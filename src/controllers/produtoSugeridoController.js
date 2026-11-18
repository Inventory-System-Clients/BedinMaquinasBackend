import { Op } from "sequelize";
import { Maquina, Produto, Movimentacao, MovimentacaoProduto } from "../models/index.js";

// Trazido da AgarraMais (tela de Movimentações): produto sugerido para a máquina.
// GET /maquinas/:id/produto-sugerido
export const produtoSugeridoPorMaquina = async (req, res) => {
  try {
    const { id } = req.params; // id da máquina
    const maquina = await Maquina.findByPk(id);
    if (!maquina) {
      return res.status(404).json({ error: "Máquina não encontrada" });
    }

    // 1. Produto da última movimentação da máquina
    const ultimaMov = await Movimentacao.findOne({
      where: { maquinaId: id },
      order: [["dataColeta", "DESC"]],
      include: [
        {
          model: MovimentacaoProduto,
          as: "detalhesProdutos",
          include: [{ model: Produto, as: "produto" }],
        },
      ],
    });

    const prodMov = ultimaMov?.detalhesProdutos?.[0];
    if (prodMov?.produto) {
      return res.json({ produtoSugerido: prodMov.produto });
    }

    // 2. Sem movimentação: tenta pelo tipo da máquina (categoria ou nome do produto).
    // (Na AgarraMais isto usava operadores "$or"/"$like" em string, que o Sequelize 6
    // não aceita — aqui com Op.)
    if (maquina.tipo) {
      const produto = await Produto.findOne({
        where: {
          [Op.or]: [
            { categoria: { [Op.iLike]: maquina.tipo } },
            { nome: { [Op.iLike]: `%${maquina.tipo}%` } },
          ],
        },
      });
      if (produto) {
        return res.json({ produtoSugerido: produto });
      }
    }

    // 3. Sem sugestão
    return res.json({ produtoSugerido: null });
  } catch (error) {
    console.error("Erro ao buscar produto sugerido:", error);
    res.status(500).json({ error: "Erro ao buscar produto sugerido" });
  }
};
