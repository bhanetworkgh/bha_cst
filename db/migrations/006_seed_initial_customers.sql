-- Migration: 006_seed_initial_customers.sql
-- Seeds initial known customers for System #1 (vFarm) into production / Render database.
-- Ensures numbers like +923082113844 have the correct role and unit assigned on deploy.

INSERT INTO customers (tenant_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id)
VALUES
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+923082113844', 'cust_vfarm_003_test_user',   'owner',   'unit_bay_01', 'farm_austin_main'),
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+15551234567',  'cust_vfarm_001_john_doe',    'manager', 'unit_bay_04', 'farm_austin_main'),
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+15558887777',  'cust_vfarm_002_alice_smith', 'tech',    'unit_bay_12', 'farm_austin_main')
ON CONFLICT (tenant_id, phone_e164) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      workspace_id    = EXCLUDED.workspace_id,
      customer_ref    = EXCLUDED.customer_ref,
      role            = EXCLUDED.role,
      unit_id         = EXCLUDED.unit_id,
      farm_id         = EXCLUDED.farm_id;
