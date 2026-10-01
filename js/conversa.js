// Conversa: mensagens, campo de digitar, preview de links, seleção, editar, excluir, copiar e mover.
import { supabase } from './db.js';
import { $, el, toast, mensagemDe, hora, rotuloDia, temMouse, guardado, confirmarComSegundoToque } from './util.js';
import { formatar, primeiraUrl, urlSegura, envolverSelecao } from './formatar.js';
import { buscarPreview, paraMensagem, previewLeve, urlDaThumb } from './preview.js';
import { mensagensDoAssunto, guardarPaginaNova, guardarMensagens, removerMensagens, kvLer, kvGravar, filaTodas } from './store.js';
import { gravar, aoProcessar, erroDeRede } from './sync.js';
import { buscarMensagens, itemResultado } from './busca.js';

const POR_PAGINA = 50;

const c = {
  ctx: null,              // { usuario, assuntos(), aoEnviar(assuntoId, msg), aoMoverOuApagar(), marcarLido(assuntoId) }
  assunto: null,
  mensagens: [],          // em ordem crescente de criado_em
  temMais: false,
  carregandoMais: false,
  membros: new Map(),     // usuario_id → nome
  selecionadas: new Set(),
  editando: null,         // mensagem em edição
  rascunhoAntesDeEditar: '',
  preview: null,          // { url, estado: 'carregando'|'ok', dados, promessa }
  pronto: false,          // terminou de carregar (cache + servidor)
  ancorado: false,        // pulou para uma mensagem da busca: não rolar para o fim sozinho
  descartada: null,       // URL cujo preview foi removido com ✕
};

const ta = $('composer-texto');
const lista = $('mensagens');

export function configurarConversa(ctx) { c.ctx = ctx; }

/* Texto vindo do botão Compartilhar: entra no campo quando o assunto abrir. */
let textoPendente = null;
export function preencherAoAbrir(texto) { textoPendente = texto; }

/* ============================================================
   Abrir / fechar
   ============================================================ */

export async function abrirConversa(assunto) {
  if (c.assunto?.id === assunto.id) return;
  fecharConversa();
  c.assunto = assunto;
  c.mensagens = [];
  c.membros = new Map();
  c.temMais = false;
  c.pronto = false;
  c.ancorado = false;

  ta.disabled = false;
  ta.value = guardado.ler(chaveRascunho(), '');
  if (textoPendente) {
    ta.value = ta.value.trim() ? ta.value.trimEnd() + '\n' + textoPendente : textoPendente;
    textoPendente = null;
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);
  }
  ajustarAltura();
  detectarLink(true);
  atualizarBotaoEnviar();
  lista.replaceChildren(el('div', { className: 'aviso-centro' }, 'Carregando…'));

  const id = assunto.id;
  // 1. O que está guardado no aparelho aparece na hora (funciona sem internet)
  const doCache = await mensagensDoAssunto(id);
  if (c.assunto?.id !== id) return;
  if (doCache.length) {
    c.mensagens = doCache;
    desenhar();
    rolarParaFim();
  }
  c.ctx.marcarLido(id);

  // 2. Depois, a versão do servidor
  const [msgs] = await Promise.all([buscarPagina(id), carregarMembros(id)]);
  if (c.assunto?.id !== id) return; // trocou de assunto enquanto carregava
  if (msgs.error) {
    if (!doCache.length) {
      lista.replaceChildren(el('div', { className: 'aviso-centro erro' }, erroDeRede(msgs.error)
        ? 'Sem internet e nada guardado neste aparelho para este assunto ainda.'
        : 'Não consegui carregar as mensagens. ' + mensagemDe(msgs.error)));
    }
    terminouDeAbrir();
    return;
  }
  // o que ainda está na fila (apagado/editado sem internet) vale mais que o servidor
  const fila = await filaTodas();
  const apagando = new Set(fila.filter(o => o.tipo === 'apagar').flatMap(o => o.ids));
  const editando = new Map(fila.filter(o => o.tipo === 'editar').map(o => [o.id, o.campos]));
  const pagina = msgs.data.reverse().filter(m => !apagando.has(m.id)).map(m => editando.has(m.id) ? { ...m, ...editando.get(m.id) } : m);
  const completa = msgs.data.length < POR_PAGINA;
  await guardarPaginaNova(id, pagina, completa);
  const pendentes = c.mensagens.filter(m => m._pendente);
  const antigas = completa ? [] : c.mensagens.filter(m => !m._pendente && pagina.length && m.criado_em < pagina[0].criado_em);
  const estavaNoFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 80;
  c.mensagens = [...antigas, ...pagina, ...pendentes.filter(p => !pagina.some(m => m.id === p.id))];
  c.temMais = !completa;
  desenhar();
  if (!doCache.length || estavaNoFim) rolarParaFim();
  if (temMouse()) ta.focus();
  terminouDeAbrir();
}

