import RegistroDinheiro from "../models/RegistroDinheiro.js";
import { Op, col, cast, where as sequelizeWhere } from "sequelize";
import { sequelize } from "../database/connection.js";
import {
  GastoVariavel,
  MovimentacaoProduto,
  Movimentacao,
  Maquina,
  Produto,
  Loja,
  MachinePayColetaPendente,
} from "../models/index.js";
import {
  consultarFechamentoMachinePay,
  fecharFechamentoMachinePay,
  calcularTotalRecebidoMachinePay,
} from "../services/machinePayService.js";

// Trazido da AgarraMais: botão "Registrar dinheiro" da tela de Movimentações.
// Registra o dinheiro/cartão de uma máquina (ou o total da loja) e, por máquina,
// FECHA o período na Machine Pay (como na AgarraMais).
//
// Diferenças do original: o Bedin não usa CompactPay, não tem "lojas de teste" nem
// cadastro de gastos fixos por loja (gasto fixo do período fica 0).

const inicioDoDia = (data) => new Date(data.getFullYear(), data.getMonth(), data.getDate(), 0, 0, 0, 0);
const fimDoDia = (data) => new Date(data.getFullYear(), data.getMonth(), data.getDate(), 23, 59, 59, 999);

const normalizarValorMonetario = (valor) => {
  if (valor === null || valor === undefined || valor === "") return 0;
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : 0;

  const valorNormalizado = String(valor)
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");

  const numero = Number(valorNormalizado);
  return Number.isFinite(numero) ? numero : 0;
};

const calcularGastoVariavelPeriodo = async (lojaId, inicio, fim) => {
  const total = await GastoVariavel.sum("valor", {
    where: {
      [Op.and]: [sequelizeWhere(cast(col("lojaId"), "text"), String(lojaId))],
      dataInicio: { [Op.lte]: fim },
      dataFim: { [Op.gte]: inicio },
    },
  });

  return Number(total || 0);
};

const calcularGastoProdutosSaidaPeriodo = async (lojaId, inicio, fim) => {
  const itensVendidos = await MovimentacaoProduto.findAll({
    attributes: ["quantidadeSaiu"],
    include: [
      { model: Produto, as: "produto", attributes: ["custoUnitario", "preco"] },
      {
        model: Movimentacao,
        attributes: [],
        required: true,
        where: { dataColeta: { [Op.between]: [inicio, fim] } },
        include: [{ model: Maquina, as: "maquina", attributes: [], required: true, where: { lojaId } }],
      },
    ],
    raw: true,
    nest: true,
  });

  const custoTotal = itensVendidos.reduce((acc, item) => {
    const qtd = Number(item.quantidadeSaiu || 0);
    if (qtd <= 0) return acc;
    const custoUnitario = Number(item.produto?.custoUnitario || 0);
    const precoFallback = Number(item.produto?.preco || 0);
    return acc + qtd * (custoUnitario > 0 ? custoUnitario : precoFallback);
  }, 0);

  return Number(custoTotal.toFixed(2));
};

const calcularGastosPeriodo = async (lojaId, inicio, fim) => {
  const [gastoVariavelPeriodo, gastoProdutosPeriodo] = await Promise.all([
    calcularGastoVariavelPeriodo(lojaId, inicio, fim),
    calcularGastoProdutosSaidaPeriodo(lojaId, inicio, fim),
  ]);
  const gastoFixoPeriodo = 0; // Bedin não tem cadastro de gastos fixos por loja

  return {
    gastoFixoPeriodo,
    gastoVariavelPeriodo,
    gastoProdutosPeriodo,
    gastoTotalPeriodo: Number((gastoFixoPeriodo + gastoVariavelPeriodo + gastoProdutosPeriodo).toFixed(2)),
  };
};

