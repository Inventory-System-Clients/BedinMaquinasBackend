import express from "express";
import { lerContadoresPorImagem } from "../controllers/assistenteIaController.js";
import { autenticar } from "../middlewares/auth.js";

// Trazido da AgarraMais: leitura dos contadores por foto (tela de Movimentações).
const router = express.Router();

router.post("/ler-contadores", autenticar, lerContadoresPorImagem);

export default router;
