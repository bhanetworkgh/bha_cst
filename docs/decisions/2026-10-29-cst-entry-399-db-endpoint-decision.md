# CST Entry 399 — Database and Endpoint Decision Record

**Date:** 2026-10-29  
**Status:** PENDING (awaiting authorized owner confirmation)  
**Decision owner:** OWNER CONFIRMATION REQUIRED  
**Implementer:** CST Engineering (local code changes)  
**Reviewer:** Pending

---

## 1. Purpose and Mission Fit

CST owns conversation orchestration, channel handling, conversation state, and its administration surface. vFarm is authoritative for farm identity, membership/authorization, farm/device associations, and live farm state. BHARAG owns knowledge and incident capabilities; CST stores incident references rather than becoming the source of truth.

This decision record covers the database continuity posture and the vFarm readings endpoint contract that CST depends on for live telemetry delivery.

## 2. Platform and Database

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

### PostgreSQL Instance
- **Resource:** `bha-cst-postgres` (dpg-db8he2qvcj2c73ado3s0-a)
- **Version:** PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2)
- **Plan:** Free
- **Expiry:** 2026-11-14T18:10:20Z (verified via Render API)
- **Database name:** `bha_cst_1sh0`
- **IP allow-list:** `0.0.0.0/0` (everywhere) — needs review
- **Network isolation:** disabled
- **Migrations applied:** 22 (through `022_add_escalations_table.sql`)
- **Tables:** 20 public base tables
- **Foreign keys:** 17

### Database Access Path
- **Internal:** Render links database to service environment; `DATABASE_URL` auto-injected
- **External:** `0.0.0.0/0` IP allow-list — potentially reachable from any IP
- **Authentication:** Username/password via `DATABASE_URL` (never printed)

## 3. Database Access and IP Lockdown

### Current Verified Facts
- IP allow-list: `0.0.0.0/0` (everywhere) — confirmed via Render API
- Network isolation: disabled
- The service connects via Render's internal network (DATABASE_URL auto-injected)
- No evidence that external access is actually being used beyond the allow-list entry

### Security Implications
- The allow-list permits connections from any IP address
- Authentication (username/password) is still required
- No evidence of unauthorized access, but the broad allow-list increases attack surface

### Unresolved Questions
- Does CST require external database access for any operational purpose?
- Is the `0.0.0.0/0` entry a leftover from initial setup or an intentional configuration?
- What is the minimum safe allow-list based on actual deployment configuration?

### Recommendation
Do not narrow the allow-list until the correct source addresses/connectivity path have been verified and an owner authorizes the change. Document the impact and safe change plan for owner review.

## 4. Readings Endpoint Contract

### Authoritative Source
- **OpenAPI spec:** `.openapi-vfarm.json` (fetched from `https://vfarm.bhanetwork.org/openapi.json`)
- **Live API verification:** Read-only curl requests to `https://vfarm.bhanetwork.org`

### Endpoint: `GET /api/v1/readings/latest`

| Property | Value |
|----------|-------|
| Method | GET |
| Path | `/api/v1/readings/latest` |
| Required param | `sensor_id` (query, string) — **NOT** `farm_id` |
| Optional params | None |
| Auth | `X-Farm-Key` header + `Authorization: Bearer <JWT>` |
| Response | `LatestReadingResponse`: `{id, sensor_id, reading_ts, received_at, temperature_c (string\|null), temperature_status, humidity_rh (string\|null), humidity_status, firmware, uptime_s, wifi_rssi, error_code, error_message, values: {temperature, humidity, ph, co, soil_moisture, relay: {unit, value, status}} \| null}` |
| Success (200) | Returns reading object |
| No readings (404) | `{"error": "error", "detail": "No readings found for sensor"}` |
| Validation error (422) | `{"error": "validation_error", "field": "query → sensor_id", "reason": "Field required"}` (when sensor_id missing) |

### Endpoint: `GET /api/v1/devices`

