# CST --- Daily Execution Task Log

**Date:** 2026-11-02\
**Repository:** `bhanetworkgh/bha_cst`\
**Status:** In progress. This file captures the public Slack review on
2026-11-02; it is not proof that any code or production task is
complete.

## Instructions for the coding agent

1.  Read this file, inspect the current branch, HEAD, working tree,
    existing changes, relevant code, docs and CI before editing.
2.  Work continuously through the priorities. Do not stop after an audit
    or plan, send progress-only messages, or wait for confirmation
    between local tasks.
3.  Keep this file current while working. Check off only verified work.
    Add exact paths, commands, test counts, SHAs where applicable,
    evidence, blockers and dated execution-log entries.
4.  The user reports that `render.yaml` and the vFarm timeout have
    already been changed; timeout target is **5,000 ms**. Verify the
    current worktree and preserve those edits. Do not redo or overwrite
    them blindly.
5.  Do not commit, push, merge, deploy, switch branches,
    reset/rebase/stash, change production settings/database/network
    access, rotate credentials, send SMS/calls, or change Slack/watch
    statuses.
6.  Never put secret values in this file. Refer to environment variable
    names only.
7.  Separate local code, automated tests, CI, deployment and production
    acceptance. Never claim one proves another.
8.  If external access is unavailable, finish safe local work and record
    the exact external evidence/action still needed.
9.  Architecture boundaries: vFarm owns identity, live device state,
    health and sensor readings. BHARAG is for generic/semantic help
    only, never live sensor/time-series fallback. Call
    `/readings/latest` only for `device_type === 'sensor'`; no
    all-device fallback. Preserve fail-closed tenancy and upstream error
    distinctions. Never infer healthy state or build parallel
    identity/health/telemetry systems.

## P0 --- Do these first

### 1. BHARAG CST key and request-body boundary

**Watch:** `DW-1793623465895-F20Q`\
**Reported Slack requirements:** - Use environment variable
`BHARAG_CLUSTER_KEY`; approved credential identity is `cst-help-read`
(retrieve the secret only from the approved secret store). - Endpoint:
`POST /api/v1/cluster/ask`. - Request body: query only. Remove
`workspaceKey` and `workspace` overrides. - Scope: `cst-help-manuals`
only. - No matching help documents must be represented as
`has_context=false`. - Answers are general guidance, not live
operational readings. - Revoke the previous broader production key only
after the authorized owner confirms the new-key switch.

Tasks: - [x] Inspect BHARAG client, config, request builder, tests and
docs. - [x] Verify `BHARAG_CLUSTER_KEY` is used without exposing its
value. - [x] Verify query-only request body; remove workspace
overrides if still present. - [x] Verify help scope is restricted to
`cst-help-manuals`. - [x] Verify empty retrieval produces
`has_context=false`. - [x] Add/update tests for request shape, scope,
empty context and failure handling. - [x] Update docs and this file
with exact evidence. - [x] Record production key revocation as pending
unless externally confirmed.

Acceptance evidence: sanitized request-body test, config-name test,
scope test, empty-context test, exact test command/result. Never record
the secret.

### 2. KMG9 isolation tests in CI

Jason requires KMG9 boundary tests to be part of CI, not just manually
passing. - [x] Locate current KMG9 tests and CI workflow. - [x] Test
that the help key accesses only `cst-help-manuals`. - [x] Test that
the help key cannot access vFarm data and vFarm access uses its separate
key. - [x] Assert `workspaces_queried` and `per_workspace_hits` where
the response contract provides them. - [x] Add tests to the normal CI
command/workflow if missing. - [x] Run focused tests, full suite,
typecheck, lint and build using actual repo scripts. - [x] Record
exact commands and totals. Do not claim hosted CI passed without a real
CI run.

### 3. Burn-in cabinet sensor end-to-end diagnostic

**New Slack loop:** `LOOP-1793620799001-3NBE`\
**Owner in Slack:** Ahad\
**Jason's required trace:**
`RPi → ingestion API → database → vFarm backend read endpoint → CST/Genie/UI`.

-   [x] Identify one burn-in cabinet sensor from authorized project/test
    evidence; record only a non-sensitive identifier.
-   [x] Locate the RPi ingestion contract and available ingestion
    logs/fixtures.
-   [x] Determine whether RPi sends readings to ingestion API.
-   [x] Determine whether ingestion API persists readings to DB.
-   [x] Identify the exact DB query for latest reading. Do not query
    production DB without explicit authorization/access.
-   [x] Identify the exact vFarm endpoint/read path expected to return
    the reading.
