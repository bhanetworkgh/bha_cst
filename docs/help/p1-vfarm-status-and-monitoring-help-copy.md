# P1.0 Help Copy — vFarm Status and Monitoring

> Specification & Customer-Facing Help Text  
> Release Target: P1.0  
> Status: Updated for Contract v1.1.1 & Deployed vFarm Behavior (2026-11-03)

## 1. Authority and Ownership

- **vFarm owns `fleet_status` and device presence:** CST is an orchestration and customer-service interface, not the authoritative state engine. CST never recomputes, overrides, or invents device states from `last_seen_at`, health scores, relay module status, or local timeouts.
- **`off` is not `offline`:** A load (pump, valve, light) reported as `off` is intentionally switched off in operations. It is not an outage, failure, or offline event. Only `offline` signifies an unreachable device.
- **Authoritative health:** Missing, stale, failed, null, or unrecognized upstream farm health from vFarm is **not** healthy. It maps directly to `degraded` or `unknown`. Only an explicit `healthy` from `GET /api/v1/farms/{farm_id}/health` is treated as healthy.

---

## 2. Upstream Presence Contract & Known Defect

### Five-Minute Presence Rule — BLOCKED
CST passes through vFarm's authoritative `fleet_status`; it does not calculate online/offline state locally. The exact presence window, including whether five minutes is implemented for every device class, is **BLOCKED** pending Jeganathan's confirmation and deployed vFarm evidence. CST must not describe the five-minute rule as verified.

### Known Defect: `NEVER_HEARD_DEVICE_FALSE_ONLINE`
> [!WARNING]
> **Known Upstream Defect Notice:**  
> A newly created or registered device in vFarm initialized with an `online` status that has never transmitted an actual presence packet or sensor reading can remain falsely marked `online`.
>
> An upstream corrective patch (vFarm PR target) ensures never-heard devices initialize to `offline` until first verified packet receipt. Until this upstream fix is deployed and verified:
> - CST describes device status as reported by vFarm.
> - CST does not manufacture local presence heuristics or mask upstream status.

---

## 3. Real-Time Monitoring Boundaries

> [!IMPORTANT]
> **Monitoring Boundary Notice:**  
> Real-time monitoring cannot be guaranteed as reliable until both:
> 1. The upstream `NEVER_HEARD_DEVICE_FALSE_ONLINE` defect fix is deployed and verified in vFarm.
> 2. The CST status gates (bounded 5,000 ms timeout, sensor-only reading filtering, and per-sensor status gates) have fully passed production end-to-end verification.

---

## 4. Operational Health Semantics & Response Discipline (Contract v1.1.1)

Under Contract v1.1.1, health is classified into four explicit operational states. CST applies strict conversational discipline regarding what it will and will not say to customers:

### 4.1 State: NORMAL
- **Operational Meaning:** Upstream `GET /api/v1/farms/{farm_id}/health` reports `healthy`, all canonical sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) report fresh telemetry (<15m), and reporting devices are online within threshold limits.
- **What CST WILL say:**
  > "Farm health is normal. All monitored sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) are reporting fresh readings within configured operational limits."
- **What CST WILL NOT say:**
  - Will **NOT** state that the entire farm biology or unmonitored equipment is healthy.
  - Will **NOT** state that unmonitored cabinets or structural frames are active.
  - Will **NOT** fabricate readings for sensors that have not reported.

### 4.2 State: DEGRADED
- **Operational Meaning:** Telemetry is stale (>15m to 24h), one or more sensor readings have breached configured thresholds, or upstream vFarm health reports `neutral`, `degraded`, or `unhealthy`.
- **What CST WILL say:**
  > "Farm health is degraded. One or more sensors are reporting out-of-range values, telemetry is stale, or upstream vFarm status is degraded."
- **What CST WILL NOT say:**
  - Will **NOT** tell the customer that everything is fine or functioning normally.
  - Will **NOT** invent substitute values or use historical averages as live measurements.
  - Will **NOT** blame hardware failure when gateway latency or upstream ingestion lag is the cause.

