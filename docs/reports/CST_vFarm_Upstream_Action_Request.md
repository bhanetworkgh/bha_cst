# CST — vFarm Upstream Action Request (For Jeganathan)

**Date:** 2026-11-02  
**From:** CST Engineering (`bha-cst`)  
**To:** Jeganathan (vFarm API / Upstream Owner)  
**CC:** Jason (PDQ2 Acceptance / Decision Watch `DW-1793626498819-PDQ2`)  
**Incident / Loop Reference:** `LOOP-1793620799001-3NBE`  
**Target Environment:** `https://vfarm.bhanetwork.com` (Organization `e991ae8f-bf93-4e20-85f0-80c74351cf13`, Farm `367a8a3d-f4d8-4a31-9716-24ef43554b93`, Cabinet `VFARM-CAB-001`)

---

## 1. Purpose

During production verification of CST (`https://bha-cst-7u9e.onrender.com`, deployment `dep-dbkgavp5efls73ag1olg`, SHA `fa701a3f7e2a4c642307d018f9a4a123cc6007d3`), CST implemented Jeganathan's interim recommendation to query `/api/v1/readings?sensor_id=X&limit=1` instead of `/api/v1/readings/latest?sensor_id=X`.

This fallback successfully restored sub-600ms latest-reading responses across all four canonical sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`). However, **seven upstream vFarm API / database / hardware items remain open** and block full PDQ2 payment-gate sign-off for Requirements A, B, and F.

---

## 2. Live Production Evidence Summary (2026-11-02T21:55:03Z)

### 2.1 Canonical Sensor Latest Readings (via Interim `/api/v1/readings?sensor_id=X&limit=1`)

| Sensor ID | CST Endpoint | HTTP Status | Latency | Latest Value Returned | Upstream Reading Timestamp | Freshness Status |
|---|---|---|---|---|---|---|
| `rack1_soil` | `GET /api/v1/admin/vfarm/sensors/rack1_soil/latest` | `200 OK` | `510 ms` | `0 %` | `2026-10-30T19:33:27.516244Z` | **Stale (>74h old)** |
| `rack1_ph` | `GET /api/v1/admin/vfarm/sensors/rack1_ph/latest` | `200 OK` | `522 ms` | `25.19 pH` | `2026-10-30T19:33:27.516244Z` | **Stale (>74h old) & uncalibrated (>14.0 pH physical scale)** |
| `rack2_dht` | `GET /api/v1/admin/vfarm/sensors/rack2_dht/latest` | `200 OK` | `498 ms` | `26.8 °C` (`humidity: 67.3 %`) | `2026-10-30T19:33:27.516244Z` | **Stale (>74h old)** |
| `rack1_mq7` | `GET /api/v1/admin/vfarm/sensors/rack1_mq7/latest` | `200 OK` | `498 ms` | `201 ppm` | `2026-10-30T19:33:27.516244Z` | **Stale (>74h old)** |

### 2.2 Remaining Upstream Endpoint Failures / Timeouts

| Upstream vFarm Endpoint | Triggered By CST Endpoint | Observed Behavior | Latency | Root Cause |
|---|---|---|---|---|
| `GET /api/v1/readings/latest?sensor_id=<id>` | Authoritative contract for latest sensor reading | Times out (`>5,000ms` to `>30,000ms`) | `>5,000 ms` | Missing composite index on `readings(sensor_id, received_at DESC)` or `readings(sensor_id, timestamp DESC)` causing sequential scan across millions of rows |
| `GET /api/v1/readings/stats?sensor_id=<id>&window=24h` | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=<id>&window=24h` | Times out (`>12,000ms` client abort / `>30,000ms` upstream scan) | `>12,058 ms` | Unindexed 24h window aggregation scan on `readings` table |
| `GET /api/v1/system/stats` | `GET /api/v1/admin/vfarm/system/stats` | Returns HTTP `502VFARM_UPSTREAM_ERROR` (`Upstream request timed out after 5000ms`) | `5,495 ms` | Upstream `COUNT(*)` across large tables without index or pre-aggregation |
| `GET /api/v1/alerts/threshold/counts` | `GET /api/v1/admin/vfarm/alerts/counts` | Returns HTTP `502` wrapping upstream HTTP `422 Unprocessable Entity` | `667 ms` | In FastAPI router, `/api/v1/alerts/threshold/{rule_id}` is registered before `/api/v1/alerts/threshold/counts`, so `"counts"` is parsed as `rule_id: UUID` and fails validation |
| `GET /api/v1/farms/{farm_id}/health` | `GET /api/health` & `GET /api/v1/admin/vfarm/farms/{id}/health` | Returns `status: "neutral"`, `health_score: null`, `calculated_at: null` | `278 ms` | Upstream health job returns `"neutral"` with null score/timestamps |

---

## 3. Specific Action Items Requested from vFarm (Jeganathan)