/* ---------- Pular para uma mensagem (resultado de busca) ---------- */

let irParaPendente = null;

export function irParaMensagem(id, criadoEm, categoriaId) {
  if (c.assunto?.id === categoriaId && c.pronto) return irPara(id, criadoEm);
  irParaPendente = { id, criadoEm };
}

function terminouDeAbrir() {
  c.pronto = true;
  if (irParaPendente) { const p = irParaPendente; irParaPendente = null; irPara(p.id, p.criadoEm); }
}

async function irPara(id, criadoEm) {
  if (!c.mensagens.some(m => m.id === id) && navigator.onLine && c.assunto) {
    // mensagem antiga, fora do que está carregado: carrega dela até hoje
    const catId = c.assunto.id;
    const { data, error } = await supabase.from('mensagens')
      .select('id, categoria_id, autor_id, texto, link, criado_em, editado_em')
      .eq('categoria_id', catId).is('apagado_em', null)
      .gte('criado_em', criadoEm).order('criado_em', { ascending: true }).limit(1000);
    if (!error && c.assunto?.id === catId) {
      const pend = c.mensagens.filter(m => m._pendente && !data.some(d => d.id === m.id));
      c.mensagens = [...data, ...pend];
      c.temMais = true;
      guardarMensagens(data);
      desenhar();
    }
  }
  const no = lista.querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (!no) { toast('Não encontrei essa mensagem aqui.'); return; }
  c.ancorado = true;
  c.destacada = id;            // sobrevive a redesenhos (ex.: carregar mais antigas ao rolar)
  no.scrollIntoView({ block: 'center' });
  no.classList.add('destaque');
  setTimeout(() => {
    if (c.destacada !== id) return;
    c.destacada = null;
    lista.querySelector('.msg.destaque')?.classList.remove('destaque');
  }, 2500);
}

/* ============================================================
   Mudanças chegando em tempo real (de outro aparelho ou da outra pessoa)
   ============================================================ */

export function receberMensagem(row) {
  if (!c.assunto) return;
  const i = c.mensagens.findIndex(m => m.id === row.id);
  const daqui = row.categoria_id === c.assunto.id && !row.apagado_em;
  if (!daqui) {
    if (row.apagado_em || i >= 0) removerMensagens([row.id]);   // apagada ou movida para outro assunto
    if (i >= 0) { c.mensagens.splice(i, 1); desenhar(); }
    return;
  }
  const m = { id: row.id, categoria_id: row.categoria_id, autor_id: row.autor_id, texto: row.texto,
    link: row.link, criado_em: row.criado_em, editado_em: row.editado_em };
  if (i >= 0) {
    if (c.editando?.id === m.id) return; // não atropela quem está editando
    c.mensagens[i] = m;
  } else {
    c.mensagens.push(m);
    c.mensagens.sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  }
  guardarMensagens([m]);
  const estavaNoFim = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 120;
  desenhar();
  if (estavaNoFim) rolarParaFim();
  if (document.visibilityState === 'visible') c.ctx.marcarLido(c.assunto.id);
}

