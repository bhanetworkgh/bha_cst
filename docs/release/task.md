# BAYS & CST Task Tracker — Status and Next Actions

**As of:** 19 October 2026 (Updated: 2026-10-19T18:55:00+05:00 / 13:55:00 UTC)  
**Owner:** Ahad (`U0AC6RFNP3P`)  
**Active Render Commit:** `3e88058a987b4cad0c72dfc3c94c75c8a353e96d` (Deploy `dep-db98vidg1s2s73bun8eg`, status: `live`)  
**Render Health:** HTTP/2 200 `{"status":"ok","service":"bha-cst-engine"}` verified fresh at 2026-10-19T13:53:25Z (cold-wake: ~14.7s; initial timeout at 15s; historical check: 2026-10-19T13:33:52Z)  
**Slack Integration Note:** This environment has no native Slack integration. External Slack findings and loop details for VU6R and related loops were supplied directly from a separate connected ChatGPT session. Mark any additional external verification as pending.

## Status key

- **DONE** — completion is supported by verifiable evidence.
- **LOCAL WORK COMPLETED** — code, tests, and documentation verified in local repository.
- **RENDER EVIDENCE OBSERVED** — independently observed and verified via authenticated Render CLI / logs.
- **IN PROGRESS** — work or verification has started but is not complete.
- **BLOCKED** — a dependency, missing credential, or external access prevents completion.
- **AWAITING APPROVAL** — deliverable prepared; awaiting formal owner sign-off before execution.
- **PENDING** — work has not yet been verified as started or completed.

> Do not mark a loop closed solely because preparation is complete or local tests pass. Preserve the distinction between code-level evidence, production verification, and formal acceptance.

---

## Tracked Infrastructure & Runtime Issues

1. **Database Expiry Deadline (14 November 2026 at 18:10:20 UTC)**:
   - Resource `dpg-db8he2qvcj2c73ado3s0-a` (`bha-cst-postgres`) is on Render Free tier with a hard 90-day expiration (`expiresAt: "2026-11-14T18:10:20.49769Z"`).
   - Requires Jason Bays / Platform Owner approval to upgrade to Starter tier ($7/mo) before cutoff. Do not trigger billing without explicit authorization.
2. **Duplicate Migration Prefix 003 Warning**:
   - Render startup logs warn: `⚠ Duplicate migration prefix(es): 003 (003_add_customers_and_security_ledger.sql, 003_customers_table.sql). They are applied in filename order and recorded individually. Do not rename them.`
   - Tracked and verified harmless: `scripts/migrate.js` handles duplicate numeric prefixes safely by applying in alphabetical sequence with individual ledger entries. Do not rename migrations or alter migration history.
3. **Free Tier Cold-Wake Latency & Transient 502s**:
   - Render free tier web service hibernates after 15 minutes of inactivity. Cold wake takes 14–17 seconds. Probes with short timeouts (<15s) receive HTTP 502 or timeout during startup before the container finishes binding to port 10000. Waking succeeds into stable HTTP 200. This does not establish a persistent outage.
4. **Database Direct Access Ingress Protection**:
   - Database IP allowlist is empty `[]`. Attempted direct connection via `render psql dpg-db8he2qvcj2c73ado3s0-a -c "SELECT version();" -o text` exited with code 1 (`Error: IP address (103.120.71.129) not in allow list for bha-cst-postgres`). Network security preserved without modifying allowlist. Do not alter the allowlist without authorization.
5. **Independent Live Schema Proof Caveat**:
   - Startup logs report 19 recorded migrations (`0 applied, 19 already recorded`), but a migration ledger entry is not independent proof that all expected live schema objects (constraints, indexes, foreign keys, triggers) exist in the PostgreSQL database. Direct SQL access is blocked by the empty IP allowlist `[]`; schema verification remains pending.

---

## Task 1 — Destiny's CST security issue

