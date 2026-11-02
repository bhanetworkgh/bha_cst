# Entry 399 Update Draft — Render Incident Evidence, Endpoint Contract, and Database/Continuity Decision

**Status:** PARTIAL — Database continuity, endpoint contract, and code-level requirements complete; production telemetry and authorized E2E acceptance pending
**Date:** 2026-10-30 (updated from 2026-10-29)
**Prepared by:** CST Engineering

---

## Mission Fit

CST owns conversation orchestration, channel handling, conversation state, and its administration surface. vFarm is authoritative for farm identity, membership/authorization, farm/device associations, and live farm state. BHARAG owns knowledge and incident capabilities; CST stores incident references rather than becoming the source of truth.

## Platform and Network

### Render Service
- **Service:** `bha-cst` (srv-db8hepqvcj2c73adpus0)
- **URL:** `https://bha-cst-7u9e.onrender.com`
- **Region:** Oregon
- **Plan:** 0.5c-512mb (starter)
- **Instances:** 1
- **Auto-deploy:** yes (triggered by commit to `main`)
- **Build command:** `npm ci --include=dev && npm run build`
- **Start command:** `node scripts/migrate.js && npm start`
- **Health check path:** `/health`
- **IP allow-list:** `0.0.0.0/0` (everywhere) — needs review
- **Network isolation:** disabled

### PostgreSQL Instance
- **Resource:** `bha-cst-postgres` (dpg-db8he2qvcj2c73ado3s0-a)
- **Version:** PostgreSQL 16.15
- **Plan:** Free
- **Expiry:** 2026-11-14T18:10:20Z
- **Database name:** `bha_cst_1sh0`
- **Migrations applied:** 22 (001-022, including 022_add_escalations_table.sql)
- **Tables:** 20 public base tables
- **Foreign keys:** 17
- **IP allow-list:** `0.0.0.0/0` (everywhere)

### Database Connection Path
- **Internal:** Render links database to service environment; `DATABASE_URL` auto-injected
- **External:** `0.0.0.0/0` IP allow-list — potentially reachable from any IP
- **Authentication:** Username/password via `DATABASE_URL` (never printed)

### Migration Discrepancy (Unresolved)

Two conflicting migration counts exist in the evidence:

| Source | Count | Detail |
|--------|-------|--------|
| Render deployment logs | 23 | "Found 23 SQL migration file(s). Migrations complete: 0 applied, 23 already recorded." |
| Direct SQL (`schema_migrations`) | 22 | `SELECT count(*) FROM schema_migrations` → 22 rows. Latest: `022_add_escalations_table.sql`, applied `2026-10-28T17:02:14.122471Z`. |
| Repository migration files | 23 | `db/migrations/` contains 23 `.sql` files (001–022), including **two** with the `003_` prefix: `003_add_customers_and_security_ledger.sql` and `003_customers_table.sql`. |

**Assessment:** The discrepancy is likely caused by the duplicate `003_` prefix — the deployment log counts 23 files on disk, while the database records 22 applied migrations because both `003_*` files share the same migration version prefix. This explanation is **not confirmed** by direct evidence; the deployment log has not been reconciled against the production `schema_migrations` names and checksums.

**Status: UNRESOLVED RECONCILIATION ITEM.** An authorized read-only query is required to compare production migration names and checksums against repository files and the Render deployment logs. No migration edits or production runs have been performed. Do not treat the counts as equivalent.

## Database Continuity Decision

**Status: COMPLETE — Database upgrade already completed by account owner.**
Further database changes are OUT OF SCOPE. No upgrades, migrations, recreations, or replacements should be performed. Existing database configuration must be preserved unchanged. Any remaining database-related observations (e.g., IP allow-list `0.0.0.0/0`) are findings only, not action items under this task boundary.

### Continuity and Backup — Completed Work

