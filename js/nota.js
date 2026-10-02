// Notas — tela do assunto do tipo Nota (SPEC 12).
// T9.4: só a rota e a leitura do conteúdo. O editor (Tiptap) entra na T9.5,
// o salvamento na T9.8 e o tempo real na T9.10.
import { supabase } from './db.js';
import { $, el, mensagemDe } from './util.js';
import { erroDeRede } from './sync.js';

const area = $('nota-area');
let atual = null; // assunto aberto

export async function abrirNota(assunto) {
  if (atual?.id === assunto.id) return;
  atual = assunto;
  area.replaceChildren(el('div', { className: 'aviso-centro discreto' }, 'Carregando…'));

  const { data, error } = await supabase.from('notas')
    .select('conteudo, versao, atualizado_em')
    .eq('categoria_id', assunto.id)
    .maybeSingle();
  if (atual?.id !== assunto.id) return; // trocou de assunto enquanto carregava

  if (error) {
    const msg = erroDeRede(error) ? 'Sem internet: a nota aparece aqui quando a conexão voltar.' : 'Não consegui abrir a nota. ' + mensagemDe(error);
    area.replaceChildren(el('div', { className: 'aviso-centro erro' }, msg));
    return;
  }

  const conteudo = data?.conteudo || '';
  area.replaceChildren(
    el('div', { className: 'nota-folha' },
      conteudo
        ? el('div', { className: 'nota-texto' }, conteudo)
        : el('p', { className: 'nota-vazia' }, 'Nota vazia.'),
      el('p', { className: 'dica' }, 'O editor da nota está chegando na próxima versão do app.')));
}

export function fecharNota() {
  if (!atual) return;
  atual = null;
  area.replaceChildren();
}
