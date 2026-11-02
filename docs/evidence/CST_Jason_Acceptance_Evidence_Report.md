# CST — Jason Acceptance & Production Evidence Report

**Prepared by:** CST Engineering (Kilo)
**Project:** Customer Service Twin
**Repository:** bhanetworkgh/bha_cst
**Pay-gate Review:** `DW-1793626498819-PDQ2`
**Report date:** 2026-11-02 (UTC)
**Current branch:** `fix/monitoring-pay-gate-closure`
**HEAD SHA:** `97e905561e45efbce3470cbb7686a1272e9c5381`
**PR:** `#19` (referenced in mission)
**Render deployment:** NOT VERIFIED (no deploy/push authorization)
**Deployed SHA:** NOT VERIFIED (cannot access Render API)
**Overall verdict:** PARTIAL — NOT READY FOR PAY-GATE CLOSURE

---

## 1. Executive Verdict

- **Genuinely complete (PASS):** Health semantics mapping (healthy/unhealthy/degraded/unknown), 8-way error classification, sensor endpoint interim switch, text pending-feedback UX, voice pipeline with deadline and persistence, CI workflow creation, dependency audit documentation.
- **Locally verified:** Typecheck PASS, 1145 tests passed / 1 failed / 6 skipped, build PASS, dependency audit documented (7 findings accepted as residual risk).
- **CI verified:** NOT YET — GitHub Actions workflow created but not triggered; no CI run URL available.
- **Production verified:** NOT YET — no Render/deployment access per operating rules.
- **Blocked (external contracts):** vFarm farm-health timestamp (freshness), Research Twin / BHA Engine integration, DNS/TLS (OYP9), real voice/SMS acceptance.
- **Jason can accept now:** Health semantics, text pending-feedback UX, sensor endpoint interim implementation, CI workflow definition, dependency risk acceptance.
- **Prevents pay-gate closure:** vFarm timestamp contract, Research Twin contract, DNS/TLS, real voice/SMS acceptance, remote CI run, browser acceptance screenshots.

---

## 2. What Moved

| Workstream | Before | Change | Current Evidence | Status | BHA Architecture Lane |
|---|---|---|---|---|---|
| Sensor endpoint | `GET /api/v1/readings/latest?sensor_id=X` (~29.6s) | Switched to `GET /api/v1/readings?sensor_id=X&limit=1` (~271ms) interim | `engine/src/adapters/vfarm/live_client.ts:667-675`; tests pass (8+17) | PARTIAL | CST → vFarm (consumer) |
| Health semantics | Already implemented; added malformed/no-status/missing-timestamp test cases | 3 new route-level test cases; 8-way error classification documented | `engine/src/app.ts:35-40,179-251`; `tests/health/*` (32 tests) | PASS | CST (authoritative for mapping) |
| Health freshness | No timestamp from vFarm; `staleness_evaluation: 'unavailable_no_timestamp'` | Documented as BLOCKED; no false healthy claim | `tests/health/health_route.test.ts:239-248` | BLOCKED | vFarm (owner) |
| Text pending feedback | Already implemented | DEBUG code removed; DOM shim `textContent` fixed as getter; `_syncClass()` restored | `web/app.js`; `tests/web/chat_pending_feedback.test.ts` (7 pass) | PASS | CST |
| Browser acceptance | None | Playwright config + 6 browser test cases created | `playwright.config.ts`; `tests/browser/pending_feedback.spec.ts` | PARTIAL (needs Chromium binary) | CST |
| Voice pipeline | Already implemented | No code changes needed; deadline/abort/persistence verified | `engine/src/transport/voice/turn_deadline.ts`; `tests/voice/*` | PARTIAL | CST |
| CI workflow | Missing (deleted in prior commit) | Created `.github/workflows/ci.yml` | `.github/workflows/ci.yml`; typecheck/test/build pass locally | PARTIAL (needs remote run) | CST (infrastructure) |
| Dependency audit | 7 findings (5 moderate, 2 high) | Documented; all require `--force` which breaks swagger-jsdoc; accepted as residual risk | `npm audit` output; `docs/evidence/cst-monitoring-pay-gate-acceptance.md:G.1` | PARTIAL | CST |
| Evidence document | Existing but incomplete | Updated with sensor endpoint change, current test results, acceptance matrix | `docs/evidence/cst-monitoring-pay-gate-acceptance.md` | PASS | CST |