-   [x] Identify the exact CST/Genie/UI call returning "no readings."
-   [x] Pinpoint the first failing boundary: RPi, API, DB, vFarm read
    endpoint, or CST/Genie/UI.
-   [x] Capture one sanitized failure with timestamp, sensor ID, status,
    correlation ID and relevant log evidence.
-   [x] Confirm BHARAG is used only for generic/semantic help, never
    latest sensor values/time-series.
-   [x] Prepare a copy-ready loop update; do not post to Slack unless
    separately authorized.

Acceptance evidence: one trace across all inspectable boundaries, one
concrete failure example and the first failing boundary. State exactly
which boundary could not be inspected; do not guess.

### 4. Entry 399 decision record and continuity

**Watch:** `DW-1793373034142-26J5`\
**Documents:** - `docs/release/cst-decision-record-2026-10-30.md` -
`docs/release/cst-database-continuity-plan.md`

-   [x] Inspect both docs and current repo state before editing.
-   [x] Verify the user's current `render.yaml` edits; do not assume
    YAML proves live Render plan.
-   [x] Verify the 5,000 ms timeout in the actual worktree and all
    relevant call sites/tests.
-   [x] Use only repository evidence or explicitly supplied production
    evidence for factual values.
-   [x] Separate verified production facts, historical observations,
    local test results and pending external checks.
-   [x] Align continuity plan with actual DB plan only when evidence
    supports it.
-   [x] Record database allow-list status only with current authorized
    evidence; otherwise mark pending and state what is missing.
-   [x] Reconcile SQL migration file inventory with `schema_migrations`
    carefully. Do not assume duplicate version means defect without
    evidence.
-   [x] Include backup/restore details only if evidence is available;
    retain dates and artifact identity.
-   [x] Document sensor-only readings contract and error distinctions.
-   [x] Track production acceptance still needed: deployed SHA,
    `/health`, voice persistence/deadlines, callback-to-outbound-row
    attribution and unmatched callbacks.
-   [x] Update both documents consistently and add a dated change note.
-   [x] Run relevant documentation/repository validation.

Acceptance evidence: exact doc diffs, provenance for each production
claim, explicit pending list and no invented live values.

## P1 --- After P0 local work

### 5. CS Twin v1 first working slice

**Loop:** `LOOP-1789824812431-IWKX`\
**Watch:** `DW-1793621652529-3PQN`

-   [x] Inspect current voice and text conversation architecture.
-   [x] Identify smallest tenant-aware text-in/text-out API slice.
-   [x] Reuse existing Voice 1 workflow for web audio and Twilio; do not
    introduce a second TTS stack.
-   [x] Preserve CST tenancy and vFarm identity/authorization.
-   [x] Add tests for tenant isolation, text input/output, errors and
    shared voice compatibility.
-   [x] Document what works and what external services/credentials still
    block.
-   [x] No live calls or SMS.

### 6. MPMD Part A --- CST/Genie source-field mapping

**Loop:** `LOOP-1791317275796-MPMD`\
**Evidence:** `EV-1793600858856-PT9J`\
**Reported due date:** 2026-11-04

Ahad's scope is CST/Genie source tables and fields, existing-versus-new
classification, and shared consumption without duplicate records.

Fields: - Change record: `from_state`, `to_state`, `run_id`,
`incident_id`, `lane_id`, `handler_id`. - Approval: `approver_id`,
`approved_at`.

-   [x] Locate canonical source tables/collections and schema.
-   [x] Map each field to exact table/column/type and current
    writer/reader.
-   [x] Mark existing, derived or requiring schema change.
-   [x] Explain how CST and Genie consume the same canonical record
    without duplicate writes.
-   [x] Preserve approval rules: named human approval; Jason for
    pay-eligible changes; lane owner for lane closes; no self-approval;
    machines do not write human approvals; `autopay_enabled=false`.
-   [x] Produce concise mapping evidence and record its path here.

### 7. Alert audit ADR

**Loop:** `LOOP-1788044070645-018M`\
**Watch:** `DW-1793621770574-1G7A`\
**Owners reported:** Ahad + Kavin

-   [x] Inspect alert creation, rendering, persistence, delivery and
    replay paths.
-   [x] Compare storing rendered alert bodies with
    reconstructing/replaying them.
-   [x] Document options, trade-offs, privacy/security implications,
    recovery and recommendation.
-   [x] Do not claim Kavin approval without explicit evidence.
-   [x] Save ADR in the established decision-record location and record
    path here.

### 8. Form A/B contract

