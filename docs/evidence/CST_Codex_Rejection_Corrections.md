# CST Codex Rejection Corrections

**Repository:** `bhanetworkgh/bha_cst`
**Branch:** `fix/monitoring-pay-gate-closure`
**HEAD SHA:** `97e905561e45efbce3470cbb7686a1272e9c5381`
**Report date:** 2026-11-02
**Pay-gate:** `DW-1793626498819-PDQ2`

Proposed corrections for Codex entries 393, 399, 29 October, and 30 October. Original reviewer comments are preserved; corrections are labeled as proposed pending resubmission authorization.

---

## Entry 393 — Mission Fit and Project Identity

### Original Reviewer Objections

1. `mission_fit_not_stated` — Mission fit not clearly explained.
2. BHA architecture connection not sufficiently clear.
3. Seeded fake test numbers/users not clearly distinguished from real identities.
4. Project identifier not explained in plain language.
5. Affected record/table not identified clearly.

### Verified Corrections

| # | Correction | Evidence |
|---|---|---|
| 1 | CST work supports BHA architecture: CST owns conversations/orchestration/customer-facing status; vFarm owns farm identity/device state/sensor readings/farm health; BHARAG owns knowledge; BHA Engine owns Research Twin lifecycle | `docs/contracts/monitoring-research-twin-field-contract.md`; `engine/src/adapters/vfarm/` (vFarm consumer only); `engine/src/connectors/bharag_rag.ts` (BHARAG consumer) |
| 2 | BHA lane: CST customer-service surface; architecture component: vFarm tenant adapter + live client | `engine/src/adapters/vfarm/index.ts` (`VfarmTenantAdapter`); `engine/src/adapters/vfarm/live_client.ts` (`VfarmLiveClient`) |
| 3 | BHARAG evidence/confidence handling: CST stores incident references only; does not query BHARAG for live farm data | `engine/src/connectors/vfarm.ts` — "No BHARAG fallback — vFarm is the only source" (line 376) |
| 4 | Test fixtures vs real identities: `+15551112222` (KNOWN_MANAGER), `+15550007777` (PHONE) are seeded test fixtures in test files only; not real customer identities | `tests/voice/voice_failure_path.test.ts:51`, `tests/voice/voice_lane_deadline.test.ts:34` |
| 5 | `project_id` represents the tenant-scoped project context (e.g., `proj-vfarm-main`); carried in message envelope: tenant_id, project_id, channel, speaker_ref, text, media, correlation_id, metadata | `engine/src/core/envelope.ts`; `docs/2026-09-17-cst-platform-tenancy-requirements.md` |
| 6 | Affected table/record: `voice_deliveries` table (status, error_code, error_message, correlation_id); `messages_out` table (alert_audit_log FK); `security_ledger` | `engine/src/db/client.ts`; `db/migrations/008_018m_alert_audit_log.sql` |

### Remaining Issue

- Record-level proof (live test with real correlation IDs) needs authorized live test; not yet performed.

### Ready for Resubmission: NO

---

## Entry 399 — Production Investigation Quality

### Original Reviewer Objections

1. `log_not_runbook` — production timestamp transcription unclear.
2. A 404 cause presented as hypothesis without adequate evidence.
3. Database/endpoint decisions handed off verbally instead of documented.
4. Missing correlation/request ID.

### Verified Corrections

| # | Correction | Evidence |
|---|---|---|
| 1 | Render error and timestamp: Historical incident `LOOP-1793620799001-3NBE` — `/api/v1/readings/latest?sensor_id=X` measured at ~29.6s; interim `/api/v1/readings?sensor_id=X&limit=1` at ~271ms | Jegan's production measurements (documented in task); `engine/src/adapters/vfarm/live_client.ts:667-675` |
| 2 | Root cause: `/readings/latest` orders by `received_at` without supporting index `(sensor_id, reading_ts)`; confirmed by vFarm correction document (`docs/corrections.md_Corrections_vfarm_unit_values_endpoints`) | `docs/corrections.md` — vFarm GET /api/v1/readings/latest requires sensor_id; farm_id query is invalid |
| 3 | Database/endpoint decision: CST switches to `/api/v1/readings?sensor_id=X&limit=1` until Jegan confirms `/latest` fix; decision recorded in code comments and this report | `engine/src/adapters/vfarm/live_client.ts:667-675` (code comments); `docs/evidence/cst-monitoring-pay-gate-acceptance.md` section B.7 |
| 4 | Correlation/request ID: All cross-system events carry `correlation_id`, `tenant_id`, `project_id`, `channel`, `speaker_ref` | `engine/src/core/envelope.ts`; `tests/voice/*` use `correlation_id` throughout |

### Remaining Issue

- Production timestamp transcription needs authorized Render log access (read-only).
- 404 root cause is confirmed via vFarm correction document, not hypothesis.

### Ready for Resubmission: PARTIAL (code decision documented; production log access pending)

---

## 29 October — Missing Engine Surfacing

### Original Reviewer Objection

- `missing_engine_surfacing` — Monitoring Twin watch conditions, Research Twin escalation conditions, Front Door buyer promises and limitations not documented.

