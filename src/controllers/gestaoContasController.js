import { randomUUID } from "crypto";
import { Op } from "sequelize";
import { ContaBancaria, ContaFinanceira, LancamentoFinanceiro, Usuario, sequelize } from "../models/index.js";
import {
  agruparSoma,
  arredondar,
  hojeBrasil,
  isDia,
  linhaDoTempo,
  mesesEntre,
  movimentosRealizados,
  resumirContas,
  situacaoConta,
  somarDias,
  somarMeses,
  valorEfetivo,
} from "../utils/gestaoContasRules.js";

// Gestão de contas da empresa: contas a pagar/receber, contas bancárias, lançamentos
// manuais, fluxo de caixa, DRE e resumo com gráficos. Rotas em gestaoContas.routes.js.

const TIPOS_CONTA = ["PAGAR", "RECEBER"];
const TIPOS_LANCAMENTO = ["ENTRADA", "SAIDA"];
// Quantos dias antes do vencimento a conta aparece como "vence em breve".
const DIAS_AVISO = 3;

// Sugestões que sempre aparecem (mesmo antes do primeiro lançamento) — as já usadas somam a elas.
const CATEGORIAS_PADRAO = {
  PAGAR: [
    "Aluguel",
    "Energia elétrica",
    "Água",
    "Internet e telefone",
    "Folha de pagamento",
    "Pró-labore",
    "Impostos e taxas",
    "Fornecedores",
    "Manutenção",
    "Combustível",
    "Serviços terceirizados",
    "Marketing",
    "Material de escritório",
    "Tarifas bancárias",
    "Empréstimos e financiamentos",
    "Outras despesas",
  ],
  RECEBER: ["Vendas", "Prestação de serviços", "Aluguel recebido", "Repasses", "Rendimentos", "Outras receitas"],
};
const GRUPOS_PADRAO = ["Despesas fixas", "Despesas variáveis", "Pessoal", "Impostos", "Investimentos", "Financeiro"];
const FORMAS_PAGAMENTO = ["PIX", "Boleto", "Dinheiro", "Cartão de crédito", "Cartão de débito", "Transferência", "Débito automático", "Cheque"];

class ErroValidacao extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const incluirRelacoes = [
  { model: ContaBancaria, as: "contaBancaria", attributes: ["id", "nome"] },
  { model: Usuario, as: "criadoPor", attributes: ["id", "nome"] },
];

function texto(value, max = 255) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  return t ? t.slice(0, max) : null;
}

function numero(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  return Number.isFinite(n) ? arredondar(n) : null;
}

function exigirDia(value, campo) {
  if (!isDia(value)) throw new ErroValidacao(`${campo} inválida.`);
  return value;
}

function exigirDataAteHoje(value, campo) {
  const dia = value ? exigirDia(value, campo) : hojeBrasil();
  if (dia > hojeBrasil()) throw new ErroValidacao(`${campo} não pode ser no futuro.`);
  return dia;
}