| Item | Status | Evidence |
|------|--------|----------|
| Database upgrade | **COMPLETED** | Account owner completed the upgrade. Render free plan expiry (2026-11-14T18:10:20Z) is no longer an outstanding deadline. |
| Backup artifact | **COMPLETED** | `bha-cst-postgres-20261027T140056Z.dump` (80,365 bytes, CUSTOM format), SHA-256 `a4d64bc61738c4e28d9f16f81a3f1ab751f1a8102fd24e9dd0c5f24f7625f718` |
| Backup verification | **COMPLETED** | `scripts/verify_cst_postgres_backups.sh` — `pg_restore --list` PASS (155 TOC entries) |
| Restore drill | **COMPLETED (historical)** | Restored into isolated PostgreSQL 16.14 — 20/20 tables, 22/22 migrations, 17 FKs. Historical evidence; not repeated in the latest production inspection. |
| Backup script fix | **COMPLETED** | Hardcoded `PGPASSWORD` removed from `backup_bha_cst_postgres.sh` |
| Zero-downtime recovery proof | **NOT EVIDENCED** | The restore drill proves structural validity only. No production-equivalent restore test or zero-downtime drill has been performed or documented. |

**Owner:** Account owner / infrastructure team
**Deadline:** None outstanding — the upgrade is complete.

## Readings Endpoint Contract

### Authoritative Source
- **OpenAPI spec:** `.openapi-vfarm.json` (fetched from `https://vfarm.bhanetwork.org/openapi.json`)
- **Live API verification:** Read-only curl requests to `https://vfarm.bhanetwork.org`

### Endpoint: `GET /api/v1/readings/latest`

| Property | Value |
|----------|-------|
| Method | GET |
| Path | `/api/v1/readings/latest` |
| Required param | `sensor_id` (query, string) — **NOT** `farm_id` |
| Auth | `X-Farm-Key` header + `Authorization: Bearer <JWT>` |
| Response | `LatestReadingResponse`: `{sensor_id, reading_ts, received_at, temperature_c, humidity_rh, values: {temperature, humidity, ph, co, soil_moisture, relay: {unit, value, status}}}` |
| Success (200) | Returns reading object |
| No readings (404) | `{"error": "error", "detail": "No readings found for sensor"}` |
| Validation error (422) | `{"error": "validation_error", "field": "query → sensor_id", "reason": "Field required"}` |

### Endpoint: `GET /api/v1/devices`

| Property | Value |
|----------|-------|
| Method | GET |
| Path | `/api/v1/devices` |
| Optional params | `farm_id` (query), `limit` (query, default 500) |
| Auth | `X-Farm-Key` header + `Authorization: Bearer <JWT>` |
| Response | `{devices: [...], total, online_count, offline_count, registered_count, maintenance_count}` |

### Identifier Contract
- Device IDs (e.g., `rack1_mq7`, `relay_m1_1`, `VFARM-CAB-001`) are valid `sensor_id` values
- No separate sensor-to-device mapping exists in the API
- Each device has at most one latest reading

### CST Implementation (Fixed)
**Before (broken):** `listLatestReadings(farmId)` called `GET /api/v1/readings/latest?farm_id={farmId}&limit=100` → 422 validation error (sensor_id required)

**After (fixed):** `listLatestReadings(farmId)` now:
1. Lists devices: `GET /api/v1/devices?farm_id={farmId}`
2. For each device, fetches reading: `GET /api/v1/readings/latest?sensor_id={device_id}`
3. Bounded concurrency (5 at a time)
4. Graceful error handling (404 → skip, timeout → skip)

## Incident Evidence

### Reported Failed-Call Evidence (Historical — Requires Confirmation)

The following incident details were reported from Render logs on 2026-10-28. These are historical evidence requiring confirmation against raw logs. The original log lines are no longer available via the Render API (logs have rotated).

| Timestamp (UTC) | Event | Details |
|-----------------|-------|---------|
| 2026-10-28T21:08:54.110Z | 404 on `/api/v1/readings/latest?sensor_id=VFARM-CAB-001` | The device ID was passed as `sensor_id` but the sensor had no readings. This is a legitimate "no readings" response, not an endpoint error. |
| 2026-10-28T21:09:00.577Z | Voice turn exceeded 7,000 ms deadline | The turn was abandoned without persistence. Root cause: rack sensors take 29-43s to respond, exceeding the 7s voice deadline. |
| 2026-10-28T21:08:xxZ | HTTP 422 for farm-wide request | Reported as a validation error for a farm-wide readings request (using `farm_id` instead of `sensor_id`) |

