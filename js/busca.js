// Busca nas mensagens: no servidor (texto, título, descrição e endereço do link,
// sem acento e por pedaço de palavra) ou, sem internet, no que está guardado no aparelho.
import { supabase } from './db.js';
import { el, quando, normalizar } from './util.js';
import { textoSimples } from './formatar.js';
import { buscarNoCache } from './store.js';
import { erroDeRede } from './sync.js';

export async function buscarMensagens(termo, categoriaId = null) {
  const t = termo.trim();
  if (t.length < 2) return { itens: [], offline: false };
  if (navigator.onLine) {
    const { data, error } = await supabase.rpc('buscar_mensagens', { p_q: t, p_categoria: categoriaId, p_limite: 50 });
    if (!error) return { itens: data || [], offline: false };
    if (!erroDeRede(error)) throw error;
  }
  const n = normalizar(t);
  const itens = await buscarNoCache(m => normalizar(conteudo(m)).includes(n), categoriaId);
  return { itens, offline: true };
}

function conteudo(m) {
  return [textoSimples(m.texto), m.link?.titulo, m.link?.descricao, m.link?.url].filter(Boolean).join(' · ');
}

/** Trecho de ~90 caracteres em volta do termo, com o termo marcado (<mark>). */
export function trecho(m, termo) {
  const texto = conteudo(m);
  // mapa caractere a caractere entre o texto original e o normalizado
  let norm = '';
  const pos = [];
  for (let i = 0; i < texto.length; i++) {
    const n = normalizar(texto[i]);
    for (let k = 0; k < n.length; k++) { norm += n[k]; pos.push(i); }
  }
  const alvo = normalizar(termo.trim());
  const j = alvo ? norm.indexOf(alvo) : -1;
  const frag = document.createDocumentFragment();
  if (j < 0) { frag.append(texto.slice(0, 90) + (texto.length > 90 ? '…' : '')); return frag; }
  const ini = pos[j], fim = pos[j + alvo.length - 1] + 1;
  let de = Math.max(0, ini - 35), ate = Math.min(texto.length, fim + 70);
  if (de > 0) { const esp = texto.lastIndexOf(' ', de); de = esp < 0 ? (ini < 50 ? 0 : de) : (ini - esp < 50 ? esp + 1 : de); } // não corta palavra
  if (ate < texto.length) { const esp = texto.indexOf(' ', ate); ate = esp > 0 && esp - fim < 90 ? esp : ate; }
  frag.append((de > 0 ? '…' : '') + texto.slice(de, ini), el('mark', {}, texto.slice(ini, fim)), texto.slice(fim, ate) + (ate < texto.length ? '…' : ''));
  return frag;
}

/** Item de resultado: avatar do assunto, nome, data e trecho. */
export function itemResultado(m, assunto, termo, mostrarAssunto = true) {
  return el('li', {},
    el('button', { type: 'button', className: 'resultado', dataset: { id: m.id, categoria: m.categoria_id, criado: m.criado_em } },
      mostrarAssunto ? el('span', { className: 'avatar pequeno' }, assunto ? (assunto.emoji || assunto.nome.trim().charAt(0)) : '?') : null,
      el('span', { className: 'resultado-corpo' },
        el('span', { className: 'resultado-topo' },
          el('span', { className: 'resultado-assunto' }, mostrarAssunto ? (assunto?.nome || 'Assunto') : ''),
          el('span', { className: 'resultado-data' }, quando(m.criado_em))),
        el('span', { className: 'resultado-trecho' }, trecho(m, termo)))));
}
