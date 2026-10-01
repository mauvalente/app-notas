// =====================================================================
// APP Notas — Edge Function "link-preview"
// Recebe { url } e devolve { url, url_final, titulo, descricao, site, imagem, status }.
// A thumb é copiada para o bucket privado "thumbs" (as URLs do Instagram etc. expiram).
// Só responde para quem está logado E está em usuarios_permitidos.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Image, decode } from 'npm:imagescript@1.3.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Muitos sites só entregam as meta tags para "robôs de preview" conhecidos.
const UA = 'Mozilla/5.0 (compatible; NotasPreview/1.0; +https://mauvalente.github.io/app-notas/) facebookexternalhit/1.1';
const LIMITE_HTML = 512 * 1024;      // lê no máximo 512 KB da página
const LIMITE_IMAGEM = 5 * 1024 * 1024;
const TEMPO_LIMITE = 8000;           // ms por requisição
const CACHE_OK_DIAS = 30;
const CACHE_FALHA_HORAS = 12;

// deno-lint-ignore no-explicit-any
type Admin = any;

type Preview = {
  url: string; url_final: string | null; titulo: string | null; descricao: string | null;
  site: string | null; imagem: string | null; w: number | null; h: number | null;
  status: 'ok' | 'sem_meta' | 'bloqueado' | 'erro';
};

/* ---------------------------------------------------------------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ erro: 'Use POST' }, 405);

  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, chaveServico(), { auth: { persistSession: false } });

    // 1. Quem está pedindo?
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user }, error: errUser } = await admin.auth.getUser(token);
    if (errUser || !user?.email) return json({ erro: 'Faça login de novo.' }, 401);
    const { data: permitido } = await admin.from('usuarios_permitidos')
      .select('email').eq('email', user.email.toLowerCase()).maybeSingle();
    if (!permitido) return json({ erro: 'Sem acesso.' }, 403);

    // 2. URL
    const corpo = await req.json().catch(() => ({}));
    let url: string;
    try { url = normalizarUrl(String(corpo.url || '')); }
    catch { return json({ erro: 'URL inválida.' }, 400); }

    // 3. Cache
    const { data: cache } = await admin.from('link_previews').select('*').eq('url_normalizada', url).maybeSingle();
    if (cache && cacheValido(cache)) return json(daTabela(cache));

    // 4. Busca
    const p = await gerarPreview(url, admin);

    await admin.from('link_previews').upsert({
      url_normalizada: url, url_final: p.url_final, titulo: p.titulo, descricao: p.descricao, site: p.site,
      imagem_path: p.imagem, imagem_largura: p.w, imagem_altura: p.h, status: p.status, buscado_em: new Date().toISOString(),
    });
    return json(p);
  } catch (e) {
    console.error(e);
    return json({ erro: String((e as Error)?.message || e) }, 500);
  }
});

/* ---------------------------------------------------------------- */

function chaveServico(): string {
  const legado = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legado) return legado;
  try { // chaves novas (sb_secret_...)
    const novas = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    return novas.default || Object.values(novas)[0] as string;
  } catch { throw new Error('Chave de serviço não encontrada'); }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function cacheValido(c: { status: string; buscado_em: string }) {
  const idade = Date.now() - Date.parse(c.buscado_em);
  return c.status === 'ok' ? idade < CACHE_OK_DIAS * 864e5 : idade < CACHE_FALHA_HORAS * 3600e3;
}

function daTabela(c: Record<string, any>): Preview {
  return {
    url: c.url_normalizada, url_final: c.url_final, titulo: c.titulo, descricao: c.descricao, site: c.site,
    imagem: c.imagem_path, w: c.imagem_largura, h: c.imagem_altura, status: c.status,
  };
}

/* ---------- URL ---------- */

const PARAMS_RASTREIO = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^igsh$/i, /^igshid$/i, /^mibextid$/i,
  /^ref_src$/i, /^ref_url$/i, /^_r$/i, /^mc_[ce]id$/i];

function normalizarUrl(bruta: string): string {
  let s = bruta.trim();
  if (/^www\./i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo');
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const host = u.hostname.replace(/^(www|m|mobile)\./, '');
  for (const k of [...u.searchParams.keys()]) {
    if (PARAMS_RASTREIO.some(r => r.test(k))) u.searchParams.delete(k);
    if (k === 'si' && /(youtube\.com|youtu\.be|spotify\.com)$/.test(host)) u.searchParams.delete(k);
    if (k === 'feature' && /(youtube\.com|youtu\.be)$/.test(host)) u.searchParams.delete(k);
    if ((k === 's' || k === 't') && /^(x|twitter)\.com$/.test(host)) u.searchParams.delete(k);
  }
  return u.toString().replace(/\?$/, '');
}

const SITES: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'], [/(^|\.)(x|twitter)\.com$/, 'X'], [/(^|\.)(facebook\.com|fb\.watch)$/, 'Facebook'],
  [/(^|\.)threads\.(net|com)$/, 'Threads'], [/(^|\.)linkedin\.com$/, 'LinkedIn'], [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)pinterest\.[a-z.]+$|(^|\.)pin\.it$/, 'Pinterest'], [/(^|\.)spotify\.com$/, 'Spotify'],
];