**Loop:** `LOOP-1790790007707-5R0J`  
**Lane:** CST  
**Raised by:** Destiny Arupi  
**Status:** IN PROGRESS — LOCAL WORK COMPLETED; RENDER EVIDENCE OBSERVED; AWAITING AUDIT LOG REVIEW & DESTINY ACCEPTANCE.

### Objective
Prevent unauthenticated access to CST routes and determine whether sensitive farm data or admin JWTs were previously exposed.

### Done
- [x] Local regression tests passing: [`tests/security/vfarm_proxy_unauth.test.ts`](../../tests/security/vfarm_proxy_unauth.test.ts) — 26/26.
- [x] Live Render deployment verified via Render CLI (`render deploys list srv-db8hepqvcj2c73adpus0`): Commit `3e88058` live via deploy `dep-db98vidg1s2s73bun8eg`.
- [x] Production unauthenticated checks returned HTTP 401 across 8 endpoint variants (`/api/devices`, `/api/v1/devices`, `/api/farms`, `/api/v1/farms`, `/api/dashboard`, `/api/v1/dashboard`, `/api/tokens`, `/api/v1/tokens`).
- [x] Render live logs (`render logs -r srv-db8hepqvcj2c73adpus0`) show 8 matching `SECURITY_LEDGER` entries at `2026-10-19T12:30:11.359Z` through `12:30:18.187Z` with `outcome: "refused"` and `reason: "Unauthenticated vFarm proxy request (no CST admin session, no vFarm JWT)"`.
- [x] Documented audit scope, findings, log query filters, and residual risk in [cst-5r0j-security-audit-and-residual-risk.md](cst-5r0j-security-audit-and-residual-risk.md).
- [x] Preserved residual risk statement pending historical log review.

### Remaining
- [ ] Authorized operator reviews historical Render production logs for potential farm-data or admin-JWT exposure prior to patch deployment.
- [ ] Obtain formal security acceptance from Destiny Arupi before closing the loop.

### Why it matters
Current rejection of unauthenticated requests does not prove there was no historical exposure prior to patch deployment.

**Next action:** Provide audit queries from [cst-5r0j-security-audit-and-residual-risk.md](cst-5r0j-security-audit-and-residual-risk.md) to authorized operator for historical log review; obtain Destiny's sign-off.

---

## Task 2 — Client 2 Commissary Ops Twin working session

**Loop:** `LOOP-1791922936305-VU6R`  
**Lane:** CST  
**Raised by:** Jason Bays, 13 October 2026  
**Assignee:** Ahad (`U0AC6RFNP3P`)  
**Due:** 20 October 2026  
**Decision watch:** `DW-1792414988891-UJJ2` (Supplied reminder: Tuesday, Oct 20, 2026, 14:03 Lagos time; preserved as context)  
**Related card:** `CARD-1791918264578-MTUW` (Client confirmation card — positive interest recorded, not working session proof)  
**Research job:** `JOB-1791920562929-V1R8` (Resolved — industry research supports initial design)  
**SOP reference:** `b248bd76-efc0-4f32-9c3d-b6f4997fbbca`  
**Slack references for human follow-up:**  
- [Thread p1791922548279039](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1791922548279039?thread_ts=1791922548.279039&cid=C0ASMPYQLG3)  
- [Thread p1792414579523679](https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792414579523679?thread_ts=1792414579.523679&cid=C0ASMPYQLG3)  
**Status:** OPEN — LOCAL PREPARATION COMPLETE; CLIENT SOURCE-CHECK & WORKING-SESSION VALIDATION PENDING.

### Objective
Arrange and run a 45–60 minute working session with Client 2 to validate the proposed Commissary Ops Twin v0 design against actual kitchen booking, handover, cleaning, verification, and health-inspector requirements.

