import { up, down } from "./src/database/migrations/add-tipo-pagamento-maquinas.js";

console.log("🚀 Executando migration de tipo de pagamento (comissão x aluguel)...\n");

try {
  await up();
  console.log("\n✅ Migration executada com sucesso!");
  console.log("\n1. Campo 'tipo_pagamento_loja' adicionado na tabela maquinas");
  console.log("2. Campo 'valor_aluguel' adicionado na tabela maquinas");
  console.log("3. Campo 'total_aluguel' adicionado na tabela comissoes_lojas");

  process.exit(0);
} catch (error) {
  console.error("\n❌ Erro ao executar migration:", error);
  console.error("\nPara reverter, rode a função down() deste script.");
  process.exit(1);
}
