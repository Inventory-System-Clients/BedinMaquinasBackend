import express from "express";
import { autenticar, autorizarRole } from "../middlewares/auth.js";
import {
  alertasContas,
  arquivarContaBancaria,
  atualizarConta,
  atualizarContaBancaria,
  atualizarLancamento,
  cancelarConta,
  criarContaBancaria,
  criarContas,
  criarLancamento,
  excluirConta,
  excluirLancamento,
  fluxoCaixa,
  listarClassificacoes,
  listarContas,
  listarContasBancarias,
  listarLancamentos,
  quitarConta,
  quitarContasLote,
  reabrirConta,
  resumoContas,
  resumoGeral,
} from "../controllers/gestaoContasController.js";

// Financeiro → Gestão de Contas. Mesmo acesso da aba Financeiro: ADMIN e FINANCEIRO.
const router = express.Router();
router.use(autenticar, autorizarRole("ADMIN", "FINANCEIRO"));

router.get("/resumo", resumoGeral);
router.get("/fluxo-caixa", fluxoCaixa);
router.get("/classificacoes", listarClassificacoes);

router.get("/contas", listarContas);
router.get("/contas/resumo", resumoContas);
router.get("/contas/alertas", alertasContas);
router.post("/contas", criarContas);
router.post("/contas/quitar-lote", quitarContasLote);
router.put("/contas/:id", atualizarConta);
router.post("/contas/:id/quitar", quitarConta);
router.post("/contas/:id/reabrir", reabrirConta);
router.post("/contas/:id/cancelar", cancelarConta);
router.delete("/contas/:id", excluirConta);

router.get("/bancos", listarContasBancarias);
router.post("/bancos", criarContaBancaria);
router.put("/bancos/:id", atualizarContaBancaria);
router.delete("/bancos/:id", arquivarContaBancaria);

router.get("/lancamentos", listarLancamentos);
router.post("/lancamentos", criarLancamento);
router.put("/lancamentos/:id", atualizarLancamento);
router.delete("/lancamentos/:id", excluirLancamento);

export default router;
