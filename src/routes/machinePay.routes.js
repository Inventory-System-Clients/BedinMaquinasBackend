import express from "express";
import {
  consultarStatusMaquinas,
  consultarFechamento,
  consultarTransacoes24h,
  descobrirUsrPorPosId,
  devolverPagamento,
  enviarCreditosMqtt,
  listarMaquinasMachinePay,
} from "../controllers/machinePayController.js";
import {
  autenticar,
  autorizarRole,
  registrarLog,
} from "../middlewares/auth.js";

const router = express.Router();

router.use(autenticar);

// Consultas - ADMIN e FINANCEIRO
router.get(
  "/maquinas",
  autorizarRole("ADMIN", "FINANCEIRO"),
  listarMaquinasMachinePay,
);
router.get(
  "/status",
  autorizarRole("ADMIN", "FINANCEIRO"),
  consultarStatusMaquinas,
);
router.get(
  "/fechamento",
  autorizarRole("ADMIN", "FINANCEIRO"),
  consultarFechamento,
);
router.get(
  "/maquinas/:id/transacoes-24h",
  autorizarRole("ADMIN", "FINANCEIRO"),
  consultarTransacoes24h,
);
router.get(
  "/descobrir-usr/:posId",
  autorizarRole("ADMIN", "FINANCEIRO"),
  descobrirUsrPorPosId,
);

// Ações sensíveis (mudam o painel real) - somente ADMIN
router.post(
  "/maquinas/:id/mqtt-creditos",
  autorizarRole("ADMIN"),
  registrarLog("MACHINEPAY_CREDITAR_MANUAL", "Maquina"),
  enviarCreditosMqtt,
);
router.post(
  "/pagamentos/:idwebhook/devolver",
  autorizarRole("ADMIN"),
  registrarLog("MACHINEPAY_DEVOLVER_PAGAMENTO", "Maquina"),
  devolverPagamento,
);

export default router;
