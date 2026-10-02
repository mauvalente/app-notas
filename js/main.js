// Notas — inicialização, login, lista de assuntos e rotas.
import { supabase, configOk } from './db.js';
import { sessaoAtual, temAcesso, nomeDe, sair, marcarUso, prepararBotaoGoogle, entrarPorRedirecionamento, renovarSessao } from './auth.js';
import { $, el, toast, mensagemDe, tempo, normalizar, quando, confirmarComSegundoToque } from './util.js';
import { textoSimples } from './formatar.js';
import { configurarConversa, abrirConversa, fecharConversa, assuntoAtualizado, preencherAoAbrir, receberMensagem, irParaMensagem } from './conversa.js';
import { buscarMensagens, itemResultado } from './busca.js';
import { abrirBanco, apagarBanco, kvLer, kvGravar } from './store.js';
import { processarFila, erroDeRede } from './sync.js';
import { abrirNota, fecharNota } from './nota.js';

export const VERSAO = '1.0.0';

const estado = {
  usuario: null,        // { id, email, nome }
  todos: [],            // todos os assuntos (inclui arquivados)
  assuntos: [],         // visíveis na lista, já ordenados
  ultimas: new Map(),   // categoria_id → { texto, titulo, criado_em }
  naoLidas: new Map(),  // categoria_id → quantidade
  filtro: '',
};

/* ============================================================
   Início
   ============================================================ */

async function iniciar() {
  registrarServiceWorker();
  $('versao').textContent = VERSAO;

  if (!configOk) {
    mostrarLogin('O config.js ainda não foi preenchido. Veja os passos 2 e 4 do README.');
    return;
  }

  // Erro devolvido pelo plano B (login por redirecionamento)
  const erroRetorno = new URL(location.href).searchParams.get('error_description');

  try {
    const sessao = await sessaoAtual();
    if (sessao) return await entrou(sessao);
    mostrarLogin(erroRetorno);
  } catch (e) {
    console.error(e);
    mostrarLogin('Não consegui verificar o login. ' + mensagemDe(e));
  }
}

async function entrou(sessao) {
  const u = sessao.user;
  await abrirBanco(u.id);
  const perfil = await kvLer('perfil');
  let permitido = null;
  try { permitido = await temAcesso(); } catch (e) { if (!erroDeRede(e)) console.error(e); }
  if (permitido === null) permitido = perfil?.permitido === true; // sem internet: vale o último resultado
  if (!permitido) {
    await sair();
    mostrarLogin(`O e-mail ${u.email} não tem acesso a este app.`);
    return;
  }
  const nome = navigator.onLine ? await nomeDe(u.email) : (perfil?.nome || u.email);
  kvGravar('perfil', { permitido: true, nome });
  estado.usuario = { id: u.id, email: u.email, nome };
  mostrarApp();
  processarFila();
  assinarTempoReal();
}

supabase?.auth.onAuthStateChange((evento) => {
  if (evento === 'SIGNED_OUT' && estado.usuario) {
    estado.usuario = null;
    canal?.unsubscribe(); canal = null;
    fecharConversa();
    apagarBanco(); // o cache deste aparelho sai junto com a conta
    mostrarLogin();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !estado.usuario) return;
  marcarUso();
  processarFila();
  carregarAssuntos(); // pega o que mudou em outro aparelho
  if (idDaRota()) marcarLido(idDaRota());
});

/* ---------- Sem internet ---------- */

function atualizarOffline() {
  $('aviso-offline').hidden = navigator.onLine;
  document.body.classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('offline', atualizarOffline);
window.addEventListener('online', async () => {
  atualizarOffline();
  if (!estado.usuario) return;
  await renovarSessao();
  processarFila();
  carregarAssuntos();
  assinarTempoReal();
});
atualizarOffline();

/* ---------- Tempo real ---------- */

let canal = null;
let timerRecarga = null;
const recarregarEmBreve = () => { clearTimeout(timerRecarga); timerRecarga = setTimeout(carregarAssuntos, 600); };

function assinarTempoReal() {
  if (!estado.usuario || !navigator.onLine) return;
  canal?.unsubscribe();
  canal = supabase.channel('notas-' + estado.usuario.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens' }, (p) => {
      if (p.new && p.new.id) receberMensagem(p.new);
      recarregarEmBreve();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'categorias' }, recarregarEmBreve)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'categoria_membros' }, recarregarEmBreve)
    .subscribe();
}