### Done
- [x] Incorporated authoritative loop text, research job details (`JOB-1791920562929-V1R8` resolved), client card (`CARD-1791918264578-MTUW`), and Decision Watch (`DW-1792414988891-UJJ2`) supplied from external Slack session.
- [x] Prepared working-session agenda (45–60 min) and validation-table template in [cst-vu6r-prep.md](cst-vu6r-prep.md).
- [x] Documented kitchen operational state machine: `BOOKED → IN_USE → CLEANED_CLAIMED → READY / NOT_READY`.
- [x] Documented append-only, signed, cryptographically chained event ledger requirements, verification rules, and defined evidence threshold for `READY`.
- [x] Documented three open design questions:
  1. Photo capture frequency: whether photos are required for every visit or sampled.
  2. Commercial model: whether operator pays, BHA bundles service, or hybrid.
  3. Regulatory requirements: which applicable licensing/inspection requirements affect required ledger events.
- [x] Formulated targeted outreach message for Jason Bays in [cst-vu6r-prep.md](cst-vu6r-prep.md).
- [x] Reconciled blocker context in [cst-vu6r-blocker.md](cst-vu6r-blocker.md).

### Remaining
- [ ] Ahad completes and reports the exact client/contact source checked (Codex/CRM records, dashboard/North Star access attempts, and what each returned).
- [ ] Identify designated Client 2 contact (Jason may assist, but Ahad retains primary assignee responsibility).
- [ ] Confirm whether working session is already scheduled or held.
- [ ] Validate booking, handover, cleaning, verification, and responsibility transfer during client session.
- [ ] Confirm practical meanings of `READY` and `NOT_READY` with operating kitchen staff.
- [ ] Confirm local health-inspector requirements and required records.
- [ ] Validate append-only signed ledger and dispute/correction handling.
- [ ] Record client-confirmed requirements, design changes, owners, and unresolved questions.

### Proposed workflow

`BOOKED → IN_USE → CLEANED_CLAIMED → READY / NOT_READY`

### Why it matters
The client's positive response on CARD-MTUW is encouraging, but real kitchen workflow and inspection requirements still need client-specific validation.

**Next action:** Ahad reports the source-check results across internal records and coordinates with Jason Bays to identify Client 2 contact and confirm working session status.

---

## Task 3 — Ship CS Twin v1 / release-readiness review

**Loop:** `LOOP-1789824812431-IWKX`  
**Lane:** CST  
**Launch target:** 31 October 2026  
**Status:** ASSESSED — LOCAL WORK COMPLETED; BLOCKED ON THREE EXTERNAL GATES.

### Objective
Determine whether CST v1 is ready for release, using explicit evidence for each acceptance criterion.

### Review checklist
- [x] Tenant isolation and project/system routing — **VERIFIED** ([`tests/tenancy/platform_tenancy.test.ts`](../../tests/tenancy/platform_tenancy.test.ts) 8/8, [`tests/tenancy/project_org_id_mapping.test.ts`](../../tests/tenancy/project_org_id_mapping.test.ts) 6/6 pass).
- [x] Authentication and webhook security — **VERIFIED** ([`tests/security/vfarm_proxy_unauth.test.ts`](../../tests/security/vfarm_proxy_unauth.test.ts) 26/26 pass, Twilio signature validation verified).
- [x] SMS consent and opt-in enforcement — **VERIFIED** ([`tests/consent/consent_spine.test.ts`](../../tests/consent/consent_spine.test.ts) 28/28, [`tests/consent/a2p_operational_acceptance.test.ts`](../../tests/consent/a2p_operational_acceptance.test.ts) 10/10 pass).
- [ ] SMS, voice, and web production paths — **BLOCKED** (local tests pass; live production SMS/voice requires approved test window and recipients).
- [x] vFarm connectivity and fail-closed behavior — **VERIFIED** ([`tests/adapters/vfarm_live_contract.test.ts`](../../tests/adapters/vfarm_live_contract.test.ts) 18/18, [`tests/regression/kmg9_farm_isolation.test.ts`](../../tests/regression/kmg9_farm_isolation.test.ts) 9/9 pass).
- [x] BHARAG integration and fallback safety — **VERIFIED** (no BHARAG fallback for farm telemetry; payloads strip `farm_id`/`unit_id`).
- [ ] Database migrations and live schema — **BLOCKED** (Render CLI shows 19 applied; direct psql connection blocked by empty IP allowlist `[]`).
- [x] Admin UI and required operational workflows — **VERIFIED** ([`tests/admin/vfarm_users_and_grants.test.ts`](../../tests/admin/vfarm_users_and_grants.test.ts) 4/4, [`tests/admin/admin_api.test.ts`](../../tests/admin/admin_api.test.ts) 14/14 pass).
- [x] Logging, auditability, health checks, and rollback — **VERIFIED** (`SECURITY_LEDGER` audit trail active; `/health` returns HTTP 200 at 2026-10-19T13:33:52Z).
- [x] Deployed commit identity verified via Render CLI — **VERIFIED** (Deploy `dep-db98vidg1s2s73bun8eg`, commit `3e88058a987b4cad0c72dfc3c94c75c8a353e96d`).