/* Resultado da fila de envio */
aoProcessar(({ op, ok, erro }) => {
  if (op.tipo === 'inserir') {
    const m = c.mensagens.find(x => x.id === op.msg.id);
    if (ok) {
      const final = { ...op.msg };
      guardarMensagens([final]);
      if (m) { delete m._pendente; m.link = final.link; desenhar(); }
      c.ctx.aoEnviar(op.msg.categoria_id, final);
    } else {
      removerMensagens([op.msg.id]);
      if (m) { c.mensagens = c.mensagens.filter(x => x !== m); desenhar(); }
      toast('Uma mensagem não pôde ser enviada. ' + mensagemDe(erro));
    }
    return;
  }
  if (!ok) {
    toast((op.tipo === 'apagar' ? 'Não deu para excluir. ' : 'Não deu para salvar a edição. ') + mensagemDe(erro));
    if (c.assunto) { const a = c.assunto; c.assunto = null; abrirConversa(a); } // recarrega a versão do servidor
    return;
  }
  c.ctx.aoMoverOuApagar();
});

export function fecharConversa() {
  fecharBusca(false);
  if (!c.assunto) return;
  if (!c.editando) guardado.gravar(chaveRascunho(), ta.value);
  limparSelecao();
  cancelarEdicao(false);
  c.assunto = null;
  c.preview = null;
  c.descartada = null;
  desenharPreview();
}

/** O assunto aberto mudou (renomeado, por exemplo). */
export function assuntoAtualizado(assunto) {
  if (c.assunto?.id === assunto.id) c.assunto = assunto;
}

function chaveRascunho() { return 'notas.rascunho.' + c.assunto.id; }

function buscarPagina(categoriaId, antesDe) {
  let q = supabase.from('mensagens')
    .select('id, categoria_id, autor_id, texto, link, criado_em, editado_em')
    .eq('categoria_id', categoriaId)
    .is('apagado_em', null)
    .order('criado_em', { ascending: false })
    .limit(POR_PAGINA);
  if (antesDe) q = q.lt('criado_em', antesDe);
  return q;
}

async function carregarMembros(categoriaId) {
  let { data, error } = await supabase.rpc('membros_da_categoria', { p_categoria: categoriaId });
  if (error) data = await kvLer('membros.' + categoriaId);          // sem internet: usa o último conhecido
  else kvGravar('membros.' + categoriaId, data);
  c.membros = new Map((data || []).map(m => [m.usuario_id, m.nome]));
}

/* ============================================================
   Desenho das mensagens
   ============================================================ */

const eMinha = (m) => m.autor_id === c.ctx.usuario.id;
const podeAlterar = (m) => eMinha(m) || c.assunto?.dono_id === c.ctx.usuario.id;

function desenhar() {
  const nos = [];
  if (c.temMais) nos.push(el('div', { className: 'aviso-centro discreto' }, 'Role para cima para ver mais'));
  if (!c.mensagens.length) {
    nos.push(el('div', { className: 'aviso-centro' }, 'Nenhuma mensagem ainda. Escreva algo ou cole um link abaixo.'));
  }
  let diaAnterior = '';
  for (const m of c.mensagens) {
    const dia = new Date(m.criado_em).toDateString();
    if (dia !== diaAnterior) {
      nos.push(el('div', { className: 'separador-dia' }, el('span', {}, rotuloDia(m.criado_em))));
      diaAnterior = dia;
    }
    nos.push(desenharMensagem(m));
  }
  lista.replaceChildren(...nos);
  carregarThumbs(lista);
}