function responderErro(res, error, fallback) {
  if (error instanceof ErroValidacao) return res.status(error.status).json({ error: error.message });
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

function serializarConta(conta, hoje = hojeBrasil()) {
  const json = conta.toJSON();
  return { ...json, situacao: situacaoConta(json, hoje) };
}

// Período de/até ("YYYY-MM-DD") num campo de data.
function filtroPeriodo(campo, de, ate) {
  if (!de && !ate) return {};
  return { [campo]: { ...(isDia(de) ? { [Op.gte]: de } : {}), ...(isDia(ate) ? { [Op.lte]: ate } : {}) } };
}

/**
 * Filtros comuns à lista e aos totais do topo (os totais ignoram só a situação):
 * período (por vencimento ou quitação), busca livre, categoria, grupo, centro de custo e valor.
 */
function filtrosConta(query) {
  const where = { tipo: query.tipo };
  const campoPeriodo = query.periodoPor === "quitacao" ? "dataQuitacao" : "vencimento";
  Object.assign(where, filtroPeriodo(campoPeriodo, query.de, query.ate));
  if (query.categoria) where.categoria = query.categoria;
  if (query.grupo) where.grupo = query.grupo;
  if (query.centroCusto) where.centroCusto = query.centroCusto;
  if (query.contaBancariaId) where.contaBancariaId = query.contaBancariaId;
  const valor = numero(query.valor);
  if (valor !== null) where.valor = valor;
  const busca = texto(query.busca, 100);
  if (busca) {
    const like = { [Op.iLike]: `%${busca}%` };
    where[Op.or] = [{ descricao: like }, { pessoa: like }, { documento: like }, { observacao: like }, { categoria: like }];
  }
  return where;
}

function filtroSituacao(situacao, hoje) {
  switch (situacao) {
    case "aberto":
      return { status: "PENDENTE" };
    case "vencidas":
      return { status: "PENDENTE", vencimento: { [Op.lt]: hoje } };
    case "quitadas":
      return { status: "QUITADA" };
    case "canceladas":
      return { status: "CANCELADA" };
    default:
      return {};
  }
}

function validarTipo(tipo) {
  if (!TIPOS_CONTA.includes(tipo)) throw new ErroValidacao("Tipo de conta inválido (PAGAR ou RECEBER).");
  return tipo;
}

async function validarContaBancaria(id, transaction) {
  if (!id) return null;
  const conta = await ContaBancaria.findByPk(id, { transaction });
  if (!conta) throw new ErroValidacao("Conta bancária não encontrada.");
  return conta.id;
}

// ---------------------------------------------------------------- Contas a pagar/receber

// GET /contas?tipo=PAGAR&situacao=aberto&periodoPor=vencimento&de&ate&busca&categoria&valor&page&pageSize
export const listarContas = async (req, res) => {
  try {
    validarTipo(req.query.tipo);
    const hoje = hojeBrasil();
    const situacao = req.query.situacao || "todas";
    const where = { ...filtrosConta(req.query), ...filtroSituacao(situacao, hoje) };
    // Em aberto: o que vence primeiro no topo. Quitadas: a mais recente primeiro.
    const order =
      situacao === "aberto" || situacao === "vencidas"
        ? [["vencimento", "ASC"], ["createdAt", "ASC"]]
        : situacao === "quitadas"
          ? [["dataQuitacao", "DESC"], ["vencimento", "DESC"]]
          : [["vencimento", "DESC"], ["createdAt", "DESC"]];
    const todas = req.query.pageSize === "all";
    const pageSize = todas ? null : Math.min(200, Math.max(1, Number(req.query.pageSize) || 10));
    const page = Math.max(1, Number(req.query.page) || 1);

    const { rows, count } = await ContaFinanceira.findAndCountAll({
      where,
      include: incluirRelacoes,
      order,
      distinct: true,
      ...(pageSize ? { limit: pageSize, offset: (page - 1) * pageSize } : {}),
    });
    res.json({ items: rows.map((c) => serializarConta(c, hoje)), total: count });
  } catch (error) {
    responderErro(res, error, "Erro ao listar contas.");
  }
};

// GET /contas/resumo?tipo=PAGAR&(mesmos filtros) — totais do topo.
export const resumoContas = async (req, res) => {
  try {
    validarTipo(req.query.tipo);
    const contas = await ContaFinanceira.findAll({
      where: { ...filtrosConta(req.query), status: { [Op.ne]: "CANCELADA" } },
      attributes: ["status", "valor", "valorQuitado", "vencimento"],
    });
    res.json({ resumo: resumirContas(contas.map((c) => c.toJSON())) });
  } catch (error) {
    responderErro(res, error, "Erro ao calcular o resumo das contas.");
  }
};

// GET /contas/alertas — vencidas e que vencem nos próximos dias, a pagar e a receber.
export const alertasContas = async (_req, res) => {
  try {
    const hoje = hojeBrasil();
    const limite = somarDias(hoje, DIAS_AVISO);
    const contas = await ContaFinanceira.findAll({
      where: { status: "PENDENTE", vencimento: { [Op.lte]: limite } },
      attributes: ["tipo", "valor", "vencimento"],
    });
    const vazio = () => ({ vencidas: { total: 0, count: 0 }, emBreve: { total: 0, count: 0 } });
    const alertas = { PAGAR: vazio(), RECEBER: vazio(), diasAviso: DIAS_AVISO };
    for (const c of contas) {
      const alvo = c.vencimento < hoje ? alertas[c.tipo].vencidas : alertas[c.tipo].emBreve;
      alvo.total = arredondar(alvo.total + c.valor);
      alvo.count += 1;
    }
    res.json({ alertas });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar alertas de vencimento.");
  }
};

// GET /classificacoes — sugestões de categorias, grupos, centros de custo e pessoas.
export const listarClassificacoes = async (_req, res) => {
  try {
    const [contas, lancamentos] = await Promise.all([
      ContaFinanceira.findAll({
        attributes: ["tipo", "categoria", "grupo", "centroCusto", "pessoa"],
        group: ["tipo", "categoria", "grupo", "centro_custo", "pessoa"],
        raw: true,
      }),
      LancamentoFinanceiro.findAll({ attributes: ["tipo", "categoria", "centroCusto"], group: ["tipo", "categoria", "centro_custo"], raw: true }),
    ]);
    const unicos = (lista) => {
      const vistos = new Map();
      for (const item of lista) if (item && !vistos.has(item.toLowerCase())) vistos.set(item.toLowerCase(), item);
      return [...vistos.values()];
    };
    const ordenar = (lista) => lista.sort((a, b) => a.localeCompare(b, "pt-BR"));
    const usadas = (tipoConta, tipoLanc) => [
      ...contas.filter((c) => c.tipo === tipoConta).map((c) => c.categoria),
      ...lancamentos.filter((l) => l.tipo === tipoLanc).map((l) => l.categoria),
    ];
    res.json({
      categorias: {
        PAGAR: unicos([...CATEGORIAS_PADRAO.PAGAR, ...ordenar(usadas("PAGAR", "SAIDA"))]),
        RECEBER: unicos([...CATEGORIAS_PADRAO.RECEBER, ...ordenar(usadas("RECEBER", "ENTRADA"))]),
      },
      grupos: unicos([...GRUPOS_PADRAO, ...ordenar(contas.map((c) => c.grupo).filter(Boolean))]),
      centrosCusto: unicos(ordenar([...contas, ...lancamentos].map((c) => c.centroCusto).filter(Boolean))),
      pessoas: {
        PAGAR: unicos(ordenar(contas.filter((c) => c.tipo === "PAGAR").map((c) => c.pessoa).filter(Boolean))),
        RECEBER: unicos(ordenar(contas.filter((c) => c.tipo === "RECEBER").map((c) => c.pessoa).filter(Boolean))),
      },
      formasPagamento: FORMAS_PAGAMENTO,
    });
  } catch (error) {
    responderErro(res, error, "Erro ao carregar classificações.");
  }
};

/**
 * POST /contas — cada parcela vira uma conta; mais de uma compartilham grupoParcelasId e
 * têm parcelaNumero/parcelaTotal (baixadas uma a uma). Parcela com `quitada` já nasce paga.
 * Body: { tipo, descricao, categoria, grupo, centroCusto, pessoa, documento, observacao,
 *         formaPagamento, contaBancariaId, recorrente, parcelas: [{ vencimento, valor,
 *         documento?, quitada?: { data, contaBancariaId? } }] }
 */
export const criarContas = async (req, res) => {
  try {
    const body = req.body || {};
    const tipo = validarTipo(body.tipo);
    const descricao = texto(body.descricao);
    const categoria = texto(body.categoria, 120);
    if (!descricao) throw new ErroValidacao("Informe a descrição.");
    if (!categoria) throw new ErroValidacao("Informe a categoria.");
    const parcelas = Array.isArray(body.parcelas) ? body.parcelas : [];
    if (parcelas.length === 0) throw new ErroValidacao("Informe ao menos um vencimento com valor.");
    if (parcelas.length > 120) throw new ErroValidacao("Máximo de 120 parcelas por lançamento.");

    const linhas = parcelas.map((p, i) => {
      const valor = numero(p.valor);
      if (!(valor > 0)) throw new ErroValidacao(`Valor inválido na parcela ${i + 1}.`);
      const vencimento = exigirDia(p.vencimento, `Data de vencimento da parcela ${i + 1}`);
      const quitada = p.quitada ? exigirDataAteHoje(p.quitada.data, `Data de ${tipo === "PAGAR" ? "pagamento" : "recebimento"}`) : null;
      return { valor, vencimento, quitada, documento: texto(p.documento, 80), contaQuitacao: p.quitada?.contaBancariaId };
    });

    const total = linhas.length;
    const grupoParcelasId = total > 1 ? randomUUID() : null;
    const contas = await sequelize.transaction(async (transaction) => {
      const contaBancariaId = await validarContaBancaria(body.contaBancariaId, transaction);
      const registros = [];
      for (const [i, linha] of linhas.entries()) {
        const contaQuitacao = (await validarContaBancaria(linha.contaQuitacao, transaction)) ?? contaBancariaId;
        registros.push({
          tipo,
          descricao,
          categoria,
          grupo: texto(body.grupo, 120),
          centroCusto: texto(body.centroCusto, 120),
          pessoa: texto(body.pessoa, 160),
          documento: linha.documento ?? texto(body.documento, 80),
          observacao: texto(body.observacao, 2000),
          formaPagamento: texto(body.formaPagamento, 40),
          contaBancariaId: linha.quitada ? contaQuitacao : contaBancariaId,
          valor: linha.valor,
          vencimento: linha.vencimento,
          parcelaNumero: total > 1 ? i + 1 : null,
          parcelaTotal: total > 1 ? total : null,
          grupoParcelasId,
          recorrente: Boolean(body.recorrente) && total > 1,
          criadoPorId: req.usuario?.id ?? null,
          ...(linha.quitada ? { status: "QUITADA", dataQuitacao: linha.quitada, valorQuitado: linha.valor } : {}),
        });
      }
      return ContaFinanceira.bulkCreate(registros, { transaction });
    });
    res.status(201).json({ contas: contas.map((c) => serializarConta(c)) });
  } catch (error) {
    responderErro(res, error, "Erro ao lançar a conta.");
  }
};

// PUT /contas/:id — edição livre (descrição, valor, vencimento, classificação, quitação...).
export const atualizarConta = async (req, res) => {
  try {
    const conta = await ContaFinanceira.findByPk(req.params.id);
    if (!conta) return res.status(404).json({ error: "Conta não encontrada." });
    const body = req.body || {};
    const dados = {};
    for (const [campo, max] of [["descricao", 255], ["categoria", 120]]) {
      if (body[campo] !== undefined) {
        const valor = texto(body[campo], max);
        if (!valor) throw new ErroValidacao(`Informe ${campo === "descricao" ? "a descrição" : "a categoria"}.`);
        dados[campo] = valor;
      }
    }
    for (const [campo, max] of [["grupo", 120], ["centroCusto", 120], ["pessoa", 160], ["documento", 80], ["formaPagamento", 40], ["observacao", 2000]]) {
      if (body[campo] !== undefined) dados[campo] = texto(body[campo], max);
    }
    if (body.valor !== undefined) {
      const valor = numero(body.valor);
      if (!(valor > 0)) throw new ErroValidacao("Valor inválido.");
      dados.valor = valor;
    }
    if (body.vencimento !== undefined) dados.vencimento = exigirDia(body.vencimento, "Data de vencimento");
    if (body.contaBancariaId !== undefined) dados.contaBancariaId = await validarContaBancaria(body.contaBancariaId || null);
    if (conta.status === "QUITADA") {
      if (body.dataQuitacao !== undefined) dados.dataQuitacao = exigirDataAteHoje(body.dataQuitacao, "Data de quitação");
      if (body.valorQuitado !== undefined) {
        const valor = numero(body.valorQuitado);
        if (!(valor >= 0)) throw new ErroValidacao("Valor pago/recebido inválido.");
        dados.valorQuitado = valor;
      }
    }
    await conta.update(dados);
    await conta.reload({ include: incluirRelacoes });
    res.json({ conta: serializarConta(conta) });
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar a conta.");
  }
};

// POST /contas/:id/quitar { data, valor, contaBancariaId, formaPagamento } — pagar/receber.
export const quitarConta = async (req, res) => {
  try {
    const conta = await ContaFinanceira.findByPk(req.params.id);
    if (!conta) return res.status(404).json({ error: "Conta não encontrada." });
    if (conta.status !== "PENDENTE") throw new ErroValidacao("Só é possível baixar contas em aberto.", 409);
    const body = req.body || {};
    const valor = body.valor === undefined || body.valor === "" ? conta.valor : numero(body.valor);
    if (!(valor >= 0)) throw new ErroValidacao("Valor inválido.");
    await conta.update({
      status: "QUITADA",
      dataQuitacao: exigirDataAteHoje(body.data, `Data do ${conta.tipo === "PAGAR" ? "pagamento" : "recebimento"}`),
      valorQuitado: valor,
      contaBancariaId: body.contaBancariaId !== undefined ? await validarContaBancaria(body.contaBancariaId || null) : conta.contaBancariaId,
      formaPagamento: body.formaPagamento !== undefined ? texto(body.formaPagamento, 40) : conta.formaPagamento,
    });
    res.json({ conta: serializarConta(conta) });
  } catch (error) {
    responderErro(res, error, "Erro ao baixar a conta.");
  }
};

// POST /contas/quitar-lote { itens: [{ id, data? }], contaBancariaId? } — valor cheio de cada uma.
export const quitarContasLote = async (req, res) => {
  try {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (itens.length === 0) throw new ErroValidacao("Selecione ao menos uma conta.");
    const datas = itens.map((item) => ({ id: item.id, data: exigirDataAteHoje(item.data, "Data de quitação") }));
    const quitadas = await sequelize.transaction(async (transaction) => {
      const contaBancariaId = await validarContaBancaria(req.body?.contaBancariaId || null, transaction);
      let count = 0;
      for (const { id, data } of datas) {
        const conta = await ContaFinanceira.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!conta || conta.status !== "PENDENTE") continue;
        await conta.update(
          { status: "QUITADA", dataQuitacao: data, valorQuitado: conta.valor, contaBancariaId: contaBancariaId ?? conta.contaBancariaId },
          { transaction }
        );
        count += 1;
      }
      return count;
    });
    res.json({ quitadas });
  } catch (error) {
    responderErro(res, error, "Erro ao baixar as contas.");
  }
};