### Three External Blockers
1. **Infrastructure & Hosting (OYP9)**: Render plan upgrade from free tier to Starter ($7/mo) to eliminate hibernation cold-starts (502s) and 14 Nov 2026 DB expiry; custom domain CNAME and TLS provisioning (`cst.*` / `cst-admin.*`).
2. **Database Verification (HOFE)**: Production/staging database schema verification for migrations 017 and 018 (direct psql blocked by empty allowlist `[]`).
3. **Partner Gate Acceptance (KMG9)**: Jason's live vFarm smoke test acceptance (`DW-19QD`) and Jegan's BHARAG key-scope proof (`DW-53P7`). Plus explicit authorization for live SMS/voice E2E smoke tests.

### Comprehensive Assessment Report
Detailed findings documented in [cst-v1-release-readiness-assessment.md](cst-v1-release-readiness-assessment.md).

---

## Task 4 — SMS consent spine

**Loop:** `LOOP-1791467054702-NI8F`  
**Lane:** CST  
**Status:** LOCAL WORK COMPLETED (38/38 tests passing); AWAITING LIVE TEST APPROVAL & EXTERNAL ACCEPTANCE.

### Objective
Establish and verify the canonical SMS opt-in/consent workflow.

### Checklist
- [x] Identify authoritative consent requirements and canonical opt-in surface (CTIA / A2P 10DLC compliance).
- [x] Trace consent capture, persistence, lookup, send enforcement, and opt-out/revocation.
- [x] Verify tenant/project scoping (opt-outs in Tenant A never suppress Tenant B).
- [x] Test missing, invalid, withdrawn, duplicate, and valid consent cases ([`tests/consent/consent_spine.test.ts`](../../tests/consent/consent_spine.test.ts) — 28/28 pass).
- [x] Test operational A2P lifecycle cases ([`tests/consent/a2p_operational_acceptance.test.ts`](../../tests/consent/a2p_operational_acceptance.test.ts) — 10/10 pass). Total: 38/38 pass.
- [x] Verify that prohibited messaging fails closed (outbound worker checks consent state before queue dispatch).
- [x] Reconcile implementation with migrations 016, 017, and 018.
- [x] Verified Render startup logs: `already applied, skipping: 017_sms_consent_audit_fk.sql` and `already applied, skipping: 018_sms_consent_prompts.sql` confirmed at 2026-10-19T13:08:32Z, 13:33:17Z, and fresh at 13:53:11Z.
- [x] Record test results and trace verification in [cst-sms-consent-verification-record.md](cst-sms-consent-verification-record.md).
- [ ] Obtain explicit approval, designated test recipient, and approved window for live SMS smoke test. Local passing tests (38/38) are not proof of a live carrier SMS round trip.

