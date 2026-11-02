# CST PDQ2 Acceptance Matrix

**Repository:** `bhanetworkgh/bha_cst`
**Branch:** `fix/monitoring-pay-gate-closure`
**HEAD SHA:** `97e905561e45efbce3470cbb7686a1272e9c5381`
**Report date:** 2026-11-02
**Pay-gate:** `DW-1793626498819-PDQ2`

Statuses: PASS | PARTIAL | BLOCKED | NOT VERIFIED | FAIL

---

## Six-Area Acceptance Matrix

| Area | Jason's Requirement | Implementation Evidence | Automated Tests | CI Evidence | Human/Upstream Evidence | Verdict |
|---|---|---|---|---|---|---|
| **A — Health semantics and CI** | vFarm healthy→healthy, unhealthy→unhealthy, missing/stale/invalid/failed→degraded/unknown; never healthy from bad data | `engine/src/app.ts:35-40` (`mapFarmHealthStatus`), `engine/src/app.ts:179-251` (`GET /api/health`), `engine/src/adapters/vfarm/index.ts:806-814` (`getFarmHealthDirect`) | `tests/health/health_route.test.ts` (23 tests), `tests/health/health_contract.test.ts` (9 tests) — all pass | `.github/workflows/ci.yml` created; typecheck/test/build pass locally; not yet run on GitHub | N/A (code-level verification) | PASS |
| **B — Presence, sensors and help** | `/api/v1/readings?sensor_id=X&limit=1` interim endpoint (not `/readings/latest`); four-sensor hierarchy via placement (not `cabinet_id`); five-minute rule and never-heard behavior upstream-owned; help copy matches actual behavior | `engine/src/adapters/vfarm/live_client.ts:667-675` (`getLatestReading` switched to interim endpoint); `docs/help/p1-vfarm-status-and-monitoring-help-copy.md` (8 states distinguished) | `tests/adapters/vfarm_per_sensor_classification.test.ts` (8 tests pass), `tests/connectors/vfarm_telemetry_mapping.test.ts` (17 tests pass) | CI workflow created; not yet run remotely | Jegan: `/readings/latest` perf fix, timestamp confirmation, five-minute rule, never-heard correction | PARTIAL |
| **C — Text and voice** | Pending/typing feedback visible; composer disabled during request; duplicate prevention; error state + retry; accessibility ARIA; voice identity/persistence/playback | `web/app.js` (sendMessage, renderMessage, setComposerPending); `engine/src/transport/voice/turn_deadline.ts` (shared deadline, abort-based); `engine/src/interfaces/voice/index.ts` (Twilio webhook, identity, synthesis) | `tests/web/chat_pending_feedback.test.ts` (7 pass), `tests/browser/pending_feedback.spec.ts` (6 Playwright tests), `tests/voice/*` (multiple files) | CI workflow created; not yet run remotely | Authorized human: real voice call, real SMS, browser acceptance screenshots | PARTIAL |
| **D — Monitoring and Research Twin** | Consumed vFarm fields documented; Monitoring Twin states; Research Twin investigation lifecycle; callback security; idempotency; retries | `docs/contracts/monitoring-research-twin-field-contract.md` (triggers logged locally); investigation triggers detected and logged | None (no live integration) | N/A | Destiny: approved n8n/Research Twin contract; Jegan: architecture confirmation | BLOCKED |
| **E — SMS attribution** | Outbound row created; Twilio SID persisted; matched callback; tenant/project/correlation attribution; Dashboard publication; unmatched callback as failure | Outbound queue, delivery callback, Dashboard publishers exist in codebase | `tests/transport/*`, `tests/publishers/*` exist | CI workflow created; not yet run remotely | Authorized human: complete SMS lifecycle with matched callback | PARTIAL |
| **F — Migrations and dependencies** | Migration reconciliation (duplicate 003, drift 006/010); dependency audit (5 moderate, 2 high); all findings fixed or explicitly accepted | 23 files in `db/migrations/`; `package.json` + lockfile audited | Migration tests exist | CI workflow includes audit (`|| true`) | Production DB owner: read-only migration history confirmation | PARTIAL |

**Overall PDQ2 verdict: NOT READY — EXTERNAL CONTRACTS / ACCEPTANCE REMAIN**

Areas at PASS: 1 (Health semantics and CI)
Areas at PARTIAL: 5 (Sensors/help, Text/voice, Voice E2E, SMS attribution, Migrations/dependencies)
Areas at BLOCKED: 2 (Freshness contract, Research Twin integration)
Areas at NOT VERIFIED: 0
Areas at FAIL: 0

---

## Evidence Classifications Used

- `PASS`: implemented and verified with reproducible local evidence
- `PARTIAL`: implementation exists, but one or more acceptance conditions remain unverified (external owner confirmation, human acceptance, or remote CI run needed)
- `BLOCKED`: requires an external contract, owner decision, or system dependency
- `NOT VERIFIED`: no reliable evidence obtained
- `FAIL`: a reproducible test or acceptance criterion currently fails

---

## Cross-References

- Full evidence document: `docs/evidence/cst-monitoring-pay-gate-acceptance.md`
- Gap matrix: `docs/evidence/cst-implementation-acceptance-gap-matrix.md`
- Entries 393/399 report: `docs/evidence/cst-entries-393-399-jason-acceptance-report.md`
- Blocker register: `docs/evidence/CST_Blocker_Register.md`
- Evidence index: `docs/evidence/CST_Evidence_Index.md`