function nomeDoSite(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return SITES.find(([r]) => r.test(host))?.[1] || host;
}

/* ---------- Segurança: só endereços públicos (evita SSRF) ---------- */

function ipPrivado(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? ipPrivado(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function hostPermitido(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return !ipPrivado(h);
  if (h === 'localhost' || /\.(local|internal|localhost)$/.test(h)) return false;
  try {
    const ips = [
      ...await Deno.resolveDns(h, 'A').catch(() => [] as string[]),
      ...await Deno.resolveDns(h, 'AAAA').catch(() => [] as string[]),
    ];
    // sem resposta do DNS (ou DNS indisponível no ambiente): deixa o fetch decidir
    return ips.every(ip => !ipPrivado(ip));
  } catch {
    return true; // sem DNS disponível: segue (o fetch falha sozinho se o host não existir)
  }
}

/** fetch que confere cada redirecionamento e corta por tempo. */
async function buscar(url: string, accept: string): Promise<{ res: Response; final: string }> {
  let atual = url;
  for (let i = 0; i < 6; i++) {
    const u = new URL(atual);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo');
    if (u.port && u.port !== '80' && u.port !== '443') throw new Error('porta');
    if (!await hostPermitido(u.hostname)) throw new Error('endereço bloqueado');
    const res = await fetch(atual, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(TEMPO_LIMITE),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      atual = new URL(loc, atual).toString();
      continue;
    }
    return { res, final: atual };
  }
  throw new Error('redirecionamentos demais');
}

async function lerAte(res: Response, limite: number): Promise<Uint8Array<ArrayBuffer>> {
  const leitor = res.body?.getReader();
  if (!leitor) return new Uint8Array();
  const partes: Uint8Array[] = [];
  let total = 0;
  while (total < limite) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value); total += value.length;
  }
  await leitor.cancel().catch(() => {});
  const out = new Uint8Array(new ArrayBuffer(Math.min(total, limite)));
  let pos = 0;
  for (const p of partes) {
    const n = Math.min(p.length, out.length - pos);
    out.set(p.subarray(0, n), pos); pos += n;
    if (pos >= out.length) break;
  }
  return out;
}

/* ---------- Gerar o preview ---------- */