// POST /contas/:id/reabrir — desfaz a baixa (estorno) ou reativa uma cancelada.
export const reabrirConta = async (req, res) => {
  try {
    const conta = await ContaFinanceira.findByPk(req.params.id);
    if (!conta) return res.status(404).json({ error: "Conta não encontrada." });
    if (conta.status === "PENDENTE") throw new ErroValidacao("A conta já está em aberto.", 409);
    await conta.update({ status: "PENDENTE", dataQuitacao: null, valorQuitado: null });
    res.json({ conta: serializarConta(conta) });
  } catch (error) {
    responderErro(res, error, "Erro ao reabrir a conta.");
  }
};

// POST /contas/:id/cancelar
export const cancelarConta = async (req, res) => {
  try {
    const conta = await ContaFinanceira.findByPk(req.params.id);
    if (!conta) return res.status(404).json({ error: "Conta não encontrada." });
    if (conta.status !== "PENDENTE") throw new ErroValidacao("Só é possível cancelar contas em aberto.", 409);
    await conta.update({ status: "CANCELADA" });
    res.json({ conta: serializarConta(conta) });
  } catch (error) {
    responderErro(res, error, "Erro ao cancelar a conta.");
  }
};

// DELETE /contas/:id?parcelasFuturas=1 — exclui a conta (e, se pedido, as próximas parcelas em aberto).
export const excluirConta = async (req, res) => {
  try {
    const conta = await ContaFinanceira.findByPk(req.params.id);
    if (!conta) return res.status(404).json({ error: "Conta não encontrada." });
    let excluidas = 1;
    await sequelize.transaction(async (transaction) => {
      if (req.query.parcelasFuturas === "1" && conta.grupoParcelasId) {
        excluidas += await ContaFinanceira.destroy({
          where: {
            grupoParcelasId: conta.grupoParcelasId,
            id: { [Op.ne]: conta.id },
            status: "PENDENTE",
            parcelaNumero: { [Op.gt]: conta.parcelaNumero ?? 0 },
          },
          transaction,
        });
      }
      await conta.destroy({ transaction });
    });
    res.json({ excluidas });
  } catch (error) {
    responderErro(res, error, "Erro ao excluir a conta.");
  }
};

