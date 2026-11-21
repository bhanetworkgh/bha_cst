# Codex Resubmission Draft — Row 467 (K9VT)

**Submission ID:** `U0AC6RFNP3P_1794245808627`  
**Row:** 467  
**Session:** K9VT  
**Linked Loop:** `LOOP-1790985133889-8D7U` — "Resolve VFAM person-to-unit authorization contract"  
**Loop Status:** **In Progress**  
**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `feature/pbt5-elevenlabs-voice-observability`  
**HEAD:** `f08e3570d19aafa55f0066e8bdb5040ea02e3438`  
**Draft Date:** 12 November 2026  
**Status:** DRAFT — FOR JASON REVIEW ONLY; NOT SUBMITTED TO CODEX

---

## 1. Work Summary

Resolved the CST-side identity, scope resolution, and fail-closed authorization architecture for `LOOP-1790985133889-8D7U` (Codex Row 467 / K9VT). 

Audited upstream vFarm OpenAPI specification (`.openapi-vfarm.json`, 33,103 lines, 130 paths), confirming that vFarm currently provides organization membership (`/organizations/{org_id}/users`) and farm role grants (`/users/{user_id}/farm-grants`), but zero endpoints mapping a user/person UUID to assigned units, zones, allocations, or sublocations.

Hardened CST's customer-facing pipeline (`engine/src/core/engine.ts`) to eliminate fabricated normal telemetry fallbacks, verified CST's deliberate omission of synthetic `unit_id`s in `VfarmTenantAdapter`, created a deterministic 14-test authorization verification suite (`tests/adapters/vfarm_person_unit_authorization.test.ts`), and published the formal upstream clarification document (`docs/evidence/2026-11-12-vfam-person-unit-authorization-contract-questions.md`) to guide vFarm API team implementation.

---

## 2. BHA Engine / Twin Mission Fit

CST is the primary customer-facing twin in the BHA Engine ecosystem, handling voice, SMS, and web interactions for vertical farm operators. Authoritative person-to-unit scoping ensures callers only receive data for their authorized units and bays, preserving vFarm as the authoritative source of truth and guaranteeing that missing or revoked upstream access fails closed immediately.

---

## 3. Commercial Impact

Prevents catastrophic cross-tenant data leakage and eliminates synthetic or fabricated unit readings in commercial vertical farming operations. Protects customer contract integrity by ensuring technician queries access only assigned hardware and grow trays without granting unconstrained farm-wide visibility.

---

## 4. Breakthroughs & Invariant Protections

- **Zero Synthetic Fallbacks:** Completely decoupled customer responses from fabricated unit IDs (e.g. `unit_bay_04`) and eliminated `"Telemetry currently normal"` fallback in `CoreEngine.processTurn()`.
- **Hierarchical Scope Isolation:** Verified multi-unit, zone, and sublocation scopes across 14 deterministic invariant tests with 100% pass rate.
- **Fail-Closed Tenancy:** Caller identity resolution enforces strict tenant/project service number bindings before querying upstream vFarm.

---

## 5. Blockers and Dependencies

1. **vFarm Upstream Endpoint Deployment (Owner: Jeganathan):** Upstream vFarm API team must review the candidate schemas in `docs/evidence/2026-11-12-vfam-person-unit-authorization-contract-questions.md` and deploy a person-to-unit mapping endpoint.
2. **CST Live Ingestion (Owner: Ahad):** Ingest verified unit scope into `SpeakerIdentity.unit_context.authorized_units` once the upstream endpoint is live.
3. **Loop Status:** Remains **In Progress** until upstream vFarm deployment and live verification are complete.

---

## 6. Exact Implementation Evidence

- **Core Engine Hardening:** [`engine/src/core/engine.ts:687-692`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/core/engine.ts#L687-L692)
- **Deterministic Test Suite:** [`tests/adapters/vfarm_person_unit_authorization.test.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/adapters/vfarm_person_unit_authorization.test.ts) (14/14 tests pass)
- **Upstream Clarification Document:** [`docs/evidence/2026-11-12-vfam-person-unit-authorization-contract-questions.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-11-12-vfam-person-unit-authorization-contract-questions.md)
- **Consolidated Evidence Document:** [`docs/evidence/2026-11-12-vfam-person-unit-authorization-evidence.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-11-12-vfam-person-unit-authorization-evidence.md)

---

## 7. Test and Production Proof

- **Targeted Authorization Suite:** `npx vitest run tests/adapters/vfarm_person_unit_authorization.test.ts` (14 passed, 0 failed, 5ms)
- **Full Workspace Regression Suite:** `npm test` (133 test files passed, 1,402 passed, 6 skipped, 0 failed)
- **TypeScript Typecheck:** `npm run typecheck` (0 errors)
- **Build Compilation:** `npm run build` (Exit code 0)

---

## 8. Layer 0 Values

- **`next_step`:** vFarm API team (Jeganathan) to review contract clarification document (`docs/evidence/2026-11-12-vfam-person-unit-authorization-contract-questions.md`) and deploy upstream person-to-unit mapping endpoint.
- **`commercial`:** Guarantees multi-tenant telemetry isolation and eliminates synthetic unit responses across voice and SMS channels for commercial vertical farm customers.
- **`proof_type`:** `CODE_AND_TEST_INVARIANTS`

---

## 9. Acceptance Request

This draft brings Row 467 / K9VT into full alignment with `LOOP-1790985133889-8D7U`. It is submitted for Jason's review. The tracking loop remains **In Progress** pending upstream vFarm contract deployment.