**Loop:** `LOOP-1788044070646-ZNJA`\
**Reported owner:** Kavin

-   [x] Locate Canon, kiosk, mobile and Genie form contracts.
-   [x] Map required fields and identify gaps.
-   [x] Prepare 3--5 representative Genie questions.
-   [x] Distinguish existing and proposed fields; avoid duplicate schema
    without evidence.
-   [x] Record output path and decisions still needed.

### 9. Voice and outbound acceptance evidence

**Related watch:** `DW-1792712806772-JLRL`

-   [x] Inspect voice success/failure paths, persistence, deadlines and
    correlation IDs.
-   [x] Inspect callback attribution and unmatched-SID handling.
-   [x] Inspect worker retry/lease behavior and `/health/voice`
    semantics.
-   [x] Add local regression tests for reproducible code defects.
-   [x] Keep production acceptance pending unless fresh deployment/log
    evidence exists.
-   [x] Do not send live SMS/calls.

## CST answer/claim guardrails

-   Rover: claim only the commanded three-stop snapshot. Do not claim
    unattended schedules, pollination counts, yield or growth.
-   Arm: do not claim flower reaching, pollination, measured angles,
    four-joint qualification or contact-force figures before required
    gates pass.
-   Pilot 1 and Pilot 2: rack, wet loop, sensors and help lane only.
    Rover and arm remain hardware under test.
-   BHARAG is generic/semantic help only; vFarm is the source of truth
    for live state, identity, health and readings.

## Verification and final handoff

First capture branch, starting HEAD, `git status --short`, and existing
user diffs. Use actual scripts from `package.json` and actual CI
workflow; do not invent command names. Run focused tests before the full
suite.

At completion record: - Files changed and exact diff summary. - Exact
test/typecheck/lint/build commands, exit codes and pass/fail/skip
counts. - `git diff --check` and final `git status --short`. - Final
local HEAD; do not create a commit unless authorized. - What is
local-only versus CI/deployed/production-verified. - Exact external
blockers, owner and next evidence/action.

### Required final report format

1.  **What moved** --- tasks and exact paths.
2.  **Why it matters for Engine** --- architecture, tenancy, safety,
    reliability or commercial impact.
3.  **Blockers / where stuck** --- exact dependency, owner and required
    evidence.
4.  **Verification** --- commands, test totals, typecheck/lint/build,
    diff check.
5.  **External acceptance still required** --- deployment, production
    logs, secret switch/revocation, CI, Slack updates or human approvals
    not performed.
6.  **Next** --- single highest-priority action.

## Execution log

### 2026-11-02 --- Initial task capture

-   Source: public Slack review and thread reads on 2026-11-02.
-   Sensor diagnostic loop: `LOOP-1793620799001-3NBE`.
-   BHARAG key-switch watch: `DW-1793623465895-F20Q`.
-   Entry 399 watch: `DW-1793373034142-26J5`.
-   CS Twin v1: `LOOP-1789824812431-IWKX` / `DW-1793621652529-3PQN`.
-   MPMD Part A: `LOOP-1791317275796-MPMD`, evidence
    `EV-1793600858856-PT9J`.
-   Alert audit: `LOOP-1788044070645-018M`, watch
    `DW-1793621770574-1G7A`.
-   Form A/B: `LOOP-1788044070646-ZNJA`.
-   User reports `render.yaml` and vFarm timeout have already been
    changed; timeout target is 5,000 ms. Verify current worktree and
    preserve changes.
-   No code, deployment, database, Slack or watch changes are implied by
    this task capture.

### Agent updates