---

## Task 5 — Database migrations 017/018 and end-to-end tests

**Loop:** `LOOP-1791826143428-HOFE`  
**Lane:** CST  
**Decision watch:** `DW-1791829227726-96O8`  
**Status:** IN PROGRESS — LOCAL WORK COMPLETED; RENDER LOGS VERIFIED; DIRECT PSQL BLOCKED BY ALLOWLIST; AWAITING DW-96O8 DECISION.

### Objective
Verify consent-related migrations, schema requirements, and end-to-end behavior in the intended environments.

### Done
- [x] Render startup logs confirmed via CLI: `0 applied, 19 already recorded` confirmed at `2026-10-19T13:08:32Z`, `2026-10-19T13:33:17Z`, and fresh at `2026-10-19T13:53:11Z` including migrations 017 and 018.
- [x] Migration code, idempotency, checksums, advisory locks, triggers, and constraints verified in local repo.
- [x] Prepared non-mutating SQL verification checklist in [cst-ho-fe-schema-verification-guide.md](cst-ho-fe-schema-verification-guide.md).
- [x] Attempted direct connection via Render CLI: `render psql dpg-db8he2qvcj2c73ado3s0-a -c "SELECT version();" -o text` exited with code 1 (`Error: IP address (103.120.71.129) not in allow list for bha-cst-postgres`). Network security preserved; no allowlist modifications made. Do not alter the allowlist without authorization.
- [x] Tracked decision watch `DW-1791829227726-96O8` (production-only evidence vs staging acceptance).

### Remaining
- [ ] Authorized database operator executes SQL checks from [cst-ho-fe-schema-verification-guide.md](cst-ho-fe-schema-verification-guide.md) against Render Postgres.
- [ ] Confirm live tables, constraints, indexes, foreign keys, and `sms_consent_audit` append-only trigger. A migration ledger entry is not independent proof that all expected live schema objects exist.
- [ ] Confirm `idx_sms_consent_prompts_active_unique` on `sms_consent_prompts`.
- [ ] Resolve `DW-1791829227726-96O8` by obtaining owner sign-off on production schema evidence.

---

## Task 6 — PostgreSQL database expiry/migration

**Loop:** `LOOP-1792104121807-XXHH`  
**Lane:** CST / infrastructure dependency  
**Resource:** `dpg-db8he2qvcj2c73ado3s0-a` (`bha-cst-postgres` / `bha_cst_1sh0`)  
**Reported expiry:** 14 November 2026 at 18:10:20 UTC (Render 90-day free DB limit)  
**Status:** PLAN COMPLETE (Planning deliverable only); AWAITING OWNER APPROVAL & UPGRADE EXECUTION.

### Objective
Prepare a safe migration or upgrade plan for the free PostgreSQL database before the reported expiry.

### Checklist
- [x] Verified database resource via Render CLI: ID `dpg-db8he2qvcj2c73ado3s0-a`, plan `free`, version `16`, status `available`, `expiresAt: "2026-11-14T18:10:20.49769Z"`, `ipAllowList: []`.
- [x] Target plan evaluated: Render Starter PostgreSQL ($7/mo, 1GB RAM, 25GB disk, automated daily backups, no expiry).
- [x] Verify backup availability and restoration procedure (`pg_dump` pre-flight export + `pg_restore`).
- [x] Document planned 5–10 minute cutover window, data validation SQL queries, and rollback steps in [cst-database-continuity-plan.md](cst-database-continuity-plan.md).
- [ ] Obtain explicit written approval from Jason Bays / Platform Owner for target cost ($7/mo) and cutover schedule.
- [ ] Execute upgrade in Render dashboard during approved maintenance window.
- [ ] Validate zero data loss across critical tables post-cutover.

---

## Task 7 — CST clone-quality gate, Step 2

