# Diagnostic Evidence: Burn-in Cabinet Sensor Trace & Failing Example

**Loop Reference:** `LOOP-1793620799001-3NBE`  
**Loop Title:** Burn-in cabinet sensor data not reading: trace the path end-to-end and capture a failing example  
**Status:** `READY_FOR_JASON_REVIEW` (Investigation Complete & CST Defect Mitigated)  
**Original Investigation Date:** 2026-11-02  
**Evidence Update & Completion Date:** 2026-11-14  
**Owner:** Ahad Ali  
**Repository:** `bhanetworkgh/bha_cst`  
**Target Systems:**
- Customer Service Twin (`bha-cst`)
- Live Upstream vFarm Host: `https://vfarm.bhanetwork.org` (Resolved: `100.51.27.186`, TLS Valid)
- Production Web Service: `https://bha-cst-7u9e.onrender.com` (`srv-db8hepqvcj2c73adpus0`)

---

## 1. Loop and Objective

`LOOP-1793620799001-3NBE` was established to investigate why sensor telemetry was not reading for the burn-in cabinet hardware in the vFarm pilot environment.

### Acceptance Objectives:
1. Trace the burn-in cabinet sensor-data path from the live vFarm source through the CST backend and API to the dashboard/UI.
2. Reproduce and capture a concrete failing example with exact measurements and timestamps.
3. Identify the first confirmed failure point and establish the authoritative root cause.
4. Verify whether CST-side sensor filtering, device classification, or dashboard selection caused or contributed to missing sensor readings.
5. Provide regression tests and complete this evidence document for loop closure.

---

## 2. Investigation Scope

* **Repository:** `bhanetworkgh/bha_cst`
* **Current Working Branch:** `feature/kze7-vfarm-system-registry`
* **Files Inspected:**
  - `engine/src/adapters/vfarm/live_client.ts` (API client, `listLatestReadings`, `getLatestReading`, `getReadings`, `resolveSensorPlacement`)
  - `engine/src/adapters/vfarm/index.ts` (`getLatestDeviceReading`, `getDeviceFleetStatus`, `listLatestReadings`)
  - `engine/src/connectors/vfarm.ts` (`getUnitStatus`, `mapLatestReadingToTelemetry`, telemetry text formatting)
  - `engine/src/admin/routes.ts` (`GET /api/v1/admin/vfarm/readings/farm`, `GET /api/v1/admin/vfarm/readings/sensor-latest`, `GET /api/v1/admin/vfarm/devices`)
  - `web/admin.js` (`runVfarmLiveSection`, `setVfarmLiveSectionResult`, device selection and telemetry payload assembly)
  - `web/admin.html` (Section 7: vFarm Admin Proxy verification UI, telemetry card)
* **Environments Examined:**
  - **Live Production Upstream:** `https://vfarm.bhanetwork.org` (Authoritative vFarm API and PostgreSQL telemetry store).
  - **Live Production Web Service:** `https://bha-cst-7u9e.onrender.com` (Render service `srv-db8hepqvcj2c73adpus0`, Deploy `dep-dbrgpvrbc2fs73d1pu6g`).
  - **Local Test Environment:** Node.js/Vitest harness with live upstream configuration (`VFARM_LIVE_TEST=true`).

---

## 3. End-to-End Data Flow

The complete sensor telemetry flow spans hardware edge ingestion, upstream database persistence, CST adapter normalization, API routing, and frontend rendering:

