# CST — Production Release Report: Isolated Authorization Remediation

**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `feat/iwkx-postgres-lifecycle-acceptance`  
**Expected Base HEAD:** `4f82b742e72bd9972f7ae7e9de216e239e926372`  
**Current Base HEAD:** `4f82b742e72bd9972f7ae7e9de216e239e926372`  
**Render Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`)  
**Production URL:** `https://bha-cst-7u9e.onrender.com`  
**Current Live Production SHA:** `19a13ceb75e75fbd78ac89b91aa79836fe385af8`  
**Render Service Tracked Branch:** `main` (autoDeploy: commit)  
**Execution Timestamp:** 2026-11-21T01:30:00Z  
**Final Release Status:** `RELEASE_BLOCKED`  

---

## 1. Executive Summary & Gate Decision

In accordance with Section 1 of the release specification:
> *"Inspect the complete diff for the four approved files... Confirm that only intended authorization changes are included. No unrelated telemetry, service-key, customer-mapping, admin UI, configuration, or documentation changes enter the release... **If the four-file diff contains unrelated changes, stop and report them. Do not discard or overwrite anything.**"*

### Decision: `RELEASE_BLOCKED`
The pre-release inspection revealed that **`engine/src/adapters/vfarm/index.ts` is contaminated with unrelated changes**:
1. **Unrelated Service-Key Wiring (Lines 33, 174, 186, 1355–1418):** Adds `serviceKey?: string` to `VfarmAdapterConfig` and implements an unreleased `resolveUserByPhone` call path against upstream vFarm.
2. **Unrelated Telemetry Forwarding (Lines 512, 552, 623, 678, 700, 752, 815):** Adds `onBehalfOf = params.speaker?.person_id` as an additional argument to six live client methods (`listAllDevices`, `getFarmHealth`, `listOpenAlerts`, `getLatestReading`, `getDeviceFleetStatus`, `listLatestReadings`).
3. **Verified Blast Radius:** As proven by baseline worktree tests, these exact modifications in `index.ts` break 4 test assertions in `tests/connectors/vfarm_telemetry_mapping.test.ts` (argument count mismatches on test spies) and 6 test assertions in `tests/identity/durable_customer_mapping.test.ts` (attempting live service-key queries with a local dummy key).
4. **Render Tracked Branch Conflict:** Render service `bha-cst` is configured to auto-deploy from branch **`main`**, not `feat/iwkx-postgres-lifecycle-acceptance`. Pushing a feature branch commit directly to production without a clean merge to `main` bypasses standard release tracking.

Therefore, under the mandatory safety restriction, the release is stopped before staging, committing, pushing, or deploying, and the safest release path is presented below.

---

## 2. Mandatory Pre-Release Git & Deployment Inspection

### A. Current Git State
* **Current Branch:** `feat/iwkx-postgres-lifecycle-acceptance`
* **Current HEAD:** `4f82b742e72bd9972f7ae7e9de216e239e926372`
* **Base Match:** Confirmed matching expected base `4f82b742e72bd9972f7ae7e9de216e239e926372`.
* **Tracked Modified Files:** 50 files (958 insertions, 297 deletions).
* **Untracked Files:** 33 files.
* **Preservation Status:** 100% preserved. No files were discarded, reset, cleaned, or stashed.

### B. Render Production State (`srv-db8hepqvcj2c73adpus0`)
* **Service Name:** `bha-cst`
* **Production URL:** `https://bha-cst-7u9e.onrender.com`
* **Health Check Endpoint (`/health`):** HTTP 200 `{"status":"ok","service":"bha-cst-engine"}`
* **Currently Deployed Commit SHA:** `19a13ceb75e75fbd78ac89b91aa79836fe385af8`
* **Current Deploy ID:** `dep-dc095g7lk1mc73f0ir90` (Triggered: 2026-11-20T18:34:40Z, Status: `Live`)
* **Deploy Commit Message:** `Merge pull request #64 from bhanetworkgh/feat/iwkx-postgres-lifecycle-acceptance \n\n fix(iwkx): persist escalation acknowledgement lifecycle`
* **Tracked Branch on Render:** `main` (autoDeploy: commit)
* **Recent Deployment History:**
  * `dep-dc095g7lk1mc73f0ir90` — `19a13ceb75e75fbd78ac89b91aa79836fe385af8` (`Live`)
  * `dep-dc08jfon74is73a5vs4g` — `1ca28d2489a816b693024a649ae951c4c3c73eea` (`Inactive`)
  * `dep-dbvm1m6q1p3s738u3hfg` — `1ca28d2489a816b693024a649ae951c4c3c73eea` (`Inactive`)
  * `dep-dbvles0jo6nc73a7p5ag` — `4f2f40906fc2b0e3a2da47ece07e2e16441a4fc2` (`Inactive`)
  * `dep-dbvf6f142hec73be9gig` — `af5b7a321b5acd78ec54712e8c152af89563d52a` (`Inactive`)