/* ---------- Lido / não lidas ---------- */

const ultimoMarcado = new Map();
async function marcarLido(id) {
  if (!estado.usuario) return;
  if (estado.naoLidas.delete(id)) desenharLista();
  if (Date.now() - (ultimoMarcado.get(id) || 0) < 3000) return;
  ultimoMarcado.set(id, Date.now());
  await supabase.from('categoria_membros').update({ lido_ate: new Date().toISOString() })
    .eq('categoria_id', id).eq('usuario_id', estado.usuario.id);
}

/* ============================================================
   Login
   ============================================================ */

async function mostrarLogin(erro) {
  document.body.classList.remove('carregando', 'em-conversa');
  $('app').hidden = true;
  $('tela-login').hidden = false;
  mostrarErroLogin(erro);
  if (!configOk) { $('login-alternativo').hidden = true; return; }
  try {
    await prepararBotaoGoogle($('google-botao'), {
      aoEntrar: (sessao) => entrou(sessao),
      aoErrar: (e) => { console.error(e); mostrarLogin('Não deu para entrar. ' + mensagemDe(e)); },
    });
  } catch (e) {
    mostrarErroLogin(mensagemDe(e));
  }
}

function mostrarErroLogin(texto) {
  $('login-erro').textContent = texto || '';
  $('login-erro').hidden = !texto;
}

$('login-alternativo').addEventListener('click', async () => {
  try { await entrarPorRedirecionamento(); }
  catch (e) { mostrarErroLogin(mensagemDe(e)); }
});

/* ============================================================
   App
   ============================================================ */

configurarConversa({
  get usuario() { return estado.usuario; },
  assuntos: () => estado.assuntos,
  aoEnviar(assuntoId, msg) {
    const a = estado.todos.find(x => x.id === assuntoId);
    if (a) a.ultima_msg_em = msg.criado_em;
    estado.ultimas.set(assuntoId, { texto: msg.texto, titulo: msg.link?.titulo || msg.link?.url, criado_em: msg.criado_em });
    ordenarEDesenhar();
  },
  aoMoverOuApagar() { carregarAssuntos(); },
  marcarLido: (id) => marcarLido(id),
});

async function mostrarApp() {
  $('tela-login').hidden = true;
  $('app').hidden = false;
  document.body.classList.remove('carregando');

  const { nome, email } = estado.usuario;
  $('conta-nome').textContent = nome;
  $('conta-email').textContent = email;
  $('conta-avatar').textContent = (nome || email).trim().charAt(0);

  await carregarAssuntos();
  aplicarRota();
  tratarCompartilhamento();
}

/* ============================================================
   Receber do botão Compartilhar (Android) ou do Atalho (iPhone)
   O app abre como  ./?title=...&text=...&url=...
   ============================================================ */

let compartilhado = null;

function lerCompartilhamento() {
  const q = new URL(location.href).searchParams;
  if (!['title', 'text', 'url'].some(k => q.has(k))) return null;
  const titulo = (q.get('title') || '').trim();
  let texto = (q.get('text') || '').trim();
  const url = (q.get('url') || '').trim();
  if (url && !texto.includes(url)) texto = texto ? texto + '\n' + url : url;
  if (!texto && titulo) texto = titulo;
  return texto || null;
}

function tratarCompartilhamento() {
  const texto = lerCompartilhamento();
  if (!texto) return;
  // limpa a URL para um recarregar não repetir o compartilhamento
  history.replaceState(null, '', location.pathname + (location.hash || '#/'));
  compartilhado = texto;
  $('salvar-em-texto').textContent = texto;
  $('salvar-em-busca').value = '';
  desenharSalvarEm();
  $('dlg-salvar-em').showModal();
}