---

## 3. Why Engine / Architecture Fit

- **BHARAG evidence/confidence handling:** CST stores incident references only; does NOT query BHARAG for live farm data ("No BHARAG fallback — vFarm is the only source", `engine/src/connectors/vfarm.ts:376`). BHARAG owns generic knowledge; CST owns conversation surface.
- **CST conversation and customer-service surface:** Message envelope (tenant_id, project_id, channel, speaker_ref, text, media, correlation_id, metadata); web chat with pending feedback; voice pipeline with deadline and persistence; SMS attribution path.
- **vFarm authoritative data:** CST reads `fleet_status`, `farm_health`, per-sensor readings verbatim; never recomputes health; never creates independent health model. vFarm remains system #1 for farm identity, devices, readings, presence, health.
- **Monitoring Twin:** CST surfaces monitoring states via `/api/health` (`farm_health.status`, `staleness_evaluation`, `api_reachability`). Investigation triggers logged (authorization_denied, no_reading, invalid_request, timeout, unhealthy/degraded/unknown health).
- **Research Twin:** NOT integrated. Contract documented as BLOCKED in `docs/contracts/monitoring-research-twin-field-contract.md:156-170`. No programmatic card creation, no lifecycle sync, no callback security implemented.
- **BHA Engine orchestration and lifecycle:** Integration blocked pending Destiny/Jegan contract confirmation. CST prepares adapter infrastructure but does not activate production integration.

**Distinction:** Actual implemented integration = health mapping, text UX, voice pipeline, sensor reads. Intended architecture = Research Twin card creation, lifecycle sync, bidirectional status.

---

## 4. PDQ2 Acceptance Matrix

| Area | Jason's Requirement | Implementation Evidence | CI Evidence | Production Evidence | Remaining Gap | Verdict |
|---|---|---|---|---|---|---|
| **A** | Health semantics and CI | `mapFarmHealthStatus()`, `/api/health`, 8-way error classification | Workflow created; not remotely run | N/A (code-level) | Remote CI run | PASS |
| **B** | Presence, sensors and help | Interim `/readings?sensor_id=X&limit=1`; 8 help states; placement hierarchy | Sensor tests (25) pass locally | Not verified | Jegan: timestamp, 5-min rule, never-heard, `/latest` fix | PARTIAL |
| **C** | Text and voice | Pending feedback, composer disable, duplicate prevention, voice deadline/persistence | Text (7) + voice tests pass locally | Not verified | Authorized human: voice call, SMS, browser screenshots | PARTIAL |
| **D** | Monitoring and Research Twin | Triggers logged locally; `/api/health` surfacing | None (no live integration) | Not verified | Destiny: Research Twin contract; Jegan: architecture | BLOCKED |
| **E** | SMS attribution | Outbound queue, delivery callback, Dashboard publishers exist | Transport/publisher tests exist | Not verified | Authorized human: SMS lifecycle with matched callback | PARTIAL |
| **F** | Migrations and dependencies | 23 migration files; 7 audit findings documented/residual risk | CI workflow includes audit | Not verified | Migration reconciliation; DB allowlist verification | PARTIAL |

**Overall: NOT READY — EXTERNAL CONTRACTS / ACCEPTANCE REMAIN**

---

## 5. Rejected Codex Entry Corrections

See `docs/evidence/CST_Codex_Rejection_Corrections.md` for full details:

| Entry | Original Objection | Correction Status | Ready for Resubmission |
|---|---|---|---|
| 393 | `mission_fit_not_stated`, identity clarity | Documented with code references; BHA architecture boundary clarified | NO |
| 399 | `log_not_runbook`, 404 hypothesis, verbally handed off | Documented with evidence; production log access pending | PARTIAL |
| 29 October | `missing_engine_surfacing` | Data flow documented; live Research Twin integration blocked | PARTIAL |
| 30 October | `evidence_smoothed_over` | Code-level corrections documented; upstream verification pending | PARTIAL |