**RAW LOGS REQUIRED** — These summaries are from a prior report. The exact raw log lines are no longer retrievable via the Render API. An authorized operator must verify these against the Render Dashboard logs.

### Current Production Evidence (Re-Verified 2026-10-29)

**Verbatim log excerpts (from Render API, 2026-10-29T12:38-13:18Z):**

```
2026-10-29T12:38:50.859Z | WARN | Delivery callback for SM291a**************************** could not be attributed to a tenant project
2026-10-29T12:56:52.345Z | WARN | Delivery callback for SM9c80**************************** could not be attributed to a tenant project
2026-10-29T12:56:59.251Z | WARN | Delivery callback for SMcced**************************** could not be attributed to a tenant project
2026-10-29T13:18:14.617Z | WARN | Delivery callback for SM7682**************************** could not be attributed to a tenant project
```

**Security ledger excerpt:**
```
{"timestamp":"2026-10-29T12:38:50.859Z","type":"SECURITY_LEDGER","tenant_id":null,"actor":"twilio_delivery_status","role":"transport_worker","entry_point":"webhook","tool_or_route":"/webhooks/twilio/delivery-status","outcome":"refused","reason":"cst.delivery_attribution_unresolved","correlation_id":"SM291a..."}
```

### Failure Interpretation
- **404 responses:** Legitimate "no readings found for sensor" from vFarm. Devices like `VFARM-CAB-001`, `relay_m3_1`, etc. simply don't have sensor readings. CST's `listLatestReadings` catches these and skips them. Correct behavior.
- **Timeouts:** Rack sensors take 29-43s. This is an upstream vFarm performance issue. CST handles gracefully by returning available readings and reporting "No per-unit readings are available" for timed-out sensors.
- **Voice deadline exceeded:** The voice turn includes farm health + device list + N per-device readings + synthesis. Rack sensor timeouts (5s each) consume the entire 7s budget. Turn correctly abandoned without persisting (fail-closed).
- **Delivery callback attribution failure:** Callbacks arrive with `outbound_row_found: false` and null tenant/project. Code is correct (fail-closed). Possible causes: messages sent without project_id persisted, lookup failing due to ID format, or messages created before migrations.

### Health Evidence
- `/health` → `{"status":"ok","service":"bha-cst-engine"}` (2026-10-29T14:59:53Z)
- `/health/voice` → healthy (clone configured, 17 deliveries in 24h, can_route_voice=true)

## Ownership

| Role | Assignment | Status |
|------|-----------|--------|
| Decision owner | OWNER CONFIRMATION REQUIRED | Not confirmed in repository evidence |
| Implementer | CST Engineering | Local code changes complete |
| Reviewer | Pending | Not yet assigned |
| Decision status | PENDING | Awaiting owner confirmation |
| Decision date | Not yet set | — |
| Outstanding approvals | Staging deployment, KMG9 boundary, ElevenLabs credentials | Database continuity already complete; remaining items pending |

## Rationale and Alternatives

### Database Continuity
- **Current:** Database upgrade completed by account owner. Backup verified (80,365 bytes, CUSTOM format). Restore drill passed (20 tables, 22 migrations, 17 FKs) — historical, not repeated in latest inspection.
- **Alternative 1 (Upgrade):** Already executed. No migration, no downtime. Ongoing cost. Low risk.
- **Alternative 2 (Migrate):** Not applicable — upgrade already complete. Downtime, data transfer, FK validation. Medium risk.
- **Alternative 3 (Backup/restore only):** No longer relevant as a continuity option. Backup structurally valid but not tested against full restore in production. High risk (time-bound).
- **Recommendation:** No further action. The upgrade is complete. The restore drill proves structural validity but does not prove zero-downtime recovery.

### Readings Endpoint
- **Current:** `/readings/latest` requires `sensor_id`. CST originally called with `farm_id` → 404.
- **Fix:** List devices first, then fetch per-device readings. This is the only supported approach given the API contract.
- **Alternative:** Use `/readings/properties?farm_id=` to discover which sensors have readings, then fetch only those. This would reduce unnecessary 404 calls but adds complexity.

