import {
  Movimentacao,
  MovimentacaoProduto,
  Maquina,
  Usuario,
  Produto,
  EstoqueLoja,
  Loja,
  RoteiroLoja,
  Roteiro,
  CarrinhoUsuario,
  ContaFinanceira,
  sequelize,
} from "../models/index.js";
import { Op } from "sequelize";
import {
  calcularBloqueioAtivoReal,
  limparEstadoLockLoja,
} from "../utils/roteiroLockRules.js";

// US08, US09, US10 - Registrar movimentação completa
export const registrarMovimentacao = async (req, res) => {
  let lockTransaction = null;

  try {
    const {
      maquinaId,
      dataColeta,
      totalPre: totalPreBody,
      abastecidas,
      fichas,
      contadorMaquina,
      contadorIn,
      contadorOut,
      observacoes,
      tipoOcorrencia,
      retiradaEstoque,
      produtos, // Array de { produtoId, quantidadeSaiu, quantidadeAbastecida }
      quantidade_notas_entrada,
      valor_entrada_maquininha_pix,
      // NOVOS CAMPOS DE VALORES DE ENTRADA
      valorEntradaFichas,
      valorEntradaNotas,
      // valorEntradaCartao NÃO vem mais do body: é calculado automaticamente
      // via Machine Pay logo abaixo (ver busca de "valor digital automático")
      roteiroId,
      // numeroSacola NÃO vem mais do body: é gerado automaticamente
      // como "Sacola - {nome da máquina}" logo abaixo
      // Só é usado quando esta é a primeira movimentação da máquina (sem
      // movimentação anterior para calcular o período automaticamente)
      machinePayDataInicio,
      // Tela de Movimentações (padrão AgarraMais): "automatico" | "manual"
      origemTotalPre,
      // Tela de Movimentações simplificada: ninguém conta o que tem dentro da
      // máquina. O totalPre sai do contador OUT (prêmios que saíram desde a
      // última movimentação) e o operador só informa o que abasteceu.
      modoSimples,
      // [{ descricao, valor }] — cada um vira conta a pagar já paga na Gestão de Contas.
      gastosExtras,
    } = req.body;

    // Validações
    if (!maquinaId || (!modoSimples && totalPreBody === undefined) || abastecidas === undefined) {
      return res.status(400).json({
        error: "maquinaId, totalPre e abastecidas são obrigatórios",
      });
    }

    const gastosExtrasNormalizados = [];
    if (gastosExtras !== undefined && gastosExtras !== null) {
      if (!Array.isArray(gastosExtras)) {
        return res.status(400).json({ error: "gastosExtras deve ser uma lista" });
      }
      for (const gasto of gastosExtras) {
        const descricao = String(gasto?.descricao || "").trim();
        const valor = Math.round(Number(gasto?.valor) * 100) / 100;
        if (!descricao && !(valor > 0)) continue; // linha em branco
        if (!descricao || !(valor > 0)) {
          return res.status(400).json({
            error: "Cada gasto extra precisa de descrição e de um valor maior que zero.",
          });
        }
        gastosExtrasNormalizados.push({ descricao: descricao.slice(0, 200), valor });
      }
    }
    const valorGastosExtras = gastosExtrasNormalizados.length
      ? Math.round(gastosExtrasNormalizados.reduce((s, g) => s + g.valor, 0) * 100) / 100
      : null;

    // Buscar última movimentação para calcular saída (sairam)
    const ultimaMov = await Movimentacao.findOne({
      where: { maquinaId },
      order: [["dataColeta", "DESC"]],
    });

    let totalPre = totalPreBody;
    if (modoSimples) {
      const outAtual = parseInt(contadorOut);
      const outAnterior = ultimaMov?.contadorOut;
      const saidaPeloContador =
        Number.isFinite(outAtual) && typeof outAnterior === "number" && outAtual >= outAnterior
          ? outAtual - outAnterior
          : 0;
      totalPre = ultimaMov && typeof ultimaMov.totalPos === "number"
        ? Math.max(0, ultimaMov.totalPos - saidaPeloContador)
        : 0;
    }

    let saidaRecalculada = 0;
    if (ultimaMov && typeof ultimaMov.totalPos === "number") {
      saidaRecalculada = Math.max(0, ultimaMov.totalPos - totalPre);
    }

    const produtosNormalizados = Array.isArray(produtos)
      ? produtos
          .filter((p) => p && p.produtoId)
          .map((p) => ({
            produtoId: p.produtoId,
            quantidadeSaiu: Math.max(0, parseInt(p.quantidadeSaiu) || 0),
            quantidadeAbastecida: Math.max(
              0,
              parseInt(p.quantidadeAbastecida) || 0,
            ),
            retiradaProduto: Math.max(0, parseInt(p.retiradaProduto) || 0),
          }))
      : [];

    // Retirada sem venda (tela de Movimentações, padrão AgarraMais). Só quando a tela
    // manda o campo: aí totalPos = totalPre + abastecidas - retirada (ver hook do
    // model). O fluxo de roteiros não manda e segue a regra antiga (null).
    const veioRetiradaProduto =
      Array.isArray(produtos) && produtos.some((p) => p && p.retiradaProduto !== undefined);
    const retiradaProdutoTotal = veioRetiradaProduto
      ? produtosNormalizados.reduce((soma, p) => soma + p.retiradaProduto, 0)
      : null;

    // Com 1 único produto, a saída detalhada deve refletir exatamente a saída da movimentação.
    if (produtosNormalizados.length === 1) {
      produtosNormalizados[0].quantidadeSaiu = saidaRecalculada;
    }

    const totalProdutosSairamDetalhado = produtosNormalizados.reduce(
      (sum, p) => sum + p.quantidadeSaiu,
      0,
    );

    if (saidaRecalculada > 0 && produtosNormalizados.length === 0) {
      return res.status(400).json({
        error:
          "Esta movimentação possui saídas e precisa informar pelo menos um produto no detalhamento.",
      });
    }

    if (
      produtosNormalizados.length > 0 &&
      totalProdutosSairamDetalhado !== saidaRecalculada
    ) {
      return res.status(400).json({
        error:
          "A soma de quantidadeSaiu dos produtos deve ser igual ao total de saídas da movimentação.",
        detalhes: {
          sairamMovimentacao: saidaRecalculada,
          somaDetalhamentoProdutos: totalProdutosSairamDetalhado,
        },
      });
    }

    // O lançamento manual por ponto (tela Financeiro antiga) saiu: os valores vêm da
    // própria movimentação / Registrar Dinheiro, então a coleta já nasce concluída.
    const statusFinanceiro = "concluido";

    // Buscar máquina para pegar valorFicha
    const maquina = await Maquina.findByPk(maquinaId);
    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    const dataColetaFinal = dataColeta || new Date();

    // Sacola: identificação automática, não editável pelo usuário
    const numeroSacola = `Sacola - ${maquina.nome || maquina.codigo}`;

    // Valor digital (cartão/PIX): buscado automaticamente da Machine Pay,
    // cobrindo o período desde a última movimentação desta máquina até agora.
    // Nunca é digitado manualmente. Best-effort: se a máquina não tiver
    // integração ou a consulta falhar, fica null (não bloqueia a movimentação).
    //
    // Se não houver movimentação anterior (primeira coleta desta máquina),
    // não há um período de referência automático — nesse caso o início do
    // período precisa vir explicitamente em `machinePayDataInicio` (o
    // frontend deve perguntar essa data ao usuário quando
    // `machinePayPrecisaDataInicio` vier true em GET /maquinas/:id/estoque-atual).
    // A tela de Movimentações deixa o operador trocar o início do período (ex.:
    // máquina sem movimentação anterior, ou período diferente): quando vem
    // `machinePayDataInicio`, ele vale; senão, a data da última movimentação.
    let valorEntradaCartao = null;
    const inicioManualValido =
      machinePayDataInicio && !Number.isNaN(new Date(machinePayDataInicio).getTime())
        ? new Date(machinePayDataInicio)
        : null;
    const inicioConsultaDigital =
      inicioManualValido || (ultimaMov ? ultimaMov.dataColeta : null);

    console.log("[MachinePay] Verificando busca automática do valor digital:", {
      maquinaId,
      machinePayPosId: maquina.machinePayPosId || "(não configurado)",
      temMovimentacaoAnterior: Boolean(ultimaMov),
      machinePayDataInicio: machinePayDataInicio || null,
      inicioConsultaDigital,
      fim: dataColetaFinal,
    });

    if (!maquina.machinePayPosId) {
      console.log(
        "[MachinePay] Pulando busca: máquina não possui machinePayPosId configurado.",
      );
    } else if (!inicioConsultaDigital) {
      console.log(
        "[MachinePay] Pulando busca: não há movimentação anterior e machinePayDataInicio não foi informado.",
      );
    } else {
      try {
        const { consultarFechamentoMachinePay } = await import(
          "../services/machinePayService.js"
        );
        const fechamentoDigital = await consultarFechamentoMachinePay({
          posId: maquina.machinePayPosId,
          inicio: inicioConsultaDigital,
          fim: dataColetaFinal,
        });
        valorEntradaCartao = fechamentoDigital.cartaoPix;
        console.log(
          "[MachinePay] Valor digital buscado com sucesso:",
          valorEntradaCartao,
        );
      } catch (machinePayError) {
        console.error(
          "[MachinePay] Erro ao buscar valor digital automático:",
          machinePayError.message,
          machinePayError.stack,
        );
      }
    }

    // VERIFICAR BLOQUEIO DE LOJA
    // Buscar a loja da máquina
    const loja = await Loja.findByPk(maquina.lojaId);
    if (!loja) {
      return res.status(404).json({ error: "Loja não encontrada" });
    }

    // BLOQUEIO APENAS SE TIVER ROTEIRO DEFINIDO
    if (roteiroId) {
      lockTransaction = await sequelize.transaction();

      const roteiro = await Roteiro.findByPk(roteiroId, {
        attributes: ["id", "semanaInicio"],
        transaction: lockTransaction,
      });

      if (!roteiro) {
        await lockTransaction.rollback();
        lockTransaction = null;
        return res.status(404).json({ error: "Roteiro não encontrado" });
      }

      // Buscar todas as lojas deste roteiro
      const lojasDoRoteiro = await RoteiroLoja.findAll({
        where: { roteiroId },
        attributes: ["lojaId"],
        transaction: lockTransaction,
      });

      const lojasIdsDoRoteiro = lojasDoRoteiro.map((rl) => rl.lojaId);

      // Buscar lojas com flag ativa no mesmo roteiro (exceto a loja atual)
      const lojasComFlagAtiva = await Loja.findAll({
        where: {
          movimentacaoEmAndamento: true,
          id: {
            [Op.ne]: loja.id, // Diferente da loja atual
            [Op.in]: lojasIdsDoRoteiro, // Apenas lojas deste roteiro
          },
        },
        attributes: ["id", "nome", "movimentacaoEmAndamento"],
        transaction: lockTransaction,
      });

      let lojaBloqueadoraReal = null;
      let movimentacoesBloqueadoras = [];

      for (const lojaFlagAtiva of lojasComFlagAtiva) {
        const whereMovimentacaoReal = {
          roteiroId,
          lojaId: lojaFlagAtiva.id,
        };

        if (roteiro.semanaInicio) {
          whereMovimentacaoReal.createdAt = { [Op.gte]: roteiro.semanaInicio };
        }

        const movimentacoesReais = await Movimentacao.findAll({
          where: whereMovimentacaoReal,
          attributes: ["id"],
          order: [["createdAt", "DESC"]],
          limit: 5,
          transaction: lockTransaction,
        });

        if (!movimentacoesReais.length) {
          // Autocorreção de lock fantasma: flag ativa sem movimentação real.
          await lojaFlagAtiva.update(
            limparEstadoLockLoja(),
            { transaction: lockTransaction },
          );

          console.warn("[LOCK_AUTOCORRECAO] Lock fantasma removido", {
            roteiroId,
            lojaId: lojaFlagAtiva.id,
            lojaNome: lojaFlagAtiva.nome,
            motivo: "flag_true_sem_movimentacao_real",
          });

          continue;
        }

        const roteiroLojaBloqueadora = await RoteiroLoja.findOne({
          where: { roteiroId, lojaId: lojaFlagAtiva.id },
          attributes: ["concluida"],
          transaction: lockTransaction,
        });

        const bloqueioAtivoReal = calcularBloqueioAtivoReal({
          movimentacaoEmAndamento: lojaFlagAtiva.movimentacaoEmAndamento,
          quantidadeMovimentacoesReais: movimentacoesReais.length,
          lojaConcluida: roteiroLojaBloqueadora?.concluida,
        });

        if (!bloqueioAtivoReal) {
          await lojaFlagAtiva.update(
            limparEstadoLockLoja(),
            { transaction: lockTransaction },
          );

          console.warn("[LOCK_AUTOCORRECAO] Lock inconsistente removido", {
            roteiroId,
            lojaId: lojaFlagAtiva.id,
            lojaNome: lojaFlagAtiva.nome,
            motivo: "loja_concluida_com_flag_ativa",
            movimentacaoIds: movimentacoesReais.map((mov) => mov.id),
          });

          continue;
        }

        lojaBloqueadoraReal = lojaFlagAtiva;
        movimentacoesBloqueadoras = movimentacoesReais.map((mov) => mov.id);
        break;
      }

      // Se há outra loja em uso, bloquear a operação
      if (lojaBloqueadoraReal) {
        console.warn("[BLOQUEIO_MOVIMENTACAO] Nova movimentação bloqueada", {
          roteiroId,
          lojaBloqueadaId: loja.id,
          lojaBloqueadaNome: loja.nome,
          lojaQueBloqueouId: lojaBloqueadoraReal.id,
          lojaQueBloqueouNome: lojaBloqueadoraReal.nome,
          motivo: "movimentacao_real_pendente_em_outra_loja",
          movimentacaoIdsEncontradas: movimentacoesBloqueadoras,
        });

        await lockTransaction.rollback();
        lockTransaction = null;

        return res.status(400).json({
          error: "Não é possível fazer movimentação em outra loja",
          message: `A loja "${lojaBloqueadoraReal.nome}" está com movimentação real pendente neste roteiro. Por favor, conclua a loja atual antes de iniciar movimentações em outra loja.`,
          lojaEmUso: {
            id: lojaBloqueadoraReal.id,
            nome: lojaBloqueadoraReal.nome,
          },
          diagnosticoBloqueio: {
            lojaBloqueadaId: loja.id,
            lojaQueBloqueouId: lojaBloqueadoraReal.id,
            motivo: "movimentacao_real_pendente_em_outra_loja",
            movimentacaoIdsEncontradas: movimentacoesBloqueadoras,
          },
        });
      }

      // Se esta loja não está marcada como "em andamento", marcar agora
      if (!loja.movimentacaoEmAndamento) {
        await loja.update(
          {
            movimentacaoEmAndamento: true,
            usuarioEmMovimentacaoId: req.usuario.id,
            dataInicioMovimentacao: new Date(),
          },
          { transaction: lockTransaction },
        );
        console.log(`🔒 Loja "${loja.nome}" bloqueada para movimentações de outras lojas no roteiro ${roteiroId}`);
      }
    }

    // Calcular valor faturado: fichas + notas + digital
    // Na tela simplificada o faturamento é o dinheiro retirado + o que entrou
    // na Machine Pay no período.
    const valorFaturado = modoSimples
      ? (parseFloat(valorEntradaNotas) || 0) + (parseFloat(valorEntradaCartao) || 0)
      : (fichas ? fichas * parseFloat(maquina.valorFicha) : 0) +
        (quantidade_notas_entrada ? parseFloat(quantidade_notas_entrada) : 0) +
        (valor_entrada_maquininha_pix
          ? parseFloat(valor_entrada_maquininha_pix)
          : 0);

    console.log("📝 [registrarMovimentacao] Criando movimentação:", {
      maquinaId,
      roteiroId,
      totalPre,
      sairam: saidaRecalculada,
      abastecidas,
      totalPosCalculado: totalPre - saidaRecalculada + abastecidas,
      fichas: fichas || 0,
      valorFaturado,
    });

    // Movimentação e contas dos gastos extras entram juntas (ou nenhuma entra).
    if (!lockTransaction && gastosExtrasNormalizados.length) {
      lockTransaction = await sequelize.transaction();
    }

    // Criar movimentação
    const movimentacao = await Movimentacao.create({
      maquinaId,
      usuarioId: req.usuario.id,
      lojaId: maquina.lojaId,
      dataColeta: dataColetaFinal,
      totalPre,
      sairam: saidaRecalculada,
      abastecidas,
      fichas: fichas || 0,
      contadorMaquina,
      contadorIn,
      contadorOut,
      valorFaturado,
      observacoes,
      tipoOcorrencia: tipoOcorrencia || "Normal",
      retiradaEstoque: retiradaEstoque || false,
      // Campos antigos (deprecated)
      quantidade_notas_entrada: quantidade_notas_entrada ?? null,
      valor_entrada_maquininha_pix: valor_entrada_maquininha_pix ?? null,
      // Novos campos de valores de entrada
      valorEntradaFichas: valorEntradaFichas ?? null,
      valorEntradaNotas: valorEntradaNotas ?? null,
      // valorEntradaCartao é o valor buscado automaticamente da Machine Pay acima
      valorEntradaCartao,
      roteiroId: roteiroId || null,
      // Gestão Financeira - Sacola (identificação automática, não editável)
      numeroSacola,
      statusFinanceiro,
      // Tela de Movimentações (padrão AgarraMais)
      origemTotalPre:
        origemTotalPre === "automatico" || origemTotalPre === "manual"
          ? origemTotalPre
          : null,
      valorFichaUnitario: parseFloat(maquina.valorFicha) || 0,
      retiradaProduto: retiradaProdutoTotal,
      valorGastosExtras,
      machinePayInicio:
        valorEntradaCartao !== null && inicioConsultaDigital ? inicioConsultaDigital : null,
    }, lockTransaction ? { transaction: lockTransaction } : undefined);

    // Gastos extras da movimentação → Gestão de Contas, como conta a pagar já
    // paga (vencimento e quitação no dia da coleta, horário de Brasília).
    let contasGastosExtras = [];
    if (gastosExtrasNormalizados.length) {
      const diaColeta = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Sao_Paulo",
      }).format(new Date(dataColetaFinal));
      const nomeMaquina = maquina.nome || maquina.codigo || "Máquina";
      contasGastosExtras = await ContaFinanceira.bulkCreate(
        gastosExtrasNormalizados.map((gasto) => ({
          tipo: "PAGAR",
          descricao: `${gasto.descricao} — ${nomeMaquina} (${loja.nome})`.slice(0, 255),
          categoria: "Gastos de movimentação",
          centroCusto: loja.nome?.slice(0, 120) || null,
          valor: gasto.valor,
          vencimento: diaColeta,
          status: "QUITADA",
          dataQuitacao: diaColeta,
          valorQuitado: gasto.valor,
          observacao: `Lançado na movimentação da máquina ${nomeMaquina} por ${req.usuario.nome || "usuário"}.`,
          criadoPorId: req.usuario.id,
          movimentacaoId: movimentacao.id,
        })),
        lockTransaction ? { transaction: lockTransaction } : undefined,
      );
    }

    // Nova coleta: o acumulado da Machine Pay preservado antes de fechamentos
    // (Registrar Dinheiro) já foi considerado; zera para o próximo ciclo.
    try {
      const { MachinePayColetaPendente } = await import("../models/index.js");
      await MachinePayColetaPendente.destroy({ where: { maquinaId } });
    } catch (erroPendente) {
      console.error("[MachinePay] Erro ao limpar coleta pendente:", erroPendente.message);
    }

    if (lockTransaction) {
      await lockTransaction.commit();
      lockTransaction = null;
    }

    console.log("✅ [registrarMovimentacao] Movimentação criada com sucesso:", {
      id: movimentacao.id,
      maquinaId: movimentacao.maquinaId,
      roteiroId: movimentacao.roteiroId,
      totalPre: movimentacao.totalPre,
      sairam: movimentacao.sairam,
      abastecidas: movimentacao.abastecidas,
      totalPos: movimentacao.totalPos,
    });

    // Verificar se foi salvo corretamente
    if (roteiroId) {
      console.log(
        `🔍 [DEBUG] Verificando movimentação no banco para roteiro ${roteiroId}...`,
      );
      const verificacao = await Movimentacao.findOne({
        where: { id: movimentacao.id },
        attributes: ["id", "maquinaId", "roteiroId"],
      });
      console.log(`📊 [DEBUG] Movimentação verificada:`, verificacao?.toJSON());
    }

    // Se produtos foram informados, registrar detalhes
    if (produtosNormalizados.length > 0) {
      const detalhesProdutos = produtosNormalizados.map((p) => ({
        movimentacaoId: movimentacao.id,
        produtoId: p.produtoId,
        quantidadeSaiu: p.quantidadeSaiu || 0,
        quantidadeAbastecida: p.quantidadeAbastecida || 0,
        retiradaProduto: p.retiradaProduto || 0,
      }));

      await MovimentacaoProduto.bulkCreate(detalhesProdutos);

      // Sem controle de estoque: os produtos cadastrados podem ser usados à
      // vontade, abastecer não desconta mais nada do estoque da loja.

      // ============================================
      // DESCONTAR PRODUTOS DO CARRINHO DO USUÁRIO
      // ============================================
      
      // Buscar carrinho ativo do usuário nadata corrente
      const hoje = new Date().toISOString().split("T")[0];
      const carrinhoUsuario = await CarrinhoUsuario.findOne({
        where: {
          usuarioId: req.usuario.id,
          data: hoje,
          ativo: true,
        },
      });

      if (carrinhoUsuario) {
        console.log("🛒 [registrarMovimentacao] Descontando produtos do carrinho:", {
          carrinhoId: carrinhoUsuario.id,
          usuarioId: req.usuario.id,
        });

        // Importar modelo CarrinhoItem
        const { CarrinhoItem } = await import("../models/index.js");

        for (const produto of produtosNormalizados) {
          if (produto.quantidadeAbastecida && produto.quantidadeAbastecida > 0) {
            // Buscar item do carrinho correspondente
            const carrinhoItem = await CarrinhoItem.findOne({
              where: {
                carrinhoId: carrinhoUsuario.id,
                produtoId: produto.produtoId,
              },
            });

            if (carrinhoItem) {
              const quantidadeAnterior = carrinhoItem.quantidadeAtual;
              const novaQuantidade = Math.max(
                0,
                carrinhoItem.quantidadeAtual - produto.quantidadeAbastecida,
              );

              console.log("📦 [registrarMovimentacao] Item do carrinho atualizado:", {
                produtoId: produto.produtoId,
                quantidadeAnterior,
                quantidadeAbastecida: produto.quantidadeAbastecida,
                novaQuantidade,
              });

              await carrinhoItem.update({ quantidadeAtual: novaQuantidade });
            } else {
              console.log("⚠️ [registrarMovimentacao] Item não encontrado no carrinho:", {
                carrinhoId: carrinhoUsuario.id,
                produtoId: produto.produtoId,
              });
            }
          }
        }

        // Atualizar quantidade total do carrinho
        const totalCarrinhoAtual = await CarrinhoItem.sum("quantidadeAtual", {
          where: { carrinhoId: carrinhoUsuario.id },
        });

        await carrinhoUsuario.update({ 
          quantidadeAtual: totalCarrinhoAtual || 0 
        });

        console.log("✅ [registrarMovimentacao] Carrinho atualizado:", {
          quantidadeTotal: totalCarrinhoAtual || 0,
        });
      } else {
        console.log("ℹ️ [registrarMovimentacao] Usuário não possui carrinho ativo hoje");
      }
    }

    // Atualizar contador de máquinas concluídas do roteiro
    if (roteiroId) {
      const { Roteiro } = await import("../models/index.js");
      const maquinasConcluidas = await Movimentacao.count({
        where: { roteiroId },
        distinct: true,
        col: "maquinaId",
      });

      await Roteiro.update(
        { maquinasConcluidas },
        { where: { id: roteiroId } },
      );
    }

    // Buscar movimentação completa para retornar
    const movimentacaoCompleta = await Movimentacao.findByPk(movimentacao.id, {
      include: [
        {
          model: Maquina,
          as: "maquina",
          attributes: ["id", "codigo", "nome"],
        },
        {
          model: Usuario,
          as: "usuario",
          attributes: ["id", "nome", "email"],
        },
        {
          model: MovimentacaoProduto,
          as: "detalhesProdutos",
          include: [
            {
              model: Produto,
              as: "produto",
              attributes: ["id", "nome", "categoria"],
            },
          ],
        },
      ],
    });

    res.locals.entityId = movimentacao.id;
    res.status(201).json(movimentacaoCompleta);
  } catch (error) {
    if (lockTransaction) {
      await lockTransaction.rollback();
    }

    console.error("❌ [registrarMovimentacao] Erro completo:", error);
    console.error("❌ [registrarMovimentacao] Stack:", error.stack);
    res.status(500).json({
      error: "Erro ao registrar movimentação",
      details: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// Listar movimentações com filtros
export const listarMovimentacoes = async (req, res) => {
  try {
    const {
      maquinaId,
      lojaId,
      dataInicio,
      dataFim,
      usuarioId,
      limite,
    } = req.query;

    const where = {};

    if (maquinaId) {
      where.maquinaId = maquinaId;
    }

    if (usuarioId) {
      where.usuarioId = usuarioId;
    }

    if (dataInicio || dataFim) {
      // Filtra por dataColeta E createdAt para cobrir todos os casos
      const filtroData = {};
      if (dataInicio) filtroData[Op.gte] = new Date(dataInicio);
      if (dataFim) filtroData[Op.lte] = new Date(dataFim);
      where[Op.or] = [
        { dataColeta: filtroData },
        { createdAt: filtroData },
      ];
    }

    const include = [
      {
        model: Maquina,
        as: "maquina",
        attributes: ["id", "codigo", "nome", "lojaId"],
      },
      {
        model: Usuario,
        as: "usuario",
        attributes: ["id", "nome"],
      },
      {
        model: MovimentacaoProduto,
        as: "detalhesProdutos",
        include: [
          {
            model: Produto,
            as: "produto",
            attributes: ["id", "nome"],
          },
        ],
      },
    ];

    // Filtrar por loja se especificado
    if (lojaId) {
      include[0].where = { lojaId };
    }

    const movimentacoes = await Movimentacao.findAll({
      where,
      include,
      order: [["dataColeta", "DESC"]],
      // Se limite explícito passado via query, usa ele.
      // Se há filtro de data (dashboard/gráficos), retorna todos.
      // Sem filtro e sem limite explícito: padrão 50 para não sobrecarregar.
      ...(limite
        ? { limit: parseInt(limite) }
        : dataInicio || dataFim
          ? {}
          : { limit: 50 }),
    });

    res.json(movimentacoes);
  } catch (error) {
    console.error("Erro ao listar movimentações:", error);
    res.status(500).json({ error: "Erro ao listar movimentações" });
  }
};

// Obter movimentação por ID
export const obterMovimentacao = async (req, res) => {
  try {
    const movimentacao = await Movimentacao.findByPk(req.params.id, {
      include: [
        {
          model: Maquina,
          as: "maquina",
          include: [
            {
              model: Loja,
              as: "loja",
              attributes: ["id", "nome"],
            },
          ],
        },
        {
          model: Usuario,
          as: "usuario",
          attributes: ["id", "nome", "email"],
        },
        {
          model: MovimentacaoProduto,
          as: "detalhesProdutos",
          include: [
            {
              model: Produto,
              as: "produto",
            },
          ],
        },
      ],
    });

    if (!movimentacao) {
      return res.status(404).json({ error: "Movimentação não encontrada" });
    }

    res.json(movimentacao);
  } catch (error) {
    console.error("Erro ao obter movimentação:", error);
    res.status(500).json({ error: "Erro ao obter movimentação" });
  }
};

// Atualizar movimentação (apenas observações e detalhes menores)
export const atualizarMovimentacao = async (req, res) => {
  try {
    const movimentacao = await Movimentacao.findByPk(req.params.id);

    if (!movimentacao) {
      return res.status(404).json({ error: "Movimentação não encontrada" });
    }

    // Apenas admin ou o próprio usuário que criou pode editar
    if (
      req.usuario.role !== "ADMIN" &&
      movimentacao.usuarioId !== req.usuario.id
    ) {
      return res
        .status(403)
        .json({ error: "Você não pode editar esta movimentação" });
    }

    const {
      observacoes,
      tipoOcorrencia,
      fichas,
      totalPre,
      sairam,
      abastecidas,
      contadorIn,
      contadorOut,
      quantidade_notas_entrada,
      valor_entrada_maquininha_pix,
      dataColeta,
      // Novos campos
      valorEntradaFichas,
      valorEntradaNotas,
      valorEntradaCartao,
    } = req.body;

    // Preparar dados para atualização
    let dataColetaAtualizada = movimentacao.dataColeta;
    if (dataColeta !== undefined) {
      dataColetaAtualizada = new Date(dataColeta);
      if (Number.isNaN(dataColetaAtualizada.getTime())) {
        return res.status(400).json({
          error: "dataColeta deve ser uma data valida",
        });
      }
    }

    const updateData = {
      observacoes: observacoes ?? movimentacao.observacoes,
      tipoOcorrencia: tipoOcorrencia ?? movimentacao.tipoOcorrencia,
      dataColeta: dataColetaAtualizada,
      totalPre:
        totalPre !== undefined
          ? parseInt(totalPre) || 0
          : movimentacao.totalPre,
      sairam:
        sairam !== undefined ? parseInt(sairam) || 0 : movimentacao.sairam,
      fichas:
        fichas !== undefined ? parseInt(fichas) || 0 : movimentacao.fichas,
      abastecidas:
        abastecidas !== undefined
          ? parseInt(abastecidas) || 0
          : movimentacao.abastecidas,
      contadorIn:
        contadorIn !== undefined
          ? parseInt(contadorIn) || null
          : movimentacao.contadorIn,
      contadorOut:
        contadorOut !== undefined
          ? parseInt(contadorOut) || null
          : movimentacao.contadorOut,
      // Campos antigos
      quantidade_notas_entrada:
        quantidade_notas_entrada !== undefined
          ? parseInt(quantidade_notas_entrada) || null
          : movimentacao.quantidade_notas_entrada,
      valor_entrada_maquininha_pix:
        valor_entrada_maquininha_pix !== undefined
          ? parseFloat(valor_entrada_maquininha_pix) || null
          : movimentacao.valor_entrada_maquininha_pix,
      // Novos campos
      valorEntradaFichas:
        valorEntradaFichas !== undefined
          ? parseFloat(valorEntradaFichas) || null
          : movimentacao.valorEntradaFichas,
      valorEntradaNotas:
        valorEntradaNotas !== undefined
          ? parseFloat(valorEntradaNotas) || null
          : movimentacao.valorEntradaNotas,
      valorEntradaCartao:
        valorEntradaCartao !== undefined
          ? parseFloat(valorEntradaCartao) || null
          : movimentacao.valorEntradaCartao,
    };

    // Reabrir automaticamente como pendente no financeiro se dinheiro em
    // espécie foi informado/alterado numa movimentação já concluída
    if (
      valorEntradaNotas !== undefined &&
      Number(updateData.valorEntradaNotas) > 0 &&
      movimentacao.statusFinanceiro === "concluido"
    ) {
      updateData.statusFinanceiro = "pendente";
    }

    // Se fichas, notas ou digital foram atualizados, recalcular o valorFaturado
    if (
      fichas !== undefined ||
      quantidade_notas_entrada !== undefined ||
      valor_entrada_maquininha_pix !== undefined
    ) {
      const maquina = await Maquina.findByPk(movimentacao.maquinaId);
      if (maquina) {
        // Valor da ficha da época da coleta (snapshot), se houver; senão o atual.
        const valorFichaHistorico =
          movimentacao.valorFichaUnitario !== null &&
          movimentacao.valorFichaUnitario !== undefined
            ? parseFloat(movimentacao.valorFichaUnitario)
            : parseFloat(maquina.valorFicha);
        updateData.valorFaturado =
          updateData.fichas * valorFichaHistorico +
          (updateData.quantidade_notas_entrada
            ? parseFloat(updateData.quantidade_notas_entrada)
            : 0) +
          (updateData.valor_entrada_maquininha_pix
            ? parseFloat(updateData.valor_entrada_maquininha_pix)
            : 0);
      }
    }

    await movimentacao.update(updateData);

    res.json(movimentacao);
  } catch (error) {
    console.error("Erro ao atualizar movimentação:", error);
    res.status(500).json({ error: "Erro ao atualizar movimentação" });
  }
};

// Deletar movimentação (apenas ADMIN)
export const deletarMovimentacao = async (req, res) => {
  try {
    const movimentacao = await Movimentacao.findByPk(req.params.id);

    if (!movimentacao) {
      return res.status(404).json({ error: "Movimentação não encontrada" });
    }

    await movimentacao.destroy();

    // Gastos extras lançados nesta movimentação saem da Gestão de Contas junto.
    try {
      await ContaFinanceira.destroy({ where: { movimentacaoId: movimentacao.id } });
    } catch (erroContas) {
      console.error("Erro ao remover gastos extras da movimentação apagada:", erroContas);
    }

    res.json({ message: "Movimentação deletada com sucesso" });
  } catch (error) {
    console.error("Erro ao deletar movimentação:", error);
    res.status(500).json({ error: "Erro ao deletar movimentação" });
  }
};

// GET /api/movimentacoes/pendentes-financeiro
// Listar movimentações com statusFinanceiro = pendente (aguardando preenchimento de valores)
export const listarPendentesFinanceiro = async (req, res) => {
  try {
    const movimentacoes = await Movimentacao.findAll({
      where: { statusFinanceiro: "pendente" },
      include: [
        {
          model: Maquina,
          as: "maquina",
          attributes: ["id", "codigo", "nome", "tipo", "lojaId"],
          include: [
            {
              model: Loja,
              as: "loja",
              attributes: ["id", "nome", "endereco", "cidade", "estado"],
            },
          ],
        },
        {
          model: Usuario,
          as: "usuario",
          attributes: ["id", "nome", "email"],
        },
      ],
      order: [["dataColeta", "DESC"]],
    });

    res.json(movimentacoes);
  } catch (error) {
    console.error("Erro ao listar movimentações pendentes:", error);
    res.status(500).json({ error: "Erro ao listar movimentações pendentes" });
  }
};

// PUT /api/movimentacoes/:id/financeiro
// Atualizar valores financeiros de uma movimentação pendente
export const atualizarValoresFinanceiros = async (req, res) => {
  try {
    const { id } = req.params;
    const { valorEntradaFichas, valorEntradaNotas, valorEntradaCartao } =
      req.body;

    const movimentacao = await Movimentacao.findByPk(id);

    if (!movimentacao) {
      return res.status(404).json({ error: "Movimentação não encontrada" });
    }

    if (movimentacao.statusFinanceiro !== "pendente") {
      return res.status(400).json({
        error: "Esta movimentação já teve seus valores financeiros preenchidos",
      });
    }

    // Buscar máquina para recalcular valorFaturado
    const maquina = await Maquina.findByPk(movimentacao.maquinaId);

    // valorEntradaCartao já vem preenchido automaticamente desde a criação da
    // movimentação (buscado da Machine Pay). Só sobrescreve se vier explícito
    // no body (permite ajuste manual em caso de divergência); caso contrário
    // mantém o valor automático já salvo.
    const valorEntradaCartaoFinal =
      valorEntradaCartao !== undefined
        ? valorEntradaCartao
        : movimentacao.valorEntradaCartao;

    // Recalcular valor faturado
    const valorFaturado =
      (movimentacao.fichas
        ? movimentacao.fichas * parseFloat(maquina.valorFicha)
        : 0) +
      (valorEntradaNotas ? parseFloat(valorEntradaNotas) : 0) +
      (valorEntradaCartaoFinal ? parseFloat(valorEntradaCartaoFinal) : 0);

    await movimentacao.update({
      valorEntradaFichas: valorEntradaFichas ?? null,
      valorEntradaNotas: valorEntradaNotas ?? null,
      valorEntradaCartao: valorEntradaCartaoFinal ?? null,
      valorFaturado,
      statusFinanceiro: "concluido",
    });

    const machinePayFechamento = await executarFechamentoMachinePay(
      maquina,
      movimentacao,
      valorEntradaNotas,
    );

    res.json({
      message: "Valores financeiros atualizados com sucesso",
      movimentacao,
      machinePayFechamento,
    });
  } catch (error) {
    console.error("Erro ao atualizar valores financeiros:", error);
    res.status(500).json({ error: "Erro ao atualizar valores financeiros" });
  }
};

// Fechamento automático na Machine Pay (best-effort, nunca bloqueia a
// conclusão do registro financeiro local)
async function executarFechamentoMachinePay(maquina, movimentacao, valorNotas) {
  let machinePayFechamento = { executado: false, concluido: false, erro: null };

  if (!maquina?.machinePayPosId) return machinePayFechamento;

  try {
    const movimentacaoAnterior = await Movimentacao.findOne({
      where: {
        maquinaId: movimentacao.maquinaId,
        dataColeta: { [Op.lt]: movimentacao.dataColeta },
      },
      order: [["dataColeta", "DESC"]],
    });

    if (!movimentacaoAnterior) {
      machinePayFechamento.erro =
        "Sem movimentação anterior desta máquina para determinar o período de fechamento";
      return machinePayFechamento;
    }

    const { fecharFechamentoMachinePay } = await import(
      "../services/machinePayService.js"
    );

    const resultadoFechamento = await fecharFechamentoMachinePay({
      posId: maquina.machinePayPosId,
      inicio: movimentacaoAnterior.dataColeta,
      fim: movimentacao.dataColeta,
      valor: Number(valorNotas) || 0,
    });

    machinePayFechamento = {
      executado: true,
      concluido: resultadoFechamento.concluido,
      erro: null,
    };
  } catch (machinePayError) {
    console.error("[MachinePay] Erro ao executar fechamento:", machinePayError);
    machinePayFechamento = {
      executado: true,
      concluido: false,
      erro: machinePayError.message,
    };
  }

  return machinePayFechamento;
}

// Rateia um total em centavos proporcionalmente aos pesos (o resto vai para o último)
function ratearValor(total, pesos) {
  const totalCentavos = Math.round((Number(total) || 0) * 100);
  const somaPesos = pesos.reduce((s, p) => s + p, 0);
  const partes = pesos.map((p) =>
    somaPesos > 0
      ? Math.floor((totalCentavos * p) / somaPesos)
      : Math.floor(totalCentavos / pesos.length),
  );
  const resto = totalCentavos - partes.reduce((s, p) => s + p, 0);
  partes[partes.length - 1] += resto;
  return partes.map((c) => c / 100);
}

// PUT /api/movimentacoes/financeiro-ponto
// Lança o dinheiro e o cartão totais de um ponto (loja) de uma vez. O valor é
// rateado entre as movimentações pendentes informadas, proporcionalmente às
// fichas de cada máquina (igualmente se nenhuma tiver fichas).
export const atualizarValoresFinanceirosPonto = async (req, res) => {
  try {
    const { movimentacaoIds, valorDinheiro, valorCartao } = req.body;

    if (!Array.isArray(movimentacaoIds) || movimentacaoIds.length === 0) {
      return res
        .status(400)
        .json({ error: "Informe as movimentações do ponto" });
    }

    const dinheiro = Number(valorDinheiro);
    const cartao = Number(valorCartao || 0);
    if (!Number.isFinite(dinheiro) || dinheiro < 0 || !Number.isFinite(cartao) || cartao < 0) {
      return res.status(400).json({ error: "Valores inválidos" });
    }

    const movimentacoes = await Movimentacao.findAll({
      where: { id: movimentacaoIds, statusFinanceiro: "pendente" },
      order: [["dataColeta", "ASC"]],
    });

    if (movimentacoes.length !== movimentacaoIds.length) {
      return res.status(400).json({
        error:
          "Algumas movimentações não existem ou já tiveram os valores preenchidos",
      });
    }

    const lojaIds = new Set(movimentacoes.map((m) => m.lojaId));
    if (lojaIds.size > 1) {
      return res
        .status(400)
        .json({ error: "As movimentações devem ser do mesmo ponto" });
    }

    const maquinas = await Maquina.findAll({
      where: { id: movimentacoes.map((m) => m.maquinaId) },
    });
    const maquinaPorId = new Map(maquinas.map((m) => [m.id, m]));

    const pesos = movimentacoes.map((m) => Number(m.fichas) || 0);
    const dinheiroPorMov = ratearValor(dinheiro, pesos);
    const cartaoPorMov = ratearValor(cartao, pesos);

    await sequelize.transaction(async (transaction) => {
      for (let i = 0; i < movimentacoes.length; i++) {
        const mov = movimentacoes[i];
        const maquina = maquinaPorId.get(mov.maquinaId);
        const valorFaturado =
          (mov.fichas ? mov.fichas * parseFloat(maquina.valorFicha) : 0) +
          dinheiroPorMov[i] +
          cartaoPorMov[i];

        await mov.update(
          {
            valorEntradaNotas: dinheiroPorMov[i],
            valorEntradaCartao: cartaoPorMov[i],
            valorFaturado,
            statusFinanceiro: "concluido",
          },
          { transaction },
        );
      }
    });

    const fechamentos = [];
    for (let i = 0; i < movimentacoes.length; i++) {
      const mov = movimentacoes[i];
      fechamentos.push(
        await executarFechamentoMachinePay(
          maquinaPorId.get(mov.maquinaId),
          mov,
          dinheiroPorMov[i],
        ),
      );
    }

    res.json({
      message: "Valores do ponto lançados com sucesso",
      totalMovimentacoes: movimentacoes.length,
      machinePayFalhas: fechamentos.filter((f) => f.executado && !f.concluido)
        .length,
    });
  } catch (error) {
    console.error("Erro ao lançar valores financeiros do ponto:", error);
    res.status(500).json({ error: "Erro ao lançar valores do ponto" });
  }
};

// POST /api/movimentacoes/:id/machine-pay/valor-digital
// Busca (ou refaz a busca) do valor digital (PIX/cartão) na Machine Pay para
// uma movimentação específica. Usado tanto pelo botão "refazer busca" quanto,
// quando não há movimentação anterior, junto com uma data de início escolhida
// pelo usuário (body: { inicio }).
export const buscarValorDigitalMachinePay = async (req, res) => {
  try {
    const { id } = req.params;
    const { inicio: inicioManual } = req.body || {};

    const movimentacao = await Movimentacao.findByPk(id);
    if (!movimentacao) {
      return res.status(404).json({ error: "Movimentação não encontrada" });
    }

    const maquina = await Maquina.findByPk(movimentacao.maquinaId);
    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    if (!maquina.machinePayPosId) {
      return res.status(400).json({
        error:
          "Esta máquina não possui ID da Machine Pay (machinePayPosId) configurado.",
      });
    }

    const movimentacaoAnterior = await Movimentacao.findOne({
      where: {
        maquinaId: movimentacao.maquinaId,
        dataColeta: { [Op.lt]: movimentacao.dataColeta },
      },
      order: [["dataColeta", "DESC"]],
    });

    const inicio = movimentacaoAnterior
      ? movimentacaoAnterior.dataColeta
      : inicioManual;

    console.log("[MachinePay] Busca manual de valor digital solicitada:", {
      movimentacaoId: id,
      maquinaId: movimentacao.maquinaId,
      machinePayPosId: maquina.machinePayPosId,
      temMovimentacaoAnterior: Boolean(movimentacaoAnterior),
      inicioManualInformado: inicioManual || null,
      inicioUsado: inicio || null,
      fim: movimentacao.dataColeta,
    });

    if (!inicio) {
      return res.status(400).json({
        error:
          "Não há movimentação anterior desta máquina para calcular o período automaticamente. Informe uma data de início.",
        precisaDataInicio: true,
      });
    }

    const { consultarFechamentoMachinePay } = await import(
      "../services/machinePayService.js"
    );

    const fechamento = await consultarFechamentoMachinePay({
      posId: maquina.machinePayPosId,
      inicio,
      fim: movimentacao.dataColeta,
    });

    await movimentacao.update({ valorEntradaCartao: fechamento.cartaoPix });

    console.log(
      "[MachinePay] Valor digital atualizado via busca manual:",
      fechamento.cartaoPix,
    );

    res.json({
      movimentacaoId: movimentacao.id,
      inicio,
      fim: movimentacao.dataColeta,
      valorEntradaCartao: fechamento.cartaoPix,
      fechamento,
    });
  } catch (error) {
    console.error(
      "[MachinePay] Erro ao buscar valor digital manualmente:",
      error.message,
      error.stack,
    );
    res.status(502).json({
      error:
        error.message || "Não foi possível buscar o valor digital na Machine Pay.",
    });
  }
};

// ---------------------------------------------------------------------------
// Trazido da AgarraMais (tela de Movimentações)
// ---------------------------------------------------------------------------

const DAY_IN_MS = 24 * 60 * 60 * 1000;

// A cada esse número de dias, força uma conferência manual (o operador conta
// fisicamente e digita) em vez de confiar cegamente nos pulsos da Machine Pay.
const DIAS_CICLO_CONFERENCIA_MANUAL = 15;

// GET /movimentacoes/sugestao-total-pre/:maquinaId
//
// Sugere o Total Pré da próxima coleta para máquinas com "desconto automático via
// Machine Pay": a cada valorDescontoMachinePay recebido desde a última coleta a máquina
// libera um pulso, então o esperado é o totalPos da última coleta menos os pulsos.
// A cada DIAS_CICLO_CONFERENCIA_MANUAL dias sem conferência manual devolve
// modo "forcar_manual" (o valor vem só para comparar com o que o operador contar).
export const sugerirTotalPre = async (req, res) => {
  try {
    const { maquinaId } = req.params;
    const maquina = await Maquina.findByPk(maquinaId);

    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    if (!maquina.machinePayPosId?.trim()) {
      return res.json({ sugestaoDisponivel: false, motivo: "sem_pos_id" });
    }

    const valorDesconto = Number(maquina.valorDescontoMachinePay || 0);
    if (!maquina.descontoAutomaticoMachinePay || valorDesconto <= 0) {
      return res.json({ sugestaoDisponivel: false, motivo: "desconto_desativado" });
    }

    const ultimaMov = await Movimentacao.findOne({
      where: { maquinaId },
      order: [["dataColeta", "DESC"]],
    });

    if (!ultimaMov) {
      return res.json({
        sugestaoDisponivel: false,
        motivo: "sem_movimentacao_anterior",
        modo: "forcar_manual",
      });
    }

    const ultimaConferenciaManual = await Movimentacao.findOne({
      where: { maquinaId, origemTotalPre: "manual" },
      order: [["dataColeta", "DESC"]],
    });

    const diasDesdeConferencia = ultimaConferenciaManual
      ? (Date.now() - new Date(ultimaConferenciaManual.dataColeta).getTime()) / DAY_IN_MS
      : Infinity;
    const modo = diasDesdeConferencia >= DIAS_CICLO_CONFERENCIA_MANUAL ? "forcar_manual" : "auto";

    const totalPosAnterior = ultimaMov.totalPos || 0;
    const { calcularEstoqueRealPagamentos } = await import("../services/estoquePagamentosService.js");
    const { fonte, estoqueReal, totalRecebidoDesdeUltimaMovimentacao, totalMachinePay, totalCompactPay, pulsos } =
      await calcularEstoqueRealPagamentos({
        maquina,
        valorDesconto,
        totalPosAnterior,
        dataUltimaColeta: ultimaMov.dataColeta,
      });

    return res.json({
      sugestaoDisponivel: true,
      fonte,
      totalMachinePay,
      totalCompactPay,
      modo,
      sugestaoTotalPre: estoqueReal,
      totalPosAnterior,
      totalRecebidoDesdeUltimaMovimentacao,
      pulsos,
      valorDesconto,
      ultimaMovimentacaoEm: ultimaMov.dataColeta,
    });
  } catch (error) {
    console.error("Erro ao sugerir total pré via Machine Pay:", error);
    res.status(502).json({
      sugestaoDisponivel: false,
      motivo: "erro_machine_pay",
      modo: "forcar_manual",
      error: error.message,
    });
  }
};

// GET /movimentacoes/saidas-compactpay/:maquinaId
// O Bedin não usa CompactPay: responde "indisponível" para a tela não tentar conferir.
export const saidasCompactPayDesdeUltimaMovimentacao = async (req, res) => {
  res.json({ disponivel: false, motivo: "compactpay_nao_usado" });
};
// GET /movimentacoes/resumo-maquina/:maquinaId?inicio=ISO
// Tela de Movimentações: dados da última movimentação (contadores, quanto ficou
// na máquina) e quanto entrou na Machine Pay de `inicio` até agora. Sem `inicio`,
// o período começa na última movimentação; sem movimentação anterior, o
// operador precisa escolher a data (precisaDataInicio).
export const resumoMaquinaMovimentacao = async (req, res) => {
  try {
    const maquina = await Maquina.findByPk(req.params.maquinaId);
    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    const ultimaMov = await Movimentacao.findOne({
      where: { maquinaId: maquina.id },
      order: [["dataColeta", "DESC"]],
      attributes: ["id", "dataColeta", "contadorIn", "contadorOut", "totalPos"],
    });

    const inicioQuery = req.query.inicio ? new Date(req.query.inicio) : null;
    if (inicioQuery && Number.isNaN(inicioQuery.getTime())) {
      return res.status(400).json({ error: "Data de início inválida" });
    }
    const inicioPadrao = ultimaMov?.dataColeta || null;
    const inicio = inicioQuery || inicioPadrao;
    const fim = new Date();

    const resposta = {
      ultimaMovimentacao: ultimaMov
        ? {
            dataColeta: ultimaMov.dataColeta,
            contadorIn: ultimaMov.contadorIn,
            contadorOut: ultimaMov.contadorOut,
            totalPos: ultimaMov.totalPos,
          }
        : null,
      machinePay: {
        configurada: Boolean(maquina.machinePayPosId),
        inicioPadrao,
        inicio,
        fim,
        precisaDataInicio: !inicio,
        valor: null,
        erro: null,
      },
    };

    if (!maquina.machinePayPosId || !inicio) {
      return res.json(resposta);
    }
    if (inicio > fim) {
      resposta.machinePay.erro = "A data de início não pode ser no futuro.";
      return res.json(resposta);
    }

    try {
      const { consultarFechamentoMachinePay } = await import(
        "../services/machinePayService.js"
      );
      const fechamento = await consultarFechamentoMachinePay({
        posId: maquina.machinePayPosId,
        inicio,
        fim,
      });
      resposta.machinePay.valor = Number(fechamento?.cartaoPix) || 0;
    } catch (erroMachinePay) {
      console.error("[MachinePay] Erro no resumo da máquina:", erroMachinePay.message);
      resposta.machinePay.erro = "Não foi possível consultar a Machine Pay agora.";
    }

    return res.json(resposta);
  } catch (error) {
    console.error("Erro ao montar resumo da máquina:", error);
    res.status(500).json({ error: "Erro ao buscar dados da máquina" });
  }
};