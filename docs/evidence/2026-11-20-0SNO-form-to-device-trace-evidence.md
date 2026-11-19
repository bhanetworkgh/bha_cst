# LOOP-1792681313173-0SNO — Form-to-Device End-to-End Trace Evidence Report

**Document Date:** 2026-11-20  
**Loop Identifier:** `LOOP-1792681313173-0SNO`  
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`  
**Decision Watch Reference:** `DW-1795036114694-RK8U`  
**Upstream Dependency:** `LOOP-1792681313174-ZAKN` (vFarm user-to-device join contract owned by Jeganathan)  
**Historical Commit:** `83422e3` (*"fix(cst): answer farm-level status when the caller has a farm grant but no unit"*)  
**Status:** `BLOCKED_ON_EXTERNAL_CONTRACT` (CST fallback implemented; awaiting authoritative upstream vFarm schema)

---

## 1. Trace Path Analysis (Steps 1–12)

The prompt defines the 12-stage end-to-end trace from an inbound customer inquiry to device delivery:

```
[1. Inbound Request] ──► [2. Identity Resolution] ──► [3. Tenant/System & Project]
        │
        ▼
[4. vFarm Authorization] ──► [5. Form Lookup] ──► [6. Form-to-User Mapping]
        │
        ▼
[7. Form-to-Device Mapping] ──► [8. Device Lookup] ──► [9. Sensor Lookup]
        │
        ▼
[10. Live Reading] ──► [11. CST Response] ──► [12. Delivery via Channel]
```

### Trace Stage Execution in CST:
1. **Inbound Request:** Handled via `/webhooks` (Twilio SMS/voice), `/api/v1/web/message`, or ElevenLabs post-call.
2. **Identity Resolution:** Speaker phone number or auth token resolved to `customer_ref`, `tenant_id`, and `role`.
3. **Tenant/System Resolution:** Scoped to `tenant-vfarm-01` and active `project_id`.
4. **vFarm Authorization:** Caller's farm grants verified via vFarm live client.
5. **Form Lookup:** Intake form submission / customer profile retrieved.
6. **Form-to-User Relationship:** Resolved via `user_id` / `person_id`.
7. **Form-to-Device / Unit Relationship:** **MISSING IN VFARM SCHEMA.** (See Section 2).
8. **Device Lookup:** Enumerated via `GET /api/v1/devices`.
9. **Sensor Lookup:** Filtered by `device_type === "sensor"`.
10. **Live Reading:** Retrieved via `GET /api/v1/readings?sensor_id={id}&limit=1`.
11. **CST Response:** Enriched with status, health, and fallback telemetry.
12. **Delivery:** Dispatched via Twilio SMS, voice audio synthesis, or web envelope response.

---

## 2. Structural Schema Gap & The External Blocker

### The Structural Gap
During production testing, callers with confirmed vFarm access were told their number was not linked to an active unit. Investigation of the vFarm API revealed that vFarm does not provide a relational link between user grants and individual devices (`unit_id` or `device_id`). The vFarm API exposes:
- `/api/v1/users/{id}/farm-grants` (grants access to a farm as a whole).
- `/api/v1/devices` (lists all devices in a farm).
- But no table or endpoint joins a user's form/grant to a specific unit.

### CST Farm-Level Fallback Mitigation
In commit `83422e3`, CST implemented a safe fallback in [engine/src/connectors/vfarm.ts](../../engine/src/connectors/vfarm.ts):
- When `unit_context` is unmapped, CST inspects the caller's authorized farms.
- If authorized, CST reports the **aggregate farm-level status** (total devices, active sensors, overall health score) rather than issuing a confusing refusal.
- CST **refuses to fabricate or hallucinate synthetic device IDs**.

### The External Blocker: `LOOP-1792681313174-ZAKN`
True end-to-end form-to-device tracing is blocked on Jeganathan delivering the upstream vFarm contract under `LOOP-1792681313174-ZAKN`:
1. vFarm schema extension linking `user_id` / intake submission to specific `device_id` / `unit_id` records.
2. REST endpoint exposing device-level assignments.
3. Updated `.openapi-vfarm.json` reflecting the confirmed join schema.

---

## 3. Verification & Current Status

- **CST Code Status:** `LOCAL_MITIGATION_VERIFIED`. CST safely returns farm-level status for authorized callers without unit bindings and prevents false refusals.
- **Loop Status:** `BLOCKED_ON_EXTERNAL_CONTRACT`. Cannot be marked complete without Jeganathan's vFarm platform updates.
