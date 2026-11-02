# CST — Production Migration Approval Plan (For Jason)

**Date:** 2026-11-02
**Target Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`)
**Target Database:** Render Production PostgreSQL (`DATABASE_URL` configured on `bha-cst`)
**Migrations Pending Execution in Production:**
1. [`db/migrations/022_add_escalations_table.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/022_add_escalations_table.sql) (Checksum: `311ebf71a5be8ecd2fcb1cf94ecdd270`)
2. [`db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql) (Checksum: `616d146e83a0da1d60c2ef62f63fcde7`)

---

## 1. Why Production Migration Execution Is Required

1. **Render Start Command Does Not Auto-Migrate:**
   - On Render (`bha-cst`), the start command runs `npm start` (`node dist/index.js`) and does not run `npm run db:migrate` (`node scripts/migrate.js`) automatically on container boot.
2. **Impact of Unapplied `022_add_escalations_table.sql` in Production:**
   - PR #21 and PR #22 (`fa701a3f7e2a4c642307d018f9a4a123cc6007d3`) deployed [`EscalationService`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/escalation/service.ts) and [`DbClient.createEscalationRecord`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/db/client.ts#L2331-L2485), which insert into the `escalations` table when a caller requests human assistance. Until `022` is applied on Render PostgreSQL, live escalation persistence will fail on the missing `escalations` relation.
3. **Impact of Unapplied `023_reconcile_duplicate_003_and_schema_drift.sql` in Production:**
   - Reconciles the schema drift between `003_add_customers_and_security_ledger.sql` (`7c93dd4d89a927df46d1cc9681dcdcbd`) and `003_customers_table.sql` (`990ecca2c6f6b48364cebeb91379799f`) by adding `customers.id`, `customers.updated_at`, widening `unit_id`/`farm_id` to `VARCHAR(128)`, and replacing `PRIMARY KEY (tenant_id, phone_e164)` with `PRIMARY KEY (id)` so multi-project customer registration under `012` works cleanly.
   - Updates `systems.onboarding_reply` and `projects.onboarding_reply` for `tenant-vfarm-01` / `proj-vfarm-main` forward-only without mutating historical migrations `006` (`6bd3841fe4e5af57b59b93bbe2f5614d`) and `010` (`f5202e9c19b049abef4c14d1d1596832`).

---

## 2. Safety & Idempotency Guarantees

Both [`022_add_escalations_table.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/022_add_escalations_table.sql) and [`023_reconcile_duplicate_003_and_schema_drift.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql) are **100% forward-only, non-destructive, and idempotent**:
- **Zero data deletion:** Neither migration drops any table, column, or row.
- **Transactional execution:** [`scripts/migrate.js`](file:///Users/HaMi/Documents/Jason/customer%20twin/scripts/migrate.js) wraps each migration in a `BEGIN ... COMMIT` transaction and acquires PostgreSQL session advisory lock `pg_advisory_lock(72839451)`.
- **Verified locally on PostgreSQL 16 (`localhost:5432/bha_cst`):** Tested against both a fresh database and an existing pre-`022` database in [`tests/db/migration_ledger_adoption.test.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/db/migration_ledger_adoption.test.ts) (`5 test files passed, 49 tests passed`).

---

## 3. Step-by-Step Execution Runbook (Upon Jason's Approval)

### Step 1 — Pre-Migration Read-Only Inspection
Run from the Render Shell on `bha-cst` (or an authorized operator workstation with production `DATABASE_URL`):
```bash
psql "$DATABASE_URL" -c "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version;"
psql "$DATABASE_URL" -c "SELECT to_regclass('public.escalations') AS escalations_table;"
psql "$DATABASE_URL" -c "SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'customers' ORDER BY ordinal_position;"
```

### Step 2 — Merge PR Containing `023` and Execute `npm run db:migrate`
Once the current branch (`fix/monitoring-pay-gate-closure`) containing `023_reconcile_duplicate_003_and_schema_drift.sql` and restored `006`/`010` checksums is merged and deployed to `bha-cst`, execute:
```bash
npm run db:migrate
```
Expected output:
```text
[migrate] Applying 022_add_escalations_table.sql...
[migrate] Applied 022_add_escalations_table.sql
[migrate] Applying 023_reconcile_duplicate_003_and_schema_drift.sql...
[migrate] Applied 023_reconcile_duplicate_003_and_schema_drift.sql
[migrate] Summary: applied=2, adopted=0, skipped=22, warnings=0
```

### Step 3 — Post-Migration Verification
```bash
psql "$DATABASE_URL" -c "SELECT version, checksum, applied_at FROM schema_migrations WHERE version IN ('022_add_escalations_table.sql', '023_reconcile_duplicate_003_and_schema_drift.sql');"
psql "$DATABASE_URL" -c "SELECT to_regclass('public.escalations') AS escalations_table;"
```