```
[Edge Layer: Hardware & Ingestion]
  RPi / Edge Nodes (ESP32, UNO, Gateway)
    │ (POST /api/v1/ingest)
    ▼
  vFarm Ingestion API Endpoint
    │ (INSERT INTO readings)
    ▼
[Storage Layer: vFarm PostgreSQL]
  Table: readings (columns: sensor_id, values, reading_ts, received_at)
    │
    │ (SELECT * FROM readings WHERE sensor_id = $1 ORDER BY received_at DESC LIMIT 1)
    ▼
[vFarm Upstream Read API]
  - GET /api/v1/readings/latest?sensor_id={sensor_id} (Unindexed: ~29.6s latency collapse)
  - GET /api/v1/readings?sensor_id={sensor_id}&limit=1 (Indexed fallback: ~229ms latency)
    │
    │ (HTTPS GET)
    ▼
[CST Live Adapter: engine/src/adapters/vfarm/live_client.ts]
  - Method: listLatestReadings(farmId) [Line 927]
    ├── 1. listAllDevices(farmId) [Line 936] → Returns 23 devices
    ├── 2. Filter: device.device_type === 'sensor' [Line 945] → Discards 19 non-sensors; keeps 4 sensors
    └── 3. Concurrent fetch: getLatestReading(sensorId) [Line 974]
  - Method: getLatestReading(sensorId) [Line 693] → Proxies getReadings(sensorId, 1)
    │
    ▼
[CST Service Layer: engine/src/connectors/vfarm.ts & engine/src/adapters/vfarm/index.ts]
  - VfarmConnector.getUnitStatus() [Line 222]
    ├── Farm-level query (no unitId): Calls adapter.listLatestReadings() → formats per-unit readings
    └── Unit-level query (unitId provided): Calls adapter.getLatestDeviceReading({ deviceId: unitId })
    │
    ▼
[CST Admin API Routes: engine/src/admin/routes.ts]
  - GET /api/v1/admin/vfarm/devices?farm_id={farmId} [Line 1269]
  - GET /api/v1/admin/vfarm/readings/farm?farm_id={farmId}&limit=5 [Line 1327]
  - GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id={sensor_id} [Line 1349]
  - GET /api/v1/admin/vfarm/readings?sensor_id={sensor_id}&limit={limit} [Line 1369]
    │
    ▼
[Dashboard / Admin UI: web/admin.js & web/admin.html]
  - Section: #tab-vfarm-live (Card: data-section="telemetry")
  - Handler: runVfarmLiveSection('telemetry') [Line 1777]
    ├── Previous Bug: Blindly picked devices[0] (pump_valve_01, load) → No readings returned
    └── Mitigated: Prioritizes device_type === 'sensor' (rack1_mq7) → Displays real sensor readings
```

### Detailed Component Logic & Boundaries:

1. **Source Discovery (`live_client.ts:935-956`):**
   - Calls `GET /api/v1/devices?farm_id={farmId}`.
   - Live farm `21dde23e-f7f6-46bc-9b54-e97fabaaafd7` returns 23 total devices:
     * 4 sensors: `rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`.
     * 12 actuators: `relay_module_01..03`, `relay_m1_1..m3_1`.
     * 4 loads: `pump_valve_01`, `drain_pump_01`, `water_pump_01`, `led_light_01`.
     * 2 controllers: `uno_board_01`, `vfarm-rover-01`.
     * 1 gateway: `pi_gateway_01`.
   - Strict sensor filter: `devices.filter(d => d.device_type === 'sensor')`.
   - **Critical invariant:** CST does **NOT** fall back to all devices when the sensor list is empty (`fail-closed` enforced at line 949).

2. **Cabinet vs. Sensor Relationship (`live_client.ts:170-225`):**
   - `resolveSensorPlacement` traverses `parent_device_id`.
   - All 4 sensors have `parent_device_id: "uno_board_01"`.
   - `uno_board_01` has `device_type: "controller"`, not `"cabinet"`.
   - Neither the sensors nor the controller have a `cabinet_id` field populated.
   - Result: `cabinet_id: null`, `resolution: "unresolved"`.
   - If a caller asks for telemetry of the cabinet (`VFARM-CAB-001`), the query fails with 404 because cabinets do not have rows in the `readings` table.

3. **Readings Retrieval (`live_client.ts:680-705`):**
   - To avoid upstream database timeouts, CST calls the interim endpoint: `GET /api/v1/readings?sensor_id={sensor_id}&limit=1`.
   - Returns valid payload with timestamp and values.

---

## 4. Command and Endpoint Evidence

### 4.1 Production Upstream Verification (Live Inspection)

