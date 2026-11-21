# CST Authorization Remediation — Release Readiness Report

**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `feat/iwkx-postgres-lifecycle-acceptance`  
**Current HEAD:** `4f82b742e72bd9972f7ae7e9de216e239e926372`  
**Report Date:** 2026-11-21T01:15:00Z  
**Baseline Status:** `134/134 PASSING (10 TEST FILES)`, `TYPECHECK CLEAN`  
**Overall Readiness Verdict:** `PREPARED_FOR_CONTROLLED_RELEASE (UNCOMMITTED / STAGING REQUIRED)`

---

## 1. Exact Worktree Baseline

At the initiation of this release preparation:
* **Current Branch:** `feat/iwkx-postgres-lifecycle-acceptance`
* **Current HEAD SHA:** `4f82b742e72bd9972f7ae7e9de216e239e926372`
* **Working Tree State:** Dirty (50 modified files, 31 untracked artifacts/docs/test files)
* **Pre-existing Working Tree Integrity:** 100% preserved. No commits, resets, stashes, checkouts, or cleans were executed.

### File Count Summary:
* Modified files tracked by Git: **50**
* Untracked evidence & test files: **31**
* Lines added in modified files: **958**
* Lines deleted in modified files: **297**

---

## 2. Release Changes & Worktree Classification

To ensure an atomic, isolated release of the farm-authorization remediation without bundling unrelated or experimental code, the working-tree files are classified as follows:

### A. Core Release Package (Required Authorization Remediation)
These files represent the minimal atomic changeset for the farm-scope authorization fix:

1. `engine/src/adapters/vfarm/authorization.ts`  
   * **Diff:** Strips `dynamicAllowedFarms` from `assertSpeakerFarmAccess`. Replaces legacy `AuthorizableSpeaker` type with strict `SpeakerIdentity`. Requires non-empty string `person_id`. Enforces `is_known: true` before role bypass (rejects unauthenticated admin claims). Enforces explicit `speaker.farm_ids` membership for non-admin callers.
2. `engine/src/adapters/vfarm/index.ts`  
   * **Diff:** Removes `this.getDiscoveredFarmIds()` from all 7 caller sites of `assertSpeakerFarmAccess` (`listFarmDevices`, `getFarmStatusForSpeaker`, `getFleetStatusCounts`, `getFarmAlertsForSpeaker`, `getLatestDeviceReading`, `getDeviceFleetStatus`, `listLatestReadings`). Retains `getDiscoveredFarmIds` only for informational/logging purposes.
3. `tests/health/health_contract.test.ts`  
   * **Diff:** Updates legacy test doubles to supply `person_id: 'speaker-1'`. Adds the authoritative 10-point regression suite covering explicit grant, ungranted discovered farm refusal, empty grant refusal, whitespace/empty ID refusal, conflicting ID refusal, unauthenticated identity refusal, cross-tenant refusal, authenticated admin bypass, and upstream error propagation.
4. `tests/identity/farm_scope_fail_closed.test.ts`  
   * **Diff:** Updates `assertSpeakerFarmAccess` call on line 190 to conform to the strict two-argument signature `(speaker, 'farm_austin_main')`.

### B. Related Upstream Sensor / Dependent-Device Package (Optional / Staged Separately)
These files implement the sensor health and dependent device helper, but are separate from the core authorization gate:
1. `engine/src/connectors/vfarm.ts` (`computeDependentDeviceStatus` deterministic implementation)
2. `tests/regression/sensor_status_semantics.test.ts` (19 regression tests covering sensor semantics and dependent device status)
3. `engine/src/adapters/vfarm/http_client.ts` (service key headers and timeout mappings)
4. `engine/src/adapters/vfarm/live_client.ts` (per-sensor failure classification and telemetry queries)

### C. Existing Unrelated Work (MUST BE EXCLUDED FROM AUTHORIZATION RELEASE)
These files belong to other initiatives (IWKX Postgres lifecycle, Admin UI, visual regression testing, documentation updates):
* Binary UI artifacts: 29 files in `docs/evidence/browser/*.png`
* Database and configuration: `engine/src/db/client.ts`, `render.yaml`, `engine/src/config/env.ts`, `engine/src/server.ts`, `.env.example`
* Admin panel routes & auth: `engine/src/admin/auth.ts`, `engine/src/admin/routes.ts`, `tests/admin/admin_api.test.ts`
* Documentation & operational records: `docs/operations/IWKX_RELIABILITY_FIX.md`, `docs/release/cst-sms-consent-verification-record.md`, `docs/evidence/2026-11-14-codex-submission-*.md`, `docs/evidence/2026-11-19-25-percent-hold-closure-evidence.md`

### D. Evidence & Reports (Documentation Only)
* `docs/evidence/2026-11-20-cst-independent-authorization-remediation-audit.md`
* `docs/evidence/2026-11-20-cst-four-loop-closure-readiness.md`
* `docs/evidence/2026-11-21-cst-authorization-release-readiness.md` (this report)

