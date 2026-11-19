# LOOP-1793031575930-X4EI — KMG9 Authoritative BHARAG RAG Acceptance Evidence Report

**Document Date:** 2026-11-20
**Loop Identifier:** `LOOP-1793031575930-X4EI`
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`
**Decision Watch Reference:** `DW-1795036114694-RK8U`
**Upstream Dependency:** `LOOP-1791991972916-G718` (CST clone quality gate Step 2 depends on KMG9 Step 1 sign-off)
**Authorized Reviewer:** Jason
**Implementation Status:** `COMPLETED`
**Evidence Status:** `VERIFIED` (16/16 automated boundary & isolation tests passing)
**Owner Acceptance Status:** `READY_FOR_OWNER_ACCEPTANCE` (CST code boundaries verified); `EXTERNAL_CONFIRMATION_REQUIRED` (Upstream BHARAG re-indexing sign-off under `LOOP-1791991972916-G718`)

---

## 1. Executive Summary

`LOOP-1793031575930-X4EI` defines the security and data boundary between CST and BHARAG Retrieval-Augmented Generation (RAG). The engineering implementation enforcing strict tenant isolation, fail-closed query boundaries, and the elimination of unauthorized BHARAG fallbacks is **COMPLETED**.

Key architectural boundaries implemented:
1. **Zero Farm Telemetry from BHARAG:** CST never queries the BHARAG cluster for live farm status or telemetry. Farm status inquiries are routed exclusively to the authenticated vFarm connector.
2. **Strictly Scoped Query API Keys:** CST calls to BHARAG enforce the scoped `cst-help-read` API key, with query payloads restricted strictly to the allowlisted `cst-help-manuals` workspace.
3. **Fail-Closed Isolation Gate:** Callers without an active unit link or attempting cross-farm access receive safe refusals without querying BHARAG.
4. **Cross-Workspace Rejection:** Answers returning references outside `cst-help-manuals` without confident context are rejected with 0 hits returned.

All 6 acceptance criteria required by the KMG9 specification are verified across 16 automated tests in the CST test suite.

---

## 2. KMG9 Acceptance Suite Specification & Results

The KMG9 acceptance suite comprises Tests 1 through 5 (including Test 1b):

| Test ID | Scenario | Contract Requirement | Actual CST Behavior | Implementation Status | Evidence Status | Result |
|---|---|---|---|---|---|---|
| **Test 1** | Scoped Key Access | CST help key can access only `cst-help-manuals` | Request to query BHARAG passes `workspaceKey: "cst-help-manuals"`; cluster calls enforce scoped key | `COMPLETED` | `VERIFIED` | **PASS** |
| **Test 1b** | Citations & Confidence | Valid help queries return verified citation metadata and confidence scores | Returned answers parse `workspaces_queried`, `per_workspace_hits`, and confidence | `COMPLETED` | `VERIFIED` | **PASS** |
| **Test 2** | Farm Query Isolation | Farm-specific status questions cannot query BHARAG workspaces | `IntentRouter` routes status queries directly to vFarm live client; 0 BHARAG cluster calls made | `COMPLETED` | `VERIFIED` | **PASS** |
| **Test 3** | Protected Workspace Guard | General queries cannot access incident-ledger, Twin, or RSS workspaces | BHARAG responses referencing unauthorized workspaces are rejected with 0 hits returned | `COMPLETED` | `VERIFIED` | **PASS** |
| **Test 4** | Authorized vFarm Context | Authorized caller retrieves only permitted farm context | Caller with valid unit context retrieves live temperature/humidity without leaking other farms | `COMPLETED` | `VERIFIED` | **PASS** |
| **Test 5** | Unauthorized Farm Access Refusal | Caller attempting to read ungranted farm receives 403 refusal | Caller receives HTTP 403 `VfarmAuthorizationError` and tripwire security audit log | `COMPLETED` | `VERIFIED` | **PASS** |

---

## 3. Automated Test Evidence

Automated regression execution across both KMG9 test suites confirms 16/16 tests passing:
- [tests/regression/kmg9_phase3_additional.test.ts](../../tests/regression/kmg9_phase3_additional.test.ts) (5 tests)
- [tests/regression/kmg9_farm_isolation.test.ts](../../tests/regression/kmg9_farm_isolation.test.ts) (11 tests)

```
 ✓ tests/regression/kmg9_phase3_additional.test.ts (5 tests) 11ms
   ✓ KMG9 Phase 3: Additional boundary verification
     ✓ CST cluster search does not query farm-specific BHARAG workspaces and returns no farm-specific hit where prohibited
     ✓ The corresponding authorized vFarm workspace query can return the expected hit
     ✓ A service identity attempting to read farm A on behalf of a user granted only farm B receives 403
     ✓ A CST service identity attempting to POST to /farms/grants receives 403
     ✓ A protected farm read without required X-On-Behalf-Of receives 400

 ✓ tests/regression/kmg9_farm_isolation.test.ts (11 tests) 9ms
   ✓ KMG9: Farm isolation and BHARAG fallback removal
     ✓ farm-specific status uses vFarm live client and never calls BHARAG cluster
     ✓ mock adapter without live client does not call BHARAG cluster
     ✓ vFarm failure does not fall back to BHARAG
     ✓ general knowledge question may go to BHARAG but only for non-farm-specific content
     ✓ unbound caller for status returns safe refusal, no BHARAG
     ✓ asserts BHARAG response parsing verifies workspaces_queried and per_workspace_hits when provided
     ✓ rejects cross-workspace retrieval if BHARAG returns workspaces outside cst-help-manuals with no context
     ✓ accepts valid cst-help-manuals response with confident context
     ✓ rejects responses where query was routed to prohibited workspaces
     ✓ ignores unexpected properties in BHARAG response without throwing
     ✓ handles missing workspace metadata gracefully

 Test Files  2 passed (2)
      Tests  16 passed (16)
```

---

## 4. Impact on Upstream Dependency `LOOP-1791991972916-G718`

- **CST Implementation:** `COMPLETED`. The CST codebase enforces all KMG9 boundaries and isolation rules.
- **Owner Acceptance:** `READY_FOR_OWNER_ACCEPTANCE`. The CST-side implementation and tests are ready for Jason's acceptance.
- **External Confirmation Requirement (`EXTERNAL_CONFIRMATION_REQUIRED`):** Under `LOOP-1791991972916-G718`, Step 2 (CST clone quality sign-off) conditionally depends on Step 1 (BHARAG re-indexing sign-off). This external sign-off confirms that the upstream BHARAG cluster re-indexing contains zero leaked farm documents.