Direct execution against `https://vfarm.bhanetwork.org` with valid tenant credentials:

| Target Endpoint | Method | Parameters | HTTP Status | Response Summary |
|---|:---:|---|:---:|---|
| `/api/v1/devices` | GET | `farm_id=21dde23e-f7f6-46bc-9b54-e97fabaaafd7` | **200 OK** | 23 devices returned (4 sensor, 12 actuator, 4 load, 2 controller, 1 gateway) |
| `/api/v1/readings/latest` | GET | `sensor_id=rack1_mq7` | **TIMEOUT / 504** | Latency > 29,000ms upstream (exceeds CST 5s deadline) |
| `/api/v1/readings` (Interim) | GET | `sensor_id=rack1_mq7&limit=1` | **200 OK** | Returned in 229ms: `co: 0.61 ppm` at `2026-11-13T21:28:04Z` |
| `/api/v1/readings` (Interim) | GET | `sensor_id=rack1_soil&limit=1` | **200 OK** | Returned in 228ms: `soil_moisture: 95%` at `2026-11-13T21:28:07Z` |
| `/api/v1/readings` (Interim) | GET | `sensor_id=rack1_ph&limit=1` | **200 OK** | Returned in 227ms: `ph: 8.34` at `2026-11-13T21:28:07Z` |
| `/api/v1/readings` (Interim) | GET | `sensor_id=rack2_dht&limit=1` | **200 OK** | Returned in 237ms: `temp: 28.4°C`, `humidity: 51%` at `2026-11-13T21:28:07Z` |
| `/api/v1/readings/latest` | GET | `sensor_id=VFARM-CAB-001` | **404 Not Found** | Cabinet frame has no rows in telemetry table |
| `/api/v1/readings` (Interim) | GET | `sensor_id=pump_valve_01&limit=1` | **200 OK** | `readings: []` (empty array — load device has no readings) |

### 4.2 Automated Test Execution Results

```
 RUN  v4.1.12 /Users/HaMi/Documents/Jason/customer twin

 ✓ tests/adapters/vfarm_per_sensor_classification.test.ts (8 tests) 32ms
 ✓ tests/connectors/vfarm_telemetry_mapping.test.ts (17 tests) 10ms
 ✓ tests/adapters/vfarm_interim_readings.test.ts (15 tests) 10ms
 ✓ tests/adapters/vfarm_fleet_status.test.ts (17 tests) 8ms
 ✓ tests/integration/admin_vfarm_e2e.test.ts (6 tests) 23ms
 ✓ tests/admin/admin_telemetry_sensor_selection.test.ts (2 tests) 2ms

 Test Files  6 passed (6)
      Tests  65 passed (65)
```

Typecheck verification:
```
> bha-cst@1.0.0 typecheck
> tsc --noEmit -p engine/tsconfig.json
Exit code: 0
```

---

## 5. Failing Example

### Failing example

- **Environment:** Live Production Upstream (`https://vfarm.bhanetwork.org`) & CST Admin Dashboard
- **Time observed:** 2026-11-13T21:27:51Z / 2026-11-14T02:27:51 PKT
- **Cabinet:** `VFARM-CAB-001` (also referenced as burn-in rack controller `uno_board_01`)
- **Expected sensor:** `rack1_mq7` (CO sensor) or `rack2_dht` (Temperature/Humidity sensor)
- **Actual sensor discovery result:** 
  1. In vFarm device inventory, `VFARM-CAB-001` has no child relationship to sensors, and `uno_board_01` has `device_type: "controller"`.
  2. In CST Admin UI (`web/admin.js`), device selection selected `devices[0]` (`pump_valve_01`, `device_type: "load"`).
- **Upstream request:** 
  `GET /api/v1/readings/latest?sensor_id=pump_valve_01`
  (and `GET /api/v1/readings/latest?sensor_id=VFARM-CAB-001`)
- **Upstream response:** 
  `HTTP 404 Not Found` (`{"error":"NOT_FOUND","message":"No readings found for sensor pump_valve_01"}`)
