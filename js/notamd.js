// Notas — Markdown da nota → texto simples (prévia na lista, busca e Copiar).
// Não precisa do editor: funciona com o texto guardado, inclusive sem internet.

const ENTIDADES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Uma linha de Markdown sem as marcações. */
export function linhaSimples(linha) {
  return linha
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/, '')   // - [ ] item
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')               // - item / 1. item
    .replace(/^\s*#{1,6}\s+/, '')                          // ## subtítulo
    .replace(/\[([^\]]*)\]\((?:[^()\s]+)(?:\s+"[^"]*")?\)/g, '$1') // [texto](url)
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1')
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ENTIDADES[m])
    .trim();
}

/** Linhas de texto da nota (sem as vazias). */
export function linhasDaNota(md) {
  return String(md || '').split('\n').map(linhaSimples).filter(Boolean);
}

/** Texto simples da nota inteira (para Copiar e busca sem internet). */
export function textoDaNota(md) {
  return linhasDaNota(md).join('\n');
}

/** Contagem dos checkbox: { total, marcados }. */
export function contarItens(md) {
  let total = 0, marcados = 0;
  for (const l of String(md || '').split('\n')) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s/.exec(l);
    if (m) { total++; if (m[1] !== ' ') marcados++; }
  }
  return { total, marcados };
}

/**
 * Prévia da nota na lista de assuntos (SPEC 12.7):
 * com checkbox → "☑ 3 de 10 · próximo item"; sem → a primeira linha.
 */
export function previaDaNota(md) {
  const { total, marcados } = contarItens(md);
  if (total) {
    const proximo = String(md).split('\n').find(l => /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s/.test(l));
    const p = proximo ? linhaSimples(proximo) : '';
    return `☑ ${marcados} de ${total}` + (p ? ' · ' + p : '');
  }
  return linhasDaNota(md)[0] || 'Nota vazia';
}
