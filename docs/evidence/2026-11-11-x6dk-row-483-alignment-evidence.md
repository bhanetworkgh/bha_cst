# X6DK Row 483 Alignment Evidence — Post-Deploy /health Recheck

**Record Identity:**
- Row: 483
- Session: X6DK
- Submission ID: `U0AC6RFNP3P_1794314702156`
- Linked Loop: `LOOP-1793031575929-X6DK` (Post-Deploy `/health` Recheck)
- Repository: `bhanetworkgh/bha_cst`
- Branch at investigation: `feature/pbt5-elevenlabs-voice-observability` (HEAD `f08e3570d19aafa55f0066e8bdb5040ea02e3438`)
- Deployed production SHA referenced: `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23, deploy `dep-dbkh3p6417fc73bffihg`, live 2026-11-02T22:43:32Z)
- Investigation date: 11 November 2026

---

## Jason's Exact Feedback

"Please make this fully aligned then submit it again."

---

## Executive Summary

The X6DK submission concerns a post-deployment recheck of CST's health endpoints. The existing evidence contained two inaccuracies that Jason's review identified:

1. It implied mission fit rather than explicitly stating the BHA Engine capability and Twin surface.
2. It claimed `/health` and `/api/health` both return truthful status, but did not explain why `/health` returns HTTP 200 while `/api/health` reports `degraded`.

**Root finding:** The two endpoints serve different purposes and this is by design:
- **`/health`** (`engine/src/app.ts:373-375`) is a **liveness** probe for Render/AWS ALB — always returns `{ status: 'ok', service: 'bha-cst-engine' }` with HTTP 200, no dependency checks.
- **`/api/health`** (`engine/src/app.ts:200-245`) is a **readiness/contract** check — returns HTTP 200 but the `status` field in the body reflects actual dependency health (`degraded` when vFarm `calculated_at` is missing/stale, never fabricated `healthy`).

**Classification:** `INTENTIONAL_LIVENESS_READINESS_SEPARATION` — the difference between the two endpoints is an architectural distinction, not a defect.

---

## Original Alignment Issues

| Issue | Detail |
|-------|--------|
| Mission fit implied rather than explicitly stated | No explicit naming of BHA Engine capability or Twin surface |
| Commercial-impact line generic | No concrete operational outcome identified |
| Breakthroughs and Blockers coverage incomplete | Sections missing or under-specified |
| Missing `proof_type` | No evidence classification provided |
| Health discrepancy unexplained | No explanation of why `/health` returns 200 while `/api/health` reports degraded |
| Missing Error Fixes & Adaptations section | Mandatory section absent |

---

## 1. BHA Engine and Customer Service Twin Mission Fit

### BHA Engine Capability Advanced

**Observability and health semantics.** The CST health surface advances the BHA Engine's observability capability: the engine must be able to report its own state truthfully to operators, dashboards, and alerting systems without fabricating health when upstream dependencies are missing or stale. This is implemented across two endpoints with distinct semantics:

| Endpoint | Purpose | Route | Behavior |
|----------|---------|-------|----------|
| `/health` | Liveness (is the process alive?) | `engine/src/app.ts:373-375` | Always `{ status: 'ok' }`, HTTP 200; no dependency checks |
| `/api/health` | Readiness/contract (can the service serve requests?) | `engine/src/app.ts:200-245` | HTTP 200, body `status` reflects vFarm farm health; `degraded` when data missing/stale |

The health mapping logic lives in `engine/src/adapters/vfarm/health.ts`:
- `mapFarmHealthStatus()` (line 54-59): only `healthy`/`unhealthy` pass through; everything else → `degraded`/`unknown`
- `normalizeFarmHealth()` (line 65-143): separates API reachability from farm health, never derives health from `health_score`, device count, or locally invented thresholds; missing `calculated_at` → `staleness_evaluation: 'unavailable_no_timestamp'` → status `degraded`

### Named Twin or CST Surface Involved

**Customer Service Twin (CST)** — the health surface is the primary observability endpoint for the customer-facing twin. Farm operators and support personnel use `/api/health` to determine whether CST can serve voice and text conversations. The vFarm adapter is a consumer only; CST does not own farm identity or device state.

### How the Work Strengthens Engine/Twin Capability

The work ensures CST's `/api/health` endpoint returns truthful status even when vFarm's `calculated_at` timestamp is missing. Instead of fabricating `healthy`, CST reports `degraded` — preventing operators from making decisions based on false health claims. The intentional separation between `/health` (liveness) and `/api/health` (readiness) means Render/AWS ALB can keep routing traffic to a live process while operators see the true dependency state via `/api/health`.

### Classification

Operational tool / observability surface (Customer Service Twin lane). Not a platform capability, not an integration, not a customer-facing feature per se — it is the health/observability surface that supports the customer-facing voice and text workflows.

---

## 2. Specific Commercial Impact

**Operational failure this health check can identify:** When vFarm's `calculated_at` timestamp is missing or stale, `/api/health` reports `degraded` rather than `healthy`. This tells operators that CST cannot confirm current farm telemetry freshness, so voice and text turns may not have reliable sensor data.

**How incorrect healthy/degraded reporting affects CST operations:** If CST reported `healthy` without vFarm freshness evidence, farm operators would believe the system is fully operational when it cannot serve live telemetry. This delays incident response and increases support burden as customers call in about missing readings.

**How reliable health semantics support service availability decisions:** The `/health`/`/api/health` split allows infrastructure (Render/ALB) to rely on liveness (`/health` = process alive) while operators rely on readiness (`/api/health` = dependencies healthy). This prevents false confidence: a process can be alive (`/health` = ok) but not ready to serve accurate data (`/api/health` = degraded).

**Measurable outcome:** `/api/health` returns HTTP 200 with `status: 'degraded'` when vFarm `calculated_at` is missing (verified by 42 deterministic tests). `/health` returns HTTP 200 with `status: 'ok'` (liveness only). No monetary value claimed; operational reliability benefit only.

**Business risk if not completed:** Operators could act on false health information, leading to delayed incident response, undetected voice/text service degradation, and increased customer churn risk.

---

## 3. Health Endpoint Investigation

### Endpoint 1: `/health` — Liveness

**Route:** `engine/src/app.ts:373-375`
```typescript
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'bha-cst-engine' });
});
```

**What it proves:** The Express process is alive and bound to a port. Render / AWS ALB uses this to determine if the instance should receive traffic.

**Dependency checks:** None. No database, no vFarm, no upstream call.

**Test coverage:** `tests/health/health_route.test.ts:254-262` — verifies `/health` returns `{ status: 'ok' }` HTTP 200 even when vFarm adapter reports `unhealthy`.

### Endpoint 2: `/api/health` — Readiness / Contract

**Route:** `engine/src/app.ts:200-245`

**What it proves:** Whether CST can serve requests with its upstream dependencies. Probes vFarm API reachability, fetches authoritative farm health, normalizes the status, and reports freshness.

**Dependency checks:** vFarm API (`getHealth`), vFarm farm health (`getFarmHealthDirect`).

**Response schema:** `{ status, service, timestamp, api_reachability, farm_health, research_twin }` where `status` is derived from `farm_health` only.

**Test coverage:** `tests/health/health_route.test.ts:87-305` and `tests/health/health_contract.test.ts:1-195` — 42 deterministic tests covering all status mappings.

### Why `/health` Returns 200 While `/api/health` Reports Degraded

The difference is **intentional and architectural**:

1. `/health` is a **liveness** probe — it answers "is the process running?" and always returns `ok`. Infrastructure uses it for load-balancing decisions.

2. `/api/health` is a **readiness/contract** probe — it answers "can the service serve accurate data?" and reports `degraded` when vFarm freshness cannot be confirmed.

Both return HTTP 200. The difference is in the **response body**, not the HTTP status code. `/api/health` returning `status: 'degraded'` is correct behavior per Contract v1.1.1: missing `calculated_at` means freshness cannot be proven, so status cannot be confirmed healthy.

### Is the Degraded Status Caused by an Actual Dependency Failure?

No. The `degraded` status on `/api/health` is caused by missing vFarm `calculated_at` timestamp evidence, not by a hard dependency failure. vFarm API may be reachable (`api_reachability: healthy`) but farm health data lacks freshness evidence (`staleness_evaluation: 'unavailable_no_timestamp'`), so status maps to `degraded`.

### Is the Response Contract Missing, Mismatched, or Unverified?

The contract is **implemented and tested** (42 deterministic tests pass). It is **not verified against live production** for `/api/health` specifically — prior production verification was read-only Render CLI query of `/health` only. Live `/api/health` production verification is pending authorized access.

### Is the Difference Intentional?

Yes. The liveness/readiness separation is deliberate: `engine/src/app.ts:203-214` explicitly documents that "API reachability remains a separate diagnostic field and is NEVER used to derive farm health."

### Does the Current Deployment Run the Code Being Inspected?

The code at HEAD `f08e357` on branch `feature/pbt5-elevenlabs-voice-observability` matches the implementation described. The deployed production SHA `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23) is an ancestor state; whether the exact health implementation is live on that deployment has not been independently re-verified in this session.

