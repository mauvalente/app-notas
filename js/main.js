// Notas — inicialização, login, lista de assuntos e rotas.
import { supabase, configOk } from './db.js';
import { sessaoAtual, temAcesso, nomeDe, sair, marcarUso, prepararBotaoGoogle, entrarPorRedirecionamento } from './auth.js';
import { $, el, toast, mensagemDe, tempo, normalizar, quando, confirmarComSegundoToque } from './util.js';
import { textoSimples } from './formatar.js';
import { configurarConversa, abrirConversa, fecharConversa, assuntoAtualizado } from './conversa.js';

export const VERSAO = '0.2.0';

const estado = {
  usuario: null,        // { id, email, nome }
  todos: [],            // todos os assuntos (inclui arquivados)
  assuntos: [],         // visíveis na lista, já ordenados
  ultimas: new Map(),   // categoria_id → { texto, titulo, criado_em }
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
  let permitido = false;
  try { permitido = await temAcesso(); } catch (e) { console.error(e); }
  if (!permitido) {
    const email = sessao.user.email;
    await sair();
    mostrarLogin(`O e-mail ${email} não tem acesso a este app.`);
    return;
  }
  estado.usuario = { id: sessao.user.id, email: sessao.user.email, nome: await nomeDe(sessao.user.email) };
  mostrarApp();
}

supabase?.auth.onAuthStateChange((evento) => {
  if (evento === 'SIGNED_OUT' && estado.usuario) {
    estado.usuario = null;
    fecharConversa();
    mostrarLogin();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !estado.usuario) return;
  marcarUso();
  carregarAssuntos(); // pega o que mudou em outro aparelho
});

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
}

/* ---------- Assuntos ---------- */

let carregando = null;
function carregarAssuntos() {
  carregando ??= (async () => {
    try {
      const [cats, minhas, ultimas] = await Promise.all([
        supabase.from('categorias').select('id, nome, emoji, cor, dono_id, ultima_msg_em, criado_em'),
        supabase.from('categoria_membros').select('categoria_id, papel, fixada, arquivada').eq('usuario_id', estado.usuario.id),
        supabase.rpc('ultimas_mensagens'),
      ]);
      if (cats.error || minhas.error) {
        toast('Não consegui carregar os assuntos. ' + mensagemDe(cats.error || minhas.error));
        return;
      }
      const porId = new Map(minhas.data.map(m => [m.categoria_id, m]));
      estado.todos = cats.data.map(c => ({ ...c, ...(porId.get(c.id) || {}) }));
      if (!ultimas.error) estado.ultimas = new Map((ultimas.data || []).map(u => [u.categoria_id, u]));
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

function desenharLista() {
  const ul = $('lista-assuntos');
  const f = normalizar(estado.filtro);
  const itens = estado.assuntos.filter(a => !f || normalizar(a.nome).includes(f));
  const atual = idDaRota();

  ul.replaceChildren(...itens.map(a => {
    const u = estado.ultimas.get(a.id);
    let previa = 'Sem mensagens';
    if (u) {
      const t = textoSimples(u.texto);
      previa = u.titulo && !t ? '🔗 ' + u.titulo : (u.titulo ? '🔗 ' : '') + t;
    }
    return el('li', { className: 'assunto' + (a.id === atual ? ' ativo' : ''), dataset: { id: a.id }, tabindex: '0' },
      el('span', { className: 'avatar' }, avatarDe(a)),
      el('div', { className: 'assunto-corpo' },
        el('div', { className: 'assunto-topo' },
          el('span', { className: 'assunto-nome' }, (a.fixada ? '📌 ' : '') + a.nome + (a.papel === 'editor' ? ' 👥' : '')),
          el('span', { className: 'assunto-hora' }, quando(u?.criado_em || a.ultima_msg_em))),
        el('div', { className: 'assunto-previa' }, previa)));
  }));

  $('lista-vazia').hidden = estado.assuntos.length > 0;
  const arq = estado.todos.filter(a => a.arquivada).length;
  $('btn-arquivados').hidden = arq === 0;
  $('btn-arquivados').textContent = `Assuntos arquivados (${arq})`;
}

$('busca-assuntos').addEventListener('input', (e) => {
  estado.filtro = e.target.value;
  desenharLista();
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
  $('menu-excluir').hidden = !dono;
  $('menu-sair').hidden = dono;
  for (const b of [$('menu-excluir'), $('menu-sair')]) {
    delete b.dataset.confirmar; b.classList.remove('confirmando');
  }
  $('menu-excluir').textContent = '🗑️ Excluir assunto';
  $('menu-sair').textContent = '🚪 Sair do assunto';
  $('dlg-menu').showModal();
}

async function atualizarMinhaParticipacao(campos) {
  const a = assuntoDoMenu;
  $('dlg-menu').close();
  Object.assign(a, campos);
  ordenarEDesenhar();
  desenharArquivados();
  const { error } = await supabase.from('categoria_membros').update(campos)
    .eq('categoria_id', a.id).eq('usuario_id', estado.usuario.id);
  if (error) { toast('Não deu para salvar. ' + mensagemDe(error)); carregarAssuntos(); }
}

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
  $('assunto-erro').hidden = true;
  $('dlg-assunto').showModal();
  setTimeout(() => $('assunto-nome').focus(), 50);
}

$('btn-novo-assunto').addEventListener('click', () => abrirFormAssunto());

$('form-assunto').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'criar') return; // Cancelar fecha normalmente
  e.preventDefault();
  const nome = $('assunto-nome').value.trim();
  const emoji = $('assunto-emoji').value.trim() || null;
  if (!nome) return;
  const btn = $('btn-criar-assunto');
  btn.disabled = true;
  const editando = assuntoEmEdicao;
  const id = editando?.id || crypto.randomUUID();
  const { error } = editando
    ? await supabase.from('categorias').update({ nome, emoji }).eq('id', id)
    : await supabase.from('categorias').insert({ id, nome, emoji });
  btn.disabled = false;
  if (error) {
    $('assunto-erro').textContent = (editando ? 'Não deu para salvar: ' : 'Não deu para criar: ') + mensagemDe(error);
    $('assunto-erro').hidden = false;
    return;
  }
  $('dlg-assunto').close();
  await carregarAssuntos();
  if (editando) aplicarRota();
  else abrirAssunto(id);
});

/* ---------- Arquivados (na ⚙️) ---------- */

$('btn-arquivados').addEventListener('click', () => {
  desenharArquivados();
  $('dlg-config').close();
  $('dlg-arquivados').showModal();
});

function desenharArquivados() {
  const arq = estado.todos.filter(a => a.arquivada);
  $('arquivados-lista').replaceChildren(...arq.map(a => el('li', {},
    el('span', { className: 'avatar' }, avatarDe(a)),
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

  if (assunto) {
    $('conversa-titulo').textContent = assunto.nome + (assunto.papel === 'editor' ? ' 👥' : '');
    $('conversa-avatar').textContent = avatarDe(assunto);
    assuntoAtualizado(assunto);
    abrirConversa(assunto);
  } else {
    fecharConversa();
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