---

## 6. Production Verification

| Item | Status | Evidence |
|---|---|---|
| Render deployment SHA | NOT VERIFIED | Cannot access Render API per operating rules |
| Deployed SHA vs HEAD SHA | NOT VERIFIED | HEAD `97e9055...`; deployed unknown |
| `/health` endpoint | NOT VERIFIED | No production access |
| Startup evidence | NOT VERIFIED | No production access |
| vFarm connectivity | NOT VERIFIED | No production access |
| Sensor endpoint evidence | LOCAL VERIFIED | `engine/src/adapters/vfarm/live_client.ts:667-675`; 25 tests pass |
| Voice/text evidence | LOCAL VERIFIED | `tests/voice/*`, `tests/web/chat_pending_feedback.test.ts` |
| SMS evidence | NOT VERIFIED | Cannot send SMS per operating rules |
| Database and migration state | PARTIAL | 23 files; duplicate 003; drift 006/010 not reconciled |
| Evidence timestamp | 2026-11-02 | This report |

---

## 7. Test and CI Evidence

| Check | Command | Result | Count | Evidence |
|---|---|---|---|---|
| Unit tests | `npm test` | PASS (1 pre-existing isolation failure) | 1145 passed, 1 failed, 6 skipped | `vitest run` |
| Health tests | `npx vitest run tests/health/` | PASS | 32 tests | `tests/health/*` |
| Sensor tests | `npx vitest run tests/adapters/vfarm_per_sensor_classification.test.ts tests/connectors/vfarm_telemetry_mapping.test.ts` | PASS | 25 tests | `tests/adapters/*, tests/connectors/*` |
| Voice tests | `npx vitest run tests/voice/` | PASS | Multiple files | `tests/voice/*` |
| Text pending-feedback | `npx vitest run tests/web/chat_pending_feedback.test.ts` | PASS | 7 tests | `tests/web/chat_pending_feedback.test.ts` |
| Type check | `npm run typecheck` | PASS | — | `tsc --noEmit -p engine/tsconfig.json` |
| Build | `npm run build` | PASS | — | `tsc -b + copy_web_assets` |
| Security audit | `npm audit --audit-level=moderate` | 7 findings | 5 moderate, 2 high | `npm audit` output |
| CI workflow | `.github/workflows/ci.yml` | Created; not remotely run | — | GitHub Actions (no run URL) |
| Browser acceptance | Playwright | Not run locally (no Chromium binary) | 6 test cases | `tests/browser/pending_feedback.spec.ts` |

**Local vs CI vs Production:** All test results above are LOCAL only. CI has not been run remotely. Production has not been accessed.

---

## 8. Security and Dependency Findings

### Dependency Audit (7 findings)

| Dependency | Severity | Issue | Patched Via | Disposition |
|---|---|---|---|---|
| `follow-redirects` (via axios) | high | Cross-realm sensitiveHeaders discarded | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |
| `ajv` / `fast-uri` | moderate | Vulnerable fast-uri versions | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |
| `glob` (via swagger-jsdoc) | moderate | AbortSignal cancellation bypass | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |
| `minimatch` | moderate | DoS via globparts amplification | `npm audit fix --force` (breaks swagger-jsdoc) | Accepted residual risk |

**Justification:** `--force` installs `swagger-jsdoc@6.2.8` (breaking change). All findings are in dev/build-time tooling, not runtime request path. Risk accepted with owner=CST, date=2026-11-02.

### Migration State

- 23 migration files in `db/migrations/` (001-022, duplicate `003_` prefix)
- Production `schema_migrations` has 22 rows
- Duplicate `003` identity and drift warnings for `006`/`010` not reconciled
- No production changes authorized

### Database Security

- Historical concern: Render Postgres allowlist observed as `0.0.0.0/0`; requires re-verification (read-only)
- No production changes authorized

### Tenant Isolation

- `assertSpeakerFarmAccess()` verifies `speaker.farm_ids` includes `farmId` before vFarm calls
- Web interface ignores tenant/project/speaker/farm overrides
- All persisted rows carry `tenant_id` and `project_id`

### Twilio Signature

