import { DataTypes } from "sequelize";
import { sequelize } from "../database/connection.js";

// Avisos de WhatsApp da Gestão de Contas (Evolution API, conectada por QR Code).
// Tabelas criadas pelo sequelize.sync() do server.js.

/** Configuração única (id = 1). A chave da Evolution fica cifrada (utils/cofreCredenciais.js). */
export const WhatsappConfig = sequelize.define(
  "WhatsappConfig",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
    ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    evolutionUrl: { type: DataTypes.STRING(300), allowNull: true },
    instancia: { type: DataTypes.STRING(60), allowNull: true },
    apiKeyCifrada: { type: DataTypes.TEXT, allowNull: true },
    // Quantos dias antes do vencimento vai o aviso antecipado (0 = só no dia).
    diasAntes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    // A partir de que hora (Brasília) os avisos do dia saem.
    horaEnvio: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 8 },
    ultimaExecucao: { type: DataTypes.JSONB, allowNull: true },
    atualizadoPor: { type: DataTypes.STRING(120), allowNull: true },
  },
  { tableName: "gestao_whatsapp_config", underscored: true }
);

/** Quem recebe os avisos (normalmente donos, financeiro, sócios). */
export const WhatsappDestinatario = sequelize.define(
  "WhatsappDestinatario",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    nome: { type: DataTypes.STRING(120), allowNull: false },
    // 55 + DDD + número, só dígitos.
    telefone: { type: DataTypes.STRING(20), allowNull: false },
    ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    avisarPagar: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    avisarReceber: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    avisoAntecipado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    avisoNoDia: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "gestao_whatsapp_destinatarios", underscored: true }
);

/**
 * Registro de cada aviso (conta × destinatário × tipo × vencimento). O índice único impede
 * aviso repetido; ERRO é tentado de novo até 3 vezes no dia.
 */
export const WhatsappAviso = sequelize.define(
  "WhatsappAviso",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    contaId: { type: DataTypes.UUID, allowNull: false },
    destinatarioId: { type: DataTypes.UUID, allowNull: false },
    tipoAviso: { type: DataTypes.STRING(20), allowNull: false }, // ANTECIPADO | NO_DIA
    vencimento: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "ENVIADO" }, // ENVIADO | ERRO
    tentativas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    erro: { type: DataTypes.TEXT, allowNull: true },
    enviadoEm: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "gestao_whatsapp_avisos",
    underscored: true,
    indexes: [{ unique: true, fields: ["conta_id", "destinatario_id", "tipo_aviso", "vencimento"] }],
  }
);
