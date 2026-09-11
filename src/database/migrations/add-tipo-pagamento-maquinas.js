import { sequelize } from "../connection.js";
import { DataTypes } from "sequelize";

/**
 * Migration: Adiciona campos tipo_pagamento_loja e valor_aluguel na tabela
 * maquinas (comissão x aluguel fixo pago ao ponto), e total_aluguel na
 * tabela comissoes_lojas.
 */
export const up = async () => {
  const queryInterface = sequelize.getQueryInterface();

  console.log("Adicionando coluna tipo_pagamento_loja na tabela maquinas...");
  await queryInterface.addColumn("maquinas", "tipo_pagamento_loja", {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: "comissao",
    comment:
      "Forma de pagamento ao ponto/loja: 'comissao' (percentual sobre o lucro) ou 'aluguel' (valor fixo)",
  });

  console.log("Adicionando coluna valor_aluguel na tabela maquinas...");
  await queryInterface.addColumn("maquinas", "valor_aluguel", {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
    comment:
      "Valor mensal fixo de aluguel pago à loja (usado quando tipo_pagamento_loja = aluguel)",
  });

  console.log("Adicionando coluna total_aluguel na tabela comissoes_lojas...");
  await queryInterface.addColumn("comissoes_lojas", "total_aluguel", {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0,
    comment: "Aluguel total descontado das máquinas em modo aluguel",
  });

  console.log("✅ Migration concluída com sucesso!");
};

export const down = async () => {
  const queryInterface = sequelize.getQueryInterface();

  console.log("Removendo coluna total_aluguel da tabela comissoes_lojas...");
  await queryInterface.removeColumn("comissoes_lojas", "total_aluguel");

  console.log("Removendo coluna valor_aluguel da tabela maquinas...");
  await queryInterface.removeColumn("maquinas", "valor_aluguel");

  console.log("Removendo coluna tipo_pagamento_loja da tabela maquinas...");
  await queryInterface.removeColumn("maquinas", "tipo_pagamento_loja");

  console.log("✅ Rollback concluído!");
};
