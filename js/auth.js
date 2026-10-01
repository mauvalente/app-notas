// Login: Google Identity Services → Supabase (signInWithIdToken),
// com o plano B por redirecionamento e a regra dos 180 dias sem uso.
import { CONFIG } from '../config.js';
import { supabase } from './db.js';

const CHAVE_USO = 'notas.ultimoUso';
const DIA = 864e5;

/* ---------- Regra dos 180 dias ---------- */

export function marcarUso() {
  try { localStorage.setItem(CHAVE_USO, String(Date.now())); } catch { /* sem storage */ }
}

function expirouPorDesuso() {
  try {
    const ultimo = Number(localStorage.getItem(CHAVE_USO));
    return ultimo > 0 && Date.now() - ultimo > CONFIG.SESSAO_DIAS * DIA;
  } catch { return false; }
}

/* ---------- Sessão ---------- */

/** Sessão salva no aparelho, ou null. Aplica a regra dos 180 dias. */
export async function sessaoAtual() {
  const { data: { session } } = await supabase.auth.getSession();
  limparUrlDeRetorno();
  if (!session) return null;
  if (expirouPorDesuso()) { await sair(); return null; }
  marcarUso();
  return session;
}

/** O e-mail logado está em usuarios_permitidos? */
export async function temAcesso() {
  const { data, error } = await supabase.rpc('eh_permitido');
  if (error) throw error;
  return data === true;
}

/** Nome cadastrado em usuarios_permitidos (ou o próprio e-mail). */
export async function nomeDe(email) {
  const { data } = await supabase.from('usuarios_permitidos').select('nome').eq('email', email.toLowerCase()).maybeSingle();
  return data?.nome || email;
}

export async function sair() {
  try { window.google?.accounts.id.disableAutoSelect(); } catch { /* ok */ }
  try { localStorage.removeItem(CHAVE_USO); } catch { /* ok */ }
  await supabase.auth.signOut({ scope: 'local' }); // só este aparelho
}

/* ---------- Botão do Google ---------- */

function carregarScript(src) {
  return new Promise((ok, falha) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = ok;
    s.onerror = () => falha(new Error('Não consegui carregar o login do Google. Confira a internet.'));
    document.head.appendChild(s);
  });
}

// O Google recebe o hash do nonce; o Supabase recebe o valor original e confere.
async function gerarNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const bruto = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bruto));
  const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { bruto, hex };
}

/**
 * Desenha o botão "Fazer login com o Google" dentro de `el`.
 * Cada tentativa usa um nonce novo, então em caso de erro basta chamar de novo.
 */
export async function prepararBotaoGoogle(el, { aoEntrar, aoErrar }) {
  await carregarScript('https://accounts.google.com/gsi/client');
  const nonce = await gerarNonce();
  google.accounts.id.initialize({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    nonce: nonce.hex,
    auto_select: false,
    itp_support: true,
    callback: async ({ credential }) => {
      try {
        const { data, error } = await supabase.auth.signInWithIdToken({
          provider: 'google', token: credential, nonce: nonce.bruto,
        });
        if (error) throw error;
        marcarUso();
        aoEntrar(data.session);
      } catch (e) {
        aoErrar(e);
      }
    },
  });
  el.replaceChildren();
  google.accounts.id.renderButton(el, {
    theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with',
    locale: 'pt-BR', width: Math.min(300, el.clientWidth || 300),
  });
}

/** Plano B (iPhone): login por redirecionamento, sai do app e volta logado. */
export async function entrarPorRedirecionamento() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;
}

// Depois do plano B a URL volta com ?code=...; o supabase-js já trocou o código pela sessão.
function limparUrlDeRetorno() {
  const u = new URL(location.href);
  if (u.searchParams.has('code') || u.searchParams.has('error')) {
    u.searchParams.delete('code'); u.searchParams.delete('error'); u.searchParams.delete('error_description');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
}