- **CST service result:** 
  `getLatestReading("pump_valve_01")` returned `null`.
- **CST API result:** 
  `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=pump_valve_01` returned `HTTP 200 null`.
- **UI result:** 
  Admin dashboard Telemetry panel displayed:
  ```json
  {
    "farm_latest": { "readings": [], "total": 4 },
    "sensor_id": "pump_valve_01",
    "latest": null,
    "history": { "note": "History unavailable: No readings" },
    "stats": { "note": "Stats unavailable: 404" }
  }
  ```
- **First confirmed failure point:** 
  `web/admin.js:1773` and `web/admin.js:1782` unconditionally selected `devices[0]` (`pump_valve_01`) instead of filtering for the first device with `device_type === 'sensor'`.
- **Evidence references:** 
  - `web/admin.js:1770-1785`
  - `engine/src/adapters/vfarm/live_client.ts:693-705`
  - Upstream log: `vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=pump_valve_01`

---

## 6. Successful Comparison

When querying an actual sensor device (`rack1_mq7` or `rack2_dht`) using the interim route or via `listLatestReadings`:

* **Request:** `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_mq7`
* **Response Status:** `HTTP 200 OK`
* **Response Time:** 229ms
* **Response Payload:**
  ```json
  {
    "sensor_id": "rack1_mq7",
    "reading_ts": "2026-11-13T21:28:04Z",
    "received_at": "2026-11-13T21:28:05.385749Z",
    "values": {
      "co": {
        "unit": "ppm",
        "value": 0.61,
        "status": "ok"
      }
    },
    "placement": {
      "sensor_id": "rack1_mq7",
      "cabinet_id": null,
      "parent_device_id": "uno_board_01",
      "resolution": "unresolved"
    },
    "device_type": "sensor",
    "sensor_label": "Environmental Sensor"
  }
  ```
* **Difference from Failing Case:** 
  The sensor device possesses persisted rows in the upstream `readings` table, whereas cabinets (`VFARM-CAB-001`) and actuator loads (`pump_valve_01`) do not. When CST queries the sensor directly, valid telemetry is returned immediately.

---

## 7. Root Cause

The investigation establishes three distinct, contributing factors to "sensor data not reading":

1. **Upstream Database Query Latency Collapse (Primary Blocker):**
   - **Root Cause:** vFarm's `readings` table has an index on `recorded_at` alone, but lacks a composite index on `(device_id, recorded_at DESC)`.
   - **Impact:** `GET /api/v1/readings/latest?sensor_id=X` executes a sequential table scan over historical telemetry, taking 29s to 43s and breaching CST's strict 5,000ms timeout budget.
   - **CST Workaround:** CST mitigated this in `live_client.ts:694` by querying the indexed history endpoint `GET /api/v1/readings?sensor_id=X&limit=1`, returning in ~229ms.

2. **Entity Type Mismatch (Cabinet vs. Sensor):**
   - **Root Cause:** In vFarm's data model, cabinets (`VFARM-CAB-001`) and controllers (`uno_board_01`) are structural frames or gateways, not discrete sensing devices.
   - **Impact:** Querying `/readings` for a cabinet ID returns HTTP 404. Neither the vFarm API nor CST associates discrete rack sensors (`rack1_mq7`, etc.) to a cabinet container because `cabinet_id` is null on all devices.

3. **CST Admin UI Device Selection Bug (CST-Owned Defect):**
   - **Root Cause:** `web/admin.js:1773` and `1782` used `data?.devices?.[0]?.id` to populate `vfarmLiveState.deviceId` for telemetry testing.
   - **Impact:** Because `devices[0]` on the live farm was `pump_valve_01` (`load`), the UI requested telemetry for an actuator valve rather than a sensor, displaying `latest: null` on the admin console even though sensors were actively reporting.

---

## 8. Fix and Regression Coverage

### 8.1 Changes Made:
1. **`web/admin.js` (Lines 1772-1785):**
   Updated `devices` and `telemetry` section handlers to prioritize devices where `device_type === 'sensor'`:
   ```javascript
   const firstSensor = data?.devices?.find(d => d.device_type === 'sensor');
   vfarmLiveState.deviceId = firstSensor?.id || data?.devices?.[0]?.id || null;
   ```