function desenharMensagem(m) {
  const minha = eMinha(m);
  const bolha = el('div', { className: 'bolha' + (m.link ? ' com-link' : '') });

  if (!minha && c.membros.size > 1) {
    bolha.append(el('div', { className: 'autor' }, c.membros.get(m.autor_id) || 'Alguém'));
  }
  if (m.link) bolha.append(cartaoLink(m.link));
  if (m.texto) {
    const t = el('div', { className: 'texto' });
    t.append(formatar(m.texto));
    bolha.append(t);
  }
  bolha.append(el('span', { className: 'meta' },
    m.editado_em ? el('span', { className: 'editada' }, 'editada') : null,
    hora(m.criado_em),
    m._pendente ? el('span', { className: 'pendente', title: 'Enviando' }, ' 🕓') : null,
  ));

  return el('div', {
    className: 'msg ' + (minha ? 'minha' : 'outra') + (c.selecionadas.has(m.id) ? ' selecionada' : '') + (c.destacada === m.id ? ' destaque' : ''),
    dataset: { id: m.id },
  }, bolha);
}

/** Cartão do link: thumb, título, descrição e site. */
export function cartaoLink(link, { noComposer = false } = {}) {
  const href = urlSegura(link.url);
  const card = el(href && !noComposer ? 'a' : 'div', {
    className: 'card-link' + (link.imagem ? '' : ' sem-imagem'),
    href: href && !noComposer ? href : null,
    target: href && !noComposer ? '_blank' : null,
    rel: href && !noComposer ? 'noopener noreferrer' : null,
  });
  if (link.imagem) {
    card.append(el('img', { className: 'card-img', alt: '', loading: 'lazy', dataset: { thumb: link.imagem } }));
  }
  let dominio = '';
  try { dominio = new URL(link.url).hostname.replace(/^www\./, ''); } catch { /* ok */ }
  const txt = el('div', { className: 'card-txt' },
    el('strong', { className: 'card-titulo' }, link.titulo || dominio || link.url),
    link.descricao ? el('span', { className: 'card-desc' }, link.descricao) : null,
    el('small', { className: 'card-site' }, link.site && link.site !== dominio ? `${link.site} · ${dominio}` : dominio),
  );
  card.append(txt);
  return card;
}

function carregarThumbs(raiz) {
  raiz.querySelectorAll('img[data-thumb]:not([src])').forEach(img => {
    urlDaThumb(img.dataset.thumb)
      .then(u => {
        const noFim = !c.ancorado && lista.scrollHeight - lista.scrollTop - lista.clientHeight < 80;
        img.addEventListener('load', () => { if (noFim) rolarParaFim(); }, { once: true });
        img.src = u;
      })
      .catch(() => { img.closest('.card-link')?.classList.add('sem-imagem'); img.remove(); });
    img.addEventListener('error', () => { img.closest('.card-link')?.classList.add('sem-imagem'); img.remove(); }, { once: true });
  });
}

function rolarParaFim() { lista.scrollTop = lista.scrollHeight; }

/* ---------- Mais antigas ao rolar para cima ---------- */

lista.addEventListener('scroll', async () => {
  if (lista.scrollTop > 120 || !c.temMais || c.carregandoMais || !c.assunto) return;
  c.carregandoMais = true;
  const id = c.assunto.id;
  const { data, error } = await buscarPagina(id, c.mensagens[0]?.criado_em);
  c.carregandoMais = false;
  if (error || c.assunto?.id !== id) return;
  const alturaAntes = lista.scrollHeight;
  guardarMensagens(data);
  c.mensagens = data.reverse().concat(c.mensagens);
  c.temMais = data.length === POR_PAGINA;
  desenhar();
  lista.scrollTop += lista.scrollHeight - alturaAntes;
}, { passive: true });

/* ============================================================
   Toques nas mensagens: abrir link, toque longo, seleção
   ============================================================ */

let timerLongo = null;
let inicioToque = null;
let ignorarClique = false;

