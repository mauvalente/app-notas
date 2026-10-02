// Notas — tela do assunto do tipo Nota (SPEC 12): editor, salvamento automático,
// cópia no aparelho, fila offline, junção de mudanças e tempo real.
//
// Como a nota é salva:
//  - cada mudança vai na hora para a cópia local (IndexedDB, chave "nota:<id>");
//  - 800 ms depois da última tecla (ou ao sair da nota / do app), sobe para o servidor
//    pela RPC salvar_nota, junto com a versão em que a edição começou;
//  - se a outra pessoa salvou antes, o servidor devolve o texto dele, o app junta
//    linha a linha (mesclar.js) e salva de novo.
import { supabase } from './db.js';
import { $, el, toast, mensagemDe, normalizar, guardado } from './util.js';
import { erroDeRede } from './sync.js';
import { kvLer, kvGravar } from './store.js';
import { mesclar } from './mesclar.js';
import { buscarPreview, previewLeve, urlDaThumb } from './preview.js';
import { cartaoLink } from './conversa.js';
import { primeiraUrl } from './formatar.js';
import { linhaSimples } from './notamd.js';

const ESPERA_ENVIO = 800;
const area = $('nota-area');
const statusEl = $('nota-status');

let ctx = { usuario: null, aoSalvar() {}, aoMudarConteudo() {} };
export function configurarNota(c) { ctx = c; }

// O editor (≈140 KB comprimido) só é baixado quando alguém abre uma nota.
let tiptap = null;
const carregarTiptap = () => (tiptap ??= import('./vendor/tiptap.js'));

/* ============================================================
   Cópia local de cada nota
   { conteudo, base_versao, base_conteudo, pendente }
   base_* = a última versão confirmada pelo servidor
   ============================================================ */

const locais = new Map();           // id → registro (memória)
const chave = (id) => 'nota:' + id;

async function lerLocal(id) {
  if (!locais.has(id)) locais.set(id, (await kvLer(chave(id))) || null);
  return locais.get(id);
}

let pendentes = null;               // Set de ids com mudança ainda não enviada
async function listaPendentes() {
  pendentes ??= new Set((await kvLer('notas-pendentes')) || []);
  return pendentes;
}

async function gravarLocal(id, rec) {
  locais.set(id, rec);
  await kvGravar(chave(id), rec);
  const p = await listaPendentes();
  const tinha = p.has(id);
  if (rec.pendente) p.add(id); else p.delete(id);
  if (tinha !== p.has(id)) await kvGravar('notas-pendentes', [...p]);
}

/* ============================================================
   Abrir / fechar
   ============================================================ */

const s = {
  id: null,            // nota aberta
  editor: null,
  aplicando: false,    // trocando o conteúdo por código (não é digitação)
  timerEnvio: null,
  timerLocal: null,
  nomes: new Map(),    // usuario_id → nome (para "Atualizada por …")
  mod: null,           // módulo do Tiptap
  focadoAntes: false,  // o editor já estava em foco quando o toque começou?
};

// Pedidos para quando a nota terminar de abrir (vindos do "Salvar em…" e da busca geral)
let acrescentarPendente = null;  // texto a acrescentar no fim
let buscarPendente = null;       // termo a destacar
/** Acrescenta este texto no fim da próxima nota aberta (SPEC 12.7, "Salvar em…"). */
export function acrescentarAoAbrir(texto) { acrescentarPendente = texto; }
/** Abre a busca na nota com este termo assim que ela abrir (resultado da busca geral). */
export function buscarAoAbrir(termo) { buscarPendente = termo; }

function terminouDeAbrir(id) {
  if (s.id !== id || !s.editor) return;
  if (acrescentarPendente) { const t = acrescentarPendente; acrescentarPendente = null; acrescentarNoFim(t); }
  if (buscarPendente) { const t = buscarPendente; buscarPendente = null; abrirBuscaNota(t); }
}

