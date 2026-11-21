# Row 451 Alignment Evidence — CST Development and Production Status (Engine Surfacing)

**Record Identity:**
- Row: 451
- Submission ID: `U0AC6RFNP3P_1793996257808`
- Title: "Reviewed CST development and production status"
- Review date: 6 November 2026
- Repository: `bhanetworkgh/bha_cst`
- Branch at investigation: `feature/pbt5-elevenlabs-voice-observability` (HEAD `f08e357`)
- Jason's feedback: "Got it — I'll be on standby."

---

## Jason's Exact Feedback

"Got it — I'll be on standby."

**Interpretation note:** Per operating restrictions, this is NOT interpreted as approval, rejection, or payment confirmation. It is an acknowledgment with standby status.

---

## Original Alignment Issues

| Issue | Detail |
|-------|--------|
| Layer 1 Partially Aligned | Submission not fully aligned |
| Red flag: `missing_engine_surfacing` | BHA Engine capabilities not explicitly surfaced in the submission |
| Other alignment criteria reportedly strong | Code, test, and production evidence said to be strong |

---

## Investigation: What Was Reviewed on 6 November 2026

Row 451 covers "CST development and production status" — a general review of CST's engineering state. Based on repository evidence as of 6 November 2026 and the current branch state:

### Code Completion (Verified)
- All locally-resolvable CST code work complete across: vFarm telemetry extraction, speaker identity resolution, farm access control, voice turn processing (ElevenLabs & Twilio), SMS outbound queue, Research Twin failure bridges, health semantics, sensor endpoint interim switch
- Branch: `feature/pbt5-elevenlabs-voice-observability`, 64 commits ahead of origin
- HEAD: `f08e3570d19aafa55f0066e8bdb5040ea02e3438`

### Automated Test Evidence (Verified)
- `npm run test` → 1373 passed, 6 skipped, 0 failed across 131 files (verified 2026-11-11)
- `npm run typecheck` → clean (0 errors)
- `npm run build` → passes (compiled to `dist/`, 8 web assets copied)

### Deployed Production Evidence (Verified)
- Deployed production SHA: `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23, deploy `dep-dbkh3p6417fc73bffihg`, live 2026-11-02T22:43:32Z)
- Render PostgreSQL on paid Starter tier (`0.1c-256mb`); 14 Nov expiry cleared
- 24 migration files = 24 rows in `schema_migrations`
- Live `/health` returns HTTP 200 OK
- Real inbound voice call `conv_1901m73dat6cfr9vbme0z54sr64` (Twilio SID `CA26d9ef83116a44bb2871d7f22757c0b8`) verified over carrier PSTN

### Operator-Reported Evidence
- Error alert test executed by Destiny via n8n captured in Render logs (`#bha-pipeline-errors`, 2026-11-08T13:49:24Z) — `tests/notifications/error_routing.test.ts` 12/12 pass

### External Approval / Acceptance (Not Complete)
- Destiny Arupi: Research Twin contract approval pending
- Ahad: Dashboard record readback pending
- Jason: Final acceptance on Codex rows pending

---

## Mission Fit — BHA Engine Surfacing (Explicit)

The `missing_engine_surfacing` red flag means the original submission did not explicitly name the BHA Engine capabilities demonstrated by the CST work. Below is the explicit surfacing:

### BHA Engine Capabilities Demonstrated

| Capability | CST Implementation | Evidence |
|------------|-------------------|----------|
| **Orchestration** | `CoreRegistry.resolveSpeaker()`, `CoreEngine.processEnvelope()` — caller-to-vFarm flow, conversation orchestration | `engine/src/core/registry.ts:540-605`, `engine/src/core/engine.ts` |
| **Event handling** | `cst.turn`, `cst.escalation`, `cst.research_twin.investigation`, `cst.research_twin.callback` CloudEvents | `engine/src/contracts/events.ts`, `engine/src/research_twin/client.ts` |
| **Reliability** | Outbound queue with atomic claiming, lease reaper, exponential backoff, monotonic delivery guards, ambiguous-outcome handling | `engine/src/transport/twilio/outbound.ts:281-684` |
| **Security** | Twilio signature validation, fail-closed identity/authorization, `assertSpeakerFarmAccess`, consent_exempt bypass guarded | `engine/src/interfaces/voice/index.ts:18-80`, `engine/src/adapters/vfarm/authorization.ts:17-37` |
| **Observability** | `/api/health` with farm_health/status separation, bounded probe, `staleness_evaluation`, alert routing to `#bha-pipeline-errors` | `engine/src/app.ts:200-251`, `engine/src/notifications/error_router.ts:80-140` |
| **Shared workflow** | Message envelope (tenant_id, project_id, channel, speaker_ref, correlation_id) carried across voice, SMS, web | `engine/src/core/envelope.ts` |

### Named Twin or CST Surface Involved

**Customer Service Twin (CST)** — all capabilities above serve the customer-facing voice, text, and web workflows.

**vFarm** — consumer only; CST reads farm identity, devices, readings, presence, health but never owns or recomputes them.

