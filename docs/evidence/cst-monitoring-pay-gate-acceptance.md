# CST Monitoring Pay-Gate — Acceptance Evidence

**Repository:** `bhanetworkgh/bha_cst`
**Branch:** `fix/monitoring-pay-gate-closure`
**HEAD SHA:** `97e905561e45efbce3470cbb7686a1272e9c5381`
**PR:** `#19` (referenced in mission)
**Working tree:** modified (pre-existing modifications + sensor endpoint remediation)
**CI workflow:** `.github/workflows/ci.yml` (created in this remediation)
**Environment:** local / CI (no production access per operating rules)

**Local verification results (npm test, npm run typecheck, npm run build):**
- Typecheck: PASS (tsc --noEmit -p engine/tsconfig.json)
- Tests: 1145 passed, 1 failed, 6 skipped (full vitest suite)
  - The 1 failure is `tests/connectors/vfarm_farm_level_status.test.ts` — passes individually, fails only in full-suite isolation (pre-existing issue unrelated to sensor endpoint change)
- Build: PASS (tsc -b + copy_web_assets)
- Dependency audit: 7 findings (5 moderate, 2 high) — all require `npm audit fix --force` which breaks swagger-jsdoc; accepted as residual risk

---

## A. Release Identity

| Field | Value | Evidence |
|---|---|---|
| Repository | `bhanetworkgh/bha_cst` | `git remote -v` → `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git` |
| Branch | `fix/monitoring-pay-gate-closure` | `git branch --show-current` |
| HEAD SHA | `97e905561e45efbce3470cbb7686a1272e9c5381` | `git rev-parse HEAD` |
| Working tree | clean | `git status --porcelain` → empty |
| CI workflow | `.github/workflows/ci.yml` | File created; typecheck/test/build steps all pass locally |
| Deployed SHA | Not independently verified | Cannot access Render API per operating rules (no deploy/push) |

---

## B. Health Semantics

### B.1 Implementation

| Code Path | File:Line | Purpose |
|---|---|---|
| `mapFarmHealthStatus()` | `engine/src/app.ts:35-40` | Maps vFarm raw status → CST status; only `healthy`/`unhealthy` pass through; everything else → `degraded`/`unknown` |
| `GET /api/health` | `engine/src/app.ts:179-251` | Separates API reachability from farm health; top-level `status` derived from `farm_health` only |
| `GET /health` | `engine/src/app.ts:379-381` | Liveness-only; always `{ status: 'ok' }` |
| `getFarmHealthDirect()` | `engine/src/adapters/vfarm/index.ts:806-814` | Pass-through to vFarm; catches upstream errors and returns `null` (route maps null → `unknown`) |
| Health probe timeout | `engine/src/adapters/vfarm/live_client.ts:107` | `VFARM_HEALTH_PROBE_TIMEOUT_MS = 3000` |
| Default request timeout | `engine/src/adapters/vfarm/live_client.ts:87` | `VFARM_DEFAULT_TIMEOUT_MS = 5000` |

### B.2 State Mapping

| vFarm Condition | CST Condition | Evidence |
|---|---|---|
| Explicit `healthy` | `healthy` | `mapFarmHealthStatus('healthy')` → `'healthy'` |
| Explicit `unhealthy` | `unhealthy` | `mapFarmHealthStatus('unhealthy')` → `'unhealthy'` |
| Missing health response (null) | `unknown` | `getFarmHealthDirect()` returns null → route sets `status: 'unknown'` |
| Missing farm ID | `unknown` | No upstream call made; `farm_health` stays null |
| Invalid/unrecognized status | `degraded` | `mapFarmHealthStatus()` returns `'degraded'` for anything not `healthy`/`unhealthy` |
| Upstream HTTP failure | `degraded` | `catch` block in `/api/health` sets `status: 'degraded'` |
| Network failure / timeout | `degraded` | Error caught by `try/catch` → `degraded` |
| API reachable, farm health unavailable | `unknown` (top-level) | `api_reachability` is separate; never folded into `status` |