// O fechamento (fecharFechamentoMachinePay) zera o extrato da máquina na Machine Pay
// para o período. Se a máquina tem "desconto automático", esse extrato é usado depois
// pela sugestão de Total Pré — então o que seria perdido é somado em
// MachinePayColetaPendente ANTES de fechar (apagado na próxima movimentação).
const preservarTransacoesPendentesMachinePay = async ({ maquina, fim }) => {
  const valorDesconto = Number(maquina.valorDescontoMachinePay || 0);
  if (!maquina.descontoAutomaticoMachinePay || valorDesconto <= 0) return;

  const [ultimaMov, pendenteExistente] = await Promise.all([
    Movimentacao.findOne({ where: { maquinaId: maquina.id }, order: [["dataColeta", "DESC"]] }),
    MachinePayColetaPendente.findOne({ where: { maquinaId: maquina.id } }),
  ]);

  const inicioJanela = pendenteExistente?.dataReferencia
    ? new Date(pendenteExistente.dataReferencia)
    : ultimaMov?.dataColeta
      ? new Date(ultimaMov.dataColeta)
      : null;

  if (!inicioJanela) return;

  const fimJanela = new Date(fim);
  if (fimJanela <= inicioJanela) return;

  const totalJanela = await calcularTotalRecebidoMachinePay({
    posId: maquina.machinePayPosId,
    inicio: inicioJanela,
    fim: fimJanela,
  });

  const totalAcumulado = Number((Number(pendenteExistente?.totalAcumulado || 0) + totalJanela).toFixed(2));

  if (pendenteExistente) {
    await pendenteExistente.update({ totalAcumulado, dataReferencia: fimJanela });
  } else {
    await MachinePayColetaPendente.create({ maquinaId: maquina.id, totalAcumulado, dataReferencia: fimJanela });
  }
};

const round2 = (valor) => Number(Number(valor || 0).toFixed(2));

// Recebido na Machine Pay no período, no formato que a tela espera (mesmos campos
// da AgarraMais; os de CompactPay vêm zerados).
const consultarPagamentosMaquina = async (maquina, inicio, fim) => {
  const posId = maquina.machinePayPosId?.trim();
  if (!posId) throw new Error("Máquina sem ID da Machine Pay.");

  const mp = await consultarFechamentoMachinePay({ posId, inicio, fim });
  const bruto = round2(mp.brutoComTaxasMp);

  return {
    fonte: "machinePay",
    machinePayPosId: posId,
    compactPayId: null,
    pix: round2(mp.pix),
    debito: round2(mp.debito),
    credito: round2(mp.credito),
    cartao: round2(mp.cartao),
    app: 0,
    brutoComTaxasMp: bruto,
    cartaoPix: bruto,
    taxas: round2(mp.taxas),
    liquido: round2(mp.liquido),
    percentualTaxaMedia: Number(mp.percentualTaxaMedia || 0),
    fisico: 0,
    valorFaturamento: bruto,
    valorMachinePay: bruto,
    valorCompactPay: 0,
    machinePay: mp,
    compactPay: null,
    erros: [],
  };
};

