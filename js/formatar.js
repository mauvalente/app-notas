// Texto da mensagem → nós do DOM, sem innerHTML (nada do texto vira HTML).
// Marcações no estilo do WhatsApp: *negrito*  _itálico_  ~riscado~  `mono`
// Links (http://, https://, www.) viram <a> clicáveis.

const RE_URL = /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>"'.,:;)\]!?]/gi;

const TAGS = { '*': 'strong', '_': 'em', '~': 's', '`': 'code' };
// Marcador de abertura: no início ou depois de espaço/pontuação, seguido de não-espaço.
// Fechamento: depois de não-espaço, seguido de fim/espaço/pontuação.
const RE_MARCA = /(^|[\s([{"'.,;:!?¿¡-])([*_~`])(?=\S)([\s\S]*?\S)\2(?=$|[\s)\]}"'.,;:!?-])/;

/** Primeira URL do texto, já com https:// quando começa com www. */
export function primeiraUrl(texto) {
  RE_URL.lastIndex = 0;
  const m = RE_URL.exec(texto || '');
  return m ? hrefDe(m[0]) : null;
}

export function hrefDe(url) {
  return /^www\./i.test(url) ? 'https://' + url : url;
}

/** Só aceita http e https (evita javascript: e afins). */
export function urlSegura(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

/** DocumentFragment com o texto formatado. */
export function formatar(texto) {
  const frag = document.createDocumentFragment();
  const s = String(texto || '');
  let i = 0;
  RE_URL.lastIndex = 0;
  for (let m; (m = RE_URL.exec(s));) {
    if (m.index > i) frag.append(marcas(s.slice(i, m.index)));
    const href = urlSegura(hrefDe(m[0]));
    if (href) {
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = m[0];
      frag.append(a);
    } else {
      frag.append(m[0]);
    }
    i = m.index + m[0].length;
  }
  if (i < s.length) frag.append(marcas(s.slice(i)));
  return frag;
}

function marcas(s) {
  const frag = document.createDocumentFragment();
  while (s) {
    const m = RE_MARCA.exec(s);
    if (!m) { frag.append(s); break; }
    const [tudo, antes, marca, dentro] = m;
    frag.append(s.slice(0, m.index) + antes);
    const tag = document.createElement(TAGS[marca]);
    if (marca === '`') tag.textContent = dentro;
    else tag.append(marcas(dentro));
    frag.append(tag);
    s = s.slice(m.index + tudo.length);
  }
  return frag;
}

/** Texto sem as marcações (para a prévia na lista de assuntos). */
export function textoSimples(texto) {
  const d = document.createElement('div');
  d.append(formatar(texto));
  return d.textContent.replace(/\s+/g, ' ').trim();
}

/** Envolve a seleção do textarea com o marcador (Ctrl+B / Ctrl+I). */
export function envolverSelecao(ta, marca) {
  const { selectionStart: a, selectionEnd: b, value: v } = ta;
  const sel = v.slice(a, b);
  ta.setRangeText(marca + sel + marca, a, b, sel ? 'select' : 'end');
  if (!sel) ta.setSelectionRange(a + 1, a + 1);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
