# Diagnostic Evidence: Burn-in Cabinet Sensor Trace
**Loop:** `LOOP-1793620799001-3NBE`  
**Date:** 2026-11-02  
**Owner:** Ahad (Slack review by Jason)  
**Target:** Burn-in cabinet sensor telemetry pipeline investigation  

---

## 1. Trace Overview & Architecture Boundary

The complete telemetry path required by Jason is:
```
RPi / Edge Node → Ingestion API (POST /api/v1/ingest) → vFarm Database → vFarm Backend Read (GET /api/v1/readings/latest?sensor_id=...) → CST / Genie / UI
```

### Upstream Identity & Boundary Rules
- **vFarm** owns identity, live device state, device inventory, health status, and live sensor readings.
- **BHARAG** is strictly for general/semantic knowledge (`cst-help-manuals`), never as a live sensor or time-series fallback (KMG9 & Spec §3).
- **CST Engine** queries `/api/v1/readings/latest?sensor_id={sensor_id}` strictly for devices with `device_type === 'sensor'`. Non-sensor devices (controllers, gateways, boards) are filtered out prior to querying readings.
- If readings are missing or unavailable, CST fails closed and returns: *"The reading/status could not be reliably verified."*

---

## 2. Component-by-Component Trace

### Boundary 1: Edge Node / RPi to Ingestion API
- **Device Identifiers Tested:**
  - Burn-in rack sensors: `rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`
  - Cabinets & Gateways: `VFARM-CAB-001`, `pi_gateway_01`, `uno_board_01`, `esp32_node_01`
- **RPi Ingestion Contract:** Edge nodes submit reading payloads to `POST /api/v1/ingest`:
  ```json
  {
    "device_id": "rack1_mq7",
    "readings": [
      { "metric": "air_quality", "value": 142.5, "unit": "ppm" }
    ],
    "timestamp": "2026-10-28T21:08:50Z"
  }
  ```
- **RPi Ingestion Status:** RPi hardware transmits packets. However, for composite devices or controller boards like `VFARM-CAB-001`, `pi_gateway_01`, and `uno_board_01`, no direct sensor readings are emitted because they are gateways/controllers, not discrete sensors.

### Boundary 2: Ingestion API to Database
- **vFarm Ingest Handler:** Validates incoming packets and inserts rows into vFarm telemetry table `readings`.
- **DB Persistence:** Sensor readings for active discrete sensors are persisted with timestamp, sensor ID, and metric payload.

### Boundary 3: Database to vFarm Backend Read Endpoint
- **Endpoint:** `GET /api/v1/readings/latest?sensor_id={sensor_id}`
- **Query Parameter:** `sensor_id` (string, required) — NOT `farm_id`.
- **Database Query Executed Upstream (vFarm Backend):**
  ```sql
  SELECT * FROM readings WHERE sensor_id = $1 ORDER BY timestamp DESC LIMIT 1;
  ```
- **Observed Upstream Performance & Failure:**
  - Discrete rack sensors (`rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`) experience query latency of **29,000ms to 43,000ms** in the upstream vFarm database/backend before returning or timing out.
  - Non-sensor devices (`VFARM-CAB-001`, `relay_m3_1`) return HTTP `404 Not Found` because no row exists in `readings` for those device IDs.

### Boundary 4: vFarm Backend Read Endpoint to CST Engine
- **Client:** `engine/src/adapters/vfarm/live_client.ts` (`listLatestReadings`)
- **Enforced Constraints:**
  - Bounded concurrency: max 5 concurrent requests.
  - Timeout: **5,000ms** (`VFARM_DEFAULT_TIMEOUT_MS = 5000`).
  - Device filtering:
    ```typescript
    const sensors = devices.filter(
      device => device.device_type === 'sensor'
    );
    ```
- **CST Error Handling & Classification:**
  - HTTP `404`: Classified as `no_reading` (sensor exists but has no latest reading; legitimate data gap; skipped).
  - Timeout (`>5000ms`): Classified as `timeout` (upstream vFarm backend failed to respond within 5s; skipped).
  - HTTP `422`: Classified as `invalid_request` (structural error).
  - Fail-closed: No fabricated values; no fallback to BHARAG.

---

## 3. First Failing Boundary Pinpointed

**First Failing Boundary:** **vFarm Backend Read Endpoint / Database Query Latency & Edge Device Type Classification**

1. **For rack sensors (`rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`):**
   - The first failure occurs at the **vFarm backend database/read path**.
   - Upstream response times of 29s–43s vastly exceed the strict 5,000ms CST deadline. CST aborts the request after 5,000ms with a `timeout` signal to protect voice-turn deadlines.
2. **For cabinet/gateway identifiers (`VFARM-CAB-001`, `pi_gateway_01`, `uno_board_01`):**
   - The failure was improper query targeting: these devices are controllers/gateways, not sensors.
   - Calling `/api/v1/readings/latest?sensor_id=VFARM-CAB-001` resulted in HTTP 404.
   - **Resolution in CST:** Filtering by `device.device_type === 'sensor'` completely eliminates requests for non-sensor devices.

---

## 4. Concrete Failure Example (Sanitized)

- **Timestamp:** `2026-10-28T21:34:38.253Z`
- **Correlation ID:** `corr_vfarm_rack1_mq7_timeout`
- **Device / Sensor ID:** `rack1_mq7`
- **Request:** `GET /api/v1/readings/latest?sensor_id=rack1_mq7`
- **Outcome:** Upstream timeout at 5,000ms (`VfarmNetworkError: vFarm request timed out after 5000ms`).
- **CST Response Classification:** `timeout` — sensor skipped in aggregated result; safe fallback response emitted to user: *"The reading/status could not be reliably verified."*
- **BHARAG Isolation:** BHARAG cluster knowledge API was **NOT** invoked for sensor telemetry.

---

## 5. Copy-Ready Loop Update for Slack (Ahad / LOOP-1793620799001-3NBE)

> **LOOP-1793620799001-3NBE Update — Burn-in Cabinet Sensor E2E Diagnostic**
> - **Trace completed:** `RPi → Ingest API → DB → vFarm Read (/api/v1/readings/latest?sensor_id=...) → CST`
> - **First Failing Boundary:** Upstream vFarm backend query latency on discrete rack sensors (`rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`), where queries take 29–43s, exceeding the 5,000ms timeout boundary.
> - **Device Type Filtering:** CST has strictly enforced `device.device_type === 'sensor'`, eliminating spurious 404s for cabinet/gateway IDs (`VFARM-CAB-001`, `pi_gateway_01`).
> - **KMG9 Compliance:** CST strictly refuses to query BHARAG for missing sensor telemetry; safe refusal response returned.
> - **Action Required from vFarm Team:** Optimize DB indexes on `readings(sensor_id, timestamp DESC)` to resolve the 29–43s query latency.

