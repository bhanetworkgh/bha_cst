-- Seed: vFarm System #1 — Known Customers
-- This seed file populates the customers table for local development and testing.
-- In production, customer records are synced from vFarm's Customer Registry API.
-- Run: psql $DATABASE_URL -f db/seeds/001_vfarm_customers.sql

INSERT INTO customers (tenant_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id)
VALUES
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+923082113844', '142d03f7-4b7e-4246-b999-70835e004f33',   'owner',   'unit_bay_01', 'farm_austin_main'),
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+15551234567',  'cust_vfarm_001_john_doe',    'manager', 'unit_bay_04', 'farm_austin_main'),
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+15558887777',  'cust_vfarm_002_alice_smith', 'tech',    'unit_bay_12', 'farm_austin_main')
ON CONFLICT (tenant_id, phone_e164) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      workspace_id    = EXCLUDED.workspace_id,
      customer_ref    = EXCLUDED.customer_ref,
      role            = EXCLUDED.role,
      unit_id         = EXCLUDED.unit_id,
      farm_id         = EXCLUDED.farm_id;
