import crypto from "crypto";

// Cofre de credenciais (mesmo desenho da GiraKids): AES-256-GCM com a chave vinda do
// ambiente (CREDENCIAIS_SECRET, ou derivada do JWT_SECRET). Quem só tiver acesso ao
// banco não consegue ler nem forjar a credencial; a API nunca devolve o valor em texto.

const VERSAO = "v1";

const chave = () => {
  const base = process.env.CREDENCIAIS_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error("Defina CREDENCIAIS_SECRET (ou JWT_SECRET) no ambiente do backend.");
  return crypto.createHash("sha256").update(`bedin-credenciais:${base}`).digest();
};

export const cifrarCredenciais = (provedor, dados) => {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv("aes-256-gcm", chave(), iv);
  cifra.setAAD(Buffer.from(`${VERSAO}:${provedor}`));
  const conteudo = Buffer.concat([cifra.update(JSON.stringify(dados), "utf8"), cifra.final()]);
  return [VERSAO, iv.toString("base64url"), cifra.getAuthTag().toString("base64url"), conteudo.toString("base64url")].join(".");
};

export const decifrarCredenciais = (provedor, valor) => {
  const [versao, iv, tag, conteudo] = String(valor || "").split(".");
  if (versao !== VERSAO) throw new Error("Formato de credencial desconhecido.");
  const decifra = crypto.createDecipheriv("aes-256-gcm", chave(), Buffer.from(iv, "base64url"));
  decifra.setAAD(Buffer.from(`${VERSAO}:${provedor}`));
  decifra.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decifra.update(Buffer.from(conteudo, "base64url")), decifra.final()]).toString("utf8"));
};