export async function abrirNota(assunto) {
  if (s.id === assunto.id) return;
  fecharNota();
  const id = s.id = assunto.id;
  area.replaceChildren(el('div', { className: 'aviso-centro discreto' }, 'Carregando…'));
  mostrarStatus('');

  const [mod, local] = await Promise.all([carregarTiptap().catch(e => ({ erro: e })), lerLocal(id)]);
  if (s.id !== id) return;
  if (mod.erro) {
    area.replaceChildren(el('div', { className: 'aviso-centro erro' }, 'Não consegui carregar o editor. ' + mensagemDe(mod.erro)));
    return;
  }

  // 1. O que está no aparelho aparece na hora (funciona sem internet)
  if (local) montarEditor(mod, local.conteudo);

  // 2. Depois, a versão do servidor
  const { data, error } = await supabase.from('notas')
    .select('conteudo, versao, atualizado_por')
    .eq('categoria_id', id)
    .maybeSingle();
  if (s.id !== id) return;

  if (error) {
    if (!local) {
      const msg = erroDeRede(error)
        ? 'Sem internet, e esta nota ainda não foi aberta neste aparelho. Ela aparece quando a conexão voltar.'
        : 'Não consegui abrir a nota. ' + mensagemDe(error);
      area.replaceChildren(el('div', { className: 'aviso-centro erro' }, msg));
      return;
    }
    mostrarStatus(local.pendente ? 'pendente' : '');
    terminouDeAbrir(id);
    return;
  }

  const servidor = { conteudo: data?.conteudo ?? '', versao: data?.versao ?? 0 };
  if (!local) {
    await gravarLocal(id, { conteudo: servidor.conteudo, base_versao: servidor.versao, base_conteudo: servidor.conteudo, pendente: false });
    montarEditor(mod, servidor.conteudo);
  } else if (!local.pendente) {
    if (servidor.versao !== local.base_versao || servidor.conteudo !== local.conteudo) {
      await gravarLocal(id, { conteudo: servidor.conteudo, base_versao: servidor.versao, base_conteudo: servidor.conteudo, pendente: false });
      aplicarNoEditor(servidor.conteudo);
    }
  } else {
    sincronizar(id); // tinha mudança minha guardada: sobe agora (junta se precisar)
  }
  carregarNomes(id);
  terminouDeAbrir(id);
}

export function fecharNota() {
  if (!s.id) return;
  const id = s.id;
  enviarJa();
  s.editor?.destroy();
  s.editor = null;
  s.id = null;
  area.replaceChildren();
  area.classList.remove('focado');
  mostrarStatus('');
  fecharDialogoLink();
  acrescentarPendente = null;
  buscarPendente = null;
  // dá tempo da cópia local ser gravada antes de tentar subir
  setTimeout(() => sincronizar(id), 0);
}

async function carregarNomes(id) {
  if (!navigator.onLine) return;
  const { data } = await supabase.rpc('membros_da_categoria', { p_categoria: id });
  for (const p of data || []) s.nomes.set(p.usuario_id, p.nome);
}

/* ============================================================
   Editor
   ============================================================ */

function configuracao(mod) {
  const { StarterKit, Link, TaskList, TaskItem, Placeholder, Markdown, Node, Extension } = mod;
  // URL sozinha (texto = endereço) volta como URL pura no Markdown: é o formato do card (SPEC 12.2)
  const LinkNota = Link.extend({
    renderMarkdown: (node, h, c) => {
      const href = node.attrs?.href ?? '', title = node.attrs?.title ?? '';
      const texto = h.renderChildren(node);
      if (!title && c?.meta?.markText === href) return texto;
      return title ? `[${texto}](${href} "${title}")` : `[${texto}](${href})`;
    },
  });
  return [
    StarterKit.configure({
      heading: { levels: [2] },
      code: false, codeBlock: false, blockquote: false, horizontalRule: false, underline: false, link: false,
    }),
    LinkNota.configure({
      openOnClick: false, autolink: true, linkOnPaste: true,
      isAllowedUri: (u) => /^https?:\/\//i.test(u),
      HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: 'Escreva aqui… Toque em ☑ para começar uma lista com checkbox.' }),
    Markdown,
    criarCardLink(mod, Node),
    Extension.create({ name: 'buscaNota', addProseMirrorPlugins: () => [pluginBusca(mod)] }),
  ];
}

/* ---------- Card de link (SPEC 12.2): URL sozinha numa linha ---------- */
// No Markdown, o card é só a URL numa linha. Ao abrir, o parágrafo que tem só um link
// (texto = endereço) vira card. Ao digitar, vira card quando o cursor sai da linha;
// ao colar, na hora.

