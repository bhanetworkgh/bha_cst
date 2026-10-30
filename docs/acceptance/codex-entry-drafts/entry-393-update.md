# Entry 393 Update Draft — CST ↔ vFarm Identity and Authorization

**Status:** PARTIAL — Code-level verified; production identity/authorization proof pending
**Date:** 2026-10-30 (updated from 2026-10-29)
**Prepared by:** CST Engineering

---

## Mission Fit and Ownership Boundaries

### Ownership Matrix

| Domain | Owner | CST Role | Boundary Rule |
|--------|-------|----------|---------------|
| Conversation orchestration | **CST** | Authoritative | CST owns conversation state, turn processing, channel routing, and administration surface |
| Customer-service interaction | **CST** | Authoritative | CST owns the voice/SMS interface, greeting, response generation, and persistence |
| Identity and authorization | **vFarm** | Consumer only | vFarm owns identity, authentication, and authoritative farm/device membership. CST consumes via API; it does not store, override, or fabricate identity/authorization state. |
| Farm and device state | **vFarm** | Consumer only | vFarm owns farm topology, device registration, sensor readings, and alert thresholds. CST fetches on demand; it does not cache or persist authoritative farm state. |
| Knowledge and incident truth | **BHARAG** | Reference holder | BHARAG owns the knowledge graph and incident lifecycle. CST stores incident references (IDs) for conversation context, not the authoritative incident record. |
| Incident references | **CST** | Store only | CST persists `incident_id` in conversation context. It does not own, modify, or adjudicate incident truth. |

### Fail-Closed Rules

- **CST fails closed when identity or authorization cannot be resolved.** If `resolveSpeaker` returns `is_known: false` or `assertSpeakerFarmAccess` throws, CST refuses protected data access and returns a safe onboarding or refusal response.
- **CST must not fabricate** user-to-location, person-to-unit, person-to-farm, or farm-to-device mappings. These are vFarm's authoritative domain.
- **CST must not fabricate** sensor readings, delivery status, or incident truth. Each has an authoritative owner (vFarm, Twilio, BHARAG respectively).
- **CST must not auto-register callers.** An unknown phone number is routed to onboarding, not silently granted access.

## Identity and Authorization Flow (Verified from Code)

### Step 1: Incoming Service Number → CST Tenant/Project Routing
- **File:** `engine/src/interfaces/voice/index.ts (Twilio webhook handler)` (Twilio webhook handler)
- **Function:** `resolveBinding(toE164)` → looks up `service_number_bindings` table
- The receiving Twilio number is matched to a `service_number_binding` record, which provides `tenant_id`, `project_id`, `capability_set`, `consent_policy`
- **Anti-tamper:** Twilio signature validated before any DB access. Body-supplied `tenant_id`/`project_id` rejected with 403.

### Step 2: Caller Phone → vFarm Speaker Resolution
- **File:** `engine/src/identity/resolver.ts` — `IdentityResolver.resolveSenderIdentity()`
- **Preferred path:** `CoreRegistry.resolveSpeaker({ tenantId, projectId, phoneE164 })`
- Calls `VfarmTenantAdapter` which verifies live membership and grants against vFarm
- Returns `person_id`, `role`, `farm_ids`, `is_known`
- **Fail-closed:** If vFarm unavailable, identity is unresolved. No fabricated identity. No auto-registration.

### Step 3: Farm Authorization
- **File:** `engine/src/adapters/vfarm/index.ts` — `assertSpeakerFarmAccess()`
- Verifies `speaker.farm_ids` includes the requested `farmId` before any upstream data request
- Called before: `getFarmStatusForSpeaker()`, `getFarmAlertsForSpeaker()`, `getLatestDeviceReading()`, `listLatestReadings()`
- **Fail-closed:** Missing grant → `VfarmAuthorizationError` → 403, no data returned

### Step 4: vFarm Readings Request
- **File:** `engine/src/adapters/vfarm/live_client.ts` — `listLatestReadings(farmId)`
- Lists devices: `GET /api/v1/devices?farm_id={farmId}`
- Fetches per-device readings: `GET /api/v1/readings/latest?sensor_id={deviceId}`
- Bounded concurrency (5 at a time), 5s per-device timeout
- Schema validation via `LatestReadingResponseSchema`

### Step 5: Response Generation and Persistence
- **File:** `engine/src/core/engine.ts` — `CoreEngine.processEnvelope()`
- **File:** `engine/src/interfaces/voice/index.ts` — voice turn handler
- Readings normalized via `mapLatestReadingToTelemetry()`
- Response generated with actual values and units
- Conversation persisted via `DbClient.getOrCreateConversation()`
- Security audit logged via `Logger.audit()` → `security_ledger` table (P0 fix: now persists to database via `DbClient.recordSecurityLedgerEvent()`)