lista.addEventListener('pointerdown', (e) => {
  const msg = e.target.closest('.msg');
  if (!msg || e.button > 0) return;
  inicioToque = { x: e.clientX, y: e.clientY };
  clearTimeout(timerLongo);
  timerLongo = setTimeout(() => {
    timerLongo = null;
    ignorarClique = true;
    alternarSelecao(msg.dataset.id, true);
    navigator.vibrate?.(15);
  }, 450);
});
lista.addEventListener('pointermove', (e) => {
  if (timerLongo && inicioToque && Math.hypot(e.clientX - inicioToque.x, e.clientY - inicioToque.y) > 10) {
    clearTimeout(timerLongo); timerLongo = null;
  }
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => lista.addEventListener(t, () => {
  clearTimeout(timerLongo); timerLongo = null;
}));

// Botão direito no computador (e toque longo em alguns Androids)
lista.addEventListener('contextmenu', (e) => {
  const msg = e.target.closest('.msg');
  if (!msg) return;
  e.preventDefault();
  if (ignorarClique) return; // o toque longo já selecionou
  alternarSelecao(msg.dataset.id, true);
});

lista.addEventListener('click', (e) => {
  const msg = e.target.closest('.msg');
  if (ignorarClique) { ignorarClique = false; e.preventDefault(); return; }
  if (!msg) return;

  if (c.selecionadas.size) {           // modo seleção: toque marca/desmarca, não abre link
    e.preventDefault();
    alternarSelecao(msg.dataset.id);
    return;
  }
  if (e.target.closest('a')) return;   // link dentro do texto ou o próprio cartão
  const m = c.mensagens.find(x => x.id === msg.dataset.id);
  const href = m?.link && urlSegura(m.link.url);
  if (href && !getSelection().toString()) window.open(href, '_blank', 'noopener');
});

/* ============================================================
   Modo seleção
   ============================================================ */

function alternarSelecao(id, porToqueLongo = false) {
  const m = c.mensagens.find(x => x.id === id);
  if (!m || m._pendente) return;
  if (!podeAlterar(m)) {
    if (porToqueLongo) toast('Só dá para alterar as suas mensagens neste assunto.');
    return;
  }
  const entrando = c.selecionadas.size === 0;
  if (c.selecionadas.has(id)) c.selecionadas.delete(id);
  else c.selecionadas.add(id);

  if (entrando && c.selecionadas.size) history.pushState({ ...(history.state || {}), selecao: true }, '');
  if (!c.selecionadas.size) return sairSelecao();
  atualizarSelecao();
}

function atualizarSelecao() {
  const n = c.selecionadas.size;
  $('barra-selecao').hidden = n === 0;
  $('barra-conversa').hidden = n > 0;
  $('selecao-contador').textContent = n === 1 ? '1 selecionada' : `${n} selecionadas`;
  $('sel-editar').disabled = n !== 1;
  lista.querySelectorAll('.msg').forEach(d => d.classList.toggle('selecionada', c.selecionadas.has(d.dataset.id)));
  lista.classList.toggle('selecionando', n > 0);
}

function limparSelecao() {
  c.selecionadas.clear();
  atualizarSelecao();
}

/** Sai do modo seleção (desfaz a entrada no histórico, para o "voltar" do celular funcionar). */
function sairSelecao() {
  if (history.state?.selecao) history.back(); // o popstate abaixo limpa
  else limparSelecao();
}

window.addEventListener('popstate', () => {
  if (c.selecionadas.size && !history.state?.selecao) limparSelecao();
});

$('sel-fechar').addEventListener('click', sairSelecao);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('dialog[open]')) return;
  if (c.selecionadas.size) sairSelecao();
  else if (c.editando) cancelarEdicao();
});

function selecionadasEmOrdem() {
  return c.mensagens.filter(m => c.selecionadas.has(m.id));
}

/* ---------- Copiar ---------- */

$('sel-copiar').addEventListener('click', async () => {
  const texto = selecionadasEmOrdem().map(m => {
    const url = m.link?.url;
    return url && !(m.texto || '').includes(url) ? [m.texto, url].filter(Boolean).join('\n') : m.texto;
  }).join('\n\n');
  try {
    await navigator.clipboard.writeText(texto);
    toast(c.selecionadas.size > 1 ? 'Mensagens copiadas' : 'Mensagem copiada');
  } catch {
    toast('Não consegui copiar.');
  }
  sairSelecao();
});

