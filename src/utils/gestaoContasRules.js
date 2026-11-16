// Regras puras (sem banco) da Gestão de Contas — cobertas por test/gestao-contas-rules.test.js.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Hoje no horário de Brasília, como "YYYY-MM-DD". */
export function hojeBrasil(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

export function isDia(value) {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Soma (ou subtrai) dias de uma data "YYYY-MM-DD". */
export function somarDias(dia, dias) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/**
 * Soma meses mantendo o dia do vencimento; se o mês não tem esse dia (31 em fevereiro),
 * cai no último dia do mês — nunca "pula" pro mês seguinte.
 */
export function somarMeses(dia, meses) {
  const [ano, mes, d] = dia.split("-").map(Number);
  const alvo = new Date(Date.UTC(ano, mes - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return alvo.toISOString().slice(0, 10);
}

/** Arredonda pra centavos sem o erro clássico de float (1.005 -> 1.01). */
export function arredondar(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

/**
 * Divide um valor em parcelas exatas em centavos — a diferença de arredondamento vai na
 * última. Sem intervaloDias, vencem mês a mês; com ele, a cada N dias.
 */
export function dividirParcelas(valor, quantidade, primeiroVencimento, intervaloDias) {
  const total = Math.max(1, Math.floor(quantidade));
  const centavos = Math.round(Number(valor) * 100);
  const base = Math.floor(centavos / total);
  return Array.from({ length: total }, (_, i) => ({
    numero: i + 1,
    valor: (i === total - 1 ? centavos - base * (total - 1) : base) / 100,
    vencimento: intervaloDias > 0 ? somarDias(primeiroVencimento, i * intervaloDias) : somarMeses(primeiroVencimento, i),
  }));
}

/** Situação mostrada na tela: PENDENTE vira VENCIDA quando o vencimento já passou. */
export function situacaoConta(conta, hoje = hojeBrasil()) {
  if (conta.status === "PENDENTE" && conta.vencimento < hoje) return "VENCIDA";
  return conta.status;
}

/** Valor efetivamente pago/recebido (pode diferir do valor da conta: juros, desconto...). */
export function valorEfetivo(conta) {
  return conta.valorQuitado ?? conta.valor;
}

/**
 * Totais do topo de Contas a pagar/receber: em aberto (pendentes + vencidas), vencido (à
 * parte, dentro do em aberto) e quitado. Canceladas não entram.
 */
export function resumirContas(contas, hoje = hojeBrasil()) {
  const acc = { aberto: { total: 0, count: 0 }, vencido: { total: 0, count: 0 }, quitado: { total: 0, count: 0 } };
  for (const conta of contas) {
    if (conta.status === "PENDENTE") {
      acc.aberto.total += conta.valor;
      acc.aberto.count += 1;
      if (conta.vencimento < hoje) {
        acc.vencido.total += conta.valor;
        acc.vencido.count += 1;
      }
    } else if (conta.status === "QUITADA") {
      acc.quitado.total += valorEfetivo(conta);
      acc.quitado.count += 1;
    }
  }
  for (const key of Object.keys(acc)) acc[key].total = arredondar(acc[key].total);
  return acc;
}

/** Soma por chave, do maior para o menor. */
export function agruparSoma(linhas, chave, valor) {
  const mapa = new Map();
  for (const linha of linhas) {
    const k = chave(linha) || "Sem classificação";
    mapa.set(k, (mapa.get(k) ?? 0) + valor(linha));
  }
  return [...mapa.entries()].map(([nome, total]) => ({ nome, total: arredondar(total) })).sort((a, b) => b.total - a.total);
}

/** Lista de meses "YYYY-MM" entre duas datas (inclusive). */
export function mesesEntre(de, ate) {
  const meses = [];
  let [ano, mes] = de.slice(0, 7).split("-").map(Number);
  const [anoFim, mesFim] = ate.slice(0, 7).split("-").map(Number);
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    meses.push(`${ano}-${String(mes).padStart(2, "0")}`);
    mes += 1;
    if (mes > 12) {
      mes = 1;
      ano += 1;
    }
    if (meses.length > 60) break;
  }
  return meses;
}

/**
 * Movimentos realizados (contas quitadas + lançamentos manuais) num formato só:
 * { data, entrada, valor, categoria, centroCusto, contaBancariaId, origem, registro }.
 */
export function movimentosRealizados(contasQuitadas, lancamentos) {
  return [
    ...contasQuitadas.map((c) => ({
      data: c.dataQuitacao,
      entrada: c.tipo === "RECEBER",
      valor: valorEfetivo(c),
      categoria: c.categoria,
      centroCusto: c.centroCusto,
      contaBancariaId: c.contaBancariaId,
      origem: c.tipo === "RECEBER" ? "recebida" : "paga",
      registro: c,
    })),
    ...lancamentos.map((l) => ({
      data: l.data,
      entrada: l.tipo === "ENTRADA",
      valor: l.valor,
      categoria: l.categoria,
      centroCusto: l.centroCusto,
      contaBancariaId: l.contaBancariaId,
      origem: "manual",
      registro: l,
    })),
  ];
}

/** Linha do tempo diária com saldo acumulado a partir do saldo inicial. */
export function linhaDoTempo(movimentos, saldoInicial) {
  const porDia = new Map();
  for (const m of movimentos) {
    const bucket = porDia.get(m.data) ?? { data: m.data, entradas: 0, saidas: 0 };
    if (m.entrada) bucket.entradas += m.valor;
    else bucket.saidas += m.valor;
    porDia.set(m.data, bucket);
  }
  let saldo = saldoInicial;
  return [...porDia.values()]
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((b) => {
      saldo += b.entradas - b.saidas;
      return { data: b.data, entradas: arredondar(b.entradas), saidas: arredondar(b.saidas), saldo: arredondar(saldo) };
    });
}
