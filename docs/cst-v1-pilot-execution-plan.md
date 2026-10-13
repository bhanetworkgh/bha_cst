# CST v1 — Pilot Execution Plan

**Document:** `docs/cst-v1-pilot-execution-plan.md`  
**Date:** 2026-10-13  
**Target:** Customer Service Twin (CST) v1 Commercial Launch  
**Repository:** `bhanetworkgh/bha-cst`  

---

## Executive Overview

This execution plan establishes three distinct, operational workstreams to take CST v1 from local verification through staging validation to a secure commercial pilot. Each track outlines discrete goals, tasks, gates, rollback procedures, and accountable owners.

---

## Track 1: Security & Platform

### 1.1 Goal & Scope
Harden the foundational platform, guarantee multi-tenant and multi-project boundary isolation, establish DNS routing and TLS termination, execute database migrations safely, and configure observability.

### 1.2 Dependencies & Accountable Owners
- **CST Application Security:** Security Engineer / Jason
- **Database Migrations:** Backend Engineer / Lead
- **DNS / Domain Administration:** Domain Administrator (Cloudflare / Registrar)
- **Deployment Platform:** Render Account Owner / Platform Ops

### 1.3 Ordered Tasks & Acceptance Criteria
1. **Task 1.1 — Code Gate & Regression Verification:**
   - *Action:* Execute full test suite, linting, typecheck, and build.
   - *Acceptance Criteria:* 551/551 tests pass; `tsc --noEmit` clean; `dist/` bundle created with 7 web assets.
   - *Status:* **VERIFIED**.
2. **Task 1.2 — Public vFarm Proxy Route Protection:**
   - *Action:* Audit `/api/devices`, `/api/dashboard`, `/api/farms`, `/api/tokens` (and `/api/v1` aliases).
   - *Acceptance Criteria:* Unauthenticated callers receive HTTP 401 with 0 upstream calls; no privileged fallback.
   - *Status:* **VERIFIED (LOCAL)**.
3. **Task 1.3 — Operational Token-Issuance Audit:**
   - *Action:* Audit vFarm database for keys minted via `POST /api/v1/tokens` between 2026-09-25 and 2026-10-07. Revoke unknown keys; rotate CST service account credentials.
   - *Acceptance Criteria:* Documented audit log with key hash / ID verification.
   - *Status:* **BLOCKED (Requires vFarm Cluster Access)**.
4. **Task 1.4 — DNS & TLS Provisioning:**
   - *Action:* Create CNAME records in DNS provider:
     - `cst.bhanetwork.org` -> `bha-cst.onrender.com`
     - `cst-admin.bhanetwork.org` -> `bha-cst.onrender.com`
   - *Action:* Attach custom domains in Render console and generate Let's Encrypt certificates.
   - *Acceptance Criteria:* `dig +short cst.bhanetwork.org` resolves to Render origin; `curl -Iv https://cst.bhanetwork.org/health` returns HTTP 200 with valid TLS cert.
   - *Status:* **BLOCKED (Domain Admin Approval)**.
5. **Task 1.5 — PostgreSQL Staging Migrations (017 & 018):**
   - *Action:* Apply `017_sms_consent_audit_fk.sql` and `018_sms_consent_prompts.sql` via `node scripts/migrate.js` on staging.
   - *Acceptance Criteria:* Tables and constraints present; append-only trigger active.
   - *Status:* **IN PROGRESS (Ready for Staging Apply)**.

### 1.4 Test & Evidence Requirements
- Local Vitest output: `tests/security/vfarm_proxy_unauth.test.ts` (18/18 PASS).
- Staging migration execution logs showing zero errors.
- TLS inspection via `openssl s_client -connect cst.bhanetwork.org:443 -servername cst.bhanetwork.org`.

### 1.5 Rollback Steps
- **Code:** Git revert to baseline commit `0ac8c5d`.
- **Database:** Revert migration 018 (`DROP TABLE sms_consent_prompts CASCADE;`), revert migration 017 (`ALTER TABLE sms_consent_audit DROP CONSTRAINT fk_sms_consent_audit_consent;`).
- **DNS:** Remove CNAME records or repoint to maintenance placeholder.

