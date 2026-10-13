# CST Commercial Pilot Checklist

Loop: LOOP-1791243473843-S777
Date: 2026-10-07
Repo: `bhanetworkgh/bha-cst`

Status of every open loop at pilot-readiness review, grouped by who can
close it. Nothing in this document requires code changes unless marked
DONE with a file reference.

Verified baseline at time of writing:

- `npm test` — **551 tests / 56 files, all passing** (6 real-provision tests skipped by default in `dashboard_real_proof.test.ts`; 557 total)
- `npm run typecheck` — clean (0 errors)
- `npm run build` — clean (dist/ generated + 7 web assets)
- Authoritative Audit: `docs/cst-v1-readiness-audit.md`
- Pilot Plan: `docs/cst-v1-pilot-execution-plan.md`
- Operations Runbook: `docs/cst-v1-operations-runbook.md`
- VJU6 Proposed Record: `docs/vju6-proposed-verification-record.md`

---

## RELEASE RULE: LIVE PILOT TRAFFIC IS NO-GO
Live CST pilot traffic remains **NO-GO** until deployed availability (Render 503 resolution), staging database migrations (017/018), vFarm operational key audit, and custom-domain DNS/TLS are completed and verified on host.

---

## DONE (closed in code, regression-tested)

| Loop | Item | Evidence |
| --- | --- | --- |
| LOOP-1791467054702-NI8F | SMS Consent Spine & A2P Operational Acceptance: canonical wording `cst_sms_consent_v1`, server-side stamping, prompt evidence tracking, strict opt-out enforcement (STOP), explicit re-subscription policy (START -> prompt -> YES), HELP handler, tenant/project scoping, append-only audit trail with composite FK, and 11-point A2P operational verification on `+1 (971) 588-5823`. | `engine/src/consent/wording.ts`, `engine/src/consent/service.ts`, `db/migrations/016_sms_consent_spine.sql`, `db/migrations/017_sms_consent_audit_fk.sql`, `db/migrations/018_sms_consent_prompts.sql`, `tests/consent/consent_spine.test.ts` (24), `tests/consent/a2p_operational_acceptance.test.ts` (10) |
| LOOP-1790790007707-5R0J | Public vFarm proxy routes are not an unauthenticated privileged proxy. `GET /api/devices`, `GET /api/v1/devices`, `GET /api/dashboard`, `GET /api/farms`, `POST /api/tokens` fail closed (401, zero upstream calls); no admin-credential fallback. | `engine/src/middleware/vfarm_proxy_auth.ts`, `tests/security/vfarm_proxy_unauth.test.ts` |
| LOOP-1790985133890-XKWD | Conversation persistence honors the FK contract. `resolveSystemIdForTenant` resolves a real `system_id`; a failed conversation INSERT raises `ConversationPersistenceError` instead of being swallowed. Foreign keys remain intact. | `engine/src/db/client.ts`, `tests/db/conversation_fk_integrity.test.ts` |
| LOOP-1790985133891-1TEN / LOOP-1790691898379-S6Q3 | Dashboard publisher: `cst.turn` / `cst.delivery` correlation via `turn_id`, retry with backoff on 5xx, fail-fast on 4xx, `MISSING_CONFIGURATION` no-op, fire-and-forget, monotonic delivery guard, and **dry-run** (`DRY_RUN=true` validates + logs locally, makes no HTTP request, persists nothing). **Serialization layer** (`serializeForDashboard`) flattens the CST event envelope into the dashboard's flat ingestion contract (`event_type`, `turn_id`, `status` at top level). Verified live against `https://dashboard.bhanetwork.org` — HTTP 200 with row insertion confirmed. | `engine/src/publishers/dashboard.ts` (`serializeForDashboard`, dry-run branch, `isDryRun()`), `engine/src/publishers/delivery.ts`, `tests/integration/dashboard_e2e.test.ts` (12), `tests/integration/dashboard_dry_run.test.ts` (12), `tests/integration/dashboard_real_proof.test.ts` (6, real) |
| LOOP-1790985133892-4DSK | vFarm timeout/retry: shared timeout budget (`VFARM_DEFAULT_TIMEOUT_MS=5000`, `VFARM_SYSTEM_STATS_TIMEOUT_MS=60000`), categorized `VfarmApiError`, retry/backoff. | `engine/src/adapters/vfarm/live_client.ts`, `engine/src/adapters/vfarm/http_client.ts`, `tests/adapters/vfarm_live_contract.test.ts` |
| LOOP-1790806602006-DOCR | vFarm live adapter contract: bearer token + farm key auth, `requestPassthrough` parity, per-call stats budget. | `tests/adapters/vfarm_live_contract.test.ts` |

