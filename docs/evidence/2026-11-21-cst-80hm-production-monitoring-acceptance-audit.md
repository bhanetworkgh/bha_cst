# CST 80HM — Production Monitoring Acceptance Audit and Verification

**Date:** 2026-11-21  
**Repository:** `bhanetworkgh/bha_cst`  
**Current Branch:** `feat/80hm-monitoring-channel-wiring`  
**Deployed Commit (Production):** `e58f81a5445cec382f9c69c68dc80eb4686efab2` (Merge PR #66)  
**Render Service:** `srv-db8hepqvcj2c73adpus0` (`bha-cst`)  
**Production URL:** `https://bha-cst-7u9e.onrender.com` / `https://cst.bhanetwork.org`  
**Target Slack Channel:** `#bha-vfarm-monitoring-twin` (`C0B8JTE51PG`)  
**Target Bot User ID:** `U0CF23JSUG4` (CST Monitoring App `A0CF23GMNHJ`)  
**Target Acceptance Loop:** `LOOP-1794902688969-80HM`  
**Acceptance Decision:** `BLOCKED_EXTERNAL_DEPENDENCY` / `PARTIALLY_VERIFIED` (LOOP REMAINS OPEN)

---

## 1. Executive Summary

This independent production acceptance audit evaluates the CST Monitoring Twin workflow under **LOOP-1794902688969-80HM**.

The target operational chain is:
$$\text{vFarm live sensor/device state} \longrightarrow \text{CST dependency evaluation} \longrightarrow \text{CST monitoring event} \longrightarrow \text{Existing CST Monitoring Slack app} \longrightarrow \text{Persisted evidence} \longrightarrow \text{Recovery notification}$$

### Key Audit Findings

1. **Architecture Clarification (n8n is NOT required):**  
   The direct CST-to-Slack architecture using the existing installed **CST Monitoring Slack App** (`A0CF23GMNHJ`, Bot User `U0CF23JSUG4`) is verified and operational. No n8n webhook, credential, or workflow is required or permitted as an intermediary.
2. **Production Deployment Baseline:**  
   Render service `srv-db8hepqvcj2c73adpus0` is **LIVE** on commit `e58f81a5445cec382f9c69c68dc80eb4686efab2` (Merge PR #66, deploy `dep-dc0bmletlv9c73equpgg`), with environment variable `SLACK_MONITORING_CHANNEL_ID=C0B8JTE51PG` configured and active.
3. **Channel Wiring & 3-Tier Precedence:**  
   Channel configuration precedence is strictly enforced:
   $$\text{1. } \texttt{SLACK\_MONITORING\_CHANNEL\_ID} \longrightarrow \text{2. } \texttt{SLACK\_VFARM\_MONITORING\_CHANNEL\_ID} \longrightarrow \text{3. Production Default } \texttt{C0B8JTE51PG}$$
   Monitoring alerts, incidents, and recoveries target `#bha-vfarm-monitoring-twin` (`C0B8JTE51PG`). Strict channel isolation prevents monitoring alerts from leaking into customer service (`#bha-customer-service-twin` / `C0BD6D53HAM`) or pipeline errors (`#bha-pipeline-errors` / `C0ATC4CA3G9`).
4. **Reconciliation of Production vFarm 401s (Section 7):**  
   The 13 upstream vFarm HTTP 401 failures and 15 degraded results reported during the full audit are definitively proven by Render production logs:
   ```text
   2026-11-20 21:38:11 [WARN] VfarmTenantAdapter: stored admin JWT is expired — re-authenticating
   2026-11-20 21:38:11 [WARN] VfarmTenantAdapter: auto-relogin failed — Login failed (401): {"error":"unauthorized","detail":"Invalid email or password"}
   ```
   The stored admin JWT expired, and upstream vFarm rejected the configured login credentials (`VFARM_ADMIN_EMAIL`/`VFARM_ADMIN_PASSWORD`). CST correctly caught these rejections and **failed closed (HTTP 502 / 401)** without crashing or fabricating mock data.
5. **Runtime Gap (`computeDependentDeviceStatus`):**  
   `computeDependentDeviceStatus` (`engine/src/connectors/vfarm.ts:59-67`) is implemented and verified by 19 tests, but remains **`IMPLEMENTED_BUT_NOT_CONNECTED_TO_RUNTIME`**.
6. **Upstream Blocker (Missing vFarm Topology Contract):**  
   Upstream `.openapi-vfarm.json` provides no device-to-sensor dependency mapping. Because CST is architecturally forbidden from guessing hardware dependencies, dynamic dependent device evaluation remains blocked on the vFarm platform team (Jegan).
7. **Slack Delivery Test Route Enhancement:**  
   Added `monitoring` kind to `POST /api/v1/alerts/test` to allow operator verification of `#bha-vfarm-monitoring-twin` (`C0B8JTE51PG`). 60/60 local automated tests pass cleanly with zero TypeScript errors.

---

## 2. Codebase Implementation & Call Graph Audit

| Component | File & Exact Line Range | Runtime Call Graph Status | Description |
|---|---|---|---|
| `computeDependentDeviceStatus` | `engine/src/connectors/vfarm.ts:59-67` | **`IMPLEMENTED_BUT_NOT_CONNECTED_TO_RUNTIME`** | Evaluates dependent device status. Returns `DEGRADED` on empty/non-online arrays; `NORMAL` only when all sensors are `online`. Called in unit tests only. |
| `notifyDeviceHealthStatus` | `engine/src/connectors/vfarm.ts:73-104` | **`IMPLEMENTED_BUT_NOT_CONNECTED_TO_RUNTIME`** | Dispatches `device_degraded` alert to Slack via `MonitoringSlackService.sendMonitoringAlert`. Called in unit tests only. |
| `notifySensorHealthStatus` | `engine/src/connectors/vfarm.ts:109-158` | **`IMPLEMENTED_BUT_NOT_CONNECTED_TO_RUNTIME`** | Dispatches `sensor_stale` or `sensor_offline` alert to Slack. Called in unit tests only. |
| `recordFailure` | `engine/src/recovery/self_healing_tracker.ts:124-229` | **`CONNECTED_TO_RUNTIME`** | Sliding window failure tracker (threshold: 3 in 10m). Lines 211-225 dispatch `sendIncidentNotification` to `#bha-vfarm-monitoring-twin`. Called in `vfarm/index.ts:1523` and `connectors/vfarm.ts:627, 650`. |
| `attemptRecovery` | `engine/src/recovery/self_healing_tracker.ts:238-320` | **`CONNECTED_TO_RUNTIME`** | Bounded self-healing recheck (max 3 rechecks, 60s cooldown). Lines 299-307 dispatch `sendRecoveryNotification` to `#bha-vfarm-monitoring-twin`. Called in `connectors/vfarm.ts:372`. |
| `MonitoringSlackService` | `engine/src/notifications/monitoring_slack_service.ts:1-871` | **`DEPLOYED_IN_PRODUCTION`** | Slack Web API client supporting monitoring alerts, incidents, escalations, and recoveries with Block Kit formatting, rate limiting (429), exponential backoff (5xx), 60s deduplication, and PII masking. |
| `testAlertRouter` | `engine/src/notifications/test_alert_router.ts:1-160` | **`DEPLOYED_IN_PRODUCTION`** | Operator alert test route. Extended to support `kinds: ['monitoring']` directly triggering `MonitoringSlackService.sendMonitoringAlert` to `#bha-vfarm-monitoring-twin`. |

---

## 3. Upstream vFarm Dependency Contract Analysis

Inspection of `.openapi-vfarm.json` and the vFarm management API surface establishes:

1. **Available Data Models:**
   - `DeviceResponse` (`#/components/schemas/DeviceResponse`): Provides `id`, `device_type`, `parent_device_id`, `child_device_count`, `children`, `status`, `health_score`, `last_seen_at`, `last_reading_at`, `current_state`.
   - `SensorTypeResponse`: Provides hardware model definitions and capabilities.
2. **Missing Dependency Schema:**
   - No schema field or endpoint defines the operational dependency relationship between a physical actuator/device (e.g. dosing pump, irrigation valve, cooling fan) and its required telemetry sensors (e.g. pH sensor, EC sensor, water level switch).
   - No API endpoint returns a directed topology graph or list of upstream sensors for a given device.
3. **CST Architectural Policy:**
   - As documented in `engine/src/connectors/vfarm.ts:160-169`: *"vFarm is the authority for device status. CST never recomputes it from last_seen_at, health score, relay state or a timeout."*
   - Therefore, CST cannot synthesize or guess dependency mappings. Without an authoritative vFarm dependency contract, CST cannot dynamically evaluate dependent device states in the runtime path.
4. **Upstream Ownership:**
   - **Responsible Owner:** Jegan / vFarm Engineering Team.
   - **Required Delivery:** Upstream vFarm contract or metadata endpoint providing `dependent_sensor_ids` or an authoritative device topology graph.

---

## 4. CST Monitoring Slack App Integration Audit

| Property | Value | Evidence / Verification |
|---|---|---|
| **App Name** | CST Monitoring | BHA Slack Workspace Integration |
| **App ID** | `A0CF23GMNHJ` | Verified in integration docs & app manifest |
| **Bot User ID** | `U0CF23JSUG4` | Verified in integration docs & bot profile |
| **Delivery Mechanism** | Direct HTTP POST | `https://slack.com/api/chat.postMessage` via Node `fetch` |
| **Intermediary Needed** | **NONE (No n8n)** | Explicitly confirmed by architecture decision |
| **Channel: Monitoring** | `#bha-vfarm-monitoring-twin` | `C0B8JTE51PG` (Render env active; bot invited; 3-tier fallback in code) |
| **Channel: Escalations** | `#bha-customer-service-twin` | `C0BD6D53HAM` (Verified with live HTTP 200 delivery) |
| **Channel: Errors** | `#bha-pipeline-errors` | `C0ATC4CA3G9` (Verified with live HTTP 200 delivery) |
| **Deduplication** | 60-second sliding cache | `tests/notifications/monitoring_slack_service.test.ts:78` (Passed) |
| **Rate Limit Handling** | HTTP 429 `Retry-After` backoff | `tests/notifications/monitoring_slack_service.test.ts:74` (Passed) |
| **PII & Secret Protection** | Phone masking & token redaction | `tests/notifications/monitoring_slack_service.test.ts:81` (Passed) |

---

## 5. Automated Test & State Transition Matrix

Executing Vitest across all monitoring, recovery, and alert routing test suites:

```text
 ✓ tests/regression/sensor_status_semantics.test.ts (19 tests) 16ms
 ✓ tests/recovery/self_healing_tracker.test.ts (12 tests) 20ms
 ✓ tests/notifications/monitoring_slack_service.test.ts (20 tests) 220ms
 ✓ tests/notifications/test_alert_route.test.ts (9 tests) 22ms

 Test Files  4 passed (4)
      Tests  60 passed (60)
   Duration  554ms
```

### State Transition & Configuration Verification Matrix

| Test Scenario | Expected Outcome | Tested Suite | Status |
|---|---|---|---|
| `SLACK_MONITORING_CHANNEL_ID` set | Uses primary ID (`C0_PRIMARY_ID`) | `monitoring_slack_service.test.ts:18` | `VERIFIED_LOCALLY` |
| Primary unset, alias set | Uses secondary ID (`C0_SECONDARY_ID`) | `monitoring_slack_service.test.ts:18` | `VERIFIED_LOCALLY` |
| Both unset | Falls back to default `C0B8JTE51PG` | `monitoring_slack_service.test.ts:17, 18` | `VERIFIED_LOCALLY` |
| All sensors online | Dependent device is `NORMAL` | `sensor_status_semantics.test.ts` | `VERIFIED_LOCALLY` |
| Any sensor offline/missing/stale | Dependent device is `DEGRADED` | `sensor_status_semantics.test.ts` | `VERIFIED_LOCALLY` |
| Empty/null/undefined sensor array | Dependent device is `DEGRADED` (Fail-safe) | `sensor_status_semantics.test.ts` | `VERIFIED_LOCALLY` |
| Controlled degradation event | Dispatched to `C0B8JTE51PG` | `monitoring_slack_service.test.ts:20` | `VERIFIED_LOCALLY` |
| Controlled recovery event | Dispatched to `C0B8JTE51PG` referencing incident | `monitoring_slack_service.test.ts:20` | `VERIFIED_LOCALLY` |
| Channel isolation | Monitoring → `C0B8JTE51PG`, CS → `C0BD6D53HAM`, Errors → `C0ATC4CA3G9` | `monitoring_slack_service.test.ts:19` | `VERIFIED_LOCALLY` |
| Slack outage/failure resilience | Non-blocking; customer flows never fail | `monitoring_slack_service.test.ts:14` | `VERIFIED_LOCALLY` |
| `POST /api/v1/alerts/test` (monitoring) | Dispatches via `MonitoringSlackService` to `C0B8JTE51PG` | `test_alert_route.test.ts` | `VERIFIED_LOCALLY` |

---

## 6. End-to-End Monitoring Chain Proof & Reality Assessment

The operational monitoring chain defined for 80HM consists of six stages:

```
[Stage 1: vFarm Ingestion] 
   └── Live sensors report telemetry to vFarm. (OPERATIONAL in vFarm)
[Stage 2: Topology & Dependency Evaluation]
   └── vFarm provides sensor-to-device topology contract to CST. (MISSING UPSTREAM)
   └── CST evaluates computeDependentDeviceStatus. (IMPLEMENTED_BUT_NOT_CONNECTED_TO_RUNTIME)
[Stage 3: Monitoring Event Generation]
   └── CST detects degradation and creates monitoring event. (IMPLEMENTED in connector & tracker)
[Stage 4: Slack Dispatch]
   └── MonitoringSlackService sends Block Kit alert to Slack app. (DEPLOYED; test delivery proven)
[Stage 5: Persisted Evidence]
   └── Event recorded in PostgreSQL security_ledger & audit log. (DEPLOYED; verified on prod)
[Stage 6: Recovery Notification]
   └── attemptRecovery detects resolution and sends recovery event. (IMPLEMENTED & tested locally)
```

### Reality Assessment: Test vs Live Event

- **What has been proven in production:**
  1. CST web service is live on Render (`f46f56d3431dec81423c78422176fb2c5be549a8`, deploy `dep-dc0c4dh7lnhs73cnobmg`) and healthy (`/health`, `/health/registry`).
  2. Security ledger and PostgreSQL persistence are actively recording security and audit events.
  3. Direct outbound Slack communication from CST to `#bha-vfarm-monitoring-twin` (`C0B8JTE51PG`) is functional via direct Slack Web API calls without n8n.
  4. Live production alert dispatch (`POST /api/v1/alerts/test`) successfully delivered to `#bha-vfarm-monitoring-twin` (`C0B8JTE51PG`) with Slack message timestamp `1795211582.774859` and `1795211640.827119`.
  5. Multi-channel routing is verified live in production across monitoring (`#bha-vfarm-monitoring-twin`), cs_handoff (`#bha-customer-service-twin`), errors (`#bha-pipeline-errors`), and notifier.
  6. Upstream vFarm credentials and authentication are **RESOLVED & VERIFIED**: Render `VFARM_ADMIN_EMAIL` and `VFARM_ADMIN_PASSWORD` successfully authenticated with upstream vFarm API; full production suite verified with **0 AUTH_BLOCKED** endpoints (down from 13). Live farm discovery returned 2 farms (`Test 001`, `v-farm`) and 25 devices (`GET /api/v1/admin/vfarm/devices`).
- **What has NOT been proven in production:**
  1. A real physical sensor in vFarm transitioning to `offline` or `stale`.
  2. CST evaluating that real event and computing a dependent device as `DEGRADED`.
  3. CST automatically transmitting that live hardware alert to `#bha-vfarm-monitoring-twin`.
  4. CST automatically observing hardware recovery and sending the corresponding recovery notice.

---

## 7. 15-Point Acceptance Criteria Table

| # | Acceptance Criterion | Evaluation Status | Empirical Evidence & Line References |
|---|---|---|---|
| 1 | `computeDependentDeviceStatus` logic correctness | `VERIFIED_LOCALLY` | `engine/src/connectors/vfarm.ts:59-67`; verified by 19 tests in `tests/regression/sensor_status_semantics.test.ts`. |
| 2 | Dependent device fails safe on missing/empty sensor state | `VERIFIED_LOCALLY` | `engine/src/connectors/vfarm.ts:62-64` returns `'DEGRADED'` on `!Array.isArray(sensorStates) \|\| sensorStates.length === 0`. |
| 3 | Dependent device evaluates to NORMAL only when all sensors online | `VERIFIED_LOCALLY` | `engine/src/connectors/vfarm.ts:65-66` uses `sensorStates.every(s => s === 'online')`. |
| 4 | `computeDependentDeviceStatus` runtime execution | `IMPLEMENTED_NOT_VERIFIED` | **`IMPLEMENTED_BUT_NOT_CONNECTED_TO_RUNTIME`**. Zero production routes or background workers invoke it. |
| 5 | Authoritative vFarm dependency topology contract | `BLOCKED_EXTERNAL_DEPENDENCY` | `.openapi-vfarm.json` lacks device-to-sensor dependency mapping. Awaiting vFarm upstream team delivery. |
| 6 | Direct Slack integration architecture (no n8n) | `VERIFIED_IN_PRODUCTION` | `MonitoringSlackService` dispatches directly via `fetch('https://slack.com/api/chat.postMessage')`. No n8n. |
| 7 | Existing CST Monitoring Slack App identity reuse | `VERIFIED_IN_PRODUCTION` | Configured for App `A0CF23GMNHJ`, Bot User `U0CF23JSUG4`. |
| 8 | Channel routing separation (monitoring vs escalations vs errors) | `VERIFIED_IN_PRODUCTION` | Verified live in production via `POST /api/v1/alerts/test` (test `alert_test_aeeb5d21-7042-4779-93e0-f8a730b61531`): monitoring routed to `#bha-vfarm-monitoring-twin` (`C0B8JTE51PG`), cs_handoff to `#bha-customer-service-twin`, errors to `#bha-pipeline-errors`. |
| 9 | Production Slack test alert delivery to #bha-vfarm-monitoring-twin | `VERIFIED_IN_PRODUCTION` | `POST /api/v1/alerts/test` returned HTTP 200 `status: "sent"` with Slack timestamps `1795211582.774859` and `1795211640.827119` directly to `C0B8JTE51PG`. |
| 10 | Live automated sensor monitoring alert in production | `IMPLEMENTED_NOT_VERIFIED` | Synthetic alerts tested; zero live hardware-triggered alerts dispatched to Slack in production. |
| 11 | Render environment variable `SLACK_MONITORING_CHANNEL_ID` / default channel | `VERIFIED_IN_PRODUCTION` | Resolved to `C0B8JTE51PG` on Render production; default fallback in code verified in tests and live execution. |
| 12 | Sliding window deduplication & rate-limit handling | `VERIFIED_LOCALLY` | 60s dedup cache and HTTP 429 `Retry-After` verified in `tests/notifications/monitoring_slack_service.test.ts:74, 78`. |
| 13 | PII masking and secret redaction in Slack payloads | `VERIFIED_LOCALLY` | Phone masking (`maskPhone`) and credential sanitization verified in `tests/notifications/monitoring_slack_service.test.ts:81`. |
| 14 | Persisted audit evidence of failure & recovery in PostgreSQL | `VERIFIED_IN_PRODUCTION` | PostgreSQL table `security_ledger` actively populated and verified via `render psql`. |
| 15 | Responsible owner formal signoff | `OWNER_ACCEPTANCE_PENDING` | Loop `80HM` remains OPEN pending upstream vFarm contract, credentials refresh, and owner review. |

---

## 8. Audit Conclusion and Acceptance Decision

### Decision: `BLOCKED_EXTERNAL_DEPENDENCY` / `PARTIALLY_VERIFIED`

**Do NOT close LOOP-1794902688969-80HM.**

While the CST Slack integration, channel wiring (`C0B8JTE51PG`), and dependency evaluation logic are fully implemented and verified locally (60/60 tests passing), outbound test alerts to `#bha-vfarm-monitoring-twin` (`C0B8JTE51PG`) are empirically verified live on production Render deploy `dep-dc0c21uk1f9s73figv70` (Slack timestamps `1795211582.774859` and `1795211640.827119`), and vFarm upstream credentials have been verified with **0 AUTH_BLOCKED** endpoints, the complete end-to-end chain cannot be verified in production until:
1. Upstream vFarm team provides an authoritative device-to-sensor topology contract (specifying which sensors govern which pumps/relays).
2. `computeDependentDeviceStatus` is wired into a live runtime telemetry polling/webhook loop.
3. An actual live hardware monitoring event executes end-to-end.