/* ---------- Excluir (segundo toque confirma) ---------- */

$('sel-excluir').addEventListener('click', (e) => {
  const n = c.selecionadas.size;
  confirmarComSegundoToque(e.currentTarget, `Excluir ${n}?`, async () => {
    const ids = [...c.selecionadas];
    c.mensagens = c.mensagens.filter(m => !c.selecionadas.has(m.id));
    sairSelecao();
    desenhar();
    await removerMensagens(ids);
    await gravar({ tipo: 'apagar', ids, apagado_em: new Date().toISOString() });
    toast(ids.length > 1 ? `${ids.length} mensagens excluídas` : 'Mensagem excluída');
  });
});

/* ---------- Mover ---------- */

$('sel-mover').addEventListener('click', () => {
  if (!navigator.onLine) { toast('Mover precisa de internet.'); return; }
  const destinos = c.ctx.assuntos().filter(a => a.id !== c.assunto.id);
  const ul = $('mover-lista');
  ul.replaceChildren(...destinos.map(a => el('li', {},
    el('button', { type: 'button', className: 'item-destino', dataset: { id: a.id } },
      el('span', { className: 'avatar' }, a.emoji || a.nome.trim().charAt(0)),
      el('span', {}, a.nome)))));
  $('mover-vazio').hidden = destinos.length > 0;
  $('dlg-mover').showModal();
});

$('mover-lista').addEventListener('click', async (e) => {
  const b = e.target.closest('.item-destino');
  if (!b) return;
  $('dlg-mover').close();
  const ids = [...c.selecionadas];
  const destino = c.ctx.assuntos().find(a => a.id === b.dataset.id);
  const { data, error } = await supabase.rpc('mover_mensagens', { p_ids: ids, p_destino: b.dataset.id });
  if (error) { toast('Não deu para mover. ' + mensagemDe(error)); return; }
  c.mensagens = c.mensagens.filter(m => !c.selecionadas.has(m.id));
  removerMensagens(ids);
  sairSelecao();
  desenhar();
  toast(`${data ?? ids.length} movida(s) para ${destino?.nome || 'outro assunto'}`);
  c.ctx.aoMoverOuApagar();
});

/* ---------- Editar ---------- */

$('sel-editar').addEventListener('click', () => {
  const [m] = selecionadasEmOrdem();
  if (!m) return;
  sairSelecao();
  c.rascunhoAntesDeEditar = ta.value;
  c.editando = m;
  ta.value = m.texto || '';
  c.descartada = null;
  c.preview = m.link ? { url: m.link.url, estado: 'ok', dados: m.link } : null;
  if (!m.link) c.descartada = primeiraUrl(m.texto); // sem preview antes: não cria um sozinho
  $('composer-editando').hidden = false;
  $('composer').classList.add('editando');
  $('btn-enviar').setAttribute('aria-label', 'Salvar edição');
  desenharPreview();
  ajustarAltura();
  atualizarBotaoEnviar();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
});

$('editando-cancelar').addEventListener('click', () => cancelarEdicao());

function cancelarEdicao(restaurar = true) {
  if (!c.editando) return;
  c.editando = null;
  $('composer-editando').hidden = true;
  $('composer').classList.remove('editando');
  $('btn-enviar').setAttribute('aria-label', 'Enviar');
  if (restaurar) {
    ta.value = c.rascunhoAntesDeEditar;
    c.preview = null; c.descartada = null;
    detectarLink(true);
    ajustarAltura();
    atualizarBotaoEnviar();
  }
}

/* ============================================================
   Campo de digitar
   ============================================================ */

function ajustarAltura() {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
}

function atualizarBotaoEnviar() {
  $('btn-enviar').disabled = !c.assunto || (!ta.value.trim() && !previewAtivo());
}