function desenharSalvarEm() {
  const f = normalizar($('salvar-em-busca').value);
  const itens = estado.assuntos.filter(a => !ehNota(a) && (!f || normalizar(a.nome).includes(f)));
  $('salvar-em-lista').replaceChildren(...itens.map(a => el('li', {},
    el('button', { type: 'button', className: 'item-destino', dataset: { id: a.id } },
      avatarEl(a),
      el('span', {}, a.nome)))));
  $('salvar-em-vazio').hidden = itens.length > 0;
}

$('salvar-em-busca').addEventListener('input', desenharSalvarEm);

$('salvar-em-lista').addEventListener('click', (e) => {
  const b = e.target.closest('.item-destino');
  if (!b || !compartilhado) return;
  $('dlg-salvar-em').close('escolhido');
  preencherAoAbrir(compartilhado);
  compartilhado = null;
  if (idDaRota() === b.dataset.id) fecharConversa(); // força reabrir para pegar o texto
  abrirAssunto(b.dataset.id);
});

let compartilhadoParaNovo = null;

$('salvar-em-novo').addEventListener('click', () => {
  compartilhadoParaNovo = compartilhado;
  compartilhado = null;
  $('dlg-salvar-em').close('novo');
  abrirFormAssunto();
});

// Cancelou a criação do assunto: volta para o "Salvar em…" com o mesmo texto
$('dlg-assunto').addEventListener('close', () => {
  if (!compartilhadoParaNovo) return;
  const texto = compartilhadoParaNovo;
  compartilhadoParaNovo = null;
  compartilhado = texto;
  desenharSalvarEm();
  $('dlg-salvar-em').showModal();
});

$('dlg-salvar-em').addEventListener('close', () => {
  if (compartilhado) { compartilhado = null; toast('Compartilhamento descartado.'); }
});

/* ---------- Assuntos ---------- */

let carregando = null;
function carregarAssuntos() {
  carregando ??= (async () => {
    try {
      const [cats, minhas, ultimas, naoLidas] = await Promise.all([
        supabase.from('categorias').select('id, nome, emoji, cor, tipo, dono_id, ultima_msg_em, criado_em'),
        supabase.from('categoria_membros').select('categoria_id, usuario_id, papel, fixada, arquivada'),
        supabase.rpc('ultimas_mensagens'),
        supabase.rpc('nao_lidas'),
      ]);
      if (cats.error || minhas.error) {
        const erro = cats.error || minhas.error;
        if (erroDeRede(erro)) {
          // sem internet: mostra o que ficou guardado no aparelho
          if (!estado.todos.length) {
            const guardado = await kvLer('assuntos');
            if (guardado) {
              estado.todos = guardado.todos;
              estado.ultimas = new Map(guardado.ultimas);
              estado.naoLidas = new Map(guardado.naoLidas || []);
              for (const id of guardado.comMembros || []) comMembros.add(id);
              ordenarEDesenhar();
            }
          }
        } else {
          toast('Não consegui carregar os assuntos. ' + mensagemDe(erro));
        }
        return;
      }
      const minhasLinhas = minhas.data.filter(x => x.usuario_id === estado.usuario.id);
      comMembros.clear();
      for (const x of minhas.data) if (x.usuario_id !== estado.usuario.id) comMembros.add(x.categoria_id);
      const porId = new Map(minhasLinhas.map(m => [m.categoria_id, m]));
      estado.todos = cats.data.map(c => ({ ...c, ...(porId.get(c.id) || {}) }));
      if (!ultimas.error && Array.isArray(ultimas.data)) estado.ultimas = new Map(ultimas.data.map(u => [u.categoria_id, u]));
      if (!naoLidas.error && Array.isArray(naoLidas.data)) {
        estado.naoLidas = new Map(naoLidas.data.map(n => [n.categoria_id, n.qtd]));
        if (idDaRota()) estado.naoLidas.delete(idDaRota());
      }
      kvGravar('assuntos', { todos: estado.todos, ultimas: [...estado.ultimas], naoLidas: [...estado.naoLidas], comMembros: [...comMembros] });
      ordenarEDesenhar();
      // o assunto aberto pode ter sido apagado/abandonado em outro aparelho
      if (idDaRota() && !estado.todos.some(a => a.id === idDaRota())) aplicarRota();
    } finally {
      carregando = null;
    }
  })();
  return carregando;
}

