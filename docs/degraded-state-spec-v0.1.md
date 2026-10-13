# bha-cst Degraded Telemetry State Specification — v0.1

**Status**: Draft  
**Version**: 0.1  
**Date**: 2026-09-14  
**Owner**: bha-cst Engineering  
**Scope**: `vFarm` telemetry connector (`engine/src/connectors/vfarm.ts`) and any future sensor/telemetry connectors added to bha-cst.

---

## 1. Background

The bha-cst Customer Service Twin relays live sensor telemetry (water temperature, pH, EC level, water level) from vFarm units to customers over SMS. This data is fetched from an external cluster API (`BHARAG_CLUSTER_URL`). When that API is down, times out, or returns incomplete data, the system must respond in a clearly defined, honest, non-deceptive manner.

This spec defines the **Degraded State** — what it means, when it applies, and exactly how the system must behave in it.

---

## 2. Definition: Degraded State

A **Degraded State** occurs when bha-cst cannot obtain verified, real-time sensor readings for a given vFarm unit. This includes:

| Condition | Trigger |
|---|---|
| Cluster API unreachable | Network timeout, DNS failure, TCP reset |
| Cluster API timeout | Response exceeds `BHARAG_CLUSTER_TIMEOUT_MS` (default: 10,000 ms) |
| Cluster returns HTTP error | Non-2xx response code |
| Cluster returns `telemetry_unavailable` status | API itself reports no data available |
| Cluster response lacks valid sensor fields | No `water_temp_c`, `ph_level`, `ec_level`, `water_level`, or `status` |
| Unit is unbound (no `farm_id` / `unit_id` on caller) | Identity resolver returned no unit context |

---

## 3. Core Rule: No Synthetic or Fallback Sensor Values

> **The system MUST NOT display hardcoded, estimated, or otherwise synthetic sensor readings when in a Degraded State.**

The following are explicitly prohibited in any degraded response path:

- Hardcoded temperature values (e.g. `25°C`, `"normal range"`)
- Hardcoded pH values (e.g. `6.2`, `"within range"`)
- Hardcoded EC or water-level values
- Language that implies readings are current or real when they are not (e.g. `"Your pH looks fine"`)
- Any response that gives the customer false confidence in system health

**Rationale**: Farming decisions (nutrient dosing, irrigation, equipment intervention) are made based on sensor readings. A fake or stale value could cause crop loss, equipment damage, or safety incidents — all of which carry direct commercial liability.

---

## 4. Required Degraded State Response Contract

When the system enters a Degraded State for a given unit, it MUST:

### 4.1 — Customer-Facing SMS Response

Return a response of this form:

```
vFarm Unit <unit_id> (<farm_id>): Telemetry currently unavailable for this unit.
Live sensor readings cannot be retrieved at this time.
```

- Do **not** include any sensor values.
- Do **not** suggest the unit is healthy or unhealthy.
- Do **not** estimate or extrapolate from previous readings.

### 4.2 — Internal Telemetry Object

The `VfarmUnitStatus` object returned internally MUST set:

```typescript
{
  unit_id:      "<bound unit_id>",
  farm_id:      "<bound farm_id>",
  status:       "telemetry_unavailable",
  last_updated: "<ISO 8601 timestamp of the failed attempt>",
  // water_temp_c, ph_level, ec_level, water_level: OMITTED (undefined)
}
```

All sensor fields (`water_temp_c`, `ph_level`, `ec_level`, `water_level`) MUST be `undefined` — never `null`, `0`, or any numeric value.

### 4.3 — Infrastructure Log (Commercial Impact)

Every Degraded State event MUST emit a structured infra log with a `commercial_impact` field:

```json
{
  "timestamp": "<ISO 8601>",
  "level": "WARN",
  "type": "INFRA_EVENT",
  "message": "vFarm telemetry unavailable: cluster API unreachable or returned no data",
  "unit_id": "<unit_id>",
  "farm_id": "<farm_id>",
  "customer_ref": "<customer_ref>",
  "commercial_impact": "Customer cannot receive live sensor data. Farming decisions may be delayed. Escalate if outage exceeds 5 minutes."
}
```

---

## 5. Timeout & Retry Policy

| Parameter | Default | Env Override |
|---|---|---|
| Cluster request timeout | 10,000 ms | `BHARAG_CLUSTER_TIMEOUT_MS` |
| Retry attempts on timeout | 0 (single attempt, no retry) | N/A — retries are caller responsibility |
| Degraded state log level | `WARN` | N/A |

> **Note**: Retries for telemetry requests are intentionally not performed within a single customer SMS round-trip to avoid latency. The cluster's own HA/retry policy is expected to handle transient failures upstream.

---

## 6. State Machine

```
Caller requests telemetry
        │
        ▼
  unit_context bound? ──No──▶ DEGRADED (unbound unit)
        │
       Yes
        │
        ▼
  Fetch from cluster API
        │
   ┌────┴────┐
  OK        Fail / Timeout / Error
   │                │
   ▼                ▼
Parse response   DEGRADED (cluster unreachable)
   │
  Valid sensor data? ──No──▶ DEGRADED (missing fields)
   │
  Yes
   │
   ▼
 Return live telemetry (NORMAL state)
```

---

## 7. Future Connector Compliance

Any new telemetry connector added to bha-cst (e.g. a second farm system or IoT gateway) MUST:

1. Implement the same `telemetry_unavailable` status path.
2. Return `undefined` (not `null` or `0`) for all missing sensor fields.
3. Emit an infra log with `commercial_impact` on every degraded event.
4. Never fall back to hardcoded sensor values.

Compliance with this spec is a merge requirement for any PR touching sensor connectors.

---

## 8. Related Files

| File | Role |
|---|---|
| [`engine/src/connectors/vfarm.ts`](engine/src/connectors/vfarm.ts) | Reference implementation of degraded state |
| [`engine/src/config/logger.ts`](engine/src/config/logger.ts) | `Logger.infra()` — structured infra log emitter |
| [`engine/src/transport/twilio/types.ts`](engine/src/transport/twilio/types.ts) | `VfarmUnitStatus` interface |

---

## 9. Change Log

| Version | Date | Author | Notes |
|---|---|---|---|
| v0.1 | 2026-09-14 | bha-cst Engineering | Initial draft |
