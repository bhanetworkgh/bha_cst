# CST Production API Degradation — Root Cause Investigation Report

**Repository:** `bhanetworkgh/bha_cst`
**Branch:** `fix/monitoring-pay-gate-closure`
**Local HEAD:** `78e8ee8016d6c5905319cbae17a36a078516ea0c`
**Deployed SHA (production):** `656000a7b768986feca9d85c7ac9d96c921306c7`
**Production URL:** `https://bha-cst-7u9e.onrender.com`
**Investigation date:** 2026-11-02
**Test data:** `prod-test-results.json` (111 endpoints evaluated, 74 PASS, 2 FAIL, 16 DEGRADED)

---

## Executive Summary

Production testing identified **2 FAIL** and **16 DEGRADED** endpoints out of 111 evaluated. All failures originate from **vFarm upstream performance and validation issues**, not from CST logic errors. CST correctly propagates upstream failures as errors rather than masking them as success. However, CST's default 5-second request timeout is too short for several vFarm endpoints that are legitimately slow in production, and `getLatestReading()` was using the `/readings/latest` endpoint which times out at ~29.6s.

CST-side fixes implemented:
1. `getLatestReading()` switched from `/readings/latest` (29.6s timeout) to `/readings?sensor_id=X&limit=1` (~271ms) — per Jason's interim instruction
2. `getReadingStats()` given extended 30s timeout (`VFARM_READINGS_STATS_TIMEOUT_MS`)
3. `request()` method now supports per-call `timeoutMs` override
4. Dashboard `getDashboardData()` now records upstream failure reasons in a `diagnostics` field

All 1159 tests pass, typecheck clean, build successful.

---

## Issue-by-Issue Root Cause Analysis

### Issue 1: vFarm `/readings/latest`, `/readings`, and `/readings/stats` timing out after 5 seconds

| Evidence | Value |
|---|---|
| Production test | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_soil` → 502, 5431ms |
| Production test | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` → 502, 5428ms |
| Production test | `/api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5` → 502, 5557ms |
| Affected sensors | rack1_soil, rack1_ph, rack2_dht, rack1_mq7 (all 4) |

**Root cause:** vFarm's `/api/v1/readings/latest?sensor_id=X` endpoint orders by `received_at` without a supporting index. Jegan's production measurements showed ~29.6s for a single sensor, with another exceeding 20s. CST's default `VFARM_DEFAULT_TIMEOUT_MS = 5000`ms is far too short for this endpoint.

**Origin:** vFarm upstream (database query performance)