**Loop:** `LOOP-1791991972916-G718`  
**Lane:** CST  
**Dependency:** Formal acceptance of `LOOP-1788044070647-KMG9`  
**Decision watches:** `DW-19QD` and `DW-53P7`  
**Status:** BLOCKED — AWAITING FORMAL KMG9 ACCEPTANCE & BHARAG KEY-SCOPE PROOF.

### Objective
Complete the clone-quality gate only after its required safety dependency has been formally accepted.

### Done
- [x] KMG9 regression tests passing: 9/9 ([`tests/regression/kmg9_farm_isolation.test.ts`](../../tests/regression/kmg9_farm_isolation.test.ts)).
- [x] Fail-closed logic and removal of BHARAG fallback verified in code ([`kmg9-verification-record.md`](../kmg9-verification-record.md)).
- [x] Step-by-step test instructions prepared for Jason in [cst-kmg9-live-test-instructions.md](cst-kmg9-live-test-instructions.md).
- [x] Verified Render live logs show zero BHARAG fallback attempts for farm status requests.

### Remaining
- [ ] Jason runs the 3 live test scenarios against deployed instance per [cst-kmg9-live-test-instructions.md](cst-kmg9-live-test-instructions.md) and signs off (`DW-19QD`).
- [ ] Jegan confirms BHARAG cluster-key scoping and policy proof (`DW-53P7`).
- [ ] Reconcile formal KMG9 closure evidence before initiating G718 clone-quality checks.
- [ ] Run G718 checks against clone quality acceptance criteria once unblocked.

---

## Task 8 — Operator Playbook SOP

**Loop:** `LOOP-1791848474090-Y5TW`  
**Lane:** **BAYS**  
**Raised by:** Destiny Arupi, 12 October 2026  
**Assignee:** Ahad (`U0AC6RFNP3P`)  
**Status:** DRAFT COMPLETE (IN REPOSITORY) — AWAITING CODEX/BHARAG PUBLICATION & DESTINY SIMULATION TEST.

### Objective
Make sure Bays can find, understand, and continue your work when you are unavailable.

### Deliverables
- [x] Named second operator for each area (Primary: Ahad, Second: Syed, Backup: Jegan).
- [x] Set and logged daily availability window (09:00 – 09:45 EST / 18:00 – 18:45 PKT).
- [x] Heads-down handoff protocol and template established.
- [x] Documented work locations and AI assistant connection instructions.
- [x] Documented common blockers and step-by-step fixes across 4 core areas (build, webhooks, migrations, telemetry).
- [x] Defined solo permissions, rationales, and standby procedures (zero secrets exposed).
- [x] Established escalation path: Owner → Second Operator at 1h → Team Huddle.
- [x] Access management locations recorded without passwords or tokens.
- [x] Formatted SOP for Codex → SOPs and BHARAG ingestion in [operator-playbook-sop.md](operator-playbook-sop.md).
- [ ] Publish SOP to dashboard under Codex → SOPs.
- [ ] Ingest SOP into BHARAG under `sop/bays-cst-operations`.
- [ ] Coordinate Destiny's live simulation drill (unannounced blocker triage).

---

## Recommended execution order

1. **VU6R:** Ahad reports source-check findings across internal records and sends outreach note to Jason regarding Client 2 working session (due 20 October).
2. **Y5TW:** Deliver the completed Operator Playbook SOP to Destiny for review and live-test scheduling.
3. **5R0J:** Provide security audit queries to authorized operator for Render log review; obtain Destiny's sign-off.
4. **IWKX:** Present the read-only Release Readiness Assessment report to team.
5. **NI8F + HOFE:** Share SMS consent verification record and SQL schema validation guide with DB operator.
6. **XXHH:** Submit Database Continuity and Upgrade Plan to Jason/Platform team for approval.
7. **G718:** Request formal KMG9 closure from Jason and Jegan before initiating Step 2 clone quality gate.