// ---------------------------------------------------------------- Contas bancárias

/** Movimento líquido por conta bancária (quitações + lançamentos), opcionalmente até uma data. */
async function movimentoPorContaBancaria(ateExclusive) {
  const filtroQuitacao = ateExclusive ? { dataQuitacao: { [Op.lt]: ateExclusive } } : {};
  const filtroLanc = ateExclusive ? { data: { [Op.lt]: ateExclusive } } : {};
  const [contas, lancamentos] = await Promise.all([
    ContaFinanceira.findAll({
      where: { status: "QUITADA", ...filtroQuitacao },
      attributes: ["contaBancariaId", "tipo", [sequelize.fn("SUM", sequelize.fn("COALESCE", sequelize.col("valor_quitado"), sequelize.col("valor"))), "total"]],
      group: ["conta_bancaria_id", "tipo"],
      raw: true,
    }),
    LancamentoFinanceiro.findAll({
      where: filtroLanc,
      attributes: ["contaBancariaId", "tipo", [sequelize.fn("SUM", sequelize.col("valor")), "total"]],
      group: ["conta_bancaria_id", "tipo"],
      raw: true,
    }),
  ]);
  const mapa = new Map();
  for (const row of [...contas, ...lancamentos]) {
    const entrada = row.tipo === "RECEBER" || row.tipo === "ENTRADA";
    const atual = mapa.get(row.contaBancariaId ?? null) ?? 0;
    mapa.set(row.contaBancariaId ?? null, atual + (entrada ? 1 : -1) * Number(row.total || 0));
  }
  return mapa;
}

