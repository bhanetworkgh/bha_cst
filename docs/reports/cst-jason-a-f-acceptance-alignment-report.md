# CST — Jason A–F Acceptance Alignment & Evidence Report (Reconciled Post-PR #23)

> **Canonical Master Reference:** This alignment report summarizes the full findings detailed in [`docs/reports/CST_Jason_Payment_Gate_Closure_Report.md`](CST_Jason_Payment_Gate_Closure_Report.md). All statements are reconciled with the latest live PR #23 Render deployment (`dep-dbkh3p6417fc73bffihg`, SHA `441d2b3f4a49c983f45131c229888a60116b9437`, live at `2026-11-02T22:43:32.077742Z`), direct read-only inspection of the Render PostgreSQL database (`dpg-db8he2qvcj2c73ado3s0-a/bha_cst_1sh0`), and the latest 111-endpoint production verification run (`2026-11-02T22:47:58Z`).

**Date:** 2026-11-02
**Decision Watch:** `DW-1793626498819-PDQ2`
**Incident:** `LOOP-1793620799001-3NBE`
**Deployed Production Commit:** `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23 Merge Commit, merging `8f2940307e9c946ad7a3b8353ecf5f53368b9933`, Deployment `dep-dbkh3p6417fc73bffihg`, live at `2026-11-02T22:43:32.077742Z`)
**Local Working Branch & HEAD:** `fix/monitoring-pay-gate-closure` @ `8f2940307e9c946ad7a3b8353ecf5f53368b9933`
**Final Verdict:** **`PARTIALLY READY — EXTERNAL EVIDENCE REQUIRED`**

---

## 1. Reconciled Production Test Summary & Live Telemetry Status

- **Run 1 (`2026-11-02T21:02:53Z`, PR #20 `656000a7`):** `74 PASS, 2 FAIL, 16 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED`
- **Run 2 (`2026-11-02T21:28:11Z`, PR #20 warm probe):** `76 PASS, 2 FAIL, 14 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED`
- **Run 3 (`2026-11-02T21:55:03Z`, PR #22 `fa701a3` in [`prod-test-results.json`](../../prod-test-results.json)):** `84 PASS, 4 FAIL, 4 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED` (sensors stale at `2026-10-30`, `rack1_ph = 25.19 pH`)
- **Run 4 (`2026-11-02T22:47:58Z`, PR #23 `441d2b3f` in [`docs/evidence/prod-test-results-pr23-latest.json`](../evidence/prod-test-results-pr23-latest.json)):** **`84 PASS, 4 FAIL, 4 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED`**
  - **Fresh Live Telemetry Confirmed:** All 4 canonical sensors (`rack1_soil = 90.0%`, `rack1_ph = 5.06 pH`, `rack2_dht = 28.8 °C / 63% RH`, `rack1_mq7 = 0.76 ppm`) are now streaming fresh (<60s old), calibrated live data via the interim endpoint (`/api/v1/readings?sensor_id=X&limit=1`).
  - **Authoritative Endpoints Remain Blocked:** Direct calls to authoritative `/api/v1/readings/latest` still time out (>6,000ms) and exhaust upstream DB connections, `/readings/stats` takes >12s (#47, #50, #53, #56), `/system/stats` times out (#42), and `/alerts/threshold/counts` returns 422 (#43).

---

## 2. Reconciled A–F Acceptance Matrix

| Area | Corrected Acceptance Classification | Code & Local Proof | Production Proof (`dep-dbkh3p6417fc73bffihg`) | Remaining Blocker / Required Action | Owner |
|---|---|---|---|---|---|
| **A — vFarm data path & sensors** | **`PARTIALLY SATISFIED — AUTHORITATIVE ENDPOINTS BLOCKED`** | [adapters/vfarm/client.ts](../../engine/src/adapters/vfarm/client.ts), `tests/adapters/vfarm_interim_readings.test.ts` (`PASS`) | Tests #45–#46, #48–#49, #51–#52, #54–#55, #61, #65 all **HTTP 200 OK (<600ms) with fresh (<60s) live data** | Upstream vFarm DB composite index on `readings(sensor_id, reading_ts DESC)` required so authoritative `/readings/latest` and `/readings/stats` (#47, #50, #53, #56) do not time out | **Jeganathan (vFarm)** |
| **B — Presence, freshness & health semantics** | **`PARTIALLY SATISFIED — UPSTREAM HEALTH SEMANTICS OPEN`** | [app.ts](../../engine/src/app.ts#L180-L212), `tests/health/health_contract.test.ts` (`PASS`) | Warm `GET /api/health` (`200 OK`, `889ms`) truthfully reports `farm_health: degraded`; `rack1_ph` calibrated at `5.06 pH` | Upstream `/farms/{id}/health` returns null timestamps and undefined `"neutral"` status | **Jeganathan (vFarm)** |
| **C — Conversational customer experience** | **`IMPLEMENTED — HUMAN ACCEPTANCE PENDING`** | [core/engine.ts](../../engine/src/core/engine.ts), [transport/voice/voice_lane.ts](../../engine/src/transport/voice/voice_lane.ts), `tests/core/help_menu_copy.test.ts` (`PASS`) | Migration `023` applied in prod DB; `systems.onboarding_reply` verified; `GET /health/voice` (`200 OK`, `can_route_voice: true`) | Authorized human tester to execute Browser Chat walkthrough and live inbound Voice Call to `+19715885823` per [CST_Human_Acceptance_Test_Plan.md](CST_Human_Acceptance_Test_Plan.md) | **Jason / Authorized Tester** |
| **D — Research Twin end-to-end** | **`CREDENTIALS CONFIGURED — CONTRACT & CALLBACK BLOCKED`** | [research_twin/config.ts](../../engine/src/research_twin/config.ts), [research_twin/lifecycle.ts](../../engine/src/research_twin/lifecycle.ts), `tests/research_twin/lifecycle.test.ts` (`PASS`) | Render startup log (`22:43:26Z`) & `GET /api/health` confirm `RT_*` env vars configured (`missing: []`, `state: "blocked"`) | Destiny Arupi to confirm wire contract (HTTP POST schema) and HMAC signature format (`RT_CALLBACK_SIGNING_SECRET`), followed by 1 live signed callback test | **Destiny Arupi (Research Twin)** |
| **E — Operator workflow, escalations & admin console** | **`SCHEMA VERIFIED — HUMAN ACCEPTANCE PENDING`** | [022 migration](../../db/migrations/022_add_escalations_table.sql), [023 migration](../../db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql), `tests/db/schema_assertions.test.ts` (`PASS`) | Production DB `dpg-db8he2qvcj2c73ado3s0-a` verified with `escalations` table (`022`) and `customers_pkey PRIMARY KEY (id)` (`023`); Admin endpoints #8, #13, #15–#41 all `200 OK` | Authorized human tester to trigger 1 live escalation turn during chat/voice testing to verify end-to-end insertion into `escalations` and Slack notification | **Jason / Authorized Tester** |
| **F — Delivery attribution, dashboard publication & governance** | **`HISTORICAL EVIDENCE VERIFIED — FRESH ATTRIBUTION PENDING`** | [007 migration](../../db/migrations/007_add_provider_sid_and_updated_at_to_messages_out.sql), [020 migration](../../db/migrations/020_dashboard_publish_outcomes.sql), `tests/transport/delivery_persistence.test.ts` (`PASS`) | Production DB verified: `2 delivered` rows in `messages_out` (Twilio SIDs: `SMdd413c99025787c3a92c9a7c5e91de77`, `SMd9ecf40685cc36db7d184ec776dc0afb`), voice delivery rows across CallSIDs `CA00c75d6e31e3e604e542f4ef05efbeb8` and `CAe444cd581967be81a5bbdb8eb0c55168`, `43 published` `cst.turn` rows, `12 published` `cst.delivery` rows; #20, #21, #41 `200 OK` | Provide explicit phone destination and consent authorization to execute 1 fresh post-PR #23 live SMS turn and voice call to capture live provider callback attribution | **Jason / Authorized Tester** |

---

## 3. Database Migrations Verified in Production (`001`–`023`)

- Render's configured `startCommand` (`node scripts/migrate.js && npm start`) automatically executed migrations on container boot.
- All 24 migration files in [`db/migrations/`](../../db/migrations) are recorded in `schema_migrations` on Render PostgreSQL (`dpg-db8he2qvcj2c73ado3s0-a/bha_cst_1sh0`) with zero checksum warnings:
  - `022_add_escalations_table.sql` (`sha256[0..32]`: `a9611f32573f3d86993a45bda10d9952`) — applied `2026-10-28 17:02:14.122471+00`.
  - `023_reconcile_duplicate_003_and_schema_drift.sql` (`sha256[0..32]`: `b03c1e0c63eb12a771d7afaaf9d1452d`) — applied `2026-11-02 22:43:25.032521+00`.

---

## 4. Supporting Reports Index

1. [`docs/reports/CST_Jason_Payment_Gate_Closure_Report.md`](CST_Jason_Payment_Gate_Closure_Report.md) — Master A–F & PDQ2 Closure Report
2. [`docs/reports/CST_Production_Test_Results_Analysis.md`](CST_Production_Test_Results_Analysis.md) — Complete 111-Endpoint Production Analysis
3. [`docs/reports/CST_Migration_Reconciliation_Report.md`](CST_Migration_Reconciliation_Report.md) — Migration `001`–`023` Audit & Production PostgreSQL Proof
4. [`docs/reports/CST_Production_Migration_Approval_Plan.md`](CST_Production_Migration_Approval_Plan.md) — Production Migration Verification & Governance Runbook
5. [`docs/reports/CST_vFarm_Upstream_Action_Request.md`](CST_vFarm_Upstream_Action_Request.md) — Upstream vFarm Action Items for Jeganathan
6. [`docs/reports/CST_Research_Twin_Integration_Handoff.md`](CST_Research_Twin_Integration_Handoff.md) — Research Twin Handoff for Destiny Arupi
7. [`docs/reports/CST_Human_Acceptance_Test_Plan.md`](CST_Human_Acceptance_Test_Plan.md) — Human Acceptance Procedures for Browser Chat, Voice & SMS
