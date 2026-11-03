# Monitoring Twin & Research Twin — Field Contract & Integration Specification

> **Repository:** `bhanetworkgh/bha_cst`
> **Target Branch:** `fix/monitoring-pay-gate-closure`
> **Date:** 2026-11-03
> **Document Reference:** `docs/contracts/monitoring-research-twin-field-contract.md`
> **Contract Version:** `1.1.1`

---

## 1. Architectural Distinction & Layer Boundaries

To prevent conflation across systems and boundaries, the following four distinct layers are established:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. vFarm Authoritative Source Data (Raw Hardware Telemetry & Database) │
│    - Endpoints: /api/v1/devices, /api/v1/readings,                     │
│                 /api/v1/farms/{farm_id}/health                         │
│    - Status: Authoritative source of truth for device status & physics │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. CST Normalized Response Fields (Internal Normalized DTOs)          │
│    - Schemas: SensorReading, FarmHealthStatus, FleetSummary             │
│    - Status: Strictly typed, sanitized, zero fabricated values         │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
                    ▼                                ▼
┌──────────────────────────────────────┐ ┌───────────────────────────────┐
│ 3. Monitoring Twin (Operational)     │ │ 4. Research Twin (Escalations)│
│    - Focus: Real-time telemetry,     │ │    - Focus: Anomaly diagnosis,│
│      online/offline device presence, │ │      research cards, long-term│
│      freshness, calibrated alerts    │ │      agronomic investigations │
│    - Status: Live operational state  │ │    - Status: Fail-closed gate │
└──────────────────────────────────────┘ └───────────────────────────────┘
```

1. **vFarm Authoritative Source Data:** Raw device registries, readings tables (`readings` table with >6.71M rows), and upstream health computations (`/api/v1/farms/{farm_id}/health`). CST never recalculates or fabricates these values.
2. **CST Normalized Response Fields:** Standardized JSON DTOs produced by `engine/src/adapters/vfarm/` and consumed across CST APIs (`/api/v1/devices`, `/api/health`, admin routes, and conversational engine).
3. **Monitoring Twin Live Operational State:** Real-time operational telemetry reflecting instantaneous cabinet physics (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`), presence states (`online`, `offline`, `off`, `unhealthy`), and sensor calibrations.
4. **Research Twin Historical / Research Information:** Asynchronous agronomic investigations, anomaly escalation cards, crop cycle comparisons, and environmental research summaries triggered by operational anomalies.

---

## 2. Farm Health Route Resolution (`/api/v1/farms/health` vs `/api/v1/farms/{id}/health`)

A critical architectural distinction exists between unparameterized and parameterized farm health endpoints:

1. **Upstream vFarm Authoritative Route:**
   - As formally defined in the vFarm OpenAPI specification (`.openapi-vfarm.json`), vFarm **only** provides the parameterized endpoint:
     `GET /api/v1/farms/{farm_id}/health`
   - There is **no** unparameterized endpoint `GET /api/v1/farms/health` in upstream vFarm. Calling an unparameterized path upstream returns HTTP 404 or HTTP 405.
   - Upstream requires `{farm_id}` (UUIDv4) and caller authentication via bearer token or service credentials.

2. **CST Internal Adapter Resolution:**
   - In CST, `engine/src/adapters/vfarm/` resolves farm health by querying `GET /api/v1/farms/{farm_id}/health` using the caller's authorized `farm_id`.
   - CST's own system health probe (`GET /api/health`) reports CST subsystem health and incorporates the active farm's health by issuing a parameterized request against `GET /api/v1/farms/{active_farm_id}/health`.
   - Any external caller or internal service requesting farm health must supply an explicit `farm_id`.

---

## 3. User-to-Farm Access Rules & Status Codes (403 vs 404 Semantics)

Strict tenant and permission boundaries govern access to farm resources. The CST engine and Monitoring Twin enforce standard RFC 7231 access semantics:

| HTTP Status | Condition | Enforcement Mechanism | Rationale |
|---|---|---|---|
| **`403 Forbidden`** | Caller is authenticated, but **does not own** or has **no active grant** for the requested `farm_id`. | `assertSpeakerFarmAccess(speaker, farmId)` throws `VfarmAuthorizationError` (`AUTH_FORBIDDEN`). | Caller identity is verified, but permissions do not allow viewing or operating on the requested farm. Prevents unauthorized tenant crossing. |
| **`404 Not Found`** | The requested `farm_id` does not exist in vFarm's database or device registry. | vFarm API returns HTTP 404, or CST farm lookup finds no matching record. | The resource identifier itself does not correspond to any known entity. |
| **`401 Unauthorized`** | Caller is unauthenticated or session token is missing/expired. | Admin auth middleware / session validation rejects request. | Identity has not been established. |

