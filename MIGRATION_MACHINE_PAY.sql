-- ═══════════════════════════════════════════════════════════════════
-- MIGRATION - INTEGRAÇÃO MACHINE PAY (CYBERPIX)
-- Adiciona os IDs necessários para consultar/fechar caixa das máquinas
-- no painel Machine Pay (leitor PIX/cartão)
-- ═══════════════════════════════════════════════════════════════════

-- Adicionar colunas de integração Machine Pay na tabela maquinas
ALTER TABLE maquinas
ADD COLUMN IF NOT EXISTS machine_pay_pos_id VARCHAR(50) UNIQUE,
ADD COLUMN IF NOT EXISTS machine_pay_usr_id VARCHAR(50);

-- Adicionar comentários nas colunas
COMMENT ON COLUMN maquinas.machine_pay_pos_id IS 'ID do POS (leitor PIX/cartão) cadastrado no painel Machine Pay';
COMMENT ON COLUMN maquinas.machine_pay_usr_id IS 'ID da conta/cliente dona do posId no painel Machine Pay (opcional, pode ser descoberto automaticamente)';

-- ═══════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO
-- ═══════════════════════════════════════════════════════════════════

-- Verificar se as colunas foram criadas
SELECT
  column_name,
  data_type,
  is_nullable,
  COALESCE(col_description('maquinas'::regclass, ordinal_position), '') as description
FROM information_schema.columns
WHERE table_name = 'maquinas'
  AND column_name IN ('machine_pay_pos_id', 'machine_pay_usr_id')
ORDER BY column_name;

-- ═══════════════════════════════════════════════════════════════════
-- RESULTADO ESPERADO
-- ═══════════════════════════════════════════════════════════════════

SELECT
  '✅ Migration concluída!' as status,
  '2 novas colunas adicionadas na tabela maquinas' as resultado,
  'Agora cada máquina pode ser vinculada ao seu posId da Machine Pay' as observacao;
