// Notas — inicialização, telas e rotas.
import { supabase, configOk } from './db.js';
import { sessaoAtual, temAcesso, nomeDe, sair, marcarUso, prepararBotaoGoogle, entrarPorRedirecionamento } from './auth.js';

export const VERSAO = '0.1.0';

const $ = (id) => document.getElementById(id);
const estado = {
  usuario: null,        // { id, email, nome }
  assuntos: [],         // categorias + dados da minha participação
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
    mostrarLogin();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && estado.usuario) marcarUso();
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

async function carregarAssuntos() {
  const [cats, minhas] = await Promise.all([
    supabase.from('categorias').select('id, nome, emoji, cor, dono_id, ultima_msg_em, criado_em'),
    supabase.from('categoria_membros').select('categoria_id, papel, fixada, arquivada').eq('usuario_id', estado.usuario.id),
  ]);
  if (cats.error || minhas.error) {
    toast('Não consegui carregar os assuntos. ' + mensagemDe(cats.error || minhas.error));
    return;
  }
  const porId = new Map(minhas.data.map(m => [m.categoria_id, m]));
  estado.assuntos = cats.data
    .map(c => ({ ...c, ...(porId.get(c.id) || {}) }))
    .filter(c => !c.arquivada)
    .sort((a, b) =>
      (b.fixada === true) - (a.fixada === true) ||
      tempo(b.ultima_msg_em || b.criado_em) - tempo(a.ultima_msg_em || a.criado_em));
  desenharLista();
}

function desenharLista() {
  const ul = $('lista-assuntos');
  const f = normalizar(estado.filtro);
  const itens = estado.assuntos.filter(a => !f || normalizar(a.nome).includes(f));
  const atual = idDaRota();

  ul.replaceChildren(...itens.map(a => {
    const li = document.createElement('li');
    li.className = 'assunto' + (a.id === atual ? ' ativo' : '');
    li.dataset.id = a.id;
    li.tabIndex = 0;

    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = a.emoji || a.nome.trim().charAt(0);

    const corpo = document.createElement('div');
    corpo.className = 'assunto-corpo';
    const topo = document.createElement('div');
    topo.className = 'assunto-topo';
    const nome = document.createElement('span');
    nome.className = 'assunto-nome';
    nome.textContent = (a.fixada ? '📌 ' : '') + a.nome + (a.papel === 'editor' ? ' 👥' : '');
    const hora = document.createElement('span');
    hora.className = 'assunto-hora';
    hora.textContent = quando(a.ultima_msg_em);
    topo.append(nome, hora);
    const previa = document.createElement('div');
    previa.className = 'assunto-previa';
    previa.textContent = a.ultima_msg_em ? '' : 'Sem mensagens';
    corpo.append(topo, previa);

    li.append(av, corpo);
    return li;
  }));

  $('lista-vazia').hidden = estado.assuntos.length > 0;
}

$('lista-assuntos').addEventListener('click', (e) => {
  const li = e.target.closest('.assunto');
  if (li) abrirAssunto(li.dataset.id);
});
$('lista-assuntos').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.assunto')) abrirAssunto(e.target.dataset.id);
});
$('busca-assuntos').addEventListener('input', (e) => {
  estado.filtro = e.target.value;
  desenharLista();
});

/* ---------- Novo assunto ---------- */

$('btn-novo-assunto').addEventListener('click', () => {
  $('form-assunto').reset();
  $('assunto-erro').hidden = true;
  $('dlg-assunto').showModal();
  setTimeout(() => $('assunto-nome').focus(), 50);
});

$('form-assunto').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'criar') return; // Cancelar fecha normalmente
  e.preventDefault();
  const nome = $('assunto-nome').value.trim();
  const emoji = $('assunto-emoji').value.trim() || null;
  if (!nome) return;
  const btn = $('btn-criar-assunto');
  btn.disabled = true;
  const id = crypto.randomUUID();
  const { error } = await supabase.from('categorias').insert({ id, nome, emoji });
  btn.disabled = false;
  if (error) {
    $('assunto-erro').textContent = 'Não deu para criar: ' + mensagemDe(error);
    $('assunto-erro').hidden = false;
    return;
  }
  $('dlg-assunto').close();
  await carregarAssuntos();
  abrirAssunto(id);
});

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
  const assunto = id && estado.assuntos.find(a => a.id === id);

  document.body.classList.toggle('em-conversa', !!assunto);
  $('conversa').hidden = !assunto;
  $('conversa-nenhuma').hidden = !!assunto;

  if (assunto) {
    $('conversa-titulo').textContent = assunto.nome;
    $('conversa-avatar').textContent = assunto.emoji || assunto.nome.trim().charAt(0);
  } else if (id) {
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
  document.querySelectorAll('.assunto').forEach(li => li.classList.toggle('ativo', li.dataset.id === id));
}

window.addEventListener('hashchange', aplicarRota);

$('btn-voltar').addEventListener('click', () => {
  if (abriuPelaLista) { abriuPelaLista = false; history.back(); }
  else location.hash = '#/';
});

/* ---------- Configurações ---------- */

$('btn-config').addEventListener('click', () => $('dlg-config').showModal());

$('btn-sair').addEventListener('click', async () => {
  const b = $('btn-sair');
  if (!b.dataset.confirmar) {               // mesmo padrão do APP de Contas: segundo toque confirma
    b.dataset.confirmar = '1';
    b.textContent = 'Toque de novo para sair';
    setTimeout(() => { delete b.dataset.confirmar; b.textContent = 'Sair desta conta'; }, 4000);
    return;
  }
  $('dlg-config').close();
  await sair();
});

$('btn-atualizar').addEventListener('click', async () => {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) return location.reload();
  await reg.update();
  if (reg.waiting || reg.installing) toast('Atualizando…');
  else toast('Você já está na versão mais nova.');
});

/* ============================================================
   Utilitários
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

let toastTimer;
export function toast(texto) {
  const t = $('toast');
  t.textContent = texto;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function mensagemDe(e) {
  return (e && (e.message || e.error_description || e.msg)) || String(e || '');
}

function tempo(iso) { return iso ? Date.parse(iso) : 0; }

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function quando(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === hoje.toDateString()) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === ontem.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR');
}

iniciar();
