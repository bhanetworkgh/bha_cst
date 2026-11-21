# CST — Independent Authorization Remediation Audit Report

**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `feat/iwkx-postgres-lifecycle-acceptance`  
**Expected HEAD:** `4f82b742e72bd9972f7ae7e9de216e239e926372`  
**Audit Timestamp:** 2026-11-20T20:10:00Z  
**Overall Security Verdict:** `PARTIALLY_SECURED`  

---

## 1. Executive Verdict

This independent audit evaluated the CST farm authorization remediation, test evidence, dependent-device helper implementation, and deployment reality.

### Key Audit Findings:
1. **Local Authorization Remediation (`SECURED_LOCALLY_PENDING_UPSTREAM_VERIFICATION`):**  
   The dangerous `dynamicAllowedFarms` parameter and tenant-discovery bypass have been completely eradicated from `assertSpeakerFarmAccess` and all 7 production caller sites in `VfarmTenantAdapter`. The legacy `AuthorizableSpeaker` type has been removed; `assertSpeakerFarmAccess` strictly requires a `SpeakerIdentity` with a non-empty string `person_id`. Unauthenticated callers (`is_known: false`) fail closed immediately with HTTP 403, preventing unauthorized role elevation (including claiming `role: 'admin'`).
2. **Production Deployment Reality (`PRODUCTION_REMEDIATION_NOT_VERIFIED`):**  
   The authorization fixes and tests exist solely as **uncommitted working-tree modifications** on branch `feat/iwkx-postgres-lifecycle-acceptance`. The HEAD commit is `4f82b742e72bd9972f7ae7e9de216e239e926372`. Render deploys git commits; therefore, **Render production service does not contain this remediation**. It is impossible for production to be verified until these changes are reviewed, committed, pushed, and deployed.
3. **Dependent-Device Status Integration (`BLOCKED_UPSTREAM`):**  
   `computeDependentDeviceStatus` is implemented and verified by 19 regression tests in `tests/regression/sensor_status_semantics.test.ts`. However, **no production runtime caller invokes it**. CST cannot wire this function into runtime flows without synthetic or invented dependency graphs; upstream vFarm has not yet delivered a device topology contract.
4. **Acceptance Loops and External Cards:**  
   All four loops (`80HM`, `X4EI`, `0SNO`, `NVLF`) remain strictly **`OPEN`**. All five external Codex/SUTS cards (Rows 483, 482, 471, 467, 451) remain **`EXTERNAL_UPDATE_PENDING`**.

---

## 2. Exact Source Files and Line References

### A. Authorization Core: `engine/src/adapters/vfarm/authorization.ts`
* **Lines 25–28:** Strict function signature accepting only `SpeakerIdentity`:
  ```typescript
  export function assertSpeakerFarmAccess(
    speaker: SpeakerIdentity,
    farmId: string,
  ): void
  ```
  `dynamicAllowedFarms` argument has been completely removed.
* **Lines 29–32:** Rejection of missing/empty target farm ID:
  ```typescript
  const target = (farmId || '').trim();
  if (!target) {
    throw new VfarmAuthorizationError('farm_id is required');
  }
  ```
* **Lines 34–37:** Strict validation of `person_id` (must be non-empty string):
  ```typescript
  const personId = typeof speaker?.person_id === 'string' ? speaker.person_id.trim() : '';
  if (!personId) {
    throw new VfarmAuthorizationError('Missing acting-user ID on protected farm request');
  }
  ```
* **Lines 40–45:** Defensive rejection of mismatched legacy identifiers:
  ```typescript
  if ((speaker as { speaker_id?: unknown })?.speaker_id !== undefined) {
    const rawSpeakerId = (speaker as { speaker_id?: unknown }).speaker_id;
    if (typeof rawSpeakerId === 'string' && rawSpeakerId.trim() !== personId) {
      throw new VfarmAuthorizationError('Conflicting speaker identity identifiers: person_id and speaker_id mismatch');
    }
  }
  ```
* **Lines 48–50:** Mandatory authentication requirement before role evaluation:
  ```typescript
  if (!speaker?.is_known) {
    throw new VfarmAuthorizationError('Speaker is not authorized for farm access: unauthenticated identity');
  }
  ```
* **Lines 52–54:** Authenticated role evaluation:
  ```typescript
  const role = speaker?.role as string | undefined;
  const isSuperOrAdmin = role === 'admin' || role === 'superadmin';
  ```
* **Lines 55–60:** Explicit farm grant containment (ordinary users must have farm in `speaker.farm_ids`):
  ```typescript
  const granted = speaker.farm_ids ?? [];
  if (!isSuperOrAdmin && !granted.includes(target)) {
    throw new VfarmAuthorizationError(
      `Speaker is not authorized for farm ${target}; granted farms: [${granted.join(', ')}]`,
    );
  }
  ```

