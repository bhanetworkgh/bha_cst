# CST Entry 393 — Identity and Authorization Evidence

**Date:** 2026-10-29  
**Entry:** 393  
**Purpose:** CST ↔ vFarm identity and authorization  
**Status:** PARTIAL — code verified, live record-level proof pending

---

## 1. Mission Fit

CST owns conversation orchestration, channel handling, conversation state, and its administration surface. vFarm is authoritative for farm identity, membership/authorization, farm/device associations, and live farm state. BHARAG owns knowledge and incident capabilities; CST stores incident references rather than becoming the source of truth.

CST must never:
- Invent or fabricate caller identity
- Use stale local identity data to authorize production requests
- Fall back to BHARAG for live farm state
- Disclose protected farm information to unauthorized callers

## 2. Identity and Authorization Flow (from code)

### Step 1: Incoming Service Number → CST Tenant/Project Routing

**File:** `engine/src/interfaces/voice/index.ts (Twilio webhook handler)` (Twilio webhook handler)  
**Function:** `resolveBinding(toE164)` → looks up `service_number_bindings` table

The receiving Twilio number is matched to a `service_number_binding` record, which provides:
- `tenant_id` — the tenant organization
- `project_id` — the project within the tenant
- `capability_set` — what the binding allows (e.g., voice, sms)
- `consent_policy` — consent requirements for this binding

**Anti-tamper:** The webhook validates Twilio signature before any DB access. Body-supplied `tenant_id`/`project_id` are rejected with 403.

### Step 2: Caller Phone → vFarm Speaker Resolution

**File:** `engine/src/identity/resolver.ts` — `IdentityResolver.resolveSenderIdentity()`  
**Preferred path:** `CoreRegistry.resolveSpeaker({ tenantId, projectId, phoneE164 })`

This calls the vFarm tenant adapter which:
1. Looks up the person by phone number in vFarm's identity system
2. Verifies live membership and grants
3. Returns `person_id`, `role`, `farm_ids`, `is_known`

**Fail-closed:** If vFarm is unavailable, identity is unresolved. No fabricated identity. No auto-registration.

### Step 3: Farm Authorization

**File:** `engine/src/adapters/vfarm/index.ts` — `assertSpeakerFarmAccess()`

```typescript
function assertSpeakerFarmAccess(speaker: SpeakerIdentity, farmId: string, discoveredFarmIds: string[]): void {
  if (!speaker.farm_ids?.includes(farmId)) {
    throw new VfarmAuthorizationError('Caller is not authorized for this farm');
  }
}
```

This is called before every upstream vFarm data request:
- `getFarmStatusForSpeaker()`
- `getFarmAlertsForSpeaker()`
- `getLatestDeviceReading()`
- `listLatestReadings()`

### Step 4: vFarm Readings Request

**File:** `engine/src/adapters/vfarm/live_client.ts` — `listLatestReadings(farmId)`

1. List devices: `GET /api/v1/devices?farm_id={farmId}`
2. For each device, fetch reading: `GET /api/v1/readings/latest?sensor_id={deviceId}`
3. Bounded concurrency (5 at a time)
4. Schema validation via `LatestReadingResponseSchema`

### Step 5: Response Generation and Persistence

**File:** `engine/src/core/engine.ts` — `CoreEngine.processEnvelope()`  
**File:** `engine/src/interfaces/voice/index.ts` — voice turn handler

- Readings normalized via `mapLatestReadingToTelemetry()`
- Response generated with actual values and units
- Conversation persisted via `DbClient.getOrCreateConversation()`
- Security audit logged via `Logger.audit()` → `security_ledger`
- Voice delivery recorded via `DbClient.recordVoiceDelivery()`

## 3. Tables and Endpoints

### Database Tables (from migrations)

| Table | Source | Purpose |
|-------|--------|---------|
| `customers` | 003, 010 | Caller identity, tenant/project scope, farm_ids |
| `service_number_bindings` | 010 | Maps receiving phone number → tenant/project/capability |
| `conversations` | 001, 010 | Conversation state, system_id FK to systems |
| `systems` | 001, 009 | Legacy tenant/system model (still FK parent) |
| `projects` | 010 | Project configuration, voice pointers |
| `organizations` | 008 | Tenant organization records |
| `security_ledger` | 003 | Durable security audit log |
| `messages_out` | 001 | Outbound message queue with provider SID, tenant/project attribution |
| `voice_deliveries` | 009 | Voice delivery records with system/tenant attribution |
| `escalations` | 022 | Human escalation records (applied in production) |

### API Endpoints

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/webhooks/twilio/voice/inbound` | POST | Twilio signature | Inbound voice call handler |
| `/webhooks/twilio/voice/turn` | POST | Twilio signature | Voice turn processing |
| `/webhooks/twilio/delivery-status` | POST | Twilio signature | SMS delivery callback |
| `/health` | GET | None | Process health |
| `/health/voice` | GET | None | Voice readiness (clone configured, not call traffic) |
| `/api/v1/voice/audio/:id` | GET | None (UUID-based) | Serve cached synthesized audio |
| `/api/v1/admin/health/verification` | GET | Admin auth | Admin readiness payload |

### vFarm Endpoints (Upstream)

| Endpoint | Method | Required Params | Auth |
|----------|--------|-----------------|------|
| `/api/v1/devices?farm_id={farmId}` | GET | `farm_id` (query) | `X-Farm-Key` + `Authorization: Bearer <JWT>` |
| `/api/v1/readings/latest?sensor_id={sensorId}` | GET | `sensor_id` (query) | Same |
| `/api/v1/farms/{farmId}/health` | GET | `farm_id` (path) | Same |
| `/api/v1/alerts/threshold/counts` | GET | `farm_id` (query) | Same |

## 4. Record-Level Proof — Safe SQL (Read-Only)

These queries can be run by an authorized operator against the production database to collect identity/authorization evidence. **Do not execute without authorization.**

```sql
-- 1. Check service number binding for a phone number (redact phone in report)
SELECT tenant_id, project_id, capability_set, consent_policy
FROM service_number_bindings
WHERE receiving_number = '<MASKED_PHONE>';