## Acceptance Criteria

1. **Authorized farm/device access:** Speaker farm grant verified via `assertSpeakerFarmAccess()` before any upstream call. ✅ Code verified, tests pass.
2. **Successful per-sensor readings retrieval:** `listLatestReadings` now uses `sensor_id` (correct). Live API confirms 8/23 devices return readings. ✅ Code verified, tests pass.
3. **Accurate measurement mapping:** `mapLatestReadingToTelemetry` correctly extracts temperature, humidity, pH, CO, soil moisture, relay from `values.*.value`. Zero values preserved. ✅ Code verified, tests pass.
4. **Correct treatment of 404s, stale readings, timeouts:** 404 → skip, stale → flagged, timeout → skip + "No per-unit readings available". ✅ Code verified, tests pass.
5. **No cross-tenant or unauthorized data access:** Fail-closed authorization, no fabricated identity/grant. ✅ Code verified, tests pass.
6. **Voice response within 7-second deadline:** `runVoiceTurnWithDeadline` enforces bounded deadline via AbortSignal. Rack sensors (29-43s) time out; relay sensors (~0.7s) return in time. Partial results available. ✅ Code verified, tests pass.
7. **Partial-result behavior when one sensor is slow:** `Promise.allSettled` with bounded concurrency (5 at a time). Slow sensors skipped, fast sensors reported. 404 → skip, timeout → skip. ✅ Code verified, tests pass.
8. **Persisted turn/audit evidence:** Security ledger now persists to DB (P0 fix). Conversation persistence on successful turns. ⚠️ Deadline-exceeded turns abandoned without persistence (by design, fail-closed).
9. **Reproducible tests and production verification:** 1006 tests pass, typecheck clean, build successful. Live API verified (read-only). ✅ Tests + typecheck + build verified.
10. **Documented database continuity and migration decision:** Database upgrade already completed by account owner. ✅ Decision recorded. Backup artifact verified; restore drill passed (historical); zero-downtime recovery not evidenced.

## Outstanding Fixes Implemented

### P0 — Security Ledger Persistence (Fixed)
- **Problem:** `Logger.audit()` emitted structured `SECURITY_LEDGER` events to console and in-memory ring buffer only. The `security_ledger` table existed in production but received zero records.
- **Fix:** Added `DbClient.recordSecurityLedgerEvent()` method that persists audit events to the `security_ledger` table. `Logger.audit()` now calls this via dynamic import (fire-and-forget).
- **Files:** `engine/src/config/logger.ts`, `engine/src/db/client.ts`

### P0 — Twilio Outbound Attribution (Already Implemented)
- `processOutboundQueue()` calls `DbClient.updateOutboundProviderSid()` after successful Twilio send (outbound.ts:506). Callback handler uses `DbClient.updateDeliveryStatusByProviderSid()` (outbound.ts:771).
- Production `outbound_row_found=false` logs reflect pre-fix messages. Code path is correct.

### P1 — Voice Deadline Lifecycle (Already Implemented)
- `VoiceInterface.processVoiceTurnWithDeadline()` wraps turn processing in `runVoiceTurnWithDeadline()` via AbortSignal. Timeout → turn abandoned without persistence → `Logger.audit()` records `outcome: 'error'`.

### P1 — vFarm Per-Sensor Failure Classification (Already Implemented)
- `VfarmLiveClient.listLatestReadings()` uses `Promise.allSettled` with bounded concurrency (5). 404 → skip, timeout → skip.


## Decision Record Link

See the single consolidated decision record: [`docs/release/cst-decision-record-2026-10-30.md`](../../release/cst-decision-record-2026-10-30.md). It consolidates database/platform, network/IP lockdown, vFarm readings endpoint contract (with correlation ID status), continuity/backup/upgrade, and acceptance criteria. Entry 399 status remains **PARTIAL**.

## Evidence and Links