## OPERATOR ACTION (requires credentials / decisions from Jason or Destiny)

1. **Real Dashboard ingestion endpoint** — DONE (configured by operator, verified live):
   - `ENGINE_DASHBOARD_URL=https://dashboard.bhanetwork.org/api/engine/cst-events` and `ENGINE_DASHBOARD_KEY` (real Bitwarden key) are configured.
   - Live proof run: `REAL_DASHBOARD_PROOF=1 npx vitest run tests/integration/dashboard_real_proof.test.ts` — all 6 tests passed:
     - dry_run=true: validates locally, NO HTTP request, no production row
     - dry_run=false: cst.turn → HTTP 200, row inserted (confirmed by `inserted: 1`)
     - dry_run=false: cst.delivery → HTTP 200, correlated delivery (`updated: 1`, joined on `turn_id`)
     - authentication: both `Authorization: Bearer <key>` and `x-dashboard-key` headers sent
     - serialized flat payload verified: `event_type`, `tenant_id`, `project_id`, `turn_id`, `status` all present
2. **Twilio pilot credentials**
   - Confirm the pilot Twilio account SID / auth token and the sender number (`+19715885823` in current config) are provisioned for SMS and voice.
   - Confirm the destination numbers for the pilot cohort are verified/opted-in.
3. **vFarm production farm scope**
   - Confirm the pilot `farm_id` list and that the engine service account holds the required farm grants (`POST /api/v1/farms/grants`).
4. **Dry-run policy decision**
   - Decide whether the pilot launches with `DRY_RUN=true` (shadow mode: events validated and logged, nothing persisted to the Dashboard) and the date to flip to `DRY_RUN=false`.
5. **vFarm farm-key issuance audit** (security follow-up)
   - Check vFarm's farm-key issuance records for any keys issued between **2026-09-25** and **2026-10-07** (the exposure window — see Security Audit below).

### Environment variables

| Variable | Purpose | Required for |
| --- | --- | --- |
| `ENGINE_DASHBOARD_URL` | Dashboard ingestion endpoint | Live Dashboard publishing |
| `ENGINE_DASHBOARD_KEY` | Dashboard auth (Bearer / x-dashboard-key) | Live Dashboard publishing |
| `DRY_RUN` | `true` = validate + log only, no remote request | Shadow mode |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Carrier auth | SMS/voice delivery |
| `VFARM_BASE_URL` / `VFARM_API_KEY` / `VFARM_JWT_*` | vFarm adapter auth | vFarm live calls |
| `VFARM_DEFAULT_TIMEOUT_MS` (default 5000) | Per-request budget | vFarm live calls |
| `VFARM_SYSTEM_STATS_TIMEOUT_MS` (default 60000) | Stats request budget | `getSystemStats` |
| `CST_DB_TESTS=1` | Enables real-Postgres FK tests | CI/DB verification |

## EXTERNAL DEPENDENCY (cannot be executed from this repo)

- **Real carrier E2E for SMS/voice** (task-loop IDs LOOP-1791243473841-02JU / LOOP-1791243473842-LMCL): requires a live Twilio number, a real handset, and carrier delivery. Local acceptance is covered by 89 transport + voice tests in `tests/transport/` and `tests/voice/`. The live leg is an operator runbook item.
- **A2P registration**: US SMS is currently blocked pending A2P registration at the carrier level. This is **not** a CST implementation failure — it is an external carrier constraint. Verify separately: `tests/transport/inbound.test.ts` (normalization, dedup) and `tests/transport/outbound_tenancy.test.ts` (DID binding, capability, delivery correlation) pass locally.
- **vFarm farm-key issuance audit**: see Security Audit below under OPERATOR ACTION.