### 1.6 Entry & Exit Criteria
- **Entry:** Clean Git working tree, passing unit tests.
- **Exit:** DNS resolves, TLS valid, migrations applied without error, operational token audit closed.
- **Track Status:** `IN PROGRESS` (Blocked on DNS and vFarm audit).

---

## Track 2: Consent & Messaging

### 2.1 Goal & Scope
Ensure strict compliance with carrier A2P messaging rules, manage customer consent lifecycle (opt-in, STOP, START, HELP), enforce immediate queued message suppression, and handle provider delivery callbacks.

### 2.2 Dependencies & Accountable Owners
- **Consent Service:** CST Backend Engineer
- **Twilio Carrier Campaign:** Twilio Account Administrator / Operations Lead
- **Carrier Route Approval:** Mobile Carrier Gateways (US / Pakistan Jazz)

### 2.3 Ordered Tasks & Acceptance Criteria
1. **Task 2.1 — Consent Spine Verification:**
   - *Action:* Validate server-side stamping of `cst_sms_consent_v1`, prompt evidence in `sms_consent_prompts`, and composite FK audit logging.
   - *Acceptance Criteria:* All 34 tests in `tests/consent/` pass cleanly.
   - *Status:* **VERIFIED (LOCAL)**.
2. **Task 2.2 — STOP / Opt-Out Immediate Queue Suppression:**
   - *Action:* Verify that when a STOP keyword is processed, all queued messages for that phone number are marked `refused` before transmission.
   - *Acceptance Criteria:* Zero messages dispatched to Twilio for opted-out numbers; audit log written.
   - *Status:* **VERIFIED (LOCAL)**.
3. **Task 2.3 — START / Re-subscription Policy Enforcement:**
   - *Action:* Test that inbound START produces an unexpired prompt (TTL 24h) and does not grant consent until explicit affirmative (`YES`).
   - *Acceptance Criteria:* Validated by `tests/consent/a2p_operational_acceptance.test.ts`.
   - *Status:* **VERIFIED (LOCAL)**.
4. **Task 2.4 — Carrier Delivery Webhooks & Failure Classification:**
   - *Action:* Verify Twilio callback handler (`/webhooks/twilio/status`) updates `messages_out` with `provider_status` and records provider error codes (`21215`, `30005`, `30008`).
   - *Acceptance Criteria:* Permanent error codes fail fast without retry; transient codes (5xx) enter exponential backoff retry.
   - *Status:* **VERIFIED (LOCAL)**.
5. **Task 2.5 — US A2P Campaign Carrier Acceptance:**
   - *Action:* Complete Twilio Campaign Registry (TCR) verification for sender `+1 (971) 588-5823`.
   - *Acceptance Criteria:* Carrier delivery receipts (`delivered`) on live test handsets.
   - *Status:* **IN PROGRESS (Pending TCR Live Verification)**.
6. **Task 2.6 — Pakistan International Route Evaluation:**
   - *Action:* Evaluate two-way SMS and voice capability for Pakistan Jazz (`+923082113844`).
   - *Acceptance Criteria:* Twilio Voice Geo-Permissions enabled for PK; local short code or WhatsApp fallback configured for SMS.
   - *Status:* **BLOCKED (Carrier Limitations)**.

### 2.4 Test & Evidence Requirements
- Vitest results: `tests/consent/consent_spine.test.ts` (24/24), `tests/consent/a2p_operational_acceptance.test.ts` (10/10), `tests/transport/delivery_status_webhook.test.ts` (10/10).
- Twilio Console delivery logs showing `status: delivered` and absence of `30007` (filtering) errors.

### 2.5 Rollback Steps
- Set `SMS_CAPABILITY=false` in project configuration to immediately refuse all outbound SMS.
- Flush or purge pending outbound queue table (`messages_out`) if duplicate queue bug detected.

### 2.6 Entry & Exit Criteria
- **Entry:** Track 1 migrations applied.
- **Exit:** Live carrier SMS roundtrip verified with START, STOP, and HELP on authorized test phone.
- **Track Status:** `IN PROGRESS` (US route Ready / PK route Blocked).

---

## 3. Track 3: First-Customer Commercial Pilot

### 3.1 Goal & Scope
Validate complete end-to-end customer conversational journey across phone channels, integrating vFarm authorization, BHARAG knowledge retrieval, ElevenLabs speech synthesis, and PostgreSQL session history.

