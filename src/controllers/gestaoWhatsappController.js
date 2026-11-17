import * as whatsapp from "../services/gestaoWhatsappService.js";

// Gestão de Contas → aba WhatsApp. Rotas em gestaoContas.routes.js (/api/gestao-contas/whatsapp).

const responder = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    if (!error.status) console.error("[gestao-whatsapp]", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Erro no WhatsApp da gestão de contas." });
  }
};

export const status = responder(() => whatsapp.obterStatus());
export const previa = responder(async () => ({ previa: await whatsapp.previa() }));
export const salvarConfig = responder(async (req) => ({ config: await whatsapp.salvarConfig(req.body, req.usuario?.nome) }));
export const conectar = responder(() => whatsapp.conectar());
export const desconectar = responder(async () => ({ conexao: await whatsapp.desconectar() }));
export const teste = responder((req) => whatsapp.enviarTeste(req.body?.telefone));
export const enviarAgora = responder(async () => ({ resultado: await whatsapp.processarAvisos({ manual: true }) }));

export const criarDestinatario = responder(async (req) => ({ destinatario: await whatsapp.criarDestinatario(req.body || {}) }));
export const atualizarDestinatario = responder(async (req) => ({ destinatario: await whatsapp.atualizarDestinatario(req.params.id, req.body || {}) }));
export const excluirDestinatario = responder(async (req) => {
  await whatsapp.excluirDestinatario(req.params.id);
  return { ok: true };
});