// GET /bancos?arquivadas=1 — contas com saldo atual (saldo inicial + tudo que entrou/saiu nela).
export const listarContasBancarias = async (req, res) => {
  try {
    const [contas, movimento] = await Promise.all([
      ContaBancaria.findAll({ where: req.query.arquivadas === "1" ? {} : { ativo: true }, order: [["ativo", "DESC"], ["nome", "ASC"]] }),
      movimentoPorContaBancaria(),
    ]);
    res.json({
      contas: contas.map((c) => ({ ...c.toJSON(), saldoAtual: arredondar(c.saldoInicial + (movimento.get(c.id) ?? 0)) })),
      semConta: arredondar(movimento.get(null) ?? 0),
    });
  } catch (error) {
    responderErro(res, error, "Erro ao listar contas bancárias.");
  }
};

function dadosContaBancaria(body, parcial = false) {
  const dados = {};
  if (!parcial || body.nome !== undefined) {
    dados.nome = texto(body.nome, 120);
    if (!dados.nome) throw new ErroValidacao("Informe o nome da conta.");
  }
  if (!parcial || body.tipo !== undefined) dados.tipo = ["BANCO", "CAIXA", "OUTRO"].includes(body.tipo) ? body.tipo : "BANCO";
  for (const [campo, max] of [["banco", 120], ["agencia", 30], ["numeroConta", 40]]) {
    if (!parcial || body[campo] !== undefined) dados[campo] = texto(body[campo], max);
  }
  if (!parcial || body.saldoInicial !== undefined) dados.saldoInicial = numero(body.saldoInicial) ?? 0;
  if (body.ativo !== undefined) dados.ativo = Boolean(body.ativo);
  return dados;
}