const registroDinheiroController = {
  // GET /registro-dinheiro/machine-pay?maquinaId&inicio&fim
  async consultarMachinePay(req, res) {
    try {
      const { maquinaId, inicio, fim } = req.query;

      if (!maquinaId || !inicio || !fim) {
        return res.status(400).json({ error: "Informe máquina, início e fim para consultar a Machine Pay." });
      }

      const maquina = await Maquina.findByPk(maquinaId, { attributes: ["id", "codigo", "nome", "machinePayPosId"] });
      if (!maquina) {
        return res.status(404).json({ error: "Máquina não encontrada." });
      }
      if (!maquina.machinePayPosId) {
        return res.status(400).json({ error: "Esta máquina ainda não possui ID da Machine Pay cadastrado." });
      }

      const dados = await consultarPagamentosMaquina(maquina, inicio, fim);
      return res.json({ maquinaId: maquina.id, inicio, fim, ...dados });
    } catch (err) {
      console.error("[MachinePay] Erro ao consultar fechamento:", err);
      return res.status(502).json({ error: "Não foi possível consultar a Machine Pay.", details: err.message });
    }
  },

  // GET /registro-dinheiro/machine-pay-total?inicio&fim
  async consultarMachinePayTotal(req, res) {
    try {
      const { inicio, fim } = req.query;
      if (!inicio || !fim) {
        return res.status(400).json({ error: "Informe início e fim para consultar o total da Machine Pay." });
      }
      if (Number.isNaN(new Date(inicio).getTime()) || Number.isNaN(new Date(fim).getTime())) {
        return res.status(400).json({ error: "Período inválido para consultar o total da Machine Pay." });
      }

      const maquinas = await Maquina.findAll({
        where: { ativo: true, machinePayPosId: { [Op.ne]: null } },
        attributes: ["id", "machinePayPosId", "nome", "codigo", "valorFicha", "lojaId"],
        include: [{ model: Loja, as: "loja", attributes: ["id", "nome"] }],
      });

      const resultados = await Promise.all(
        maquinas.map(async (maquina) => {
          try {
            const dados = await consultarPagamentosMaquina(maquina, inicio, fim);
            return {
              maquinaId: maquina.id,
              nome: maquina.nome,
              codigo: maquina.codigo,
              valorFicha: Number(maquina.valorFicha || 0),
              lojaId: maquina.lojaId,
              loja: maquina.loja?.nome || null,
              ...dados,
            };
          } catch (err) {
            console.error(`[PagamentosDigitais] Erro ao consultar máquina ${maquina.id}:`, err.message);
            return null;
          }
        })
      );

      const maquinasComDados = resultados.filter(Boolean);
      const somar = (campo) => round2(maquinasComDados.reduce((acc, item) => acc + Number(item[campo] || 0), 0));

      return res.json({
        totalBrutoComTaxasMp: somar("valorFaturamento"),
        totalPix: somar("pix"),
        totalCartao: somar("cartao"),
        totalLiquido: somar("liquido"),
        totalMachinePay: somar("valorMachinePay"),
        totalCompactPay: 0,
        totalFisicoCompactPay: 0,
        totalAppCompactPay: 0,
        maquinaCount: maquinasComDados.length,
        maquinaCountMachinePay: maquinasComDados.length,
        maquinaCountCompactPay: 0,
        maquinas: maquinasComDados,
      });
    } catch (err) {
      console.error("[MachinePay] Erro ao consultar total Machine Pay:", err);
      return res.status(502).json({ error: "Não foi possível consultar o total da Machine Pay.", details: err.message });
    }
  },

  // POST /registro-dinheiro
  async criar(req, res) {
    try {
      const {
        loja,
        maquina,
        registrarTotalLoja,
        inicio,
        fim,
        valorDinheiro,
        valorCartaoPix,
        percentualTaxaCartaoMedia,
        observacoes,
        gastosVariaveis = [],
      } = req.body;

      const ehRegistroTotalLoja = !!registrarTotalLoja;

      if (!loja || !inicio || !fim) {
        return res.status(400).json({ error: "Campos obrigatórios ausentes: loja, início e fim." });
      }

      const inicioPeriodo = new Date(inicio);
      const fimPeriodo = new Date(fim);

      if (Number.isNaN(inicioPeriodo.getTime()) || Number.isNaN(fimPeriodo.getTime())) {
        return res.status(400).json({ error: "Período inválido." });
      }
      if (fimPeriodo < inicioPeriodo) {
        return res.status(400).json({ error: "Data fim não pode ser menor que data início." });
      }
      if (!Array.isArray(gastosVariaveis)) {
        return res.status(400).json({ error: "gastosVariaveis deve ser um array." });
      }

      const gastosVariaveisNormalizados = gastosVariaveis
        .map((item) => ({
          nome: String(item?.nome || "").trim(),
          valor: normalizarValorMonetario(item?.valor),
          observacao: item?.observacao ? String(item.observacao).trim() : null,
        }))
        .filter((item) => item.nome.length > 0);

      const totalGastosVariaveisNovos = ehRegistroTotalLoja
        ? gastosVariaveisNormalizados.reduce((acc, item) => acc + Number(item.valor || 0), 0)
        : 0;

      const gastosPeriodo = ehRegistroTotalLoja
        ? await calcularGastosPeriodo(loja, inicioDoDia(inicioPeriodo), fimDoDia(fimPeriodo))
        : { gastoFixoPeriodo: 0, gastoVariavelPeriodo: 0, gastoProdutosPeriodo: 0, gastoTotalPeriodo: 0 };

      const gastoVariavelPeriodoFinal = Number((gastosPeriodo.gastoVariavelPeriodo + totalGastosVariaveisNovos).toFixed(2));
      const gastoTotalPeriodoFinal = Number(
        (gastosPeriodo.gastoFixoPeriodo + gastoVariavelPeriodoFinal + gastosPeriodo.gastoProdutosPeriodo).toFixed(2)
      );

      const valorCartaoPixNumero = normalizarValorMonetario(valorCartaoPix);
      const percentualTaxaCartaoMediaNumero = Math.max(normalizarValorMonetario(percentualTaxaCartaoMedia), 0);
      const taxaDeCartao = Number((valorCartaoPixNumero * (Math.min(percentualTaxaCartaoMediaNumero, 100) / 100)).toFixed(2));
      const valorCartaoPixLiquidoNumero = Number(Math.max(valorCartaoPixNumero - taxaDeCartao, 0).toFixed(2));

      const dadosRegistro = {
        lojaId: loja,
        maquinaId: ehRegistroTotalLoja ? null : maquina || null,
        registrarTotalLoja: ehRegistroTotalLoja,
        inicio,
        fim,
        valorDinheiro: normalizarValorMonetario(valorDinheiro),
        valorCartaoPix: valorCartaoPixNumero,
        valorCartaoPixLiquido: valorCartaoPixLiquidoNumero,
        taxaDeCartao,
        percentualTaxaCartaoMedia: percentualTaxaCartaoMediaNumero,
        gastoFixoPeriodo: ehRegistroTotalLoja ? gastosPeriodo.gastoFixoPeriodo : 0,
        gastoVariavelPeriodo: ehRegistroTotalLoja ? gastoVariavelPeriodoFinal : 0,
        gastoProdutosPeriodo: ehRegistroTotalLoja ? gastosPeriodo.gastoProdutosPeriodo : 0,
        gastoTotalPeriodo: ehRegistroTotalLoja ? gastoTotalPeriodoFinal : 0,
        observacoes,
      };

      // Proteção contra clique duplo / reenvio: recusa registro idêntico criado há pouco.
      const registroDuplicado = await RegistroDinheiro.findOne({
        where: {
          lojaId: dadosRegistro.lojaId,
          maquinaId: dadosRegistro.maquinaId,
          registrarTotalLoja: dadosRegistro.registrarTotalLoja,
          inicio: inicioPeriodo,
          fim: fimPeriodo,
          valorDinheiro: dadosRegistro.valorDinheiro,
          valorCartaoPix: dadosRegistro.valorCartaoPix,
          createdAt: { [Op.gte]: new Date(Date.now() - 2 * 60 * 1000) },
        },
      });

      if (registroDuplicado) {
        return res.status(409).json({ error: "Esse registro já foi salvo agora há pouco (possível clique duplo)." });
      }

      const transaction = await sequelize.transaction();

      try {
        const registro = await RegistroDinheiro.create(dadosRegistro, { transaction });

        if (ehRegistroTotalLoja && gastosVariaveisNormalizados.length > 0) {
          await GastoVariavel.bulkCreate(
            gastosVariaveisNormalizados.map((item) => ({
              lojaId: loja,
              nome: item.nome,
              valor: item.valor,
              observacao: item.observacao,
              dataInicio: inicio,
              dataFim: fim,
              registroDinheiroId: registro.id,
              usuarioId: req.usuario?.id || null,
            })),
            { transaction }
          );
        }

        await transaction.commit();

        let fechamentoMachinePay = { executado: false, concluido: false, erro: null };
        const fechamentoCompactPay = { executado: false, concluido: false, jaExistia: false, erro: null };

        if (!ehRegistroTotalLoja && maquina) {
          try {
            const maquinaFechamento = await Maquina.findByPk(maquina, {
              attributes: ["id", "machinePayPosId", "descontoAutomaticoMachinePay", "valorDescontoMachinePay"],
            });

            if (maquinaFechamento?.machinePayPosId) {
              try {
                await preservarTransacoesPendentesMachinePay({ maquina: maquinaFechamento, fim });
              } catch (preservarError) {
                // Sem preservar o que seria perdido, não fecha agora: melhor deixar o
                // extrato acumular na Machine Pay do que zerar e perder a contagem.
                console.error("[MachinePay] Erro ao preservar transações pendentes antes do fechamento:", preservarError);
                throw new Error(
                  "Não foi possível preservar as transações da Machine Pay antes do fechamento; fechamento não executado."
                );
              }

              const resultadoFechamento = await fecharFechamentoMachinePay({
                posId: maquinaFechamento.machinePayPosId,
                inicio,
                fim,
                valor: dadosRegistro.valorDinheiro,
              });

              fechamentoMachinePay = { executado: true, concluido: resultadoFechamento.concluido, erro: null };
            }
          } catch (machinePayError) {
            console.error("[MachinePay] Erro ao executar fechamento:", machinePayError);
            fechamentoMachinePay = { executado: true, concluido: false, erro: machinePayError.message };
          }
        }

        return res.status(201).json({ ...registro.toJSON(), fechamentoMachinePay, fechamentoCompactPay });
      } catch (dbError) {
        await transaction.rollback();
        throw dbError;
      }
    } catch (err) {
      console.error("[RegistrarDinheiro] Erro inesperado:", err);
      return res.status(500).json({ error: "Erro ao registrar dinheiro", details: err.message });
    }
  },

  // GET /registro-dinheiro
  async listar(req, res) {
    try {
      const registros = await RegistroDinheiro.findAll({ order: [["createdAt", "DESC"]] });
      return res.json(registros);
    } catch (err) {
      return res.status(500).json({ error: "Erro ao buscar registros", details: err.message });
    }
  },
};

export default registroDinheiroController;
