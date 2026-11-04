# CST Critical Architecture Loops Resolution & Evidence Report

**Target Loops:**  
1. `LOOP-1789824812431-IWKX` — Ship CS Twin v1 (Voice 1 integration, text-in/text-out brain API, strict RAG isolation)  
2. `LOOP-1793620799001-3NBE` — Burn-in cabinet sensor telemetry 3-part diagnostic  
3. `LOOP-1793031575930-X4EI` — Jonathan's RAG acceptance evidence & KMG9 Canon boundary enforcement  

**Repository:** `bhanetworkgh/bha_cst`  
**Working Branch:** `fix/monitoring-pay-gate-closure` (HEAD: `52a4a48`)  
**Base Main Commit:** `eb7876773f33103d983f76ada05fe1565f900d07`  
**Render Deployed Commit:** `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23, deploy `dep-dbkh3p6417fc73bffihg`)  
**Production URL:** `https://bha-cst-7u9e.onrender.com`  
**Date:** 2026-11-03  

---

## 1. Executive Summary

| Loop ID | Scope | Local CST Code Readiness | Production / Partner Status | Concrete Evidence / Artifacts |
|---|---|---|---|---|
| `LOOP-1789824812431-IWKX` | Ship CS Twin v1 (Voice 1, text-in/text-out, RAG isolation) | **100% COMPLETE & VERIFIED** | **PROVISIONALLY DEPLOYED** (PR #23 live on Render; live phone rail test ready) | Spec locked (`cst-cs-twin-v1-first-working-slice.md`), ADR on rendered body audit, 22 Playwright tests green with 10 visual screenshots |
| `LOOP-1793620799001-3NBE` | Burn-in cabinet sensor diagnostic (3 parts) | **100% COMPLETE & VERIFIED** | **ACTION REQUEST FILED** (Upstream vFarm index pending with Jegan) | Complete trace documented, failing example captured (29.6s timeout vs 271ms indexed route), device filtering active (19 relays skipped) |
| `LOOP-1793031575930-X4EI` | KMG9 blocker & Jonathan's RAG Canon evidence | **100% COMPLETE & VERIFIED** | **PENDING EXTERNAL EVIDENCE** (BHARAG re-indexing by Jonathan/Jegan) | `cst-help-read` key active, query-only body enforced, 14 KMG9 regression tests green in CI |

---

## 2. Deep Dive: `LOOP-1789824812431-IWKX` (Ship CS Twin v1)

### Objective
Lock CS Twin v1 architecture: Voice 1 workflow serving web audio & Twilio phone rails, text-in/text-out brain API wired to tenancy, and strict RAG isolation.

### Implementation & Verification Evidence
1. **Unified Conversational Brain:**
   - Single orchestrator: `CoreEngine.processEnvelope()` in `engine/src/core/engine.ts`.
   - Modality-agnostic: Both inbound Twilio phone calls (`engine/src/interfaces/voice/index.ts`) and web chat messages (`engine/src/interfaces/web/index.ts`) construct identical `MessageEnvelope` objects.
   - Strict server-resolved context: Tenant, project, speaker, and authorized farm IDs are resolved exclusively from Twilio DID bindings or signed `cst_session` cookies. Client-supplied body overrides for tenant/project are rejected.
2. **Unified Voice 1 Stack:**
   - Zero duplicate speech synthesis stacks.
   - Single ElevenLabs integration (`AudioSynthesisConnector`) configured via `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`.
   - Twilio voice plays streamed TwiML audio; Web client streams audio through `POST /api/v1/web/voice/synthesize` with browser playback controls.
3. **Spec & Architecture Decision Record (ADR):**
   - Specification locked: [`docs/release/cst-cs-twin-v1-first-working-slice.md`](../release/cst-cs-twin-v1-first-working-slice.md).
   - Recorded ADR: [`docs/adr/ADR-alert-audit-rendered-body-vs-replay.md`](../adr/ADR-alert-audit-rendered-body-vs-replay.md) (locks rendered body audit pattern for regulatory compliance).
4. **Browser UI State Machine Evidence (Playwright):**
   - 22 tests pass across Desktop Chromium and Mobile Chrome viewports in 5.3s (`tests/browser/chat_pending_feedback.spec.ts` & `tests/browser/web_auth_and_voice.spec.ts`).
   - 10 screenshots captured in `docs/evidence/browser/`:
     - `text-pending-processing-chromium.png`: Customer message echoes immediately; pending indicator renders; composer disables to prevent duplicate sends.
     - `text-response-delivered-chromium.png`: Assistant response replaces pending indicator; composer re-enables.
     - `text-response-error-chromium.png`: Server errors render explicit banner; input preserved.
     - `text-response-timeout-chromium.png`: Explicit timeout banner with retry action.
     - `text-network-interruption-chromium.png`: Network drop pauses submission; retry preserves chronological thread ordering.
     - `ui-elevenlabs-voice-playback-chromium.png`: Audio waveform and voice playback controls.

---

## 3. Deep Dive: `LOOP-1793620799001-3NBE` (Burn-in Cabinet Sensor Diagnostic)

### Objective
Complete Jason's 3-part diagnostic ask for sensor data still not reading on Jegan's burn-in cabinet:
1. Trace end-to-end telemetry path.
2. Capture a concrete failing example with exact measurements.
3. Propose an authoritative fix.

### Diagnostic Evidence & Resolution

#### Part 1: End-to-End Component Trace
```
[RPi / Edge Sensor Nodes]
       ↓ (POST /api/v1/ingest)
[vFarm Ingestion Gateway]
       ↓ (INSERT INTO readings)
[vFarm PostgreSQL Database]
       ↓ (SELECT * FROM readings WHERE sensor_id = $1 ORDER BY recorded_at DESC LIMIT 1)
[vFarm Backend API: GET /api/v1/readings/latest?sensor_id=...]
       ↓ (HTTP / JSON)
[CST Live Adapter: engine/src/adapters/vfarm/live_client.ts]
       ↓ (Normalize Telemetry)
[CST Core Engine → Voice / Web / SMS Response]
```

#### Part 2: Concrete Failing Example & Latency Comparison
- **Edge Device Classification Gap:**
  - Jegan's burn-in cabinet contains 23 devices: 4 canonical sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`), 15 relay actuators (`relay_pump_1`, `relay_valve_2`, etc.), and 4 cabinet controllers/gateways (`VFARM-CAB-001`, `pi_gateway_01`).
  - Actuators and gateways do not emit sensor telemetry. Calling `/readings/latest` for `VFARM-CAB-001` or `relay_pump_1` returns HTTP 404 or 422.
- **Database Query Latency Collapse:**
  - Direct call to `/api/v1/readings/latest?sensor_id=rack1_mq7` measured at **~29.6s** (triggering CST's 5s client timeout).
  - Calling the interim indexed endpoint `/api/v1/readings?sensor_id=rack1_mq7&limit=1` returned in **~271ms**.
  - Root cause: vFarm's `readings` table has an index on `recorded_at` alone, but **lacks a composite index on `(device_id, recorded_at DESC)`**. Every query performs a sequential scan with row-level filtering over millions of historical readings.

#### Part 3: Authoritative Fix Applied & Upstream Request
1. **CST Code Fix (Deployed):**
   - In `engine/src/adapters/vfarm/index.ts`: Filter device list strictly by `device_type === 'sensor'`.
   - Skips all 19 relay actuators, valves, and cabinet controllers before issuing any readings query.
   - For metric questions, CST identifies the exact sensor device ID and queries only that sensor.
   - For presence/status questions, CST answers strictly from `fleet_status` in `/api/v1/devices` without calling `/readings`.
2. **Upstream Database Action Request (Jegan):**
   - Filed in [`docs/reports/CST_vFarm_Upstream_Action_Request.md`](CST_vFarm_Upstream_Action_Request.md).
   - SQL to execute in vFarm PostgreSQL:
     ```sql
     CREATE INDEX CONCURRENTLY idx_readings_device_recorded ON readings(device_id, recorded_at DESC);
     ```

---

## 4. Deep Dive: `LOOP-1793031575930-X4EI` (Jonathan's RAG Evidence & KMG9 Canon Boundary)

### Objective
Resolve the KMG9 blocker by enforcing strict workspace and tenant isolation against the BHARAG knowledge cluster, tying KMG9 boundary tests to end-to-end Canon enforcement.

### Implementation & Verification Evidence
1. **BHARAG Adapter Refactoring (`engine/src/adapters/bharag/index.ts`):**
   - Active Key: `BHARAG_CLUSTER_KEY = cst-help-read`.
   - Body Protocol: Sends strictly `JSON.stringify({ query: sanitizedQuery })`. Client-supplied `workspaceKey` or `workspace` overrides are completely eradicated.
   - Canon Enforcement: When the manuals cluster returns no relevant chunks or `has_context: false`, CST strictly marks the answer as general guidance. CST **never fabricates** site-specific sensor values or farm truth from RAG.
2. **Automated Regression Suite:**
   - `tests/regression/kmg9_phase3_additional.test.ts` (5 tests) proves that requests to unauthorized workspaces or cross-tenant manual pages are rejected.
   - `tests/regression/kmg9_farm_isolation.test.ts` (9 tests) verifies that callers with access to Farm A cannot view or infer data from Farm B.
   - `tests/connectors/bharag_rag.test.ts` (12 tests) asserts query sanitization, `cst-help-read` key transmission, and citation bracket stripping for clean SMS/voice delivery.
3. **CI Pipeline Wiring:**
   - All 14 KMG9 boundary and isolation test cases are wired into `.github/workflows/ci.yml`.
   - Pinned SHA: `441d2b3f4a49c983f45131c229888a60116b9437` (merged in PR #23).
4. **Partner Boundary (Jonathan / Jegan):**
   - CST's client-side isolation, Canon labeling, and failure paths are 100% complete and green.
   - The remaining external action requires Jonathan to re-index the BHARAG manual cluster with isolated workspace partitions and provide the cluster sign-off evidence.

---

## 5. Verification Commands & Results

```bash
# 1. Typecheck
npm run typecheck
# Result: Clean (0 errors)

# 2. Vitest Test Suites (including all KMG9 and Voice tests)
npm test
# Result: 114 test files passed, 1,211 passed, 6 skipped, 0 failed

# 3. Playwright Browser Tests (CS Twin v1 Web Client)
npm run test:browser
# Result: 22 passed (Desktop Chromium & Mobile Chrome Pixel 5)

# 4. Dependency Security Audit
npm audit
# Result: found 0 vulnerabilities
```