function ordenarEDesenhar() {
  estado.assuntos = estado.todos
    .filter(c => !c.arquivada)
    .sort((a, b) =>
      (b.fixada === true) - (a.fixada === true) ||
      tempo(b.ultima_msg_em || b.criado_em) - tempo(a.ultima_msg_em || a.criado_em));
  desenharLista();
}

function avatarDe(a) { return a.emoji || a.nome.trim().charAt(0); }

/** Assunto do tipo Nota (os antigos, sem tipo, são conversa). */
export const ehNota = (a) => a?.tipo === 'nota';

/** Avatar do assunto; nas notas, com um 📝 pequeno no canto. */
function avatarEl(a, classe = '') {
  return el('span', { className: 'avatar' + (classe ? ' ' + classe : '') + (ehNota(a) ? ' com-selo' : '') },
    avatarDe(a), ehNota(a) ? el('span', { className: 'selo', 'aria-label': 'Nota' }, '📝') : null);
}

/** Assunto com mais de uma pessoa (sou editor, ou sou dono e chamei alguém). */
const comMembros = new Set();
function temOutros(a) { return a.papel === 'editor' || comMembros.has(a.id); }

function desenharLista() {
  const ul = $('lista-assuntos');
  const f = normalizar(estado.filtro);
  const itens = estado.assuntos.filter(a => !f || normalizar(a.nome).includes(f));
  const atual = idDaRota();

  ul.replaceChildren(...itens.map(a => {
    const u = estado.ultimas.get(a.id);
    let previa = ehNota(a) ? 'Nota' : 'Sem mensagens';
    if (u && !ehNota(a)) {
      const t = textoSimples(u.texto);
      previa = u.titulo && !t ? '🔗 ' + u.titulo : (u.titulo ? '🔗 ' : '') + t;
    }
    return el('li', { className: 'assunto' + (a.id === atual ? ' ativo' : ''), dataset: { id: a.id }, tabindex: '0' },
      avatarEl(a),
      el('div', { className: 'assunto-corpo' },
        el('div', { className: 'assunto-topo' },
          el('span', { className: 'assunto-nome' }, (a.fixada ? '📌 ' : '') + a.nome + (temOutros(a) ? ' 👥' : '')),
          el('span', { className: 'assunto-hora' + (estado.naoLidas.get(a.id) ? ' com-nao-lidas' : '') }, quando(u?.criado_em || a.ultima_msg_em))),
        el('div', { className: 'assunto-baixo' },
          el('div', { className: 'assunto-previa' }, previa),
          estado.naoLidas.get(a.id) ? el('span', { className: 'nao-lidas' }, String(estado.naoLidas.get(a.id))) : null)));
  }));

  $('lista-vazia').hidden = estado.assuntos.length > 0;
  const arq = estado.todos.filter(a => a.arquivada).length;
  $('btn-arquivados').hidden = arq === 0;
  $('btn-arquivados').textContent = `Assuntos arquivados (${arq})`;
}

$('busca-assuntos').addEventListener('input', (e) => {
  estado.filtro = e.target.value;
  desenharLista();
  agendarBuscaGlobal();
});

/* ---------- Busca nas mensagens de todos os assuntos ---------- */