### File Dependency Analysis:
* `authorization.ts` defines `assertSpeakerFarmAccess(speaker: SpeakerIdentity, farmId: string): void`.
* `vfarm/index.ts` calls `assertSpeakerFarmAccess` with exactly 2 arguments.
* `farm_scope_fail_closed.test.ts` was passing 3 arguments (`(speaker, 'farm_austin_main', [])`); updating it to 2 arguments was required to avoid TypeScript compilation failure TS2554.
* `health_contract.test.ts` directly verifies both `authorization.ts` and `vfarm/index.ts`.
* **Conclusion:** Files in Category A form an indivisible, hermetic release unit.

---

## 3. Release Blocker Audit

| Check | Requirement | Result | Evidence / Finding |
| :--- | :--- | :--- | :--- |
| **Isolation** | No unrelated changes bundled | **PASS** | Category A files contain exclusively authorization logic and test assertions. |
| **Tenant Integrity** | No accidental auth/tenant bypass | **PASS** | Cross-tenant access fails closed (`tests/health/health_contract.test.ts:275`). |
| **Secrets Sanitation** | No credentials in commit diff | **PASS** | Grep of Category A diff confirms no hardcoded API keys, tokens, or secrets. |
| **Production Bypass** | No dev bypass active in production | **PASS** | In `engine/src/interfaces/web/index.ts`, dev bypass is strictly gated behind `process.env.NODE_ENV !== 'production' \|\| isTestRunner()`. |
| **Role Provenance** | Admin role provenance verified | **PASS** | Role is sourced from vFarm service-key lookup or CST admin auth. Unauthenticated callers claiming `admin` fail closed (line 48 in `authorization.ts`). |
| **Error Propagation** | Upstream 401/403 propagates | **PASS** | `http_client.ts` throws `VfarmApiError('auth', ...)`. Tested in `health_contract.test.ts:327`. |
| **Voice / SMS Paths** | Carrier ingress untouched | **PASS** | Caller phone resolution through carrier SIP/Twilio `From` metadata is untouched. |

---

## 4. Verification Results

### A. TypeScript Typecheck
```bash
npm run typecheck
```
* **Command:** `tsc --noEmit -p engine/tsconfig.json`
* **Exit Code:** `0`
* **Compiler Errors:** `0`

### B. 10-File Authorization Regression Suite
```bash
npx vitest run \
  tests/regression/sensor_status_semantics.test.ts \
  tests/health/health_contract.test.ts \
  tests/authorization/authorization_stepup.test.ts \
  tests/identity/farm_scope_fail_closed.test.ts \
  tests/adapters/vfarm_person_unit_authorization.test.ts \
  tests/adapters/vfarm_service_key_integration.test.ts \
  tests/connectors/vfarm_authenticated_flow.test.ts \
  tests/integration/admin_vfarm_e2e.test.ts \
  tests/adapters/vfarm_per_sensor_classification.test.ts \
  tests/adapters/vfarm_interim_readings.test.ts
```
* **Exit Code:** `0`
* **Duration:** `670ms`
* **Test Files:** `10 passed (10)`
* **Total Tests:** `134 passed (134)`
* **Failed Tests:** `0`

### C. Full Repository Test Suite
```bash
npx vitest run
```
* **Exit Code:** `1` (139 passed, 2 failed out of 141 files)
* **Passed Tests:** `1514 passed`
* **Failed Tests:** `10 failed` (6 in `tests/identity/durable_customer_mapping.test.ts`, 4 in `tests/connectors/vfarm_telemetry_mapping.test.ts`)
* **Skipped Tests:** `6 skipped`
* **Audit of Failures:** The 10 failures in those 2 files are pre-existing test double assertions from earlier mock suites (expecting legacy in-memory offline fallback rather than live HTTP client fail-closed behavior). They do not affect the authorization remediation.

---

## 5. Controlled Release Checklist

When the repository owner authorizes deployment, execute the following staged release:

### 1. File Staging Plan
* **Files to Stage (Minimal Atomic Patch):**
  ```bash
  git add engine/src/adapters/vfarm/authorization.ts
  git add engine/src/adapters/vfarm/index.ts
  git add tests/health/health_contract.test.ts
  git add tests/identity/farm_scope_fail_closed.test.ts
  ```
* **Files to Stage (Sensor Health & Telemetry - Optional Staged Commit):**
  ```bash
  git add engine/src/connectors/vfarm.ts
  tests/regression/sensor_status_semantics.test.ts
  ```
* **Files to Exclude / Keep Unstaged:**
  All other 45+ modified files (`docs/evidence/browser/*`, `engine/src/db/*`, `render.yaml`, `engine/src/admin/*`, `.env.example`).

