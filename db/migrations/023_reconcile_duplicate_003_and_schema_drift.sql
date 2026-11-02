-- Migration: 023_reconcile_duplicate_003_and_schema_drift.sql
--
-- Forward-only reconciliation for:
--   1. Duplicate 003 prefix (`003_add_customers_and_security_ledger.sql` vs
--      `003_customers_table.sql`):
--      Because `003_add_customers_and_security_ledger.sql` sorts lexicographically
--      before `003_customers_table.sql`, its `CREATE TABLE IF NOT EXISTS customers`
--      runs first with `PRIMARY KEY (tenant_id, phone_e164)` and without `id` or
--      `updated_at`, making `003_customers_table.sql`'s `CREATE TABLE IF NOT EXISTS`
--      a silent no-op. In addition, the leftover `customers_pkey (tenant_id, phone_e164)`
--      was not dropped by migration 012, blocking a phone number from belonging to
--      multiple projects within the same tenant.
--   2. Forward-only onboarding reply update (previously edited in-place in 006 and
--      010 with an unescaped apostrophe, causing checksum drift and breaking fresh
--      database installations).
--
-- Idempotent and non-destructive: preserves all existing rows, foreign keys,
-- indexes, and historical migration ledger entries.

-- ── 1. Ensure security_ledger exists (from 003_add_customers_and_security_ledger.sql) ──

CREATE TABLE IF NOT EXISTS security_ledger (
  id             VARCHAR(64)  PRIMARY KEY,
  timestamp      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id      VARCHAR(64),
  actor          VARCHAR(255) NOT NULL,
  role           VARCHAR(64)  NOT NULL,
  entry_point    VARCHAR(64)  NOT NULL,
  tool_or_route  VARCHAR(255) NOT NULL,
  outcome        VARCHAR(32)  NOT NULL,
  reason         TEXT         NOT NULL,
  correlation_id VARCHAR(128),
  tripwire       BOOLEAN      DEFAULT FALSE,
  level          VARCHAR(16)  NOT NULL DEFAULT 'INFO'
);

CREATE INDEX IF NOT EXISTS idx_security_ledger_tenant ON security_ledger(tenant_id);

-- ── 2. Reconcile customers columns skipped when 003_customers_table.sql was a no-op ──

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS id VARCHAR(64) DEFAULT gen_random_uuid()::text;

UPDATE customers
   SET id = gen_random_uuid()::text
 WHERE id IS NULL;

ALTER TABLE customers
  ALTER COLUMN id SET DEFAULT gen_random_uuid()::text,
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE customers
  ALTER COLUMN unit_id TYPE VARCHAR(128),
  ALTER COLUMN farm_id TYPE VARCHAR(128);

-- ── 3. Reconcile customers primary key so (id) is PK and project-scoped uniqueness holds ──

DO $$
DECLARE
  pk_cols TEXT;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO pk_cols
    FROM pg_constraint c
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.conrelid = 'public.customers'::regclass
     AND c.contype = 'p';

  IF pk_cols IS DISTINCT FROM 'id' THEN
    IF pk_cols IS NOT NULL THEN
      ALTER TABLE customers DROP CONSTRAINT customers_pkey;
    END IF;
    ALTER TABLE customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
  END IF;
END
$$;

-- Ensure project-scoped uniqueness and indexes from 003 / 010 / 012 remain intact
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_e164);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone ON customers(tenant_id, phone_e164);

CREATE UNIQUE INDEX IF NOT EXISTS unq_customers_tenant_phone_null_project
  ON customers (tenant_id, phone_e164)
  WHERE project_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.customers'::regclass
       AND conname = 'unq_customers_tenant_project_phone'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT unq_customers_tenant_project_phone
      UNIQUE (tenant_id, project_id, phone_e164);
  END IF;
END
$$;

-- ── 4. Forward-only onboarding greeting update (replaces in-place 006/010 drift) ──

UPDATE systems
   SET onboarding_reply = 'Hi, thanks for calling vFarm Support. I''m here to help. What would you like to check today?'
 WHERE system_id = 'system-vfarm-01'
   AND (onboarding_reply IS NULL
        OR onboarding_reply = 'Welcome to vFarm Support! We received your message. A specialist will assist you shortly.');

UPDATE projects
   SET onboarding_reply = 'Hi, thanks for calling vFarm Support. I''m here to help. What would you like to check today?',
       updated_at = CURRENT_TIMESTAMP
 WHERE project_id = 'proj-vfarm-main'
   AND (onboarding_reply IS NULL
        OR onboarding_reply = 'Welcome to vFarm Support! We received your message. A specialist will assist you shortly.');

