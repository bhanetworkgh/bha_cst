-- 012_customers_project_scope_and_vfarm_org_mapping.sql
--
-- Two corrections found while auditing CST user integration against a real,
-- migrated Postgres instance.
--
-- ── 1. G10: customers uniqueness must be per project, not per tenant ──────────
--
-- Migration 010 added `unq_customers_tenant_project_phone (tenant_id,
-- project_id, phone_e164)` but deliberately kept the older
-- `customers_tenant_id_phone_e164_key (tenant_id, phone_e164)` "for backwards
-- compat". That leftover constraint silently forbids the same E.164 number
-- appearing in two different projects of the same tenant, which is a supported
-- configuration: one person can be authorized in more than one project with
-- independent roles and farm scopes.
--
-- `DbClient.seedCustomer` also still used `ON CONFLICT (tenant_id, phone_e164)`,
-- targeting that stale constraint. Both are corrected here.
--
-- project_id is nullable, and in Postgres NULL never equals NULL, so the
-- composite constraint cannot deduplicate legacy NULL-project rows. A partial
-- unique index preserves uniqueness for those rows only, without blocking the
-- legitimate cross-project duplicates.

-- 1a. Backfill any remaining NULL project_id from the tenant's first project so
--     the composite constraint can actually apply. Best-effort and idempotent:
--     only affects rows that have no project at all.
UPDATE customers c
   SET project_id = p.project_id
  FROM projects p
 WHERE c.project_id IS NULL
   AND p.tenant_id = COALESCE(c.tenant_id, c.organization_id)
   AND p.project_id = (
     SELECT min(p2.project_id) FROM projects p2
      WHERE p2.tenant_id = COALESCE(c.tenant_id, c.organization_id)
   );

-- 1b. Drop the stale per-tenant uniqueness.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tenant_id_phone_e164_key;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_tenant_phone_e164_key;

-- 1c. Uniqueness for any residual NULL-project rows (partial: does not fire for
--     scoped rows, so cross-project duplicates remain allowed).
CREATE UNIQUE INDEX IF NOT EXISTS unq_customers_tenant_phone_null_project
  ON customers (tenant_id, phone_e164)
  WHERE project_id IS NULL;

-- 1d. Make sure the per-project constraint actually exists and is unique.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS unq_customers_tenant_project_phone;
ALTER TABLE customers ADD CONSTRAINT unq_customers_tenant_project_phone
  UNIQUE (tenant_id, project_id, phone_e164);


-- ── 2. G19: real vFarm organization ids ────────────────────────────────────────
--
-- `projects.tenant_org_id` held CST placeholders ('org-vfarm-austin',
-- 'org-vfarm-dallas') that match no vFarm organization. vFarm organization ids
-- are UUIDs and it answers HTTP 422 for the placeholders, so the live
-- cross-check in `pullSpeakers` could never run and speaker membership could
-- never be verified against the vFarm source of truth.
--
-- The id below was NOT invented: it was read from the live vFarm instance via
-- `GET /api/v1/organizations` (one organization exists: slug "default",
-- member_count 1, farms "Test 001" and "v-farm"). Override per environment with
--   SET cst.vfarm_org_id = '<uuid>';   before applying this file.
--
-- Both default CST projects roll up to that same vFarm organization, which is
-- what a single-organization vFarm deployment implies. A project with no
-- corresponding vFarm organization is left NULL rather than pointed at a
-- fabricated id, so `pullSpeakers` skips the live cross-check and warns instead
-- of silently reporting stale scope.

DO $$
DECLARE
  discovered_org_id CONSTANT TEXT := '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';
  real_org_id TEXT := COALESCE(
    NULLIF(current_setting('cst.vfarm_org_id', true), ''),
    discovered_org_id
  );
BEGIN
  RAISE NOTICE '012: repointing placeholder projects to vFarm org %', real_org_id;

  UPDATE projects
     SET tenant_org_id = real_org_id
   WHERE tenant_org_id IS NULL
      OR tenant_org_id IN ('org-vfarm-austin', 'org-vfarm-dallas');

  -- Backfill the in-code default shape so `GET /api/v1/admin/projects` and the
  -- Admin Panel's org selector agree with the database.
  RAISE NOTICE '012: tenant_org_id now % for all vFarm projects', real_org_id;
END
$$;