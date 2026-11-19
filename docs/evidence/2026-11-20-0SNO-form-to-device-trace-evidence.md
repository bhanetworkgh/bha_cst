# LOOP-1792681313173-0SNO — Form-to-Device End-to-End Trace Evidence Report

**Document Date:** 2026-11-20
**Loop Identifier:** `LOOP-1792681313173-0SNO`
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`
**Decision Watch Reference:** `DW-1795036114694-RK8U`
**Upstream Dependency:** `LOOP-1792681313174-ZAKN` (vFarm user-to-device join contract owned by Jeganathan)
**Historical Commit:** `83422e3` (*"fix(cst): answer farm-level status when the caller has a farm grant but no unit"*)
**Implementation Status:** `COMPLETED`
**Evidence Status:** `VERIFIED` (CST 12-stage trace pipeline and fallback behavior verified)
**Owner Acceptance Status:** `READY_FOR_OWNER_ACCEPTANCE` (CST engine implementation); `EXTERNAL_CONFIRMATION_REQUIRED` (Upstream vFarm join schema under `LOOP-1792681313174-ZAKN`)

---

## 1. Trace Path Analysis (Steps 1–12)

The 12-stage end-to-end trace from an inbound customer inquiry to device delivery is structured as follows:

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

| Stage | Name | Implementation in CST | Implementation Status | Evidence Status |
|---|---|---|---|---|
| **1** | Inbound Request | Ingress via Twilio webhook, web session, or ElevenLabs post-call | `COMPLETED` | `VERIFIED` |
| **2** | Identity Resolution | Caller phone number or session token mapped to `customer_ref`, `tenant_id`, and `role` | `COMPLETED` | `VERIFIED` |
| **3** | Tenant/System Resolution | Request scoped to `tenant-vfarm-01` and active `project_id` | `COMPLETED` | `VERIFIED` |
| **4** | vFarm Authorization | User grants validated via vFarm API | `COMPLETED` | `VERIFIED` |
| **5** | Form Lookup | Intake form / profile retrieved from datastore | `COMPLETED` | `VERIFIED` |
| **6** | Form-to-User Mapping | Profile joined via `user_id` / `person_id` | `COMPLETED` | `VERIFIED` |
| **7** | Form-to-Device Mapping | **CST Fallback Implemented:** If unit unlinked in vFarm, answers with aggregate farm status; zero synthetic IDs fabricated | `COMPLETED` | `VERIFIED` |
| **8** | Device Lookup | Devices enumerated via `GET /api/v1/devices` | `COMPLETED` | `VERIFIED` |
| **9** | Sensor Lookup | Filtered by `device_type === "sensor"` | `COMPLETED` | `VERIFIED` |
| **10** | Live Reading | Reading queried via `GET /api/v1/readings?sensor_id={id}&limit=1` | `COMPLETED` | `VERIFIED` |
| **11** | CST Response | Enriched with health, status, and confidence metadata | `COMPLETED` | `VERIFIED` |
| **12** | Channel Delivery | Response dispatched via Twilio SMS, voice synthesis, or web envelope | `COMPLETED` | `VERIFIED` |

---

## 2. CST Farm-Level Fallback Implementation

### 2.1 The Upstream Schema Gap
In the current vFarm API:
- `/api/v1/users/{id}/farm-grants` grants access to an entire farm.
- `/api/v1/devices` lists all devices located on a farm.
- However, vFarm does not yet maintain a relational join table or property linking a specific user/intake form to an individual `device_id` or `unit_id`.

### 2.2 CST Mitigating Implementation (Commit `83422e3`)
Rather than failing closed or refusing valid authorized farm owners, CST implemented a safe, non-hallucinating fallback in [engine/src/connectors/vfarm.ts](../../engine/src/connectors/vfarm.ts):
1. When `unit_context` is unmapped, CST inspects the caller's authorized farm grants.
2. If the caller is authorized for the farm, CST computes and returns the **aggregate farm-level status** (total devices online, active sensors, overall climate status).
3. CST strictly **refuses to fabricate or hallucinate synthetic device IDs**.

---

## 3. Upstream Dependency & External Confirmation

### Upstream Contract: `LOOP-1792681313174-ZAKN`
- **Owner:** Jeganathan (vFarm API Lead)
- **External Confirmation Required (`EXTERNAL_CONFIRMATION_REQUIRED`):**
  1. Delivery of the vFarm schema migration linking `user_id` / intake submission to specific `device_id` / `unit_id` records.
  2. Availability of the endpoint exposing unit-level customer assignments.
  3. Release of the updated `.openapi-vfarm.json` schema.

*Summary:* The CST-side implementation for form-to-device tracing and farm-level fallback is **`COMPLETED`** and **`VERIFIED`**. Direct 1-to-1 unit binding is awaiting the upstream vFarm database contract delivery from Jeganathan.
