# CST Structured Logging & Silent-Failure Elimination Report

**Document Date:** 2026-11-20  
**Context:** CST Observability Hardening & Telemetry Standardization  
**Related Loops:** `LOOP-1795035800169-NVLF`, `LOOP-1794902688969-80HM`  
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`  
**Status:** `IMPLEMENTED` / `CODE_VERIFIED` / `LOCAL_TEST_VERIFIED`

---

## 1. Objective & Problem Analysis

In distributed multi-channel applications like CST (handling voice, SMS, web, and webhooks), failures must be identifiable, attributable, and diagnosable without inspecting raw customer payloads or logging private secrets.

The incident addressed in `LOOP-1795035800169-NVLF` demonstrated that Express body parsing skips unmatching Content-Types, leaving `req.body` empty without emitting an alert or log. This caused downstream route handlers to report generic secondary failures (e.g. `AUTH_REQUIRED`) instead of the true protocol root cause (`UNSUPPORTED_MEDIA_TYPE`). Similarly, body-parser syntax errors previously threw uncaught `SyntaxError` exceptions that produced unformatted 500 errors without preserved correlation IDs.

This workstream eliminates these silent-failure paths and standardizes structured operational telemetry across CST gateways.

---

## 2. Standardized Telemetry Schema

Structured events emitted by CST gateways and middleware are standardized around the following fields:

| Field | Type | Description | Example |
|---|---|---|---|
| `timestamp` | ISO-8601 string | UTC time when the event occurred | `2026-11-19T19:57:28.750Z` |
| `level` | string | Standard severity level (`INFO`, `WARN`, `ERROR`) | `WARN` |
| `service` | string | Canonical service identifier | `cst` |
| `environment` | string | Deployment environment (`production`, `staging`, `test`) | `production` |
| `component` | string | Specific subsystem or middleware module | `content_type_validator` |
| `event_name` | string | Normalized snake_case event name | `request_rejected` |
| `event_type` | string | Category of event (`security_audit`, `protocol_error`) | `security_audit` |
| `correlation_id` | string | Traceable ingress correlation identifier | `cst_aec5c45d-c561-486f` |
| `route` | string | Requested endpoint path | `/api/v1/web/session` |
| `method` | string | HTTP request method | `POST` |
| `http_status` | number | HTTP status code returned to client | `400` |
| `error_code` | string | Stable machine-readable error token | `UNSUPPORTED_MEDIA_TYPE` |
| `failure_stage` | string | Exact pipeline phase where failure occurred | `pre_route_media_validation` |
| `classification` | string | Failure taxonomy classification | `client_protocol_error` |
| `source_system` | string | Ingress gateway or upstream authority | `cst_gateway` |
| `outcome` | string | Security ledger outcome (`ok`, `refused`, `error`) | `refused` |
| `commercial_impact`| string | Business or reliability impact statement | *"Request rejected due to unsupported Content-Type"* |

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
- Request bodies, passwords, auth tokens, and Twilio/ElevenLabs HMAC signatures are **strictly excluded** from log payloads.
- Verified in [tests/middleware/content_type_validation.test.ts](../../tests/middleware/content_type_validation.test.ts): requests containing `password=super_secret_password` were rejected with zero credential leakage into response bodies or audit logs.

---

## 4. Verification Evidence

### Audit Log Sample Emitted by CST Gateway:
```json
{
  "timestamp": "2026-11-19T19:57:28.750Z",
  "type": "SECURITY_LEDGER",
  "tenant_id": null,
  "actor": "anonymous",
  "role": "unknown",
  "entry_point": "api",
  "tool_or_route": "/session",
  "outcome": "refused",
  "reason": "UNSUPPORTED_CONTENT_TYPE",
  "correlation_id": "cst_aec5c45d-c561-486f-8042-1d493afddc66",
  "commercial_impact": "Request rejected due to unsupported Content-Type \"application/x-www-form-urlencoded\" on JSON endpoint",
  "service": "cst",
  "environment": "test",
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
  "content_type": "application/x-www-form-urlencoded",
  "level": "WARN",
  "tripwire": true
}
```

### Syntax Error Telemetry Log Sample:
```json
{
  "timestamp": "2026-11-19T19:57:28.763Z",
  "level": "WARN",
  "message": "Malformed JSON payload rejected on /api/v1/web/session: Expected double-quoted property name in JSON at position 24 (line 1 column 25)",
  "service": "cst",
  "environment": "test",
  "component": "content_type_validator",
  "event_name": "malformed_json_rejected",
  "event_type": "protocol_error",
  "correlation_id": "malformed_d3b90a59-e16a-4d68-b0e1-2d6c4bb78889",
  "path": "/api/v1/web/session",
  "method": "POST",
  "http_status": 400,
  "error_code": "MALFORMED_JSON",
  "failure_stage": "body_parsing",
  "classification": "client_syntax_error",
  "source_system": "cst_gateway"
}
```