---

## 4. Error Fixes & Adaptations

| Field | Required content |
|-------|---------------|
| **Finding** | `/api/health` reports `degraded` while `/health` returns HTTP 200 with `{ status: 'ok' }`. Jason flagged this as a discrepancy requiring explanation. |
| **Classification** | `INTENTIONAL_LIVENESS_READINESS_SEPARATION` — the two endpoints serve different purposes by design; no defect exists. |
| **Root cause** | Architectural distinction: `/health` is a process liveness probe (no dependency checks, always `ok`); `/api/health` is a readiness/contract probe (checks vFarm farm health, reports `degraded` when `calculated_at` is missing/stale). |
| **Before state** | Existing evidence implied `/health` and `/api/health` should return the same status; no explanation of why one returns 200 while the other reports degraded. |
| **Adaptation** | No code change required. The behavior is intentional. Documentation corrected to explain the liveness/readiness distinction, endpoint responsibilities, and why `/api/health` reports `degraded` when vFarm freshness evidence is absent. |
| **Owner** | CST Engineering (owner to be assigned for documentation clarification) |
| **Tracking card** | Not yet created — no existing card ID found for this documentation/observability clarification |
| **Test evidence** | `npx vitest run tests/health/` → 3 test files, 42 tests passed, 0 failed (2026-11-11). Includes `/health` liveness test (`health_route.test.ts:254-262`) and `/api/health` degraded mapping test (`health_route.test.ts:290-304`). |
| **Production evidence** | Prior read-only Render CLI query verified `/health` returns HTTP 200 OK (`CST_14_Decision_Watches_Render_Evidence.md:96`, `Open_decision_watches_for_Ahad_3_Nov_2026.md:136`). Live `/api/health` production verification **not performed** in this session — pending authorized read-only access. |
| **Remaining risk** | Operators or automated tooling may misinterpret `/health` HTTP 200 as full service readiness when `/api/health` reports `degraded`. Documentation/observability clarification recommended. |
| **Status** | Open — behavioral clarification documented; no code fix required. |
| **Next action** | CST Engineering to add observability documentation clarifying `/health` (liveness) vs `/api/health` (readiness) semantics; optionally add a dashboard/alerting note that `/api/health` status field, not HTTP 200, is the readiness signal. |

