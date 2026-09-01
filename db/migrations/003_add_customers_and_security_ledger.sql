-- Migration: 003_add_customers_and_security_ledger.sql
-- Adds cached customer projections table, unique constraint on conversations, and immutable security ledger audit table.

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS unq_conversations_tenant_customer;
ALTER TABLE conversations ADD CONSTRAINT unq_conversations_tenant_customer UNIQUE (tenant_id, customer_ref);

CREATE TABLE IF NOT EXISTS customers (
  tenant_id VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  phone_e164 VARCHAR(32) NOT NULL,
  customer_ref VARCHAR(255) NOT NULL,
  unit_id VARCHAR(64),
  farm_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS security_ledger (
  id VARCHAR(64) PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id VARCHAR(64),
  actor VARCHAR(255) NOT NULL,
  role VARCHAR(64) NOT NULL,
  entry_point VARCHAR(64) NOT NULL,
  tool_or_route VARCHAR(255) NOT NULL,
  outcome VARCHAR(32) NOT NULL,
  reason TEXT NOT NULL,
  correlation_id VARCHAR(128),
  tripwire BOOLEAN DEFAULT FALSE,
  level VARCHAR(16) NOT NULL DEFAULT 'INFO'
);

CREATE INDEX IF NOT EXISTS idx_security_ledger_tenant ON security_ledger(tenant_id);