| Property | Value |
|----------|-------|
| Method | GET |
| Path | `/api/v1/devices` |
| Optional params | `farm_id` (query), `limit` (query, default 500) |
| Auth | `X-Farm-Key` header + `Authorization: Bearer <JWT>` |
| Response | `{devices: [...], total, online_count, offline_count, registered_count, maintenance_count}` |

### Endpoint: `GET /api/v1/readings/properties`

| Property | Value |
|----------|-------|
| Method | GET |
| Path | `/api/v1/readings/properties` |
| Optional params | `farm_id` (query), `window` (query) |
| Auth | `X-Farm-Key` header + `Authorization: Bearer <JWT>` |
| Response | `{window, properties: [{id, name, unit, category, readings, sensors}]}` |

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

### CST Telemetry Mapping (Verified Correct)

| vFarm Field | CST Field | Spoken Label | Zero Preserved? |
|-------------|-----------|--------------|-----------------|
| `values.temperature.value` | `water_temp_c` | Temperature: X°C | Yes |
| `values.humidity.value` | `humidity_rh` | Humidity: X% | Yes |
| `values.ph.value` | `ph_level` | pH: X | Yes |
| `values.co.value` | `ec_level` | CO: X | Yes |
| `values.soil_moisture.value` | `water_level` | Soil Moisture: X% | Yes |
| `values.relay.value` | `relay` | Relay: ON/OFF | Yes |

**Note:** Top-level `temperature_c` and `humidity_rh` are always null in the API response. CST correctly prefers `values.*.value` over top-level fields. The `ec_level` field name is misleading (holds CO value) but the spoken label "CO" is correct — not mislabeled as electrical conductivity.

## 5. Ownership

| Role | Assignment | Status |
|------|-----------|--------|
| Decision owner | OWNER CONFIRMATION REQUIRED | Not confirmed in repository evidence |
| Implementer | CST Engineering | Local code changes complete |
| Reviewer | Pending | Not yet assigned |
| Decision status | PENDING | Awaiting owner confirmation |
| Decision date | Not yet set | — |
| Outstanding approvals | Database continuity, staging deployment, KMG9 boundary, ElevenLabs credentials | All pending |

## 6. Rationale and Alternatives

### Database Continuity
- **Current:** Free plan expires Nov 14, 2026. Backup verified (80,365 bytes, CUSTOM format). Restore drill passed (20 tables, 22 migrations, 17 FKs).
- **Alternative 1 (Upgrade):** Simplest, no migration, no downtime. Ongoing cost. Low risk.
- **Alternative 2 (Migrate):** Fresh start, clean schema. Downtime, data transfer, FK validation. Medium risk.
- **Alternative 3 (Backup/restore only):** No cost change. But backup not tested against full restore in production. High risk (time-bound).
- **Recommendation:** Upgrade to paid plan before expiry. The restore drill proves the backup is valid, but does not prove zero-downtime recovery.

### Readings Endpoint
- **Current:** `/readings/latest` requires `sensor_id`. CST originally called with `farm_id` → 404.
- **Fix:** List devices first, then fetch per-device readings. This is the only supported approach given the API contract.
- **Alternative:** Use `/readings/properties?farm_id=` to discover which sensors have readings, then fetch only those. This would reduce unnecessary 404 calls but adds complexity.

## 7. Continuity and Backup vs Upgrade

### Current Verified Facts
- Database plan: Free (Render)
- Expiry: 2026-11-14T18:10:20Z
- PostgreSQL version: 16.15
- Tables: 20 public base tables
- Foreign keys: 17
- Migrations: 22 applied (001-022)
- IP allow-list: 0.0.0.0/0 (everywhere)
- Network isolation: disabled

### Backup Status
- Backup artifact: `bha-cst-postgres-20261027T140056Z.dump` (80,365 bytes, CUSTOM format)
- SHA-256: `a4d64bc61738c4e28d9f16f81a3f1ab751f1a8102fd24e9dd0c5f24f7625f718`
- `pg_restore --list`: PASS (155 TOC entries)
- Two zero-byte files from failed backup attempts (preserved, not deleted)