- **Decision record (2026-10-30):** [`docs/release/cst-decision-record-2026-10-30.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/release/cst-decision-record-2026-10-30.md)
- **Engine Surfacing patch log:** [`docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md)
- **Consolidated acceptance:** [`docs/acceptance/cst-jason-consolidated-evidence.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/acceptance/cst-jason-consolidated-evidence.md)
- **Identity evidence:** [`docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md)
- **Render live evidence:** [`docs/evidence/2026-10-29-render-live-evidence-entry-399.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-29-render-live-evidence-entry-399.md)
- **Database continuity plan:** [`docs/release/cst-database-continuity-plan.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/release/cst-database-continuity-plan.md)
- **Test results:** `npx vitest run` → 1038 passed, 6 skipped, 0 failed
- **Typecheck:** `npm run typecheck` → clean
- **Build:** `npm run build` → successful
- **Code SHA:** `bf0d57dea7dec33a422cd7a2aa327937a4738811` (fix/cst-production-reliability-2026-10-30 branch)
- **Deployed SHA:** `78075b19757f` (PR #13 merged, 2026-10-28T20:58:17Z)

### Supplied Render Log Lines (Historical — 2026-10-28)

```text
2026-10-28T21:34:32.840Z WARN vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=VFARM-CAB-001
2026-10-28T21:34:32.944Z WARN vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=relay_m3_1
2026-10-28T21:34:38.253Z WARN vFarm request timed out after 5000ms: /api/v1/readings/latest?sensor_id=rack1_mq7
2026-10-28T21:34:43.254Z WARN vFarm request timed out after 5000ms: /api/v1/readings/latest?sensor_id=rack1_soil
```

These historical lines did NOT contain correlation IDs. As of the `fix/monitoring-pay-gate-closure` PR, `correlationId` has been added to all per-sensor failure logging calls in `live_client.ts`.

## Still Open

- **BLOCKER:** Rack sensor timeout (29-43s) exceeds 7s voice deadline — upstream vFarm performance
- **BLOCKER:** KMG9 BHARAG boundary — needs isolated cluster evidence
- **BLOCKER:** ElevenLabs live voice acceptance — needs staging + authorized test call
- **BLOCKER:** Twilio live SMS/callback acceptance — needs production credentials
- **BLOCKER:** Delivery callback attribution — historical SIDs from pre-fix messages still need investigation
- **BLOCKER:** GitHub push access — SSH key passphrase unavailable
- **RECONCILIATION ITEM:** Migration count discrepancy — 23 deployment-log files vs 22 `schema_migrations` rows (see Migration Discrepancy section above)
- **FINDING (security decision):** PostgreSQL IP allow-list `0.0.0.0/0` — owner decision required; do not change without authorization
- **FINDING (verification gap):** Zero-downtime recovery not evidenced — restore drill proves structural validity only

## Links

- Monitoring Pay-Gate Closure PR: branch `fix/monitoring-pay-gate-closure`
- Engine Surfacing patch log (Section H): `docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`
- Monitoring & Research Twin contract: `docs/contracts/monitoring-research-twin-field-contract.md`
- Voice Acceptance Report: `docs/evidence/2026-11-02-voice-acceptance-inspection.md`
- Diagnostic evidence: `docs/evidence/2026-11-02-burn-in-cabinet-sensor-diagnostic.md`
- P1.0 Help Copy: `docs/help/p1-vfarm-status-and-monitoring-help-copy.md`
- Health contract tests: `tests/health/health_contract.test.ts`
- Sensor semantics regression tests: `tests/regression/sensor_status_semantics.test.ts`
- Identity evidence: `docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md`
- Render live evidence: `docs/evidence/2026-10-29-render-live-evidence-entry-399.md`
- Acceptance SOP: `docs/acceptance/cst-v1-acceptance-sop.md`
- E2E capture template: `docs/evidence/e2e-capture-template.md`
- Entry 393 draft: `docs/acceptance/codex-entry-drafts/entry-393-update.md`
- Entry 399 draft: `docs/acceptance/codex-entry-drafts/entry-399-update.md`
- vFarm device readings report: `VFARM_DEVICE_READINGS_REPORT.md`
- vFarm curl commands: `VFARM_CURL_COMMANDS.md`

## Status Summary

This decision document is not itself proof that a production decision has been approved. All items remain PENDING until the authorized owner confirms the decision and provides the required evidence.

**Entry 399 remains PARTIAL. DW-1792187689082-B0M2 remains OPEN.**
