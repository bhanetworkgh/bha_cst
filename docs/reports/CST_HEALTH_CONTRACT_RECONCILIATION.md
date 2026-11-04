# CST Health Contract Reconciliation Report (v1.1.1)

**Contract Version:** Monitoring & Research Twin Field Contract v1.1.1  
**Target Specification:** Section 4.1 (Freshness and Staleness Evaluation) & Section 4.2 (Status Normalization)  
**Affected Files:**  
- `engine/src/adapters/vfarm/health.ts`  
- `tests/health/health_contract.test.ts`  
- `tests/health/health_route.test.ts`  
- `tests/health/vfarm_health_surfaces.test.ts`  
**Date:** 2026-11-03  

---

## 1. Problem Statement

Under previous implementations, CST normalized vFarm health responses by inspecting device counts, connectivity flags, and alert thresholds. However, upstream vFarm payloads do not consistently provide a `calculated_at` timestamp.

Contract v1.1.1 Section 4.1 establishes strict freshness criteria:
> "If the upstream health payload does not include a valid `calculated_at` ISO-8601 timestamp, the client MUST NOT assert that the farm is `healthy`. The absence of a timestamp evaluates to `staleness_evaluation: 'unavailable_no_timestamp'`, and the normalized overall status MUST be degraded to at least `degraded`."

Fabricating a timestamp or assuming that a lack of errors implies freshness directly violates the fail-closed monitoring agreement.

---

## 2. Code-Level Implementation Changes

In `engine/src/adapters/vfarm/health.ts`:

1. **Timestamp Extraction:**
   The adapter extracts candidate timestamps from `options.sourceTimestamp` or the upstream payload (`upstream.calculated_at` or `upstream.timestamp`).
   
2. **Staleness Evaluation:**
   - If no valid ISO-8601 timestamp is present:
     - `staleness_evaluation` is assigned `'unavailable_no_timestamp'`.
     - `calculated_at` is set to `null`.
     - If the pre-normalized status was `'healthy'`, it is downgraded to `'degraded'`.
   - If a valid timestamp is present:
     - Age is computed against current time (`Date.now() - timestampMs`).
     - If age exceeds 300,000 ms (5 minutes): `staleness_evaluation` is `'stale'`, status downgrades to `'degraded'`.
     - Otherwise: `staleness_evaluation` is `'fresh'`.

3. **Output Normalization:**
   The returned `NormalizedFarmHealth` object explicitly outputs `calculated_at: string | null` and `staleness_evaluation: 'fresh' | 'stale' | 'unavailable_no_timestamp'`, conforming exactly to the Contract v1.1.1 schema.

---

## 3. Test Suite Alignment

All unit and integration tests across `tests/health/` were updated to enforce Contract v1.1.1 semantics:

1. **`tests/health/health_contract.test.ts`:**
   - Tests asserting status on missing `calculated_at` now verify that status resolves to `degraded` with `staleness_evaluation: 'unavailable_no_timestamp'`.
   - Tests asserting status `'healthy'` provide an explicit, fresh `calculated_at` ISO timestamp.
2. **`tests/health/health_route.test.ts`:**
   - Route-level tests verify that `GET /api/v1/farms/:id/health` returns HTTP 200 with `status: "degraded"` when vFarm omits the calculation timestamp.
3. **`tests/health/vfarm_health_surfaces.test.ts`:**
   - Verifies that voice, SMS, and web surfaces truthfully report "degraded (timestamp unavailable)" rather than misleading customers with false "all systems normal" greetings.

---

## 4. Verification Evidence

All 42 tests across the health test suite pass:
```bash
npx vitest run tests/health/
# Results:
# ✓ tests/health/vfarm_health_surfaces.test.ts (11 tests)
# ✓ tests/health/health_route.test.ts (20 tests)
# ✓ tests/health/health_contract.test.ts (11 tests)
# Test Files  3 passed (3)
# Tests       42 passed (42)
```

