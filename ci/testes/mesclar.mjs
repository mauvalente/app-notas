// Teste da junção de mudanças nas notas (js/mesclar.js). Rodar na raiz do repositório: node ci/testes/mesclar.mjs
import { mesclar } from '../../js/mesclar.js';
let f = 0;
const c = (nome, base, minha, deles, esperado, conflito = false) => {
  const r = mesclar(base, minha, deles);
  const ok = r.texto === esperado && r.conflito === conflito;
  if (!ok) f++;
  console.log((ok ? 'ok: ' : 'FALHOU: ') + nome + (ok ? '' : `\n  saiu: ${JSON.stringify(r)}\n  esp:  ${JSON.stringify(esperado)} conflito=${conflito}`));
};
const L = (...x) => x.join('\n');
const base = L('- [ ] leite', '- [ ] pão', '- [ ] café');
c('ninguém mudou', base, base, base, base);
c('só eu mudei', base, L('- [x] leite', '- [ ] pão', '- [ ] café'), base, L('- [x] leite', '- [ ] pão', '- [ ] café'));
c('só a outra pessoa mudou', base, base, L('- [ ] leite', '- [x] pão', '- [ ] café'), L('- [ ] leite', '- [x] pão', '- [ ] café'));
c('eu marco leite, ela marca café', base, L('- [x] leite', '- [ ] pão', '- [ ] café'), L('- [ ] leite', '- [ ] pão', '- [x] café'), L('- [x] leite', '- [ ] pão', '- [x] café'));
c('os dois marcam o mesmo item', base, L('- [ ] leite', '- [x] pão', '- [ ] café'), L('- [ ] leite', '- [x] pão', '- [ ] café'), L('- [ ] leite', '- [x] pão', '- [ ] café'));
c('os dois acrescentam no fim', base, L(base, '- [ ] arroz'), L(base, '- [ ] feijão'), L(base, '- [ ] feijão', '- [ ] arroz'));
c('os dois acrescentam o mesmo item no fim', base, L(base, '- [ ] arroz'), L(base, '- [ ] arroz'), L(base, '- [ ] arroz'));
c('eu marco pão, ela acrescenta no fim', base, L('- [ ] leite', '- [x] pão', '- [ ] café'), L(base, '- [ ] ovos'), L('- [ ] leite', '- [x] pão', '- [ ] café', '- [ ] ovos'));
c('eu apago leite, ela marca café', base, L('- [ ] pão', '- [ ] café'), L('- [ ] leite', '- [ ] pão', '- [x] café'), L('- [ ] pão', '- [x] café'));
c('ela insere depois de leite, eu marco pão (linhas vizinhas)', base, L('- [ ] leite', '- [x] pão', '- [ ] café'), L('- [ ] leite', '- [ ] queijo', '- [ ] pão', '- [ ] café'), L('- [ ] leite', '- [ ] queijo', '- [x] pão', '- [ ] café'));
c('mesma linha mudada diferente: ficam as duas', base, L('- [ ] leite integral', '- [ ] pão', '- [ ] café'), L('- [x] leite', '- [ ] pão', '- [ ] café'), L('- [x] leite', '- [ ] leite integral', '- [ ] pão', '- [ ] café'), true);
c('nota vazia: os dois começam a escrever', '', 'arroz', 'feijão', L('feijão', 'arroz'));
c('eu apago tudo marcado, ela acrescenta', L('- [x] a', '- [ ] b', '- [x] c'), '- [ ] b', L('- [x] a', '- [ ] b', '- [x] c', '- [ ] d'), L('- [ ] b', '- [ ] d'));
console.log(f ? f + ' FALHA(S)' : 'TUDO OK');