---

## 3. Four-File Diff Inspection & Contamination Audit

The complete diff across the four candidate files was inspected:

| File Path | Total Diff Lines | Intended Authorization Remediation | Unrelated / Contaminated Changes |
| :--- | :--- | :--- | :--- |
| `engine/src/adapters/vfarm/authorization.ts` | 36 lines | **Clean.** Strips `dynamicAllowedFarms`, enforces strict `SpeakerIdentity`, requires `person_id`, rejects mismatched `speaker_id`, requires `is_known: true` before role check, asserts explicit `speaker.farm_ids`. | None. |
| `tests/health/health_contract.test.ts` | 162 lines | **Clean.** Updates test doubles to `person_id`. Adds comprehensive 10-point regression suite. | None. |
| `tests/identity/farm_scope_fail_closed.test.ts` | 2 lines | **Clean.** Aligns line 190 to 2-argument signature `assertSpeakerFarmAccess(speaker, 'farm_austin_main')`. | None. |
| `engine/src/adapters/vfarm/index.ts` | 112 lines | **Contaminated.** Removes `this.getDiscoveredFarmIds()` from 7 caller sites (Lines 507, 549, 619, 674, 697, 748, 807). | **Contaminated with:**<br>1. `serviceKey` handling (Lines 33, 174, 186, 1355–1418).<br>2. `onBehalfOf` telemetry forwarding across 6 methods (Lines 512, 552, 623, 678, 700, 752, 815).<br>3. `getUserFarmGrants` duplicate arg (Line 1533). |

### Detailed Breakdown of Unrelated Changes in `engine/src/adapters/vfarm/index.ts`:
1. **Lines 30–33:**
   ```typescript
   export interface VfarmAdapterConfig {
     baseUrl?: string;
     apiKey?: string;
   + serviceKey?: string;
   ```
2. **Lines 170–189:**
   ```typescript
   return new VfarmHttpClient({
     baseUrl: config.baseUrl,
     apiKey: config.apiKey,
   + serviceKey: config.serviceKey,
   ```
3. **Lines 512, 552, 623, 678, 700, 752, 815:**
   ```typescript
   + const onBehalfOf = params.speaker?.person_id;
   - const res = await this.liveClient.listAllDevices(params.farmId);
   + const res = await this.liveClient.listAllDevices(params.farmId, onBehalfOf);
   ```
4. **Lines 1355–1418:**
   ```typescript
   + if (this.liveClient?.hasServiceKey()) {
   +   serviceKeyAttempted = true;
   +   try {
   +     resolvedByServiceKey = await this.liveClient.resolveUserByPhone(cleanPhone);
   ```

---

## 4. Test Gate Execution & Verification Results

### A. Targeted Authorization Suite (10 Files, 134 Tests)
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
* **Failures:** `0`

### B. TypeScript Compilation Gate
```bash
npm run typecheck
```
* **Command:** `tsc --noEmit -p engine/tsconfig.json`
* **Exit Code:** `0`
* **Compiler Errors:** `0`

### C. Production Build Gate
```bash
npm run build
```
* **Command:** `tsc -b engine/tsconfig.json && node scripts/copy_web_assets.js`
* **Exit Code:** `0`
* **Output:** `copy_web_assets: copied 8 entries to dist/web`

