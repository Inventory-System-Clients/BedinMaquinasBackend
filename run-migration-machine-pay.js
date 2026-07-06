import pkg from "pg";
const { Client } = pkg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL não configurada!");
  console.log("Configure a variável de ambiente DATABASE_URL");
  process.exit(1);
}

async function runMigration() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  try {
    console.log("🔌 Conectando ao banco de dados...");
    await client.connect();
    console.log("✅ Conectado!");

    console.log("\n📝 Adicionando colunas de integração Machine Pay...");

    await client.query(`
      ALTER TABLE maquinas
      ADD COLUMN IF NOT EXISTS machine_pay_pos_id VARCHAR(50) UNIQUE,
      ADD COLUMN IF NOT EXISTS machine_pay_usr_id VARCHAR(50);
    `);
    console.log("✅ Colunas adicionadas!");

    console.log("\n📝 Adicionando comentários...");
    await client.query(`
      COMMENT ON COLUMN maquinas.machine_pay_pos_id IS 'ID do POS (leitor PIX/cartão) cadastrado no painel Machine Pay';
    `);
    await client.query(`
      COMMENT ON COLUMN maquinas.machine_pay_usr_id IS 'ID da conta/cliente dona do posId no painel Machine Pay (opcional, pode ser descoberto automaticamente)';
    `);
    console.log("✅ Comentários adicionados!");

    console.log("\n🔍 Verificando colunas criadas...");
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'maquinas'
        AND column_name IN ('machine_pay_pos_id', 'machine_pay_usr_id')
      ORDER BY column_name;
    `);

    console.log("\n📊 Colunas encontradas:");
    result.rows.forEach((row) => {
      console.log(`  ✓ ${row.column_name} (${row.data_type})`);
    });

    console.log("\n✅ Migration concluída com sucesso!");
    console.log("🎉 Agora as máquinas podem ser vinculadas ao posId da Machine Pay!");
  } catch (error) {
    console.error("\n❌ Erro ao executar migration:", error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