function criarCardLink(mod, Node) {
  const { Plugin, PluginKey, TextSelection } = mod;
  return Node.create({
    name: 'cardLink',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() { return { href: { default: null } }; },
    parseHTML() { return [{ tag: 'div[data-card-link]', getAttrs: (d) => ({ href: d.getAttribute('data-card-link') }) }]; },
    renderHTML({ node }) { return ['div', { 'data-card-link': node.attrs.href }]; },
    renderMarkdown: (node) => node.attrs.href || '',
    addNodeView() { return ({ node, getPos }) => criarCardView(node, getPos); },
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey('cardsDeLink'),
        appendTransaction(trs, _velho, state) {
          const colou = trs.some(t => t.getMeta('uiEvent') === 'paste');
          const forcar = colou || trs.some(t => t.getMeta('converterCards'));
          if (!forcar && !trs.some(t => t.docChanged || t.selectionSet)) return null;
          const tipo = state.schema.nodes.cardLink, link = state.schema.marks.link;
          const sel = state.selection.from;
          const alvos = [];
          state.doc.forEach((node, pos) => {     // só parágrafos soltos (não dentro de listas)
            if (node.type.name !== 'paragraph' || node.childCount !== 1) return;
            const t = node.firstChild;
            const m = t.isText && t.marks.find(x => x.type === link);
            const txt = t.text?.trim();
            if (!m || txt !== m.attrs.href || !/^https?:\/\//i.test(txt)) return;
            const dentro = sel >= pos && sel <= pos + node.nodeSize;
            if (dentro && !forcar) return;        // ainda digitando a URL
            alvos.push({ pos, fim: pos + node.nodeSize, href: txt, dentro });
          });
          if (!alvos.length) return null;
          const tr = state.tr;
          let cursor = null;
          for (const a of alvos.reverse()) {
            tr.replaceWith(a.pos, a.fim, tipo.create({ href: a.href }));
            if (a.dentro && colou) cursor = a.pos + 1;
          }
          if (cursor != null) {
            // depois de colar, o cursor vai para uma linha nova abaixo do card
            const depois = tr.doc.nodeAt(cursor);
            if (!depois || depois.type.name !== 'paragraph') tr.insert(cursor, state.schema.nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, cursor + 1));
          }
          return tr.setMeta('addToHistory', !trs.some(t => t.getMeta('converterCards')));
        },
      })];
    },
  });
}

const PREVIEWS = 'notas.previews';
const cachePreviews = guardado.ler(PREVIEWS, {});

/** Preview do link: do aparelho, ou pela Edge Function (a mesma das mensagens). */
async function obterPreview(href) {
  if (cachePreviews[href]) return cachePreviews[href];
  const p = await buscarPreview(href);
  if (p && (p.titulo || p.imagem || p.site)) {
    cachePreviews[href] = { url: p.url || href, titulo: p.titulo || null, descricao: p.descricao || null, site: p.site || null, imagem: p.imagem || null };
    const chaves = Object.keys(cachePreviews);
    if (chaves.length > 300) delete cachePreviews[chaves[0]];
    guardado.gravar(PREVIEWS, cachePreviews);
  }
  return cachePreviews[href] || p;
}

function desenharCard(dom, href) {
  const pintar = (p) => {
    const card = cartaoLink({ ...p, url: href });
    dom.replaceChildren(card);
    card.querySelectorAll('img[data-thumb]').forEach(img => {
      const sem = () => { card.classList.add('sem-imagem'); img.remove(); };
      urlDaThumb(img.dataset.thumb).then(u => { img.src = u; }, sem);
      img.addEventListener('error', sem, { once: true });
    });
  };
  pintar(cachePreviews[href] || previewLeve(href));
  if (!cachePreviews[href] && navigator.onLine) {
    obterPreview(href).then(p => { if (p && dom.dataset.href === href) pintar(p); }).catch(() => { /* fica o card leve */ });
  }
}

function criarCardView(node, getPos) {
  const dom = el('div', { className: 'card-nota', contenteditable: 'false', dataset: { href: node.attrs.href } });
  desenharCard(dom, node.attrs.href);

  // toque longo (ou botão direito) → Editar / Remover; toque simples abre o link
  let timer = null, longo = false, origem = null;
  dom.addEventListener('pointerdown', (e) => {
    longo = false; origem = { x: e.clientX, y: e.clientY };
    if (e.button > 0) return;
    timer = setTimeout(() => { longo = true; navigator.vibrate?.(15); abrirDialogoLink({ getPos, href: dom.dataset.href }); }, 500);
  });
  dom.addEventListener('pointermove', (e) => {
    if (timer && origem && Math.hypot(e.clientX - origem.x, e.clientY - origem.y) > 10) { clearTimeout(timer); timer = null; }
  });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) dom.addEventListener(t, () => { clearTimeout(timer); timer = null; });
  dom.addEventListener('click', (e) => { if (longo) { e.preventDefault(); longo = false; } });
  dom.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!longo) abrirDialogoLink({ getPos, href: dom.dataset.href }); });

  return {
    dom,
    update(n) {
      if (n.type.name !== 'cardLink') return false;
      if (n.attrs.href !== dom.dataset.href) { dom.dataset.href = n.attrs.href; desenharCard(dom, n.attrs.href); }
      return true;
    },
    stopEvent: (e) => e.type.startsWith('pointer') || e.type === 'click' || e.type === 'contextmenu',
    ignoreMutation: () => true,
  };
}

