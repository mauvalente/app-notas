// Cache local (IndexedDB): assuntos, mensagens e a fila de envio offline.
// Um banco por usuário ("notas-<id>"). Nada aqui lança erro: se o IndexedDB
// não estiver disponível (aba anônima, por exemplo), as funções devolvem vazio.

let banco = null;      // Promise<IDBDatabase|null>
let nomeBanco = null;

export function abrirBanco(usuarioId) {
  if (nomeBanco === 'notas-' + usuarioId && banco) return banco;
  nomeBanco = 'notas-' + usuarioId;
  banco = new Promise((ok, falha) => {
    const r = indexedDB.open(nomeBanco, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('kv');
      const m = db.createObjectStore('mensagens', { keyPath: 'id' });
      m.createIndex('categoria', 'categoria_id');
      db.createObjectStore('fila', { keyPath: 'seq', autoIncrement: true });
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => falha(r.error);
  }).catch((e) => { console.warn('IndexedDB indisponível', e); return null; });
  return banco;
}

export async function apagarBanco() {
  const db = await banco;
  db?.close();
  if (nomeBanco) indexedDB.deleteDatabase(nomeBanco);
  banco = null; nomeBanco = null;
}

/** Roda fn(stores) numa transação e devolve o que fn devolver (requests viram .result). */
async function transacao(nomes, modo, fn) {
  const db = await banco;
  if (!db) return null;
  try {
    return await new Promise((ok, falha) => {
      const t = db.transaction(nomes, modo);
      const stores = Object.fromEntries([].concat(nomes).map(n => [n, t.objectStore(n)]));
      const r = fn(stores);
      t.oncomplete = () => ok(r instanceof IDBRequest ? r.result : r);
      t.onerror = () => falha(t.error);
      t.onabort = () => falha(t.error);
    });
  } catch (e) {
    console.warn('IndexedDB', e);
    return null;
  }
}

/* ---------- Chave/valor (assuntos, nomes, etc.) ---------- */

export const kvLer = (chave) => transacao('kv', 'readonly', s => s.kv.get(chave));
export const kvGravar = (chave, valor) => transacao('kv', 'readwrite', s => { s.kv.put(valor, chave); });

/* ---------- Mensagens ---------- */

export async function mensagensDoAssunto(categoriaId) {
  const lista = await transacao('mensagens', 'readonly', s => s.mensagens.index('categoria').getAll(categoriaId));
  return (lista || []).sort((a, b) => a.criado_em.localeCompare(b.criado_em));
}

/**
 * Guarda a página mais nova vinda do servidor: o que estava no cache dentro do
 * mesmo período e não veio (apagado ou movido) sai; o mais antigo fica; pendentes ficam.
 */
export async function guardarPaginaNova(categoriaId, doServidor, completa) {
  const maisAntiga = doServidor[0]?.criado_em;
  return transacao('mensagens', 'readwrite', (s) => {
    const req = s.mensagens.index('categoria').getAll(categoriaId);
    req.onsuccess = () => {
      const ids = new Set(doServidor.map(m => m.id));
      for (const m of req.result) {
        if (m._pendente || ids.has(m.id)) continue;
        if (completa || !maisAntiga || m.criado_em >= maisAntiga) s.mensagens.delete(m.id);
      }
      for (const m of doServidor) s.mensagens.put(limpar(m));
    };
  });
}

export const guardarMensagens = (lista) =>
  transacao('mensagens', 'readwrite', s => { for (const m of lista) s.mensagens.put(limpar(m, true)); });

export const removerMensagens = (ids) =>
  transacao('mensagens', 'readwrite', s => { for (const id of ids) s.mensagens.delete(id); });

/** Só os campos que importam (mantém _pendente quando pedido). */
function limpar(m, manterPendente = false) {
  const { id, categoria_id, autor_id, texto, link, criado_em, editado_em } = m;
  const out = { id, categoria_id, autor_id, texto, link: link || null, criado_em, editado_em: editado_em || null };
  if (manterPendente && m._pendente) out._pendente = true;
  return out;
}

/* ---------- Fila de envio ---------- */

export const enfileirar = (op) => transacao('fila', 'readwrite', s => s.fila.add({ ...op, criado: Date.now() }));
export const filaTodas = async () => (await transacao('fila', 'readonly', s => s.fila.getAll())) || [];
export const filaRemover = (seq) => transacao('fila', 'readwrite', s => { s.fila.delete(seq); });
export const filaAtualizar = (op) => transacao('fila', 'readwrite', s => { s.fila.put(op); });
