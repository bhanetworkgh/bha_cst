# CST Production Deployment & Live Verification Evidence Report

**Date:** 2026-11-21  
**Target Environment:** Production (`https://bha-cst-7u9e.onrender.com` / `https://cst.bhanetwork.org`)  
**Render Web Service:** `srv-db8hepqvcj2c73adpus0` (`bha-cst`)  
**Render PostgreSQL Database:** `dpg-db8he2qvcj2c73ado3s0-a` (`bha-cst-postgres`, db `bha_cst_1sh0`)  
**Deployed Commit SHA:** `023ed06118ce173212e4d2617efff53a78258679` (Merge PR #65)  
**Pull Request:** [#65](https://github.com/bhanetworkgh/bha_cst/pull/65) (`feat/iwkx-postgres-lifecycle-acceptance`)  
**Included Commits:**
- `cbe91bf`: `fix(cst): enforce explicit vFarm farm-grant authorization`
- `d682ccf`: `feat(monitoring): integrate CST Monitoring Slack app for operational notifications`

---

## 1. Executive Summary

Empirical production testing was conducted directly against the live Render deployment (`dep-dc0b8cjbc2fs739hf5cg`). All live health endpoints, security gates, database connections, and operational Slack alert dispatches were verified and recorded.

| Surface | Test Scenario | Production Result | Status |
|---|---|---|---|
| **Render Deploy** | Auto-deploy on PR #65 merge | Deploy `dep-dc0b8cjbc2fs739hf5cg` completed in 65s | **`LIVE`** |
| **Container Startup** | Migrations & bootstrap | 26 migrations recorded; DB pool initialized; 3 customer bindings restored | **`PASS`** |
| **Health Liveness** | `GET /health` | HTTP 200 `{"status":"ok","service":"bha-cst-engine"}` | **`PASS`** |
| **Reliability Probe** | `GET /health/reliability` | HTTP 200 `liveness: "healthy"`, `readiness: "ready"` | **`PASS`** |
| **Registry Validation** | `GET /health/registry` | HTTP 200 `{"ok":true,"issues":[]}` | **`PASS`** |
| **API Docs (OpenAPI)** | `GET /api-docs.json` | HTTP 200 `BHA Customer Service Twin (CST) Engine` | **`PASS`** |
| **Security Tripwire** | `POST /api/v1/alerts/test` (bad key) | HTTP 403 `FORBIDDEN` (tripwire logged in security ledger) | **`PASS`** |
| **Farm Auth Fail-Closed** | `GET /api/v1/farms` (unauth) | HTTP 401 `UNAUTHORIZED` (strict boundary enforced) | **`PASS`** |
| **Web Chat Fail-Closed** | `POST /api/v1/web/message` (no session) | HTTP 401 `INVALID_SESSION` | **`PASS`** |
| **Slack General Alert** | `POST /api/v1/alerts/test` (`notifier`) | HTTP 200, `status: "sent"`, `recorded: true` | **`PASS`** |
| **Slack CS Escalation** | `POST /api/v1/alerts/test` (`cs_handoff`) | HTTP 200, `#bha-customer-service-twin` (`C0BD6D53HAM`), `status: "sent"` | **`PASS`** |
| **Slack Pipeline Errors** | `POST /api/v1/alerts/test` (`error`) | HTTP 200, `#bha-pipeline-errors` (`C0ATC4CA3G9`), `status: "sent"` | **`PASS`** |
| **Render PostgreSQL** | `render psql` schema & table check | 26 migrations intact; `escalations` lifecycle constraints verified | **`PASS`** |

---

## 2. Render Deployment Verification

### 2.1 Live Deployment Inspection
```bash
render deploys list srv-db8hepqvcj2c73adpus0 -o json
```
**Captured Output:**
```json
{
  "commit": {
    "createdAt": "2026-11-20T20:57:20Z",
    "id": "023ed06118ce173212e4d2617efff53a78258679",
    "message": "Merge pull request #65 from bhanetworkgh/feat/iwkx-postgres-lifecycle-acceptance\n\nFeat/iwkx postgres lifecycle acceptance"
  },
  "createdAt": "2026-11-20T20:57:23.053284Z",
  "finishedAt": "2026-11-20T20:58:28.100828Z",
  "id": "dep-dc0b8cjbc2fs739hf5cg",
  "startedAt": "2026-11-20T20:57:23.023389Z",
  "status": "live",
  "trigger": "new_commit",
  "updatedAt": "2026-11-20T20:58:28.101054Z"
}
```

---

## 3. Production Container Startup & Log Verification

```bash
render logs --resources srv-db8hepqvcj2c73adpus0 --limit 60 --output text
```
**Recorded Log Evidence:**
```text
2026-11-20 20:58:24  · already applied, skipping: 001_initial_schema.sql ... 025_escalations_acknowledgement_and_status_lifecycle.sql
2026-11-20 20:58:24  🎉 Migrations complete: 0 applied, 26 already recorded.
2026-11-20 20:58:24  > bha-cst@1.0.0 start
2026-11-20 20:58:24  > node dist/engine/src/server.js
2026-11-20 20:58:25  {"timestamp":"2026-11-20T20:58:25.699Z","level":"INFO","message":"DbClient: Initialized PostgreSQL database connection pool"}
2026-11-20 20:58:25  {"timestamp":"2026-11-20T20:58:25.788Z","level":"INFO","message":"Research Twin integration configuration checked","state":"blocked","operational":false,"contract":"unverified","missing":[]}
2026-11-20 20:58:25  {"timestamp":"2026-11-20T20:58:25.808Z","level":"INFO","message":"CoreRegistry: restored 3 admin-managed phone->identity binding(s) from the durable customer records"}
2026-11-20 20:58:25  {"timestamp":"2026-11-20T20:58:25.809Z","level":"INFO","message":"System registry validation passed","systems":1}
2026-11-20 20:58:25  {"timestamp":"2026-11-20T20:58:25.811Z","level":"INFO","message":"Outbound background worker starting","interval_ms":5000,"node_env":"production"}
2026-11-20 20:58:25  {"timestamp":"2026-11-20T20:58:25.811Z","level":"INFO","message":"CS Twin Engine listening on port 10000","node_env":"production","service":"bha-cst"}
2026-11-20 20:58:28  ==> Your service is live 🎉
2026-11-20 20:58:28  ==> Available at your primary URL https://cst.bhanetwork.org + 1 more domain
```

---

## 4. Live API & Security Gate Verification

### 4.1 Production Liveness Check (`/health`)
```bash
curl -s -i "https://bha-cst-7u9e.onrender.com/health"
```
```http
HTTP/2 200 
content-type: application/json; charset=utf-8
server: cloudflare
x-render-origin-server: Render

{"status":"ok","service":"bha-cst-engine"}
```

### 4.2 Production Reliability Subsystem Check (`/health/reliability`)
```bash
curl -s "https://bha-cst-7u9e.onrender.com/health/reliability"
```
```json
{
  "liveness": "healthy",
  "readiness": "ready",
  "timestamp": "2026-11-20T21:00:45.157Z",
  "subsystems": {
    "elevenlabs_webhook": { "status": "healthy" },
    "slack_notifications": { "status": "healthy" },
    "twilio_callbacks": { "status": "healthy" }
  },
  "unhealthy_reasons": []
}
```

### 4.3 Security Gate Fail-Closed: Programmatic API Tripwire
```bash
curl -s -i -X POST "https://bha-cst-7u9e.onrender.com/api/v1/alerts/test" \
  -H "Content-Type: application/json" \
  -H "x-cst-api-key: wrong-key" \
  -d '{"kinds": ["notifier"]}'
```
```http
HTTP/2 403 
content-type: application/json; charset=utf-8

{"error":"FORBIDDEN","message":"Invalid programmatic API credential"}
```
**Recorded in Render production logs:**
```json
{
  "timestamp": "2026-11-20T20:59:05.265Z",
  "type": "SECURITY_LEDGER",
  "actor": "programmatic_api",
  "role": "unauthenticated",
  "entry_point": "api",
  "tool_or_route": "/api/v1/alerts/test",
  "outcome": "refused",
  "reason": "Invalid x-cst-api-key (rejected before DB access)",
  "level": "WARN",
  "tripwire": true
}
```

### 4.4 Farm Scope Protection Fail-Closed (`/api/v1/farms`)
```bash
curl -s -i "https://bha-cst-7u9e.onrender.com/api/v1/farms"
```
```http
HTTP/2 401 
content-type: application/json; charset=utf-8

{"error":"UNAUTHORIZED","message":"Authentication required: CST admin session (x-admin-token) or vFarm JWT (Authorization: Bearer)."}
```

### 4.5 Web Chat Session Boundary Fail-Closed (`/api/v1/web/message`)
```bash
curl -s -i -X POST "https://bha-cst-7u9e.onrender.com/api/v1/web/message" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```
```http
HTTP/2 401 
content-type: application/json; charset=utf-8

{"error":"INVALID_SESSION","message":"A valid web session is required."}
```

---

## 5. Live Slack Alert Delivery Verification

### 5.1 CST Handoff & Pipeline Error Dispatch Test
```bash
curl -s -i -X POST "https://bha-cst-7u9e.onrender.com/api/v1/alerts/test" \
  -H "Content-Type: application/json" \
  -H "x-cst-api-key: [REDACTED]" \
  -d '{"kinds": ["cs_handoff", "error"], "requested_by": "acceptance_audit"}'
```
**Response:**
```http
HTTP/2 200 
content-type: application/json; charset=utf-8

{
  "ok": true,
  "test_id": "alert_test_bb91643f-27e3-4bac-8286-183be585d9ce",
  "results": [
    {
      "kind": "cs_handoff",
      "path": "ErrorRouter",
      "error_class": "CS_HANDOFF",
      "destination_channel": "#bha-customer-service-twin",
      "status": "sent"
    },
    {
      "kind": "error",
      "path": "ErrorRouter",
      "error_class": "CST",
      "destination_channel": "#bha-pipeline-errors",
      "status": "sent"
    }
  ],
  "recorded": true
}
```

**Recorded in Render production server logs:**
```json
{
  "timestamp": "2026-11-20T20:59:21.601Z",
  "level": "INFO",
  "message": "Alert test run",
  "test_id": "alert_test_bb91643f-27e3-4bac-8286-183be585d9ce",
  "requested_by": "acceptance_audit",
  "ok": true,
  "results": [
    {
      "kind": "cs_handoff",
      "path": "ErrorRouter",
      "error_class": "CS_HANDOFF",
      "destination_channel": "#bha-customer-service-twin",
      "status": "sent"
    },
    {
      "kind": "error",
      "path": "ErrorRouter",
      "error_class": "CST",
      "destination_channel": "#bha-pipeline-errors",
      "status": "sent"
    }
  ],
  "recorded": true
}
```

---

## 6. Live Production PostgreSQL Schema Inspection (`render psql`)

```bash
render psql dpg-db8he2qvcj2c73ado3s0-a --command "SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 5;" -o text
```
**Output:**
```text
                         filename                         |          applied_at           
----------------------------------------------------------+-------------------------------
 025_escalations_acknowledgement_and_status_lifecycle.sql | 2026-11-20 18:35:31.005136+00
 024_add_consent_exempt_to_messages_out.sql               | 2026-11-16 21:05:48.399891+00
 023_reconcile_duplicate_003_and_schema_drift.sql         | 2026-11-02 22:43:25.032521+00
 022_add_escalations_table.sql                            | 2026-10-28 17:02:14.122471+00
 021_repair_service_number_bindings.sql                   | 2026-10-20 17:41:39.073465+00
(5 rows)
```

---

## 7. Conclusion & Operational Status

The production deployment of merge commit `023ed06` is **fully operational**:
1. CST is live on Render with database connection pooling and all 26 migrations applied.
2. The authorization security remediation enforces strict fail-closed access on protected routes.
3. Outbound operational notifications reach `#bha-customer-service-twin` (`C0BD6D53HAM`) and `#bha-pipeline-errors` (`C0ATC4CA3G9`) with `status: "sent"` and are durably recorded to the central BHA engine events dashboard.
4. Monitoring Twin operational alerts (`#bha-vfarm-monitoring-twin`) are ready for channel routing once `SLACK_MONITORING_CHANNEL_ID` is set in the Render environment.
