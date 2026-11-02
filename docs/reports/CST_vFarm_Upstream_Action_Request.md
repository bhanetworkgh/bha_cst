# CST — vFarm Upstream Action Request (For Jeganathan)

**Date:** 2026-11-02 (Updated Post-PR #23 Live Verification at `2026-11-02T22:53:30Z`)
**From:** CST Engineering (`bha-cst`)
**To:** Jeganathan (vFarm API / Upstream Owner)
**CC:** Jason (PDQ2 Acceptance / Decision Watch `DW-1793626498819-PDQ2`)
**Incident / Loop Reference:** `LOOP-1793620799001-3NBE`
**Target Environment:** `https://vfarm-iot-platform-739n.onrender.com` (Organization `122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d`, Farms: `Test 001` `ed95e120-74c4-4126-a2e9-0e4ffa9275e6` [0 devices] & `v-farm` `21dde23e-f7f6-46bc-9b54-e97fabaaafd7` [23 devices])

---

## 1. Executive Summary — Major Positive Progress & Remaining Upstream Items

During the latest post-PR #23 production verification of CST (`https://bha-cst-7u9e.onrender.com`, deployment `dep-dbkh3p6417fc73bffihg`, SHA `441d2b3f4a49c983f45131c229888a60116b9437`, verified `2026-11-02T22:45:49Z`–`22:53:30Z`):

1. **RESOLVED UPSTREAM — All 4 Canonical Sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) Are Now Streaming Fresh (<60s old), Calibrated Live Telemetry!**
   - Earlier at `21:55:03Z`, the 4 sensors were stale (`2026-10-30T19:33:27Z`, >74h old) and `rack1_ph` reported `25.19 pH`.
   - As of `2026-11-02T22:46Z–22:53Z`, all 4 canonical sensors are **actively streaming live telemetry** (`firmware: "1.0.0"`, `status: "ok"`), and **`rack1_ph` is now calibrated at `5.06 pH`** (within the physical `0.0–14.0` pH scale)!
2. **REMAINING UPSTREAM BLOCKERS (5 Items):**
   - Authoritative `GET /api/v1/readings/latest?sensor_id=<id>` still times out (`>6,000ms`) and holds upstream PostgreSQL connections (`HTTP 503 Database connection error`).
   - `GET /api/v1/readings/stats?sensor_id=<id>&window=24h` still times out (`>12,058ms`).
   - `GET /api/v1/system/stats` still times out (`>12,061ms`).
   - `GET /api/v1/alerts/threshold/counts` still returns `HTTP 422 Unprocessable Entity` due to FastAPI route ordering.
   - `GET /api/v1/farms` returns `Test 001` (`ed95e120-74c4-4126-a2e9-0e4ffa9275e6`, `is_active: true`, `device_count: 0`) ahead of `v-farm` (`21dde23e-f7f6-46bc-9b54-e97fabaaafd7`, `is_active: true`, `device_count: 23`), and `GET /api/v1/farms/{id}/health` returns `status: "neutral"`, `health_score: null`, `calculated_at: null`.

---

## 2. Live Production Sensor Evidence (`2026-11-02T22:46Z–22:53Z`)

### 2.1 Canonical Sensor Latest Readings (via Interim `/api/v1/readings?sensor_id=X&limit=1` / CST `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=X`)

| Sensor ID | CST Endpoint | HTTP Status | Latency | Latest Live Value(s) | `reading_ts` (UTC) | `received_at` (UTC) | Status |
|---|---|---|---|---|---|---|---|
| `rack1_soil` | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_soil` | `200 OK` | `573 ms` | `soil_moisture: 90.0 %` (`status: "ok"`) | `2026-11-02T22:48:50Z` | `2026-11-02T22:48:51.470544Z` | **FRESH (<2s old) & VALID** |
| `rack1_ph` | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_ph` | `200 OK` | `494 ms` | `ph: 5.06 ph` (`status: "ok"`) | `2026-11-02T22:48:56Z` | `2026-11-02T22:48:57.757120Z` | **FRESH (<2s old) & CALIBRATED (`5.06 pH`)** |
| `rack2_dht` | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack2_dht` | `200 OK` | `529 ms` | `temperature: 28.8 °C`, `humidity: 63 % RH` (`status: "ok"`) | `2026-11-02T22:52:29Z` | `2026-11-02T22:53:28.451257Z` | **FRESH (<60s old) & VALID** |
| `rack1_mq7` | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_mq7` | `200 OK` | `526 ms` | `co: 0.76 ppm` (`status: "ok"`) | `2026-11-02T22:48:59Z` | `2026-11-02T22:49:12.079460Z` | **FRESH (<15s old) & VALID** |