export const criarContaBancaria = async (req, res) => {
  try {
    const conta = await ContaBancaria.create(dadosContaBancaria(req.body || {}));
    res.status(201).json({ conta });
  } catch (error) {
    responderErro(res, error, "Erro ao criar conta bancária.");
  }
};

export const atualizarContaBancaria = async (req, res) => {
  try {
    const conta = await ContaBancaria.findByPk(req.params.id);
    if (!conta) return res.status(404).json({ error: "Conta bancária não encontrada." });
    await conta.update(dadosContaBancaria(req.body || {}, true));
    res.json({ conta });
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar conta bancária.");
  }
};

// DELETE /bancos/:id — arquiva (o histórico continua apontando pra ela).
export const arquivarContaBancaria = async (req, res) => {
  try {
    const conta = await ContaBancaria.findByPk(req.params.id);
    if (!conta) return res.status(404).json({ error: "Conta bancária não encontrada." });
    await conta.update({ ativo: false });
    res.json({ conta });
  } catch (error) {
    responderErro(res, error, "Erro ao arquivar conta bancária.");
  }
};

// ---------------------------------------------------------------- Lançamentos manuais

// GET /lancamentos?de&ate&tipo&categoria
export const listarLancamentos = async (req, res) => {
  try {
    const where = { ...filtroPeriodo("data", req.query.de, req.query.ate) };
    if (TIPOS_LANCAMENTO.includes(req.query.tipo)) where.tipo = req.query.tipo;
    if (req.query.categoria) where.categoria = req.query.categoria;
    const lancamentos = await LancamentoFinanceiro.findAll({ where, include: incluirRelacoes, order: [["data", "DESC"], ["createdAt", "DESC"]] });
    res.json({ lancamentos });
  } catch (error) {
    responderErro(res, error, "Erro ao listar lançamentos.");
  }
};

async function dadosLancamento(body, parcial = false) {
  const dados = {};
  if (!parcial || body.tipo !== undefined) {
    if (!TIPOS_LANCAMENTO.includes(body.tipo)) throw new ErroValidacao("Tipo inválido (ENTRADA ou SAIDA).");
    dados.tipo = body.tipo;
  }
  for (const [campo, nome] of [["descricao", "a descrição"], ["categoria", "a categoria"]]) {
    if (!parcial || body[campo] !== undefined) {
      dados[campo] = texto(body[campo], campo === "descricao" ? 255 : 120);
      if (!dados[campo]) throw new ErroValidacao(`Informe ${nome}.`);
    }
  }
  if (!parcial || body.valor !== undefined) {
    dados.valor = numero(body.valor);
    if (!(dados.valor > 0)) throw new ErroValidacao("Valor inválido.");
  }
  if (!parcial || body.data !== undefined) dados.data = exigirDataAteHoje(body.data, "Data");
  if (!parcial || body.centroCusto !== undefined) dados.centroCusto = texto(body.centroCusto, 120);
  if (!parcial || body.formaPagamento !== undefined) dados.formaPagamento = texto(body.formaPagamento, 40);
  if (!parcial || body.contaBancariaId !== undefined) dados.contaBancariaId = await validarContaBancaria(body.contaBancariaId || null);
  return dados;
}

export const criarLancamento = async (req, res) => {
  try {
    const lancamento = await LancamentoFinanceiro.create({ ...(await dadosLancamento(req.body || {})), criadoPorId: req.usuario?.id ?? null });
    await lancamento.reload({ include: incluirRelacoes });
    res.status(201).json({ lancamento });
  } catch (error) {
    responderErro(res, error, "Erro ao registrar lançamento.");
  }
};

export const atualizarLancamento = async (req, res) => {
  try {
    const lancamento = await LancamentoFinanceiro.findByPk(req.params.id);
    if (!lancamento) return res.status(404).json({ error: "Lançamento não encontrado." });
    await lancamento.update(await dadosLancamento(req.body || {}, true));
    await lancamento.reload({ include: incluirRelacoes });
    res.json({ lancamento });
  } catch (error) {
    responderErro(res, error, "Erro ao atualizar lançamento.");
  }
};