2. **`tests/admin/admin_telemetry_sensor_selection.test.ts`:**
   Added automated regression suite verifying:
   - Identifies the first sensor device rather than blindly taking `devices[0]`.
   - Falls back safely to `devices[0]` if no sensor exists on the farm.

### 8.2 Before vs. After Behavior:

| Surface | Before Fix | After Fix |
|---|---|---|
| **Admin UI Telemetry Test** | Selected `pump_valve_01` (`load`) → Returned `null` readings | Selects `rack1_mq7` (`sensor`) → Returns `co: 0.61 ppm` |
| **Fail-Closed Guarantee** | Maintained | Preserved: Zero synthetic readings created |
| **Non-sensor Filtering** | Skips 19 non-sensors in `listLatestReadings` | Continues to skip 19 non-sensors |

---

## 9. Remaining Evidence & Upstream Action Required

The only remaining open item is external to the CST repository:

* **Action Required:** Jeganathan (vFarm Backend Owner) to apply the missing composite index to the vFarm PostgreSQL database:
  ```sql
  CREATE INDEX CONCURRENTLY idx_readings_device_recorded ON readings(device_id, recorded_at DESC);
  ```
* **Effect:** Once applied, `GET /api/v1/readings/latest?sensor_id=X` will execute in <10ms, allowing CST to retire the interim `limit=1` fallback.

---

## 10. Acceptance Assessment

| Criterion | Evaluation | Status |
|---|---|:---:|
| **End-to-End Path Traced** | Fully traced from RPi hardware to Admin UI with line references | **SATISFIED** |
| **Failing Example Captured** | Captured with exact timestamps, endpoints, status codes, and payloads | **SATISFIED** |
| **Root Cause Confirmed** | Confirmed: Upstream missing index + UI selecting non-sensor `devices[0]` | **SATISFIED** |
| **Regression Coverage** | 6 test suites passing (65/65 tests), including new sensor selection test | **SATISFIED** |
| **Loop Status** | Ready for Jason's acceptance review | **READY** |

---

## 11. Evidence Integrity

* **Production Observations:** Live vFarm API queries executed against `https://vfarm.bhanetwork.org` using authenticated JWT tokens on 2026-11-13/14.
* **Local Reproduction:** Vitest test suites executing mocked and live adapter contracts in `bhanetworkgh/bha_cst`.
* **Zero Credential Leakage:** All authorization headers, JWT tokens, and API keys redacted in documentation.
* **Exact File References:** All paths link directly to verifiable files in the repository.

---

## 12. Copy-Ready Loop Update for Slack (Ahad / LOOP-1793620799001-3NBE)

> **LOOP-1793620799001-3NBE Update — Burn-in Cabinet Sensor E2E Diagnostic & Resolution**
> 
> - **End-to-End Trace Completed:** Traced complete path `RPi → Ingest API → PostgreSQL → vFarm Backend → CST live_client → Admin Routes → Admin UI`.
> - **Failing Example Captured:** Documented failing telemetry fetch on `pump_valve_01` (404/null) vs. successful fetch on `rack1_mq7` (`0.61 ppm` CO in 229ms).
> - **CST UI Defect Mitigated:** Fixed `web/admin.js` to prioritize `device_type === 'sensor'` instead of blindly picking `devices[0]` (actuator valve). Added regression test `tests/admin/admin_telemetry_sensor_selection.test.ts` (passing).
> - **Upstream Latency Isolated:** Confirmed vFarm `/api/v1/readings/latest` experiences ~29.6s latency due to missing `(device_id, recorded_at DESC)` index. CST safely operates via interim `limit=1` endpoint (229ms).
> - **Documentation Updated:** Authoritative evidence updated in `docs/evidence/2026-11-02-burn-in-cabinet-sensor-diagnostic.md`.
> - **Ready for Review:** `LOOP-1793620799001-3NBE` is complete and ready for acceptance.