/* ---------- Busca dentro da nota (SPEC 12.4, ⋮ / lupa) ---------- */

let chaveBusca = null;

/** Trechos { from, to } do documento que batem com o termo (sem acento, sem maiúsculas). */
function acharTodos(doc, termo) {
  const alvo = normalizar(termo.trim());
  const achados = [];
  if (!alvo) return achados;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const txt = node.text;
    let norm = ''; const mapa = [];
    for (let i = 0; i < txt.length; i++) { const n = normalizar(txt[i]); for (const ch of n) { norm += ch; mapa.push(i); } }
    for (let j = norm.indexOf(alvo); j >= 0; j = norm.indexOf(alvo, j + 1)) {
      achados.push({ from: pos + mapa[j], to: pos + mapa[j + alvo.length - 1] + 1 });
    }
    return false;
  });
  return achados;
}

function pluginBusca(mod) {
  const { Plugin, PluginKey, Decoration, DecorationSet } = mod;
  chaveBusca = new PluginKey('buscaNota');
  const calcular = (doc, termo, atual) => {
    const achados = termo ? acharTodos(doc, termo) : [];
    const a = achados.length ? ((atual % achados.length) + achados.length) % achados.length : 0;
    const deco = DecorationSet.create(doc, achados.map((r, i) => Decoration.inline(r.from, r.to, { class: i === a ? 'achado atual' : 'achado' })));
    return { termo, atual: a, total: achados.length, deco };
  };
  return new Plugin({
    key: chaveBusca,
    state: {
      init: () => ({ termo: '', atual: 0, total: 0, deco: DecorationSet.empty }),
      apply(tr, v, _velho, novo) {
        const meta = tr.getMeta(chaveBusca);
        if (!meta && !tr.docChanged) return v;
        return calcular(novo.doc, meta?.termo ?? v.termo, meta?.atual ?? v.atual);
      },
    },
    props: { decorations: (st) => chaveBusca.getState(st).deco },
  });
}

function buscar(termo, atual = 0) {
  const ed = s.editor;
  if (!ed || !chaveBusca) return;
  ed.view.dispatch(ed.state.tr.setMeta(chaveBusca, { termo, atual }).setMeta('addToHistory', false));
  const st = chaveBusca.getState(ed.state);
  $('nota-busca-contador').textContent = st.termo ? (st.total ? `${st.atual + 1} de ${st.total}` : 'nada') : '';
  requestAnimationFrame(() => area.querySelector('.achado.atual')?.scrollIntoView({ block: 'center' }));
}

export function abrirBuscaNota(termo = '') {
  if (!s.editor) return;
  const barra = $('nota-busca');
  barra.hidden = false;
  const input = $('nota-busca-texto');
  input.value = termo;
  buscar(termo);
  if (!termo) setTimeout(() => input.focus(), 30);
}

function fecharBuscaNota() {
  const barra = document.getElementById('nota-busca');
  if (barra) barra.hidden = true;
  buscar('');
}

function criarBarraBusca() {
  const input = el('input', { id: 'nota-busca-texto', type: 'search', placeholder: 'Buscar na nota', autocomplete: 'off', enterkeyhint: 'search' });
  const barra = el('div', { id: 'nota-busca', className: 'nota-busca', hidden: true },
    input,
    el('span', { id: 'nota-busca-contador', className: 'nota-busca-contador' }),
    el('button', { type: 'button', className: 'icone-botao', 'aria-label': 'Anterior', onclick: () => buscar(input.value, chaveBusca.getState(s.editor.state).atual - 1) }, '↑'),
    el('button', { type: 'button', className: 'icone-botao', 'aria-label': 'Próximo', onclick: () => buscar(input.value, chaveBusca.getState(s.editor.state).atual + 1) }, '↓'),
    el('button', { type: 'button', className: 'icone-botao', 'aria-label': 'Fechar busca', onclick: fecharBuscaNota }, '✕'));
  input.addEventListener('input', () => buscar(input.value, 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); buscar(input.value, chaveBusca.getState(s.editor.state).atual + (e.shiftKey ? -1 : 1)); }
    if (e.key === 'Escape') { e.preventDefault(); fecharBuscaNota(); }
  });
  return barra;
}

/* ---------- Ações do menu ⋮ (SPEC 12.4) ---------- */

/** Troca o texto inteiro da nota como se a pessoa tivesse editado (salva e entra no desfazer). */
function substituirTexto(md) {
  const ed = s.editor;
  if (!ed) return false;
  ed.commands.setContent(md, { contentType: 'markdown', emitUpdate: true });
  converterCards();
  return true;
}

const RE_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s/;

