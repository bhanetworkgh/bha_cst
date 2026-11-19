# CST Structured Logging & Silent-Failure Elimination Report

**Document Date:** 2026-11-20
**Context:** CST Observability Hardening & Telemetry Standardization
**Related Loops:** `LOOP-1795035800169-NVLF`, `LOOP-1794902688969-80HM`
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`
**Decision Watch Reference:** `DW-1795036114694-RK8U`
**Production Target:** `https://bha-cst-7u9e.onrender.com` (`srv-db8hepqvcj2c73adpus0`)
**Live Production Deploy ID:** `dep-dbvles0jo6nc73a7p5ag` (Commit `4f2f40906fc2b0e3a2da47ece07e2e16441a4fc2`, PR #62)
**Implementation Status:** `COMPLETED`
**Evidence Status:** `VERIFIED` (Telemetry schema, console WARN logs, and application log write path verified; direct database inspection NOT INDEPENDENTLY VERIFIED)
**Owner Acceptance Status:** `READY_FOR_OWNER_ACCEPTANCE`

---

## 1. Objective & Problem Analysis

In distributed multi-channel applications like CST (handling voice, SMS, web, and webhooks), failures must be identifiable, attributable, and diagnosable without inspecting raw customer payloads or logging private secrets.

The incident addressed in `LOOP-1795035800169-NVLF` demonstrated that Express body parsing skips unmatching Content-Types, leaving `req.body` empty without emitting an alert or log. This caused downstream route handlers to report generic secondary failures (e.g. `AUTH_REQUIRED`) instead of the true protocol root cause (`UNSUPPORTED_MEDIA_TYPE`). Similarly, body-parser syntax errors previously threw uncaught `SyntaxError` exceptions that produced unformatted 500 errors without preserved correlation IDs.

This workstream eliminates these silent-failure paths and standardizes structured operational telemetry across CST gateways.

---

## 2. Standardized Telemetry Schema

Structured events emitted by CST gateways and middleware are standardized around the following 17 fields:

| Field | Type | Description | Example |
|---|---|---|---|
| `timestamp` | ISO-8601 string | UTC time when the event occurred | `2026-11-19T20:12:22.951Z` |
| `level` | string | Standard severity level (`INFO`, `WARN`, `ERROR`) | `WARN` |
| `service` | string | Canonical service identifier | `cst` |
| `environment` | string | Deployment environment (`production`, `staging`, `test`) | `production` |
| `component` | string | Specific subsystem or middleware module | `content_type_validator` |
| `event_name` | string | Normalized snake_case event name | `request_rejected` |
| `event_type` | string | Category of event (`security_audit`, `protocol_error`) | `security_audit` |
| `correlation_id` | string | Traceable ingress correlation identifier | `prod_live_test_missing_ct_001` |
| `route` | string | Requested endpoint path | `/api/v1/web/session` |
| `method` | string | HTTP request method | `POST` |
| `http_status` | number | HTTP status code returned to client | `400` |
| `error_code` | string | Stable machine-readable error token | `UNSUPPORTED_MEDIA_TYPE` |
| `failure_stage` | string | Exact pipeline phase where failure occurred | `pre_route_media_validation` |
| `classification` | string | Failure taxonomy classification | `client_protocol_error` |
| `source_system` | string | Ingress gateway or upstream authority | `cst_gateway` |
| `outcome` | string | Security ledger outcome (`ok`, `refused`, `error`) | `refused` |
| `commercial_impact`| string | Business or reliability impact statement | *"Request rejected due to missing Content-Type header on JSON endpoint"* |

---

## 3. Silent-Failure Elimination Across CST Request Flows

### 3.1 Pre-Route Media Type Enforcement
- **Silent Path Removed:** Express body-parser skipping non-JSON POST requests, leaving `req.body` empty.
- **New Behavior:** `validateJsonContentType` validates `Content-Type` before route handlers run. Rejections are logged to the security audit ledger and returned with HTTP 400.

### 3.2 JSON Syntax Error Interception
- **Silent Path Removed:** Malformed JSON strings in request bodies triggering uncaught `SyntaxError` that bypassed application handlers and returned a generic Express 500 error page.
- **New Behavior:** `handleJsonSyntaxError` intercepts `body-parser` syntax errors, logs a structured `WARN` event with `event_name: 'malformed_json_rejected'`, and returns HTTP 400 `MALFORMED_JSON` with `X-Correlation-ID`.

### 3.3 Telemetry Semantics (Sensor Data)
- **Silent Path Removed:** Missing or null sensor data defaulting to `normal` health.
- **New Behavior:** In `engine/src/connectors/vfarm.ts` and `sensor_status_semantics.test.ts`, null readings map explicitly to `telemetry_unavailable`. Stale readings (>24h) set `stale: true` and are flagged as degraded.

### 3.4 Data Privacy & Redaction Requirements
To prevent credential leaks:
- Request bodies, passwords, auth tokens, and Twilio/ElevenLabs HMAC signatures are strictly excluded from log payloads.
- Verified in tests and production: requests containing sensitive parameters are rejected with zero credential leakage into response bodies or audit logs.

---

## 4. Local Test Evidence

All 11 unit and integration scenarios passed in [tests/middleware/content_type_validation.test.ts](../../tests/middleware/content_type_validation.test.ts):
- Missing Content-Type rejected with HTTP 400 envelope and security ledger emission.
- `text/plain` rejected with HTTP 400 and preserved correlation ID.
- Malformed JSON intercepted and formatted with HTTP 400 `MALFORMED_JSON`.
- Sensitive passwords completely omitted from log metadata and response bodies.

---

## 5. Live Production Log Verification (Render Deploy `dep-dbvles0jo6nc73a7p5ag`)

Following the deployment of commit `4f2f40906fc2b0e3a2da47ece07e2e16441a4fc2` (PR #62) to Render service `srv-db8hepqvcj2c73adpus0`, real live traffic was executed against `https://bha-cst-7u9e.onrender.com`.

The following logs were captured via `render logs --resources srv-db8hepqvcj2c73adpus0 --limit 60`:

### 5.1 Missing Content-Type Production Log (`prod_live_test_missing_ct_001`)
```json
{
  "timestamp": "2026-11-19T20:12:22.951Z",
  "type": "SECURITY_LEDGER",
  "tenant_id": null,
  "actor": "anonymous",
  "role": "unknown",
  "entry_point": "api",
  "tool_or_route": "/session",
  "outcome": "refused",
  "reason": "MISSING_CONTENT_TYPE",
  "correlation_id": "prod_live_test_missing_ct_001",
  "commercial_impact": "Request rejected due to missing Content-Type header on JSON endpoint",
  "service": "cst",
  "environment": "production",
  "component": "content_type_validator",
  "event_name": "request_rejected",
  "event_type": "security_audit",
  "route": "/session",
  "method":"POST",
  "http_status": 400,
  "error_code": "UNSUPPORTED_MEDIA_TYPE",
  "failure_stage": "pre_route_media_validation",
  "classification": "client_protocol_error",
  "source_system": "cst_gateway",
  "content_type": null,
  "level": "WARN",
  "tripwire": true
}
```
**Follow-up application log write path:**
```json
{
  "timestamp": "2026-11-19T20:12:22.955Z",
  "level": "INFO",
  "message": "Security ledger event recorded: /session",
  "service": "cst",
  "environment": "production"
}
```

### 5.2 Unsupported Media Type (`text/plain`) Production Log (`prod_live_test_text_plain_002`)
```json
{
  "timestamp": "2026-11-19T20:12:30.938Z",
  "type": "SECURITY_LEDGER",
  "tenant_id": null,
  "actor": "anonymous",
  "role": "unknown",
  "entry_point": "api",
  "tool_or_route": "/session",
  "outcome": "refused",
  "reason": "UNSUPPORTED_CONTENT_TYPE",
  "correlation_id": "prod_live_test_text_plain_002",
  "commercial_impact": "Request rejected due to unsupported Content-Type \"text/plain\" on JSON endpoint",
  "service": "cst",
  "environment": "production",
  "component": "content_type_validator",
  "event_name": "request_rejected",
  "event_type": "security_audit",
  "route": "/session",
  "method": "POST",
  "http_status": 400,
  "error_code": "UNSUPPORTED_MEDIA_TYPE",
  "failure_stage": "pre_route_media_validation",
  "classification": "client_protocol_error",
  "source_system": "cst_gateway",
  "content_type": "text/plain",
  "level": "WARN",
  "tripwire": true
}
```
**Follow-up application log write path:**
```json
{
  "timestamp": "2026-11-19T20:12:30.942Z",
  "level": "INFO",
  "message": "Security ledger event recorded: /session",
  "service": "cst",
  "environment": "production"
}
```

### 5.3 Malformed JSON Syntax Interception Production Log (`prod_live_test_malformed_json_003`)
```json
{
  "timestamp": "2026-11-19T20:12:36.438Z",
  "level": "WARN",
  "message": "Malformed JSON payload rejected on /api/v1/web/session: Unexpected token 'i', \"{ invalid_\"... is not valid JSON",
  "service": "cst",
  "environment": "production",
  "component": "content_type_validator",
  "event_name": "malformed_json_rejected",
  "event_type": "protocol_error",
  "correlation_id": "prod_live_test_malformed_json_003",
  "path": "/api/v1/web/session",
  "method": "POST",
  "http_status": 400,
  "error_code": "MALFORMED_JSON",
  "failure_stage": "body_parsing",
  "classification": "client_syntax_error",
  "source_system": "cst_gateway"
}
```

---

## 6. Distinguishing Application Log Evidence from Direct Database Inspection

- **Application-Reported Write Path (`VERIFIED`):** The application logs explicitly confirm that `DbClient.recordSecurityLedgerEvent(...)` executed its write routine for each rejected request, emitting `Security ledger event recorded: /session` within 4ms.
- **Direct Database Datastore Verification (`NOT INDEPENDENTLY VERIFIED`):** Direct SQL query verification (e.g. `SELECT * FROM security_ledger WHERE correlation_id = ...`) against PostgreSQL datastore `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`) was not performed because direct psql access is restricted by private network boundaries. The evidence confirms the application's reported write execution path, but direct datastore inspection remains not independently verified.