- `verifyTwilioSignature` on Twilio webhook routes
- Programmatic voice API guarded by `CST_API_KEY` middleware

### Identity Fail-Closed

- Missing live client → fail closed
- Project with no vFarm org ID → fail closed
- Expired/stale JWT → re-auth attempted; upstream 401 remains authoritative

---

## 9. Blocker Register

Full details in `docs/evidence/CST_Blocker_Register.md`.

| ID | Blocker | Severity | Owner | Status |
|---|---|---|---|---|
| B-01 | vFarm farm-health timestamp contract | High | Jeganathan / vFarm | OPEN |
| B-02 | Five-minute online rule confirmation | Medium | Jeganathan / vFarm | OPEN |
| B-03 | Never-heard device correction | Medium | Jeganathan / vFarm | OPEN |
| B-04 | `/readings/latest` permanent fix | High | Jeganathan / vFarm | OPEN |
| B-05 | Research Twin / BHA Engine contract | Critical | Destiny Arupi / Jeganathan | BLOCKED |
| B-06 | Research Twin credentials rotation | High | Destiny / Jason | OPEN |
| B-07 | DNS/TLS configuration (OYP9) | High | Jason / Platform | OPEN |
| B-08 | Render Postgres upgrade | Medium | Jason / Platform | OPEN |
| B-09 | Migration 020 approval | Medium | Jason | OPEN |
| B-10 | Migration reconciliation | Medium | CST / DB owner | OPEN |
| B-11 | Database network restriction | Medium | Platform / Jason | OPEN |
| B-12 | Real voice call acceptance | High | Authorized human | OPEN |
| B-13 | Real SMS acceptance | High | Authorized human | OPEN |
| B-14 | Browser acceptance screenshots | Medium | CST / tester | OPEN |
| B-15 | Remote CI run | Medium | CST / GitHub | OPEN |
| B-16 | Dependency audit residual risk | Low | CST | OPEN |

---

## 10. Commercial Impact

| Area | Customer Impact | Operational Reliability | Risk if Unresolved |
|---|---|---|---|
| Health semantics | Farm operators see accurate farm status | Prevents false "healthy" claims from missing/failed data | Misleading status → delayed incident response |
| Sensor endpoint (~271ms vs ~29.6s) | Fast sensor data in voice/text responses | Prevents voice turn timeouts and abandoned conversations | Callers receive no usable answer; support burden increases |
| Freshness/timestamp | Operators know if health data is current | Prevents stale data from driving decisions | Stale health presented as current → wrong operational calls |
| Research Twin | Incidents tracked through approved lifecycle | Investigation lifecycle synchronized CST↔Engine | Incidents lost or duplicated; no audit trail |
| Voice E2E | Callers reach CST and get answers | Call persistence and playback verified | Calls fail silently; no recourse for customers |
| SMS attribution | Delivery status accurately attributed | Callbacks matched to outbound rows | Delivery failures invisible; support burden increases |
| Help copy accuracy | Customers see states that match actual behavior | No mismatch between documentation and reality | Trust erosion; incorrect customer decisions |

---

## 11. Next Actions

### Ahad / CST (code work complete)
- No remaining CST code work — all locally-resolvable gaps implemented and tested
- Assist with browser acceptance screenshots when Chromium available
- Assist with remote CI run setup

### Jeganathan / vFarm
1. Confirm farm-health timestamp field for `GET /api/v1/farms/{farm_id}/health` (B-01)
2. Confirm five-minute online rule implementation and semantics (B-02)
3. Confirm never-heard device correction (B-03)
4. Deploy `/readings/latest` performance fix; provide before/after latency evidence (B-04)

### Destiny Arupi / Research Twin
1. Confirm approved n8n/Research Twin webhook contract (B-05)
2. Rotate exposed credentials (`RT_SERVICE_API_KEY`, `RT_CALLBACK_SIGNING_SECRET`) (B-06)

### Jason / Platform
1. Add CNAME at GoDaddy for `cst.bhanetwork.org` and `cst-admin.bhanetwork.org` → `bha-cst-7u9e.onrender.com` (B-07)
2. Add domains in Render dashboard; provision TLS certificates (B-07)
3. Upgrade Render Postgres from free tier before 14 Nov 2026 expiry (B-08)
4. Authorize migration `020_dashboard_publish_outcomes.sql` (B-09)
5. Verify database allowlist restriction (B-11)