export const excluirLancamento = async (req, res) => {
  try {
    const excluidos = await LancamentoFinanceiro.destroy({ where: { id: req.params.id } });
    if (!excluidos) return res.status(404).json({ error: "Lançamento não encontrado." });
    res.status(204).send();
  } catch (error) {
    responderErro(res, error, "Erro ao excluir lançamento.");
  }
};

// ---------------------------------------------------------------- Fluxo de caixa, DRE e resumo

function periodoPadrao(query) {
  const hoje = hojeBrasil();
  const de = isDia(query.de) ? query.de : `${hoje.slice(0, 7)}-01`;
  const ate = isDia(query.ate) ? query.ate : hoje;
  if (de > ate) throw new ErroValidacao("A data inicial é depois da data final.");
  return { de, ate };
}

async function movimentosNoPeriodo(de, ate, contaBancariaId) {
  const filtroConta = contaBancariaId ? { contaBancariaId } : {};
  const [contas, lancamentos] = await Promise.all([
    ContaFinanceira.findAll({
      where: { status: "QUITADA", dataQuitacao: { [Op.between]: [de, ate] }, ...filtroConta },
      include: incluirRelacoes,
      order: [["dataQuitacao", "ASC"]],
    }),
    LancamentoFinanceiro.findAll({ where: { data: { [Op.between]: [de, ate] }, ...filtroConta }, include: incluirRelacoes, order: [["data", "ASC"]] }),
  ]);
  return movimentosRealizados(
    contas.map((c) => c.toJSON()),
    lancamentos.map((l) => l.toJSON())
  );
}

/** Saldo no começo do dia `de`: saldos iniciais + tudo que entrou/saiu antes dele. */
async function saldoAntesDe(de, contaBancariaId) {
  const [bancos, movimento] = await Promise.all([
    ContaBancaria.findAll({ where: contaBancariaId ? { id: contaBancariaId } : { ativo: true }, attributes: ["id", "saldoInicial"] }),
    movimentoPorContaBancaria(de),
  ]);
  const inicial = bancos.reduce((s, b) => s + b.saldoInicial, 0);
  if (contaBancariaId) return arredondar(inicial + (movimento.get(contaBancariaId) ?? 0));
  // Sem filtro de conta: todo o movimento conta (inclusive o sem conta bancária e o de contas arquivadas).
  return arredondar(inicial + [...movimento.values()].reduce((s, v) => s + v, 0));
}

function dre(movimentos) {
  const receitas = agruparSoma(movimentos.filter((m) => m.entrada), (m) => m.categoria, (m) => m.valor);
  const despesas = agruparSoma(movimentos.filter((m) => !m.entrada), (m) => m.categoria, (m) => m.valor);
  const receitaTotal = arredondar(receitas.reduce((s, r) => s + r.total, 0));
  const despesaTotal = arredondar(despesas.reduce((s, r) => s + r.total, 0));
  return { receitas, despesas, receitaTotal, despesaTotal, resultado: arredondar(receitaTotal - despesaTotal) };
}

// GET /fluxo-caixa?de&ate&contaBancariaId — realizado no período + previsto (contas em aberto).
export const fluxoCaixa = async (req, res) => {
  try {
    const { de, ate } = periodoPadrao(req.query);
    const contaBancariaId = req.query.contaBancariaId || null;
    const [movimentos, saldoInicial, emAberto] = await Promise.all([
      movimentosNoPeriodo(de, ate, contaBancariaId),
      saldoAntesDe(de, contaBancariaId),
      ContaFinanceira.findAll({
        where: { status: "PENDENTE", vencimento: { [Op.between]: [de, ate] }, ...(contaBancariaId ? { contaBancariaId } : {}) },
        attributes: ["tipo", "valor"],
      }),
    ]);
    const entradas = arredondar(movimentos.filter((m) => m.entrada).reduce((s, m) => s + m.valor, 0));
    const saidas = arredondar(movimentos.filter((m) => !m.entrada).reduce((s, m) => s + m.valor, 0));
    const saldoFinal = arredondar(saldoInicial + entradas - saidas);
    const previstoReceber = arredondar(emAberto.filter((c) => c.tipo === "RECEBER").reduce((s, c) => s + c.valor, 0));
    const previstoPagar = arredondar(emAberto.filter((c) => c.tipo === "PAGAR").reduce((s, c) => s + c.valor, 0));

    res.json({
      fluxo: {
        de,
        ate,
        saldoInicial,
        entradas,
        saidas,
        saldoFinal,
        previstoReceber,
        previstoPagar,
        saldoProjetado: arredondar(saldoFinal + previstoReceber - previstoPagar),
        linhaDoTempo: linhaDoTempo(movimentos, saldoInicial),
        movimentos: movimentos
          .map(({ registro, ...m }) => ({ ...m, id: registro.id, descricao: registro.descricao, pessoa: registro.pessoa ?? null, contaBancaria: registro.contaBancaria?.nome ?? null, registro }))
          .sort((a, b) => b.data.localeCompare(a.data)),
        dre: dre(movimentos),
      },
    });
  } catch (error) {
    responderErro(res, error, "Erro ao calcular o fluxo de caixa.");
  }
};