### Security Ledger Persistence (P0 Fix)
- **File:** `engine/src/config/logger.ts` — `Logger.audit()` now calls `DbClient.recordSecurityLedgerEvent()` via dynamic import
- **File:** `engine/src/db/client.ts` — New method `recordSecurityLedgerEvent()` persists events to the `security_ledger` table
- The `security_ledger` table (migration `003_add_customers_and_security_ledger.sql`) exists in production but received zero records because `Logger.audit()` previously only wrote to the in-memory ring buffer and console. The fix adds durable DB persistence.
- Tests: `npx vitest run` → 1006 passed, 6 skipped, 0 failed (97 files)
- Typecheck: `npx tsc --noEmit -p engine/tsconfig.json` → clean
- Build: `npm run build` → successful

## Record-Level Proof Available

### Local Test Evidence (Verified)
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
- Database: PostgreSQL 16.15, 20 tables, 17 FKs, 22 migrations applied
- Delivery callbacks: `outbound_row_found: false` for some SIDs (fail-closed, no fabricated attribution)

### Still Missing (Blocked)
- Live vFarm identity resolution proof for a real caller (requires vFarm credentials + authorized test)
- Live authorization grant verification for a real farm (requires vFarm membership data)
- Live vFarm readings retrieval for an authorized caller (requires vFarm credentials)
- Live voice E2E test with authorized test number (requires Twilio + ElevenLabs credentials)

## Fail-Closed Behavior (Cited Tests)

| Scenario | Implementation | Test Evidence |
|----------|---------------|---------------|
| Missing vFarm credentials | `VfarmTenantAdapter` returns no live client; `getUnitStatus` returns `telemetry_unavailable` | `kmg9_farm_isolation.test.ts` — "no live client → telemetry_unavailable, no BHARAG call" |
| Unresolved identity | `resolveSpeaker` returns `is_known: false`; router refuses protected data | `router.test.ts` — "serves unregistered sender safe onboarding" |
| Revoked membership | `assertSpeakerFarmAccess` throws `VfarmAuthorizationError` → 403 | `platform_tenancy.test.ts` — "Req 6: Speaker removal immediately revokes farm data access" |
| Missing farm grant | `assertSpeakerFarmAccess` throws → 403 | `vfarm_telemetry_mapping.test.ts` — "unauthorized farm → fail-closed" |
| vFarm timeout | `getUnitStatus` catches error → `telemetry_unavailable` | `vfarm_telemetry_mapping.test.ts` — "vFarm failure → no BHARAG fallback" |
| Unknown inbound destination | `resolveBinding` returns null → 403 | `delivery_callback_security.test.ts` — "unknown destination → refused" |

## Commercial Impact

Without authoritative identity resolution, CST cannot safely disclose farm data to callers. The fail-closed design ensures that even if vFarm is unavailable or a caller's grants are revoked, no protected data is exposed. This protects against cross-tenant data leakage and maintains compliance with the BHA vFarm customer-service direction.

## Links

- Identity evidence: [`docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md)
- Engine Surfacing patch log: [`docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md)
- Decision record (399): [`docs/release/cst-decision-record-2026-10-30.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/release/cst-decision-record-2026-10-30.md)
- Render live evidence: [`docs/evidence/2026-10-29-render-live-evidence-entry-399.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-29-render-live-evidence-entry-399.md)
- Consolidated acceptance: [`docs/acceptance/cst-jason-consolidated-evidence.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/acceptance/cst-jason-consolidated-evidence.md)
- KMG9 verification record: `docs/kmg9-verification-record.md`

### Identity/Authorization Code and Test Evidence

| File | Purpose |
|------|---------|
| `engine/src/identity/resolver.ts` | `IdentityResolver.resolveSenderIdentity()` — speaker resolution |
| `engine/src/adapters/vfarm/index.ts` | `assertSpeakerFarmAccess()` — farm grant verification |
| `engine/src/interfaces/voice/index.ts` | Voice webhook handler — binding resolution, signature validation |
| `engine/src/core/registry.ts` | `CoreRegistry.resolveSpeaker()` — identity orchestration |
| `tests/regression/kmg9_farm_isolation.test.ts` | 9 tests — cross-farm isolation |
| `tests/tenancy/platform_tenancy.test.ts` | 8 tests — tenant boundary enforcement |
| `tests/identity/identity_binding_restoration.test.ts` | 15 tests — identity binding |
| `tests/authorization/authorization_stepup.test.ts` | 6 tests — authorization step-up |

## Still Open

- **BLOCKER:** Live vFarm identity resolution proof for a real caller (requires vFarm credentials + authorized test)
- **BLOCKER:** Live authorization grant verification for a real farm (requires vFarm membership data)
- **BLOCKER:** Live vFarm readings retrieval for an authorized caller (requires vFarm credentials)
- **BLOCKER:** Live voice E2E test with authorized test number (requires Twilio + ElevenLabs credentials)
- **BLOCKER:** KMG9 BHARAG boundary verification (requires isolated cluster evidence from Jegan)

> KMG9 boundary proof and upstream identity binding are NOT complete. No supporting evidence exists for either. They remain BLOCKED pending external evidence.

**Entry 393 remains PARTIAL. DW-1792187689082-B0M2 remains OPEN.**
