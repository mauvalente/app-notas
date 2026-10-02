// Notas — junta duas versões de uma nota linha a linha (merge de 3 vias, SPEC 12.6).
// base  = o texto que os dois tinham em comum (a última versão confirmada pelo servidor)
// minha = o que eu editei a partir da base
// deles = o que está no servidor agora (a outra pessoa salvou antes)
// Como cada item da lista é uma linha, os casos comuns se resolvem sozinhos:
// cada um acrescenta itens diferentes, um marca e o outro acrescenta, os dois marcam o mesmo item.
// Se os dois mudaram a MESMA linha de jeitos diferentes, ficam as duas versões
// (a do servidor e depois a minha) e `conflito` volta true.

const LIMITE = 4_000_000; // células da tabela de LCS; acima disso, usa o plano simples

/** Pares [i, j] de linhas iguais (subsequência comum mais longa), com sentinelas nas pontas. */
function alinhar(a, b) {
  const n = a.length, m = b.length;
  // corta começo e fim iguais (o normal numa nota: só um pedaço muda)
  let ini = 0;
  while (ini < n && ini < m && a[ini] === b[ini]) ini++;
  let fimA = n, fimB = m;
  while (fimA > ini && fimB > ini && a[fimA - 1] === b[fimB - 1]) { fimA--; fimB--; }

  const pares = [[-1, -1]];
  for (let k = 0; k < ini; k++) pares.push([k, k]);

  const A = a.slice(ini, fimA), B = b.slice(ini, fimB);
  if (A.length && B.length) {
    if (A.length * B.length > LIMITE) return null;
    const w = B.length + 1;
    const t = new Uint32Array((A.length + 1) * w);
    for (let i = A.length - 1; i >= 0; i--)
      for (let j = B.length - 1; j >= 0; j--)
        t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { pares.push([ini + i, ini + j]); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < n - fimA; k++) pares.push([fimA + k, fimB + k]);
  pares.push([n, m]);
  return pares;
}

/** Trechos da base que mudaram: { ini, fim (exclusivo), linhas novas }. */
function trechos(base, outro) {
  const pares = alinhar(base, outro);
  if (!pares) return null;
  const r = [];
  for (let k = 1; k < pares.length; k++) {
    const [i0, j0] = pares[k - 1], [i1, j1] = pares[k];
    if (i1 - i0 > 1 || j1 - j0 > 1) r.push({ ini: i0 + 1, fim: i1, linhas: outro.slice(j0 + 1, j1) });
  }
  return r;
}

/** Aplica, no intervalo [ini, fim) da base, só os trechos de um lado. */
function versaoDoTrecho(base, ini, fim, lista) {
  const out = [];
  let i = ini;
  for (const t of lista) {
    out.push(...base.slice(i, t.ini), ...t.linhas);
    i = t.fim;
  }
  out.push(...base.slice(i, fim));
  return out;
}

const iguais = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);

export function mesclar(baseTxt, minhaTxt, delesTxt) {
  if (minhaTxt === delesTxt) return { texto: minhaTxt, conflito: false };
  if (minhaTxt === baseTxt) return { texto: delesTxt, conflito: false };
  if (delesTxt === baseTxt) return { texto: minhaTxt, conflito: false };

  if (!baseTxt.trim()) {
    // nota estava vazia e os dois começaram a escrever: entram os dois textos
    const tem = new Set(delesTxt.split('\n'));
    const extras = minhaTxt.split('\n').filter(l => !tem.has(l));
    return { texto: [delesTxt, ...extras].join('\n'), conflito: false };
  }

  const base = baseTxt.split('\n'), minha = minhaTxt.split('\n'), deles = delesTxt.split('\n');
  const tm = trechos(base, minha), td = trechos(base, deles);
  if (!tm || !td) {
    // nota enorme: fica a do servidor + as minhas linhas que ela não tem
    const tem = new Set(deles);
    const extras = minha.filter(l => l.trim() && !tem.has(l));
    return { texto: [...deles, ...extras].join('\n'), conflito: extras.length > 0 };
  }

  // junta os trechos dos dois lados em grupos que se encostam na base
  const todos = [...tm.map(t => ({ ...t, lado: 'm' })), ...td.map(t => ({ ...t, lado: 'd' }))]
    .sort((x, y) => x.ini - y.ini || x.fim - y.fim);
  const grupos = [];
  for (const t of todos) {
    const g = grupos.at(-1);
    // sobrepõe: mexem nas mesmas linhas da base, ou os dois só inserem no mesmo ponto
    const sobrepoe = g && (t.ini < g.fim || (t.ini === t.fim && g.ini === g.fim && t.ini === g.ini));
    if (sobrepoe) { g.itens.push(t); g.fim = Math.max(g.fim, t.fim); }
    else grupos.push({ ini: t.ini, fim: t.fim, itens: [t] });
  }

  const out = [];
  let conflito = false, i = 0;
  for (const g of grupos) {
    out.push(...base.slice(i, g.ini));
    const m = g.itens.filter(t => t.lado === 'm'), d = g.itens.filter(t => t.lado === 'd');
    const vm = versaoDoTrecho(base, g.ini, g.fim, m), vd = versaoDoTrecho(base, g.ini, g.fim, d);
    if (!m.length) out.push(...vd);
    else if (!d.length) out.push(...vm);
    else if (iguais(vm, vd)) out.push(...vm);
    else if (g.ini === g.fim) {
      // os dois só acrescentaram linhas no mesmo lugar: entram as dos dois, sem repetir
      const ja = new Set(vd);
      out.push(...vd, ...vm.filter(l => !ja.has(l)));
    } else {
      conflito = true;
      const ja = new Set(vd);
      out.push(...vd, ...vm.filter(l => !ja.has(l)));
    }
    i = g.fim;
  }
  out.push(...base.slice(i));
  return { texto: out.join('\n'), conflito };
}
