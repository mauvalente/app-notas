// Preview de links (Edge Function link-preview) e URLs das thumbs (bucket privado).
import { supabase } from './db.js';
import { guardado } from './util.js';

/* ---------- Preview ---------- */

const previews = new Map(); // url → Promise<preview>

/**
 * Pede o preview de uma URL à Edge Function. Resultado:
 * { url, titulo, descricao, site, imagem, status }
 */
export function buscarPreview(url) {
  if (!previews.has(url)) {
    const p = supabase.functions.invoke('link-preview', { body: { url } })
      .then(({ data, error }) => {
        if (error) throw error;
        return data;
      })
      .catch((e) => { previews.delete(url); throw e; });
    previews.set(url, p);
  }
  return previews.get(url);
}

/** Objeto que vai em mensagens.link (cópia do preview no momento do envio). */
export function paraMensagem(p) {
  if (!p) return null;
  const { url, titulo, descricao, site, imagem, w, h } = p;
  return { url, titulo: titulo || null, descricao: descricao || null, site: site || null, imagem: imagem || null, w: w || null, h: h || null };
}

/** Preview "leve" quando a função falha: só o domínio. */
export function previewLeve(url) {
  let site = url;
  try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ok */ }
  return { url, titulo: null, descricao: null, site, imagem: null, status: 'erro' };
}

/* ---------- Thumbs (URLs assinadas, válidas por 7 dias) ---------- */

const VALIDADE = 7 * 24 * 3600;        // segundos
const CHAVE = 'notas.thumbs';
const assinadas = guardado.ler(CHAVE, {}); // caminho → { u, exp }
let fila = new Map();                  // caminho → [resolvers]
let agendado = false;

export function urlDaThumb(caminho) {
  const c = assinadas[caminho];
  if (c && c.exp > Date.now() + 3600e3) return Promise.resolve(c.u);
  return new Promise((ok, falha) => {
    if (!fila.has(caminho)) fila.set(caminho, []);
    fila.get(caminho).push({ ok, falha });
    if (!agendado) { agendado = true; setTimeout(assinarFila, 0); }
  });
}

async function assinarFila() {
  const lote = fila; fila = new Map(); agendado = false;
  const caminhos = [...lote.keys()];
  const { data, error } = await supabase.storage.from('thumbs').createSignedUrls(caminhos, VALIDADE);
  for (const caminho of caminhos) {
    const item = data?.find(d => d.path === caminho);
    for (const r of lote.get(caminho)) {
      if (error || !item?.signedUrl) r.falha(error || new Error('thumb indisponível'));
      else r.ok(item.signedUrl);
    }
    if (item?.signedUrl) assinadas[caminho] = { u: item.signedUrl, exp: Date.now() + VALIDADE * 1000 };
  }
  // limpa as vencidas e guarda
  for (const [k, v] of Object.entries(assinadas)) if (v.exp < Date.now()) delete assinadas[k];
  guardado.gravar(CHAVE, assinadas);
}