export function desmarcarTodos() {
  const md = markdownDoEditor();
  const novo = md.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[[xX]\]/gm, '$1[ ]');
  if (novo === md) { toast('Nenhum item marcado.'); return; }
  substituirTexto(novo);
  toast('Todos os itens foram desmarcados.');
}

export function apagarMarcados() {
  const linhas = markdownDoEditor().split('\n');
  const out = [];
  let pularAte = -1, apagados = 0;
  for (const l of linhas) {
    const recuo = l.match(/^\s*/)[0].length;
    if (pularAte >= 0) {
      if (l.trim() && recuo > pularAte) continue;   // subitem do item apagado
      pularAte = -1;
    }
    const m = RE_ITEM.exec(l);
    if (m && m[2] !== ' ') { pularAte = recuo; apagados++; continue; }
    out.push(l);
  }
  if (!apagados) { toast('Nenhum item marcado.'); return; }
  substituirTexto(out.join('\n').replace(/\n{3,}/g, '\n\n').trim());
  toast(apagados === 1 ? '1 item apagado.' : `${apagados} itens apagados.`);
}

/** Texto da nota para colar no WhatsApp etc.: ☐/☑ nos itens, • nas listas. */
export async function copiarNota() {
  const linhas = markdownDoEditor().split('\n').map(l => {
    const recuo = ' '.repeat(Math.floor(l.match(/^\s*/)[0].length / 2) * 2);
    const m = RE_ITEM.exec(l);
    if (m) return recuo + (m[2] === ' ' ? '☐ ' : '☑ ') + linhaSimples(l);
    if (/^\s*[-*+]\s/.test(l)) return recuo + '• ' + linhaSimples(l);
    if (/^\s*#{1,6}\s/.test(l)) return '*' + linhaSimples(l) + '*';
    return linhaSimples(l) || '';
  });
  const texto = linhas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  try { await navigator.clipboard.writeText(texto); toast('Nota copiada.'); }
  catch { toast('Não consegui copiar.'); }
}

/** Acrescenta texto (ex.: link compartilhado) no fim da nota, com o link numa linha própria. */
function acrescentarNoFim(texto) {
  const url = primeiraUrl(texto);
  const resto = (url ? texto.replace(url, '') : texto).trim();
  const partes = [resto, url].filter(Boolean);
  if (!partes.length) return;
  const md = markdownDoEditor();
  substituirTexto((md ? md + '\n\n' : '') + partes.join('\n\n'));
  const ed = s.editor;
  ed.commands.focus('end');
  requestAnimationFrame(() => { const r = area.querySelector('.nota-rolagem'); if (r) r.scrollTop = r.scrollHeight; });
}

/** Converte em card os links sozinhos numa linha (ao abrir e depois de trocar o conteúdo). */
function converterCards() {
  const ed = s.editor;
  if (!ed) return;
  ed.view.dispatch(ed.state.tr.setMeta('converterCards', true).setMeta('addToHistory', false));
}

/* ---------- Links no meio do texto: tocar abre quando não está editando ---------- */
// Com o teclado fechado, tocar num link abre o link. Editando (cursor no texto),
// o toque só posiciona o cursor; Ctrl/⌘ + clique abre sempre.

function configurarLinks(raiz) {
  const linkDe = (e) => !e.target.closest('.card-nota') && e.target.closest('a[href]');
  raiz.addEventListener('pointerdown', (e) => {
    s.focadoAntes = !!s.editor?.isFocused;
    if (linkDe(e) && !s.focadoAntes) e.preventDefault();
  }, { capture: true });
  raiz.addEventListener('mousedown', (e) => { if (linkDe(e) && !s.focadoAntes) e.preventDefault(); }, { capture: true });
  raiz.addEventListener('click', (e) => {
    const a = linkDe(e);
    if (!a) return;
    if (!s.focadoAntes || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute('href');
      if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener');
    }
  }, { capture: true });
}

function montarEditor(mod, conteudo) {
  if (s.editor) { aplicarNoEditor(conteudo); return; }
  s.mod = mod;
  const barra = criarBarra();
  const elEditor = el('div', { className: 'nota-editor' });
  area.replaceChildren(barra, criarBarraBusca(), el('div', { className: 'nota-rolagem' }, el('div', { className: 'nota-folha' }, elEditor)));

  s.editor = new mod.Editor({
    element: elEditor,
    extensions: configuracao(mod),
    content: conteudo,
    contentType: 'markdown',
    editorProps: { attributes: { class: 'nota-texto-editor', spellcheck: 'true', 'aria-label': 'Texto da nota' } },
    onUpdate: () => { if (!s.aplicando) aoEditar(); },
    onFocus: () => area.classList.add('focado'),
    onBlur: () => setTimeout(() => { if (!s.editor?.isFocused) area.classList.remove('focado'); }, 150),
    onSelectionUpdate: atualizarBarra,
    onTransaction: atualizarBarra,
  });
  configurarCheckboxSemTeclado(elEditor);
  configurarLinks(elEditor);
  s.aplicando = true;
  try { converterCards(); } finally { s.aplicando = false; }
  atualizarBarra();
}

/** Markdown do editor, sem as linhas vazias do fim (o editor sempre deixa um parágrafo vazio depois de uma lista). */
function markdownDoEditor() {
  return s.editor.getMarkdown().replace(/\s+$/, '');
}

/** Troca o conteúdo do editor sem contar como digitação, mantendo o cursor perto de onde estava. */
function aplicarNoEditor(texto) {
  const ed = s.editor;
  if (!ed) return;
  if (markdownDoEditor() === texto) return;
  const focado = ed.isFocused;
  const { from } = ed.state.selection;
  const rolagem = area.querySelector('.nota-rolagem')?.scrollTop;
  s.aplicando = true;
  try {
    ed.commands.setContent(texto, { contentType: 'markdown', emitUpdate: false });
    converterCards();
    if (focado) ed.commands.setTextSelection(Math.min(from, ed.state.doc.content.size - 1));
  } finally {
    s.aplicando = false;
  }
  const r = area.querySelector('.nota-rolagem');
  if (r && rolagem != null) r.scrollTop = rolagem;
}

/* ---------- Checkbox: marcar sem abrir o teclado (SPEC 12.4) ---------- */
// O TaskItem do Tiptap dá foco ao editor quando o checkbox muda, o que abre o
// teclado no celular. Aqui o toque no checkbox é tratado antes e só troca o "checked".

function configurarCheckboxSemTeclado(raiz) {
  const ehCheckbox = (e) => e.target instanceof HTMLInputElement && e.target.type === 'checkbox' && e.target.closest('li[data-checked]');
  // pointerdown/mousedown: o editor não pega o foco (não abre o teclado). O "click" continua vindo.
  for (const tipo of ['pointerdown', 'mousedown']) {
    raiz.addEventListener(tipo, (e) => { if (ehCheckbox(e)) e.preventDefault(); }, { capture: true });
  }
  raiz.addEventListener('click', (e) => {
    const li = ehCheckbox(e);
    if (!li) return;
    e.preventDefault();
    e.stopPropagation();
    // Com o clique cancelado, o navegador desfaz a marcação do quadradinho DEPOIS
    // deste evento. Por isso a troca acontece logo em seguida, quando ele já desfez.
    setTimeout(() => alternarItem(li), 0);
  }, { capture: true });
}

function alternarItem(li) {
  const ed = s.editor;
  if (!ed) return;
  const { view } = ed;
  let pos = null;
  view.state.doc.descendants((node, p) => {
    if (pos != null) return false;
    if (node.type.name === 'taskItem' && view.nodeDOM(p) === li) { pos = p; return false; }
    return true;
  });
  if (pos == null) return;
  const node = view.state.doc.nodeAt(pos);
  const marcado = !node.attrs.checked;
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: marcado }));
  // garante o desenho do quadradinho igual ao estado da nota
  const cb = li.querySelector(':scope > label input[type="checkbox"]');
  if (cb) cb.checked = marcado;
  navigator.vibrate?.(8);
}

