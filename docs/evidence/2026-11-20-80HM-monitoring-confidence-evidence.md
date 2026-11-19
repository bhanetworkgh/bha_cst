# LOOP-1794902688969-80HM — Monitoring Twin Sensor Confidence & Fallback Evidence Report

**Document Date:** 2026-11-20
**Loop Identifier:** `LOOP-1794902688969-80HM`
**Primary Context:** Monitoring Twin sensor fallback, confidence rules, and operational surfacing
**Authoritative Contracts:**
- [docs/contracts/cst-monitoring-engine-surfacing-contract.md](../contracts/cst-monitoring-engine-surfacing-contract.md)
- [docs/contracts/monitoring-research-twin-field-contract.md](../contracts/monitoring-research-twin-field-contract.md)
**Implementation Status:** `COMPLETED`
**Evidence Status:** `VERIFIED` (17/17 regression tests passing; contract rules verified in engine code)
**Owner Acceptance Status:** `READY_FOR_OWNER_ACCEPTANCE` (Core sensor confidence & fallback rules); `EXTERNAL_CONFIRMATION_REQUIRED` (External n8n transport card creation parameters)

---

## 1. Executive Summary

`LOOP-1794902688969-80HM` establishes telemetry confidence, fallback sensors, and operational surfacing for agricultural devices connected to vFarm. The engineering implementation for all telemetry mapping rules, dependent device integrity checks, and fail-safe sensor fallback within CST is **COMPLETED**.

Key architectural boundaries implemented:
1. **Single Source of Truth:** vFarm is the exclusive authority for farm identity, device presence, sensor readings, and farm health. CST does not calculate a second health model or query BHARAG for live telemetry.
2. **Strict Failure Semantics:** Missing or null sensor values can never default to `normal`. They surface explicitly as `telemetry_unavailable`.
3. **Dependent Device Integrity:** A dependent device (such as an irrigation relay or climate cabinet) evaluates to `DEGRADED` if any required sensor is offline, missing, stale, or timed out.
4. **Stale Threshold:** Readings older than 24 hours are labeled `stale: true` and surfaced as `degraded` or `telemetry_unavailable`.
5. **External Transport Separation:** Core engine fallback logic is fully implemented and operational. Triggering external Research Twin cards via n8n is isolated behind configuration and requires external confirmation (`EXTERNAL_CONFIRMATION_REQUIRED`) from Destiny Arupi / Jeganathan.

---

## 2. Telemetry Semantics & Mapping Rules

### 2.1 Reading Classification Categories
Implemented in `engine/src/connectors/vfarm.ts`:

| Category | vFarm Observation | CST Telemetry Status | API & UI Representation | Implementation Status | Evidence Status |
|---|---|---|---|---|---|
| **Authoritative Normal** | Valid reading within protocol bands (e.g. 10°C–35°C) | `normal` | `farm_health.status = healthy` | `COMPLETED` | `VERIFIED` |
| **Protocol-Band Breach** | Temperature <10°C or >35°C, or error code set | `warning` / `fault` | `farm_health.status = unhealthy` / warning alert | `COMPLETED` | `VERIFIED` |
| **Fallback Sensor** | Preferred sensor unavailable; secondary sensor reading used | `fallback` | Explicitly marked as degraded / fallback | `COMPLETED` | `VERIFIED` |
| **Stale Reading** | Reading timestamp > 24 hours old | `stale` | Surfaced as `degraded` or `telemetry_unavailable` | `COMPLETED` | `VERIFIED` |
| **Low-Confidence / Ambiguous**| Sensor data fluctuates or conflicts | `low_confidence` | Incident recorded locally; routes to RT question | `COMPLETED` | `VERIFIED` |
| **Unavailable Telemetry** | Reading is null, empty object, 404, or timed out | `telemetry_unavailable` | Never defaults to `normal`; reports unavailable | `COMPLETED` | `VERIFIED` |

### 2.2 Dependent Device Status Gate
Implemented in `computeDependentDeviceStatus` and tested in [tests/regression/sensor_status_semantics.test.ts](../../tests/regression/sensor_status_semantics.test.ts):
- A dependent device requires all assigned sensors to be strictly `online`.
- If any assigned sensor is `offline`, `missing`, `stale`, or `timed_out`, the dependent device evaluates to `DEGRADED`.
- Only when all sensors recover and report `online` does the device return to `NORMAL`.

---

## 3. Automated Test Verification

Execution results from [tests/regression/sensor_status_semantics.test.ts](../../tests/regression/sensor_status_semantics.test.ts) (17/17 tests passing):

```
 ✓ tests/regression/sensor_status_semantics.test.ts (17 tests) 3ms
   ✓ mapLatestReadingToTelemetry — missing values cannot default to normal
     ✓ returns telemetry_unavailable when ALL sensor values are null (rack2_dht)
     ✓ returns telemetry_unavailable when values map is empty (rack1_mq7)
     ✓ returns telemetry_unavailable when no values key at all (rack1_soil)
     ✓ returns telemetry_unavailable when top-level fields are also null (rack1_ph)
     ✓ returns normal when at least one value is present (rack2_dht with temp=28.3)
     ✓ returns fault when error_code is set, even if values exist
     ✓ returns warning when temperature is out of range (esp32_node_01)
     ✓ preserves zero values as valid (soil moisture 0% is not missing)
   ✓ off vs offline distinction
     ✓ "off" means load is switched off (not a failure)
   ✓ Dependent device status gate — regression test
     ✓ dependent relay is NOT NORMAL when all sensors are offline
     ✓ dependent relay is NOT NORMAL when any sensor is missing
     ✓ dependent relay is NOT NORMAL when any sensor is stale
     ✓ dependent relay is NOT NORMAL when any sensor timed out
     ✓ dependent relay IS NORMAL only when ALL sensors are online
     ✓ recovery: status restores to NORMAL when sensor comes back online
     ✓ null readings map to telemetry_unavailable (not normal)
     ✓ timeout scenario: reading with only error_message maps to fault

 Test Files  1 passed (1)
      Tests  17 passed (17)
```

---

## 4. Status of External Research Twin Transport

### Current Implementation State: `COMPLETED` (Engine Logic)
As specified in [docs/contracts/cst-monitoring-engine-surfacing-contract.md](../contracts/cst-monitoring-engine-surfacing-contract.md):
- In-engine anomaly detection, confidence evaluation, and incident logging are fully operational.
- Incident records and alerts are captured in local datastore tables and memory audit buffers.

### External Confirmation Requirement: `EXTERNAL_CONFIRMATION_REQUIRED`
Actual dispatch of outbound webhook cards to external n8n instances requires confirmation of external operational parameters:
1. Approved external n8n transport URL (`RT_ENDPOINT_URL`) and HMAC signature specification.
2. Priority taxonomy agreement (`P0`, `P1`, `P2`) between CST and Research Twin.
3. Deduplication and idempotency key specification.
4. Formal owner confirmation from Destiny Arupi and Jeganathan.

*Note:* This outstanding external operational parameter does not reopen or diminish the completed status of CST's internal telemetry confidence engine.
