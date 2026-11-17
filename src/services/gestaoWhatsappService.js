import { Op } from "sequelize";
import { ContaFinanceira, WhatsappAviso, WhatsappConfig, WhatsappDestinatario } from "../models/index.js";
import { hojeBrasil, somarDias } from "../utils/gestaoContasRules.js";
import { avisosPendentes, chaveAviso, horaBrasil, montarMensagem, normalizarTelefone } from "../utils/gestaoWhatsappRules.js";

// Avisos de vencimento por WhatsApp (Gestão de Contas). Mesmo modelo da GiraKids:
// o WhatsApp roda numa Evolution API externa (conectada por QR Code) e aqui só falamos
// com ela por REST. A sessão do WhatsApp fica na Evolution.
//
// URL e chave da Evolution vêm SÓ das variáveis de ambiente protegidas do servidor
// (EVOLUTION_API_URL / EVOLUTION_API_KEY) — nunca do banco nem da tela. No banco ficam
// apenas instância, preferências, destinatários e o registro dos avisos.

const MAX_TENTATIVAS = 3;
const PAUSA_ENTRE_ENVIOS_MS = 2500;

export const erroHttp = (status, message) => Object.assign(new Error(message), { status });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/** URL e chave da Evolution, lidas do ambiente a cada uso (sem cache). */
function evolutionDoAmbiente() {
  const url = String(process.env.EVOLUTION_API_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.EVOLUTION_API_KEY || "").trim();
  const faltando = [];
  if (!/^https?:\/\/[^\s/]+/i.test(url)) faltando.push("EVOLUTION_API_URL");
  if (!apiKey) faltando.push("EVOLUTION_API_KEY");
  return { evolutionUrl: faltando.includes("EVOLUTION_API_URL") ? null : url, apiKey: apiKey || null, faltando };
}

async function registroConfig() {
  const [config] = await WhatsappConfig.findOrCreate({ where: { id: 1 }, defaults: { id: 1 } });
  return config;
}

async function lerConfig() {
  const c = await registroConfig();
  return { registro: c, ...c.get({ plain: true }), ...evolutionDoAmbiente() };
}

const configurado = (c) => Boolean(c.evolutionUrl && c.apiKey && c.instancia);

const mensagemNaoConfigurado = (c) =>
  c.faltando?.length
    ? `Defina ${c.faltando.join(" e ")} nas variáveis de ambiente do servidor (Render).`
    : "Informe o nome da instância na configuração dos avisos.";

/** Para a tela: nem a chave nem a URL completa da Evolution voltam — só se estão definidas. */
function configPublica(c) {
  let evolutionHost = null;
  try {
    evolutionHost = c.evolutionUrl ? new URL(c.evolutionUrl).host : null;
  } catch {
    evolutionHost = null;
  }
  return {
    ativo: c.ativo,
    instancia: c.instancia,
    evolutionConfigurada: c.faltando.length === 0,
    evolutionHost,
    variaveisFaltando: c.faltando,
    diasAntes: c.diasAntes,
    horaEnvio: c.horaEnvio,
    ultimaExecucao: c.ultimaExecucao,
    atualizadoPor: c.atualizadoPor,
    atualizadoEm: c.updatedAt,
  };
}

export async function salvarConfig(payload = {}, usuarioNome) {
  const atual = await lerConfig();
  const novo = {};

  if (payload.instancia !== undefined) {
    const instancia = String(payload.instancia || "").trim();
    if (instancia && !/^[\w.-]{1,60}$/.test(instancia)) throw erroHttp(400, "Nome da instância: use letras, números, ponto, hífen ou _.");
    novo.instancia = instancia || null;
  }
  if (payload.diasAntes !== undefined) {
    const dias = Number(payload.diasAntes);
    if (!Number.isInteger(dias) || dias < 0 || dias > 30) throw erroHttp(400, "Dias de antecedência: de 0 a 30.");
    novo.diasAntes = dias;
  }
  if (payload.horaEnvio !== undefined) {
    const hora = Number(payload.horaEnvio);
    if (!Number.isInteger(hora) || hora < 0 || hora > 23) throw erroHttp(400, "Horário de envio: de 0 a 23 h.");
    novo.horaEnvio = hora;
  }
  if (payload.ativo !== undefined) novo.ativo = Boolean(payload.ativo);

  const final = { ...atual, ...novo };
  if (final.ativo && !configurado(final)) {
    throw erroHttp(
      400,
      final.faltando.length
        ? `Defina ${final.faltando.join(" e ")} nas variáveis de ambiente do servidor antes de ligar os avisos.`
        : "Informe o nome da instância antes de ligar os avisos."
    );
  }

  await atual.registro.update({ ...novo, atualizadoPor: usuarioNome || null });
  return configPublica(await lerConfig());
}