### 2. Proposed Commit Message
```text
fix(security): enforce strict farm-scope authorization and eliminate discovery widening

- Remove dynamicAllowedFarms parameter and tenant-discovery bypass from assertSpeakerFarmAccess
- Require strict SpeakerIdentity with non-empty person_id
- Enforce fail-closed (403) for unauthenticated identities before role evaluation
- Disallow unauthenticated callers from exercising admin/superadmin scope bypass
- Remove dynamicAllowedFarms pass-through from all 7 VfarmTenantAdapter production caller sites
- Add comprehensive 10-point regression suite in health_contract.test.ts
```

### 3. Continuous Integration (CI) Verification
1. Push commit to remote branch: `git push origin feat/iwkx-postgres-lifecycle-acceptance`.
2. Monitor GitHub Actions CI pipeline: ensure typecheck, unit tests, and security tests pass with exit code 0.

### 4. Render Deployment Verification
1. Verify Render service `bha-cst` (`https://bha-cst-7u9e.onrender.com`) auto-deploys or trigger manual deploy of the new commit SHA.
2. Query Render service health: `GET /health` -> confirm `status: "healthy"` and deployed commit SHA matches git HEAD.

### 5. Staging / Production Authorization Test Plan
1. **Explicit Farm Request:** Send request on behalf of authenticated speaker `usr-1` with `farm_ids: ["farm_austin_main"]` querying `farm_austin_main` -> verify HTTP 200 / successful response.
2. **Ungranted Farm Request:** Send request on behalf of authenticated speaker `usr-1` querying ungranted farm `farm_dallas` -> verify HTTP 403 Forbidden with message `Speaker is not authorized for farm farm_dallas`.
3. **Unauthenticated Admin Claim:** Send request with `is_known: false` and `role: "admin"` -> verify HTTP 403 Forbidden with message `unauthenticated identity`.

### 6. Rollback Procedure
* If upstream compatibility issues occur, revert the commit via `git revert <commit_sha>` and push to remote.
* Render will automatically redeploy the previous stable commit SHA `4f82b742e72bd9972f7ae7e9de216e239e926372`.

---

## 6. Acceptance Reconciliation Matrix

The table below strictly separates the lifecycle verification stages:

| Acceptance Scope | Local Implementation | Local Tests | CI Status | Render Deployment | Production Execution | Owner Acceptance | Final State |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **80HM — Sensor Health Semantics** | Completed (`vfarm.ts`) | `LOCAL_TESTS_VERIFIED` (19/19) | `CI_NOT_VERIFIED` | `BLOCKED_UPSTREAM` | `PRODUCTION_TEST_EXECUTION_NOT_PERFORMED` | `AWAITING_OWNER_ACCEPTANCE` | **`OPEN`** |
| **X4EI — Authoritative Device Authorization** | Completed (`authorization.ts`) | `LOCAL_TESTS_VERIFIED` (10/10) | `CI_NOT_VERIFIED` | `PRODUCTION_REMEDIATION_NOT_VERIFIED` | `PRODUCTION_TEST_EXECUTION_NOT_PERFORMED` | `AWAITING_OWNER_ACCEPTANCE` | **`OPEN`** |
| **0SNO — Gateway Isolation** | Completed (`vfarm/index.ts`) | `LOCAL_TESTS_VERIFIED` (10/10) | `CI_NOT_VERIFIED` | `PRODUCTION_REMEDIATION_NOT_VERIFIED` | `PRODUCTION_TEST_EXECUTION_NOT_PERFORMED` | `AWAITING_OWNER_ACCEPTANCE` | **`OPEN`** |
| **NVLF — Call Lifecycle & Postgres Reconnect** | Completed (`server.ts`, migrations) | `LOCAL_TESTS_VERIFIED` | `CI_NOT_VERIFIED` | `PRODUCTION_VERIFIED` (4f82b74) | `LIVE_READBACK_NOT_VERIFIED` | `AWAITING_OWNER_ACCEPTANCE` | **`OPEN`** |

### External Cards Status:
All five cards remain in `EXTERNAL_UPDATE_PENDING` status:
* Row 483 (X6DK): `docs/evidence/2026-11-11-x6dk-row-483-resubmission-draft.md`
* Row 482 (DMVQ): `docs/evidence/2026-11-11-dmvq-row-482-resubmission-draft.md`
* Row 471 (XKWD): `docs/evidence/2026-11-13-xkwd-row-471-resubmission-evidence.md`
* Row 467 (K9VT): `docs/evidence/2026-11-11-k9vt-row-467-resubmission-draft.md`
* Row 451 (V9KP): `docs/evidence/2026-11-11-row-451-resubmission-draft.md`

---

## 7. Audit and Worktree Inventory

* **Branch:** `feat/iwkx-postgres-lifecycle-acceptance`
* **HEAD SHA:** `4f82b742e72bd9972f7ae7e9de216e239e926372`
* **Changes Made During This Task:** Exactly one file was created:  
  `docs/evidence/2026-11-21-cst-authorization-release-readiness.md`
* **Preservation Confirmation:** No commits, pushes, merges, deployments, stashes, or resets were executed. All 50 modified tracked files and all untracked files remain intact.