let timerBuscaGlobal;
function agendarBuscaGlobal() {
  clearTimeout(timerBuscaGlobal);
  const termo = estado.filtro.trim();
  const box = $('resultados-mensagens');
  if (termo.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  $('resultados-titulo').textContent = 'Mensagens · buscando…';
  timerBuscaGlobal = setTimeout(async () => {
    let r;
    try { r = await buscarMensagens(termo); }
    catch (e) { r = { itens: [], erro: mensagemDe(e) }; }
    if (estado.filtro.trim() !== termo) return;
    const porId = new Map(estado.todos.map(a => [a.id, a]));
    $('resultados-lista').replaceChildren(...r.itens.map(m => itemResultado(m, porId.get(m.categoria_id), termo)));
    $('resultados-titulo').textContent = r.itens.length
      ? `Mensagens (${r.itens.length}${r.itens.length === 50 ? '+' : ''})` + (r.offline ? ' · sem internet: só o que está no aparelho' : '')
      : 'Mensagens';
    $('resultados-vazio').hidden = r.itens.length > 0;
    $('resultados-vazio').textContent = r.erro || (r.offline ? 'Nada encontrado no que está guardado neste aparelho.' : 'Nenhuma mensagem encontrada.');
  }, 300);
}

$('resultados-lista').addEventListener('click', (e) => {
  const b = e.target.closest('.resultado');
  if (!b) return;
  irParaMensagem(b.dataset.id, b.dataset.criado, b.dataset.categoria);
  abrirAssunto(b.dataset.categoria);
});

/* ---------- Toques na lista: abrir e toque longo (menu) ---------- */

let timerLongo = null, origem = null, ignorarClique = false;
const listaEl = $('lista-assuntos');

listaEl.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('.assunto');
  ignorarClique = false;
  if (!li || e.button > 0) return;
  origem = { x: e.clientX, y: e.clientY };
  timerLongo = setTimeout(() => {
    timerLongo = null; ignorarClique = true;
    navigator.vibrate?.(15);
    abrirMenuAssunto(li.dataset.id);
  }, 450);
});
listaEl.addEventListener('pointermove', (e) => {
  if (timerLongo && Math.hypot(e.clientX - origem.x, e.clientY - origem.y) > 10) { clearTimeout(timerLongo); timerLongo = null; }
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => listaEl.addEventListener(t, () => { clearTimeout(timerLongo); timerLongo = null; }));
listaEl.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('.assunto');
  if (!li) return;
  e.preventDefault();
  if (!ignorarClique) abrirMenuAssunto(li.dataset.id);
});
listaEl.addEventListener('click', (e) => {
  if (ignorarClique) { ignorarClique = false; return; }
  const li = e.target.closest('.assunto');
  if (li) abrirAssunto(li.dataset.id);
});
listaEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.assunto')) abrirAssunto(e.target.dataset.id);
  if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && e.target.matches('.assunto')) abrirMenuAssunto(e.target.dataset.id);
});

/* ---------- Menu do assunto ---------- */

let assuntoDoMenu = null;

function abrirMenuAssunto(id) {
  const a = estado.todos.find(x => x.id === id);
  if (!a) return;
  assuntoDoMenu = a;
  const dono = a.dono_id === estado.usuario.id;
  $('menu-titulo').textContent = a.nome;
  $('menu-fixar').textContent = a.fixada ? '📌 Desafixar' : '📌 Fixar no topo';
  $('menu-arquivar').textContent = a.arquivada ? '📂 Desarquivar' : '🗃️ Arquivar';
  $('menu-editar').hidden = !dono;
  $('menu-compartilhar').textContent = dono ? '👥 Compartilhar' : '👥 Participantes';
  $('menu-excluir').hidden = !dono;
  $('menu-sair').hidden = dono;
  for (const b of [$('menu-excluir'), $('menu-sair')]) {
    delete b.dataset.confirmar; b.classList.remove('confirmando');
  }
  $('menu-excluir').textContent = '🗑️ Excluir assunto';
  $('menu-sair').textContent = '🚪 Sair do assunto';
  $('dlg-menu').showModal();
}

function precisaInternet() {
  if (navigator.onLine) return false;
  toast('Isso precisa de internet.');
  return true;
}

async function atualizarMinhaParticipacao(campos) {
  if (precisaInternet()) { $('dlg-menu').close(); return; }
  const a = assuntoDoMenu;
  $('dlg-menu').close();
  Object.assign(a, campos);
  ordenarEDesenhar();
  desenharArquivados();
  const { error } = await supabase.from('categoria_membros').update(campos)
    .eq('categoria_id', a.id).eq('usuario_id', estado.usuario.id);
  if (error) { toast('Não deu para salvar. ' + mensagemDe(error)); carregarAssuntos(); }
}

$('menu-compartilhar').addEventListener('click', () => {
  $('dlg-menu').close();
  abrirCompartilhar(assuntoDoMenu);
});

$('menu-fixar').addEventListener('click', () => atualizarMinhaParticipacao({ fixada: !assuntoDoMenu.fixada }));

