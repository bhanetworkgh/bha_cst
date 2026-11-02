# CST — Production Migration Verification & Governance Runbook (For Jason)

**Date:** 2026-11-02
**Target Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`)
**Target Database:** Render Production PostgreSQL (`bha-cst-postgres`, `dpg-db8he2qvcj2c73ado3s0-a`, Database `bha_cst_1sh0`, PostgreSQL 16)
**Verified Production Deployment:** `dep-dbkh3p6417fc73bffihg` (PR #23 Merge Commit `441d2b3f4a49c983f45131c229888a60116b9437`, merging `8f2940307e9c946ad7a3b8353ecf5f53368b9933`, live at `2026-11-02T22:43:32.077742Z`)
**Status:** **`VERIFIED IN PRODUCTION` — All 24 Migrations (`001`–`023`) Applied & Confirmed on Render PostgreSQL**

---

## 1. Executive Summary & Verification Evidence

Render's configured `startCommand` for `bha-cst` (`srv-db8hepqvcj2c73adpus0`) is:

```bash
node scripts/migrate.js && npm start
```

When PR #23 (`441d2b3f4a49c983f45131c229888a60116b9437`) deployed in `dep-dbkh3p6417fc73bffihg` at `2026-11-02T22:43:24Z`, `node scripts/migrate.js` executed automatically on container startup and applied [`db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql`](../../db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql) cleanly (`1 applied, 23 already recorded, 0 checksum warnings`).

Read-only inspection of both Render startup logs and the live Render PostgreSQL database (`dpg-db8he2qvcj2c73ado3s0-a/bha_cst_1sh0`, queried with `SET default_transaction_read_only = on;`) confirms:

1. **`022_add_escalations_table.sql`** (`sha256[0..32]`: `a9611f32573f3d86993a45bda10d9952`, `md5`: `311ebf71a5be8ecd2fcb1cf94ecdd270`) was applied in production at **`2026-10-28 17:02:14.122471+00`**.
2. **`023_reconcile_duplicate_003_and_schema_drift.sql`** (`sha256[0..32]`: `b03c1e0c63eb12a771d7afaaf9d1452d`, `md5`: `616d146e83a0da1d60c2ef62f63fcde7`) was applied in production at **`2026-11-02 22:43:25.032521+00`**.
3. **Zero pending migrations remain in production.** All 24 migration files in [`db/migrations/`](../../db/migrations) are recorded in `schema_migrations` with exact matching checksums.

---

## 2. Production Database Verification Details (`dpg-db8he2qvcj2c73ado3s0-a`)

### 2.1 `escalations` Table (`022_add_escalations_table.sql`)
- **Columns Verified (14):** `id`, `caller_phone`, `tenant_id`, `project_id`, `conversation_id`, `correlation_id`, `caller_email`, `reason`, `transcript`, `slack_notified`, `slack_notified_at`, `slack_error`, `created_at`, `status`.
- **Constraints & Indexes Verified:** `escalations_pkey PRIMARY KEY (id)`, `ck_escalation_status CHECK (status IN ('pending', 'notified', 'failed'))`, `idx_escalations_correlation`, `idx_escalations_tenant`, `idx_escalations_status`, `idx_escalations_caller_phone`.

### 2.2 `customers` Table (`023_reconcile_duplicate_003_and_schema_drift.sql`)
- **Columns Verified (14):** `tenant_id`, `phone_e164`, `customer_ref`, `first_name`, `last_name`, `unit_id` (`VARCHAR(128)`), `farm_id` (`VARCHAR(128)`), `status`, `expires_at`, `created_at`, `role`, `project_id`, `id` (`VARCHAR(64) NOT NULL DEFAULT (gen_random_uuid())::text`), `updated_at` (`TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`).
- **Constraints Verified:**
  - `customers_pkey PRIMARY KEY (id)` (reconciled from composite `(tenant_id, phone_e164)`)
  - `customers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES systems(tenant_id)`
  - `unq_customers_tenant_project_phone UNIQUE (tenant_id, project_id, phone_e164)`
  - `customers_role_check CHECK (role IN ('owner', 'manager', 'tech', 'viewer'))`
- **Production Customer Rows Verified:** 3 rows (`+1555***4567` `manager`, `+1555***7777` `tech`, `+9230***3844` `owner`), all populated with UUID `id` and `updated_at = 2026-11-02T22:43:25.032Z`.

### 2.3 Greeting Copy in `systems` and `projects` (`023_reconcile_duplicate_003_and_schema_drift.sql`)
- `systems` (`tenant-vfarm-01`) and `projects` (`proj-vfarm-main`) both verified in production with:
  ```text
  Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?
  ```

---

## 3. Mandatory Governance & Safety Runbook for Future Migrations

Future production database migrations must not be assumed risk-free simply because `node scripts/migrate.js` executes automatically during Render startup. The following multi-step governance policy must be followed for any future schema change:

### Step 1 — Pre-Migration Backup Requirement
Before merging or deploying any PR that contains a new SQL migration file:
- Create a verified logical database backup using PostgreSQL tools:
  ```bash
  pg_dump -Fc "$DATABASE_URL" > "cst_pre_migration_backup_$(date +%Y%m%d_%H%M%S).dump"
  ```
- Verify the backup file size and integrity before proceeding with deployment.

### Step 2 — Staging Dry-Run & Locking Review
- Review SQL statements for lock duration risks:
  - Avoid statements that acquire an `ACCESS EXCLUSIVE` lock on high-traffic tables (`messages_out`, `conversations`).
  - Use `CREATE INDEX CONCURRENTLY` outside transactional blocks when indexing large tables.
  - Test migration execution against a staging PostgreSQL 16 database loaded with production-like data volume.

### Step 3 — Forward-Only & Idempotent SQL Design
- Write all migrations forward-only and defensively (`IF NOT EXISTS`, `IF EXISTS`).
- Ensure every migration runs under PostgreSQL advisory locking (`pg_advisory_lock(812345671)`) inside [scripts/migrate.js](../../scripts/migrate.js) to avoid race conditions during overlapping Render rolling deployments.

### Step 4 — Rollback & Disaster Recovery Procedures
- Because forward-only migrations avoid destructive drops, if a migration fails during container startup:
  1. The Render container startup will abort, preventing the deployment of a mismatched application version.
  2. If a migration is applied but introduces an application regression, prepare a compensating forward-only migration (e.g., `024_compensate_...sql`) rather than attempting manual in-place schema edits or ledger deletion.
  3. If data corruption occurs, restore from the pre-migration logical dump taken in Step 1.

### Step 5 — Post-Migration Validation Protocol
Immediately upon container boot after a migration:
1. Check Render logs to verify clean execution:
   ```text
   ✓ Successfully applied: 0XX_...
   🎉 Migrations complete: X applied, Y already recorded.
   ```
2. Verify table and column definitions in `information_schema.columns`.
3. Inspect `schema_migrations` to confirm recorded checksums.
4. Run the read-only production test suite ([scripts/test-prod-all-endpoints.sh](../../scripts/test-prod-all-endpoints.sh)) to confirm zero regressions across all public and admin API endpoints.
