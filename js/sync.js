// Fila de envio: tudo que o app grava (nova mensagem, edição, exclusão) passa por aqui.
// Com internet, sai na hora; sem internet, fica guardado e sobe quando a conexão voltar.
import { supabase } from './db.js';
import { enfileirar, filaTodas, filaRemover, filaAtualizar, guardarMensagens } from './store.js';
import { buscarPreview, paraMensagem } from './preview.js';

const ouvintes = new Set();
/** cb({ op, ok, erro }) é chamado a cada operação concluída (ou descartada). */
export function aoProcessar(cb) { ouvintes.add(cb); return () => ouvintes.delete(cb); }

export async function gravar(op) {
  await enfileirar(op);
  processarFila();
}

export async function pendentes() {
  return (await filaTodas()).length;
}

export function erroDeRede(e) {
  if (!navigator.onLine) return true;
  const msg = String(e?.message || e || '');
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|aborted/i.test(msg) || e?.status === 0;
}

// Token vencido / sessão ainda renovando: não é motivo para descartar a operação
function erroDeLogin(e) {
  const msg = String(e?.message || '');
  return e?.code === 'PGRST301' || e?.code === 'PGRST303' || e?.status === 401 || /jwt|token/i.test(msg);
}

let processando = null;

export function processarFila() {
  processando ??= (async () => {
    try {
      for (const op of await filaTodas()) {
        if (!navigator.onLine) break;
        try {
          await executar(op);
          await filaRemover(op.seq);
          avisar({ op, ok: true });
        } catch (e) {
          if (erroDeRede(e) || erroDeLogin(e)) break; // tenta de novo depois (conexão/sessão)
          console.error('fila', op, e);
          await filaRemover(op.seq);         // erro do servidor (permissão etc.): não adianta repetir
          avisar({ op, ok: false, erro: e });
        }
      }
    } finally {
      processando = null;
    }
  })();
  return processando;
}

function avisar(r) { for (const cb of ouvintes) { try { cb(r); } catch (e) { console.error(e); } } }

async function executar(op) {
  if (op.tipo === 'inserir') {
    const m = op.msg;
    // enviada sem internet: tenta o preview agora
    if (op.buscarPreview) {
      try {
        const p = await buscarPreview(op.buscarPreview);
        if (p && (p.titulo || p.imagem)) {
          m.link = paraMensagem({ ...p, url: p.url || op.buscarPreview });
          await guardarMensagens([{ ...m, _pendente: true }]);
        }
      } catch (e) {
        if (erroDeRede(e)) throw e;
      }
      op.buscarPreview = null;
      await filaAtualizar(op);
    }
    const { error } = await supabase.from('mensagens')
      .upsert({ id: m.id, categoria_id: m.categoria_id, texto: m.texto, link: m.link }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
    return;
  }
  if (op.tipo === 'editar') {
    const { error } = await supabase.from('mensagens').update(op.campos).eq('id', op.id);
    if (error) throw error;
    return;
  }
  if (op.tipo === 'apagar') {
    const { error } = await supabase.from('mensagens').update({ apagado_em: op.apagado_em }).in('id', op.ids);
    if (error) throw error;
    return;
  }
  throw new Error('operação desconhecida: ' + op.tipo);
}

// Ao voltar a internet, o main.js renova a sessão e depois chama processarFila().