// ---------------------------------------------------------------------------
// Evolution API
// ---------------------------------------------------------------------------

async function evolution(config, caminho, { method = "GET", body } = {}) {
  if (!configurado(config)) throw erroHttp(400, mensagemNaoConfigurado(config));
  let resposta;
  try {
    resposta = await fetch(`${config.evolutionUrl}${caminho}`, {
      method,
      headers: { apikey: config.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw erroHttp(502, `Não foi possível falar com a Evolution API: ${error.message}`);
  }
  const texto = await resposta.text();
  let dados = null;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = { message: texto };
  }
  if (!resposta.ok) {
    const bruto = dados?.response?.message ?? dados?.message ?? dados?.error ?? resposta.statusText;
    const detalhe = Array.isArray(bruto) ? bruto.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join("; ") : String(bruto);
    const semWhatsapp = /"exists":\s*false/.test(detalhe);
    const erro = erroHttp(
      resposta.status === 404 ? 404 : 502,
      resposta.status === 401 || resposta.status === 403
        ? "A Evolution API recusou a chave (apikey). Confira a configuração."
        : semWhatsapp
          ? "Este número não tem WhatsApp."
          : `Evolution API respondeu ${resposta.status}: ${detalhe}`
    );
    erro.httpStatus = resposta.status;
    erro.semWhatsapp = semWhatsapp;
    throw erro;
  }
  return dados;
}

const inst = (config) => encodeURIComponent(config.instancia);

async function estadoConexao(config) {
  const r = await evolution(config, `/instance/connectionState/${inst(config)}`);
  return r?.instance?.state || r?.state || "unknown";
}

async function obterConexao(config) {
  if (!configurado(config)) return { configurado: false, estado: null };
  try {
    return { configurado: true, estado: await estadoConexao(config) };
  } catch (error) {
    // Instância ainda não criada não é erro: ela é criada ao conectar.
    if (error.httpStatus === 404) return { configurado: true, estado: "inexistente" };
    return { configurado: true, estado: "erro", erro: error.message };
  }
}

/** QR Code para conectar o número; cria a instância na Evolution se ainda não existir. */
export async function conectar() {
  const config = await lerConfig();
  if (!configurado(config)) throw erroHttp(400, mensagemNaoConfigurado(config));
  const estado = await estadoConexao(config).catch((error) => {
    if (error.httpStatus === 404) return "inexistente";
    throw error;
  });
  if (estado === "open") return { estado, qrBase64: null, pairingCode: null };

  let r = null;
  if (estado === "inexistente") {
    r = await evolution(config, "/instance/create", {
      method: "POST",
      body: { instanceName: config.instancia, integration: "WHATSAPP-BAILEYS", qrcode: true },
    });
    r = r?.qrcode || r;
  }
  if (!r?.base64) r = await evolution(config, `/instance/connect/${inst(config)}`);

  const base64 = r?.base64 || null;
  return {
    estado: "connecting",
    qrBase64: base64 && !base64.startsWith("data:") ? `data:image/png;base64,${base64}` : base64,
    pairingCode: r?.pairingCode || null,
  };
}

/** Desconecta o número (logout na Evolution). Para usar outro número, conecte de novo. */
export async function desconectar() {
  const config = await lerConfig();
  await evolution(config, `/instance/logout/${inst(config)}`, { method: "DELETE" }).catch((error) => {
    // Já desconectado/inexistente: nada a fazer.
    if (error.httpStatus === 404 || error.httpStatus === 400) return null;
    throw error;
  });
  return obterConexao(config);
}

/** Número exato que o WhatsApp usa (com ou sem o 9º dígito). null = não tem WhatsApp. */
async function numeroNoWhatsapp(config, numero) {
  try {
    const r = await evolution(config, `/chat/whatsappNumbers/${inst(config)}`, { method: "POST", body: { numbers: [numero] } });
    const item = Array.isArray(r) ? r[0] : null;
    if (!item) return numero;
    if (item.exists === false) return null;
    return String(item.jid || item.number || numero).split("@")[0] || numero;
  } catch (error) {
    if (error.semWhatsapp) return null;
    return numero;
  }
}

const enviarTexto = (config, numero, texto) =>
  evolution(config, `/message/sendText/${inst(config)}`, { method: "POST", body: { number: numero, text: texto, delay: 1200 } });

export async function enviarTeste(telefone) {
  const numero = normalizarTelefone(telefone);
  if (!numero) throw erroHttp(400, "Celular inválido. Use DDD + número.");
  const config = await lerConfig();
  const destino = await numeroNoWhatsapp(config, numero);
  if (!destino) throw erroHttp(400, "Este número não tem WhatsApp.");
  await enviarTexto(config, destino, "✅ Teste da *Bedin Máquinas · Gestão de Contas*: os avisos de vencimento pelo WhatsApp estão funcionando.");
  return { enviado: true, numero: destino };
}

// ---------------------------------------------------------------------------
// Destinatários
// ---------------------------------------------------------------------------

const CAMPOS_BOOL = ["ativo", "avisarPagar", "avisarReceber", "avisoAntecipado", "avisoNoDia"];

function dadosDestinatario(body, parcial) {
  const dados = {};
  if (!parcial || body.nome !== undefined) {
    const nome = String(body.nome || "").trim();
    if (!nome) throw erroHttp(400, "Informe o nome de quem vai receber os avisos.");
    dados.nome = nome.slice(0, 120);
  }
  if (!parcial || body.telefone !== undefined) {
    const telefone = normalizarTelefone(body.telefone);
    if (!telefone) throw erroHttp(400, "Celular inválido. Use DDD + número, ex.: (11) 98765-4321.");
    dados.telefone = telefone;
  }
  for (const campo of CAMPOS_BOOL) if (body[campo] !== undefined) dados[campo] = Boolean(body[campo]);
  if ((dados.avisarPagar ?? true) === false && (dados.avisarReceber ?? false) === false && !parcial) {
    throw erroHttp(400, "Escolha ao menos um tipo de conta (a pagar ou a receber).");
  }
  return dados;
}

export const listarDestinatarios = () => WhatsappDestinatario.findAll({ order: [["nome", "ASC"]] });

export async function criarDestinatario(body) {
  const dados = dadosDestinatario(body, false);
  if (await WhatsappDestinatario.findOne({ where: { telefone: dados.telefone } })) throw erroHttp(409, "Este número já está cadastrado.");
  return WhatsappDestinatario.create(dados);
}

export async function atualizarDestinatario(id, body) {
  const destinatario = await WhatsappDestinatario.findByPk(id);
  if (!destinatario) throw erroHttp(404, "Destinatário não encontrado.");
  const dados = dadosDestinatario(body, true);
  if (dados.telefone && dados.telefone !== destinatario.telefone && (await WhatsappDestinatario.findOne({ where: { telefone: dados.telefone } }))) {
    throw erroHttp(409, "Este número já está cadastrado.");
  }
  return destinatario.update(dados);
}

export async function excluirDestinatario(id) {
  const n = await WhatsappDestinatario.destroy({ where: { id } });
  if (!n) throw erroHttp(404, "Destinatário não encontrado.");
  await WhatsappAviso.destroy({ where: { destinatarioId: id } });
}

// ---------------------------------------------------------------------------
// Envio dos avisos
// ---------------------------------------------------------------------------

/** Contas pendentes dentro da janela (hoje … hoje + diasAntes) e o que já foi avisado. */
async function carregarJanela(config, hoje) {
  const contas = await ContaFinanceira.findAll({
    where: { status: "PENDENTE", vencimento: { [Op.between]: [hoje, somarDias(hoje, config.diasAntes)] } },
    order: [["vencimento", "ASC"]],
  });
  const registros = contas.length ? await WhatsappAviso.findAll({ where: { contaId: contas.map((c) => c.id) } }) : [];
  const porChave = new Map(registros.map((r) => [chaveAviso(r.contaId, r.destinatarioId, r.tipoAviso, r.vencimento), r]));
  return { contas: contas.map((c) => c.get({ plain: true })), porChave };
}

/** Prévia do que sairia agora (sem enviar), por destinatário. */
export async function previa() {
  const config = await lerConfig();
  const hoje = hojeBrasil();
  const { contas, porChave } = await carregarJanela(config, hoje);
  const enviados = new Set([...porChave].filter(([, r]) => r.status === "ENVIADO").map(([k]) => k));
  const destinatarios = await WhatsappDestinatario.findAll({ where: { ativo: true }, order: [["nome", "ASC"]] });
  return destinatarios.map((d) => ({
    destinatario: { id: d.id, nome: d.nome },
    contas: avisosPendentes({ contas, destinatario: d, bloqueados: enviados, hoje, diasAntes: config.diasAntes }).map((i) => ({
      id: i.conta.id,
      descricao: i.conta.descricao,
      tipo: i.conta.tipo,
      valor: i.conta.valor,
      vencimento: i.conta.vencimento,
      tipoAviso: i.tipoAviso,
    })),
  }));
}

async function registrar(itens, destinatarioId, status, erro) {
  for (const { conta, tipoAviso } of itens) {
    const where = { contaId: conta.id, destinatarioId, tipoAviso, vencimento: conta.vencimento };
    const [registro] = await WhatsappAviso.findOrCreate({ where, defaults: { ...where, status, tentativas: 0 } });
    await registro.update({
      status,
      tentativas: registro.tentativas + 1,
      erro: erro ? String(erro).slice(0, 500) : null,
      enviadoEm: status === "ENVIADO" ? new Date() : registro.enviadoEm,
    });
  }
}

let rodando = false;

/**
 * Manda os avisos do dia. Automático (job): só com os avisos ligados e a partir do horário
 * configurado. `manual` (botão "Enviar agora"): ignora horário/ligado e tenta de novo
 * os que falharam. Um destinatário recebe uma única mensagem com todas as contas dele.
 */
export async function processarAvisos({ manual = false } = {}) {
  if (rodando) return { ignorado: "Já existe um envio em andamento." };
  rodando = true;
  const config = await lerConfig().catch(() => null);
  try {
    if (!config) return { ignorado: "Configuração indisponível." };
    if (!manual) {
      if (!config.ativo) return { ignorado: "Avisos desligados." };
      if (horaBrasil() < config.horaEnvio) return { ignorado: "Antes do horário de envio." };
    }
    if (!configurado(config)) throw erroHttp(400, mensagemNaoConfigurado(config));
    const conexao = await obterConexao(config);
    if (conexao.estado !== "open") {
      throw erroHttp(409, conexao.estado === "erro" ? conexao.erro : "O WhatsApp não está conectado. Conecte o número pelo QR Code.");
    }

    const hoje = hojeBrasil();
    const { contas, porChave } = await carregarJanela(config, hoje);
    // Bloqueia o que já foi enviado e o que já falhou demais (no automático).
    const bloqueados = new Set(
      [...porChave].filter(([, r]) => r.status === "ENVIADO" || (!manual && r.tentativas >= MAX_TENTATIVAS)).map(([k]) => k)
    );
    const destinatarios = await WhatsappDestinatario.findAll({ where: { ativo: true } });

    const resultado = { mensagens: 0, contasAvisadas: 0, falhas: [] };
    for (const destinatario of destinatarios) {
      const itens = avisosPendentes({ contas, destinatario, bloqueados, hoje, diasAntes: config.diasAntes });
      if (!itens.length) continue;
      try {
        const numero = await numeroNoWhatsapp(config, destinatario.telefone);
        if (!numero) throw erroHttp(400, "Este número não tem WhatsApp.");
        await enviarTexto(config, numero, montarMensagem({ nome: destinatario.nome, itens, hoje }));
        await registrar(itens, destinatario.id, "ENVIADO");
        resultado.mensagens += 1;
        resultado.contasAvisadas += itens.length;
      } catch (error) {
        await registrar(itens, destinatario.id, "ERRO", error.message);
        resultado.falhas.push({ destinatario: destinatario.nome, erro: error.message });
      }
      await esperar(PAUSA_ENTRE_ENVIOS_MS);
    }
    await config.registro.update({ ultimaExecucao: { em: new Date().toISOString(), manual, ...resultado } });
    return resultado;
  } catch (error) {
    if (config?.registro) {
      await config.registro.update({ ultimaExecucao: { em: new Date().toISOString(), manual, erro: error.message } }).catch(() => {});
    }
    throw error;
  } finally {
    rodando = false;
  }
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export async function obterStatus() {
  const config = await lerConfig();
  const [conexao, destinatarios, historico] = await Promise.all([
    obterConexao(config),
    listarDestinatarios(),
    WhatsappAviso.findAll({
      include: [
        { association: "conta", attributes: ["id", "descricao", "tipo", "valor", "vencimento"] },
        { association: "destinatario", attributes: ["id", "nome"] },
      ],
      order: [["updatedAt", "DESC"]],
      limit: 40,
    }),
  ]);
  return { config: configPublica(config), conexao, destinatarios, historico };
}
