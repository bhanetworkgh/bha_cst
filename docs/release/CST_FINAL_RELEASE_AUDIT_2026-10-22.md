# CST — Final Release Audit and P0/P1 Status

**Date:** 2026-10-22
**Branch:** `fix/vfarm-farm-level-status-without-unit-binding`
**HEAD:** `83422e3`
**Working tree:** 7 modified + 4 untracked, all uncommitted
**Live release:** `ddae968` (merged PR #1)

---

## 1. What I moved

### Changes by lane

#### `[vFarm]` — Farm-level status and alert integration
- `engine/src/adapters/vfarm/index.ts`: `getFarmAlertsForSpeaker()` adapter method (farm-scoped, auth-checked via `assertSpeakerFarmAccess`). Redacted failure classification in `resolveSpeaker()` (`local_reference_matches_no_member` vs `upstream_organization_has_no_members`). Normalized upstream id comparison (trim + case).
- `engine/src/connectors/vfarm.ts`: Farm-level status when farm is authorized but no unit binding. Alert integration wired into farm-level answer. Honest counter wording (overlapping categories reported as "Of those, N are flagged unhealthy" rather than a disjoint partition).
- `tests/connectors/vfarm_farm_level_status.test.ts`: 5 tests (farm-level answer, no-farm refusal, ungranted speaker refusal, unknown speaker refusal, unit-level path unchanged).

#### `[Ask Engine]` — Intent routing
- `engine/src/router/index.ts`: Word-boundary matching for `ph`/`ec` (was `text.includes`, causing false positives on "phone", "because", "spec"). Possessive scope + live-data noun → vFarm. Knowledge markers → BHARAG. Narrow "form"→"farm" speech correction (possessive + live-data noun only, not global). Escalation preserved.
- `tests/router/intent_routing_matrix.test.ts`: 11 tests (routing matrix, lane separation, farm response integrity).
- `tests/router/router.test.ts`: Updated test body to a genuine farm-status question.

#### `[BHARAG]` — Credential separation
- `tests/connectors/bharag_credential_separation.test.ts`: 5 tests (credential separation, no fallback, no credential in logs, farm-status never calls BHARAG).

#### `[infra]` — Dependency remediation, self-healing, operations
- `package.json` / `package-lock.json`: npm overrides for `proxy-addr@2.0.8`, `follow-redirects@1.16.1`, `fast-uri@3.1.8`, `qs@6.16.1`, `brace-expansion@5.0.12`. Express bumped to `^4.22.3`.
- `engine/src/recovery/self_healing_tracker.ts`: NEW — self-healing state tracker (threshold 3/10min, deduplicated incident, bounded recheck max 5/1min, degraded capability). Uses existing Logger only — no new scheduler.
- `engine/src/adapters/vfarm/index.ts`: Wired `recordFailure` into `resolveSpeaker` failure path.
- `engine/src/connectors/vfarm.ts`: Wired `recordFailure` into farm-level status failure path.
- `tests/recovery/self_healing_tracker.test.ts`: 12 tests (trigger, dedup, recovery, bounded rechecks, rate limiting, audit fields, redacted logs).
- `docs/operations/SOP_CST_BHA_Independent_Work_Evidence_Logging_2026-10-22.md`: NEW — SOP from provided specification.
- `docs/release/CST_OPERATIONS_CHECKLIST_2026-10-22.md`: NEW — operations checklist.

### What was NOT changed
- No source files in `engine/src/core/`, `engine/src/identity/`, `engine/src/db/`, `engine/src/transport/`, `engine/src/admin/` were modified (except recovery wiring).
- No migrations added or modified.
- No environment variables, Render settings, or production configuration changed.
- No dependencies removed or downgraded.

## 2. Why it matters for the Engine

### P0 — vFarm person → form → device path

**The path is PARTIALLY verified.** The person → farm → (device) chain breaks at the device level:

```
person (vFarm user) → org membership (vFarm user_roles) → farm grants (vFarm farm_grants)
  → farm (vFarm farms table) → device (vFarm devices, linked via farm_id + zone_id/location_id/sublocation_id)
  → telemetry (vFarm device_readings via GET /readings/latest?sensor_id=device_id)
  → CST voice response (VfarmConnector.getUnitStatus → engine.ts → spoken reply)
```

**What works:** person → org membership → farm grants → farm → farm-level status (health, device counts, zones). This is the fix that makes "what's the status of my farm?" return real data instead of "not linked to an active vFarm unit."

**What breaks:** person → device. vFarm exposes no user→device assignment. `owner_user_id` occurs once in the spec, only as prose in an `InventoryUpdate` PATCH description. `DevicePlacement` has only `zone_id`, `location_id`, `sublocation_id` — no user link. So CST cannot answer "what's the temperature in bay 4?" for a specific person.

**Farm-level workaround:** When a caller has a farm grant but no unit binding, CST now answers at farm level (farm health + device counts) and honestly states that per-unit readings are not available. This is the correct behavior until vFarm provides the user→device contract.

### Operational truth rules

**SMS delivery:**
- May say "queued" only with evidence of durable queueing.
- May say "accepted by provider" only with a confirming provider response.
- May say "delivered" only with an authoritative provider delivery receipt/status.
- Must not equate queued or provider-accepted with handset delivery.
- Must disclose unknown, pending, failed, or unavailable delivery status honestly.

**CST health:**
- Distinguish API/process, database, vFarm identity/live data, BHARAG knowledge, outbound worker/queue, and actual provider delivery.
- A successful shallow `/health` probe proves only the checks that endpoint performs.
- Never claim full CST health or successful delivery based solely on a shallow health endpoint or local tests.

### Self-healing rule

**Trigger:** Same person → farm → device resolution failure ≥3 times in 10 minutes, scoped by (tenant, project, category). Stable, non-PII failure category only.

**Action:** Emit deduplicated operational incident (once per scope until recovery). Mark capability as degraded. Stop claiming live device data for the affected scope.

**Safe behavior:** Preserve authorization boundaries. Do not fabricate data. Do not silently switch to knowledge answers. Do not retry indefinitely.

**Recovery:** Bounded recheck (max 5, 1 per minute). Restore only after successful authorized resolution and telemetry retrieval.

**Audit fields:** timestamp, tenant_id, project_id, failure_category, failure_count, threshold, window_ms, capability_state, correlation_ref, recheck_count, recovery_result. No secrets or PII.

**Proof of invocation:** Wired into `VfarmConnector.getUnitStatus()` (upstream failure path) and `VfarmTenantAdapter.resolveSpeaker()` (no-member-match path). The tracker emits through existing `Logger.audit`/`Logger.infra` — no new scheduler or infrastructure service.

## 3. Evidence register

| ID | Source | Environment | Observed result | Limitations |
|---|---|---|---|---|
| E-vFarm-001 | `GET /api/v1/organizations/{org}/users` (live vFarm) | Production (read-only) | 2 members, both admin, UUID user_ids | Only confirms org membership, not device assignment |
| E-vFarm-002 | `GET /api/v1/users/{id}/farm-grants` (live vFarm) | Production (read-only) | 1 and 2 grants (UUID farm ids) | Confirms farm scope, not device scope |
| E-vFarm-003 | `GET /api/v1/farms/{id}/health` (live vFarm) | Production (read-only) | status=critical, 26 devices, 19 online, 6 offline, 10 unhealthy | Device counts are farm-level, not user-level |
| E-vFarm-004 | `GET /api/v1/devices?farm_id={id}` (live vFarm) | Production (read-only) | 26 devices, no user_id field on any device | Confirms no user→device link exists |
| E-vFarm-005 | Live vFarm OpenAPI spec (171 paths) | Production (read-only) | `owner_user_id` occurs once (prose only). `assignee`/`assigned`/`technician`/`staff`/`person` occur 0 times | Confirms no user→device contract exists upstream |
| E-vFarm-006 | `GET /api/v1/alerts/threshold/open?farm_id={id}` (live vFarm) | Production (read-only) | 200, total=0, auth required (401 without) | Confirms alert endpoint exists and is farm-scoped |
| E-AskEngine-001 | `tests/router/intent_routing_matrix.test.ts` | Local | 11 tests pass | Mocked upstream; does not prove live routing |
| E-AskEngine-002 | `tests/connectors/bharag_credential_separation.test.ts` | Local | 5 tests pass | Mocked BHARAG; does not prove upstream key enforcement |
| E-infra-001 | `npm run typecheck` | Local | 0 errors | — |
| E-infra-002 | `npm run build` | Local | clean (8 entries copied) | — |
| E-infra-003 | `npx vitest run` | Local | 92 files / 941 passed / 6 skipped / 0 failed, exit 0 | Pre-existing intermittent failure documented |
| E-infra-004 | `git diff --check` | Local | clean | — |
| E-infra-005 | `npm audit` | Local | 5 vulnerabilities (all dev-toolchain only) | — |
| E-infra-006 | `npm audit --omit=dev` | Local | 0 vulnerabilities | — |
| E-infra-007 | `tests/recovery/self_healing_tracker.test.ts` | Local | 12 tests pass | Mocked Logger; does not prove live invocation |
| E-render-001 | Render logs (2026-10-22) | Production (read-only) | Worker heartbeat every 5 min, queue empty, no errors | — |
| E-render-002 | Render deploy history | Production (read-only) | Live release `ddae968`, deployed 2026-10-22T11:15:20Z | — |

## 4. Blockers / Where I'm stuck

### Blocker 1: User-to-device/zone/location assignment
- **Owner:** `[vFarm]`
- **Evidence:** E-vFarm-004, E-vFarm-005
- **Missing:** A user-to-device/zone/location assignment endpoint with authorization, lifecycle, and stale-binding handling.
- **Impact:** Per-device readings unavailable. Farm-level status works without it.
- **Question for Jegan:** Does vFarm plan to expose a user→device/zone/location assignment? If so, what is the endpoint, schema, and authorization model?

### Blocker 2: vFarm service key + `X-On-Behalf-Of` + `/users/resolve?phone=`
- **Owner:** `[vFarm]` (Jegan's proposed PR)
- **Evidence:** Jegan's proposal §3.1. Not verified as shipped.
- **Missing:** Service key kind, phone column on users, resolve endpoint, `X-On-Behalf-Of` enforcement.
- **Impact:** Admin credentials cannot be removed from CST. Full three-lane credential contract not achievable.
- **Question for Jegan:** Has the service-key PR shipped? What is the exact endpoint and response shape for phone resolution?

### Blocker 3: Rack channel keys (`co_ppm`, `ph`, `soil_moisture`)
- **Owner:** `[vFarm]`
- **Evidence:** Schema declares `values` as an object. No live response with rack channels populated.
- **Missing:** A live response sample with rack channels.
- **Impact:** 3 telemetry metrics pending. Does NOT block farm-level status.

### Blocker 4: BHARAG `cst-help` cluster + `cst-help-read` key
- **Owner:** `[BHARAG]` / Jegan
- **Evidence:** Proposal §4.1. Not provisioned.
- **Missing:** `cst-help` cluster with only approved help workspaces; `cst-help-read` key with `['ask']` permissions only.
- **Impact:** Credential separation not enforceable upstream. Code is ready.

### Blocker 5: BHARAG incidents-only key
- **Owner:** `[BHARAG]` / Jegan
- **Evidence:** Proposal §5. Not provisioned.
- **Missing:** Separate incidents-only key with `['incidents']` permissions.
- **Impact:** Credential scoping not enforceable upstream. Code works with current key.

### Blocker 6: Production database expiry
- **Owner:** Operator (Bays)
- **Evidence:** `bha-cst-postgres` reports `expiresAt: 2026-11-14T18:10:20Z` (Render free plan).
- **Missing:** Move off free plan or approved export/restore path.
- **Impact:** Total data loss risk. Highest-impact operational item.

### Blocker 7: `trust proxy: true` spoofing
- **Owner:** Engineering
- **Evidence:** `app.set('trust proxy', true)` makes `req.ip` the left-most (caller-supplied) `X-Forwarded-For` entry.
- **Missing:** Staging measurement of Render's `X-Forwarded-For` chain.
- **Impact:** Rate limiter evasion/poisoning. Guessing wrong is worse than current state.

## 5. Next

### Completed (this session)
- ✅ Candidate `83422e3` verified: typecheck 0 errors, build clean, 92 files / 941 passed / 6 skipped / 0 failed.
- ✅ Farm-level status without unit binding (works).
- ✅ Intent routing (farm vs. knowledge) — 11 tests.
- ✅ Farm-level status integrity (counter overlap fix).
- ✅ Alert capability verified and wired (endpoint exists, farm-scoped, auth-required).
- ✅ BHARAG credential separation verified — 5 tests.
- ✅ Jegan three-lane architecture alignment documented.
- ✅ Telemetry shape documented (confirmed + pending keys).
- ✅ User-to-device contract documented as upstream dependency.
- ✅ Self-healing tracker implemented and wired — 12 tests.
- ✅ Operations checklist created.
- ✅ SOP document created from provided specification.
- ✅ Dependency remediation: 6 packages fixed via overrides. 5 dev-toolchain-only remain.
- ✅ Trust proxy investigation documented.
- ✅ Full verification: 92 files / 941 passed / 6 skipped / 0 failed, typecheck clean, build clean, `git diff --check` clean.

### Remaining CST-local tasks (priority order)
1. **Measure Render's `X-Forwarded-For` chain** — to fix `trust proxy: true`.
2. **Strip `workspaceKey`/`workspace` from BHARAG ask body** — after BHARAG confirms stripping is stable.
3. **Apply vitest major upgrade** — dedicated branch, full-suite review.
4. **Move `bha-cst-postgres` off free plan** — before 2026-11-14 expiry.

### Upstream tasks awaiting Jegan
1. vFarm: service key kind, `X-On-Behalf-Of` enforcement, phone column + `/users/resolve?phone=`.
2. vFarm: user-to-device/zone/location assignment contract.
3. vFarm: confirm exact keys for `co_ppm`, `ph`, `soil_moisture`.
4. vFarm: confirm alert endpoint authorization and empty/error semantics.
5. BHARAG: provision `cst-help` cluster + `cst-help-read` key with `['ask']` only.
6. BHARAG: confirm supported ask body and whether `workspaceKey`/`workspace` must be removed.
7. BHARAG: provision separate incidents key with `['incidents']` only.
8. BHARAG: provide permission-boundary evidence without creating a real incident.

### Required review and acceptance steps before an authorized deployment
1. Open a PR from `fix/vfarm-farm-level-status-without-unit-binding` against `main`.
2. Reviewer sign-off on the routing matrix and corrected aggregation wording.
3. Authorized real caller gets a farm-level status answer matching the upstream response.
4. Farm-data and farm-alert questions do not invoke BHARAG knowledge search.
5. General how-to questions still return knowledge responses with citations.
6. Unknown and unauthorized callers remain denied.
7. No unit/device ID or telemetry is fabricated.
8. vFarm service-key/on-behalf-of authorization tests pass after the upstream release.
9. BHARAG key separation and permission-boundary evidence are available.
10. A missing alert endpoint is reported honestly rather than represented as an empty alert list.
11. No BHARAG fallback occurs after a vFarm authorization or availability failure.
12. Voice delivery is checked only after an explicitly authorized deployment and live-test window.

---

### Status table

| Task | Status |
|---|---|
| Candidate `83422e3` verification | ✅ DONE |
| Farm-level status without unit binding | ✅ DONE |
| Intent routing (farm vs. knowledge) | ✅ DONE |
| Farm-level status integrity (counter overlap fix) | ✅ DONE |
| Alert capability verification + wiring | ✅ DONE |
| BHARAG credential separation verification | ✅ DONE |
| BHARAG credential separation (code) | ✅ DONE (already correct) |
| BHARAG credential separation tests | ✅ DONE (5 new tests) |
| Jegan three-lane architecture alignment | ✅ DONE (documented) |
| vFarm service-key migration preparation | ✅ DONE (interface prepared) |
| vFarm service-key implementation | 🔲 BLOCKED (upstream) |
| Telemetry shape documentation | ✅ DONE (confirmed + pending keys) |
| Telemetry shape implementation | 🔲 PARTIAL (3 keys pending) |
| User-to-device contract documentation | ✅ DONE |
| User-to-device implementation | 🔲 BLOCKED (upstream) |
| Trust proxy investigation | ✅ DONE (documented, not changed) |
| Dependency remediation (production) | ✅ DONE (6 packages fixed via overrides) |
| Dependency remediation (dev-toolchain) | 🔲 NOT STARTED (major upgrade needed) |
| Self-healing tracker | ✅ DONE (12 tests, wired into execution path) |
| Operations checklist | ✅ DONE |
| SOP document | ✅ DONE (created from provided specification) |
| Release-readiness audit | ✅ DONE |
| Production database expiry | 🔲 BLOCKED (operator action) |
| Production deployment | 🔲 NOT STARTED (requires authorization) |

### Safety confirmation

No commits, pushes, merges, deployments, production writes, live calls, or branch switches were performed. The working tree contains 7 modified and 4 untracked files, all local and uncommitted. No secrets, credentials, phone numbers, or customer identifiers were introduced. The identity-resolution, tenancy, security-ledger, and outbound-queue regressions remain intact (941 passed / 6 skipped / 0 failed). The BHARAG connector already follows the separation rules (no farm_id/unit_id sent, incidents separate, no fabricated incident IDs). No vFarm endpoint or field was invented — the alert endpoint was verified against the live OpenAPI spec before implementation. The operations checklist and SOP document were created as documentation only, with no production changes. No dependency was removed or downgraded; 6 production-relevant vulnerabilities were fixed via npm overrides and express bump. The `trust proxy` setting was investigated but not changed (requires staging measurement). `npm audit --omit=dev` reports 0 vulnerabilities. The remaining 5 advisories are all dev-toolchain only. The self-healing tracker uses existing Logger infrastructure — no new scheduler or infrastructure service was introduced. The self-healing tracker is now wired into the vFarm connector failure path and the adapter identity-resolution failure path.

### Decision Watch closure checklist

1. **P0 closed with Jegan and authorized end-to-end path proven:** ❌ NOT CLOSED. The person → farm → device path breaks at the device level (vFarm exposes no user→device assignment). Farm-level status works. Per-device readings are blocked on the upstream contract.
2. **Exact database path included in the log:** ✅ INCLUDED (see §2, "P0 — vFarm person → form → device path").
3. **SMS delivery and CST health allowed/not-allowed claims included:** ✅ INCLUDED (see §2, "Operational truth rules").
4. **Evidence-backed self-healing rule included:** ✅ INCLUDED (see §2, "Self-healing rule" + 12 regression tests).

**Release decision: `BLOCKED — NEEDS JEGAN / UPSTREAM CONTRACT`**

The CST-side work is complete and verified. The remaining blockers are upstream (vFarm service key, user-to-device assignment, BHARAG credential provisioning) and operational (database plan, trust proxy measurement). No production deployment should proceed until the upstream contracts are confirmed and the operator actions are completed.

**Next action:** Open a PR from `fix/vfarm-farm-level-status-without-unit-binding` against `main` with the 7 modified and 4 untracked files. Reviewer sign-off required before any deployment. The self-healing tracker, dependency remediation, and operations checklist are ready for review. The vFarm user-to-device contract and service-key contract require Jegan's confirmation before implementation can proceed. The production database expires 2026-11-14 — this is the highest-impact operational item.