/* ---------- Barra de formatação (SPEC 12.4) ---------- */

const BOTOES = [
  ['negrito', 'B', 'Negrito (Ctrl+B)'],
  ['italico', 'I', 'Itálico (Ctrl+I)'],
  ['riscado', 'S', 'Riscado (Ctrl+Shift+S)'],
  ['checklist', '☑', 'Lista com checkbox (Ctrl+Shift+9)'],
  ['lista', '•', 'Lista'],
  ['subtitulo', 'T', 'Subtítulo'],
  ['link', '🔗', 'Link'],
];

function criarBarra() {
  const barra = el('div', { className: 'nota-barra', role: 'toolbar', 'aria-label': 'Formatação' },
    ...BOTOES.map(([acao, rotulo, titulo]) =>
      el('button', { type: 'button', className: 'nota-botao fmt-' + acao, dataset: { acao }, title: titulo, 'aria-label': titulo, 'aria-pressed': 'false' }, rotulo)));
  // não tira o foco do editor (o teclado do celular continua aberto)
  barra.addEventListener('pointerdown', (e) => { if (e.target.closest('.nota-botao')) e.preventDefault(); });
  barra.addEventListener('mousedown', (e) => e.preventDefault());
  barra.addEventListener('click', (e) => {
    const b = e.target.closest('.nota-botao');
    if (b) executar(b.dataset.acao);
  });
  return barra;
}