### Action VF-1 (P0 — Database Indexing for `/readings/latest` and `/readings/stats`)
1. Add a composite B-tree index on the vFarm PostgreSQL `readings` table:
   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_readings_sensor_received_desc
     ON readings (sensor_id, received_at DESC);
   ```
   *(If the query sorts by `timestamp` rather than `received_at`, index `(sensor_id, timestamp DESC)` as well.)*
2. Verify that both:
   - `GET /api/v1/readings/latest?sensor_id=rack1_soil`
   - `GET /api/v1/readings/stats?sensor_id=rack1_soil&window=24h`
   execute via `Index Scan` / `Index Only Scan` in `< 500ms`.
3. **Why this is required:** While CST's interim fallback (`/api/v1/readings?sensor_id=X&limit=1`) works today, Jason's Requirement A (`DW-1793626498819-PDQ2`) requires the authoritative `/api/v1/readings/latest` contract and `/api/v1/readings/stats` to operate reliably without query timeouts.

### Action VF-2 (P1 — Optimize `GET /api/v1/system/stats`)
1. Replace full-table sequential `COUNT(*)` queries on `readings` inside `GET /api/v1/system/stats` with either:
   - Approximate row counts from `pg_class.reltuples`, or
   - Cached/materialized summary counters.
2. Target latency: `< 1,000ms` (currently timing out at `> 5,000ms`).

### Action VF-3 (P1 — Fix Route Ordering for `GET /api/v1/alerts/threshold/counts`)
1. In the vFarm FastAPI alerts router, move the static route `@router.get("/threshold/counts")` **above** the parameterized route `@router.get("/threshold/{rule_id}")`.
2. Currently, FastAPI matches `/api/v1/alerts/threshold/counts` against `{rule_id}` and returns `422 Unprocessable Entity` (`Input should be a valid UUID, invalid character: expected an optional prefix of 'urn:uuid:' followed by [0-9a-fA-F-], found 'o' at 2`).

### Action VF-4 (P1 — Clarify or Populate `/api/v1/farms/{farm_id}/health`)
1. `GET /api/v1/farms/367a8a3d-f4d8-4a31-9716-24ef43554b93/health` currently returns:
   ```json
   {
     "status": "neutral",
     "health_score": null,
     "calculated_at": null
   }
   ```
2. Please confirm whether `"neutral"` is an intended steady-state enum value (meaning no active alerts / nominal state) or indicates that the farm health calculator is not running, and populate `calculated_at` / `updated_at` timestamps.

### Action VF-5 (P1 — Align on Canonical Presence / Freshness Contract for `VFARM-CAB-001`)
1. All four canonical sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) currently return their newest reading at `2026-10-30T19:33:27.516244Z` (>74 hours old), while device `VFARM-CAB-001` (`f0f09574-4fa7-4ae9-b9be-a8fd04a2b7fa`) reports `status: "active"`, `is_connected: null`, `last_seen_at: null`, `last_heartbeat: null`.
2. Please confirm:
   - Whether `VFARM-CAB-001` is currently offline or paused in the lab.
   - Which field (`device.last_seen_at`, `device.last_heartbeat`, or `reading.received_at`) CST should treat as the authoritative hardware presence indicator for Requirement B.

### Action VF-6 (P2 — Calibrate `rack1_ph` Sensor Value)
1. `rack1_ph` currently reports `value: 25.19`, `unit: "pH"`, which exceeds the physical pH scale (`0.0–14.0`).
2. CST surfaces this reading transparently with a physical-range anomaly warning, but upstream ADC-to-pH calibration on `VFARM-CAB-001` should be corrected so operators receive physically valid pH measurements.

---

## 4. Verification Checklist for Upstream Sign-Off

Once the above changes are deployed on `vfarm.bhanetwork.com`, CST will run the read-only verification suite (`scripts/test-prod-all-endpoints.sh`) to capture HTTP 200 evidence for:
- [ ] `GET /api/v1/readings/latest?sensor_id=rack1_soil` (`< 500ms`)
- [ ] `GET /api/v1/readings/latest?sensor_id=rack1_ph` (`< 500ms`)
- [ ] `GET /api/v1/readings/latest?sensor_id=rack2_dht` (`< 500ms`)
- [ ] `GET /api/v1/readings/latest?sensor_id=rack1_mq7` (`< 500ms`)
- [ ] `GET /api/v1/readings/stats?sensor_id=rack1_soil&window=24h` (`< 1,000ms`)
- [ ] `GET /api/v1/readings/stats?sensor_id=rack1_ph&window=24h` (`< 1,000ms`)
- [ ] `GET /api/v1/readings/stats?sensor_id=rack2_dht&window=24h` (`< 1,000ms`)
- [ ] `GET /api/v1/readings/stats?sensor_id=rack1_mq7&window=24h` (`< 1,000ms`)
- [ ] `GET /api/v1/system/stats` (`< 1,000ms`)
- [ ] `GET /api/v1/alerts/threshold/counts` (`200 OK`)

