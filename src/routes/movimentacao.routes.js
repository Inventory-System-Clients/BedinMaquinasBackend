import express from "express";
import {
  registrarMovimentacao,
  listarMovimentacoes,
  obterMovimentacao,
  atualizarMovimentacao,
  deletarMovimentacao,
  listarPendentesFinanceiro,
  atualizarValoresFinanceiros,
  atualizarValoresFinanceirosPonto,
  buscarValorDigitalMachinePay,
  sugerirTotalPre,
  saidasCompactPayDesdeUltimaMovimentacao,
} from "../controllers/movimentacaoController.js";
import {
  autenticar,
  autorizarRole,
  registrarLog,
} from "../middlewares/auth.js";

const router = express.Router();

router.get("/", autenticar, listarMovimentacoes);
router.get("/pendentes-financeiro", autenticar, listarPendentesFinanceiro);
// Tela de Movimentações (padrão AgarraMais)
router.get("/sugestao-total-pre/:maquinaId", autenticar, sugerirTotalPre);
router.get(
  "/saidas-compactpay/:maquinaId",
  autenticar,
  autorizarRole("ADMIN"),
  saidasCompactPayDesdeUltimaMovimentacao
);
router.get("/:id", autenticar, obterMovimentacao);
router.post(
  "/",
  autenticar,
  registrarLog("REGISTRAR_MOVIMENTACAO", "Movimentacao"),
  registrarMovimentacao
);
router.put(
  "/:id",
  autenticar,
  registrarLog("EDITAR_MOVIMENTACAO", "Movimentacao"),
  atualizarMovimentacao
);
router.put(
  "/financeiro-ponto",
  autenticar,
  registrarLog("ATUALIZAR_VALORES_FINANCEIROS_PONTO", "Movimentacao"),
  atualizarValoresFinanceirosPonto
);
router.put(
  "/:id/financeiro",
  autenticar,
  registrarLog("ATUALIZAR_VALORES_FINANCEIROS", "Movimentacao"),
  atualizarValoresFinanceiros
);
router.post(
  "/:id/machine-pay/valor-digital",
  autenticar,
  registrarLog("MACHINEPAY_BUSCAR_VALOR_DIGITAL", "Movimentacao"),
  buscarValorDigitalMachinePay
);
router.delete(
  "/:id",
  autenticar,
  autorizarRole("ADMIN"),
  registrarLog("DELETAR_MOVIMENTACAO", "Movimentacao"),
  deletarMovimentacao
);

export default router;
