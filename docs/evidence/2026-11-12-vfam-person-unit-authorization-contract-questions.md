# vFarm Person-to-Unit Authorization Contract Clarification & Questions

**Document Reference:** `docs/evidence/2026-11-12-vfam-person-unit-authorization-contract-questions.md`  
**Date:** 2026-11-12  
**Loop Reference:** `LOOP-1790985133889-8D7U`  
**Codex Row Reference:** Row 467 / Session K9VT (`U0AC6RFNP3P_1794245808627`)  
**Target Upstream System:** vFarm API (`https://vfarm.bhanetwork.org/api/v1`)  
**Target Upstream Owner / Engineering Lead:** Jeganathan (vFarm API Team)  
**Consumer System:** Customer Service Twin (CST — `bhanetworkgh/bha_cst`)  
**Status:** **AWAITING VFAM TEAM SPECIFICATION & CONTRACT CONFIRMATION**

---

## 1. Executive Summary & Purpose

Customer Service Twin (CST) orchestrates tenant-isolated customer interactions across SMS, voice, and web channels. To answer user-specific queries (e.g., *"What is the status of my unit?"*, *"Check my moisture level"*), CST must resolve an authenticated user's genuine operational scope from vFarm.

In vFarm's currently published OpenAPI specification (`.openapi-vfarm.json`, 33,103 lines, 130 paths), vFarm provides:
1. Organization membership via `GET /api/v1/organizations/{org_id}/users` (returns `user_id`, `email`, `name`, `role`).
2. Farm-level role grants via `GET /api/v1/users/{user_id}/farm-grants` (returns `farm_id`, `role`, `granted_at`).
3. Farm physical layout via `GET /api/v1/farms/{farm_id}/layout` (zones → locations → sublocations).
4. Device inventory via `GET /api/v1/devices?farm_id={farm_id}` (devices with `zone_id`, `sublocation_id`).

**Critical Upstream Gap:**  
vFarm currently provides **no API endpoint or schema** mapping a user/person to their authorized units, zones, allocations, or sublocations. As a result, CST deliberately omits `unit_id` and answers at the farm level rather than fabricating synthetic unit assignments (e.g. `unit_bay_04`).

This document details the exact missing contract fields, CST's current fail-closed dependencies, proposed wire contracts (clearly labelled **PROPOSED — NOT VERIFIED**), and specific questions requiring vFarm team confirmation.

---

## 2. Exact Missing Contract Fields

The following fields and semantics are completely absent from vFarm's published API:

| Contract Dimension | Required Upstream Information | Current vFarm Published Status |
|---|---|---|
| **Person Identity** | Authoritative vFarm user/person UUID (`user_id` / `person_id`) | Present on org-members and farm-grants, but decoupled from units. |
| **Zone Assignment** | Authoritative zone ID and human-readable name (`zone_id`, `zone_name`) assigned to user | **MISSING** — no user-to-zone endpoint exists. |
| **Allocation Assignment** | Authoritative allocation identifier, allocation state, and tenant binding (`allocation_id`) | **MISSING** — inventory allocate operates only org-wide (`/inventory/{serial}/allocate`). |
| **Sublocation Assignment** | Sublocation UUID, tray index, or rack bay assignment (`sublocation_id`, `bay_index`) | **MISSING** — physical sublocations exist in layout, but zero user assignment links exist. |
| **Authorized Units** | List of specific hardware unit IDs / sensor IDs assigned to person (`unit_ids`) | **MISSING** — no user-to-device/unit mapping endpoint exists. |
| **Authorization Restrictions** | Access level per unit (e.g., `read_telemetry`, `control_actuators`, `manage_alerts`) | **MISSING** — only coarse farm-level roles (`operator`, `viewer`) exist. |
| **Multiple Assignments** | Whether a user can hold assignments across multiple zones, sublocations, or units | **UNSPECIFIED** |
| **Empty Assignments** | Distinction between "user has zero unit assignments" vs "user has unconstrained farm access" | **UNSPECIFIED** |
| **Revocation Semantics** | How unassigned, expired, or revoked unit access is signaled over HTTP | **UNSPECIFIED** |
| **Freshness & Expiry** | Timestamping (`granted_at`, `expires_at`, `version`) on unit-level assignments | **UNSPECIFIED** |
| **Error Handling** | Exact HTTP status codes when user exists in farm but has no unit assignment (e.g., 200 with empty array vs 404) | **UNSPECIFIED** |

---

## 3. Existing CST Assumptions and Code Dependencies

1. **Identity Resolution (`engine/src/adapters/vfarm/index.ts:1506-1517`):**
   - CST queries `GET /api/v1/organizations/{org_id}/users` to verify active org membership, followed by `GET /api/v1/users/{user_id}/farm-grants`.
   - Because vFarm exposes no unit identifier on either endpoint, CST explicitly leaves `speaker.unit_context.unit_id` as `undefined`.
   - **Current Rule:** CST refuses to guess or invent a unit ID.
2. **Telemetry Query Dispatch (`engine/src/connectors/vfarm.ts:290-300`):**
   - When a customer asks about status and `unit_id` is undefined, CST checks `boundFarmId`.
   - If the caller has an authorized farm grant, CST queries farm-level aggregated readings or fleet status, stating that per-unit readings are unassigned.
   - If `farm_id` is missing or unauthorized, CST refuses with `403` (`assertSpeakerFarmAccess`).