### B. Production Callers: `engine/src/adapters/vfarm/index.ts`
All 7 production callers invoke `assertSpeakerFarmAccess(params.speaker, params.farmId)` with zero dynamic scope widening:
1. **Line 507 (`listFarmDevices`):** `assertSpeakerFarmAccess(params.speaker, params.farmId);`
2. **Line 549 (`getFarmStatusForSpeaker`):** `assertSpeakerFarmAccess(params.speaker, params.farmId);`
3. **Line 619 (`getFleetStatusCounts`):** `assertSpeakerFarmAccess(params.speaker, params.farmId);`
4. **Line 674 (`getFarmAlertsForSpeaker`):** `assertSpeakerFarmAccess(params.speaker, params.farmId);`
5. **Line 697 (`getLatestDeviceReading`):** `assertSpeakerFarmAccess(params.speaker, params.farmId);`
6. **Line 748 (`getDeviceFleetStatus`):** `assertSpeakerFarmAccess(params.speaker, params.farmId);`
7. **Line 807 (`listLatestReadings`):** `assertSpeakerFarmAccess(params.speaker, params.farmId);`
*(Note: `getDiscoveredFarmIds()` remains on line 851 for informational/logging purposes only and is never passed to authorization).*

### C. Test Suites:
* `tests/health/health_contract.test.ts`:
  * **Lines 139, 164:** Test doubles conform to `person_id: 'speaker-1'`.
  * **Lines 174–330:** Dedicated 10-point regression suite asserting strict boundaries.
* `tests/identity/farm_scope_fail_closed.test.ts`:
  * **Line 190:** Conforms to 2-argument signature `assertSpeakerFarmAccess(speaker, 'farm_austin_main')`.

---

## 3. Request-to-Authorization Call-Flow Trace

Trace from ingress request to outbound vFarm authorization:

```
[ Ingress: Voice / SMS / Web ]
           │
           ▼
[ CoreRegistry.resolveSpeaker ] (engine/src/core/registry.ts:546)
  • Extracts clean phone number from carrier metadata (Twilio/LiveKit SIP)
  • If cache miss, delegates to VfarmTenantAdapter.resolveSpeaker
           │
           ▼
[ VfarmTenantAdapter.resolveSpeaker ] (engine/src/adapters/vfarm/index.ts:1336)
  • Case 1 (Service Key configured): Calls `liveClient.resolveUserByPhone(phone)`
    - Extracts authoritative `user_id` -> maps to `person_id`.
    - Maps vFarm organization role via `mapVfarmOrgRoleToCstRole(role)` -> `role`.
    - Queries authoritative farm grants -> `farm_ids: string[]`.
    - Returns `SpeakerIdentity` with `is_known: true`.
  • Case 2 (No Service Key / Legacy): Queries upstream `/api/v1/organizations/{id}/members`
    - Validates project org ID. If missing, fails closed with `opaque_revoked` (`is_known: false`).
  • Error / Timeout / Unmapped:
    - Calls `this.unknownIdentity(...)` returning `is_known: false, role: 'unknown', farm_ids: []`.
           │
           ▼
[ CoreEngine / Tool Execution ] (engine/src/connectors/vfarm.ts)
  • Caller invokes tool (e.g. `getFarmStatusForSpeaker`, `listFarmDevices`)
           │
           ▼
[ Local Circuit Breaker ] (assertSpeakerFarmAccess, authorization.ts:25)
  1. Validates `target` farm ID.
  2. Validates non-empty `person_id`.
  3. Fails closed if `speaker.speaker_id` mismatches `person_id`.
  4. Fails closed (403) if `speaker.is_known === false` (rejects unauthenticated admin claims).
  5. If authenticated, allows admin/superadmin bypass; otherwise asserts `target` is in `speaker.farm_ids`.
           │
           ▼ (Passes)
[ Outbound HTTP Call to vFarm ] (engine/src/adapters/vfarm/http_client.ts)
  • Attaches headers:
    `Authorization: Bearer <admin_or_service_jwt>`
    `x-on-behalf-of: speaker.person_id`
  • If upstream returns 401 or 403:
    - Throws `VfarmApiError('auth', 'vFarm authentication/authorization failed', status)`.
    - Propagates error directly. Zero fallback to alternate identities or broader farm scopes.
```

### Can an HTTP request influence `role` or `person_id`?
* **Voice / SMS:** No. The phone number is extracted from authenticated carrier envelopes. Identity attributes (`person_id`, `role`, `farm_ids`) are retrieved exclusively from upstream vFarm or the tenant directory.
* **Web:** In production (`process.env.NODE_ENV === 'production'`), sessions require email/password authentication against vFarm `/api/v1/auth/login` or CST Admin DB (`admin_users`). Arbitrary client parameters cannot forge `SpeakerIdentity`. In non-production development (`NODE_ENV !== 'production' || isTestRunner()`), dev bypasses exist for testing (`DEV_USERS`).