$('menu-arquivar').addEventListener('click', () => {
  const arquivar = !assuntoDoMenu.arquivada;
  if (arquivar && idDaRota() === assuntoDoMenu.id) location.hash = '#/';
  atualizarMinhaParticipacao({ arquivada: arquivar });
  toast(arquivar ? 'Assunto arquivado. Ele fica em ⚙️ → Assuntos arquivados.' : 'Assunto de volta na lista.');
});

$('menu-editar').addEventListener('click', () => {
  $('dlg-menu').close();
  abrirFormAssunto(assuntoDoMenu);
});

$('menu-excluir').addEventListener('click', (e) => {
  confirmarComSegundoToque(e.currentTarget, 'Toque de novo: apaga para todos', async () => {
    const a = assuntoDoMenu;
    $('dlg-menu').close();
    const { error } = await supabase.from('categorias').delete().eq('id', a.id);
    if (error) { toast('Não deu para excluir. ' + mensagemDe(error)); return; }
    try { localStorage.removeItem('notas.rascunho.' + a.id); } catch { /* ok */ }
    if (idDaRota() === a.id) location.hash = '#/';
    toast(`"${a.nome}" foi excluído.`);
    carregarAssuntos();
  });
});

$('menu-sair').addEventListener('click', (e) => {
  confirmarComSegundoToque(e.currentTarget, 'Toque de novo para sair', async () => {
    const a = assuntoDoMenu;
    $('dlg-menu').close();
    const { error } = await supabase.rpc('sair_da_categoria', { p_categoria: a.id });
    if (error) { toast('Não deu para sair. ' + mensagemDe(error)); return; }
    if (idDaRota() === a.id) location.hash = '#/';
    toast(`Você saiu de "${a.nome}".`);
    carregarAssuntos();
  });
});

/* ---------- Criar / editar assunto ---------- */

let assuntoEmEdicao = null;

function abrirFormAssunto(a = null) {
  assuntoEmEdicao = a;
  $('form-assunto').reset();
  $('assunto-titulo').textContent = a ? 'Editar assunto' : 'Novo assunto';
  $('btn-criar-assunto').textContent = a ? 'Salvar' : 'Criar';
  $('assunto-nome').value = a?.nome || '';
  $('assunto-emoji').value = a?.emoji || '';
  $('assunto-tipo').hidden = !!a; // o tipo não muda depois de criado
  $('assunto-erro').hidden = true;
  $('dlg-assunto').showModal();
  setTimeout(() => $('assunto-nome').focus(), 50);
}

$('btn-novo-assunto').addEventListener('click', () => { if (!precisaInternet()) abrirFormAssunto(); });

$('form-assunto').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'criar') return; // Cancelar fecha normalmente
  e.preventDefault();
  const nome = $('assunto-nome').value.trim();
  const emoji = $('assunto-emoji').value.trim() || null;
  const tipo = $('form-assunto').elements.tipo.value === 'nota' ? 'nota' : 'conversa';
  if (!nome) return;
  const btn = $('btn-criar-assunto');
  btn.disabled = true;
  const editando = assuntoEmEdicao;
  const id = editando?.id || crypto.randomUUID();
  const { error } = editando
    ? await supabase.from('categorias').update({ nome, emoji }).eq('id', id)
    : await supabase.from('categorias').insert({ id, nome, emoji, tipo });
  btn.disabled = false;
  if (error) {
    $('assunto-erro').textContent = (editando ? 'Não deu para salvar: ' : 'Não deu para criar: ') + mensagemDe(error);
    $('assunto-erro').hidden = false;
    return;
  }
  if (compartilhadoParaNovo) { preencherAoAbrir(compartilhadoParaNovo); compartilhadoParaNovo = null; }
  $('dlg-assunto').close();
  await carregarAssuntos();
  if (editando) aplicarRota();
  else abrirAssunto(id);
});

/* ---------- Compartilhar assunto ---------- */

let assuntoCompartilhado = null;

async function abrirCompartilhar(a) {
  if (precisaInternet()) return;
  assuntoCompartilhado = a;
  const dono = a.dono_id === estado.usuario.id;
  $('compartilhar-titulo').textContent = (dono ? 'Compartilhar ' : 'Participantes de ') + '“' + a.nome + '”';
  $('compartilhar-adicionar').hidden = !dono;
  $('compartilhar-erro').hidden = true;
  $('dlg-compartilhar').showModal();
  await desenharCompartilhar();
}

