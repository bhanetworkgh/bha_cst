# Entry 399 Update Draft — Render Incident Evidence, Endpoint Contract, and Database/Continuity Decision

**Status:** DRAFT — ready to copy into the authoritative tracking entry  
**Date:** 2026-10-29  
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

## Database Continuity Decision

**Status: PENDING OWNER APPROVAL**

| Option | Pros | Cons | Risk |
|--------|------|------|------|
| Upgrade to paid plan | No migration, no downtime, simplest | Ongoing cost | Low |
| Migrate to new database | Fresh start, clean schema | Downtime, data transfer, FK validation | Medium |
| Backup/restore only | No cost change | Backup not tested against full restore in production | High (time-bound) |

**Recommendation:** Upgrade to paid plan before expiry. The restore drill proves the backup is structurally valid (80,365 bytes, 20 tables, 22 migrations, 17 FKs), but does not prove zero-downtime recovery.

**Owner:** Account owner / infrastructure team  
**Deadline:** November 14, 2026

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
| Outstanding approvals | Database continuity, staging deployment, KMG9 boundary, ElevenLabs credentials | All pending |

## Rationale and Alternatives

### Database Continuity
- **Current:** Free plan expires Nov 14, 2026. Backup verified (80,365 bytes, CUSTOM format). Restore drill passed (20 tables, 22 migrations, 17 FKs).
- **Alternative 1 (Upgrade):** Simplest, no migration, no downtime. Ongoing cost. Low risk.
- **Alternative 2 (Migrate):** Fresh start, clean schema. Downtime, data transfer, FK validation. Medium risk.
- **Alternative 3 (Backup/restore only):** No cost change. But backup not tested against full restore in production. High risk (time-bound).
- **Recommendation:** Upgrade to paid plan before expiry. The restore drill proves the backup is structurally valid, but does not prove zero-downtime recovery.

### Readings Endpoint
- **Current:** `/readings/latest` requires `sensor_id`. CST originally called with `farm_id` → 404.
- **Fix:** List devices first, then fetch per-device readings. This is the only supported approach given the API contract.
- **Alternative:** Use `/readings/properties?farm_id=` to discover which sensors have readings, then fetch only those. This would reduce unnecessary 404 calls but adds complexity.

## Acceptance Criteria

1. **Authorized farm/device access:** Speaker farm grant verified via `assertSpeakerFarmAccess()` before any upstream call. ✅ Code verified, tests pass.
2. **Successful per-sensor readings retrieval:** `listLatestReadings` now uses `sensor_id` (correct). Live API confirms 8/23 devices return readings. ⚠️ Rack sensors time out (29-43s).
3. **Accurate measurement mapping:** `mapLatestReadingToTelemetry` correctly extracts temperature, humidity, pH, CO, soil moisture, relay from `values.*.value`. Zero values preserved. ✅ Code verified, tests pass.
4. **Correct treatment of 404s, stale readings, timeouts:** 404 → skip, stale → flagged, timeout → skip + "No per-unit readings available". ✅ Code verified, tests pass.
5. **No cross-tenant or unauthorized data access:** Fail-closed authorization, no fabricated identity/grant. ✅ Code verified, tests pass.
6. **Voice response within 7-second deadline:** Rack sensors (29-43s) will always time out. Relay sensors (~0.7s) return in time. Partial results available. ⚠️ Upstream performance issue.
7. **Partial-result behavior when one sensor is slow:** `Promise.allSettled` with bounded concurrency. Slow sensors skipped, fast sensors reported. ✅ Code verified, tests pass.
8. **Persisted turn/audit evidence:** Security ledger records turn outcomes. Conversation persistence on successful turns. ⚠️ Deadline-exceeded turns abandoned without persistence (by design, fail-closed).
9. **Reproducible tests and production verification:** 1006 tests pass. Live API verified (read-only). Production E2E not performed. ⚠️ Partial.
10. **Documented database continuity and migration decision:** This record. Migration 022 applied in production. ⚠️ Owner decision on continuity pending.

## Evidence and Links

- **Test results:** `npx vitest run` → 1006 passed, 6 skipped, 0 failed (97 files)
- **Typecheck:** `npm run typecheck` → clean
- **Build:** `npm run build` → successful
- **Backup verification:** `bash scripts/verify_cst_postgres_backups.sh /Users/HaMi/cst-db-backups` → 1 PASS, 2 FAIL
- **Live API evidence:** `VFARM_DEVICE_READINGS_REPORT.md` in workspace root
- **Render logs:** Delivery callback `outbound_row_found: false` for SIDs `SM291a...`, `SM9c80...`, `SMcced...`, `SM7682...`
- **Code SHA:** Local HEAD `c8de2f6` (fix/cst-slack-error-notifications branch)
- **Deployed SHA:** `78075b19757f` (PR #13 merged, 2026-10-28T20:58:17Z)

## Still Open

- **BLOCKER:** Rack sensor timeout (29-43s) exceeds 7s voice deadline — upstream vFarm performance
- **BLOCKER:** KMG9 BHARAG boundary — needs isolated cluster evidence
- **BLOCKER:** Postgres continuity — owner decision before Nov 14 2026
- **BLOCKER:** ElevenLabs live voice acceptance — needs staging + authorized test call
- **BLOCKER:** Twilio live SMS/callback acceptance — needs production credentials
- **BLOCKER:** Delivery callback attribution — production DB investigation needed
- **BLOCKER:** GitHub push access — SSH key passphrase unavailable
- **BLOCKER:** Stale customer refs — owner confirmation needed
- **BLOCKER:** Legacy systems table — owner decision needed
- **BLOCKER:** EWQI vFarm contract — vFarm owner confirmation needed

## Links

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
