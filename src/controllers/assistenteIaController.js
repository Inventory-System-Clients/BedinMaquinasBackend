// Trazido da AgarraMais: só a leitura dos contadores IN/OUT por foto (tela de
// Movimentações). O "comando de voz" do assistente IAgarra não veio.
// Precisa de OPENAI_API_KEY (e opcionalmente OPENAI_MODEL) no ambiente.

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELO_PADRAO = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const extrairTextoResposta = (resposta) => {
  if (typeof resposta?.output_text === "string") return resposta.output_text;

  const textos = [];
  for (const item of resposta?.output || []) {
    for (const conteudo of item?.content || []) {
      if (conteudo?.type === "output_text" && conteudo?.text) {
        textos.push(conteudo.text);
      }
    }
  }

  return textos.join("\n").trim();
};

const schemaLeituraContadores = {
  type: "object",
  additionalProperties: false,
  required: ["contadorIn", "contadorOut", "confianca", "observacao"],
  properties: {
    contadorIn: { type: ["integer", "null"] },
    contadorOut: { type: ["integer", "null"] },
    confianca: {
      type: "string",
      enum: ["alta", "media", "baixa"],
    },
    observacao: { type: "string" },
  },
};

const chamarOpenAIParaLerContadores = async ({ imagemBase64, mimeType }) => {
  if (!process.env.OPENAI_API_KEY) {
    const erro = new Error("OPENAI_API_KEY nao configurada no backend");
    erro.status = 500;
    throw erro;
  }

  const dataUrl = `data:${mimeType};base64,${imagemBase64}`;
  const resposta = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO_PADRAO,
      instructions: [
        "Voce le fotos de dois contadores mecanicos numericos de maquina.",
        "Retorne apenas JSON conforme o schema.",
        "Leia somente os numeros brancos dentro das janelas pretas dos contadores mecanicos.",
        "Ignore voltimetro, regua, parafusos, cabos, madeira, etiquetas e qualquer outro numero fora dos contadores.",
        "Normalmente existem dois contadores. O maior numero sempre e contadorIn. O menor numero sempre e contadorOut.",
        "Se nao conseguir ler os dois com seguranca, retorne contadorIn null, contadorOut null e confianca baixa.",
        "Nao chute. Prefira null se estiver em duvida.",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Leia os dois contadores mecanicos da foto. O maior numero e IN e o menor e OUT.",
            },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "leitura_contadores",
          strict: true,
          schema: schemaLeituraContadores,
        },
      },
      max_output_tokens: 300,
    }),
    signal: AbortSignal.timeout(60000),
  });

  const payload = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const erro = new Error(payload?.error?.message || "Falha ao ler contadores com OpenAI");
    erro.status = resposta.status;
    throw erro;
  }

  const textoJson = extrairTextoResposta(payload);
  if (!textoJson) {
    const erro = new Error("OpenAI nao retornou uma leitura valida");
    erro.status = 502;
    throw erro;
  }

  return JSON.parse(textoJson);
};

// POST /assistente-ia/ler-contadores { imagemBase64, mimeType }
export const lerContadoresPorImagem = async (req, res) => {
  try {
    const imagemBase64 = String(req.body?.imagemBase64 || "")
      .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
      .trim();
    const mimeType = String(req.body?.mimeType || "image/jpeg").trim();

    if (!imagemBase64) {
      return res.status(400).json({ error: "imagemBase64 e obrigatoria" });
    }

    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(mimeType)) {
      return res.status(400).json({ error: "Formato de imagem invalido. Use JPEG, PNG ou WEBP." });
    }

    const tamanhoEstimadoBytes = Math.ceil((imagemBase64.length * 3) / 4);
    if (tamanhoEstimadoBytes > 5 * 1024 * 1024) {
      return res.status(413).json({ error: "Imagem muito grande. Envie uma foto com ate 5MB." });
    }

    const leitura = await chamarOpenAIParaLerContadores({ imagemBase64, mimeType });

    return res.json({
      contadorIn: typeof leitura.contadorIn === "number" ? leitura.contadorIn : null,
      contadorOut: typeof leitura.contadorOut === "number" ? leitura.contadorOut : null,
      confianca: leitura.confianca || "baixa",
      observacao: leitura.observacao || "",
    });
  } catch (error) {
    console.error("Erro ao ler contadores por imagem:", error);
    return res.status(error.status || 500).json({
      error: "Erro ao ler contadores por imagem",
      message: error.message,
    });
  }
};
