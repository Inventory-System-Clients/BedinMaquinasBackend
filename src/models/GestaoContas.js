import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Gestão de contas da empresa (aba Financeiro → Gestão de Contas): contas a pagar e a
// receber, contas bancárias/caixas e lançamentos manuais. As tabelas são criadas pelo
// sequelize.sync() do server.js. Datas de vencimento/quitação são só a data (DATEONLY),
// sem hora — evita o clássico "um dia antes" de fuso.

// DECIMAL do Postgres volta como string — converte pra número na leitura (inclusive no JSON).
const money = (field, allowNull = false) => ({
  type: DataTypes.DECIMAL(14, 2),
  allowNull,
  ...(allowNull ? {} : { defaultValue: 0 }),
  get() {
    const value = this.getDataValue(field);
    return value === null || value === undefined ? null : Number(value);
  },
});

export const ContaBancaria = sequelize.define(
  "ContaBancaria",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    nome: { type: DataTypes.STRING(120), allowNull: false },
    // BANCO, CAIXA (dinheiro em espécie) ou OUTRO (carteira digital, maquininha...)
    tipo: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "BANCO" },
    banco: { type: DataTypes.STRING(120), allowNull: true },
    agencia: { type: DataTypes.STRING(30), allowNull: true },
    numeroConta: { type: DataTypes.STRING(40), allowNull: true },
    saldoInicial: money("saldoInicial"),
    ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "gestao_contas_bancarias", underscored: true, timestamps: true }
);

export const ContaFinanceira = sequelize.define(
  "ContaFinanceira",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    // PAGAR (despesa) ou RECEBER (receita)
    tipo: { type: DataTypes.STRING(10), allowNull: false },
    descricao: { type: DataTypes.STRING(255), allowNull: false },
    categoria: { type: DataTypes.STRING(120), allowNull: false },
    // Classificação opcional: grupo (ex.: "Despesas fixas") e centro de custo/setor.
    grupo: { type: DataTypes.STRING(120), allowNull: true },
    centroCusto: { type: DataTypes.STRING(120), allowNull: true },
    // Fornecedor/beneficiário (a pagar) ou cliente/pagador (a receber).
    pessoa: { type: DataTypes.STRING(160), allowNull: true },
    // Nº do boleto, nota, duplicata, contrato...
    documento: { type: DataTypes.STRING(80), allowNull: true },
    valor: money("valor"),
    vencimento: { type: DataTypes.DATEONLY, allowNull: false },
    // PENDENTE, QUITADA (paga/recebida) ou CANCELADA. "Vencida" é calculado:
    // PENDENTE com vencimento antes de hoje.
    status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: "PENDENTE" },
    dataQuitacao: { type: DataTypes.DATEONLY, allowNull: true },
    valorQuitado: money("valorQuitado", true),
    formaPagamento: { type: DataTypes.STRING(40), allowNull: true },
    contaBancariaId: { type: DataTypes.UUID, allowNull: true },
    observacao: { type: DataTypes.TEXT, allowNull: true },
    // Parcelamento/recorrência: as contas geradas juntas compartilham grupoParcelasId.
    parcelaNumero: { type: DataTypes.INTEGER, allowNull: true },
    parcelaTotal: { type: DataTypes.INTEGER, allowNull: true },
    grupoParcelasId: { type: DataTypes.UUID, allowNull: true },
    recorrente: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    criadoPorId: { type: DataTypes.UUID, allowNull: true },
    // Gasto extra lançado numa movimentação (sai junto se a movimentação for apagada).
    movimentacaoId: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: "gestao_contas",
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ["tipo", "status", "vencimento"] }, { fields: ["data_quitacao"] }],
  }
);

export const LancamentoFinanceiro = sequelize.define(
  "LancamentoFinanceiro",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    // ENTRADA ou SAIDA — movimento avulso, já realizado (sem vencimento).
    tipo: { type: DataTypes.STRING(10), allowNull: false },
    descricao: { type: DataTypes.STRING(255), allowNull: false },
    categoria: { type: DataTypes.STRING(120), allowNull: false },
    centroCusto: { type: DataTypes.STRING(120), allowNull: true },
    valor: money("valor"),
    data: { type: DataTypes.DATEONLY, allowNull: false },
    formaPagamento: { type: DataTypes.STRING(40), allowNull: true },
    contaBancariaId: { type: DataTypes.UUID, allowNull: true },
    criadoPorId: { type: DataTypes.UUID, allowNull: true },
  },
  { tableName: "gestao_lancamentos", underscored: true, timestamps: true, indexes: [{ fields: ["data"] }] }
);