### Authorized Human Tester
1. Conduct real voice call acceptance using test number and credentials (B-12)
2. Conduct real SMS acceptance lifecycle (B-13)

### Order by Dependency
1. Jegan/Destiny contracts (B-01 through B-06) — unblock CST freshness and Research Twin
2. Jason/Platform infrastructure (B-07 through B-11) — unblock deployment
3. Human acceptance (B-12, B-13) — unblock voice/SMS E2E
4. CST final verification (B-14, B-15) — complete evidence package

---

## 12. Jason Acceptance Request

**Areas ready for your review now:**
- Health semantics (PASS) — code and tests verified locally
- Text pending-feedback UX (PASS) — 7 DOM tests pass; browser tests ready
- Sensor endpoint interim implementation (PARTIAL) — code switched; tests pass; awaiting your/Jegan confirmation on `/latest` fix
- CI workflow (PARTIAL) — created; awaiting remote run
- Dependency risk acceptance (PARTIAL) — documented; all 7 findings are dev-tool-only

**Areas still blocked (require your action or external owner input):**
- vFarm timestamp contract → Jeganathan
- Research Twin contract → Destiny Arupi / Jeganathan
- DNS/TLS (OYP9) → Jason / Platform
- Render Postgres upgrade → Jason / Platform
- Migration 020 approval → Jason
- Real voice/SMS acceptance → Authorized human tester

**I am NOT requesting pay-gate closure.** 2 of 6 PDQ2 areas are BLOCKED; 4 are PARTIAL. External contract confirmation and human acceptance are required before pay-gate eligibility can be assessed.

---

## 13. Appendix — Evidence Index

Full evidence index: `docs/evidence/CST_Evidence_Index.md`

| Evidence ID | Area | Description | Source/Link | SHA | Timestamp |
|---|---|---|---|---|---|
| E-01 | Release identity | Repo, branch, HEAD, working tree | `git` commands | `97e9055...` | 2026-11-02 |
| E-02 | CI workflow | GitHub Actions definition | `.github/workflows/ci.yml` | — | 2026-11-02 |
| E-03 | Sensor endpoint | Interim `/readings?sensor_id=X&limit=1` | `engine/src/adapters/vfarm/live_client.ts:667-675` | `97e9055...` | 2026-11-02 |
| E-04 | Health semantics | `mapFarmHealthStatus()`, `/api/health` | `engine/src/app.ts:35-40,179-251` | `97e9055...` | 2026-11-02 |
| E-05 | Health tests | 32 health tests | `tests/health/*` | `97e9055...` | 2026-11-02 |
| E-06 | Sensor tests | 25 sensor tests | `tests/adapters/*`, `tests/connectors/*` | `97e9055...` | 2026-11-02 |
| E-07 | Text tests | 7 pending-feedback tests | `tests/web/chat_pending_feedback.test.ts` | `97e9055...` | 2026-11-02 |
| E-08 | Browser tests | 6 Playwright test cases | `tests/browser/pending_feedback.spec.ts` | — | 2026-11-02 |
| E-09 | Voice tests | Voice pipeline tests | `tests/voice/voice_*.test.ts` | `97e9055...` | 2026-11-02 |
| E-11 | Evidence doc | Consolidated acceptance evidence | `docs/evidence/cst-monitoring-pay-gate-acceptance.md` | — | 2026-11-02 |
| E-12 | Gap matrix | Implementation-to-acceptance gaps | `docs/evidence/cst-implementation-acceptance-gap-matrix.md` | — | 2026-11-02 |
| E-13 | PDQ2 matrix | Six-area acceptance matrix | `docs/evidence/CST_PDQ2_Acceptance_Matrix.md` | — | 2026-11-02 |
| E-14 | Blocker register | Owner-based blocker list | `docs/evidence/CST_Blocker_Register.md` | — | 2026-11-02 |

**No secrets, API keys, phone numbers, customer identities, or sensitive personal data are included in this report.**