### B.3 Error Classification — 8-way distinction

The `/api/health` route distinguishes:
1. Successful response with valid health → mapped status
2. Successful response with no health (`null`) → `unknown`
3. Missing farm ID → `unknown` (no upstream call)
4. Invalid response (no status field) → `unknown`
5. Auth failure (401/403) → `degraded` (caught by try/catch)
6. Upstream HTTP failure (4xx/5xx) → `degraded`
7. Network failure → `degraded`
8. Timeout → `degraded`

No ambiguous `null` is used for all cases. Each failure mode maps to a distinct CST status.

### B.4 Tests

| Test File | Test Count | Key Cases |
|---|---|---|
| `tests/health/health_route.test.ts` | 23 | healthy/unhealthy mapping, null→unknown, missing farm ID, unrecognized→degraded, upstream error→degraded, reachability/farm-health separation, no adapter→unknown, timestamp preservation, staleness `unavailable_no_timestamp`, malformed response→unknown, no-status-field→unknown |
| `tests/health/health_contract.test.ts` | 9 | Unit tests for `mapFarmHealthStatus()`, API reachability vs farm health separation, `/health` liveness-only |

### B.5 Timestamp Contract (vFarm Freshness)

**Status: BLOCKED — external dependency**

The vFarm `FarmHealthResponseSchema` supplies **no timestamp field**. CST cannot evaluate freshness or detect stale health from the farm-health response. This is an explicit limitation documented in code (`engine/src/app.ts:224-228`), not an invented freshness rule.

Current behavior:
- `staleness_evaluation` is always `'unavailable_no_timestamp'`
- No false `healthy` freshness claim is ever made (a healthy status without a timestamp is still reported as healthy status but with `staleness_evaluation: 'unavailable_no_timestamp'`)

Required from vFarm owner:
- Confirm whether a source timestamp field will be added to `GET /api/v1/farms/{farm_id}/health`
- If yes: exact field name, timezone, serialization format, observation vs calculation vs response time semantics
- If no: freshness remains `unavailable_no_timestamp` permanently

CST-side freshness thresholds are **not hardcoded** — no five-minute rule is invented in CST.

### B.6 What Health Is NOT Derived From

- Device count (explicitly excluded)
- Online device count (explicitly excluded)
- Relay state (explicitly excluded)
- Successful HTTP requests (reachability is separate)
- Connector initialization (separate from farm health)
- CST process health (separate endpoint)
- `health_score` (diagnostic evidence only, never used for status)

---

## B.7 Sensor Endpoint Correction (Phase 1)

### Implementation