### Restore Drill (Historical, User-Provided)
- Restored 20/20 tables, 22/22 migrations, 17 FKs into isolated PostgreSQL 16.14
- 4 `ALTER DEFAULT PRIVILEGES` errors for missing production role `bha_cst_user` — non-critical
- Verified record counts: customers(3), conversations(2), messages_out(2), sms_consents(1), voice_deliveries(60)

### Continuity Decision
**COMPLETE — Database upgrade already completed by account owner.** Further database changes are OUT OF SCOPE. No upgrades, migrations, recreations, or replacements should be performed. Existing database configuration must be preserved unchanged. Any remaining database-related observations (e.g., IP allow-list `0.0.0.0/0`) are findings only, not action items under this task boundary.

## 8. Acceptance Criteria

1. **Authorized farm/device access:** Speaker farm grant verified via `assertSpeakerFarmAccess()` before any upstream call. ✅ Code verified, tests pass.
2. **Successful per-sensor readings retrieval:** `listLatestReadings` now uses `sensor_id` (correct). Live API confirms 8/23 devices return readings. ⚠️ Rack sensors time out (29-43s).
3. **Accurate measurement mapping:** `mapLatestReadingToTelemetry` correctly extracts temperature, humidity, pH, CO, soil moisture, relay from `values.*.value`. Zero values preserved. ✅ Code verified, tests pass.
4. **Correct treatment of 404s, stale readings, timeouts:** 404 → skip (no reading), stale → flagged, timeout → skip + "No per-unit readings available". ✅ Code verified, tests pass.
5. **No cross-tenant or unauthorized data access:** Fail-closed authorization, no fabricated identity/grant. ✅ Code verified, tests pass.
6. **Voice response within 7-second deadline:** Rack sensors (29-43s) will always time out. Relay sensors (~0.7s) return in time. Partial results available. ⚠️ Upstream performance issue.
7. **Partial-result behavior when one sensor is slow:** `Promise.allSettled` with bounded concurrency. Slow sensors skipped, fast sensors reported. ✅ Code verified, tests pass.
8. **Persisted turn/audit evidence:** Security ledger records turn outcomes. Conversation persistence on successful turns. ⚠️ Deadline-exceeded turns are abandoned without persistence (by design, fail-closed).
9. **Reproducible tests and production verification:** 1006 tests pass. Live API verified (read-only). Production E2E not performed. ⚠️ Partial.
10. **Documented database continuity and migration decision:** COMPLETE — Database upgrade completed by account owner. Migration 022 applied in production. No further database changes required.

## 9. Evidence and Links

- **Test results:** `npx vitest run` → 1006 passed, 6 skipped, 0 failed (97 files)
- **Typecheck:** `npm run typecheck` → clean
- **Build:** `npm run build` → successful
- **Backup verification:** `bash scripts/verify_cst_postgres_backups.sh /Users/HaMi/cst-db-backups` → 1 PASS, 2 FAIL
- **Live API evidence:** `VFARM_DEVICE_READINGS_REPORT.md` in workspace root
- **Render logs:** Delivery callback `outbound_row_found: false` for SIDs `SM291a...`, `SM9c80...`, `SMcced...`, `SM7682...`
- **Code SHA:** Local HEAD `c8de2f6` (fix/cst-slack-error-notifications branch)
- **Deployed SHA:** `78075b19757f` (PR #13 merged, 2026-10-28T20:58:17Z)

## 10. Still Open

- **BLOCKER:** Rack sensor timeout (29-43s) exceeds 7s voice deadline — upstream vFarm performance
- **BLOCKER:** KMG9 BHARAG boundary — needs isolated cluster evidence
- **BLOCKER:** Postgres continuity — owner decision before Nov 14 2026
- **BLOCKER:** ElevenLabs live voice acceptance — needs staging + authorized test call
- **BLOCKER:** Twilio live SMS/callback acceptance — needs production credentials
- **BLOCKER:** GitHub push access — SSH key passphrase unavailable
- **BLOCKER:** Stale customer refs — owner confirmation needed
- **BLOCKER:** Legacy systems table — owner decision needed
- **BLOCKER:** EWQI vFarm contract — vFarm owner confirmation needed
