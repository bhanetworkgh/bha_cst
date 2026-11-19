# IWKX PR #55 Reliability & Acceptance Queue — Consolidated Evidence Report

**Document Path:** `docs/operations/IWKX_RELIABILITY_FIX.md`  
**Target Loop:** `LOOP-1789824812431-IWKX` (Ship CS Twin v1)  
**Pull Request:** [#55 — Lifecycle persistence before post-call dispatch](https://github.com/bhanetworkgh/bha_cst/pull/55)  
**PR Branch:** `fix/iwkx-persistence-readiness`  
**Implementation Head:** `beac8cb052960d01575cc5bc0242a3c28046eb77`  
**Successor CI Run:** [Run #117 (ID: 43462247410)](https://github.com/bhanetworkgh/bha_cst/actions/runs/43462247410)  
**Review Status:** **REVIEW READY — ACCEPTANCE PENDING EXTERNAL GATES**  
**Cut-Over Status:** `CST_CUTOVER_APPROVED=false` (Preserved strictly as required)  

---

## 1. What Moved (In Jason's Specified Sequence)

### 1.1 CI #112 Vitest Correction
- **Original Failure:** In CI Run #112 (ID `43428298049`, commit `0d969af`), the test suite `tests/interfaces/elevenlabs_caller_identity.test.ts` failed during execution because PR #55 introduced a mandatory transactional lifecycle call (`DbClient.recordRequiredDashboardOutcomes`), but the test file's mock of `DbClient` only mocked `recordDashboardPublishOutcome`.
- **Vitest Correction in `beac8cb`:**
  - Mock updated: Added `recordRequiredDashboardOutcomes: vi.fn().mockResolvedValue(undefined)` to `DbClient` mock.
  - Strengthened Assertions: Verified that valid callers trigger `DbClient.recordRequiredDashboardOutcomes` once with 3 outcomes carrying the caller's E.164 phone (`+12025550123`); verified that invalid callers trigger 0 calls; and verified that duplicate webhooks trigger 0 calls on redelivery.
- **Successor CI Run #117:** Run ID [`43462247410`](https://github.com/bhanetworkgh/bha_cst/actions/runs/43462247410) on commit `beac8cb` succeeded with all jobs green (**1,365 passed, 6 skipped across 131 test files**).

### 1.2 Stage D — Lifecycle Persistence & Transaction Guarantees
- **Transactional Gating:** Introduced `DbClient.recordRequiredDashboardOutcomes` (`engine/src/db/client.ts:2693-2743`), wrapping lifecycle record persistence (`start`, `trsc`, `outc`, `escl`) in a single PostgreSQL transaction (`BEGIN` → `INSERT` → `COMMIT`).
- **Deterministic Row IDs:** Replaced randomized UUIDs with deterministic SHA-256 IDs (`evt_${kind}_${sha256(['elevenlabs', tenant, project, convId, kind])}`) so that redeliveries after ambiguous commits or network dropouts are completely idempotent.
- **Conflict Handling:** Applied `ON CONFLICT (id) DO NOTHING` to guarantee that original committed rows are preserved without mutation or duplication.
- **Poisoned Connection Disposal:** If a rollback fails, `client.release(discardClient = true)` explicitly destroys the connection rather than returning a corrupted client to the pool.
- **Withheld Customer Dispatch:** Any insert or commit failure returns HTTP 500, withholds customer Slack dispatch, suppresses escalation creation, and leaves the conversation eligible for redelivery.

### 1.3 Stage E — Error Routing & Notification Delivery
- **Deduplication Gate:** Modified `Logger.error(message, meta, notify = true)` in `engine/src/config/logger.ts`. When a failure has an authoritative class-specific destination in `ErrorRouter`, `notify = false` suppresses duplicate generic Slack alerts.
- **Dedicated Route:** Inbound webhook persistence failures route exclusively to `ErrorRouter.route({ category: 'webhook_persistence', severity: 'ERROR' })`.

### 1.4 Stage F — Health Reporting & Alert Coverage
- **Honest Readiness:** Updated `FailureDetector.getReadinessStatus()` (`engine/src/observability/failure_detector.ts:272-277`) so that `slackStatus === 'failing'` now marks overall readiness as `'unready'` (HTTP 503 on `/webhooks/elevenlabs/health`), preventing operational blindness from masquerading as system readiness.

### 1.5 Stage S1 — Event Field Contract
- Derived canonical field-level contract across all normalized lifecycle events (`cst.event.v1`). Mapped required vs optional fields, nullability, E.164 phone masking, and correlation identifiers. External sign-off recorded as `APPROVAL_PENDING` from Destiny Arupi (`U0AEW3TBYH1`).

### 1.6 Stage S2 — Human Handoff Lifecycle
- Automated human handoff extraction from ElevenLabs analysis evaluation criteria (`human_handoff: true`). Enforced that escalation records in `escalations` table are only written after the lifecycle database transaction commits.

### 1.7 Stage S3 — Forward-Only Cut-Over
- Verified prospective activation boundaries in `CutOverManager`. Preserved `CST_CUTOVER_APPROVED=false` without default activation or historical data mutation.

### 1.8 Open Audits
- **Audit 1 (2 Nov Escalation):** Audited call attribution and verified that human handoffs are strictly gated behind lifecycle transaction commits.
- **Audit 2 (NS False Positives):** Confirmed sensor-vs-relay diagnosis; verified that non-sensor devices are strictly excluded via `device_type === 'sensor'` filter (`261b4b6` and `579983f`).
- **Audit 3 (ElevenLabs Webhook Shape):** Validated incoming payload structure, header specifications, and HMAC signature timestamp tolerance (300s window).

---

## 2. Why Engine (Architecture & Reliability Rationale)

1. **Transactional Atomicity Before External Effects:**
   Under high load or database brownouts, an engine must never produce side-effects (e.g. sending customer Slack cards, notifying on-call personnel, or publishing metrics) if the durable evidence record cannot be committed. Moving lifecycle persistence inside a strict PostgreSQL transaction before downstream dispatch eliminates "ghost dispatch" incidents.
2. **Idempotent Recovery Under Provider Retries:**
   ElevenLabs retries failed post-call webhooks up to provider limits. Using deterministic hashing for event IDs ensures that when a retry arrives after a dropped connection or ambiguous commit, the database safely executes `ON CONFLICT (id) DO NOTHING`, ensuring idempotent ingestion without duplicate escalation creation.
3. **Safe Disposal of Broken Database Connections:**
   In Node.js `pg` connection pools, if an error occurs during `ROLLBACK`, returning that client to the pool results in subsequent queries failing or executing inside an un-reset transaction state. Passing `discardClient = true` to `client.release()` guarantees poisoned connections are closed immediately.
4. **Subsystem Health Fidelity:**
   Previously, CST reported `ready` even when Slack alerting had reached a `failing` state (6 consecutive errors). Elevating failing Slack health to an overall `unready` state (HTTP 503) alerts upstream load balancers and operators immediately.

---

## 3. Evidence Matrix

| Area / Stage | Requirement | Code Location | Test Command & Verification | Result | Evidence Classification |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **CI #112** | Fix Vitest mock omission | `tests/interfaces/elevenlabs_caller_identity.test.ts` | CI Run #117 ([`43462247410`](https://github.com/bhanetworkgh/bha_cst/actions/runs/43462247410)) | 1,365 passed, 6 skipped across 131 test files | `EXTERNAL_TEST_VERIFIED` |
| **Stage D** | Transactional lifecycle persistence | `engine/src/db/client.ts:2693-2743`<br>`service.ts:324-348` | `npx vitest run tests/interfaces/iwkx_persistence.test.ts` | 7/7 tests pass; rollback & connection disposal verified | `TESTED_LOCAL` |
| **Stage E** | Deduplicated error routing | `engine/src/config/logger.ts:53-56`<br>`engine/src/notifications/error_router.ts` | `npx vitest run tests/notifications/error_routing.test.ts` | Dispatches to `webhook_persistence`; no duplicate Slack alert | `TESTED_LOCAL` |
| **Stage F** | Health reporting on Slack failure | `engine/src/observability/failure_detector.ts:275` | `npx vitest run tests/observability/failure_detector_cutover.test.ts` | Returns HTTP 503 (`unready`) when Slack health is failing | `TESTED_LOCAL` |
| **Stage S1** | Canonical event field contract | `engine/src/contracts/events.ts`<br>`engine/src/interfaces/elevenlabs/schemas.ts` | Schema inspection & typecheck | Mapped 8-field envelope; awaits Destiny approval | `APPROVAL_PENDING` |
| **Stage S2** | Durable human handoff | `service.ts:291-344`<br>`engine/src/escalation/` | `tests/interfaces/iwkx_persistence.test.ts` | Escalation suppressed on DB failure; stable ID on retry | `TESTED_LOCAL` |
| **Stage S3** | Forward-only cut-over | `engine/src/observability/cut_over.ts` | Cut-over specification (§4.4) | `CST_CUTOVER_APPROVED=false` preserved strictly | `PROPOSED` |
| **Audit 1** | 2 Nov escalation verification | `engine/src/interfaces/elevenlabs/service.ts` | Telephony attribution & escalation audit (§5.1) | Gated behind lifecycle commit; no premature card dispatch | `TESTED_LOCAL` |
| **Audit 2** | NS false-positive resolution | `engine/src/adapters/vfarm/live_client.ts:942-955` | Commits `261b4b6` & `579983f`; `vfarm_authenticated_flow.test.ts` | Strict `device_type === 'sensor'` filter verified | `TESTED_LOCAL` |
| **Audit 3** | ElevenLabs webhook shape | `engine/src/interfaces/elevenlabs/schemas.ts` | `tests/interfaces/elevenlabs_webhook.test.ts` | Inbound method, headers, timestamp HMAC, body validated | `TESTED_LOCAL` |

---

## 4. Technical Deep-Dives by Stage

### 4.1 Stage D: Transaction Semantics & Residual Risk Statement
```
Inbound ElevenLabs Webhook
       │
       ▼
HMAC Signature & Timestamp Verification (300s window)
       │
       ▼
Normalize Events (Interaction Start, Transcript, Outcome, Escalation)
       │
       ▼
BEGIN PostgreSQL Transaction (DbClient.recordRequiredDashboardOutcomes)
   ├── INSERT INTO dashboard_publish_outcomes (start event) ON CONFLICT DO NOTHING
   ├── INSERT INTO dashboard_publish_outcomes (transcript event) ON CONFLICT DO NOTHING
   ├── INSERT INTO dashboard_publish_outcomes (outcome event) ON CONFLICT DO NOTHING
   └── INSERT INTO dashboard_publish_outcomes (escalation event) ON CONFLICT DO NOTHING
COMMIT Transaction
       │
       ├──[SUCCESS]──► Create Escalation Row ──► Publish cst.turn ──► Customer Slack Card
       │
       └──[FAILURE]──► ROLLBACK ──► client.release(discard=true) ──► ErrorRouter.route
                                └──► Return HTTP 500 (Withhold Slack & Escalation)
```

> [!WARNING]
> **Residual Risk Statement on Concurrency & Process Crashes:**
> 1. **Database Transaction Atomicity:** Atomicity is strictly guaranteed at the database level for all required lifecycle rows.
> 2. **Idempotent Ingestion:** Deterministic IDs derived from `['elevenlabs', tenant_id, project_id, conversation_id, kind]` prevent duplicate rows on retry.
> 3. **Non-Guarantee of Exactly-Once External Dispatch:** If the CST process crashes *after* publishing to Slack but *before* writing the final completion record, provider redelivery may produce a duplicate external Slack card. True end-to-end exactly-once external dispatch across arbitrary distributed process crashes remains an open distributed systems limitation.

### 4.2 Stage E: Error Routing Matrix
| Failure Class | Trigger Condition | Expected Handling Route | Downstream Dispatch |
| :--- | :--- | :--- | :--- |
| **Lifecycle Insert Failure** | SQL syntax, constraint, or disk error | `ErrorRouter.route({ category: 'webhook_persistence', severity: 'ERROR' })` | Withheld; returns HTTP 500 |
| **Commit Failure** | Connection drop during `COMMIT` | Handled identically; `ROLLBACK` attempted; connection discarded | Withheld; returns HTTP 500 |
| **Database Unavailable** | Connection pool exhausted / DB offline | `FailureDetector.recordWebhookPersistenceFailure`, logged without duplicate alert | Withheld; returns HTTP 500 |
| **Slack Outage** | 6 consecutive Slack delivery failures | Health marks subsystem failing; overall readiness reports `unready` (503) | Degraded/Unready |

### 4.3 Stage S1: Canonical Event Field Contract (`cst.event.v1`)
| Field | Type | Required? | Source / Extraction | Description |
| :--- | :--- | :---: | :--- | :--- |
| **`tenant_id`** | `string` | **Yes** | Authoritative binding | Tenant identifier (e.g. `tenant-vfarm-01`). |
| **`project_id`** | `string` | **Yes** | Authoritative binding | Project scope (e.g. `proj-vfarm-main`). |
| **`channel`** | `enum` | **Yes** | Provider transport | One of: `voice`, `sms`, `whatsapp`, `web`. |
| **`customer.customer_ref`** | `string` | **Yes** | Resolved identity | User identifier or E.164 phone string. |
| **`customer.phone_e164`** | `string` | Optional | E.164 caller extraction | Masked in public logs (`+9230****3844`). |
| **`correlation_id`** | `string` | **Yes** | Provider conversation ID | E.g. `conv_7401m7ap0wbnf998yphpd0x7ts7k`. |
| **`text` / `message`** | `string` | **Yes** | Transcript synthesis | Interaction transcript body. |
| **`metadata`** | `object` | Optional | Provider telemetry | Duration, termination reason, agent ID. |

### 4.4 Stage S3: Forward-Only Cut-Over Specification
- **Activation Gate:** `CutOverManager.isCutOverApproved()` checks `process.env.CST_CUTOVER_APPROVED === 'true'`.
- **Current Production Value:** `false` (Strictly maintained; never set to `true` autonomously).
- **Prospective Gating Rule:** Inbound calls with timestamp before `start_timestamp` are classified as pre-cutover and ignored from forward pipeline.
- **No Historical Rewrite:** Existing records in `dashboard_publish_outcomes` and `conversations` remain strictly preserved without backfill or re-keying.

---

## 5. Open Audits

### 5.1 Audit 1: 2 November Escalation
- **Audit Findings:** The 2 November escalation sequence was audited against `engine/src/interfaces/elevenlabs/service.ts`.
- **Root Protection:** In PR #55, human handoff escalation creation (`DbClient.createEscalationRecord`) is explicitly placed *after* `DbClient.recordRequiredDashboardOutcomes`. If the lifecycle write fails, escalation rows are not written, preventing orphaned escalations without underlying event telemetry.

### 5.2 Audit 2: NS False-Positive Telemetry Warnings
- **Triggering Condition:** Non-sensor hardware devices (relays, valves, switches) in vFarm return telemetry schemas that lack continuous numeric readings, causing Zod schema failures when processed as sensor readings.
- **Resolution:** Fully verified in commits `261b4b6` and `579983f` (PR #44 `78e8ee80`). CST enforces strict filtering: `devices.filter(d => d.device_type === 'sensor')`, failing closed if no valid sensors exist.

### 5.3 Audit 3: ElevenLabs Post-Call Webhook Contract
- **HTTP Method:** `POST`
- **Path:** `/webhooks/elevenlabs`
- **Headers:** `elevenlabs-signature` (Format: `t=<timestamp>,v0=<hmac_sha256>`)
- **HMAC Verification:** Validated with `ELEVENLABS_WEBHOOK_SECRET` over `${timestamp}.${rawBody}`. Maximum allowable clock skew: 300 seconds (5 minutes).
- **Body Requirement:** Must be valid JSON matching `ElevenLabsPostCallWebhookPayload` schema with `conversation_id`, `start_time_unix_secs`, and `transcript`.

---

## 6. Acceptance Status Matrix

| Stage / Component | Status | Detail / Remaining Blocker |
| :--- | :--- | :--- |
| **CI #112 & Successor Run** | **Complete** | Successor CI run `43462247410` green on commit `beac8cb`. |
| **Stage D (Lifecycle Persistence)** | **Implemented & Verified Locally** | Transaction atomicity, rollback, and stable IDs verified in tests. Local Postgres integration verification pending environment authorization. |
| **Stage E (Error Routing)** | **Implemented & Verified Locally** | Error router handles persistence failures; logger deduplication verified. Live Slack receipt remains an operational gate. |
| **Stage F (Health Reporting)** | **Implemented & Verified Locally** | `unready` status on Slack failure verified. |
| **Stage S1 (Field Contract)** | **Approval Pending** | Derived contract ready; requires Destiny Arupi (`U0AEW3TBYH1`) written confirmation. |
| **Stage S2 (Human Handoff)** | **Implemented & Verified Locally** | Local failure and retry paths verified. Controlled live human handoff receipt remains unexecuted. |
| **Stage S3 (Cut-Over Proposal)** | **Proposed (Pending Agreement)** | Technical analysis completed; requires joint agreement between Jason and Destiny on activation gate vs metadata semantics. |
| **Audit 1 (2 Nov Escalation)** | **Complete** | Sequence and persistence gating fully audited. |
| **Audit 2 (NS False Positives)** | **Complete** | Root-cause diagnosed and fixed in `live_client.ts` (`261b4b6`/`579983f`). |
| **Audit 3 (ElevenLabs Webhook)** | **Complete** | Inbound schema and HMAC signature validation verified. |

---

## 7. Blockers & Outstanding External Decisions

1. **Destiny Arupi Written Sign-Off (Stage S1 / Pay-Gate D):**
   - Formal sign-off on event contract `cst.event.v1` for external Monitoring / Research Twin ingestion.
2. **Jason & Destiny Joint Cut-Over Alignment (Stage S3):**
   - Written agreement whether `CST_CUTOVER_APPROVED` operates as an ingestion gate or approval metadata, and the agreed cut-over epoch timestamp.
3. **Controlled Live Telephony Handoff Receipt (Stage S2):**
   - Authorization to execute a single live carrier test call triggering human handoff to verify actual operator notification delivery.

---

## 8. Next Acceptance Action

The single next action in Jason's specified sequence is:
> **Destiny Arupi records written approval on the Stage S1 event field contract (`cst.event.v1`), unblocking Pay-Gate D and enabling final review on PR #55.**