// GET /resumo?de&ate — painel de análise: totais, séries mensais, composição e projeção.
export const resumoGeral = async (req, res) => {
  try {
    const { de, ate } = periodoPadrao(req.query);
    const hoje = hojeBrasil();
    // Série mensal: no mínimo os últimos 6 meses até o fim do período.
    const inicioSerie = (() => {
      const seisMeses = somarMeses(`${ate.slice(0, 7)}-01`, -5);
      return de < seisMeses ? `${de.slice(0, 7)}-01` : seisMeses;
    })();
    const fimProjecao = somarDias(hoje, 55);

    const [movimentosSerie, abertas, bancos, movimentoBancos] = await Promise.all([
      movimentosNoPeriodo(inicioSerie, ate),
      ContaFinanceira.findAll({ where: { status: "PENDENTE" }, include: incluirRelacoes, order: [["vencimento", "ASC"]] }),
      ContaBancaria.findAll({ where: { ativo: true } }),
      movimentoPorContaBancaria(),
    ]);
    const movimentos = movimentosSerie.filter((m) => m.data >= de && m.data <= ate);
    const resultado = dre(movimentos);

    const mensal = mesesEntre(inicioSerie, ate).map((mes) => {
      const doMes = movimentosSerie.filter((m) => m.data.startsWith(mes));
      const entradas = arredondar(doMes.filter((m) => m.entrada).reduce((s, m) => s + m.valor, 0));
      const saidas = arredondar(doMes.filter((m) => !m.entrada).reduce((s, m) => s + m.valor, 0));
      return { mes, entradas, saidas, resultado: arredondar(entradas - saidas) };
    });

    // Projeção semanal (8 semanas a partir de hoje) do que está em aberto; vencidas entram na 1ª.
    const projecao = Array.from({ length: 8 }, (_, i) => {
      const inicio = somarDias(hoje, i * 7);
      return { inicio, fim: somarDias(inicio, 6), pagar: 0, receber: 0 };
    });
    for (const conta of abertas) {
      if (conta.vencimento > fimProjecao) continue;
      const semana = conta.vencimento < hoje ? projecao[0] : projecao.find((s) => conta.vencimento >= s.inicio && conta.vencimento <= s.fim);
      if (!semana) continue;
      if (conta.tipo === "PAGAR") semana.pagar = arredondar(semana.pagar + conta.valor);
      else semana.receber = arredondar(semana.receber + conta.valor);
    }

    const abertasJson = abertas.map((c) => serializarConta(c, hoje));
    const resumoAberto = (tipo) => resumirContas(abertasJson.filter((c) => c.tipo === tipo), hoje);
    const saldoBancos = arredondar(bancos.reduce((s, b) => s + b.saldoInicial + (movimentoBancos.get(b.id) ?? 0), 0));

    res.json({
      resumo: {
        de,
        ate,
        entradas: resultado.receitaTotal,
        saidas: resultado.despesaTotal,
        resultado: resultado.resultado,
        margem: resultado.receitaTotal > 0 ? arredondar((resultado.resultado / resultado.receitaTotal) * 100) : null,
        saldoBancos,
        bancos: bancos.map((b) => ({ id: b.id, nome: b.nome, saldo: arredondar(b.saldoInicial + (movimentoBancos.get(b.id) ?? 0)) })),
        pagar: resumoAberto("PAGAR"),
        receber: resumoAberto("RECEBER"),
        mensal,
        despesasPorCategoria: resultado.despesas,
        receitasPorCategoria: resultado.receitas,
        despesasPorCentroCusto: agruparSoma(movimentos.filter((m) => !m.entrada), (m) => m.centroCusto, (m) => m.valor),
        projecao,
        proximosVencimentos: abertasJson.filter((c) => c.vencimento <= somarDias(hoje, 15)).slice(0, 12),
        quantidadeLancamentos: movimentos.length,
      },
    });
  } catch (error) {
    responderErro(res, error, "Erro ao calcular o resumo financeiro.");
  }
};