function executar(acao) {
  const ed = s.editor;
  if (!ed) return;
  const c = ed.chain().focus();
  if (acao === 'negrito') c.toggleBold().run();
  else if (acao === 'italico') c.toggleItalic().run();
  else if (acao === 'riscado') c.toggleStrike().run();
  else if (acao === 'checklist') c.toggleTaskList().run();
  else if (acao === 'lista') c.toggleBulletList().run();
  else if (acao === 'subtitulo') c.toggleHeading({ level: 2 }).run();
  else if (acao === 'link') abrirDialogoLink();
}

const ATIVO = {
  negrito: (ed) => ed.isActive('bold'),
  italico: (ed) => ed.isActive('italic'),
  riscado: (ed) => ed.isActive('strike'),
  checklist: (ed) => ed.isActive('taskList'),
  lista: (ed) => ed.isActive('bulletList'),
  subtitulo: (ed) => ed.isActive('heading', { level: 2 }),
  link: (ed) => ed.isActive('link'),
};

function atualizarBarra() {
  const ed = s.editor;
  if (!ed) return;
  for (const b of area.querySelectorAll('.nota-botao')) {
    b.setAttribute('aria-pressed', String(!!ATIVO[b.dataset.acao]?.(ed)));
  }
}

/* ---------- Link ---------- */

const dlgLink = $('dlg-link');

let cardEditando = null; // { getPos, href } quando o diálogo veio de um card

function abrirDialogoLink(card = null) {
  const ed = s.editor;
  if (!ed) return;
  cardEditando = card;
  const atual = card ? card.href : (ed.getAttributes('link').href || '');
  $('link-url').value = atual;
  $('link-remover').hidden = !atual;
  $('link-abrir').hidden = !card;
  $('link-erro').hidden = true;
  dlgLink.showModal();
  setTimeout(() => $('link-url').focus(), 50);
}

function fecharDialogoLink() { cardEditando = null; if (dlgLink?.open) dlgLink.close(); }

$('form-link').addEventListener('submit', (e) => {
  const v = e.submitter?.value;
  if (v === 'cancelar') return;
  e.preventDefault();
  const ed = s.editor;
  if (!ed) { dlgLink.close(); return; }
  const card = cardEditando;
  cardEditando = null;
  if (v === 'abrir' && card) {
    dlgLink.close();
    window.open(card.href, '_blank', 'noopener');
    return;
  }
  if (v === 'remover') {
    dlgLink.close();
    if (card) {
      const pos = card.getPos();
      if (typeof pos === 'number') ed.view.dispatch(ed.state.tr.delete(pos, pos + 1));
    } else {
      ed.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    return;
  }
  let url = $('link-url').value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) {
    $('link-erro').textContent = 'Endereço inválido. Ex.: https://www.exemplo.com';
    $('link-erro').hidden = false;
    return;
  }
  dlgLink.close();
  if (card) {
    const pos = card.getPos();
    if (typeof pos === 'number') ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { href: url }));
    return;
  }
  const { empty } = ed.state.selection;
  if (empty && !ed.isActive('link')) {
    ed.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).insertContent(' ').run();
  } else {
    ed.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }
});

/* ---------- Teclado no iPhone: a barra fica logo acima dele ---------- */
// No Android (interactive-widget=resizes-content) a tela encolhe sozinha; no iPhone, não.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const ajustar = () => {
    const teclado = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--teclado', teclado + 'px');
  };
  vv.addEventListener('resize', ajustar);
  vv.addEventListener('scroll', ajustar);
}

/* ============================================================
   Salvamento
   ============================================================ */

function aoEditar() {
  const id = s.id;
  const rec = locais.get(id);
  if (!id || !rec) return;
  const md = markdownDoEditor();
  rec.conteudo = md;
  rec.pendente = md !== rec.base_conteudo;
  ctx.aoMudarConteudo?.(id, md);
  mostrarStatus(rec.pendente ? 'salvando' : 'salvo');
  clearTimeout(s.timerLocal);
  s.timerLocal = setTimeout(() => gravarLocal(id, rec), 250);
  clearTimeout(s.timerEnvio);
  s.timerEnvio = setTimeout(() => { s.timerEnvio = null; sincronizar(id); }, ESPERA_ENVIO);
}

