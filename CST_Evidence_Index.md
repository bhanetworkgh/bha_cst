# CST Evidence Index

**Repository:** `bhanetworkgh/bha_cst`
**Branch:** `fix/monitoring-pay-gate-closure`
**HEAD SHA:** `97e905561e45efbce3470cbb7686a1272e9c5381`
**Report date:** 2026-11-02
**Pay-gate:** `DW-1793626498819-PDQ2`

---

## Core Evidence Documents

| Evidence ID | Area | Description | Source/Link | SHA | Timestamp |
|---|---|---|---|---|---|
| E-01 | Release identity | Repository, branch, HEAD, working tree state | `git remote -v`, `git branch --show-current`, `git rev-parse HEAD`, `git status --porcelain` | `97e905561e45efbce3470cbb7686a1272e9c5381` | 2026-11-02 |
| E-02 | CI workflow | GitHub Actions workflow definition | `.github/workflows/ci.yml` | — | 2026-11-02 |
| E-03 | Sensor endpoint | Interim `/readings?sensor_id=X&limit=1` implementation | `engine/src/adapters/vfarm/live_client.ts:667-675` | `97e9055...` | 2026-11-02 |
| E-04 | Health semantics | `mapFarmHealthStatus()` and `/api/health` route | `engine/src/app.ts:35-40,179-251` | `97e9055...` | 2026-11-02 |
| E-05 | Health tests | Health route and contract tests | `tests/health/health_route.test.ts`, `tests/health/health_contract.test.ts` | `97e9055...` | 2026-11-02 |
| E-06 | Sensor tests | Per-sensor classification and telemetry mapping tests | `tests/adapters/vfarm_per_sensor_classification.test.ts`, `tests/connectors/vfarm_telemetry_mapping.test.ts` | `97e9055...` | 2026-11-02 |
| E-07 | Text pending feedback | DOM-shim integration tests | `tests/web/chat_pending_feedback.test.ts` | `97e9055...` | 2026-11-02 |
| E-08 | Browser tests | Playwright pending-feedback acceptance | `tests/browser/pending_feedback.spec.ts`, `playwright.config.ts` | — | 2026-11-02 |
| E-09 | Voice tests | Voice failure path, deadline, lifecycle tests | `tests/voice/voice_*.test.ts` | `97e9055...` | 2026-11-02 |
| E-10 | Voice pipeline | Turn deadline, abort-based abandonment | `engine/src/transport/voice/turn_deadline.ts` | `97e9055...` | 2026-11-02 |
| E-11 | Evidence document | Consolidated pay-gate acceptance evidence | `docs/evidence/cst-monitoring-pay-gate-acceptance.md` | — | 2026-11-02 |
| E-12 | Gap matrix | Implementation-to-acceptance gap matrix | `docs/evidence/cst-implementation-acceptance-gap-matrix.md` | — | 2026-11-02 |
| E-13 | PDQ2 matrix | Six-area acceptance matrix | `docs/evidence/CST_PDQ2_Acceptance_Matrix.md` | — | 2026-11-02 |
| E-14 | Blocker register | Owner-based blocker list | `docs/evidence/CST_Blocker_Register.md` | — | 2026-11-02 |

## Pre-Existing Evidence Documents

| Evidence ID | Area | Description | Source/Link | SHA | Timestamp |
|---|---|---|---|---|---|
| E-P1 | Entry 393 evidence | Identity/authority evidence for Codex entry 393 | `docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md` | — | 2026-10-29 |
| E-P2 | Entry 399 evidence | Render incident evidence for Codex entry 399 | `docs/evidence/2026-10-29-render-live-evidence-entry-399.md` | — | 2026-10-29 |
| E-P3 | Engine surfacing | CST-engine surfacing patch log | `docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md` | — | 2026-10-30 |
| E-P4 | Entries 393/399 report | Jason acceptance report for entries 393/399 | `docs/evidence/cst-entries-393-399-jason-acceptance-report.md` | — | 2026-10-29 |
| E-P5 | Burn-in diagnostic | Cabinet sensor diagnostic | `docs/evidence/2026-11-02-burn-in-cabinet-sensor-diagnostic.md` | — | 2026-11-02 |
| E-P6 | Voice acceptance | Voice acceptance inspection | `docs/evidence/2026-11-02-voice-acceptance-inspection.md` | — | 2026-11-02 |
| E-P7 | Admin panel | User integration admin panel evidence | `docs/evidence/cst-user-integration-admin-panel.md` | — | — |
| E-P8 | E2E template | End-to-end capture template | `docs/evidence/e2e-capture-template.md` | — | — |

## Test Evidence (Local Verification)

| Command | Result | Count | Evidence |
|---|---|---|---|
| `npm run typecheck` | PASS | — | `tsc --noEmit -p engine/tsconfig.json` |
| `npm test` | PASS (with 1 pre-existing isolation failure) | 1145 passed, 1 failed, 6 skipped | `vitest run` |
| `npm run build` | PASS | — | `tsc -b engine/tsconfig.json && node scripts/copy_web_assets.js` |
| `npm audit --audit-level=moderate` | 7 findings | 5 moderate, 2 high | `npm audit` output |
| `npx vitest run tests/adapters/vfarm_per_sensor_classification.test.ts` | PASS | 8/8 | Sensor endpoint interim tests |
| `npx vitest run tests/connectors/vfarm_telemetry_mapping.test.ts` | PASS | 17/17 | Telemetry mapping tests |
| `npx vitest run tests/web/chat_pending_feedback.test.ts` | PASS | 7/7 | Pending-feedback DOM tests |
| `npx vitest run tests/health/` | PASS | 32 tests | Health route and contract tests |

## Verification Limitations

- **No remote CI run**: GitHub Actions workflow created but not yet triggered on GitHub; no CI run URL available
- **No browser tests run locally**: Chromium browser cannot be installed (no network access); Playwright tests require browser binary
- **No production access**: Cannot verify deployed SHA, Render deployment, or production behavior per operating rules
- **No real voice/SMS calls**: Cannot initiate per operating rules; requires authorized human tester
- **No vFarm live access**: Cannot verify upstream contract, timestamp field, or five-minute rule independently