---

## 4. Test-to-Assertion Evidence Matrix

The 10-file test suite executes **134 tests (100% passing)**. The specific security behaviors are proven by the following exact assertions:

| Security Requirement | Test File & Line | Exact Verifying Assertion |
| :--- | :--- | :--- |
| **1. Explicit grant succeeds** | `tests/health/health_contract.test.ts:183` | `expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-alpha')).not.toThrow();` |
| **2. Discovered but ungranted farm rejected** | `tests/health/health_contract.test.ts:195-196` | `expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-beta')).toThrow(VfarmAuthorizationError);`<br>`expect(...).toThrow(/not authorized for farm farm-beta/);` |
| **3. Empty farm grants reject** | `tests/health/health_contract.test.ts:207-208` | `expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-alpha')).toThrow(VfarmAuthorizationError);`<br>`expect(...).toThrow(/granted farms: \[\]/);` |
| **4. Empty/whitespace farm ID rejects** | `tests/health/health_contract.test.ts:219-220` | `expect(() => assertSpeakerFarmAccess(speaker as any, '')).toThrow('farm_id is required');`<br>`expect(() => assertSpeakerFarmAccess(speaker as any, '   ')).toThrow('farm_id is required');` |
| **5. Missing/blank `person_id` rejects** | `tests/health/health_contract.test.ts:230, 238` | `expect(() => assertSpeakerFarmAccess(speakerNoPerson as any, 'farm-alpha')).toThrow(/Missing acting-user ID/);`<br>`expect(() => assertSpeakerFarmAccess(speakerWhitespace as any, 'farm-alpha')).toThrow(/Missing acting-user ID/);` |
| **6. Conflicting identifiers reject** | `tests/health/health_contract.test.ts:250-251` | `expect(() => assertSpeakerFarmAccess(conflictingSpeaker as any, 'farm-alpha')).toThrow(VfarmAuthorizationError);`<br>`expect(...).toThrow(/Conflicting speaker identity/);` |
| **7. `is_known: false` rejects** | `tests/health/health_contract.test.ts:262-263` | `expect(() => assertSpeakerFarmAccess(unknownSpeaker as any, 'farm-alpha')).toThrow(VfarmAuthorizationError);`<br>`expect(...).toThrow(/unauthenticated identity/);` |
| **8. Cross-tenant access rejected** | `tests/health/health_contract.test.ts:275-276` | `expect(() => assertSpeakerFarmAccess(tenantASpeaker as any, 'farm-tenant-b')).toThrow(VfarmAuthorizationError);`<br>`expect(...).toThrow(/not authorized for farm farm-tenant-b/);` |
| **9. Admin bypass requires `is_known: true`** | `tests/health/health_contract.test.ts:289-308` | `expect(() => assertSpeakerFarmAccess(unauthAdmin as any, 'farm-any')).toThrow(/unauthenticated identity/);`<br>`expect(() => assertSpeakerFarmAccess(authAdmin as any, 'farm-unlisted')).not.toThrow();` |
| **10. Upstream error propagated without fallback** | `tests/health/health_contract.test.ts:327-328` | `await expect(adapter.getFarmStatusForSpeaker({ farmId: 'farm-restricted', speaker: speakerWithNoAccess })).rejects.toThrow(VfarmAuthorizationError);` |
| **Fail-closed tenant boundary containment** | `tests/identity/farm_scope_fail_closed.test.ts:190` | `expect(() => assertSpeakerFarmAccess(speaker, 'farm_austin_main')).toThrow();` |

---

## 5. Dependent-Device Helper Contract

### Contract Definition (`engine/src/connectors/vfarm.ts:58-66`)
```typescript
export function computeDependentDeviceStatus(
  sensorStates?: (SensorState | string | null | undefined)[] | null,
): DependentDeviceStatus {
  if (!Array.isArray(sensorStates) || sensorStates.length === 0) {
    return 'DEGRADED';
  }
  const allOnline = sensorStates.every((s) => s === 'online');
  return allOnline ? 'NORMAL' : 'DEGRADED';
}
```

### Hierarchy & Precedence Rules:
1. **Empty / Null / Undefined Input:** Evaluates to `'DEGRADED'`. Never defaults to `'NORMAL'`.
2. **Missing / Stale / Timed-out / Unknown Sensor:** If any element in `sensorStates` is not `'online'`, the dependent device evaluates to `'DEGRADED'`.
3. **Recovery:** Restores to `'NORMAL'` if and only if every dependent sensor transitions to `'online'`.
4. **Distinct from Relay State:** Differentiates between physical device health and relay power (`off` is not `offline`).

