# P1.0 Help Copy — vFarm Status and Monitoring

> Specification & Customer-Facing Help Text  
> Release Target: P1.0  
> Status: Updated for Deployed vFarm Behavior (2026-11-02)

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

## 4. Customer-Facing Help & Guidance Copy

### General Farm & Fleet Status Inquiries
> "vFarm is the authoritative system of record for your farm's devices and health. When checking status:
> - **Switched Off (`off`):** The load (pump, valve, light) is intentionally powered off by schedule or controller, not offline.
> - **Offline (`offline`):** The device has stopped reporting presence to vFarm.
> - **Unhealthy (`unhealthy`):** The device is online but reporting an error or diagnostic fault.
> - **Cabinet Frames:** Cabinet identifiers (e.g. `VFARM-CAB-001`) are structural frames, not reporting devices.
>
> If farm health indicates degraded or unknown, CST is unable to verify authoritative health from vFarm. We do not infer health from partial sensor readings or health scores."

### Sensor Telemetry, Freshness & Missing Readings
> "Telemetry readings are requested only from devices whose authoritative vFarm `device_type` is `sensor`. CST currently uses `GET /api/v1/readings?sensor_id={sensor_id}&limit=1`; the history endpoint's ordering is not verified, so CST does not claim that the returned row is definitively the newest. Missing, malformed, timed-out, or unauthorized readings are unavailable—not zero, normal, or healthy. A stale reading remains labeled stale and is not proof of current device presence or farm health."

### Health Freshness
The current CST farm-health response contract has no confirmed authoritative health timestamp. `/api/health` therefore reports `staleness_evaluation: unavailable_no_timestamp`. Freshness handling is implemented at the normalization boundary for an explicitly contracted timestamp and budget, but no timestamp field or farm-health freshness window is claimed in production.

### Pilot Capability Boundaries
- Live verification of `rack1_soil`, `rack1_ph`, `rack2_dht`, and `rack1_mq7` is **BLOCKED** by the current vFarm farm-discovery HTTP 401; no current value or online claim is made from that failed check.
- Temperature, humidity, pH, soil-moisture, and air-quality values may be rendered only when present in a valid upstream reading. Their current production availability is **NOT VERIFIED**.
- Camera/media capability is **NOT VERIFIED** for this pilot and is not promised by this help copy.
- `OFFLINE_UPSTREAM` means CST could not retrieve authoritative upstream state; it is not a device offline verdict. `NEVER_HEARD` remains an upstream-owned correction and is not inferred by CST.

