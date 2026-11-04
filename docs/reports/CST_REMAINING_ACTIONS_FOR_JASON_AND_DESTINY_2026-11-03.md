# CST Remaining Actions for Jason and Destiny

**Date:** 2026-11-03  
**Target Repository:** `bhanetworkgh/bha_cst`  
**Purpose:** Isolate genuine external partner decisions, approvals, and actions required to flip CST acceptance gates to CLOSED.  

---

## 1. Action Items for Jason (CST & Acceptance Lead)

All underlying code fixes, test suites, and documentation on the CST side are 100% complete and passing. Jason's review and operational approval are required on the following items:

| # | Action Required | Purpose / Impact | Supporting Evidence Link | Status |
|---|---|---|---|---|
| **J-1** | **Approve PR for Branch `fix/monitoring-pay-gate-closure`** | Merges CI configuration fix, Contract v1.1.1 health freshness, `rung=farm` query fix, Research Twin Zod schemas, and Playwright live Chrome tests into `main`. | PR diff on branch `fix/monitoring-pay-gate-closure` (1,211 tests pass, 28 browser tests pass) | Ready for Merge |
| **J-2** | **Approve Live Outbound Telephony Test to `+923082113844`** | Authorizes execution of `npm run acceptance:all -- --confirm-live-sms --confirm-live-call` against deployed production to capture fresh carrier delivery receipts. | [`CST_SMS_VOICE_ACCEPTANCE_RUNBOOK.md`](CST_SMS_VOICE_ACCEPTANCE_RUNBOOK.md) | Preflight Verified |
| **J-3** | **Approve Codex Draft Updates (Entries 393 & 399)** | Formal acceptance of reconciled identity/authorization boundaries (393) and database continuity/migration ledger (399). | [`entry-393-update.md`](../acceptance/codex-entry-drafts/entry-393-update.md), [`entry-399-update.md`](../acceptance/codex-entry-drafts/entry-399-update.md) | Formatted & Reconciled |
| **J-4** | **Financial Authorization: PostgreSQL Plan Upgrade** | Free Starter tier on `bha-cst-postgres` expires on 14 Nov 2026. Authorize in-place upgrade to Render Basic tier ($7/month). | [`cst-postgres-upgrade-vs-migration-2026-11-02.md`](../operations/cst-postgres-upgrade-vs-migration-2026-11-02.md) | Backup Drill Passed |

---

## 2. Action Items for Destiny Arupi (Research Twin & Engine Lead)

CST's Research Twin client, Zod schemas, HMAC signature verification, and fail-closed guards are deployed and active. Destiny's bilateral confirmation is required on the following items:

| # | Action Required | Purpose / Impact | Supporting Evidence Link | Status |
|---|---|---|---|---|
| **D-1** | **Confirm Research Twin Wire Schemas** | Confirm that `ResearchTwinOutboundPayload` and `ResearchTwinInboundCallback` schemas conform to Destiny's external service / n8n workflow. | [`CST_Research_Twin_Integration_Brief_for_Destiny.md`](../../CST_Research_Twin_Integration_Brief_for_Destiny.md) | Awaiting Destiny Review |
| **D-2** | **Trigger 1 Signed Callback to Production** | Post one test callback to `https://bha-cst-7u9e.onrender.com/api/v1/research-twin/callback` using `X-Research-Twin-Signature`. Flips `research_twin.state` from `"blocked"` to `"active"` on `/api/health`. | Section 5 of [`CST_Research_Twin_Integration_Brief_for_Destiny.md`](../../CST_Research_Twin_Integration_Brief_for_Destiny.md) | Endpoint Live & Ready |
| **D-3** | **Observe Voice-Lane Health Verification** | Co-sign the live outbound call test to `+923082113844` to verify end-to-end voice latency and increment `successful_deliveries_24h` on `/health/voice`. | Live `/health/voice` response (`can_route_voice: true`) | Clone Configured |
| **D-4** | **Confirm Engine Dashboard `test: true` Handling** | Verify that test events carrying `test: true` are correctly classified as "sent as a test" and excluded from production billing metrics. | `engine/src/contracts/events.ts` | Test Events Active |
| **D-5** | **Formal SOP Loop Closure Sign-off** | Review the session-to-loop evidence register for `LOOP-1789824812431-IWKX`, `LOOP-1793031575930-X4EI`, `LOOP-1793031575927-LSJY`, and `LOOP-1792104121807-XXHH`. | [`CST_LOOP_CLOSURE_REGISTER_2026-11-03.md`](CST_LOOP_CLOSURE_REGISTER_2026-11-03.md) | Awaiting Destiny Sign-off |

---

## 3. Action Items for Jeganathan (vFarm Backend Lead)

CST's monitoring adapter and device filtering are complete. Upstream vFarm backend updates are required on the following items:

| # | Action Required | Purpose / Impact | Supporting Evidence Link | Status |
|---|---|---|---|---|
| **JG-1** | **Deploy `calculated_at` in Farm Health Payload** | Upstream `GET /api/v1/farms/{id}/health` currently lacks calculation timestamp. Adding this allows CST to report `healthy` instead of `degraded`. | [`CST_HEALTH_CONTRACT_RECONCILIATION.md`](CST_HEALTH_CONTRACT_RECONCILIATION.md) | CST Enforcing v1.1.1 |
| **JG-2** | **Execute Composite Index on `readings` Table** | Execute: `CREATE INDEX CONCURRENTLY idx_readings_device_recorded ON readings(device_id, recorded_at DESC);` in vFarm database to eliminate 29s query timeouts on `/readings/latest`. | [`CST_vFarm_Upstream_Action_Request.md`](CST_vFarm_Upstream_Action_Request.md) | CST Client Timeout Active |
| **JG-3** | **Verify vFarm Web Authentication Endpoint** | Confirm that `POST /api/v1/auth/login` is reachable and validates user credentials for CST web login. | `engine/src/interfaces/web/index.ts` | CST Auth Guard Active |

