# CST — Jason A–F Acceptance Alignment & Evidence Report (Reconciled)

> **Superseded / Canonical Reference:** This report has been reconciled with the latest PR #22 Render deployment (`dep-dbkgavp5efls73ag1olg`, SHA `fa701a3f7e2a4c642307d018f9a4a123cc6007d3`), the live Research Twin environment variable update on Render (`2026-11-02T22:25:18.754Z`), and local migration reconciliation (`023_reconcile_duplicate_003_and_schema_drift.sql`). See the comprehensive master report at [`docs/reports/CST_Jason_Payment_Gate_Closure_Report.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Jason_Payment_Gate_Closure_Report.md).

**Date:** 2026-11-02
**Decision Watch:** `DW-1793626498819-PDQ2`
**Deployed Production Commit:** `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` (PR #22, Deployment `dep-dbkgavp5efls73ag1olg`, live at `2026-11-02 21:51:02 UTC`)
**Live Research Twin Config Probe (`GET /api/health`):** `2026-11-02T22:25:18.754Z` (`endpoint_configured: true, service_api_key_configured: true, callback_signing_secret_configured: true, missing: [], state: "blocked"`)
**Local Working Branch & HEAD:** `fix/monitoring-pay-gate-closure` @ `dd7130879eef1e5e00f5645bb18bd602e234d8f7`
**Final Verdict:** **`PARTIALLY READY — EXTERNAL EVIDENCE REQUIRED`**

---

## 1. Reconciled Production Test Summary (`prod-test-results.json`) & Research Twin Update

- **Run 1 (`2026-11-02T21:02:53Z`, PR #20 `656000a7b768986feca9d85c7ac9d96c921306c7`):** `74 PASS, 2 FAIL, 16 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED`
- **Run 2 (`2026-11-02T21:28:11Z`, PR #20 warm probe):** `76 PASS, 2 FAIL, 14 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED` (`rack1_ph` and `rack2_dht` historical `limit=5` endpoints responded under 5s)
- **Run 3 (`2026-11-02T21:55:03Z`, PR #22 `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` in `prod-test-results.json`):** **`84 PASS, 4 FAIL, 4 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED`**
- **Live Render Research Twin Update (`2026-11-02T22:25:18.754Z`):** `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` are now configured on Render (`missing: []`, `endpoint_configured: true`, `service_api_key_configured: true`, `callback_signing_secret_configured: true`, `state: "blocked"` awaiting Destiny Arupi wire-contract verification).

Full 111-endpoint reconciliation and root causes are detailed in [`docs/reports/CST_Production_Test_Results_Analysis.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Production_Test_Results_Analysis.md).

---

## 2. Reconciled Database Migrations (`001`–`023`)

- [`db/migrations/006_seed_initial_customers.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/006_seed_initial_customers.sql) (`6bd3841fe4e5af57b59b93bbe2f5614d`) and [`db/migrations/010_add_projects_bindings_and_project_id.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/010_add_projects_bindings_and_project_id.sql) (`f5202e9c19b049abef4c14d1d1596832`) have been restored to their exact production-applied MD5 checksums, removing the unescaped apostrophe (`I'm`) introduced in `e9075a3`.
- Both [`003_add_customers_and_security_ledger.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/003_add_customers_and_security_ledger.sql) (`7c93dd4d89a927df46d1cc9681dcdcbd`) and [`003_customers_table.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/003_customers_table.sql) (`990ecca2c6f6b48364cebeb91379799f`) are preserved untouched at their canonical checksums.
- [`db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql) (`616d146e83a0da1d60c2ef62f63fcde7`) reconciles the duplicate `003` schema drift forward-only (`customers.id`, `customers.updated_at`, `PRIMARY KEY (id)`, `VARCHAR(128)` `unit_id`/`farm_id`) and updates `onboarding_reply` greeting copy cleanly.
- Verified locally on PostgreSQL 16 (`CST_DB_TESTS=1 DATABASE_URL=postgresql://localhost:5432/bha_cst npx vitest run tests/db/` -> `5 files passed, 49 tests passed`).
- Full details in [`docs/reports/CST_Migration_Reconciliation_Report.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Migration_Reconciliation_Report.md).

---

## 3. Supporting Deliverables Index

1. [`docs/reports/CST_Jason_Payment_Gate_Closure_Report.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Jason_Payment_Gate_Closure_Report.md) — Master A–F & PDQ2 Closure Report
2. [`docs/reports/CST_Production_Test_Results_Analysis.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Production_Test_Results_Analysis.md) — Complete 111-Endpoint Production Analysis
3. [`docs/reports/CST_Migration_Reconciliation_Report.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Migration_Reconciliation_Report.md) — Migration `001`–`023` Audit & PostgreSQL Proof
4. [`docs/reports/CST_vFarm_Upstream_Action_Request.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_vFarm_Upstream_Action_Request.md) — Upstream vFarm Action Items for Jeganathan
5. [`docs/reports/CST_Research_Twin_Integration_Handoff.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Research_Twin_Integration_Handoff.md) — Research Twin Handoff for Destiny Arupi
6. [`docs/reports/CST_Production_Migration_Approval_Plan.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Production_Migration_Approval_Plan.md) — Production DB Migration Runbook for `022` & `023`
7. [`docs/reports/CST_Human_Acceptance_Test_Plan.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/reports/CST_Human_Acceptance_Test_Plan.md) — Human Acceptance Procedures for Browser Chat, Voice & SMS