async function desenharCompartilhar() {
  const a = assuntoCompartilhado;
  const dono = a.dono_id === estado.usuario.id;
  const [membros, permitidos] = await Promise.all([
    supabase.rpc('membros_da_categoria', { p_categoria: a.id }),
    dono ? supabase.from('usuarios_permitidos').select('email, nome') : Promise.resolve({ data: [] }),
  ]);
  const lista = membros.data || [];
  $('compartilhar-membros').replaceChildren(...lista.map(p => el('li', {},
    el('span', { className: 'avatar' }, (p.nome || p.email).trim().charAt(0)),
    el('span', { className: 'arq-nome' }, (p.usuario_id === estado.usuario.id ? 'Você' : p.nome) + (p.papel === 'dono' ? ' · dono' : '')),
    dono && p.papel !== 'dono'
      ? el('button', { type: 'button', className: 'botao', onclick: (e) => confirmarComSegundoToque(e.currentTarget, 'Remover?', () => alterarMembro('remover', p)) }, 'Remover')
      : null)));
  const emails = new Set(lista.map(p => (p.email || '').toLowerCase()));
  const candidatos = (permitidos.data || []).filter(p => !emails.has(p.email.toLowerCase()));
  $('compartilhar-candidatos').replaceChildren(...candidatos.map(p => el('li', {},
    el('span', { className: 'avatar' }, p.nome.trim().charAt(0)),
    el('span', { className: 'arq-nome' }, p.nome),
    el('button', { type: 'button', className: 'botao primario', onclick: () => alterarMembro('adicionar', p) }, 'Adicionar'))));
  $('compartilhar-ninguem').hidden = candidatos.length > 0;
}

async function alterarMembro(acao, p) {
  const a = assuntoCompartilhado;
  const { error } = acao === 'adicionar'
    ? await supabase.rpc('compartilhar_categoria', { p_categoria: a.id, p_email: p.email })
    : await supabase.rpc('remover_membro', { p_categoria: a.id, p_usuario: p.usuario_id });
  if (error) {
    $('compartilhar-erro').textContent = mensagemDe(error);
    $('compartilhar-erro').hidden = false;
    return;
  }
  $('compartilhar-erro').hidden = true;
  toast(acao === 'adicionar' ? `${p.nome} agora vê “${a.nome}”.` : `${p.nome} saiu de “${a.nome}”.`);
  await desenharCompartilhar();
  carregarAssuntos();
}

/* ---------- Arquivados (na ⚙️) ---------- */

$('btn-arquivados').addEventListener('click', () => {
  desenharArquivados();
  $('dlg-config').close();
  $('dlg-arquivados').showModal();
});

function desenharArquivados() {
  const arq = estado.todos.filter(a => a.arquivada);
  $('arquivados-lista').replaceChildren(...arq.map(a => el('li', {},
    avatarEl(a),
    el('span', { className: 'arq-nome' }, a.nome),
    el('button', { type: 'button', className: 'botao', onclick: () => { assuntoDoMenu = a; atualizarMinhaParticipacao({ arquivada: false }); } }, 'Desarquivar'))));
  $('arquivados-vazio').hidden = arq.length > 0;
}

/* ---------- Rotas: #/  e  #/c/<id> ---------- */

