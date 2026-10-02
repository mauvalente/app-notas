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
import { $, el, toast, mensagemDe } from './util.js';
import { erroDeRede } from './sync.js';
import { kvLer, kvGravar } from './store.js';
import { mesclar } from './mesclar.js';

const ESPERA_ENVIO = 800;
const area = $('nota-area');
const statusEl = $('nota-status');

let ctx = { usuario: null, aoSalvar() {} };
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
};

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
  const { StarterKit, Link, TaskList, TaskItem, Placeholder, Markdown } = mod;
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
  ];
}

function montarEditor(mod, conteudo) {
  if (s.editor) { aplicarNoEditor(conteudo); return; }
  const barra = criarBarra();
  const elEditor = el('div', { className: 'nota-editor' });
  area.replaceChildren(barra, el('div', { className: 'nota-rolagem' }, el('div', { className: 'nota-folha' }, elEditor)));

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
    alternarItem(li);
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
  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
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

function abrirDialogoLink() {
  const ed = s.editor;
  if (!ed) return;
  const atual = ed.getAttributes('link').href || '';
  $('link-url').value = atual;
  $('link-remover').hidden = !atual;
  $('link-erro').hidden = true;
  dlgLink.showModal();
  setTimeout(() => $('link-url').focus(), 50);
}

function fecharDialogoLink() { if (dlgLink?.open) dlgLink.close(); }

$('form-link').addEventListener('submit', (e) => {
  const v = e.submitter?.value;
  if (v === 'cancelar') return;
  e.preventDefault();
  const ed = s.editor;
  if (!ed) { dlgLink.close(); return; }
  if (v === 'remover') {
    ed.chain().focus().extendMarkRange('link').unsetLink().run();
    dlgLink.close();
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
