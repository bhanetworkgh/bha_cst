# CST Commercial Pilot Checklist

Loop: LOOP-1791243473843-S777
Date: 2026-10-06
Repo: `bhanetworkgh/bha-cst`

Status of every open loop at pilot-readiness review, grouped by who can
close it. Nothing in this document requires code changes unless marked
DONE with a file reference.

Verified baseline at time of writing:

- `npm test` — **471 tests / 49 files, all passing**
- `npm run typecheck` — clean
- `npm run build` — clean

---

## DONE (closed in code, regression-tested)

| Loop | Item | Evidence |
| --- | --- | --- |
| LOOP-1790790007707-5R0J | Public vFarm proxy routes are not an unauthenticated privileged proxy. `GET /api/devices`, `GET /api/v1/devices`, `GET /api/dashboard`, `GET /api/farms`, `POST /api/tokens` fail closed (401, zero upstream calls); no admin-credential fallback. | `engine/src/middleware/vfarm_proxy_auth.ts`, `tests/security/vfarm_proxy_unauth.test.ts` |
| LOOP-1790985133890-XKWD | Conversation persistence honors the FK contract. `resolveSystemIdForTenant` resolves a real `system_id`; a failed conversation INSERT raises `ConversationPersistenceError` instead of being swallowed. Foreign keys remain intact. | `engine/src/db/client.ts`, `tests/db/conversation_fk_integrity.test.ts` |
| LOOP-1790985133891-1TEN / LOOP-1790691898379-S6Q3 | Dashboard publisher: `cst.turn` / `cst.delivery` correlation via `turn_id`, retry with backoff on 5xx, fail-fast on 4xx, `MISSING_CONFIGURATION` no-op, fire-and-forget, monotonic delivery guard, and **dry-run** (`DRY_RUN=true` validates + logs locally, makes no HTTP request, persists nothing). | `engine/src/publishers/dashboard.ts`, `engine/src/publishers/delivery.ts`, `tests/integration/dashboard_e2e.test.ts`, `tests/integration/dashboard_dry_run.test.ts` |
| LOOP-1790985133892-4DSK | vFarm timeout/retry: shared timeout budget (`VFARM_DEFAULT_TIMEOUT_MS=5000`, `VFARM_SYSTEM_STATS_TIMEOUT_MS=60000`), categorized `VfarmApiError`, retry/backoff. | `engine/src/adapters/vfarm/live_client.ts`, `engine/src/adapters/vfarm/http_client.ts`, `tests/adapters/vfarm_live_contract.test.ts` |
| LOOP-1790806602006-DOCR | vFarm live adapter contract: bearer token + farm key auth, `requestPassthrough` parity, per-call stats budget. | `tests/adapters/vfarm_live_contract.test.ts` |

## OPERATOR ACTION (requires credentials / decisions from Jason or Destiny)

1. **Real Dashboard ingestion endpoint**
   - Provide the production `ENGINE_DASHBOARD_URL` (e.g. `https://dashboard.<domain>/api/events`) and `ENGINE_DASHBOARD_KEY`.
   - Set both as environment variables on the engine host (see env vars below).
   - Expected behavior once set: `cst.turn` and `cst.delivery` events are POSTed as `cst.event.v1` JSON with `Authorization: Bearer <key>` (or `x-dashboard-key`); the Dashboard responds `202 Accepted` and persists one record per event, joinable on `data.turn_id`.
   - Exact verification command: `npm test` (the `tests/integration/dashboard_e2e.test.ts` and `tests/integration/dashboard_dry_run.test.ts` suites cover the contract against a local sink; point `ENGINE_DASHBOARD_URL` at the real endpoint for a live smoke check).
2. **Twilio pilot credentials**
   - Confirm the pilot Twilio account SID / auth token and the sender number (`+19715885823` in current config) are provisioned for SMS and voice.
   - Confirm the destination numbers for the pilot cohort are verified/ opted-in.
3. **vFarm production farm scope**
   - Confirm the pilot `farm_id` list and that the engine service account holds the required farm grants (`POST /api/v1/farms/grants`).
4. **Dry-run policy decision**
   - Decide whether the pilot launches with `DRY_RUN=true` (shadow mode: events validated and logged, nothing persisted to the Dashboard) and the date to flip to `DRY_RUN=false`.

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

- **Real carrier E2E for SMS/voice** (task-loop IDs LOOP-1791243473841-02JU / LOOP-1791243473842-LMCL): requires a live Twilio number, a real handset, and carrier delivery. Local acceptance is covered by the sink-based suites; the live leg is an operator runbook item.
- **Real Dashboard persistence E2E with `dry_run=false`**: requires the production Dashboard URL/key above. The contract is fully proven against a local HTTP sink in `tests/integration/dashboard_dry_run.test.ts` (test 3: record persists, verified after).

## BLOCKED (upstream gap — do not fabricate)

- **LOOP-1790985133889-8D7U — vFarm person→unit mapping**: the vFarm OpenAPI (`.openapi-vfarm.json`, 130 paths) exposes org→members, `/api/v1/farms/grants`, farm→zones→locations→sublocations, but **no person→unit endpoint**. CST deliberately omits `unit_id` from the adapter payload rather than inventing unit IDs. Blocked until vFarm/LM7W ships a person→unit mapping API.

---

## Pilot launch gate

- [ ] `npm test` green (471/471)
- [ ] `npm run typecheck` clean
- [ ] `npm run build` clean
- [ ] `ENGINE_DASHBOARD_URL` / `ENGINE_DASHBOARD_KEY` provisioned (operator)
- [ ] Twilio SMS/voice numbers provisioned (operator)
- [ ] vFarm farm grants confirmed for pilot scope (operator)
- [ ] `DRY_RUN` policy agreed and rollout date set (operator)
- [ ] Person→unit mapping: accepted as blocked or vFarm API shipped (upstream)
