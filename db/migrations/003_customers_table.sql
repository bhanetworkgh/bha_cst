-- Migration 003: Customer Registry Table
-- Stores the phone-to-customer_ref identity mapping per Spec §3.
-- CST owns conversations. Identity (phone->customer_ref) lives in this table,
-- seeded from vFarm customer data. vFarm remains the source-of-truth; CST
-- caches the mapping here and re-resolves on incoming messages.

CREATE TABLE IF NOT EXISTS customers (
  id               VARCHAR(64)  PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id        VARCHAR(64)  NOT NULL REFERENCES systems(tenant_id) ON DELETE CASCADE,
  phone_e164       VARCHAR(32)  NOT NULL,
  customer_ref     VARCHAR(255) NOT NULL,   -- Opaque ID from the owning system (vFarm)
  unit_id          VARCHAR(128),            -- Associated hydroponic unit (optional)
  farm_id          VARCHAR(128),            -- Associated farm (optional)
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A phone number must be unique per tenant
  UNIQUE (tenant_id, phone_e164)
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_e164);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone ON customers(tenant_id, phone_e164);
