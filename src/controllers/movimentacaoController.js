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
      totalPre,
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
      valorEntradaCartao,
      roteiroId,
      numeroSacola, // opcional: identificação livre da sacola de dinheiro
    } = req.body;

    // Validações
    if (!maquinaId || totalPre === undefined || abastecidas === undefined) {
      return res.status(400).json({
        error: "maquinaId, totalPre e abastecidas são obrigatórios",
      });
    }
    // Buscar última movimentação para calcular saída (sairam)
    const ultimaMov = await Movimentacao.findOne({
      where: { maquinaId },
      order: [["dataColeta", "DESC"]],
    });

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
          }))
      : [];

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

    // Sacola pendente automática: sempre que houver dinheiro em espécie retirado
    const statusFinanceiro =
      Number(valorEntradaNotas) > 0 ? "pendente" : "concluido";

    // Buscar máquina para pegar valorFicha
    const maquina = await Maquina.findByPk(maquinaId);
    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
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
    const valorFaturado =
      (fichas ? fichas * parseFloat(maquina.valorFicha) : 0) +
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

    // Criar movimentação
    const movimentacao = await Movimentacao.create({
      maquinaId,
      usuarioId: req.usuario.id,
      lojaId: maquina.lojaId,
      dataColeta: dataColeta || new Date(),
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
      valorEntradaCartao: valorEntradaCartao ?? null,
      roteiroId: roteiroId || null,
      // Gestão Financeira - Sacola
      numeroSacola: numeroSacola || null,
      statusFinanceiro,
    }, lockTransaction ? { transaction: lockTransaction } : undefined);

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
      }));

      await MovimentacaoProduto.bulkCreate(detalhesProdutos);

      // Descontar do estoque da loja os produtos abastecidos
      for (const produto of produtosNormalizados) {
        if (produto.quantidadeAbastecida && produto.quantidadeAbastecida > 0) {
          console.log(
            "🏪 [registrarMovimentacao] Atualizando estoque da loja:",
            {
              lojaId: maquina.lojaId,
              produtoId: produto.produtoId,
              quantidadeAbastecida: produto.quantidadeAbastecida,
            },
          );

          // Buscar estoque do produto na loja da máquina
          const estoqueLoja = await EstoqueLoja.findOne({
            where: {
              lojaId: maquina.lojaId,
              produtoId: produto.produtoId,
            },
          });

          if (estoqueLoja) {
            const quantidadeAnterior = estoqueLoja.quantidade;
            // Descontar a quantidade abastecida (não permite ficar negativo)
            const novaQuantidade = Math.max(
              0,
              estoqueLoja.quantidade - produto.quantidadeAbastecida,
            );

            console.log(
              "📦 [registrarMovimentacao] Estoque da loja atualizado:",
              {
                produtoId: produto.produtoId,
                quantidadeAnterior,
                quantidadeAbastecida: produto.quantidadeAbastecida,
                novaQuantidade,
              },
            );

            await estoqueLoja.update({ quantidade: novaQuantidade });
          } else {
            console.log(
              "⚠️ [registrarMovimentacao] Estoque da loja não encontrado:",
              {
                lojaId: maquina.lojaId,
                produtoId: produto.produtoId,
              },
            );
          }
        }
      }

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
        updateData.valorFaturado =
          updateData.fichas * parseFloat(maquina.valorFicha) +
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

    // Recalcular valor faturado
    const valorFaturado =
      (movimentacao.fichas
        ? movimentacao.fichas * parseFloat(maquina.valorFicha)
        : 0) +
      (valorEntradaNotas ? parseFloat(valorEntradaNotas) : 0) +
      (valorEntradaCartao ? parseFloat(valorEntradaCartao) : 0);

    await movimentacao.update({
      valorEntradaFichas: valorEntradaFichas ?? null,
      valorEntradaNotas: valorEntradaNotas ?? null,
      valorEntradaCartao: valorEntradaCartao ?? null,
      valorFaturado,
      statusFinanceiro: "concluido",
    });

    // Fechamento automático na Machine Pay (best-effort, nunca bloqueia a
    // conclusão do registro financeiro local)
    let machinePayFechamento = { executado: false, concluido: false, erro: null };

    if (maquina?.machinePayPosId) {
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
        } else {
          const { fecharFechamentoMachinePay } = await import(
            "../services/machinePayService.js"
          );

          const resultadoFechamento = await fecharFechamentoMachinePay({
            posId: maquina.machinePayPosId,
            inicio: movimentacaoAnterior.dataColeta,
            fim: movimentacao.dataColeta,
            valor: Number(valorEntradaNotas) || 0,
          });

          machinePayFechamento = {
            executado: true,
            concluido: resultadoFechamento.concluido,
            erro: null,
          };
        }
      } catch (machinePayError) {
        console.error(
          "[MachinePay] Erro ao executar fechamento:",
          machinePayError,
        );
        machinePayFechamento = {
          executado: true,
          concluido: false,
          erro: machinePayError.message,
        };
      }
    }

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
