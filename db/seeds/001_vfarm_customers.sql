-- Seed: vFarm System #1 — Known Customers
-- This seed file populates the customers table for local development and testing.
-- In production, customer records are synced from vFarm's Customer Registry API.
-- Run: psql $DATABASE_URL -f db/seeds/001_vfarm_customers.sql

INSERT INTO customers (tenant_id, phone_e164, customer_ref, unit_id, farm_id)
VALUES
  ('tenant-vfarm-01', '+923082113844', 'cust_vfarm_003_test_user',    'unit_bay_01', 'farm_austin_main'),
  ('tenant-vfarm-01', '+15551234567',  'cust_vfarm_001_john_doe',     'unit_bay_04', 'farm_austin_main'),
  ('tenant-vfarm-01', '+15558887777',  'cust_vfarm_002_alice_smith',  'unit_bay_12', 'farm_austin_main')
ON CONFLICT (tenant_id, phone_e164) DO UPDATE
  SET customer_ref = EXCLUDED.customer_ref,
      unit_id      = EXCLUDED.unit_id,
      farm_id      = EXCLUDED.farm_id,
      updated_at   = CURRENT_TIMESTAMP;
