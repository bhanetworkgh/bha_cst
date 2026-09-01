-- Migration: 004_add_role_to_customers.sql
-- Adds role column to customers table with default 'manager'

ALTER TABLE customers ADD COLUMN IF NOT EXISTS role VARCHAR(32) NOT NULL DEFAULT 'manager';

-- Index to optimize server-side identity resolution by tenant and phone
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone ON customers(tenant_id, phone_e164);
