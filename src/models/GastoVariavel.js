import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

const GastoVariavel = sequelize.define(
  "GastoVariavel",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    lojaId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "lojas", key: "id" },
    },
    nome: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    valor: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    observacao: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    dataInicio: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    dataFim: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    // Sem FK no banco (no Bedin a tabela registro_dinheiro é criada pelo mesmo
    // sync, e a FK só atrapalharia a ordem de criação).
    registroDinheiroId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    usuarioId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "usuarios", key: "id" },
    },
    veiculoId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "veiculos", key: "id" },
    },
  },
  {
    tableName: "GastoVariavel",
    timestamps: true,
  },
);

export default GastoVariavel;
