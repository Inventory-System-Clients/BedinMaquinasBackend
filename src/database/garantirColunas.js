import { sequelize } from "./connection.js";

// O sequelize.sync() do server.js cria tabelas novas, mas NÃO acrescenta colunas novas
// em tabelas que já existem. Estas colunas vieram com a tela de Movimentações da
// AgarraMais; aqui elas são garantidas a cada boot (idempotente: IF NOT EXISTS), sem
// precisar rodar migração manual no Render.
const COLUNAS = [
  ["movimentacoes", "origem_total_pre", "VARCHAR(20)"],
  ["movimentacoes", "valor_ficha_unitario", "DECIMAL(10,2)"],
  ["movimentacoes", "retirada_produto", "INTEGER"],
  ["movimentacao_produtos", '"retiradaProduto"', "INTEGER NOT NULL DEFAULT 0"],
  ["maquinas", "geradora_dinheiro", "BOOLEAN NOT NULL DEFAULT false"],
  ["maquinas", "desconto_automatico_machine_pay", "BOOLEAN NOT NULL DEFAULT false"],
  ["maquinas", "valor_desconto_machine_pay", "DECIMAL(10,2)"],
];

export async function garantirColunas() {
  for (const [tabela, coluna, tipo] of COLUNAS) {
    await sequelize.query(`ALTER TABLE "${tabela}" ADD COLUMN IF NOT EXISTS ${coluna} ${tipo};`);
  }
}