let timerDigitacao;
ta.addEventListener('input', () => {
  ajustarAltura();
  atualizarBotaoEnviar();
  clearTimeout(timerDigitacao);
  timerDigitacao = setTimeout(() => {
    detectarLink();
    if (c.assunto && !c.editando) guardado.gravar(chaveRascunho(), ta.value);
  }, 400);
});

ta.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && temMouse()) {
    e.preventDefault();
    enviar();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); envolverSelecao(ta, '*'); }
    if (k === 'i') { e.preventDefault(); envolverSelecao(ta, '_'); }
  }
});

$('composer').addEventListener('submit', (e) => { e.preventDefault(); enviar(); });

/* ---------- Preview no campo de digitar ---------- */

const previewAtivo = () => c.preview && c.preview.url !== c.descartada;

function detectarLink(imediato = false) {
  const url = primeiraUrl(ta.value);
  if (!url) {
    if (c.preview) { c.preview = null; desenharPreview(); atualizarBotaoEnviar(); }
    c.descartada = null;
    return;
  }
  if (url === c.descartada) return;
  if (c.preview?.url === url) return;
  const promessa = buscarPreview(url)
    .catch((e) => { console.warn('preview', e); return previewLeve(url); });
  c.preview = { url, estado: 'carregando', dados: null, promessa };
  desenharPreview();
  atualizarBotaoEnviar();
  promessa.then((dados) => {
    if (c.preview?.url !== url) return;
    c.preview = { url, estado: 'ok', dados: { ...dados, url: dados.url || url }, promessa };
    desenharPreview();
  });
  if (imediato) { /* rascunho reaberto: o preview carrega em segundo plano */ }
}

function desenharPreview() {
  const box = $('composer-preview');
  if (!previewAtivo()) { box.hidden = true; box.replaceChildren(); return; }
  const fechar = el('button', { type: 'button', className: 'preview-fechar', 'aria-label': 'Remover preview', onclick: () => {
    c.descartada = c.preview.url;
    desenharPreview();
    atualizarBotaoEnviar();
    ta.focus();
  } }, '✕');
  const conteudo = c.preview.estado === 'carregando'
    ? el('div', { className: 'card-link carregando' }, el('div', { className: 'card-txt' },
        el('strong', { className: 'card-titulo' }, 'Carregando preview…'),
        el('small', { className: 'card-site' }, c.preview.url)))
    : cartaoLink(c.preview.dados, { noComposer: true });
  box.replaceChildren(conteudo, fechar);
  box.hidden = false;
  carregarThumbs(box);
}

/** Preview para gravar na mensagem; espera até 5 s se ainda estiver carregando. */
async function linkParaEnviar() {
  if (!previewAtivo()) return null;
  const p = c.preview;
  if (p.estado === 'ok') return paraMensagem(p.dados);
  const dados = await Promise.race([p.promessa, new Promise(ok => setTimeout(() => ok(previewLeve(p.url)), 5000))]);
  return paraMensagem({ ...dados, url: dados.url || p.url });
}

/* ---------- Enviar / salvar edição ---------- */

let enviando = false;

async function enviar() {
  if (enviando || !c.assunto) return;
  const texto = ta.value.replace(/\s+$/, '').replace(/^\s*\n/, '');
  if (!texto.trim() && !previewAtivo()) return;
  enviando = true;
  $('btn-enviar').disabled = true;
  try {
    const link = await linkParaEnviar();
    if (c.editando) await salvarEdicao(texto, link);
    else await enviarNova(texto, link);
  } finally {
    enviando = false;
    atualizarBotaoEnviar();
  }
}