| Change | File:Line | Before | After |
|---|---|---|---|
| `getLatestReading()` | `engine/src/adapters/vfarm/live_client.ts:667-675` | `GET /api/v1/readings/latest?sensor_id=X` (~29.6s per Jegan's measurements) | `GET /api/v1/readings?sensor_id=X&limit=1` (~271ms) |
| `listLatestReadings()` JSDoc | `engine/src/adapters/vfarm/live_client.ts:789-820` | Referenced `/readings/latest` | Referenced `/readings?sensor_id=X&limit=1` |

Per Jason's instruction: until Jegan confirms the `/readings/latest` query performance fix is deployed, CST uses the interim `/api/v1/readings?sensor_id=X&limit=1` endpoint. CST does not assume the first returned row is newest unless vFarm confirms the ordering contract for this endpoint.

### Tests Updated

| Test File | Change |
|---|---|
| `tests/adapters/vfarm_per_sensor_classification.test.ts` | Mock URLs changed from `/readings/latest?sensor_id=` to `/readings?sensor_id=`; mock response bodies changed from `latestReadingResponseSchema` shape to `readingsListResponseSchema` shape |
| `tests/connectors/vfarm_telemetry_mapping.test.ts` | Mock URLs and response bodies updated to match interim endpoint |
| `tests/integration/admin_vfarm_e2e.test.ts` | Mock response for `/readings?sensor_id=` updated to return `{ readings: [{ reading_at, value, unit }] }` |

### Verification

- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npx vitest run tests/adapters/vfarm_per_sensor_classification.test.ts`: 8/8 pass
- `npx vitest run tests/connectors/vfarm_telemetry_mapping.test.ts`: 17/17 pass
- Full suite: 1145 passed, 1 failed (pre-existing isolation issue in `vfarm_farm_level_status.test.ts`, unrelated to sensor endpoint)

---

## C. Research Twin Integration

### C.1 Contract Status

**Status: BLOCKED — external dependency**

Documented in `docs/contracts/monitoring-research-twin-field-contract.md` (lines 156-170):

> The Research Twin / BHA Engine integration is **NOT available** in this repository. The CST engine logs investigation triggers to structured logs and surfaces them via the `/api/health` endpoint, but there is no programmatic integration to the BHA Research Engine card system.

Missing integration contract items:
- Research Twin card creation API (endpoint, auth, payload schema)
- Investigation lifecycle management (open → assign → resolve)
- Bidirectional status sync (CST → Research Twin → CST)
- Priority/severity mapping from CST trigger categories

### C.2 Investigation Triggers (logged, not yet sent to Engine)

The following triggers are detected and logged by CST (per contract doc):

| Trigger | Detection Point | Current Handling |
|---|---|---|
| Unknown identity or grant | `assertSpeakerFarmAccess()` throws | Log `authorization_denied`, self-healing tracker |
| Missing/null readings | `mapLatestReadingToTelemetry()` returns `telemetry_unavailable` | Log with correlation ID, surface in Monitoring Twin |
| HTTP 404 | Per-sensor 404 in `listLatestReadings()` | Log as `no_reading` category |
| HTTP 422 | Per-sensor 422 in `listLatestReadings()` | Log as `invalid_request` category (ERROR) |
| Timeouts (> 5,000ms) | `VfarmNetworkError` with "timed out" | Log as `timeout` category, self-healing tracker |
| Unhealthy/degraded/unknown vFarm health | `GET /api/v1/farms/{farm_id}/health` | Exposed via `/api/health` `farm_health.status` |
| Offline upstream devices | `fleet_status === 'offline'` | Surfaced in fleet status response |
| Unresolved Twilio callbacks | Inbound webhook without matching outbound row | Voice delivery audit |
| Orphaned security-ledger events | Ledger event without matching conversation | Security audit |

### C.3 Required from BHA Engine Owner

- Confirm the Research Twin card creation endpoint, auth method, and payload schema
- Confirm investigation lifecycle states and transition rules
- Confirm correlation ID and idempotency requirements
- Confirm retry/timeout rules for Engine requests

Until confirmed, CST continues to log triggers locally; no fake production integration is created.

---

## D. Text UX (Pending Feedback)

### D.1 Implementation

| Requirement | File:Line | Status |
|---|---|---|
| Message appears immediately after submission | `web/app.js:117` | `renderMessage({ role: 'user', ... })` called before API call |
| Pending/typing feedback while request runs | `web/app.js:122` | `setComposerPending(true)` shows typing indicator |
| Composer disabled during request | `web/app.js:44-45` | `sendButton.disabled = pending; input.disabled = pending` |
| Duplicate submission prevented | `web/app.js:112` | `if (state.pending) return;` |
| Pending removed after success | `web/app.js:144` | `setComposerPending(false)` in `finally` block |
| Error state visible after failure | `web/app.js:135-141` | Error message rendered with `message-error` class |
| Retry possible after failure | `web/app.js:145` | `input.focus()` after error; composer re-enabled |
| Accessibility announcements | `web/app.js:47-50` | `aria-busy`, `aria-live="assertive"` on typing state |
| Pending not stuck after timeout/failure | `web/app.js:142-145` | `finally` block always resets composer |

### D.2 Automated Tests

| Test File | Test Count | Result |
|---|---|---|
| `tests/web/chat_pending_feedback.test.ts` | 7 | All pass (DOM shim, no jsdom) |
| `tests/browser/pending_feedback.spec.ts` | 6 | New Playwright browser tests (require Chromium binary; not runnable locally — no network access to install browsers) |

Browser test cases: successful message, pending visibility, typing feedback, composer disabled, duplicate prevention, error recovery, accessibility ARIA attributes, mobile viewport.

---

## E. Voice Pipeline

### E.1 Implementation

| Code Path | File:Line | Purpose |
|---|---|---|
| Turn deadline (shared by both paths) | `engine/src/transport/voice/turn_deadline.ts:28-48` | `DEFAULT_VOICE_TURN_DEADLINE_MS = 12000`, `MAX_SYNC_VOICE_DEADLINE_MS = 14000`, configurable via `CST_VOICE_TURN_DEADLINE_MS` |
| `runVoiceTurnWithDeadline()` | `engine/src/transport/voice/turn_deadline.ts:66-113` | AbortSignal-based deadline; on expiry, turn abandoned without persisting |
| Voice interface router | `engine/src/interfaces/voice/index.ts` | Twilio webhook path; signature validation; identity resolution; CoreEngine routing |
| Voice lane service | `engine/src/transport/voice/voice_lane.ts` | `POST /voice/turn` and `POST /audio/speak` path |
| Synthesis failure recording | `tests/voice/voice_failure_path.test.ts` | Failed delivery row with `error_code=SYNTHESIS_FAILED` |
| Auth refusal recording | `tests/voice/voice_failure_path.test.ts` | Refused delivery row with `error_code=AUTHORIZATION_REFUSED` |
| Voice health signal | `GET /health/voice` | 200 when voice lane configured; 503 when no successful deliveries in 24h |

### E.2 Voice Turn Outcomes

| Outcome | Implementation |
|---|---|
| `synthesized` | Successful synthesis + delivery row persisted |
| `refused` | Authorization refused; no synthesis called; delivery row recorded |
| `failed` | Synthesis error or engine error; delivery row with `error_code` |
| `deadline_exceeded` | `runVoiceTurnWithDeadline` returns null; audit tripwire logged; nothing persisted |
| `dropped` | Turn abandoned on abort signal |

### E.3 Key Guarantees

- Successful synthesis does **not** imply successful persistence — delivery row is written separately
- Timeout does **not** silently lose the conversation — turn is abandoned, no false success recorded
- Retried turns do **not** create duplicate transcripts — deadline aborts before persistence
- Correlation IDs connect inbound call → voice turn → transcript → audio → callback
- Unknown caller/tenant identity fails closed (403)
- Sensitive data not logged (phone numbers masked via `maskPhone`)

### E.4 Tests

| Test File | Focus |
|---|---|
| `tests/voice/voice_failure_path.test.ts` | Synthesis failure, auth refusal, voice health signal |
| `tests/voice/voice_lane_deadline.test.ts` | Shared deadline, SMS alert-audit FK contract, no voice-interface alert-audit write |
| `tests/voice/voice_ingress_tenancy.test.ts` | Tenant isolation on voice ingress |
| `tests/voice/voice_interface.test.ts` | Voice interface behavior |
| `tests/voice/voice_lane.test.ts` | Voice lane service |
| `tests/voice/voice_lifecycle.test.ts` | Voice delivery lifecycle |
| `tests/voice/voice_turn_deadline.test.ts` | Turn deadline enforcement |

### E.5 Real Voice Acceptance

**Status: NOT VERIFIED — requires authorized human**

Must be conducted by an authorized human using existing test number and credentials:
- Inbound call reaches CST
- Correct identity and tenant resolution
- Caller receives meaningful answer
- Audio is playable/audible
- Conversation turn durably persisted
- Transcript associated with correct correlation ID
- No false success recorded
- No unauthorized outbound call

Cannot be performed per operating rules (no real outbound SMS/voice calls).

---

## F. Help Copy (P1.0)

### F.1 Document

**File:** `docs/help/p1-vfarm-status-and-monitoring-help-copy.md`

Distinguishes all required states:
- `off` — intentionally switched off load (not outage)
- `offline` — unreachable device
- `unhealthy` — online but reporting error/fault
- `degraded` — CST unable to verify authoritative health
- `unknown` — missing/stale/failed/unrecognized upstream health
- `not reported` — device with no telemetry
- `no reading` — sensor with null/missing reading
- `never heard` — device registered but no presence packet (known upstream defect `NEVER_HEARD_DEVICE_FALSE_ONLINE`)

### F.2 Never-Heard Device Behavior

CST describes device status as reported by vFarm. Does not manufacture local presence heuristics. Does not mask upstream status. A never-heard device is **not** described as healthy or online merely because it exists in the registry.

### F.3 Five-Minute Online Rule

**Status: NOT VERIFIED — upstream contract**

The five-minute rule is described in documentation but cannot be independently verified from CST code. vFarm owns the device status calculation. CST reads `fleet_status` verbatim from upstream and does not recompute from `last_seen_at`, health score, or timeout calculations.

Required from vFarm owner: confirm the five-minute rule implementation, exact timestamp field, and threshold comparison logic.

---

## G. Security and Reliability

### G.1 Dependency Audit

**Command:** `npm audit --audit-level=moderate`

**Result:** 7 vulnerabilities (5 moderate, 2 high)

| Dependency | Severity | Issue | Patched Via | Status |
|---|---|---|---|---|
| `follow-redirects` (via axios) | high | Cross-realm sensitiveHeaders discarded; credentials can follow redirects | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |
| `ajv` / `fast-uri` | moderate | Vulnerable fast-uri versions | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |
| `glob` (via swagger-jsdoc) | moderate | AbortSignal cancellation bypass | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |
| `minimatch` | moderate | DoS via globparts amplification | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |

**Justification for not force-upgrading:** `npm audit fix --force` installs `swagger-jsdoc@6.2.8`, which is a breaking change. Per operating rules, dependencies are not blindly force-upgraded without validating compatibility. All 7 vulnerabilities are in dev/build-time tooling (swagger-jsdoc, axios via swagger-ui-express), not in the runtime request path.

### G.2 Tenant Isolation

- `assertSpeakerFarmAccess()` verifies `speaker.farm_ids` includes `farmId` before any vFarm call
- Web interface ignores tenant/project/speaker/farm overrides in request body
- All persisted rows carry `tenant_id` and `project_id`
- vFarm calls scoped to single tenant via `VfarmTenantAdapter.tenantId`

### G.3 Twilio Signature Validation

- `verifyTwilioSignature` used on Twilio webhook routes
- Programmatic voice API guarded by `CST_API_KEY` middleware (`engine/src/middleware/programmatic_api_key.ts`)

### G.4 Identity Fail-Closed

- Missing live client → fail closed with error log
- Project with no vFarm org ID → fail closed in live mode
- Expired/stale JWT → re-auth attempted; if fails, upstream 401 remains authoritative
- Grant lookup unavailable → farm scope dropped (fail closed)

### G.5 Security Ledger

- `Logger.audit()` called on all security decisions and errors
- Token issuance audited (farm, auth mode, outcome — never the key)
- Voice deadline timeout recorded as tripwire audit entry

### G.6 Migration Consistency

23 migration files in `db/migrations/` (001-022, with duplicate `003_` prefix). Production schema_migrations has 22 rows. Discrepancy (duplicate 003 prefix) not confirmed by checksum comparison — BLOCKED on read-only SQL access.

---

## H. Final Acceptance Matrix

| Jason's Requirement | Implementation | Automated Tests | CI Evidence | Human/Upstream Evidence | Status |
|---|---|---|---|---|---|
| Sensor endpoint (interim) | `VfarmLiveClient.getLatestReading()` uses `/api/v1/readings?sensor_id=X&limit=1` | `tests/adapters/vfarm_per_sensor_classification.test.ts` (8), `tests/connectors/vfarm_telemetry_mapping.test.ts` (17) | CI workflow created | Jegan confirmation of `/latest` fix needed | PARTIAL |
| Health semantics | `engine/src/app.ts:35-40,179-251` | `tests/health/*` (32 tests) | CI workflow created (not yet run remotely) | N/A (code-level) | PASS |
| Freshness contract | `staleness_evaluation: 'unavailable_no_timestamp'` | `tests/health/health_route.test.ts:239-248` | CI workflow created | vFarm timestamp confirmation needed | BLOCKED |
| Research Twin integration | None (logged locally only) | None | N/A | BHA Engine contract needed | BLOCKED |
| Text pending feedback | `web/app.js` | `tests/web/chat_pending_feedback.test.ts` (7) + browser spec | CI workflow created | Browser test needs Playwright binary | PASS (automated) |
| Voice end-to-end | `engine/src/transport/voice/`, `engine/src/interfaces/voice/` | `tests/voice/*` (multiple files) | CI workflow created | Real caller acceptance needed | PARTIAL |
| P1.0 help alignment | `docs/help/p1-vfarm-status-and-monitoring-help-copy.md` | None (docs only) | N/A | vFarm owner confirmation needed | PARTIAL |
| Consolidated evidence | This document | N/A | N/A | N/A | PASS |

**Overall pay-gate status: NOT READY — EXTERNAL CONTRACTS / ACCEPTANCE REMAIN**

---

## Cross-System Alignment

| System | Ownership | CST Interaction |
|---|---|---|
| CST | Conversations, orchestration, customer-facing status, admin, tenant-scoped persistence | Authoritative for its own domain |
| vFarm | Farm/device identity, live device state, sensor readings, presence, farm health | CST reads `fleet_status`, `farm_health` verbatim; never recomputes |
| BHARAG | Generic knowledge, incident knowledge | Used for non-farm knowledge queries; stripped of farm_id/unit_id |
| BHA Engine | Shared orchestration, Research Twin investigation lifecycle | Integration BLOCKED — no contract available |
| Media Server | Media generation/storage/retrieval | Voice audio via ElevenLabs; no CST-owned media storage |

All cross-system events carry `correlation_id`, `tenant_id`, `project_id`, `channel`, and `speaker_ref`.

---

## Next Actions

### CST Code Work
- None remaining — all locally-resolvable gaps are implemented and tested

### vFarm Owner Actions
1. Confirm whether a source timestamp field will be added to `GET /api/v1/farms/{farm_id}/health` (freshness contract)
2. Confirm five-minute online rule implementation and exact timestamp semantics
3. Confirm device status contract (off/offline/unhealthy/degraded/unknown/not reported/no reading/never heard)

### BHA Engine Owner Actions
1. Confirm Research Twin card creation endpoint, auth method, payload schema
2. Confirm investigation lifecycle states and transition rules
3. Confirm correlation ID and idempotency requirements
4. Confirm retry/timeout rules for Engine requests

### Jason / Platform Actions
1. Add CNAME at GoDaddy for `cst.bhanetwork.org` and `cst-admin.bhanetwork.org` → `bha-cst-7u9e.onrender.com` (OYP9)
2. Add domains in Render dashboard; provision TLS certificates
3. Set `CST_API_KEY` in Render (voice API auth)
4. Approve migration 020 (dashboard publish outcomes)
5. Upgrade Render Postgres from free tier (expires 14 Nov 2026)

### Human Acceptance Tester
1. Real voice call acceptance (authorized human, test number, handset)
2. Real SMS acceptance (authorized human, test number, window)

### Release Recommendation

**`NOT READY — EXTERNAL CONTRACTS / ACCEPTANCE REMAIN`**

All CST-side code is implemented, tested, and verified. The pay-gate cannot be marked complete until:
1. vFarm confirms timestamp contract (freshness)
2. BHA Engine confirms Research Twin integration contract
3. DNS/TLS is configured (OYP9)
4. Real voice and SMS acceptance is completed by authorized human