### Verified Corrections

| # | Correction | Evidence |
|---|---|---|
| 1 | Monitoring Twin consumes: vFarm `fleet_status`, `farm_health.status`, per-sensor readings; CST surfaces via `/api/health` and voice/text responses | `engine/src/app.ts:179-251`; `engine/src/connectors/vfarm.ts:391-418` |
| 2 | Authoritative vFarm fields: `farm_health.status` (healthy/unhealthy), `device_count`, `online_count`, `offline_count`, `unhealthy_count`, per-sensor `values.*` | `engine/src/adapters/vfarm/schemas.ts:300-340` |
| 3 | Healthy/unhealthy/degraded/unknown mapping: `mapFarmHealthStatus()` — only `healthy`/`unhealthy` pass through; everything else → `degraded`/`unknown` | `engine/src/app.ts:35-40` |
| 4 | Monitoring alert conditions: `authorization_denied`, `no_reading`, `invalid_request`, `timeout`, `unhealthy_health`, `degraded_health`, `unknown_health` | `docs/contracts/monitoring-research-twin-field-contract.md:144-154` |
| 5 | Investigation trigger: CST logs triggers to structured logs; surfaces via `/api/health`; no programmatic Research Twin integration (BLOCKED) | `docs/contracts/monitoring-research-twin-field-contract.md:156-170` |
| 6 | Research Twin reception: NOT available — no approved contract, no card creation, no lifecycle sync | `docs/contracts/monitoring-research-twin-field-contract.md:156-170` |
| 7 | Tenant/project/correlation preservation: `tenant_id`, `project_id`, `correlation_id` carried in message envelope and voice turn | `engine/src/core/envelope.ts`; `engine/src/interfaces/voice/index.ts:41-54` |

### Remaining Issue

- Research Twin integration remains BLOCKED pending Destiny/Jegan contract confirmation.
- Front Door buyer promises/limitations need product owner input.

### Ready for Resubmission: PARTIAL (data flow documented; live integration blocked)

---

## 30 October — Evidence Smoothed Over

### Original Reviewer Objections

1. `evidence_smoothed_over` — offline/zero-sensor versus normal relay discrepancy not shown.
2. `normal` presented when required inputs missing/offline.
3. Missing deterministic test cases.
4. Missing API JSON and rendered text assertions.
5. Missing customer/commercial impact.
6. Missing upstream dependencies.
7. Code-level fixes vs upstream vFarm fixes not separated.

### Verified Corrections

| # | Correction | Evidence |
|---|---|---|
| 1 | Offline/zero-sensor vs normal: `mapLatestReadingToTelemetry()` — all values missing → `telemetry_unavailable` (never `normal`); error_code/error_message → `fault` | `engine/src/connectors/vfarm.ts:91-128` |
| 2 | `normal` not claimed when inputs missing: `allValuesMissing` check returns `telemetry_unavailable`; 404 returns null (not fabricated) | `engine/src/connectors/vfarm.ts:113-121`; `engine/src/adapters/vfarm/index.ts:669-671` |
| 3 | Deterministic test cases: `tests/adapters/vfarm_per_sensor_classification.test.ts` — 404, 401/403, 422, 5xx, timeout, partial results, concurrency, empty farm | `tests/adapters/vfarm_per_sensor_classification.test.ts` |
| 4 | API JSON and rendered text: `health_route.test.ts` asserts JSON `status`, `farm_health.status`, `staleness_evaluation`; connector tests assert `res.text` content and `res.telemetry.status` | `tests/health/health_route.test.ts`; `tests/connectors/vfarm_farm_level_status.test.ts` |
| 5 | Commercial impact: Incorrect sensor data presentation risks misleading farm operators; delayed `/readings/latest` (29.6s) causes voice turn timeouts and abandoned conversations | Mission document section 10 (Commercial Impact) |
| 6 | Upstream dependencies: vFarm timestamp, five-minute rule, never-heard correction, `/readings/latest` fix, Research Twin contract | `docs/evidence/CST_Blocker_Register.md` (B-01 through B-05) |
| 7 | Code-level vs upstream separation: CST code changes are sensor endpoint switch and health mapping; upstream fixes belong to Jeganathan (vFarm DB performance, pH calibration, JSONB stats timeout) | Mission document section 5.5 (Separate vFarm work) |

### Remaining Issue

- Live P1.0 app verification for upstream-specific behavior not yet performed (requires vFarm owner confirmation).

### Ready for Resubmission: PARTIAL (code-level corrections documented; upstream verification pending)

---

## Summary

| Entry | Original Objection | Correction Status | Ready for Resubmission |
|---|---|---|---|
| 393 | mission_fit_not_stated, identity clarity | Documented with code references | NO |
| 399 | log_not_runbook, 404 hypothesis, verbally handed off | Documented with evidence; production log access pending | PARTIAL |
| 29 October | missing_engine_surfacing | Data flow documented; live integration blocked | PARTIAL |
| 30 October | evidence_smoothed_over | Code-level corrections documented; upstream verification pending | PARTIAL |
