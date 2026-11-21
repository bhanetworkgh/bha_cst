# CST Four-Loop Operational State & Evidence Audit Report

**Date:** 20 November 2026 / 21 November 2026  
**Repository:** `bhanetworkgh/bha_cst`  
**Current Working Branch:** `feat/iwkx-postgres-lifecycle-acceptance` (HEAD: `4f82b74`)  
**Production Host:** `https://bha-cst-7u9e.onrender.com`  
**Live Production Deploy:** `dep-dc095g7lk1mc73f0ir90` (Commit `19a13ceb75e75fbd78ac89b91aa79836fe385af8`, PR #64 Live)  
**Render Service ID:** `srv-db8hepqvcj2c73adpus0` (`bha-cst`)  
**Target Reviewers:** Jason Bays / Destiny Arupi  

---

## 1. Executive Summary

This document provides the authoritative technical audit, evidence recovery report, and system state reconciliation for the four live loops in Customer Service Twin (CST):

1. **`LOOP-1794902688969-80HM`** — Monitoring Twin Confidence & Fallback Rules (**OPEN — AWAITING EXTERNAL CONFIRMATION**)
2. **`LOOP-1793031575930-X4EI`** — KMG9 Authoritative BHARAG RAG Acceptance (**OPEN — BLOCKED ON UPSTREAM G718**)
3. **`LOOP-1792681313173-0SNO`** — Form-to-Device Traceability & Farm Fallback (**OPEN — BLOCKED ON UPSTREAM ZAKN**)
4. **`LOOP-1795035800169-NVLF`** — Pre-Route Content-Type Validation Middleware (**OPEN — AWAITING OWNER ACCEPTANCE**)

### Foundational Distinction of System States
All four loops remain **OPEN**. To strictly prevent inaccurate completion claims:
- **CST Implementation:** Indicates whether code and unit/regression tests within the CST boundary have been implemented. CST-side code is implemented for all four loops.
- **Evidence Status:** Distinguishes what is empirically verified in production versus what remains simulated, unit-tested, or unverified.
- **System Loop State:** Accurately reflects reality in accordance with Jason's directives. No loop is marked `CLOSED` without complete acceptance evidence and explicit owner sign-off.
- **Payment Release vs. Loop Closure:** Destiny's release of the 25% payment hold under `DW-1795036114694-RK8U` is an administrative payment action and is **not** loop closure.

---

## 2. Four-Loop Authoritative State Matrix

| Loop ID | Title | CST Implementation | Evidence Status | Upstream Dependency / Blocker | Authoritative Loop State | Action Required for Closure |
|---|---|:---:|:---:|:---:|:---:|---|
| **`LOOP-1794902688969-80HM`** | Monitoring Twin Confidence & Fallback Rules | **IMPLEMENTATION_COMPLETE** | Unit Verified (19/19 pass); Production n8n Unverified | Restored n8n workflow deployment; Priority taxonomy approval | **`OPEN — AWAITING_EXTERNAL_CONFIRMATION`** | Destiny Arupi & Jeganathan to confirm live n8n workflow URL and formally approve priority taxonomy. |
| **`LOOP-1793031575930-X4EI`** | KMG9 Authoritative BHARAG RAG Acceptance | **IMPLEMENTATION_COMPLETE** | Unit Verified (16/16 pass); Upstream Boundary Unverified | `LOOP-1791991972916-G718` (BHARAG re-indexing sign-off) | **`OPEN — BLOCKED`** | Jason Bays to inspect and approve BHARAG re-indexing under G718 and verify Gate 6 upstream boundary. |
| **`LOOP-1792681313173-0SNO`** | Form-to-Device Traceability & Farm Fallback | **IMPLEMENTATION_COMPLETE** | Code Verified (`83422e3`); Upstream Schema Unverified | `LOOP-1792681313174-ZAKN` (vFarm user-to-device join table) | **`OPEN — BLOCKED`** | Jeganathan to merge and deploy ZAKN join table in vFarm. CST operates in aggregate farm fallback. |
| **`LOOP-1795035800169-NVLF`** | Pre-Route Content-Type Validation Middleware | **EVIDENCE_READY** | Verified in Live Production (`dep-dc0d7jp5efls739sstj0`, PR #68) | None (PR #61, #62, #63, #68 merged on `main`) | **`OPEN — AWAITING_OWNER_ACCEPTANCE`** | Jason Bays to review corrected evidence package and record formal technical acceptance. |

---

## 3. Deep Dive: LOOP-1794902688969-80HM (Monitoring Twin Confidence & Fallback)

### 3.1 CST Code Implementation & Resolution of `computeDependentDeviceStatus`
In response to Jason's audit finding that `computeDependentDeviceStatus` had no matching engine code, the function was implemented directly in `engine/src/connectors/vfarm.ts` (lines 45–66) and exported alongside its core types (`SensorState`, `DependentDeviceStatus`):
- **Function Signature:** `computeDependentDeviceStatus(sensorStates: SensorState[]): DependentDeviceStatus`
- **Allowed States:** `'online' | 'offline' | 'missing' | 'stale' | 'timed_out' | 'degraded'`
- **Behavior:**
  - Evaluates to `NORMAL` if and only if **all** required sensors are `online`.
  - If any sensor is `offline`, `missing`, `stale`, `timed_out`, or `degraded`, evaluates strictly to `DEGRADED`.
  - Fails safe to `DEGRADED` on empty arrays, `null`, or `undefined`.
- **Telemetry Mapping:** `mapLatestReadingToTelemetry` in `engine/src/connectors/vfarm.ts` strictly maps all-null readings to `"telemetry_unavailable"`, ensuring CST never fabricates nominal sensor readings. Error codes map to `"fault"`.
- **Actuator Distinction:** Intentional `off` status (pump/valve/light switched off) is distinguished from `offline` (unreachable hardware).

### 3.2 Regression Test Evidence
The test suite `tests/regression/sensor_status_semantics.test.ts` imports `computeDependentDeviceStatus` directly from `../../engine/src/connectors/vfarm.js` and executes 19 deterministic tests:
- Sensor state degradation, recovery, and boundary handling.
- Timestamp staleness and threshold detection.
- Fail-safe handling on empty and invalid sensor arrays.
- Honest handling of null readings and offline actuators.
- **Execution:**
  ```bash
  npx vitest run tests/regression/sensor_status_semantics.test.ts
  # Output: 19 passed (19) in 3ms
  ```

### 3.3 Evidence Gaps & Production Reality
1. **n8n Workflow Execution:** In production Render, querying `GET /api/health` yields:
   ```json
   "research_twin": {
     "state": "blocked",
     "operational": false,
     "contract": "unverified"
   }
   ```
   While `.env.example` specifies `RT_ENDPOINT_URL=https://bayshorizonnetwork.app.n8n.cloud/webhook/research-twin`, there is no evidence that an active 80HM n8n workflow survived the November 1 n8n restoration or that genuine live cards were created in production.
2. **Priority Taxonomy:** Candidate priorities exist in `engine/src/core/schemas.ts` (`critical`, `high`, `medium`, `low`, `p1`, `p2`, `p3`), but there is no formal owner-approved taxonomy document from Destiny Arupi or Jeganathan defining SLA mapping and escalation triggers.

### 3.4 Acceptance Requirements Remaining
- **External Action Required:** Destiny Arupi and Jeganathan must provide the active n8n workflow webhook endpoint and formally sign off on the priority taxonomy. Loop remains **`OPEN — AWAITING EXTERNAL CONFIRMATION`**.

---

## 4. Deep Dive: LOOP-1793031575930-X4EI (KMG9 RAG Acceptance)

### 4.1 Reviewer Authority & Decision Context
In Bays Horizon Network Slack (`C0AD3PM603T/p1794319647449059`, thread `1791974048.091059`), Jason Bays confirmed:
- **Jason Bays** is the sole authorized reviewer for X4EI.
- References to "Jonathan" in earlier records refer to Jeganathan.
- Reviewer designation does not imply acceptance; KMG9 acceptance remains open until all gate conditions are satisfied.

### 4.2 Audit of the Six KMG9 Security Gates
| Gate | Condition | CST Enforcement | Status |
|---|---|---|:---:|
| **Gate 1** | Farm-specific questions route strictly to vFarm | Query classifier routes farm domain inquiries directly to vFarm live adapter. | **VERIFIED** |
| **Gate 2** | Fail closed on vFarm outage (no BHARAG fallback) | If vFarm is unavailable, CST returns fail-closed message; BHARAG fallback is barred. | **VERIFIED** |
| **Gate 3** | General questions route to BHARAG | General system inquiries and CST help manuals route to BHARAG RAG client. | **VERIFIED** |
| **Gate 4** | Scoped BHARAG key and workspace | BHARAG requests use `cst-help-read` API key and `cst-help-manuals` workspace only. | **VERIFIED** |
| **Gate 5** | Upstream BHARAG re-indexing sign-off | Blocked on `LOOP-1791991972916-G718` completion in upstream BHARAG repo. | **BLOCKED (G718)** |
| **Gate 6** | Third boundary test (`UTC8`) | Unit test in `kmg9_phase3_additional.test.ts:123` is a local stub. Upstream external boundary test required. | **PENDING UPSTREAM** |

### 4.3 Test Evidence
- `tests/regression/kmg9_phase3_additional.test.ts` (5 tests pass)
- `tests/regression/kmg9_farm_isolation.test.ts` (11 tests pass)
- Total 16/16 unit tests passing.

### 4.4 Acceptance Requirements Remaining
- **External Action Required:** Jason Bays to inspect and approve BHARAG re-indexing under `LOOP-1791991972916-G718`, and verify the upstream 403 boundary test for CST identities attempting unauthorized grant modification. Loop remains **`OPEN — BLOCKED`**.

---

## 5. Deep Dive: LOOP-1792681313173-0SNO (Form-to-Device Traceability & Farm Fallback)

### 5.1 12-Stage Trace Architecture
CST traces form submissions through 12 distinct functional stages:
1. `INGRESS`: Web/SMS form submission received.
2. `IDENTITY_RESOLUTION`: Phone number/session mapped to verified identity.
3. `TENANT_SCOPING`: Organization and tenant boundaries isolated.
4. `VFARM_AUTH`: Scoped bearer token validated against vFarm.
5. `FORM_LOOKUP`: Form template and submission metadata resolved.
6. `FORM_TO_USER_MAPPING`: Submitter mapped to vFarm user profile.
7. `FORM_TO_DEVICE_MAPPING`: Target unit/hardware resolved.
8. `DEVICE_LOOKUP`: Device operational status queried.
9. `SENSOR_LOOKUP`: Attached sensor channels queried.
10. `LIVE_READING`: Fresh telemetry fetched from sensor endpoints.
11. `CST_RESPONSE`: Multi-turn response synthesized without hallucinations.
12. `CHANNEL_DELIVERY`: Response returned via Web UI or Twilio SMS/Voice.

### 5.2 Historical Outage Root Cause (`CODEX-20261030-ahad-vfarm-sensor-timeout`)
During the October 30 incident, 23 devices were offline and individual sensor queries (`rack1_ph`, `rack1_soil`, `rack2_dht`, `rack1_mq7`) timed out (>5000ms), resulting in upstream 502 Bad Gateway responses. The query pattern `/api/v1/readings/latest` was migrated to `/api/v1/readings?sensor_id=X&limit=1` with strict 3-second timeouts.

### 5.3 CST Fallback Implementation
In commit `83422e3`, CST hardened its fallback: when a user has valid farm-level grants but lacks specific unit-level mappings, CST returns aggregate farm-level operational status rather than hallucinating fictitious unit IDs or crashing.

### 5.4 Acceptance Requirements Remaining
- **External Action Required:** Jeganathan must merge the user-to-device join table in upstream vFarm (`LOOP-1792681313174-ZAKN`). Until deployed upstream, CST operates safely in aggregate farm fallback mode. Loop remains **`OPEN — BLOCKED`**.

---

## 6. Deep Dive: LOOP-1795035800169-NVLF (Content-Type Validation Middleware)

### 6.1 Architecture & Merged Changes
To prevent unparsed body bypasses and malformed payload injection, global pre-route middleware `createPreRouteContentTypeValidator` was implemented in `engine/src/middleware/content_type_validator.ts` and registered in `engine/src/app.ts`:
- Executes before any body parsing or route handling middleware.
- Rejects POST/PUT/PATCH requests lacking `Content-Type: application/json` on JSON endpoints with HTTP 400 Bad Request (`"Content-Type must be application/json"`).
- Rejects malformed JSON with HTTP 400 (`MALFORMED_JSON`) via `handleJsonSyntaxError`.
- Rejects payloads exceeding 100kb with HTTP 413 (`PAYLOAD_TOO_LARGE`).
- Allows empty bodies on allowlisted logout endpoints (`POST /api/v1/web/logout`, `/api/v1/auth/logout`, `/logout`).
- Preserves webhook form-encoded payloads (`/webhooks/twilio/sms`, `/webhooks/twilio/delivery-status`) and dual Form/JSON voice ingress routes (`/webhooks/twilio/voice/*`, `/twilio/voice/*`, `/webhooks/voice/*`).
- Merged into `main` via PR #61 (`af5b7a321b`), PR #62 (`4f2f40906f`), PR #63 (`1ca28d2489`), and PR #68 (`9c046afe5b`).

### 6.2 Live Production Verification (`dep-dc0d7jp5efls739sstj0`)
Empirical curl tests executed directly against `https://bha-cst-7u9e.onrender.com` on live deploy `dep-dc0d7jp5efls739sstj0` (Commit `9c046afe5b`):
- Missing Content-Type: `POST /api/v1/web/session` -> `HTTP/2 400 Bad Request` (`{"error":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type must be application/json"}`) — **PASS**
- Text/Plain Content-Type: `POST /api/v1/web/session` -> `HTTP/2 400 Bad Request` — **PASS**
- Unsupported Charset: `POST /api/v1/web/session` with `charset=iso-8859-1` -> `HTTP/2 400 Bad Request` (`"Unsupported charset \"iso-8859-1\". Only UTF-8 is supported."`) — **PASS**
- Twilio Voice Webhook Signature Gate: `POST /webhooks/twilio/voice/status` -> `HTTP/2 401 Unauthorized` (`"Missing Twilio signature header"` — signature gate reached) — **PASS**

### 6.3 Historical Session Invalidation Verification
Live test against production confirms historical session `web_a8150cbe-e342-4d33-bc90-e373ad31e4d8` is fully invalidated:
- `GET /api/v1/web/session/history` with cookie `cst_session=web_a8150cbe...` -> `HTTP/1.1 401 Unauthorized` (`"Session expired or invalid"`) — **PASS**
- `POST /api/v1/web/message` with cookie `cst_session=web_a8150cbe...` -> `HTTP/1.1 401 Unauthorized` — **PASS**

### 6.4 Browser E2E Suite & Payment Hold Separation
- 8 out of 8 tests in `tests/browser/prod_live_verification.spec.ts` passed in 10.5 seconds when run locally against the live Render production environment. (Note: CI in `.github/workflows/ci.yml` runs unit and regression tests, not Playwright).
- Decision Watch `DW-1795036114694-RK8U` was closed in Bays' Audit 7453. Destiny Arupi confirmed release of the 25% payment hold.
- **Crucial Distinction:** Release of the payment hold does **not** equal loop closure. Technical acceptance remains pending Jason Bays' sign-off. Loop remains **`OPEN — AWAITING_OWNER_ACCEPTANCE`**.

---

## 7. Exact Outstanding Actions for Loop Closure

1. **For Jason Bays:**
   - Review corrected NVLF evidence package and record formal technical acceptance on `LOOP-1795035800169-NVLF`.
   - Review BHARAG re-indexing status under `LOOP-1791991972916-G718` to enable closure of `LOOP-1793031575930-X4EI`.
2. **For Destiny Arupi & Jeganathan:**
   - Provide the restored production n8n webhook URL for `LOOP-1794902688969-80HM` and sign off on the priority taxonomy.
   - Merge the user-to-device join table in vFarm under `LOOP-1792681313174-ZAKN` for `LOOP-1792681313173-0SNO`.