async function enviarNova(texto, link) {
  const assunto = c.assunto;
  const msg = {
    id: crypto.randomUUID(),
    categoria_id: assunto.id,
    autor_id: c.ctx.usuario.id,
    texto,
    link,
    criado_em: new Date().toISOString(),
    editado_em: null,
    _pendente: true,
  };
  // aparece na hora (com 🕓 até o servidor confirmar); o campo é limpo
  c.ancorado = false;
  c.mensagens.push(msg);
  ta.value = '';
  c.preview = null; c.descartada = null;
  guardado.gravar(chaveRascunho(), '');
  desenharPreview(); ajustarAltura();
  desenhar(); rolarParaFim();

  await guardarMensagens([msg]);
  const semPreview = link && !link.titulo && !link.imagem; // ex.: enviada sem internet
  const { _pendente, ...dados } = msg;
  await gravar({ tipo: 'inserir', msg: dados, buscarPreview: semPreview ? link.url : null });
  if (!navigator.onLine) toast('Sem internet: a mensagem vai assim que a conexão voltar.');
}

async function salvarEdicao(texto, link) {
  const m = c.editando;
  if (!texto.trim() && !link) return;
  const editado_em = new Date().toISOString();
  Object.assign(m, { texto, link, editado_em });
  c.editando = null;
  cancelarEdicaoVisual();
  desenhar();
  await guardarMensagens([m]);
  await gravar({ tipo: 'editar', id: m.id, campos: { texto, link, editado_em } });
}

function cancelarEdicaoVisual() {
  $('composer-editando').hidden = true;
  $('composer').classList.remove('editando');
  $('btn-enviar').setAttribute('aria-label', 'Enviar');
  ta.value = c.rascunhoAntesDeEditar;
  c.preview = null; c.descartada = null;
  detectarLink(true);
  ajustarAltura();
}

/* ============================================================
   Buscar nesta conversa
   ============================================================ */

let buscaAberta = false;
let timerBusca;

$('btn-buscar-conversa').addEventListener('click', () => {
  if (!c.assunto) return;
  buscaAberta = true;
  history.pushState({ ...(history.state || {}), busca: true }, '');
  $('barra-conversa').hidden = true;
  $('barra-busca').hidden = false;
  $('busca-conversa-texto').value = '';
  desenharResultadosConversa([], '');
  $('busca-conversa-texto').focus();
});

$('busca-conversa-texto').addEventListener('input', (e) => {
  clearTimeout(timerBusca);
  const termo = e.target.value;
  if (termo.trim().length < 2) { desenharResultadosConversa([], termo); return; }
  timerBusca = setTimeout(async () => {
    try {
      const { itens, offline } = await buscarMensagens(termo, c.assunto?.id);
      if ($('busca-conversa-texto').value !== termo) return;
      desenharResultadosConversa(itens, termo, offline);
    } catch (err) {
      desenharResultadosConversa([], termo, false, mensagemDe(err));
    }
  }, 300);
});

function desenharResultadosConversa(itens, termo, offline = false, erro = '') {
  const box = $('busca-conversa-resultados');
  const ativo = termo.trim().length >= 2;
  box.hidden = !ativo;
  if (!ativo) return;
  $('busca-conversa-lista').replaceChildren(...itens.map(m => itemResultado(m, null, termo, false)));
  $('busca-conversa-vazio').hidden = itens.length > 0;
  $('busca-conversa-vazio').textContent = erro || (offline ? 'Nada encontrado no que está guardado neste aparelho.' : 'Nada encontrado.');
}

$('busca-conversa-lista').addEventListener('click', (e) => {
  const b = e.target.closest('.resultado');
  if (!b) return;
  const { id, criado } = b.dataset;
  fecharBusca();
  irPara(id, criado);
});

function fecharBusca(voltarHistorico = true) {
  if (!buscaAberta) return;
  buscaAberta = false;
  $('barra-busca').hidden = true;
  $('barra-conversa').hidden = c.selecionadas.size > 0;
  $('busca-conversa-resultados').hidden = true;
  if (voltarHistorico && history.state?.busca) history.back();
}

$('busca-fechar').addEventListener('click', () => fecharBusca());
window.addEventListener('popstate', () => { if (buscaAberta && !history.state?.busca) fecharBusca(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && buscaAberta) fecharBusca(); });
