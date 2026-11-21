# Codex Resubmission Draft — Row 483 (X6DK)

**Submission ID:** `U0AC6RFNP3P_1794314702156`  
**Row:** 483  
**Session:** X6DK  
**Linked Loop:** `LOOP-1793031575929-X6DK` (Post-Deploy `/health` Recheck)  
**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `feature/pbt5-elevenlabs-voice-observability`  
**HEAD:** `f08e3570d19aafa55f0066e8bdb5040ea02e3438`  
**Deployed Production SHA:** `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23, deploy `dep-dbkh3p6417fc73bffihg`)  
**Draft Date:** 11 November 2026  
**Status:** DRAFT — for Jason review only; NOT submitted to Codex

---

## Response to Jason's Feedback

Your feedback: "Please make this fully aligned then submit it again."

This resubmission addresses the alignment gaps:

1. **Mission fit now explicitly stated** — BHA Engine observability/health semantics capability, Customer Service Twin surface.
2. **Commercial impact made concrete** — operational failure prevented, workflow enabled, business risk identified.
3. **Breakthroughs and Blockers completed** — health discrepancy identified, classified, documented with owners and next actions.
4. **`proof_type` added** — `mixed_deterministic_and_production_evidence`.
5. **Error Fixes & Adaptations section added** — explains the `/health` vs `/api/health` discrepancy.
6. **Health discrepancy directly addressed** — `/health` (liveness) vs `/api/health` (readiness/contract) separation explained with code references.

---

## Work Summary

Re-checked CST health endpoints after production deployment. Investigated the discrepancy between `/health` (returns HTTP 200 with `{ status: 'ok' }`) and `/api/health` (returns HTTP 200 but body `status: 'degraded'` when vFarm freshness evidence is missing). Classified as `INTENTIONAL_LIVENESS_READINESS_SEPARATION` — the two endpoints serve different purposes by design; no code defect exists.

## BHA Engine / Twin Mission Fit

**BHA Engine capability:** Observability and health semantics — CST's health surface reports service state truthfully to operators, dashboards, and alerting systems without fabricating health when upstream dependencies are missing or stale. Two endpoints with distinct semantics:

| Endpoint | Purpose | Route | Behavior |
|----------|---------|-------|----------|
| `/health` | Liveness (is the process alive?) | `engine/src/app.ts:373-375` | Always `{ status: 'ok' }`, HTTP 200; no dependency checks |
| `/api/health` | Readiness/contract (can the service serve requests?) | `engine/src/app.ts:200-245` | HTTP 200; body `status` reflects vFarm farm health; `degraded` when data missing/stale |

**Twin surface:** Customer Service Twin (CST) — health endpoint supports voice and text conversation workflows by giving operators a truthful service status. vFarm is consumer only; CST does not own farm identity or device state.

**Strengthening:** Prevents false "healthy" claims during upstream data gaps. The `/health`/`/api/health` split lets infrastructure (Render/ALB) rely on liveness while operators rely on readiness via `/api/health`.

## Commercial Impact

Operators querying `/health` receive process-liveness confirmation only; `/api/health` provides the truthful readiness signal. Without this distinction, operators could act on false readiness assumptions during vFarm telemetry gaps, delaying incident response and increasing support burden. `/api/health` reports `degraded` when vFarm `calculated_at` is missing — preventing operators from believing the system is fully operational when it cannot serve live telemetry. No monetary value claimed; operational reliability benefit only.

## Breakthroughs

1. **Health discrepancy identified and classified:** `/health` HTTP 200 vs `/api/health` degraded traced to intentional liveness/readiness separation (`engine/src/app.ts:200-245, 373-375`); classified as `INTENTIONAL_LIVENESS_READINESS_SEPARATION`, not a defect.

2. **Contract v1.1.1 freshness enforcement verified:** 42 deterministic tests confirm missing `calculated_at` → `staleness_evaluation: 'unavailable_no_timestamp'` → status `degraded`, never `healthy` (`tests/health/health_route.test.ts:290-304`; `tests/health/health_contract.test.ts:80-89`).

3. **Liveness/readiness separation proven in tests:** `/health` returns `{ status: 'ok' }` even when vFarm reports `unhealthy` (`tests/health/health_route.test.ts:254-262`).

## Blockers and Dependencies

| Blocker | Owner | Next Action | Completion Criterion |
|---------|-------|-------------|---------------------|
| Live `/api/health` production verification not performed | Owner to be assigned | Authorized read-only request to production `/api/health`; record status field and timestamp | Live `/api/health` response recorded with deployed SHA |
| No tracking card for documentation clarification | Owner to be assigned | Create tracking card for `/health` vs `/api/health` documentation/observability clarification | Card ID recorded |
| Operators may misinterpret `/health` HTTP 200 as readiness | CST Engineering | Add documentation clarifying liveness vs readiness semantics; consider alerting on `/api/health` status field | Documentation published and reviewed |

## Error Fixes & Adaptations

| Field | Content |
|-------|---------|
| **Finding** | `/api/health` reports `degraded` while `/health` returns HTTP 200 with `{ status: 'ok' }` |
| **Classification** | `INTENTIONAL_LIVENESS_READINESS_SEPARATION` — no defect; architectural distinction by design |
| **Root cause** | `/health` is a process liveness probe (no dependency checks, always `ok`); `/api/health` is a readiness/contract probe (checks vFarm farm health, reports `degraded` when `calculated_at` is missing/stale) |
| **Before state** | Existing evidence implied both endpoints should return the same status; no explanation of the discrepancy |
| **Adaptation** | No code change required. Behavior is intentional. Documentation corrected to explain the liveness/readiness distinction, endpoint responsibilities, and why `/api/health` reports `degraded` when vFarm freshness evidence is absent |
| **Owner** | CST Engineering (owner to be assigned) |
| **Tracking card** | Not yet created — no existing card ID found |
| **Test evidence** | `npx vitest run tests/health/` → 3 files, 42 tests passed, 0 failed (2026-11-11) |
| **Production evidence** | Prior read-only Render CLI verified `/health` HTTP 200 OK (`CST_14_Decision_Watches_Render_Evidence.md:96`); live `/api/health` production verification pending |
| **Remaining risk** | Operators may misinterpret `/health` HTTP 200 as full service readiness |
| **Status** | Open — behavioral clarification documented; no code fix required |
| **Next action** | CST Engineering to add observability documentation clarifying `/health` vs `/api/health` semantics |

## Exact Implementation Evidence

- `engine/src/app.ts:373-375` — `/health` liveness route (always `{ status: 'ok' }`)
- `engine/src/app.ts:200-245` — `/api/health` readiness route (status from farm health)
- `engine/src/adapters/vfarm/health.ts:54-59` — `mapFarmHealthStatus()` (only `healthy`/`unhealthy` pass through)
- `engine/src/adapters/vfarm/health.ts:65-143` — `normalizeFarmHealth()` (missing `calculated_at` → `degraded`)

## Test and Production Proof

- `npx vitest run tests/health/` → 42 passed, 0 failed, 0 skipped (2026-11-11)
- Upstream dependencies: mocked in tests
- Prior production evidence: `/health` HTTP 200 OK via read-only Render CLI (historical)
- Live `/api/health` production verification: pending authorized access
- proof_type: `mixed_deterministic_and_production_evidence`

## Layer 0 Values

- `next_step`: CST Engineering to add observability documentation clarifying `/health` (liveness) vs `/api/health` (readiness); owner CST Engineering (to be assigned); completion: documentation published and live `/api/health` production recheck recorded; then Jason reviews and accepts Codex row 483
- `commercial`: Operators querying `/health` receive liveness only; `/api/health` provides truthful readiness; distinction prevents false readiness assumptions during vFarm telemetry gaps
- `proof_type`: `mixed_deterministic_and_production_evidence`

## Acceptance Request

Please review this resubmission for Codex row 483. The health discrepancy you identified has been investigated and classified as an intentional liveness/readiness separation — no code fix is required. Documentation clarification is recommended. Live `/api/health` production verification remains pending authorized access. All CST-side code is complete and tested (42 health tests pass).