### 2.2 Remaining Upstream Endpoint Failures / Timeouts (`2026-11-02T22:45:49Z`–`22:49:12Z`)

| Upstream vFarm Endpoint | Triggered By CST Endpoint | Observed Behavior | Latency | Root Cause |
|---|---|---|---|---|
| `GET /api/v1/readings/latest?sensor_id=<id>` | Authoritative contract for latest sensor reading | Times out (`>6,000ms`) and exhausts upstream DB pool (`HTTP 503 {"error":"error","detail":"Database connection error"}`) | `>6,000 ms` | Missing composite index on `readings(sensor_id, received_at DESC)` or `readings(sensor_id, reading_ts DESC)` causing sequential scan across millions of rows (`id > 6,715,153`) |
| `GET /api/v1/readings/stats?sensor_id=<id>&window=24h` | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=<id>&window=24h` | Times out (`>12,053ms` client abort / `>30,000ms` upstream scan) | `>12,053 ms` | Unindexed 24h window aggregation scan on `readings` table |
| `GET /api/v1/system/stats` | `GET /api/v1/admin/vfarm/system-stats` | Times out (`>12,058ms`) | `>12,058 ms` | Upstream `COUNT(*)` across `6.7M+` rows without index or pre-aggregation |
| `GET /api/v1/alerts/threshold/counts` | `GET /api/v1/admin/vfarm/alerts/counts` | Returns HTTP `422 Unprocessable Entity` | `1,303 ms` | In FastAPI router, `/api/v1/alerts/threshold/{rule_id}` is registered before `/api/v1/alerts/threshold/counts`, so `"counts"` is parsed as `rule_id: UUID` |
| `GET /api/v1/farms/{farm_id}/health` | `GET /api/health` & `GET /api/v1/admin/vfarm/health` | Returns `status: "neutral"`, `health_score: null`, `calculated_at: null` | `889 ms` | Upstream health job returns `"neutral"` with null score/timestamps |

---

## 3. Specific Action Items Requested from vFarm (Jeganathan)

### Action VF-1 (P0 — Database Indexing for `/readings/latest` and `/readings/stats`)
1. The `readings` table now has over **6.71 million rows** (`id: 6715153`). Add a composite B-tree index on `readings`:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_readings_sensor_reading_ts_desc
     ON readings (sensor_id, reading_ts DESC);
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_readings_sensor_received_desc
     ON readings (sensor_id, received_at DESC);
   ```
2. Verify that both `GET /api/v1/readings/latest?sensor_id=rack1_soil` and `GET /api/v1/readings/stats?sensor_id=rack1_soil&window=24h` execute via `Index Scan` in `< 500ms` without holding PostgreSQL pool connections.

### Action VF-2 (P1 — Optimize `GET /api/v1/system/stats`)
1. Replace full-table sequential `COUNT(*)` queries on `readings` (`6.71M+` rows) inside `GET /api/v1/system/stats` with `pg_class.reltuples` or cached summary counters (`< 1,000ms`).

### Action VF-3 (P1 — Fix Route Ordering for `GET /api/v1/alerts/threshold/counts`)
1. In the vFarm FastAPI alerts router, move `@router.get("/threshold/counts")` **above** `@router.get("/threshold/{rule_id}")` so `"counts"` is not rejected as an invalid UUID (`422`).

### Action VF-4 (P1 — Deactivate Empty `Test 001` Farm or Confirm Active Farm UUID & Health Enum)
1. `GET /api/v1/farms` currently returns two active farms for org `122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d`:
   - `ed95e120-74c4-4126-a2e9-0e4ffa9275e6` (`name: "Test 001"`, `is_active: true`, `device_count: 0`)
   - `21dde23e-f7f6-46bc-9b54-e97fabaaafd7` (`name: "v-farm"`, `is_active: true`, `device_count: 23`)
2. Because `Test 001` is first in the list with `is_active: true`, default farm auto-selection lands on `Test 001` (`0 devices`). Please either set `is_active = false` on `Test 001` (`ed95e120-74c4-4126-a2e9-0e4ffa9275e6`) or confirm that CST's `VFARM_FARM_ID` env var on Render should be set to `21dde23e-f7f6-46bc-9b54-e97fabaaafd7` (`v-farm`).
3. Populate `calculated_at` and `health_score` on `GET /api/v1/farms/{farm_id}/health` (currently returning `status: "neutral"`, `health_score: null`, `calculated_at: null`).