### Runtime Wiring Status: `BLOCKED_UPSTREAM`
* **Inspection Result:** There are **zero runtime callers** of `computeDependentDeviceStatus` in `engine/src/`.
* **Root Cause:** vFarm's upstream OpenAPI specification does not expose device dependency graphs or parent/child topology data (e.g., mapping relays or nutrient pumps to specific soil/pH sensors).
* **Policy Compliance:** CST has deliberately not invented synthetic sensor relationships. Runtime wiring remains blocked until the upstream vFarm topology contract is published.

---

## 6. Verification Status Matrix

| Environment | Scope | Status | Notes |
| :--- | :--- | :--- | :--- |
| **Local Working Tree** | Typecheck (`tsc --noEmit`) | `LOCAL_TYPECHECK_VERIFIED` | Clean compile, 0 errors |
| **Local Test Runner** | 10 Test Files (134 tests) | `LOCAL_TESTS_VERIFIED` | 134 passed, 0 failed (duration: 633ms) |
| **Git & CI** | Remote tracking branch | `CI_NOT_VERIFIED` | Changes are uncommitted in local workspace |
| **Render Deployed Service** | Service `bha-cst` | `PRODUCTION_REMEDIATION_NOT_VERIFIED` | Production runs commit `4f82b74`, which predates these uncommitted changes |
| **Production Live Execution** | Real-world API probing | `PRODUCTION_TEST_EXECUTION_NOT_PERFORMED` | Prohibited without customer authorization |

---

## 7. Four-Loop Status Reconciliation

| Loop ID | Title | System State | Verification Authority | Reason for Retaining OPEN Status |
| :--- | :--- | :--- | :--- | :--- |
| **80HM** | Sensor Reading Health Semantics | `OPEN` | `BLOCKED_UPSTREAM` | Implementation complete in `vfarm.ts` (19 tests pass), but runtime caller blocked waiting for vFarm topology schema. |
| **X4EI** | Authoritative Device Authorization | `OPEN` | `AWAITING_OWNER_ACCEPTANCE` | Local remediation verified (10 tests pass), but code is uncommitted and not deployed to production. |
| **0SNO** | Gateway Fail-Closed Isolation | `OPEN` | `AWAITING_OWNER_ACCEPTANCE` | Local containment proven; live cross-tenant upstream simulation not executed. |
| **NVLF** | Postgres Call Lifecycle Reconnect | `OPEN` | `LIVE_READBACK_NOT_VERIFIED` | Migrations deployed on Render; readback pending authenticated session token. |

### External Cards Status:
All five cards remain **`EXTERNAL_UPDATE_PENDING`**:
* Row 483 (X6DK): `docs/evidence/2026-11-11-x6dk-row-483-resubmission-draft.md`
* Row 482 (DMVQ): `docs/evidence/2026-11-11-dmvq-row-482-resubmission-draft.md`
* Row 471 (XKWD): `docs/evidence/2026-11-13-xkwd-row-471-resubmission-evidence.md`
* Row 467 (K9VT): `docs/evidence/2026-11-11-k9vt-row-467-resubmission-draft.md`
* Row 451 (V9KP): `docs/evidence/2026-11-11-row-451-resubmission-draft.md`

---

## 8. Remaining Security Risks & Smallest Next Actions

1. **Uncommitted Working-Tree Vulnerability:**  
   * *Risk:* The code running in production does not include these authorization fixes.  
   * *Action:* Owner must approve creating a clean commit on `feat/iwkx-postgres-lifecycle-acceptance` and deploying to Render.
2. **Upstream Role Trust Invariant:**  
   * *Risk:* CST trusts the role string returned by vFarm's service key lookup. If vFarm upstream has an authentication bypass, CST would inherit it.  
   * *Action:* Add signature verification or mutual TLS on service-key assertions when supported upstream.
3. **Upstream Device Topology Gap:**  
   * *Risk:* Lack of topology prevents dependent-device health computations from running in real time.  
   * *Action:* vFarm team must provide the schema for device dependency mapping before Loop 80HM can be closed.

---

## 9. Before-and-After Git Status, Branch, and HEAD

### Git Metadata:
* **Branch:** `feat/iwkx-postgres-lifecycle-acceptance`
* **HEAD SHA:** `4f82b742e72bd9972f7ae7e9de216e239e926372`

### Working Tree Preservation:
All pre-existing working-tree modifications (45+ files including `.env.example`, `engine/src/adapters/vfarm/live_client.ts`, and visual artifacts in `docs/evidence/browser/`) were strictly preserved. No files were reset, stashed, committed, or deleted.

---

## 10. Exact Files Changed by This Audit

* `docs/evidence/2026-11-20-cst-independent-authorization-remediation-audit.md` (this report created).
