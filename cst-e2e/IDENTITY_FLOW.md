# Authoritative CST Identity Flow

This document details the exact, verified code path by which an inbound phone number is mapped to tenancy, upstream vFarm person identity, and live farm grants in CST.

---

## Architecture Flow

```
Inbound Phone (E.164)
       │
       ▼
[Twilio Ingress] (`engine/src/interfaces/sms/index.ts` / `voice/index.ts`)
       │
       ▼
CoreRegistry.resolveServiceNumber(receivingToNumber)
  ├─ Matches `ServiceNumberBinding` in memory / DB
  ├─ Resolves: `tenant_id` ("tenant-vfarm-01")
  └─ Resolves: `project_id` ("proj-vfarm-main")
       │
       ▼
CoreRegistry.resolveSpeaker({ tenantId, projectId, phoneE164: callerFromNumber })
  ├─ 1. Check in-memory short TTL cache (`speakerCache`, 60s TTL)
  └─ 2. If miss or expired: delegate to `VfarmTenantAdapter.resolveSpeaker(...)`
       │
       ▼
VfarmTenantAdapter.resolveSpeaker(params) (`engine/src/adapters/vfarm/index.ts`)
  ├─ 1. Look up locally projected speaker in `speakersMap` / DB (`DbClient.getAllCustomers`)
  │     └─ Matches `customer_ref` / `person_id` (e.g. `debf555c-b37d-4e92-bb15-597e169f1b38`)
  │
  ├─ 2. Query live vFarm organization members:
  │     `VfarmLiveClient.listOrganizationMembers(tenantOrgId)`
  │     └─ Verifies `person_id` is an active member of vFarm organization `122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d`.
  │     └─ If revoked or missing upstream: returns `opaque_revoked` (fails closed).
  │
  ├─ 3. Query live user farm grants:
  │     `VfarmHttpClient.getUserFarmGrants(person_id)`
  │     └─ Upstream API: `GET /api/v1/users/{user_id}/farm-grants`
  │     └─ Returns authoritative array of granted `farm_id`s (e.g. `["21dde23e-f7f6-46bc-9b54-e97fabaaafd7"]`).
  │     └─ If upstream grant query fails: logs warning and fails CLOSED (`farmIds = []`).
  │
  └─ 4. Construct authoritative `SpeakerIdentity`:
        {
          person_id: "debf555c-b37d-4e92-bb15-597e169f1b38",
          customer_ref: "debf555c-b37d-4e92-bb15-597e169f1b38",
          tenant_id: "tenant-vfarm-01",
          project_id: "proj-vfarm-main",
          phone_e164: "+923082113844",
          is_known: true,
          role: "owner" | "manager" | "tech",
          permissions: ["read:telemetry", "read:knowledge", ...],
          farm_ids: ["21dde23e-f7f6-46bc-9b54-e97fabaaafd7"]
        }
       │
       ▼
CoreEngine.processEnvelope(envelope, speaker) (`engine/src/core/engine.ts`)
  ├─ Farm-scope enforcement:
  │    `authorizedFarmIds = speaker.farm_ids;`
  └─ If request targets farm NOT in `authorizedFarmIds`:
       Refuses telemetry/image access with commercial audit refusal log.
```

---

## Key Files and Functions

| Step | File | Function / Class |
|---|---|---|
| Service Number Binding | `engine/src/core/registry.ts` | `CoreRegistry.resolveServiceNumber(phoneE164)` |
| Speaker Delegation | `engine/src/core/registry.ts` | `CoreRegistry.resolveSpeaker(params)` |
| Upstream Member Check | `engine/src/adapters/vfarm/index.ts` | `VfarmTenantAdapter.resolveSpeaker(params)` |
| Live vFarm HTTP Call | `engine/src/adapters/vfarm/live_client.ts` | `VfarmLiveClient.listOrganizationMembers(orgId)` |
| Live Farm Grants Call | `engine/src/adapters/vfarm/http_client.ts` | `VfarmHttpClient.getUserFarmGrants(userId)` |
| Authorization Gate | `engine/src/core/engine.ts` | `CoreEngine.processEnvelope(envelope, speaker)` |

---

## Fail-Closed Security Invariants

1. **Unregistered Phone Number**: If caller phone is not known to the tenant adapter, returns `is_known: false`, `role: 'unknown'`, `farm_ids: []`.
2. **Upstream Org Revocation**: If a user exists in the local database but was deleted or deactivated from the vFarm organization upstream, `resolveSpeaker` flags them as `opaque_revoked` and rejects all farm data.
3. **Upstream Grant API Degradation**: If vFarm's `/farm-grants` endpoint fails or times out, farm scope is set to `[]` (fail-closed); knowledge base questions still answer, but farm-specific telemetry is blocked.