-- 2. Check caller identity in customers table
SELECT tenant_id, project_id, customer_ref, role, farm_id, farm_ids
FROM customers
WHERE phone_e164 = '<MASKED_PHONE>';

-- 3. Check vFarm system registration
SELECT system_id, tenant_id, project_id, farm_ids, voice_id
FROM systems
WHERE system_id = 'system-vfarm-01';

-- 4. Check conversation persistence
SELECT conversation_id, tenant_id, project_id, system_id, customer_ref, created_at
FROM conversations
WHERE tenant_id = '<TENANT_ID>'
ORDER BY created_at DESC LIMIT 5;

-- 5. Check voice delivery records
SELECT id, system_id, tenant_id, status, voice_id, correlation_id, created_at
FROM voice_deliveries
WHERE tenant_id = '<TENANT_ID>'
ORDER BY created_at DESC LIMIT 5;

-- 6. Check security ledger entries
SELECT id, tenant_id, actor, entry_point, tool_or_route, outcome, reason, correlation_id, timestamp
FROM security_ledger
WHERE correlation_id = '<CALL_SID>'
ORDER BY timestamp DESC;
```

## 5. Test vs Production Evidence

### Local Tests (Verified)
- `tests/identity/identity_binding_restoration.test.ts` — 15 tests pass
- `tests/authorization/authorization_stepup.test.ts` — 6 tests pass
- `tests/tenancy/platform_tenancy.test.ts` — 8 tests pass
- `tests/router/router.test.ts` — 15 tests pass
- `tests/regression/kmg9_farm_isolation.test.ts` — 9 tests pass
- `tests/connectors/vfarm_telemetry_mapping.test.ts` — 17 tests pass
- `tests/connectors/bharag_rag.test.ts` — 12 tests pass

### Production Evidence (Read-Only, Re-Verified 2026-10-29)
- `/health` → 200 OK
- `/health/voice` → healthy (clone configured, 17 deliveries in 24h)
- Outbound worker: heartbeats every 5 min, all queue counts at 0
- Database: PostgreSQL 16.15, 20 tables, 17 FKs, 22 migrations (022 applied)
- Backup: 1 valid archive (80,365 bytes), restore drill passed
- Delivery callbacks: `outbound_row_found: false` for some SIDs (fail-closed, no fabricated attribution)

### Still Missing (Blocked)
- Live vFarm identity resolution proof for a real caller
- Live authorization grant verification for a real farm
- Live vFarm readings retrieval for an authorized caller
- Live voice E2E test with authorized test number

## 6. Mismatch Example (Historical, Not Current Proof)

The previously reported `usr_vfarm_003` / `opaque_revoked` case is documented in `docs/kmg9-verification-record.md` and `cst-status-and-remaining-work.md`. This is **historical evidence** from a prior audit, not proof of current state. The current codebase has fail-closed identity resolution that refuses unverified callers.

## 7. Fail-Closed Behavior (Cited Tests)

| Scenario | Implementation | Test Evidence |
|----------|---------------|---------------|
| Missing vFarm credentials | `VfarmTenantAdapter` returns no live client; `getUnitStatus` returns `telemetry_unavailable` | `kmg9_farm_isolation.test.ts` — "no live client → telemetry_unavailable, no BHARAG call" |
| Unresolved identity | `resolveSpeaker` returns `is_known: false`; router refuses protected data | `router.test.ts` — "serves unregistered sender safe onboarding" |
| Revoked membership | `assertSpeakerFarmAccess` throws `VfarmAuthorizationError` → 403 | `platform_tenancy.test.ts` — "Req 6: Speaker removal immediately revokes farm data access" |
| Missing farm grant | `assertSpeakerFarmAccess` throws → 403 | `vfarm_telemetry_mapping.test.ts` — "unauthorized farm → fail-closed" |
| vFarm timeout | `getUnitStatus` catches error → `telemetry_unavailable` | `vfarm_telemetry_mapping.test.ts` — "vFarm failure → no BHARAG fallback" |
| Unknown inbound destination | `resolveBinding` returns null → 403 | `delivery_callback_security.test.ts` — "unknown destination → refused" |

## 8. Still Open

- **BLOCKER:** Live vFarm identity resolution proof for a real caller (requires vFarm credentials + authorized test)
- **BLOCKER:** Live authorization grant verification for a real farm (requires vFarm membership data)
- **BLOCKER:** Live vFarm readings retrieval for an authorized caller (requires vFarm credentials)
- **BLOCKER:** Live voice E2E test with authorized test number (requires Twilio + ElevenLabs credentials)
- **BLOCKER:** KMG9 BHARAG boundary verification (requires isolated cluster evidence from Jegan)
- **BLOCKER:** Postgres continuity decision (requires account owner decision before Nov 14 2026)