### 3.2 Dependencies & Accountable Owners
- **vFarm API & Identity:** vFarm Platform Team / Destiny
- **BHARAG Knowledge Engine:** BHARAG Ops
- **Pilot Customer Engagement:** Product Manager / Commercial Lead
- **Technical Support:** CST Engineering On-Call

### 3.3 Ordered Tasks & Acceptance Criteria
1. **Task 3.1 — Tenant & Customer Registration:**
   - *Action:* Register pilot tenant and project via `CoreRegistry.registerProject()`; bind pilot service number.
   - *Acceptance Criteria:* Customer phone resolved to valid vFarm member; system identity persisted in database.
   - *Status:* **VERIFIED (LOCAL & PERSISTENT DB)**.
2. **Task 3.2 — vFarm Adapter Live Contracts:**
   - *Action:* Connect to `https://vfarm.bhanetwork.org/api/v1` and discover pilot farms and device layout.
   - *Acceptance Criteria:* `VfarmLiveClient` returns structured layout; timeouts bounded by 5000ms.
   - *Status:* **VERIFIED (Live Contract Tests Passing)**.
3. **Task 3.3 — Person-to-Unit Upstream Resolution (`LOOP-1790985133889-8D7U`):**
   - *Action:* Resolve member's specific unit or zone.
   - *Acceptance Criteria:* vFarm exposes person→unit mapping API; CST adapter ingests real `unit_id`.
   - *Status:* **BLOCKED (vFarm OpenAPI Gap; Currently Fallback to Farm Scope)**.
4. **Task 3.4 — Engine Dashboard Live Publishing:**
   - *Action:* Stream turn and delivery events to `https://dashboard.bhanetwork.org/api/engine/cst-events`.
   - *Acceptance Criteria:* Real HTTP 200 with row insertion confirmed (`turn_id` correlated).
   - *Status:* **VERIFIED (Proven Live with `REAL_DASHBOARD_PROOF=1`)**.
5. **Task 3.5 — ElevenLabs Voice Synthesis Lane:**
   - *Action:* Stream audio response via custom cloned voice ID.
   - *Acceptance Criteria:* Audio synthesized and delivered under 1500ms latency budget.
   - *Status:* **VERIFIED (Contract & Mock Verified)**.
6. **Task 3.6 — First-Customer Acceptance & Shadow Run:**
   - *Action:* Run 24 hours in shadow mode (`DRY_RUN=true`), inspecting conversation transcripts and accuracy.
   - *Acceptance Criteria:* 100% transcript durability, 0 cross-tenant leaks, customer signs off on accuracy.
   - *Status:* **NOT STARTED (Pending Staging Gate)**.

### 3.4 First-Customer Acceptance Checklist

| Requirement | Pass/Fail Criteria | Verification Method | Status |
|:---|:---|:---|:---:|
| **Identity Resolution** | Customer phone maps to authorized vFarm farm | Inbound turn log inspection | **READY** |
| **Consent Gate** | Affirmative opt-in verified before outbound SMS | `canSendSms` audit log | **READY** |
| **Response Latency** | SMS reply queued < 2.0s; Voice TTS start < 1.5s | Turn timestamp telemetry | **READY** |
| **Knowledge Accuracy** | Answers reflect authorized farm data & BHARAG docs | Transcript manual review | **READY** |
| **Safety / Escalation** | Out-of-scope or emergency questions trigger fallback | Security tripwire audit | **READY** |
| **Cost & Quota** | Per-turn cost within budget (Twilio + ElevenLabs) | Provider dashboard tally | **READY** |

### 3.5 Rollback & Contingency Plan
- **Instant Kill Switch:** Set `DRY_RUN=true` or disable project service number binding via CST Admin Panel.
- **Provider Outage:** Automatic fallback to generic SMS response if vFarm or BHARAG fails.
- **Voice Fallback:** Route voice calls to human support forwarding number if ElevenLabs synthesis errors.

### 3.6 Entry & Exit Criteria
- **Entry:** Track 1 and Track 2 verified on staging.
- **Exit:** Pilot customer executes 10 successful test turns; 0 critical defects; commercial sign-off signed.
- **Track Status:** `CONDITIONAL GO` (Ready for US pilot cohort; Blocked for Pakistan handset).