function idDaRota() {
  const m = location.hash.match(/^#\/c\/([0-9a-f-]{36})$/i);
  return m ? m[1] : null;
}

let abriuPelaLista = false;

function abrirAssunto(id) {
  if (idDaRota() === id) return aplicarRota();
  abriuPelaLista = true;
  location.hash = '#/c/' + id; // empilha no histórico: o "voltar" do celular volta para a lista
}

function aplicarRota() {
  if (!estado.usuario) return;
  const id = idDaRota();
  const assunto = id && estado.todos.find(a => a.id === id);

  document.body.classList.toggle('em-conversa', !!assunto);
  $('conversa').hidden = !assunto;
  $('conversa-nenhuma').hidden = !!assunto;

  const nota = ehNota(assunto);
  $('conversa').classList.toggle('modo-nota', nota);
  $('nota-area').hidden = !nota;
  $('btn-buscar-conversa').hidden = nota; // a busca dentro da nota chega na T9.13

  if (assunto) {
    $('conversa-titulo').textContent = assunto.nome + (temOutros(assunto) ? ' 👥' : '');
    $('conversa-avatar').replaceWith(Object.assign(avatarEl(assunto), { id: 'conversa-avatar' }));
    if (nota) {
      fecharConversa();
      abrirNota(assunto);
      marcarLido(assunto.id);
    } else {
      fecharNota();
      assuntoAtualizado(assunto);
      abrirConversa(assunto);
    }
  } else {
    fecharConversa();
    fecharNota();
    if (id) history.replaceState(null, '', location.pathname + location.search + '#/');
  }
  document.querySelectorAll('.assunto').forEach(li => li.classList.toggle('ativo', li.dataset.id === id));
}

window.addEventListener('hashchange', aplicarRota);

$('btn-voltar').addEventListener('click', () => {
  if (abriuPelaLista) { abriuPelaLista = false; history.back(); }
  else location.hash = '#/';
});

$('btn-menu-conversa').addEventListener('click', () => { if (idDaRota()) abrirMenuAssunto(idDaRota()); });

/* ---------- Configurações ---------- */

$('btn-config').addEventListener('click', () => $('dlg-config').showModal());

$('btn-sair').addEventListener('click', (e) => {
  confirmarComSegundoToque(e.currentTarget, 'Toque de novo para sair', async () => {
    $('dlg-config').close();
    await sair();
  });
});

/* ---------- Exportar tudo (backup em JSON) ---------- */

$('btn-exportar').addEventListener('click', async () => {
  if (precisaInternet()) return;
  const b = $('btn-exportar');
  b.disabled = true;
  b.textContent = 'Preparando…';
  try {
    const cats = await supabase.from('categorias').select('id, nome, emoji, cor, dono_id, criado_em');
    if (cats.error) throw cats.error;
    const msgs = [];
    for (let de = 0; ; de += 1000) {
      const { data, error } = await supabase.from('mensagens')
        .select('id, categoria_id, autor_id, texto, link, criado_em, editado_em')
        .is('apagado_em', null).order('criado_em', { ascending: true }).range(de, de + 999);
      if (error) throw error;
      msgs.push(...data);
      if (data.length < 1000) break;
    }
    const nomes = new Map();
    for (const c of cats.data) {
      const { data } = await supabase.rpc('membros_da_categoria', { p_categoria: c.id });
      for (const p of data || []) nomes.set(p.usuario_id, p.nome);
    }
    const backup = {
      app: 'Notas', versao: VERSAO, exportado_em: new Date().toISOString(),
      usuario: { email: estado.usuario.email, nome: estado.usuario.nome },
      assuntos: cats.data.map(c => ({
        ...c,
        dono: nomes.get(c.dono_id) || null,
        mensagens: msgs.filter(m => m.categoria_id === c.id)
          .map(({ categoria_id, ...m }) => ({ ...m, autor: nomes.get(m.autor_id) || null })),
      })),
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `notas-backup-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Backup gerado: ${cats.data.length} assuntos, ${msgs.length} mensagens.`);
  } catch (e) {
    toast('Não deu para exportar. ' + mensagemDe(e));
  } finally {
    b.disabled = false;
    b.textContent = '⬇️ Exportar meus dados (JSON)';
  }
});

$('btn-atualizar').addEventListener('click', async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) return location.reload();
  await reg.update();
  if (reg.waiting || reg.installing) toast('Atualizando…');
  else toast('Você já está na versão mais nova.');
});

// Fecha as folhas tocando fora delas
document.querySelectorAll('dialog.folha').forEach(d => d.addEventListener('click', (e) => {
  if (e.target === d) d.close();
}));

/* ============================================================
   Service worker
   ============================================================ */

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(console.error);
  if (!navigator.serviceWorker.controller) return; // primeira visita: nada para recarregar
  let recarregou = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (recarregou) return;
    recarregou = true;
    location.reload();
  });
}

iniciar();
