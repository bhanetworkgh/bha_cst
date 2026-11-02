# CST Migration Reconciliation Report

**Report Date:** 2026-11-02
**Target Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`)
**Target Production Database:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`, Database `bha_cst_1sh0`, PostgreSQL 16)
**Repository:** `bhanetworkgh/bha_cst`
**Local Branch / HEAD:** `fix/monitoring-pay-gate-closure` @ `8f2940307e9c946ad7a3b8353ecf5f53368b9933`
**Deployed Production Commit:** `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23 Merge Commit, Deployment `dep-dbkh3p6417fc73bffihg`, live at `2026-11-02T22:43:32.077742Z`)

---

## 1. Executive Summary

All **24 SQL migration files** (`001` through `023`, including both `003` files) in [`db/migrations/`](../../db/migrations), [`scripts/migrate.js`](../../scripts/migrate.js), and [`scripts/migration_checks.js`](../../scripts/migration_checks.js) have been reconciled, verified locally against PostgreSQL 16 (`localhost:5432/bha_cst`), and **verified applied in production** on Render PostgreSQL (`dpg-db8he2qvcj2c73ado3s0-a/bha_cst_1sh0`) as of `2026-11-02 22:43:25.032521+00`:

1. **Duplicate `003` Migration Prefix & Divergent `customers` Schema Reconciled in Production (`023`):** Both [`003_add_customers_and_security_ledger.sql`](../../db/migrations/003_add_customers_and_security_ledger.sql) and [`003_customers_table.sql`](../../db/migrations/003_customers_table.sql) exist in `db/migrations/` and are recorded in `schema_migrations`. Because `003_add_customers_and_security_ledger.sql` sorts lexically before `003_customers_table.sql`, the `CREATE TABLE IF NOT EXISTS customers` statement in `003_customers_table.sql` was skipped on PostgreSQL. Forward-only migration [`023_reconcile_duplicate_003_and_schema_drift.sql`](../../db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql) added `customers.id VARCHAR(64) NOT NULL DEFAULT gen_random_uuid()::text`, `customers.updated_at TIMESTAMPTZ`, widened `unit_id`/`farm_id` to `VARCHAR(128)`, and switched `customers_pkey` from `(tenant_id, phone_e164)` to `PRIMARY KEY (id)` in production at `2026-11-02 22:43:25.032521+00`.
2. **Restored Canonical Checksums for `006` and `010`:** [`006_seed_initial_customers.sql`](../../db/migrations/006_seed_initial_customers.sql) (`sha256[0..32]`: `2aa49f8b129ce4d4d36344bbe8af3551`) and [`010_add_projects_bindings_and_project_id.sql`](../../db/migrations/010_add_projects_bindings_and_project_id.sql) (`sha256[0..32]`: `f1b17b26542e09626bdc8a21169bc8aa`) match the exact production `schema_migrations` ledger with zero checksum warnings on startup.
3. **Complete Schema Effect Checks (`001`–`023`):** [`scripts/migration_checks.js`](../../scripts/migration_checks.js) validates every table, column, constraint, and index across all 24 migrations.
4. **Fixed Parameter Indexing in `DbClient.expireCustomer`:** [`engine/src/db/client.ts`](../../engine/src/db/client.ts) correctly binds `$1`, `$2`, and `$3` whether `projectId` is provided or omitted.

---

## 2. Complete Inventory of All 24 Migration Files & Production Ledger Verification (`dpg-db8he2qvcj2c73ado3s0-a`)

Note: [`scripts/migrate.js`](../../scripts/migrate.js) stores `crypto.createHash('sha256').update(sql).digest('hex').slice(0, 32)` in `schema_migrations.checksum`. Both the 32-char SHA-256 ledger checksum and MD5 file checksum are listed below alongside the exact `applied_at` timestamp from the production database (`bha_cst_1sh0`):

| # | Version / Filename | Production `schema_migrations.checksum` (`sha256[0..32]`) | File MD5 Checksum | Production `applied_at` (UTC) | Primary Schema Effects |
|---|---|---|---|---|---|
| 1 | `001_initial_schema.sql` | `b6cfac9040da09a1ddd379079395af41` | `55444249eca3a8ab715a278c63e2f0e8` | `2026-10-16 20:54:51.946894+00` | Creates `systems`, `conversations`, `messages`, `messages_in`, `messages_out` |
| 2 | `002_add_missing_system_config_cols.sql` | `73a0e542ef8329dee37297776a9c0d60` | `1b6b5d3a7909995b5d0030b3d768db49` | `2026-10-16 20:54:51.946894+00` | Adds system config columns |
| 3a | `003_add_customers_and_security_ledger.sql` | `d8ae56d61cee51d59c64f135f5e3b378` | `7c93dd4d89a927df46d1cc9681dcdcbd` | `2026-10-16 20:54:51.946894+00` | Creates `customers` and `security_ledger` |
| 3b | `003_customers_table.sql` | `3d4b223d2baab356c346395a916626e2` | `990ecca2c6f6b48364cebeb91379799f` | `2026-10-16 20:54:51.946894+00` | Adds `idx_customers_phone`, `idx_customers_tenant_phone` |
| 4 | `004_add_role_to_customers.sql` | `38bd17f45c7f1342ceeb22064172dfae` | `2f6d96063b78fc261e1198cde49a628a` | `2026-10-16 20:54:51.946894+00` | Adds `customers.role` and check constraint |
| 5 | `005_add_organizations_and_workspaces.sql` | `99d5c7d0c7cbf21ed7febaab93a32aca` | `d0eb2e2f8d8a3e5a3b8bfc1481deeccb` | `2026-10-16 20:54:51.946894+00` | Creates `organizations` and `workspaces` |
| 6 | `006_seed_initial_customers.sql` | `2aa49f8b129ce4d4d36344bbe8af3551` | `6bd3841fe4e5af57b59b93bbe2f5614d` | `2026-10-16 20:54:51.946894+00` | Seeds `tenant-vfarm-01` and initial customer rows |
| 7 | `007_add_provider_sid_and_updated_at_to_messages_out.sql` | `326d02162ba6d9d761bf5bd170ea2390` | `31323e00ce89ec3d6e37380865f52cb3` | `2026-10-16 20:54:51.946894+00` | Adds `provider_sid`, `updated_at`, lease/claim columns to `messages_out` |
| 8 | `008_018m_alert_audit_log.sql` | `76e48f6a50779e74aae826905b8188c5` | `406b8a0bd8b42401a3be9c424e61da10` | `2026-10-16 20:54:51.946894+00` | Creates `alert_audit_log` |
| 9 | `009_add_voice_pointer_to_systems.sql` | `9c5f23366c297e847b554c21eab8b7db` | `068c0bb996d5bddd8909de9069f681ad` | `2026-10-16 20:54:51.946894+00` | Adds `systems.voice_pointer` |
| 10 | `010_add_projects_bindings_and_project_id.sql` | `f1b17b26542e09626bdc8a21169bc8aa` | `f5202e9c19b049abef4c14d1d1596832` | `2026-10-16 20:54:51.946894+00` | Creates `projects`, `service_number_bindings`, adds `project_id` |
| 11 | `011_admin_users.sql` | `9def72d87e3fc44f46ac46bd5a7cf37d` | `ab2e2579653b217cabe72109de797a6d` | `2026-10-16 20:54:51.946894+00` | Creates `admin_users` and `admin_sessions` |
| 12 | `012_customers_project_scope_and_vfarm_org_mapping.sql` | `07841fc807ebd9b6ecad853e2d8826ed` | `4387518c9831688bfca52c71e500f7c9` | `2026-10-16 20:54:51.946894+00` | Adds `unq_customers_tenant_project_phone` and `projects.tenant_org_id` |
| 13 | `013_messages_out_turn_id.sql` | `324eec186e099399ddefb831dc9edc31` | `ec1527b8a504e9396a5a94afe830c796` | `2026-10-16 20:54:51.946894+00` | Adds `messages_out.turn_id` |
| 14 | `014_messages_out_next_retry_at.sql` | `08e3346b513d063731dde851216b228b` | `88d1045123f90089cde3ed3b39225a29` | `2026-10-16 20:54:51.946894+00` | Adds `messages_out.next_retry_at` |
| 15 | `015_clear_fabricated_unit_and_farm_ids.sql` | `1c5327bd032bca670a68a766edb12e6b` | `9069d245edba976cc8da7ead8ede6746` | `2026-10-16 20:54:51.946894+00` | Clears legacy placeholder `unit_id`/`farm_id` |
| 16 | `016_sms_consent_spine.sql` | `68a30c0d9e12de7eb45521efde901581` | `85f6aa0e0ea726582ee7ebf2229e4168` | `2026-10-16 20:54:51.946894+00` | Creates `sms_consents` and `sms_consent_audit` |
| 17 | `017_sms_consent_audit_fk.sql` | `ca7c257cbc5cb9cfddd40a5548135a0a` | `fe068656114293e6010f854d8bc7a121` | `2026-10-16 20:54:51.946894+00` | Adds FK constraint on `sms_consent_audit` |
| 18 | `018_sms_consent_prompts.sql` | `bdb49cecae71a8b18a3b82be542c519b` | `8cfe718f580556a86f52e92123316f04` | `2026-10-16 20:54:51.946894+00` | Creates `sms_consent_prompts` |
| 19 | `019_backfill_project_voice_pointer.sql` | `c2f0c782b8eea0c3fc5453e1cb9de5cd` | `a1932b70a8490aed0927a4f2fe2ca71e` | `2026-10-19 20:42:37.542758+00` | Backfills `projects.voice_pointer` & creates `voice_deliveries` |
| 20 | `020_dashboard_publish_outcomes.sql` | `d9ea54e06704ae86080eab5a026279af` | `d2d236ac4203b72430e059582e429d7e` | `2026-10-20 14:43:08.532638+00` | Creates `dashboard_publish_outcomes` and indexes |
| 21 | `021_repair_service_number_bindings.sql` | `c8f65a18154c6e30d15b534933212449` | `c9b54676118000eaf7c72da116962b5b` | `2026-10-22 22:07:38.969346+00` | Repairs `service_number_bindings` for `+19715885823` |
| 22 | `022_add_escalations_table.sql` | `a9611f32573f3d86993a45bda10d9952` | `311ebf71a5be8ecd2fcb1cf94ecdd270` | `2026-10-28 17:02:14.122471+00` | Creates `escalations` table (14 columns, check constraint, 4 indexes) |
| 23 | `023_reconcile_duplicate_003_and_schema_drift.sql` | `b03c1e0c63eb12a771d7afaaf9d1452d` | `616d146e83a0da1d60c2ef62f63fcde7` | **`2026-11-02 22:43:25.032521+00`** | **Applied in PR #23 (`dep-dbkh3p6417fc73bffihg`):** Reconciles `customers` schema drift (`id`, `updated_at`, `PRIMARY KEY (id)`, `VARCHAR(128)` `unit_id`/`farm_id`) and updates `onboarding_reply` copy forward-only |

---

## 3. Local & Production PostgreSQL Verification Summary

1. **Production PostgreSQL (`dpg-db8he2qvcj2c73ado3s0-a/bha_cst_1sh0`):**
   - Verified 24 rows in `schema_migrations`, 21 public tables (`admin_sessions`, `admin_users`, `alert_audit_log`, `conversations`, `customers`, `dashboard_publish_outcomes`, `escalations`, `messages`, `messages_in`, `messages_out`, `organizations`, `projects`, `schema_migrations`, `security_ledger`, `service_number_bindings`, `sms_consent_audit`, `sms_consent_prompts`, `sms_consents`, `systems`, `voice_deliveries`, `workspaces`), `customers_pkey PRIMARY KEY (id)`, `escalations` table and indexes, and updated `onboarding_reply` greeting in `systems` and `projects`.
2. **Local PostgreSQL (`localhost:5432/bha_cst`):**
   ```text
   $ CST_DB_TESTS=1 DATABASE_URL=postgresql://localhost:5432/bha_cst npx vitest run tests/db/
    ✓ tests/db/schema_assertions.test.ts (12 tests)
    ✓ tests/db/db_client_persistence.test.ts (3 tests)
    ✓ tests/db/outbound_durability_invariants.test.ts (14 tests)
    ✓ tests/db/conversation_fk_integrity.test.ts (13 tests)
    ✓ tests/db/migration_ledger_adoption.test.ts (7 tests)
    Test Files  5 passed (5)
         Tests  49 passed (49)
   ```