/** Grava a cópia local agora e manda subir (ao sair da nota ou do app). */
function enviarJa() {
  const id = s.id;
  if (!id) return;
  const rec = locais.get(id);
  const tinhaAlgo = s.timerLocal || s.timerEnvio;
  clearTimeout(s.timerLocal); s.timerLocal = null;
  clearTimeout(s.timerEnvio); s.timerEnvio = null;
  if (rec && tinhaAlgo) gravarLocal(id, rec).then(() => sincronizar(id));
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') enviarJa(); });
window.addEventListener('pagehide', enviarJa);

const enviando = new Set();
const deNovo = new Set();

/** Sobe a nota para o servidor, juntando com a versão de lá se a outra pessoa salvou antes. */
async function sincronizar(id) {
  if (!id) return;
  if (enviando.has(id)) { deNovo.add(id); return; }
  enviando.add(id);
  try {
    for (let tentativa = 0; tentativa < 5; tentativa++) {
      const rec = await lerLocal(id);
      if (!rec?.pendente) { if (s.id === id && !s.timerEnvio) mostrarStatus('salvo'); return; }
      if (!navigator.onLine) { if (s.id === id) mostrarStatus('pendente'); return; }

      const enviado = rec.conteudo;
      const { data, error } = await supabase.rpc('salvar_nota', {
        p_categoria: id, p_conteudo: enviado, p_versao_base: rec.base_versao,
      });
      if (error) {
        if (s.id === id) mostrarStatus('pendente');
        if (!erroDeRede(error) && !/jwt|token/i.test(error.message || '')) {
          toast('Não deu para salvar a nota. ' + mensagemDe(error));
        }
        return; // fica guardada no aparelho; tenta de novo depois
      }
      const r = Array.isArray(data) ? data[0] : data;
      const atual = locais.get(id); // pode ter mudado enquanto esperava o servidor

      if (r?.ok) {
        atual.base_versao = r.versao;
        atual.base_conteudo = enviado;
        atual.pendente = atual.conteudo !== enviado;
        await gravarLocal(id, atual);
        ctx.aoSalvar?.(id, r.atualizado_em);
        continue; // se mudou de novo enquanto subia, manda outra vez
      }

      // Conflito: a outra pessoa salvou antes. Junta linha a linha.
      const deles = r?.conteudo ?? '';
      const m = mesclar(atual.base_conteudo, atual.conteudo, deles);
      atual.base_versao = r?.versao ?? 0;
      atual.base_conteudo = deles;
      atual.conteudo = m.texto;
      atual.pendente = m.texto !== deles;
      await gravarLocal(id, atual);
      ctx.aoMudarConteudo?.(id, m.texto);
      if (s.id === id) {
        aplicarNoEditor(m.texto);
        if (m.conflito) toast('Algumas linhas foram editadas pelos dois ao mesmo tempo. Confira a nota.', 6000);
        else avisarAtualizadaPor(r?.atualizado_por);
      }
    }
  } catch (e) {
    console.error('nota', e);
    if (s.id === id) mostrarStatus('pendente');
  } finally {
    enviando.delete(id);
    if (deNovo.delete(id)) sincronizar(id);
  }
}

/** Sobe todas as notas com mudança guardada (ao abrir o app e quando a internet volta). */
export async function sincronizarPendentes() {
  for (const id of await listaPendentes()) sincronizar(id);
}

/* ---------- Tempo real: a outra pessoa salvou ---------- */

export async function receberNota(row) {
  const id = row?.categoria_id;
  if (!id || row.conteudo == null) return;
  const rec = await lerLocal(id);
  if (!rec) return;                                // nota nunca aberta neste aparelho: nada a fazer
  if (row.versao <= rec.base_versao) return;       // já tenho (é o meu próprio salvamento, por exemplo)
  if (rec.pendente || enviando.has(id)) { sincronizar(id); return; } // tenho mudança: junta ao subir
  await gravarLocal(id, { conteudo: row.conteudo, base_versao: row.versao, base_conteudo: row.conteudo, pendente: false });
  if (s.id === id) {
    aplicarNoEditor(row.conteudo);
    avisarAtualizadaPor(row.atualizado_por);
  }
}

/* ---------- Indicador no cabeçalho ---------- */

let timerAviso = null;

function mostrarStatus(estado) {
  if (!statusEl) return;
  clearTimeout(timerAviso);
  const textos = { salvando: 'Salvando…', salvo: 'Salvo', pendente: '🕓 Aguardando envio' };
  statusEl.textContent = textos[estado] || '';
  statusEl.dataset.estado = estado || '';
  statusEl.hidden = !textos[estado];
}

function avisarAtualizadaPor(usuarioId) {
  if (!statusEl || !usuarioId || usuarioId === ctx.usuario?.id) return;
  const nome = s.nomes.get(usuarioId) || 'outra pessoa';
  statusEl.textContent = 'Atualizada por ' + nome;
  statusEl.dataset.estado = 'outro';
  statusEl.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => mostrarStatus('salvo'), 4000);
}

// Para os testes e a depuração no console
export const _interno = { s, locais, sincronizar };
