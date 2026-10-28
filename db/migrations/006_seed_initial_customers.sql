-- Migration: 006_seed_initial_customers.sql
-- Seeds initial known customers for System #1 (vFarm) into production / Render database.
-- Ensures numbers like +923082113844 have the correct role and unit assigned on deploy.
--
-- The FK parent this seed depends on (`systems.tenant_id = 'tenant-vfarm-01'`,
-- enforced by `customers_tenant_id_fkey`) is created here as well. `systems` is
-- otherwise populated only at application runtime by SystemsRegistry, which means
-- a fresh database could never finish migrating: 006 always failed with
-- "insert or update on table customers violates foreign key constraint
-- customers_tenant_id_fkey", and because render.yaml runs
-- `node scripts/migrate.js && npm start`, that was a boot failure. The row below
-- is the same one SystemsRegistry inserts, and both use
-- ON CONFLICT (system_id) DO UPDATE, so they converge rather than conflict.
INSERT INTO systems (system_id, tenant_id, organization_id, name, status, phone_numbers, onboarding_reply)
VALUES ('system-vfarm-01', 'tenant-vfarm-01', 'tenant-vfarm-01', 'vFarm System', 'active', '[]'::jsonb,
        'Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?')
ON CONFLICT (system_id) DO UPDATE SET
  tenant_id    = EXCLUDED.tenant_id,
  organization_id = EXCLUDED.organization_id,
  name         = EXCLUDED.name,
  status       = EXCLUDED.status;

-- unit_id / farm_id are left NULL deliberately.
--
-- They previously held invented values ('unit_bay_01', 'farm_austin_main', …).
-- Real vFarm ids are UUIDs and vFarm exposes no user -> unit/zone/location
-- assignment, so those strings identified units and farms that do not exist;
-- the adapter already removed its hardcoded `unit_bay_04` for exactly that
-- reason. `customers.unit_id` is never read to build a unit context — the only
-- unit id CST trusts is `speaker.unit_context.unit_id`, which the adapter omits
-- unless vFarm supplies one — so this is dead data, and inventing it is worse
-- than leaving it empty. Farm authorization comes from the live
-- `GET /api/v1/users/{user_id}/farm-grants` lookup, never from this column.
INSERT INTO customers (tenant_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id)
VALUES
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+923082113844', 'cust_vfarm_003_test_user',   'owner',   NULL, NULL),
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+15551234567',  'cust_vfarm_001_john_doe',    'manager', NULL, NULL),
  ('tenant-vfarm-01', 'tenant-vfarm-01', 'ws-vfarm-main', '+15558887777',  'cust_vfarm_002_alice_smith', 'tech',    NULL, NULL)
ON CONFLICT (tenant_id, phone_e164) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      workspace_id    = EXCLUDED.workspace_id,
      customer_ref    = EXCLUDED.customer_ref,
      role            = EXCLUDED.role,
      unit_id         = EXCLUDED.unit_id,
      farm_id         = EXCLUDED.farm_id;
