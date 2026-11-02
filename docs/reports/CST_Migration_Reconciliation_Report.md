# CST Migration Reconciliation Report

**Report Date:** 2026-11-02
**Target Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`)
**Repository:** `bhanetworkgh/bha_cst`
**Local Branch / HEAD:** `fix/monitoring-pay-gate-closure` @ `dd7130879eef1e5e00f5645bb18bd602e234d8f7`
**Deployed Production Commit:** `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` (PR #22, Deployment `dep-dbkgavp5efls73ag1olg`)

---

## 1. Executive Summary

A full audit and local PostgreSQL verification (`localhost:5432/bha_cst`) of all 24 SQL migration files (`001` through `023`, including both `003` files) in [`db/migrations/`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations), [`scripts/migrate.js`](file:///Users/HaMi/Documents/Jason/customer%20twin/scripts/migrate.js), and [`scripts/migration_checks.js`](file:///Users/HaMi/Documents/Jason/customer%20twin/scripts/migration_checks.js) identified four critical issues that have been remediated locally using strict forward-only migration hygiene:

1. **Duplicate `003` Migration Prefix & Divergent `customers` Schema:** Both [`003_add_customers_and_security_ledger.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/003_add_customers_and_security_ledger.sql) and [`003_customers_table.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/003_customers_table.sql) exist in `db/migrations/` and are recorded in `schema_migrations`. Because `003_add_customers_and_security_ledger.sql` sorts lexically before `003_customers_table.sql`, the `CREATE TABLE IF NOT EXISTS customers` statement in `003_customers_table.sql` was skipped on PostgreSQL, leaving `customers` without `id VARCHAR(64)`, without `updated_at TIMESTAMPTZ`, with `VARCHAR(64)` instead of `VARCHAR(128)` for `unit_id`/`farm_id`, and with `customers_pkey PRIMARY KEY (tenant_id, phone_e164)` blocking multi-project customer registration under [`012_customers_project_scope_and_vfarm_org_mapping.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/012_customers_project_scope_and_vfarm_org_mapping.sql).
2. **In-Place Edits & Unescaped Single Quotes in `006` and `010`:** Commit `e9075a3` edited [`006_seed_initial_customers.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/006_seed_initial_customers.sql) and [`010_add_projects_bindings_and_project_id.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/010_add_projects_bindings_and_project_id.sql) in place and introduced an unescaped apostrophe (`'Hi, thanks for calling vFarm Support. I'm here to help...'`), breaking fresh PostgreSQL migrations (`syntax error at or near "m"`) and causing checksum mismatch warnings against already-migrated databases.
3. **Incomplete Schema Effect Check for `020` and `022`:** [`scripts/migration_checks.js`](file:///Users/HaMi/Documents/Jason/customer%20twin/scripts/migration_checks.js) checked non-existent index names for `020_dashboard_publish_outcomes.sql` and only checked table existence for `022_add_escalations_table.sql`.
4. **Parameter Indexing Bug in `DbClient.expireCustomer`:** [`engine/src/db/client.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/db/client.ts#L1806-L1814) had swapped `$2` and `$3` placeholders when `projectId` was omitted.

---

## 2. Complete Inventory of All 24 Migration Files (`001`–`023`)

| # | Filename | Canonical MD5 Checksum | Ledger Version Key | Primary Schema Effects |
|---|---|---|---|---|
| 1 | `001_initial_schema.sql` | `55444249eca3a8ab715a278c63e2f0e8` | `001_initial_schema.sql` | Creates `systems`, `conversations`, `messages`, `voice_deliveries`, `tool_calls`, `audit_log` |
| 2 | `002_add_missing_system_config_cols.sql` | `1b6b5d3a7909995b5d0030b3d768db49` | `002_add_missing_system_config_cols.sql` | Adds system configuration columns (`messaging_service_sid`, `media_base_url`, `escalation_rules`, `routing_rules`) |
| 3a | `003_add_customers_and_security_ledger.sql` | `7c93dd4d89a927df46d1cc9681dcdcbd` | `003_add_customers_and_security_ledger.sql` | Creates `customers` (`PRIMARY KEY (tenant_id, phone_e164)`) and `security_ledger` |
| 3b | `003_customers_table.sql` | `990ecca2c6f6b48364cebeb91379799f` | `003_customers_table.sql` | Defines `customers` (`id VARCHAR(64) PRIMARY KEY`, `updated_at`, `VARCHAR(128)` `unit_id`/`farm_id`), `idx_customers_phone`, `idx_customers_tenant_phone` |
| 4 | `004_add_role_to_customers.sql` | `2f6d96063b78fc261e1198cde49a628a` | `004_add_role_to_customers.sql` | Adds `role` column and check constraint to `customers` |
| 5 | `005_add_organizations_and_workspaces.sql` | `d0eb2e2f8d8a3e5a3b8bfc1481deeccb` | `005_add_organizations_and_workspaces.sql` | Creates `organizations` and `workspaces` tables |
| 6 | `006_seed_initial_customers.sql` | `6bd3841fe4e5af57b59b93bbe2f5614d` | `006_seed_initial_customers.sql` | Seeds `tenant-vfarm-01` in `systems` and initial customer rows (restored to canonical pre-`e9075a3` checksum) |
| 7 | `007_add_provider_sid_and_updated_at_to_messages_out.sql` | `31323e00ce89ec3d6e37380865f52cb3` | `007_add_provider_sid_and_updated_at_to_messages_out.sql` | Creates/updates `messages_out` with `provider_sid`, `updated_at`, lease/claim columns |
| 8 | `008_018m_alert_audit_log.sql` | `406b8a0bd8b42401a3be9c424e61da10` | `008_018m_alert_audit_log.sql` | Creates `alert_audit_log` with FK to `messages_out` |
| 9 | `009_add_voice_pointer_to_systems.sql` | `068c0bb996d5bddd8909de9069f681ad` | `009_add_voice_pointer_to_systems.sql` | Adds `voice_pointer` configuration to `systems` |
| 10 | `010_add_projects_bindings_and_project_id.sql` | `f5202e9c19b049abef4c14d1d1596832` | `010_add_projects_bindings_and_project_id.sql` | Creates `projects`, `service_number_bindings`, adds `project_id` across tenant tables (restored to canonical pre-`e9075a3` checksum) |
| 11 | `011_admin_users.sql` | `ab2e2579653b217cabe72109de797a6d` | `011_admin_users.sql` | Creates `admin_users` and `admin_sessions` tables |
| 12 | `012_customers_project_scope_and_vfarm_org_mapping.sql` | `4387518c9831688bfca52c71e500f7c9` | `012_customers_project_scope_and_vfarm_org_mapping.sql` | Adds `unq_customers_tenant_project_phone` and `projects.tenant_org_id` |
| 13 | `013_messages_out_turn_id.sql` | `ec1527b8a504e9396a5a94afe830c796` | `013_messages_out_turn_id.sql` | Adds `turn_id` to `messages_out` |
| 14 | `014_messages_out_next_retry_at.sql` | `88d1045123f90089cde3ed3b39225a29` | `014_messages_out_next_retry_at.sql` | Adds `next_retry_at` and delivery retry columns to `messages_out` |
| 15 | `015_clear_fabricated_unit_and_farm_ids.sql` | `9069d245edba976cc8da7ead8ede6746` | `015_clear_fabricated_unit_and_farm_ids.sql` | Clears legacy placeholder `unit_id`/`farm_id` values |
| 16 | `016_sms_consent_spine.sql` | `85f6aa0e0ea726582ee7ebf2229e4168` | `016_sms_consent_spine.sql` | Creates `sms_consents` and `sms_consent_audit` tables |
| 17 | `017_sms_consent_audit_fk.sql` | `fe068656114293e6010f854d8bc7a121` | `017_sms_consent_audit_fk.sql` | Adds FK constraint on `sms_consent_audit` |
| 18 | `018_sms_consent_prompts.sql` | `8cfe718f580556a86f52e92123316f04` | `018_sms_consent_prompts.sql` | Adds consent prompt tracking columns |
| 19 | `019_backfill_project_voice_pointer.sql` | `a1932b70a8490aed0927a4f2fe2ca71e` | `019_backfill_project_voice_pointer.sql` | Backfills `projects.voice_pointer` |
| 20 | `020_dashboard_publish_outcomes.sql` | `d2d236ac4203b72430e059582e429d7e` | `020_dashboard_publish_outcomes.sql` | Creates `dashboard_publish_outcomes` and indexes (`idx_dashboard_publish_outcomes_status`, `idx_dashboard_publish_outcomes_created`, `unq_dashboard_publish_outcomes_event`) |
| 21 | `021_repair_service_number_bindings.sql` | `c9b54676118000eaf7c72da116962b5b` | `021_repair_service_number_bindings.sql` | Repairs `service_number_bindings` for `+19715885823` |
| 22 | `022_add_escalations_table.sql` | `311ebf71a5be8ecd2fcb1cf94ecdd270` | `022_add_escalations_table.sql` | Creates `escalations` table (14 columns, `ck_escalation_status CHECK (status IN ('pending', 'notified', 'failed'))`, 4 indexes) |
| 23 | `023_reconcile_duplicate_003_and_schema_drift.sql` | `616d146e83a0da1d60c2ef62f63fcde7` | `023_reconcile_duplicate_003_and_schema_drift.sql` | **NEW:** Reconciles duplicate `003` schema drift (`customers.id`, `updated_at`, `PRIMARY KEY (id)`, `VARCHAR(128)` `unit_id`/`farm_id`) and updates `onboarding_reply` copy forward-only |

---

## 3. Detailed Verification of `022_add_escalations_table.sql` and `023_reconcile_duplicate_003_and_schema_drift.sql`

### 3.1 `022_add_escalations_table.sql` (`311ebf71a5be8ecd2fcb1cf94ecdd270`)
- Creates table `escalations` with 14 columns matching [`EscalationService`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/escalation/service.ts) and [`DbClient`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/db/client.ts#L2331-L2485):
  - `id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text`
  - `caller_phone VARCHAR(32) NOT NULL`
  - `tenant_id VARCHAR(64) NOT NULL`
  - `project_id VARCHAR(64)`
  - `conversation_id VARCHAR(64)`
  - `correlation_id VARCHAR(128) NOT NULL`
  - `caller_email VARCHAR(255)`
  - `reason TEXT`
  - `transcript JSONB`
  - `slack_notified BOOLEAN NOT NULL DEFAULT FALSE`
  - `slack_notified_at TIMESTAMPTZ`
  - `slack_error TEXT`
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`
  - `status VARCHAR(32) NOT NULL DEFAULT 'pending'` (`CONSTRAINT ck_escalation_status CHECK (status IN ('pending', 'notified', 'failed'))`)
- Indexes: `idx_escalations_correlation`, `idx_escalations_tenant`, `idx_escalations_status`, `idx_escalations_caller_phone`.

### 3.2 `023_reconcile_duplicate_003_and_schema_drift.sql` (`616d146e83a0da1d60c2ef62f63fcde7`)
- Preserves both historical `003` files at their exact checksums (`7c93dd4d89a927df46d1cc9681dcdcbd` and `990ecca2c6f6b48364cebeb91379799f`).
- Idempotently adds `customers.id VARCHAR(64) NOT NULL DEFAULT gen_random_uuid()::text` and `customers.updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`.
- Widens `customers.unit_id` and `customers.farm_id` from `VARCHAR(64)` to `VARCHAR(128)`.
- Replaces composite `customers_pkey (tenant_id, phone_e164)` with `customers_pkey PRIMARY KEY (id)` while preserving `unq_customers_tenant_project_phone` and `unq_customers_tenant_phone_null_project`.
- Updates `systems.onboarding_reply` and `projects.onboarding_reply` to `'Hi, thanks for calling vFarm Support. I''m here to help. What would you like to check today?'` forward-only.

---

## 4. Local PostgreSQL Empirical Verification (`localhost:5432/bha_cst`)

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