### D. Full-Suite Baseline Comparison & 10-Failure Explanation
* **Full Suite Execution (`npx vitest run`):** 139 passed, 2 failed out of 141 files (1514 passed, 10 failed, 6 skipped).
* **Baseline Proof (Clean commit `4f82b74`):** Passes 1520/1520 tests (32/32 in the two failing files).
* **Failure Explanation:**
  * 4 failures in `tests/connectors/vfarm_telemetry_mapping.test.ts` are caused by the uncommitted `onBehalfOf` argument additions in `index.ts:700, 821`.
  * 6 failures in `tests/identity/durable_customer_mapping.test.ts` are caused by uncommitted `serviceKey` wiring in `registry.ts` and `index.ts:1355` calling `resolveUserByPhone` with the local dummy key.
  * Staging `index.ts` as-is would carry these exact 10 failures into the release commit.

---

## 5. Security Invariants & Qualification Ledger

The authorization remediation satisfies the following core invariants:
1. **Explicit Farm Grants Only:** A non-admin speaker can access only farms in `speaker.farm_ids`.
2. **No Discovery-Based Grants:** Discovered farms do not grant authorization (`dynamicAllowedFarms` removed).
3. **Fail-Closed on Empty Grants:** Missing/empty `farm_ids` arrays throw `VfarmAuthorizationError` (HTTP 403).
4. **Input Sanitation:** Blank/whitespace `farm_id` and `person_id` throw HTTP 403 immediately.
5. **Conflict Rejection:** Conflicting `speaker_id` and `person_id` fail closed.
6. **Authentication Gate for Roles:** `is_known: true` is strictly required before `role === 'admin'` or `superadmin` bypass is granted.
7. **Seven Call Sites Protected:** All 7 methods in `VfarmTenantAdapter` invoke `assertSpeakerFarmAccess(params.speaker, params.farmId)`.

### Mandatory Release Qualifications:
1. **Upstream Role Authority Dependency:** CST trusts the role string returned by authenticated upstream vFarm identity resolution (`/api/v1/users/resolve`).
2. **Upstream 401/403 Propagation:** While upstream 401/403 classification and fail-closed handling have been empirically proven at the adapter layer (`http_client.ts` throwing `VfarmApiError('auth')`), a dedicated HTTP-mocked end-to-end 401/403 wire-level test remains unperformed.
3. **Dependent-Device Helper:** `computeDependentDeviceStatus` has no production runtime caller and remains blocked waiting for vFarm upstream to deliver device-dependency topology schemas.

---

## 6. Safest Release Path & Next Steps

Because `index.ts` in the working tree combines both authorization fixes and unrelated telemetry/service-key changes, the release cannot proceed atomically without isolating the patch:

### Recommended Execution Path:
1. **Prepare Isolated Hunk Patch:**  
   Extract strictly the 7 `assertSpeakerFarmAccess` call-site updates from `engine/src/adapters/vfarm/index.ts` (excluding `serviceKey` and `onBehalfOf`), combined with `authorization.ts`, `health_contract.test.ts`, and `farm_scope_fail_closed.test.ts`.
2. **Merge via Pull Request to `main`:**  
   Because Render service `bha-cst` tracks branch `main`, the clean commit should be submitted via Pull Request to `main` (using `ahadbhanetwork` profile).
3. **Render Deployment:**  
   Once merged to `main`, Render auto-deploy will deploy the commit cleanly to production without tracking conflicts.
4. **Post-Deploy Production Verification:**  
   Verify production `/health` and execute the 7 authorization smoke tests with authorized staging credentials.

---

## 7. Acceptance Loops & External Records

All acceptance states remain strictly preserved in their open status:
* **80HM:** `OPEN` (`BLOCKED_UPSTREAM` on vFarm device-dependency topology)
* **X4EI:** `OPEN` (`AWAITING_OWNER_ACCEPTANCE` on authorization staging release)
* **0SNO:** `OPEN` (`AWAITING_OWNER_ACCEPTANCE` on gateway isolation)
* **NVLF:** `OPEN` (`LIVE_READBACK_NOT_VERIFIED` on authenticated session token)
* **External Codex Cards:** `EXTERNAL_UPDATE_PENDING` (Rows 483, 482, 471, 467, 451)