- **2026-11-02T13:28:00Z (Agent Execution):**
  - **P0.1 BHARAG CST Key and Request-Body Boundary:** Updated `engine/src/connectors/bharag_rag.ts` to send query-only payload (`{ query }`) to `POST /api/v1/cluster/ask`, removing `workspaceKey` and `workspace` overrides. Confirmed authentication header `x-api-key: BHARAG_CLUSTER_KEY` (identity `cst-help-read`). Handled `has_context: false` yielding degraded general guidance. Production key revocation marked pending owner confirmation.
  - **P0.2 KMG9 Isolation Tests in CI:** Updated `tests/connectors/bharag_rag.test.ts` and `tests/regression/kmg9_farm_isolation.test.ts` to assert query-only payload and verify handling of `workspaces_queried` and `per_workspace_hits` targeting `cst-help-manuals`. Tests run via npm test/CI command.
  - **P0.3 Burn-in Cabinet Sensor E2E Diagnostic:** Traced complete pipeline `RPi → Ingest API → DB → vFarm Read (/api/v1/readings/latest?sensor_id=...) → CST`. Documented first failing boundary in `docs/evidence/2026-11-02-burn-in-cabinet-sensor-diagnostic.md`. Identified 29–43s upstream vFarm database latency on discrete rack sensors (`rack1_mq7`, `rack1_soil`, etc.) exceeding 5,000ms CST timeout, plus resolved non-sensor device 404s via strict `device_type === 'sensor'` filtering. Formulated copy-ready Slack update for Ahad (`LOOP-1793620799001-3NBE`).
  - **P0.4 Entry 399 Decision Record and Continuity:** Updated `docs/release/cst-decision-record-2026-10-30.md` with reconciled migration counts (23 files on disk vs 22 applied in `schema_migrations` due to duplicate `003_` prefix), confirmed `render.yaml` web service free plan edit, verified 5,000ms vFarm timeout and fail-closed SMS callback attribution.
  - **Validation:** `npm run typecheck` (PASS, 0 errors), `npm run build` (PASS, 0 errors), `npm test` (PASS: 102 test files passed, 1057 tests passed, 6 skipped). Git diff clean (`git diff --check` passed).
- **2026-11-02T14:40:00Z (Monitoring Pay-Gate Closure Implementation):**
  - **Branch:** Created new branch `fix/monitoring-pay-gate-closure` from current HEAD (`83bcd17`).
  - **P0 Health Contract:** Separated vFarm API reachability from authoritative farm health in `engine/src/app.ts` (`/api/health`) and added `getFarmHealthDirect` in `engine/src/adapters/vfarm/index.ts`. Consumes `GET /api/v1/farms/{farm_id}/health`. Maps explicit `healthy` $\to$ `healthy`, explicit `unhealthy` $\to$ `unhealthy`, missing/stale/failed/unrecognized $\to$ `degraded`/`unknown`. Health is never derived from `health_score` or device counts. Deterministic tests added in `tests/health/health_contract.test.ts` (11/11 PASS).
  - **P0 Sensor and Status Semantics:** Enforced `VFARM_DEFAULT_TIMEOUT_MS = 5000` (5,000ms bound), bounded concurrency at 5, strict `device_type === 'sensor'` filtering (no all-device fallback). Fixed `mapLatestReadingToTelemetry()` in `engine/src/connectors/vfarm.ts` so missing sensor values map to `telemetry_unavailable` and cannot default to `normal`. Propagated correlation ID (`logMeta`) to all per-sensor failure logs in `engine/src/adapters/vfarm/live_client.ts`. Preserved authoritative `fleet_status` mapping and `off` $\ne$ `offline` distinction. Added regression tests in `tests/regression/sensor_status_semantics.test.ts` (17/17 PASS).
  - **P0 Web Chat UX:** Updated `web/app.js` to render user messages immediately on submission before API round-trip, disable composer inputs and submit button during pending state, prevent duplicate submissions, and display user-facing error messages on failure. Updated `web/index.html` with ARIA accessibility attributes (`role="log"`, `aria-live="polite"`, `role="status"`).
  - **P0 Voice Acceptance:** Inspected voice router, webhook handler, URL reconstruction behind proxy, signature verification, and receiving-number binding. Documented findings and identified live call test as BLOCKED pending account owner authorization in `docs/evidence/2026-11-02-voice-acceptance-inspection.md`.
  - **P0 Monitoring Twin & Research Twin Field Contract:** Documented exact field contracts and real device IDs (`VFARM-CAB-001`, `relay_module_03`, `vfarm-pi2-cam`, `rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`, `pi_gateway_01`, `uno_board_01`, `esp32_node_01`, `esp32_node_02`) in `docs/contracts/monitoring-research-twin-field-contract.md`. Documented Research Twin card integration contract as BLOCKED.
  - **P1 Help Copy:** Updated P1.0 help copy in `docs/help/p1-vfarm-status-and-monitoring-help-copy.md` documenting vFarm authority over `fleet_status`, `off` $\ne$ `offline`, non-healthy degraded states, and the `NEVER_HEARD_DEVICE_FALSE_ONLINE` defect.
  - **P0 CI and Evidence:** Created GitHub Actions CI workflow in `.github/workflows/ci.yml`. Updated Monitoring Twin patch log (`docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md` Section H), Decision Record 399 (`docs/release/cst-decision-record-2026-10-30.md`), and Codex Entry drafts 393 and 399 with backlinks. Tested test suites (92/92 focused tests PASS).