async function gerarPreview(url: string, admin: Admin): Promise<Preview> {
  const base: Preview = { url, url_final: null, titulo: null, descricao: null, site: nomeDoSite(url), imagem: null, w: null, h: null, status: 'erro' };
  let imagemOrigem: string | null = null;

  try {
    const host = new URL(url).hostname.replace(/^(www|m)\./, '');
    let feito = false;

    // oEmbed públicos (mais confiáveis que ler a página)
    const oembed =
      /(^|\.)(youtube\.com|youtu\.be)$/.test(host) ? 'https://www.youtube.com/oembed?format=json&url=' :
      /(^|\.)tiktok\.com$/.test(host) ? 'https://www.tiktok.com/oembed?url=' :
      /^(x|twitter)\.com$/.test(host) ? 'https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=' : null;
    if (oembed) {
      const o = await buscarJson(oembed + encodeURIComponent(url));
      if (o) {
        if (/^(x|twitter)\.com$/.test(host)) {
          const texto = semTags(String(o.html || '')).replace(/—\s*[^—]*$/, '').trim();
          base.titulo = o.author_name ? `${o.author_name} no X` : 'Post no X';
          base.descricao = texto || null;
        } else {
          base.titulo = o.title || null;
          base.descricao = o.author_name || null;
          imagemOrigem = o.thumbnail_url || null;
        }
        base.url_final = url;
        base.status = 'ok';
        feito = true;
      }
    }

    // Qualquer site: meta tags da página
    if (!feito) {
      const { res, final } = await buscar(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
      base.url_final = final;
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        await res.body?.cancel();
        base.status = 'bloqueado';
      } else if (!res.ok) {
        await res.body?.cancel();
        base.status = 'erro';
      } else {
        const tipo = res.headers.get('content-type') || '';
        if (!/html|xml/i.test(tipo)) {
          await res.body?.cancel();
          base.titulo = decodeURIComponent(new URL(final).pathname.split('/').pop() || '') || null;
          if (/^image\//i.test(tipo)) imagemOrigem = final; // link direto para uma imagem: ela mesma é a thumb
          base.status = 'sem_meta';
        } else {
          const bytes = await lerAte(res, LIMITE_HTML);
          const html = decodificar(bytes, tipo);
          const meta = lerMetas(html);
          base.titulo = meta['og:title'] || meta['twitter:title'] || tituloDaPagina(html) || null;
          base.descricao = meta['og:description'] || meta['twitter:description'] || meta['description'] || null;
          if (meta['og:site_name']) base.site = meta['og:site_name'];
          imagemOrigem = meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || null;
          if (imagemOrigem) imagemOrigem = new URL(imagemOrigem, final).toString();
          // página de login (Instagram/Facebook bloqueando) não conta como preview
          const loginWall = /instagram|facebook/i.test(base.site || '') && !imagemOrigem && /log ?in|entrar|entre/i.test(base.titulo || '');
          if (loginWall) { base.titulo = null; base.descricao = null; }
          base.status = base.titulo || imagemOrigem ? 'ok' : (loginWall ? 'bloqueado' : 'sem_meta');
        }
      }
    }
  } catch (e) {
    console.warn('preview', url, (e as Error)?.message);
    base.status = 'erro';
  }

  base.titulo = cortar(base.titulo, 300);
  base.descricao = cortar(base.descricao, 500);
  if (base.titulo && base.descricao && base.titulo === base.descricao) base.descricao = null;

  // Thumb → bucket "thumbs"
  if (imagemOrigem) {
    try {
      const img = await guardarImagem(imagemOrigem, admin);
      if (img) { base.imagem = img.caminho; base.w = img.w; base.h = img.h; }
    }
    catch (e) { console.warn('imagem', imagemOrigem, (e as Error)?.message); }
  }
  return base;
}

async function buscarJson(url: string): Promise<Record<string, any> | null> {
  try {
    const { res } = await buscar(url, 'application/json');
    if (!res.ok) { await res.body?.cancel(); return null; }
    return JSON.parse(new TextDecoder().decode(await lerAte(res, 256 * 1024)));
  } catch { return null; }
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

const LADO_MAX = 600;     // px (maior lado da thumb guardada)

async function guardarImagem(origem: string, admin: Admin): Promise<{ caminho: string; w: number | null; h: number | null } | null> {
  const { res } = await buscar(origem, 'image/jpeg,image/png,image/*;q=0.8');
  let tipo = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !EXT[tipo]) { await res.body?.cancel(); return null; }
  let bytes: Uint8Array<ArrayBuffer> = await lerAte(res, LIMITE_IMAGEM + 1);
  if (bytes.length > LIMITE_IMAGEM || bytes.length < 200) return null;

  // Reduz para no máximo 600 px em WebP (economiza o Storage gratuito).
  // Formatos que a biblioteca não lê (WebP/AVIF de origem) são guardados como vieram.
  let w: number | null = null, h: number | null = null;
  try {
    const img = await decode(bytes) as Image;
    if (img && typeof img.width === 'number') {
      if (img.width > LADO_MAX || img.height > LADO_MAX) {
        if (img.width >= img.height) img.resize(LADO_MAX, Image.RESIZE_AUTO);
        else img.resize(Image.RESIZE_AUTO, LADO_MAX);
      }
      const webp = await img.encodeWEBP(72);
      if (webp.length < bytes.length) {
        bytes = new Uint8Array(webp);
        tipo = 'image/webp';
      }
      w = img.width; h = img.height;
    }
  } catch (e) {
    console.warn('reduzir imagem', (e as Error)?.message);
  }

  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  const caminho = `${hash.slice(0, 2)}/${hash}.${EXT[tipo]}`;
  const { error } = await admin.storage.from('thumbs').upload(caminho, bytes, { contentType: tipo, upsert: true });
  if (error) throw error;
  return { caminho, w, h };
}

/* ---------- HTML ---------- */

function decodificar(bytes: Uint8Array, contentType: string): string {
  let charset = /charset=([\w-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const inicio = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(inicio)?.[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function lerMetas(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const cabeca = html.slice(0, html.search(/<\/head>/i) > 0 ? html.search(/<\/head>/i) : html.length);
  for (const tag of cabeca.match(/<meta\b[^>]*>/gi) || []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const chave = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (chave && attrs.content && !(chave in out)) out[chave] = entidades(attrs.content).trim();
  }
  return out;
}

function tituloDaPagina(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? entidades(m[1]).replace(/\s+/g, ' ').trim() || null : null;
}

function semTags(html: string): string {
  return entidades(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').trim();
}

const NOMEADAS: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»' };

function entidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (t, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return t; }
    }
    return NOMEADAS[e.toLowerCase()] ?? t;
  });
}

function cortar(s: string | null, max: number): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
