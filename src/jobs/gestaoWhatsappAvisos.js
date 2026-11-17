// Avisos de vencimento por WhatsApp (Gestão de Contas).
// Roda a cada 30 min no horário de Brasília; o próprio serviço só envia a partir da hora
// configurada e nunca repete um aviso já enviado. Também roda 1 min após o servidor
// subir (no Render o serviço pode ter dormido e perdido o horário).
import cron from "node-cron";
import { processarAvisos } from "../services/gestaoWhatsappService.js";

async function executar() {
  try {
    const r = await processarAvisos();
    if (r?.mensagens) console.log(`📲 Avisos de contas: ${r.mensagens} mensagem(ns), ${r.contasAvisadas} conta(s).`);
    if (r?.falhas?.length) console.warn("📲 Avisos de contas com falha:", r.falhas);
  } catch (error) {
    // WhatsApp desconectado / Evolution fora do ar: fica registrado na última execução.
    console.warn("📲 Avisos de contas não enviados:", error.message);
  }
}

if (process.env.NODE_ENV !== "test") {
  cron.schedule("*/30 * * * *", executar, { timezone: "America/Sao_Paulo" });
  setTimeout(executar, 60 * 1000).unref();
}

export default null;