### 4.3 State: OFFLINE
- **Operational Meaning:** Hardware controllers, gateways, or reporting sensors have been unreachable for > 1 hour, or upstream device registry reports `fleet_status: "offline"`.
- **What CST WILL say:**
  > "Farm devices or connectivity gateway are offline. Hardware has stopped emitting telemetry packets."
- **What CST WILL NOT say:**
  - Will **NOT** describe scheduled or powered-down loads (`fleet_status: "off"`) as offline or faulted.
  - Will **NOT** describe structural frames (e.g. `VFARM-CAB-001`) as offline devices.
  - Will **NOT** speculate on the root cause before physical or telemetry connectivity is verified.

### 4.4 State: UNKNOWN
- **Operational Meaning:** CST cannot establish communication with upstream vFarm (network error, timeout > 5,000 ms), authentication failed, or container is in pre-poll initialization.
- **What CST WILL say:**
  > "Farm health is unknown. CST is currently unable to verify authoritative status with the upstream vFarm system."
- **What CST WILL NOT say:**
  - Will **NOT** assume or report healthy status by default.
  - Will **NOT** present stale or unverified cached metrics without explicit staleness disclosure.
  - Will **NOT** hide upstream connection failures behind generic pleasantries.

---

## 5. Customer-Facing Help & Guidance Copy

### General Farm & Fleet Status Inquiries
> "vFarm is the authoritative system of record for your farm's devices and health. When checking status:
> - **Switched Off (`off`):** The load (pump, valve, light) is intentionally powered off by schedule or controller, not offline.
> - **Offline (`offline`):** The device has stopped reporting presence to vFarm.
> - **Unhealthy (`unhealthy`):** The device is online but reporting an error or diagnostic fault.
> - **Cabinet Frames:** Cabinet identifiers (e.g. `VFARM-CAB-001`) are structural frames, not reporting devices.
>
> If farm health indicates degraded or unknown, CST is unable to verify authoritative health from vFarm. We do not infer health from incomplete sensor readings or health scores."

### Sensor Telemetry, Freshness & Missing Readings
> "Telemetry readings are requested only from devices whose authoritative vFarm `device_type` is `sensor`. CST currently uses `GET /api/v1/readings?sensor_id={sensor_id}&limit=1`; the history endpoint's ordering is not verified, so CST does not claim that the returned row is definitively the newest. Missing, malformed, timed-out, or unauthorized readings are unavailable—not zero, normal, or healthy. A stale reading remains labeled stale and is not proof of current device presence or farm health."

### Health Freshness
The current CST farm-health response contract has no confirmed authoritative health timestamp. `/api/health` therefore reports `staleness_evaluation: unavailable_no_timestamp`. Freshness handling is implemented at the normalization boundary for an explicitly contracted timestamp and budget, but no timestamp field or farm-health freshness window is claimed in production.

### Pilot Capability Boundaries
- Live telemetry retrieval of `rack1_soil`, `rack1_ph`, `rack2_dht`, and `rack1_mq7` is verified in production deployment `dep-dbkh3p6417fc73bffihg` using the interim endpoint (`GET /api/v1/readings?sensor_id={sensor_id}&limit=1`). Direct authoritative retrieval from `/api/v1/readings/latest` remains **BLOCKED** on upstream vFarm database composite indexing.
- Temperature, humidity, pH, soil-moisture, and air-quality values are rendered only when present in a valid upstream reading. If upstream data is missing, timed out, or uncalibrated, status maps truthfully to `telemetry_unavailable`.
- Camera/media capability is **NOT CONFIGURED** for this pilot (upstream returns HTTP 422) and is not promised by this help copy.
- `OFFLINE_UPSTREAM` means CST could not retrieve authoritative upstream state; it is not a device offline verdict. `NEVER_HEARD` remains an upstream-owned correction and is not inferred by CST.