3. **Core Engine Fallback (`engine/src/core/engine.ts:665-691`):**
   - Only a unit ID vFarm actually reported may be used. CST strictly prohibits falling back to a farm ID where a unit ID is expected.

---

## 4. Proposed Wire Contract Candidates (PROPOSED — NOT VERIFIED)

> [!WARNING]
> **PROPOSED — NOT VERIFIED**  
> The endpoints, schemas, and payloads below are proposed options formulated by CST engineering for discussion with the vFarm API team. They do NOT represent existing or deployed vFarm API endpoints.

### Option A: Extend Existing Farm Grants Endpoint (Recommended)
Extend `GET /api/v1/users/{user_id}/farm-grants` to include an `assignments` block per farm.

```http
GET /api/v1/users/{user_id}/farm-grants HTTP/1.1
Host: vfarm.bhanetwork.org
Authorization: Bearer <admin_or_user_jwt>
X-Farm-Key: <farm_key>
```

#### Proposed Response Schema:
```json
{
  "total": 1,
  "grants": [
    {
      "farm_id": "21dde23e-f7f6-46bc-9b54-e97fabaaafd7",
      "role": "operator",
      "granted_by": "usr_admin_001",
      "granted_at": "2026-11-01T12:00:00Z",
      "unit_scope": {
        "is_unrestricted": false,
        "authorized_unit_ids": [
          "rack1_soil",
          "rack1_ph"
        ],
        "zones": [
          {
            "zone_id": "f1ce21e7-0000-0000-0000-000000000000",
            "zone_name": "Main Zone"
          }
        ],
        "allocations": [
          {
            "allocation_id": "alloc_bay_01",
            "serial_number": "VF-RACK1-2026",
            "status": "allocated"
          }
        ],
        "sublocations": [
          {
            "sublocation_id": "6190067f-0000-0000-0000-000000000000",
            "sublocation_name": "tray 01",
            "bay_index": 0
          }
        ]
      }
    }
  ]
}
```

### Option B: Dedicated Person-to-Unit Scope Endpoint
Introduce a new dedicated query endpoint scoped by farm and user.

```http
GET /api/v1/farms/{farm_id}/users/{user_id}/scope HTTP/1.1
Host: vfarm.bhanetwork.org
Authorization: Bearer <admin_or_user_jwt>
X-Farm-Key: <farm_key>
```

#### Proposed Response Schema:
```json
{
  "user_id": "142d03f7-4b7e-4246-b999-70835e004f33",
  "farm_id": "21dde23e-f7f6-46bc-9b54-e97fabaaafd7",
  "role": "operator",
  "scope_type": "restricted",
  "units": [
    {
      "unit_id": "rack1_soil",
      "unit_type": "sensor",
      "zone_id": "f1ce21e7-0000-0000-0000-000000000000",
      "location_id": "89b46a18-0000-0000-0000-000000000000",
      "sublocation_id": "6190067f-0000-0000-0000-000000000000",
      "permissions": ["read_telemetry"]
    }
  ],
  "updated_at": "2026-11-10T14:30:00Z"
}
```

---

## 5. Formal Questions for the vFarm API Team

Please provide written answers to the following engineering questions:

1. **Canonical Endpoint:** Will vFarm expose person-to-unit assignments by extending `GET /api/v1/users/{user_id}/farm-grants` (Option A), via a new endpoint such as `/api/v1/farms/{farm_id}/users/{user_id}/scope` (Option B), or through an alternate path?
2. **Assignment Granularity:** Is a user assigned directly to individual `device_id`s, or are assignments made to a physical container (`zone_id`, `location_id`, `sublocation_id` / bay) from which device access is derived?
3. **Cardinality:** Can a person have multiple unit assignments within a single farm, or is it strictly 1-to-1?
4. **Unassigned / Unrestricted Semantics:** What is returned for a farm `operator` or `manager` who has access to the whole farm rather than specific bays? (e.g., `authorized_unit_ids: []` with an `is_all_units: true` flag, or a list of all unit IDs on the farm?)
5. **Revocation Representation:** When a user's unit assignment is removed while their farm grant remains active, does vFarm return an empty unit list (`[]`) with HTTP 200, or a specific status code?
6. **Authentication & Authorization:** What credentials are required to read user unit assignments? Can CST query this using its administrative service credentials (`VFARM_ADMIN_USER` / Bearer JWT and `X-Farm-Key`), or does it require an on-behalf-of user token?
7. **Timeline & Deployment:** When is the person-to-unit contract scheduled for implementation in the vFarm codebase, and on what deployment will it be available for staging integration?

---

## 6. CST Decisions Blocked Until vFarm Confirmation

Until the vFarm API team confirms the specification above:
- CST **must not** synthesize fake unit IDs or infer unit bindings from caller phone numbers.
- CST **must continue** to report `unit_context.unit_id: undefined` in `VfarmTenantAdapter.resolveSpeaker()`.
- CST status queries for callers with authorized farm grants but no unit binding will continue to answer at the **farm aggregate level** (`listLatestReadings(farmId)`).
- Loop `LOOP-1790985133889-8D7U` remains classified as **`BLOCKED_WAITING_FOR_VFAM_CONTRACT`**.