> [!IMPORTANT]
> CST will **never** return `404` when an unauthorized user attempts to query an existing farm (which would mask access boundaries or leak information inconsistently), nor return `403` when a farm ID is non-existent.

---

## 4. Health Semantics: NORMAL / DEGRADED / OFFLINE / UNKNOWN

The system evaluates operational health into four distinct, deterministic states. No state is ever guessed or fabricated:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        HEALTH STATE MACHINE                            │
├─────────────┬──────────────────────────────────────────────────────────┤
│ NORMAL      │ All canonical sensors reporting fresh (<15m) telemetry,   │
│             │ devices online, vFarm upstream reports healthy.          │
├─────────────┼──────────────────────────────────────────────────────────┤
│ DEGRADED    │ Telemetry stale (>15m to 24h), out-of-range sensor data, │
│             │ missing calculation timestamp, or vFarm reports neutral/ │
│             │ degraded/unhealthy.                                      │
├─────────────┼──────────────────────────────────────────────────────────┤
│ OFFLINE     │ Hardware controller/gateway unreachable (>1h), or        │
│             │ vFarm device fleet_status is 'offline'.                  │
├─────────────┼──────────────────────────────────────────────────────────┤
│ UNKNOWN     │ Container boot before upstream poll, unauthenticated,    │
│             │ missing farm_id, or upstream communication timeout.      │
└─────────────┴──────────────────────────────────────────────────────────┘
```

### 4.1 State Definitions and Transitions

1. **`NORMAL`:**
   - **Definition:** Optimal operational state.
   - **Preconditions:**
     - Upstream `GET /api/v1/farms/{farm_id}/health` returns status `healthy`.
     - All 4 canonical sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) have reported readings with `age < 15 minutes`.
     - Reporting devices show `fleet_status: "online"`.
     - Sensor values reside within calibrated agronomic operating thresholds.

2. **`DEGRADED`:**
   - **Definition:** Telemetry available but impaired, or parameters out of tolerance.
   - **Preconditions (any of the following):**
     - Sensor telemetry age is between 15 minutes and 24 hours (`stale: false`, but delayed).
     - Upstream farm health reports `neutral`, `degraded`, or `unhealthy`.
     - Upstream health response has null or missing `calculated_at` (`staleness_evaluation: "unavailable_no_timestamp"`).
     - Individual sensor values exceed configured operating thresholds (e.g. soil moisture < 20% or pH > 7.5).

3. **`OFFLINE`:**
   - **Definition:** Hardware disconnected, gateway down, or persistent communication failure.
   - **Preconditions (any of the following):**
     - Upstream device registry reports `fleet_status: "offline"`.
     - Sensor telemetry age exceeds 24 hours (`stale: true`).
     - Gateway or Arduino/ESP32 controllers have failed to emit presence packets for > 1 hour.
     - Note: A load (pump, valve) with `fleet_status: "off"` is intentionally powered down and does NOT trigger `OFFLINE`.

4. **`UNKNOWN`:**
   - **Definition:** Indeterminate state due to initialization or platform isolation.
   - **Preconditions (any of the following):**
     - Initial container cold boot before the first background polling cycle.
     - Upstream vFarm API connection timeout (> 5,000 ms) or network unreachable.
     - Missing or unresolvable `farm_id`.
     - Auth failure against upstream vFarm proxy.

---

## 5. Comprehensive Field Contract Specification

The table below defines all observable and normalized fields across the Monitoring and Research Twin surfaces:

| Field Name | Description | Data Type | Req / Opt | Nullable | Units | Timestamp Semantics | Freshness Expectations | Source of Truth | Tenant / System Scope | Error Behavior |
|---|---|---|---|---|---|---|---|---|---|---|
| `farm_id` | Unique UUID of the vertical farm | `string (UUIDv4)` | Required | No | N/A | ISO 8601 creation | Static configuration | vFarm Farm Entity | Scoped to `tenant_id` | Throws `404` if non-existent, `403` if unauthorized |
| `fleet_status` | Operational presence of hardware device | `enum ('online', 'offline', 'off', 'unhealthy')` | Required | Yes (cabinets) | N/A | Upstream event | Polled on-demand; stale if >5m | vFarm `GET /api/v1/devices` | Farm & Tenant scoped | Missing maps to `null` (never defaults to `online`) |
| `farm_health.status` | Consolidated farm health evaluation | `enum ('healthy', 'degraded', 'unhealthy', 'unknown')` | Required | No | N/A | Evaluated at request time | Bounded by upstream calculation | vFarm `GET /api/v1/farms/{id}/health` | Tenant scoped | Maps unrecognized status or auth failure to `degraded`/`unknown` |
| `health_score` | Upstream diagnostic numerical health score | `number (float 0.0-100.0)` | Optional | Yes | Score | Upstream calculation timestamp | Stale if uncomputed | vFarm `GET /api/v1/farms/{id}/health` | Diagnostic only | If `null`, preserved as `null`; never used to derive `farm_health.status` |
| `calculated_at` | Upstream health calculation timestamp | `string (ISO 8601)` | Optional | Yes | UTC | Timestamp when upstream calculated score | Fresh if < 1h | vFarm `GET /api/v1/farms/{id}/health` | Tenant scoped | If `null`, CST flags `staleness_evaluation: "unavailable_no_timestamp"` |
| `sensor_id` | Unique hardware identifier for sensor | `string` | Required | No | N/A | Hardware registry | Static | vFarm Device Registry | Farm scoped | Unknown ID returns `404 no_reading` |
| `reading_ts` | Physics observation timestamp | `string (ISO 8601)` | Required | No | UTC | Hardware measurement instant | Fresh if < 15m; stale if > 24h | Sensor hardware clock | Farm scoped | If missing or invalid, reading rejected as malformed |
| `received_at` | vFarm ingestion timestamp | `string (ISO 8601)` | Optional | Yes | UTC | Ingestion receipt at gateway | Ingestion instant | vFarm Ingestion Gateway | Platform scoped | Diagnostic logging only |
| `soil_moisture` | Volumetric soil water content (`rack1_soil`) | `number (float)` | Optional | Yes | `%` (0-100) | `reading_ts` | Fresh if < 15m | `rack1_soil` sensor | Farm scoped | If null/missing, status `telemetry_unavailable` |
| `ph` | Acidity/alkalinity measurement (`rack1_ph`) | `number (float)` | Optional | Yes | `pH` (0-14) | `reading_ts` | Fresh if < 15m | `rack1_ph` sensor | Farm scoped | Calibrated at sensor; if null, status `telemetry_unavailable` |
| `temperature` | Ambient air temperature (`rack2_dht`) | `number (float)` | Optional | Yes | `°C` (-10 to 60) | `reading_ts` | Fresh if < 15m | `rack2_dht` sensor | Farm scoped | If null/missing, status `telemetry_unavailable` |
| `humidity` | Relative humidity (`rack2_dht`) | `number (float)` | Optional | Yes | `% RH` (0-100) | `reading_ts` | Fresh if < 15m | `rack2_dht` sensor | Farm scoped | If null/missing, status `telemetry_unavailable` |
| `co` | Carbon monoxide concentration (`rack1_mq7`) | `number (float)` | Optional | Yes | `ppm` (0-1000) | `reading_ts` | Fresh if < 15m | `rack1_mq7` sensor | Farm scoped | If null/missing, status `telemetry_unavailable` |
| `stale` | Telemetry age indicator flag | `boolean` | Required | No | Boolean | Derived from `reading_ts` | `true` if `age > 24h` | CST Normalization Boundary | Session scoped | Prevents stale data from masquerading as live |
| `correlation_id`| End-to-end trace identifier | `string` | Required | No | Identifier | Ingress timestamp instant | Turn lifetime | Ingress Lane (`corr_...`) | Turn scoped | Propagated across DB, vFarm requests, logs, and dashboard |

---

## 6. Example Normalized Response Payloads

### 6.1 Live Monitoring Telemetry Response (`GET /api/v1/devices`)
```json
{
  "farm_id": "21dde23e-f7f6-46bc-9b54-e97fabaaafd7",
  "farm_code": "v-farm",
  "status": "online",
  "fleet_summary": {
    "total_devices": 23,
    "online": 20,
    "offline": 1,
    "off": 2,
    "unhealthy": 0
  },
  "canonical_sensors": {
    "rack1_soil": {
      "sensor_id": "rack1_soil",
      "device_type": "sensor",
      "value": 90.0,
      "unit": "%",
      "reading_ts": "2026-11-02T22:47:30.000Z",
      "stale": false,
      "status": "ok"
    },
    "rack1_ph": {
      "sensor_id": "rack1_ph",
      "device_type": "sensor",
      "value": 5.06,
      "unit": "pH",
      "reading_ts": "2026-11-02T22:47:30.000Z",
      "stale": false,
      "status": "ok"
    },
    "rack2_dht": {
      "sensor_id": "rack2_dht",
      "device_type": "sensor",
      "temperature": 28.8,
      "humidity": 63.0,
      "reading_ts": "2026-11-02T22:47:30.000Z",
      "stale": false,
      "status": "ok"
    },
    "rack1_mq7": {
      "sensor_id": "rack1_mq7",
      "device_type": "sensor",
      "value": 0.76,
      "unit": "ppm",
      "reading_ts": "2026-11-02T22:47:30.000Z",
      "stale": false,
      "status": "ok"
    }
  }
}
```

### 6.2 CST Detailed Health Status Response (`GET /api/health`)
```json
{
  "status": "degraded",
  "version": "1.0.0",
  "uptime_seconds": 1842,
  "api_reachability": {
    "status": "healthy",
    "latency_ms": 889
  },
  "farm_health": {
    "status": "degraded",
    "raw_status": "neutral",
    "health_score": null,
    "calculated_at": null,
    "staleness_evaluation": "unavailable_no_timestamp"
  },
  "research_twin": {
    "state": "blocked",
    "operational": false,
    "contract": "unverified",
    "endpoint_configured": true,
    "service_api_key_configured": true,
    "callback_signing_secret_configured": true,
    "missing": [],
    "reason": "approved Research Twin API and callback contract is not verified"
  }
}
```

---

## 7. Research Twin Escalation & Investigation Contract

When the Monitoring Twin detects persistent operational deviations, it triggers structured investigation records.

### 7.1 Investigation Triggers & Classifications
| Trigger Condition | Detection Point | Action & Classification | Research Twin Event Type |
|---|---|---|---|
| Sensor reading absent | `mapLatestReadingToTelemetry()` | Status `telemetry_unavailable` | `investigation.sensor_telemetry_missing` |
| Sensor reading stale (>24h) | Telemetry normalization boundary | Flag `stale: true` | `investigation.sensor_telemetry_stale` |
| Sensor reading out-of-bounds | Threshold engine | Threshold breach logged | `investigation.sensor_threshold_breach` |
| Unrecognized farm health status | `getFarmHealth()` | Health status `degraded` | `investigation.farm_health_anomaly` |
| Device dropped offline | `pullStatuses()` | Presence `offline` | `investigation.device_connectivity_loss` |
| Self-healing failure threshold | `SelfHealingTracker` (3 errors/10m) | Capability degraded | `investigation.self_healing_exhaustion` |

### 7.2 Research Twin Wire & Webhook Contract (Fail-Closed Boundary)
- **Outbound Dispatch:** CST will dispatch HTTP POST requests to `RT_ENDPOINT_URL` authenticated with header `X-Service-Key: $RT_SERVICE_API_KEY`.
- **Inbound Callback:** Research Twin posts investigation lifecycle updates to `/webhooks/research-twin/callback`.
- **Cryptographic Signature:** Every callback payload must include header `X-RT-Signature` containing the HMAC-SHA256 signature of the raw request body computed with `RT_CALLBACK_SIGNING_SECRET`.
- **Timestamp & Replay Defense:** Payloads must include `timestamp` within 300 seconds of current UTC. Replayed timestamps or invalid HMAC signatures are rejected with HTTP 401/403.
- **Fail-Closed Boundary:** Until Destiny Arupi formally confirms the JSON payload schema and executes one signed callback round-trip, the integration remains strictly in `state: "blocked"`, refusing to emit unverified requests.

---

## 8. Compatibility, Versioning & Evolution Rules

1. **Additive Schema Modifications:** Fields may only be added with optional or nullable designations. Existing field names and enum values (`fleet_status: 'online' | 'offline' | 'off' | 'unhealthy'`) must never be modified or removed.
2. **No Fabricated Health:** When upstream vFarm returns unrecognized or null status fields, CST must continue mapping them truthfully to `degraded` or `unknown`. Defaulting unverified data to `healthy` or `online` is prohibited.
3. **Interim Endpoint Sunset Policy:** The interim readings endpoint (`/api/v1/readings?sensor_id=X&limit=1`) remains active as a transitional compatibility fallback until upstream vFarm applies composite indexes on `readings(sensor_id, reading_ts DESC)`. Upon upstream index deployment, CST will revert to the authoritative `/api/v1/readings/latest` endpoint without changing external DTO contracts.
4. **Contract Versioning:**
   - Contract `1.1.0`: Layer boundaries, observable field specs, interim endpoint isolation, fail-closed Research Twin.
   - Contract `1.1.1`: Route resolution (`/api/v1/farms/{id}/health`), 403 vs 404 access semantics, and explicit NORMAL/DEGRADED/OFFLINE/UNKNOWN state definitions.