## SECURITY AUDIT — `/api/tokens` (LOOP-1790790007707-5R0J)

### What was the vulnerability
Before commit `31f3a5f`, the `POST /api/tokens` route (and `/api/devices`, `/api/dashboard`, `/api/farms`) had **no authentication middleware** at all. The original handler (`engine/src/app.ts`, commit `9465fd4`) accepted a `farm_id` from the request body and optionally a `token` from `req.body?.token` as a credential override, then minted a farm key using CST's own vFarm admin JWT and returned the `raw_key` in the HTTP response. This made CST an unauthenticated privileged proxy in front of vFarm.

### Current state
`requireVfarmAdminSessionOrJwt` middleware (`engine/src/middleware/vfarm_proxy_auth.ts`) now gates all vFarm proxy routes. It accepts exactly two modes:
1. `admin_session` — valid CST admin session token (`x-admin-token`)
2. `caller_jwt` — caller's own vFarm JWT (`Authorization: Bearer <jwt>`)

Any other caller is refused with 401. A body-supplied `token` field is no longer honoured.

### Evidence
- 18 regression tests in `tests/security/vfarm_proxy_unauth.test.ts` — all pass
- Key assertions: unauthenticated caller → 401 with zero upstream calls; body-supplied `token` → rejected; valid admin session → 201 issued; valid caller JWT → 201 issued; expired caller JWT → 401

### Exposure window
- Route introduced without auth: **2026-09-25 03:26:39 +0500** (commit `9465fd4`)
- Auth middleware added: **2026-10-07 01:57:30 +0500** (commit `31f3a5f`)
- Duration: approximately **11.9 days**

### External reachability
- Deployment: Render.com public web service (`render.yaml`: `type: web`, `autoDeploy: true`, no VPC/internal-only flag)
- Public URL: `https://bha-cst.onrender.com` (per `docs/api-endpoints.md`)
- Route was reachable at: `POST https://bha-cst.onrender.com/api/tokens`
- No tunnel or proxy intermediary — direct public ingress

### Farm-key issuance audit (requires vFarm records)
- **Cannot be determined from this repository.** No access-log aggregation is configured (no Datadog, New Relic, Loki, or fluentd in `render.yaml`).
- vFarm operator action: check the vFarm API key issuance records (`POST /api/v1/tokens` on the vFarm API) for any keys issued between 2026-09-25 and 2026-10-07. If any are found that were not initiated by a known CST admin, **rotate those farm keys and the CST admin JWT** using the approved mechanism in `engine/src/admin/routes.ts`.

## BLOCKED (upstream gap — do not fabricate)

- **LOOP-1790985133889-8D7U — vFarm person→unit mapping**: the vFarm OpenAPI (`.openapi-vfarm.json`, 130 paths) exposes org→members, `/api/v1/farms/grants`, farm→zones→locations→sublocations, but **no person→unit endpoint**. CST deliberately omits `unit_id` from the adapter payload rather than inventing unit IDs. Blocked until vFarm/LM7W ships a person→unit mapping API.
- **vFarm farm-key issuance audit**: see Security Audit above — requires external vFarm records.

---

## Pilot launch gate

- [x] `npm test` green (551/551 tests passed, 6 skipped for real-provision tests)
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [x] `ENGINE_DASHBOARD_URL` / `ENGINE_DASHBOARD_KEY` provisioned and verified live
- [x] Twilio A2P Campaign approved for `+1 (971) 588-5823` (Verified for Customer Care, Jason confirmed)
- [ ] vFarm farm grants confirmed for pilot scope (operator)
- [ ] `DRY_RUN` policy agreed and rollout date set (operator)
- [x] `/api/tokens` and all vFarm proxy routes: auth middleware enforced (18 security tests pass)
- [ ] vFarm farm-key issuance audit completed (operator — requires vFarm records)
- [x] Person→unit mapping: accepted as blocked (no upstream endpoint) — or vFarm API ships
- [x] Role-based acceptance: manager/tech/owner verified (23 tests pass)
- [x] SMS/Voice transport & A2P Consent Spine: 551 tests pass locally; A2P campaign verified by carrier
