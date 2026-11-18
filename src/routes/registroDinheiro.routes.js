import express from "express";
import registroDinheiroController from "../controllers/registroDinheiroController.js";
import { autenticar } from "../middlewares/auth.js";

// Trazido da AgarraMais (botão "Registrar dinheiro" da tela de Movimentações).
// Diferença: aqui POST e GET também exigem login (na AgarraMais estavam abertos).
const router = express.Router();

router.get("/machine-pay", autenticar, registroDinheiroController.consultarMachinePay);
router.get("/machine-pay-total", autenticar, registroDinheiroController.consultarMachinePayTotal);
router.post("/", autenticar, registroDinheiroController.criar);
router.get("/", autenticar, registroDinheiroController.listar);

export default router;