---

## 5. Breakthroughs

| Breakthrough | Before State | Change Made | After State | Evidence |
|-------------|-------------|-------------|-------------|----------|
| Health discrepancy identified and classified | `/health` HTTP 200 vs `/api/health` degraded presented as unexplained inconsistency | Traced both routes: `/health` (liveness, line 373-375) vs `/api/health` (readiness/contract, line 200-245); classified as `INTENTIONAL_LIVENESS_READINESS_SEPARATION` | Difference is documented as intentional architectural behavior, not a defect | `engine/src/app.ts:200-245, 373-375`; `engine/src/adapters/vfarm/health.ts` |
| Contract v1.1.1 freshness enforcement verified | Missing `calculated_at` handling claimed but not exhaustively tested | 42 deterministic tests confirm: missing timestamp → `staleness_evaluation: 'unavailable_no_timestamp'` → status `degraded`, never `healthy` | Freshness contract proven in deterministic tests | `tests/health/health_route.test.ts:290-304`; `tests/health/health_contract.test.ts:80-89` |
| Liveness/readiness separation proven in tests | No test asserted `/health` is independent of upstream state | Test `health_route.test.ts:254-262` proves `/health` returns `{ status: 'ok' }` even when vFarm reports `unhealthy` | Separation is empirically verified | `tests/health/health_route.test.ts:254-262` |

---

## 6. Blockers