**Monitoring/Research Twin** — CST surfaces monitoring states via `/api/health` and logs investigation triggers; Research Twin programmatic integration is BLOCKED pending Destiny Arupi contract approval.

**Media Server** — not involved in this submission.

### Classification

Platform capability / reliability / observability (BHA Engine lane), serving the Customer Service Twin surface. Not an integration with external systems (Research Twin blocked), not purely customer-facing (it's the engine infrastructure underpinning customer workflows).

---

## Commercial Impact

**Operational failure prevented:** Without explicit engine surfacing, reviewers cannot verify that CST work advances actual BHA Engine capabilities rather than superficial changes. This creates ambiguity about what is production-ready versus experimental.

**Customer/operator workflow enabled:** Explicit engine surfacing lets operators and reviewers understand which CST capabilities are production-ready (health, voice, text, SMS queue) versus blocked (Research Twin, freshness timestamp, DNS/TLS).

**Measurable outcome:** 1373 tests passed / 6 skipped / 0 failed; production deployment verified; `/health` HTTP 200 OK; live voice call verified.

**Business risk if not completed:** Ambiguity about engine capabilities could lead to incorrect deployment decisions, missed production incidents, or misallocated support resources.

---

## Breakthroughs

| Breakthrough | Before State | Change Made | After State | Evidence |
|-------------|-------------|-------------|-------------|----------|
| Engine capabilities explicitly surfaced | Engine capabilities implied but not named in submission | Mapped 6 BHA Engine capabilities (orchestration, event handling, reliability, security, observability, shared workflow) to specific code paths and tests | Explicit engine/twin relationship documented with line references | `engine/src/core/registry.ts`, `engine/src/transport/twilio/outbound.ts`, `engine/src/app.ts`, `engine/src/contracts/events.ts` |
| Production state verified | Production status claimed but not independently verified | Read-only verification of deployed SHA, PostgreSQL plan, migration count, `/health`, live voice call | Production evidence documented with timestamps and SHAs | `CST_14_Decision_Watches_Render_Evidence.md`, `decision-watch-audit-2026-11-10.md` |

---

## Blockers

| Blocker | Type | Owner | Next Action | Completion Criterion |
|---------|------|-------|-------------|---------------------|
| Jason's "standby" — no decision rendered | External approval dependency | Jason | Jason to review this evidence and provide formal acceptance or specify further action | Jason records decision on row 451 |
| Research Twin contract | External approval dependency | Destiny Arupi | Destiny to approve external dispatch contract, secret rotation, card-creation target | Contract approved; `RT_ENDPOINT_URL`/`RT_SERVICE_API_KEY` configured |
| vFarm freshness timestamp | External dependency | Jeganathan / vFarm | Jegan to confirm timestamp contract for farm health | Timestamp field confirmed or confirmed absent |
| DNS/TLS (OYP9) | External dependency | Jason / Platform | CNAME records, Render domains, TLS certificates | `cst.bhanetwork.org` reachable over HTTPS |
| Real SMS acceptance | External dependency | Authorized human tester | Live SMS lifecycle with matched callback | SMS E2E evidence captured |

---

## Layer 0 Field Proposals

| Field | Proposed Value |
|-------|---------------|
| `next_step` | Jason to review the explicit BHA Engine surfacing and production evidence documented here, then provide formal acceptance or specify further action on row 451. Responsible owner: Jason. Completion: Jason records decision on Codex row 451. |
| `commercial` | Explicit engine surfacing prevents misaligned deployment decisions. Operators and reviewers can distinguish production-ready CST capabilities (health, voice, text, SMS queue) from blocked items (Research Twin, freshness, DNS/TLS). No monetary value claimed. |
| `proof_type` | `mixed_deterministic_and_production_evidence` — deterministic unit tests (1373 passed/6 skipped/0 failed) + production database verification (24 migrations, paid Starter DB) + live API verification (`/health` HTTP 200 OK) + live telephony verification (voice call `conv_1901m73dat6cfr9vbme0z54sr64`). |

---

## Implementation Paths and Line References

- Orchestration: `engine/src/core/registry.ts:540-605` (`resolveSpeaker`), `engine/src/core/engine.ts` (`processEnvelope`)
- Event handling: `engine/src/contracts/events.ts`, `engine/src/research_twin/client.ts`
- Reliability: `engine/src/transport/twilio/outbound.ts:281-684` (`processOutboundQueue`)
- Security: `engine/src/interfaces/voice/index.ts:18-80`, `engine/src/adapters/vfarm/authorization.ts:17-37`
- Observability: `engine/src/app.ts:200-251` (`/api/health`), `engine/src/notifications/error_router.ts:80-140`
- Shared workflow: `engine/src/core/envelope.ts`

---

## Commit SHAs

- Investigation branch HEAD: `f08e3570d19aafa55f0066e8bdb5040ea02e3438`
- Deployed production SHA: `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23)

---

## Exact Tests and Outputs

- `npx vitest run` — 1373 passed, 6 skipped, 0 failed across 131 files (verified 2026-11-11)
- `npm run typecheck` — 0 errors (PASS)
- `npm run build` — PASS
- `npx vitest run tests/health/` — 32 tests pass
- `npx vitest run tests/notifications/error_routing.test.ts` — 12 tests pass

---

## Production Evidence and Timestamps

- Deployed SHA `441d2b3f4a49c983f45131c229888a60116b9437` live on Render `dep-dbkh3p6417fc73bffihg` at 2026-11-02T22:43:32Z
- PostgreSQL Starter tier `0.1c-256mb`; 14 Nov expiry cleared
- 24 migration files = 24 rows in `schema_migrations`
- `/health` HTTP 200 OK (live Render CLI query)
- Live voice call `conv_1901m73dat6cfr9vbme0z54sr64` — 78 seconds, TTS avg 96ms, tool 395ms

---

## Evidence Limitations

- Codex submission record not accessible locally; original Layer 0 fields and Layer 1 assessment not retrievable
- Jason's "standby" feedback is not approval/rejection/payment confirmation
- Production verification was read-only; no write access or configuration changes
- Some production items (Research Twin, freshness timestamp, DNS/TLS, real SMS) remain blocked on external owners

---

## Revised Submission Text (Jason Resubmission Draft)

### Work Summary

CST development and production status review (row 451). All CST-side code complete and verified: 1373 tests passed / 6 skipped / 0 failed; typecheck clean; build passes. Production deployment verified: SHA `441d2b3f4a49c983f45131c229888a60116b9437` live on Render, PostgreSQL on paid Starter tier, 24/24 migrations applied, `/health` returns HTTP 200 OK, live voice call verified over carrier PSTN.

### BHA Engine / Twin Mission Fit (Explicitly Surfaced)

**BHA Engine capabilities demonstrated:**
1. **Orchestration** — `CoreRegistry.resolveSpeaker()`, `CoreEngine.processEnvelope()` (`engine/src/core/registry.ts:540-605`)
2. **Event handling** — `cst.turn`, `cst.escalation`, `cst.research_twin.*` CloudEvents (`engine/src/contracts/events.ts`)
3. **Reliability** — Outbound queue with atomic claiming, lease reaper, exponential backoff, monotonic delivery (`engine/src/transport/twilio/outbound.ts:281-684`)
4. **Security** — Twilio signature validation, fail-closed identity/authorization (`engine/src/interfaces/voice/index.ts:18-80`, `engine/src/adapters/vfarm/authorization.ts:17-37`)
5. **Observability** — `/api/health` with farm_health/status separation, alert routing (`engine/src/app.ts:200-251`, `engine/src/notifications/error_router.ts:80-140`)
6. **Shared workflow** — Message envelope with tenant_id, project_id, correlation_id (`engine/src/core/envelope.ts`)

**Twin surface:** Customer Service Twin (CST). vFarm is consumer-only. Monitoring/Research Twin integration blocked pending Destiny contract.

### Commercial Impact

Explicit engine surfacing lets operators distinguish production-ready CST capabilities from blocked items, preventing misaligned deployment decisions. Current suite: 1373 passed / 6 skipped / 0 failed; production verified. No monetary value claimed.

### Breakthroughs

1. Engine capabilities explicitly mapped to code paths with line references (addressing `missing_engine_surfacing` red flag).
2. Production state independently verified: deployed SHA, PostgreSQL plan, migration count, `/health`, live voice call.

### Blockers and Dependencies

- Jason's "standby" — formal decision pending on row 451
- Research Twin contract — Destiny Arupi approval pending
- vFarm freshness timestamp — Jeganathan confirmation pending
- DNS/TLS (OYP9) — Jason/Platform action pending
- Real SMS acceptance — Authorized human tester pending

### Exact Implementation Evidence

Code paths listed above under BHA Engine capabilities, with file and line references.

### Test and Production Proof

- 1373 passed / 6 skipped / 0 failed (131 files)
- Production: deploy `dep-dbkh3p6417fc73bffihg`, SHA `441d2b3f4a49c983f45131c229888a60116b9437`, live 2026-11-02T22:43:32Z
- proof_type: `mixed_deterministic_and_production_evidence`

### Layer 0 Values

- `next_step`: Jason formal review and decision on Codex row 451
- `commercial`: Explicit engine surfacing prevents misaligned deployment decisions
- `proof_type`: `mixed_deterministic_and_production_evidence`

### Acceptance Request

I acknowledge your "Got it — I'll be on standby" message (6 November 2026). This is not interpreted as approval, rejection, or payment confirmation. The explicit BHA Engine surfacing and production evidence above address the `missing_engine_surfacing` red flag. Please review and provide your formal decision on row 451 when ready.

---

## Final Readiness Assessment

**READY FOR JASON REVIEW** — Explicit BHA Engine surfacing documented; production evidence verified. Awaiting Jason's formal decision on row 451 (his "standby" note acknowledged, not interpreted as approval).
