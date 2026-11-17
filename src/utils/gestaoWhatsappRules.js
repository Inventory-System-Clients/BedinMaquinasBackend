// Regras puras (sem banco) dos avisos de WhatsApp da Gestão de Contas —
// cobertas por test/gestao-whatsapp-rules.test.js.

import { somarDias } from "./gestaoContasRules.js";

export const TIPOS_AVISO = ["ANTECIPADO", "NO_DIA"];

/** 55 + DDD + número (só dígitos); null se não der para usar. Mesmo critério da GiraKids. */
export function normalizarTelefone(telefone) {
  let digitos = String(telefone || "").replace(/\D/g, "").replace(/^0+/, "");
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  return /^55\d{10,11}$/.test(digitos) ? digitos : null;
}

/** Hora cheia atual no horário de Brasília (0–23). */
export function horaBrasil(now = new Date()) {
  const h = Number(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }));
  return Number.isFinite(h) ? h % 24 : 0;
}

/** Dias corridos entre duas datas "YYYY-MM-DD" (b - a). */
export function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

/**
 * Que aviso a conta merece hoje: NO_DIA quando vence hoje; ANTECIPADO quando vence
 * nos próximos `diasAntes` dias; null fora dessa janela (vencidas não são avisadas aqui).
 */
export function classificarAviso(vencimento, hoje, diasAntes) {
  if (vencimento === hoje) return "NO_DIA";
  if (diasAntes > 0 && vencimento > hoje && vencimento <= somarDias(hoje, diasAntes)) return "ANTECIPADO";
  return null;
}

/** Chave única de um aviso — o vencimento entra para avisar de novo se a conta for reagendada. */
export function chaveAviso(contaId, destinatarioId, tipoAviso, vencimento) {
  return `${contaId}|${destinatarioId}|${tipoAviso}|${vencimento}`;
}

/**
 * Avisos que ainda faltam mandar para um destinatário: só contas PENDENTES, dos tipos que
 * ele escolheu (a pagar / a receber), dos avisos que ele quer (antecipado / no dia) e que
 * ainda não constam como enviados (`bloqueados` = Set de chaveAviso).
 */
export function avisosPendentes({ contas, destinatario, bloqueados = new Set(), hoje, diasAntes }) {
  const itens = [];
  for (const conta of contas) {
    if (conta.status !== "PENDENTE") continue;
    if (conta.tipo === "PAGAR" && !destinatario.avisarPagar) continue;
    if (conta.tipo === "RECEBER" && !destinatario.avisarReceber) continue;
    const tipoAviso = classificarAviso(conta.vencimento, hoje, diasAntes);
    if (!tipoAviso) continue;
    if (tipoAviso === "NO_DIA" && !destinatario.avisoNoDia) continue;
    if (tipoAviso === "ANTECIPADO" && !destinatario.avisoAntecipado) continue;
    if (bloqueados.has(chaveAviso(conta.id, destinatario.id, tipoAviso, conta.vencimento))) continue;
    itens.push({ conta, tipoAviso });
  }
  return itens.sort((a, b) => (a.conta.vencimento < b.conta.vencimento ? -1 : a.conta.vencimento > b.conta.vencimento ? 1 : 0));
}

const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dataBR = (dia) => dia.split("-").reverse().join("/");

function linha({ conta }, hoje) {
  const tipo = conta.tipo === "PAGAR" ? "A pagar" : "A receber";
  const parcela = conta.parcelaTotal ? ` (${conta.parcelaNumero}/${conta.parcelaTotal})` : "";
  const pessoa = conta.pessoa ? ` · ${conta.pessoa}` : "";
  let quando = "";
  if (conta.vencimento !== hoje) {
    const d = diasEntre(hoje, conta.vencimento);
    quando = ` — vence ${dataBR(conta.vencimento)} (${d === 1 ? "amanhã" : `em ${d} dias`})`;
  }
  return `• ${tipo}: ${conta.descricao}${parcela}${pessoa} — *${brl(conta.valor)}*${quando}`;
}

/** Texto único por destinatário, agrupando "vencem hoje" e "vencem nos próximos dias". */
export function montarMensagem({ nome, itens, hoje, empresa = "Bedin Máquinas" }) {
  const hojeItens = itens.filter((i) => i.tipoAviso === "NO_DIA");
  const breveItens = itens.filter((i) => i.tipoAviso === "ANTECIPADO");
  const primeiroNome = String(nome || "").trim().split(/\s+/)[0];
  const partes = [`*${empresa} · Gestão de Contas*`, `Olá${primeiroNome ? `, ${primeiroNome}` : ""}! 👋`];

  if (hojeItens.length) {
    partes.push(`📅 *Vence${hojeItens.length > 1 ? "m" : ""} hoje (${dataBR(hoje)}):*\n${hojeItens.map((i) => linha(i, hoje)).join("\n")}`);
  }
  if (breveItens.length) {
    partes.push(`⏰ *Vence${breveItens.length > 1 ? "m" : ""} nos próximos dias:*\n${breveItens.map((i) => linha(i, hoje)).join("\n")}`);
  }
  const totalPagar = itens.filter((i) => i.conta.tipo === "PAGAR").reduce((s, i) => s + Number(i.conta.valor || 0), 0);
  if (totalPagar > 0 && itens.length > 1) partes.push(`Total a pagar nestes avisos: *${brl(totalPagar)}*`);
  partes.push("_Aviso automático do sistema. Depois de pagar, dê baixa na Gestão de Contas._");
  return partes.join("\n\n");
}