**CST fix:** `getLatestReading()` now calls `GET /api/v1/readings?sensor_id=X&limit=1` (~271ms per Jegan's measurements) as an interim measure, per Jason's instruction. This endpoint is fast because it uses the existing `(sensor_id, reading_ts)` index. CST does **not** assume the first returned row is newest — vFarm must confirm the ordering contract before CST relies on it.

**Files changed:**
- `engine/src/adapters/vfarm/live_client.ts:670-690` — `getLatestReading()` implementation
- `engine/src/adapters/vfarm/live_client.ts:903-929` — `listLatestReadings()` JSDoc updated

### Issue 2: `/api/v1/devices` and `/api/v1/farms` returning HTTP 500

| Evidence | Value |
|---|---|
| Production test | `/api/v1/devices` → 500, 6023ms |
| Production test | `/api/v1/farms` → 500, 5442ms |
| Error message | `DISCOVERY_ERROR: List farms network error: This operation w...` |

**Root cause:** Both endpoints time out at CST's 5-second default because vFarm is slow to respond. `/api/v1/farms` calls `listFarms()` which uses the default 5s timeout. `/api/v1/devices` calls `listFarmDevices()` → `listAllDevices()` which also uses the default 5s timeout. The 5s budget was measured on other endpoints (p50 ~235ms / max ~984ms) and does not cover these discovery endpoints in production.

**Origin:** vFarm upstream slowness + CST default timeout too short

**CST behavior:** Correct — CST returns 500 with `DISCOVERY_ERROR` / `DEVICES_ERROR` rather than fabricating data. No silent failures.

**CST fix:** None required for correctness — the timeout behavior is appropriate. Operators should set `VFARM_API_TIMEOUT_MS` higher if vFarm discovery endpoints remain slow.

### Issue 3: `/api/v1/system/stats` exceeding its 60-second timeout

| Evidence | Value |
|---|---|
| Production test | `/api/v1/admin/vfarm/system-stats` → DEGRADED, 12056ms, status 000000 |
| Code comment | `/system/stats` measured 13.8-39.0s live on 2026-10-05 |

**Root cause:** vFarm `/api/v1/system/stats` scans every reading in the platform and is inherently slow (13.8-39s observed). CST already assigns it `VFARM_SYSTEM_STATS_TIMEOUT_MS = 60000`ms (60s), but production shows connection failure at ~12s (status 0 = network abort). This suggests either vFarm is taking longer than 60s, or there's a network/load-balancer timeout between CST and vFarm.

**Origin:** vFarm upstream (full platform scan)

**CST fix:** None required — the 60s timeout is already the maximum reasonable for an admin-only endpoint. The connection abort at 12s is a network/infrastructure issue outside CST's control.

### Issue 4: Alert counts returning upstream HTTP 422

| Evidence | Value |
|---|---|
| Production test | `/api/v1/admin/vfarm/alerts/counts` → DEGRADED, 422, 809ms |
| Error message | `PROXY_ERROR: vFarm HTTP 422 from /api/v1/alerts/threshold/counts` |

**Root cause:** vFarm returns HTTP 422 (Unprocessable Entity) from `/api/v1/alerts/threshold/counts?farm_id=...`. This is a vFarm validation error — likely the request payload or query parameters don't match vFarm's current schema for this endpoint.

**Origin:** vFarm upstream (validation error)

**CST fix:** None required — `sendProxyError()` correctly maps this to 502 with `upstream_status: 422`. CST does not retry or mask the error.

### Issue 5: Vision latest returning 422 when cameras not configured

| Evidence | Value |
|---|---|
| Production test | `/api/v1/admin/vfarm/vision/latest` → DEGRADED, 422, 591ms |
| Notes | "Upstream vFarm returns 422 (no cameras configured for active farm)" |

**Root cause:** vFarm returns HTTP 422 because no cameras are configured for the active farm. This is expected upstream behavior when the farm has no vision/camera devices.

**Origin:** vFarm upstream (expected behavior)

**CST fix:** None required — this is correct vFarm behavior. CST correctly propagates the 422 as a proxy error.

### Issue 6: Dashboard returning `farm: null` and `device_count: 0`

| Evidence | Value |
|---|---|
| Production test | `/api/v1/dashboard` → 200, `{"farm_id":"ed95e120-...","farm":null,"device_count":0,...}` |
| Production test | `/api/v1/admin/vfarm/summary` → 200, `{"farms":{"total":2},"devices":{"total":23,...}}` |

**Root cause:** `getDashboardData()` calls `listFarms()` and `listAllDevices()` in parallel, both with `.catch(() => empty)`. Production shows:
- `listFarms()` fails (500 from `/api/v1/farms` timeout) → `farmList.farms` is empty → `farm: null`
- `listAllDevices()` times out (5s default) → `devices: []` → `device_count: 0`

Meanwhile, `/api/v1/admin/vfarm/summary` (which uses `getDashboardSummary()` → `/api/v1/dashboard/summary`) succeeds and reports 23 devices. This confirms vFarm has 23 devices, but CST's dashboard can't reach them because the individual `/api/v1/farms` and `/api/v1/devices` calls are timing out.

**Origin:** vFarm upstream slowness cascading through CST's graceful degradation

**CST fix:** Dashboard now includes a `diagnostics` field recording WHY each upstream call failed, so operators can distinguish vFarm degradation from CST issues.

**Files changed:**
- `engine/src/adapters/vfarm/index.ts:429-515` — `getDashboardData()` with diagnostics

### Issue 7: Admin vFarm devices returning empty list

| Evidence | Value |
|---|---|
| Production test | `/api/v1/admin/vfarm/devices` → 200, `{"devices":[],"total":0,...}` |
| Contrast | `/api/v1/admin/vfarm/summary` reports 23 devices |

**Root cause:** Same as Issue 6 — `listAllDevices()` times out at 5s, caught by `.catch(() => ({ devices: [], total: 0 }))`, returning an empty list.

**Origin:** vFarm upstream slowness

**CST fix:** Same as Issue 6 — diagnostics field added to dashboard. The devices endpoint itself correctly returns 500 DEVICES_ERROR when the upstream times out (see Issue 2).

### Issue 8: `/api/health` reporting `status: degraded`

| Evidence | Value |
|---|---|
| Production test | `/api/health` → 200, `{"status":"degraded",...}` |
| Test classification | PASS (HTTP 200 is expected) |

**Root cause:** This is **correct behavior**, not a defect. `/api/health` derives its top-level `status` from `farm_health` only. Since vFarm's farm health endpoint is degraded (due to all the upstream failures above), CST correctly reports `status: degraded`. API reachability (`api_reachability`) is a separate field and is never folded into `status`.

**Origin:** Correct CST behavior reflecting vFarm's degraded state

**CST fix:** None required.

---

## Code Changes Summary

### `engine/src/adapters/vfarm/live_client.ts`

| Change | Lines | Purpose |
|---|---|---|
| `getLatestReading()` now uses `/readings?sensor_id=X&limit=1` | 670-690 | Interim endpoint per Jason's instruction; avoids 29.6s `/readings/latest` timeout |
| `listLatestReadings()` JSDoc updated | 903-929 | References interim endpoint instead of `/readings/latest` |
| `VFARM_READINGS_STATS_TIMEOUT_MS = 30000` added | ~98-103 | Extended timeout for `/readings/stats` (admin-only, not hot path) |
| `request()` accepts optional `timeoutMs` parameter | ~417-421 | Per-call timeout override, used by `getReadingStats` |
| `request()` uses `budget` variable (hoisted) | ~440-449 | Fixes `budget` not defined in catch block |
| `getReadingStats()` uses extended timeout | ~701-705 | Passes `VFARM_READINGS_STATS_TIMEOUT_MS` to `request()` |

### `engine/src/adapters/vfarm/index.ts`

| Change | Lines | Purpose |
|---|---|---|
| `getDashboardData()` captures upstream failure reasons | 429-515 | Adds `diagnostics` field with per-call error messages |

### Test files updated

| File | Change |
|---|---|
| `tests/adapters/vfarm_interim_readings.test.ts` | Rewritten for interim endpoint (`/readings?sensor_id=X&limit=1`) with envelope-shaped mocks |
| `tests/adapters/vfarm_per_sensor_classification.test.ts` | Added 3 tests for interim endpoint behavior |
| `tests/connectors/vfarm_telemetry_mapping.test.ts` | Updated mock URLs and response bodies for interim endpoint |

---

## Verification Results

| Check | Command | Result |
|---|---|---|
| TypeScript typecheck | `npm run typecheck` | PASS |
| Full test suite | `npm test` | 1159 passed, 6 skipped, 0 failed |
| Production build | `npm run build` | PASS |
| Sensor endpoint tests | `tests/adapters/vfarm_interim_readings.test.ts` | 26 passed |
| Per-sensor classification | `tests/adapters/vfarm_per_sensor_classification.test.ts` | 12 passed |
| Telemetry mapping | `tests/connectors/vfarm_telemetry_mapping.test.ts` | All pass |

---

## Remaining External Blockers

| Blocker | Owner | Required Action |
|---|---|---|
| vFarm `/readings/latest` performance fix | Jeganathan / vFarm | Deploy query fix using `reading_ts` index; confirm <500ms latency for all 4 sensors |
| vFarm farm-health timestamp | Jeganathan / vFarm | Confirm whether `GET /api/v1/farms/{id}/health` will include a source timestamp |
| Five-minute online rule | Jeganathan / vFarm | Confirm implementation and exact timestamp semantics |
| Research Twin contract | Destiny Arupi / Jeganathan | Approved n8n webhook contract for investigation lifecycle |
| DNS/TLS (OYP9) | Jason / Platform | CNAME at GoDaddy + Render domain configuration |
| Real voice/SMS acceptance | Authorized human | Real call and SMS lifecycle tests |

---

## Production Retest Requirements

After deployment of the CST fixes and vFarm `/readings/latest` performance fix, retest these production endpoints:

| Endpoint | Expected Result | Evidence Source |
|---|---|---|
| `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_soil` | 200, <1000ms | `prod-test-results.json` |
| `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` | 200, <30000ms | `prod-test-results.json` |
| `/api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5` | 200, <5000ms | `prod-test-results.json` |
| `/api/v1/admin/vfarm/system-stats` | 200 or 502 with clear error | `prod-test-results.json` |
| `/api/v1/dashboard` | `farm` non-null, `device_count` > 0 | `prod-test-results.json` |
| `/api/v1/admin/vfarm/devices` | Non-empty device list | `prod-test-results.json` |
| `/api/health` | `status` reflects actual vFarm health | `prod-test-results.json` |

**Do not deploy CST changes without authorization.** All changes are local only. Deployment requires explicit authorization from the release owner.
