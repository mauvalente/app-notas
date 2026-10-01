// Utilitários compartilhados.

export const $ = (id) => document.getElementById(id);

/** Cria um elemento: el('div', { className: 'x', onclick }, filho1, 'texto', ...) */
export function el(tag, props = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'className' || k === 'textContent') n[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const f of filhos.flat()) if (f != null && f !== false) n.append(f);
  return n;
}

let toastTimer;
export function toast(texto, ms = 3500) {
  const t = $('toast');
  t.textContent = texto;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function mensagemDe(e) {
  return (e && (e.message || e.error_description || e.msg)) || String(e || '');
}

export function tempo(iso) { return iso ? Date.parse(iso) : 0; }

export function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export function hora(iso) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function mesmoDia(a, b) { return a.toDateString() === b.toDateString(); }

/** "14:32", "Ontem" ou "12/09/2026" — para a lista de assuntos. */
export function quando(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  if (mesmoDia(d, hoje)) return hora(iso);
  if (mesmoDia(d, ontem)) return 'Ontem';
  return d.toLocaleDateString('pt-BR');
}

/** "Hoje", "Ontem", "segunda-feira" (última semana) ou "12/09/2026" — separadores da conversa. */
export function rotuloDia(iso) {
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  if (mesmoDia(d, hoje)) return 'Hoje';
  if (mesmoDia(d, ontem)) return 'Ontem';
  if (hoje - d < 6 * 864e5) return d.toLocaleDateString('pt-BR', { weekday: 'long' });
  return d.toLocaleDateString('pt-BR');
}

/** true em aparelhos com mouse (computador): Enter envia. */
export const temMouse = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

/** Lê/grava no localStorage sem quebrar quando ele não existe. */
export const guardado = {
  ler(chave, padrao = null) {
    try { const v = localStorage.getItem(chave); return v == null ? padrao : JSON.parse(v); } catch { return padrao; }
  },
  gravar(chave, valor) {
    try {
      if (valor == null || valor === '') localStorage.removeItem(chave);
      else localStorage.setItem(chave, JSON.stringify(valor));
    } catch { /* sem storage */ }
  },
};

/** Botão que pede um segundo toque para confirmar (padrão do APP de Contas). */
export function confirmarComSegundoToque(botao, textoConfirmar, acao, ms = 4000) {
  if (botao.dataset.confirmar) {
    clearTimeout(Number(botao.dataset.timer));
    delete botao.dataset.confirmar;
    botao.classList.remove('confirmando');
    botao.innerHTML = botao.dataset.htmlOriginal; // marcação fixa do próprio app (ícone/texto do botão)
    return acao();
  }
  botao.dataset.htmlOriginal = botao.innerHTML;
  botao.dataset.confirmar = '1';
  botao.classList.add('confirmando');
  botao.textContent = textoConfirmar;
  botao.dataset.timer = String(setTimeout(() => {
    delete botao.dataset.confirmar;
    botao.classList.remove('confirmando');
    botao.innerHTML = botao.dataset.htmlOriginal;
  }, ms));
}