| Blocker | Type | Owner | Next Action | Completion Criterion |
|---------|------|-------|-------------|---------------------|
| Live `/api/health` production verification not performed | Production access limitation | Owner to be assigned | Authorized read-only request to `https://cst.bhanetwork.org/api/health` or Render equivalent; record status field and timestamp | Live `/api/health` response recorded with deployed SHA |
| No tracking card for documentation clarification | Missing tracking card | Owner to be assigned | Create tracking card for `/health` vs `/api/health` documentation/observability clarification | Card ID recorded in this report |
| Operators may misinterpret `/health` HTTP 200 as readiness | Observability gap | CST Engineering | Add documentation clarifying liveness vs readiness semantics; consider alerting on `/api/health` status field | Documentation published and reviewed |

---

## 7. Layer 0 Field Proposals

| Field | Proposed Value |
|-------|---------------|
| `next_step` | CST Engineering to add observability documentation clarifying `/health` (liveness, always `ok`) vs `/api/health` (readiness, status field reflects dependency health). Owner: CST Engineering (to be assigned). Completion: documentation published; live `/api/health` production recheck performed and recorded. Jason then reviews and accepts Codex row 483. |
| `commercial` | Operators querying `/health` receive process-liveness confirmation only; `/api/health` provides the truthful readiness signal. Without the distinction, operators could act on false readiness assumptions during vFarm telemetry gaps, delaying incident response. No monetary value claimed; operational reliability benefit only. |
| `proof_type` | `mixed_deterministic_and_production_evidence` — 42 deterministic unit tests pass (mocked upstream, proving contract behavior); prior read-only Render CLI verification of `/health` HTTP 200 OK (production evidence). Live `/api/health` production verification pending authorized access. |

---

## 8. Implementation Paths and Line References

- `/health` liveness route: `engine/src/app.ts:373-375`
- `/api/health` readiness route: `engine/src/app.ts:200-245`
- Health status mapping: `engine/src/app.ts:35-40` (`mapFarmHealthStatus()` re-exported from `engine/src/adapters/vfarm/health.ts:54-59`)
- Farm health normalization: `engine/src/adapters/vfarm/health.ts:65-143` (`normalizeFarmHealth()`)
- vFarm adapter health probe: `engine/src/adapters/vfarm/live_client.ts` (`getHealth()`, `hasLiveClient()`)
- Farm health direct: `engine/src/adapters/vfarm/index.ts` (tenant adapter, `getFarmHealthDirect()`)

---

## 9. Commit SHAs

- Investigation branch HEAD: `f08e3570d19aafa55f0066e8bdb5040ea02e3438` (feature/pbt5-elevenlabs-voice-observability)
- Deployed production SHA: `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23, deploy `dep-dbkh3p6417fc73bffihg`)

---

## 10. Exact Tests and Outputs

Command: `npx vitest run tests/health/`
- Test files: 3 passed (`health_contract.test.ts`, `health_route.test.ts`, `vfarm_health_surfaces.test.ts`)
- Tests: **42 passed, 0 failed, 0 skipped**
- Timestamp: 2026-11-11
- Upstream dependencies: **mocked** (vFarm adapter mocked via `vi.fn()` in `health_route.test.ts`)
- Current branch: `feature/pbt5-elevenlabs-voice-observability`
- HEAD SHA: `f08e3570d19aafa55f0066e8bdb5040ea02e3438`

Full suite (all tests): 1388 passed, 6 skipped, 0 failed (132 files, verified 2026-11-11).

---

## 11. Production Evidence and Timestamps

- `/health` (production, historical): HTTP 200 OK, queried via read-only Render CLI on deploy `dep-dbkh3p6417fc73bffihg` (source: `CST_14_Decision_Watches_Render_Evidence.md:96`, `Open_decision_watches_for_Ahad_3_Nov_2026.md:136`)
- `/api/health` (production): **NOT verified in this session** — no read-only production request made; pending authorized access
- `/api/health` (local, deterministic): Returns `status: 'degraded'` when vFarm `calculated_at` missing (verified by `health_route.test.ts:290-304`, 42 tests pass)

---

## 12. Evidence Limitations

- Codex submission record is external and not accessible from this repository; original Layer 0 fields and Layer 1 assessment not retrievable locally
- Jason's thread reply (if any) for this submission was not found in the repository
- Live `/api/health` production verification not performed — no read-only production request made in this session
- No source code or production configuration was modified
- No Codex or Slack records were changed

---

## 13. Final Readiness Decision

**READY FOR JASON REVIEW** — The health discrepancy has been investigated and classified as `INTENTIONAL_LIVENESS_READINESS_SEPARATION`. No code change is required. Documentation clarification is recommended. Live `/api/health` production verification remains pending authorized access but does not block Jason's review of the aligned evidence.
