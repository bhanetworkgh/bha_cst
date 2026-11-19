# LOOP-1795035800169-NVLF — Pre-Route Content-Type Validation Middleware Evidence Report

**Document Date:** 2026-11-20
**Loop Identifier:** `LOOP-1795035800169-NVLF`
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`
**Decision Watch Reference:** `DW-1795036114694-RK8U`
**Primary Slack Discussion:** [https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1795035800416699](https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1795035800416699)
**Target Repository:** `bhanetworkgh/bha_cst`
**Production Target:** `https://bha-cst-7u9e.onrender.com`
**Render Service ID:** `srv-db8hepqvcj2c73adpus0` (`bha-cst`)
**Live Production Deploy ID:** `dep-dbvles0jo6nc73a7p5ag` (Commit `4f2f40906fc2b0e3a2da47ece07e2e16441a4fc2`, PR #62)
**Implementation Status:** `COMPLETED`
**Evidence Status:** `VERIFIED` (11/11 local tests passed; production HTTP verified; Render container logs verified; application-reported DB write path verified)
**Owner Acceptance Status:** `READY_FOR_OWNER_ACCEPTANCE`

---

## 1. Executive Summary

During the review of `CODEX-20261118-ahad-cst-error-routing` and the subsequent Decision Watch `DW-1795036114694-RK8U`, Jason instructed the team to close the open loop `LOOP-1795035800169-NVLF` by implementing explicit, pre-route Content-Type validation on JSON-expecting endpoints (`/api/v1/web` and webhooks).

Previously, requests with missing or unsupported media types (e.g., `text/plain` or missing headers) were skipped by Express's `express.json()` body-parser without error. This left `req.body` unpopulated (`undefined` or `{}`), silently causing downstream handlers to fail with generic authentication errors (`AUTH_REQUIRED`) or missing-field exceptions rather than alerting the client to the protocol violation.

This implementation provides:
1. Pre-route Content-Type validation middleware ([engine/src/middleware/content_type_validator.ts](../../engine/src/middleware/content_type_validator.ts)) mounted before JSON route handlers in [engine/src/app.ts](../../engine/src/app.ts).
2. Explicit rejection of missing or unsupported media types with **HTTP 400 Bad Request** and a standard machine-readable JSON envelope:
   ```json
   {
     "error": "UNSUPPORTED_MEDIA_TYPE",
     "message": "Content-Type must be application/json",
     "correlation_id": "cst_..."
   }
   ```
3. Custom JSON parse error handling (`handleJsonSyntaxError`) intercepting body-parser syntax errors and returning **HTTP 400 MALFORMED_JSON** with preserved correlation IDs.
4. Security-ledger audit persistence via `Logger.audit` with structured operational telemetry.
5. Strict protection of Twilio webhooks (`/webhooks`, `/webhooks/sms`, `/webhooks/voice`), which legitimately consume `application/x-www-form-urlencoded` and require uncorrupted `rawBody` buffers for HMAC signature verification.
6. Automated verification across 11 unit tests in [tests/middleware/content_type_validation.test.ts](../../tests/middleware/content_type_validation.test.ts).
7. Live production verification on deployed Render instance `dep-dbvles0jo6nc73a7p5ag` via curl and Render real-time log inspection.

---

## 2. Express Middleware Architecture & Ordering

In [engine/src/app.ts](../../engine/src/app.ts), the middleware pipeline is structured as follows:

```
[Incoming HTTP Request]
        │
        ▼
1. Trust Proxy Configuration (`app.set('trust proxy', true)`)
        │
        ▼
2. Body Parsing Layer:
   ├── /webhooks/elevenlabs (express.json limit 5mb + rawBody capture)
   ├── express.urlencoded (limit 100kb + rawBody capture for Twilio)
   └── express.json (limit 100kb + rawBody capture)
        │
        ▼
3. JSON Syntax Error Interceptor (`handleJsonSyntaxError`)
   └── Catches body-parser SyntaxError → Returns HTTP 400 MALFORMED_JSON
        │
        ▼
4. Security Headers (nosniff, DENY, XSS-Protection)
        │
        ▼
5. Rate Limiter Middleware (/webhooks, 120 req/min)
        │
        ▼
6. Pre-Route Media Type Validation & Router Mounting:
   ├── /webhooks (Twilio SMS & outbound: urlencoded allowed, signature verified)
   ├── /webhooks/voice (Twilio Voice: urlencoded allowed, signature verified)
   ├── /webhooks/research-twin (validateJsonContentType() → JSON strictly enforced)
   ├── /webhooks/elevenlabs (validateJsonContentType() → JSON strictly enforced)
   ├── /api/v1/auth (validateJsonContentType() → JSON strictly enforced)
   ├── /api/v1/admin (validateJsonContentType() → JSON strictly enforced)
   └── /api/v1/web (validateJsonContentType() → JSON strictly enforced, /logout exempted)
```

---

## 3. Implementation Details

### 3.1 Content-Type Validator Middleware
Located in [engine/src/middleware/content_type_validator.ts](../../engine/src/middleware/content_type_validator.ts):
- Evaluates HTTP method: only mutative methods (`POST`, `PUT`, `PATCH`) are evaluated.
- Evaluates body presence: `hasRequestBody(req)` inspects `content-length` and `transfer-encoding: chunked`.
- Empty-body allowlist: `/api/v1/web/logout` is permitted without Content-Type when no body is transmitted.
- Validation checks:
  - If `Content-Type` is missing on a request carrying a body: rejected with HTTP 400 `UNSUPPORTED_MEDIA_TYPE`.
  - If `Content-Type` is set to `text/plain`, `multipart/form-data`, or any non-JSON media type: rejected with HTTP 400 `UNSUPPORTED_MEDIA_TYPE`.
  - Emits structured security audit entry with fields: `service: 'cst'`, `component: 'content_type_validator'`, `event_name: 'request_rejected'`, `http_status: 400`, `error_code: 'UNSUPPORTED_MEDIA_TYPE'`, `failure_stage: 'pre_route_media_validation'`, and `classification: 'client_protocol_error'`.
  - Preserves and reflects `X-Correlation-ID` header.
  - Zero sensitive payload logging: credentials, passwords, and tokens are omitted.

### 3.2 Twilio Webhook Signature Safety
Twilio webhooks call `/webhooks`, `/webhooks/sms`, and `/webhooks/voice`.
- These endpoints receive `application/x-www-form-urlencoded` payloads signed with `X-Twilio-Signature`.
- `validateJsonContentType` is **not mounted** on the root `/webhooks` router.
- `express.urlencoded()` parses the form parameters into `req.body`, while the `verify` callback stores the exact string in `req.rawBody`.
- `verifyTwilioSignature` validates the request using `twilio.validateRequest(authToken, twilioSignature, url, params)`.
- Verified in tests and production: Twilio requests with `application/x-www-form-urlencoded` pass through without media-type rejection, and reach the Twilio signature verification gate where an unsigned request is rejected with HTTP 401.

---

## 4. Automated Test Scenarios & Execution Proof

Test file: [tests/middleware/content_type_validation.test.ts](../../tests/middleware/content_type_validation.test.ts)

| Scenario | Request | Header | Expected Result | Actual Result | Implementation Status | Evidence Status |
|---|---|---|---|---|---|---|
| Missing Content-Type | `POST /api/v1/web/session` | None / unset | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, structured envelope | `COMPLETED` | `VERIFIED` |
| Text/plain | `POST /api/v1/web/session` | `Content-Type: text/plain` | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, correlation ID preserved | `COMPLETED` | `VERIFIED` |
| Multipart form data | `POST /api/v1/web/session` | `Content-Type: multipart/form-data` | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, rejected pre-route | `COMPLETED` | `VERIFIED` |
| Webhook text/plain | `POST /webhooks/elevenlabs` | `Content-Type: text/plain` | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, rejected pre-route | `COMPLETED` | `VERIFIED` |
| Valid JSON | `POST /api/v1/web/session` | `Content-Type: application/json` | Passes to handler (HTTP 201) | HTTP 201 Created | `COMPLETED` | `VERIFIED` |
| Malformed JSON body | `POST /api/v1/web/session` | `Content-Type: application/json` | HTTP 400 MALFORMED_JSON | HTTP 400 MALFORMED_JSON | `COMPLETED` | `VERIFIED` |
| Twilio Form Post | `POST /webhooks` | `application/x-www-form-urlencoded` | Passes media check (not 400) | Not rejected with 400 | `COMPLETED` | `VERIFIED` |
| Twilio Signature Gate | `POST /webhooks/voice/inbound` | Missing signature | HTTP 401 UNAUTHORIZED | HTTP 401 UNAUTHORIZED | `COMPLETED` | `VERIFIED` |
| GET Request | `GET /api/v1/web/projects` | No Content-Type | Passes normally (HTTP 200) | HTTP 200 OK | `COMPLETED` | `VERIFIED` |
| Allowlisted Logout | `POST /api/v1/web/logout` | No body, no Content-Type | Passes normally (HTTP 204) | HTTP 204 No Content | `COMPLETED` | `VERIFIED` |
| Sensitive Data Redaction | `POST /api/v1/web/session` | `password=secret` in text body | Credentials omitted from logs/response | Zero credentials leaked | `COMPLETED` | `VERIFIED` |

### Vitest Test Execution Output:
```
 ✓ tests/middleware/content_type_validation.test.ts (11 tests) 28ms
   ✓ LOOP-1795035800169-NVLF: Content-Type Validation, Observability & Error Handling (11)
     ✓ rejects POST to JSON endpoint without Content-Type with HTTP 400 and structured envelope
     ✓ rejects POST to JSON endpoint with text/plain with HTTP 400
     ✓ rejects unsupported media type multipart/form-data on JSON endpoint with HTTP 400
     ✓ rejects POST to webhook JSON endpoint with text/plain with HTTP 400
     ✓ allows POST to JSON endpoint with application/json and valid body
     ✓ catches malformed JSON on application/json requests and returns HTTP 400 MALFORMED_JSON
     ✓ does NOT reject Twilio webhook POST with application/x-www-form-urlencoded
     ✓ rejects Twilio webhook when signature is missing (proves signature gate intact)
     ✓ does NOT reject GET requests to any endpoint without Content-Type
     ✓ allows empty-body POST to allowlisted logout route without Content-Type
     ✓ does not expose credentials or sensitive parameters in error responses or audit logs

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

---

## 5. Live Production Verification & Telemetry Proof

Following the merge of PR #62 (`4f2f40906fc2b0e3a2da47ece07e2e16441a4fc2`), Render deployment `dep-dbvles0jo6nc73a7p5ag` went live on service `srv-db8hepqvcj2c73adpus0` at `2026-11-19T20:10:00.428419Z`.

Live HTTP verification was executed directly against `https://bha-cst-7u9e.onrender.com`:

### 5.1 Production Request Verification Table

| Test ID | Path & Method | Headers | Body | Status | Response Body | Implementation Status | Evidence Status |
|---|---|---|---|---|---|---|---|
| `prod_live_test_missing_ct_001` | `POST /api/v1/web/session` | None / unset | `{"email":"test@example.com"}` | **400 Bad Request** | `{"error":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type must be application/json","correlation_id":"prod_live_test_missing_ct_001"}` | `COMPLETED` | `VERIFIED` |
| `prod_live_test_text_plain_002` | `POST /api/v1/web/session` | `Content-Type: text/plain` | `email=test@example.com` | **400 Bad Request** | `{"error":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type must be application/json","correlation_id":"prod_live_test_text_plain_002"}` | `COMPLETED` | `VERIFIED` |
| `prod_live_test_malformed_json_003` | `POST /api/v1/web/session` | `Content-Type: application/json` | `{ invalid_json_syntax: true }` | **400 Bad Request** | `{"error":"MALFORMED_JSON","message":"Request body contains invalid JSON","correlation_id":"prod_live_test_malformed_json_003"}` | `COMPLETED` | `VERIFIED` |
| `prod_live_test_logout_004` | `POST /api/v1/web/logout` | No Content-Type | *(empty)* | **204 No Content** | *(empty response)* | `COMPLETED` | `VERIFIED` |
| *(Read-only)* | `GET /api/v1/web/projects` | None | *(none)* | **200 OK** | `[{"project_id":"proj-vfarm-main","name":"vFarm Austin HQ"}]` | `COMPLETED` | `VERIFIED` |
| `prod_live_test_twilio_005` | `POST /webhooks/voice/inbound` | `Content-Type: application/x-www-form-urlencoded` | `CallSid=CA123&From=%2B15551234567` | **401 Unauthorized** | Twilio signature check error | `COMPLETED` | `VERIFIED` (Proves Twilio signature gate reached; not authenticated) |

*Important Clarification on Scenario 6:* The HTTP 401 response demonstrates that the request bypassed the JSON media-type validator and successfully reached the Twilio webhook signature verification gate. It does not demonstrate a successful authenticated Twilio request.

### 5.2 Real Production Render Logs Captured via CLI

Inspection of live container logs (`render logs --resources srv-db8hepqvcj2c73adpus0 --limit 60`) confirms that incoming rejections were handled pre-route and emitted structured audit logs:

```log
Nov 19 20:12:22 bha-cst-7u9e {"timestamp":"2026-11-19T20:12:22.951Z","type":"SECURITY_LEDGER","tenant_id":null,"actor":"anonymous","role":"unknown","entry_point":"api","tool_or_route":"/session","outcome":"refused","reason":"MISSING_CONTENT_TYPE","correlation_id":"prod_live_test_missing_ct_001","commercial_impact":"Request rejected due to missing Content-Type header on JSON endpoint","service":"cst","environment":"production","component":"content_type_validator","event_name":"request_rejected","event_type":"security_audit","route":"/session","method":"POST","http_status":400,"error_code":"UNSUPPORTED_MEDIA_TYPE","failure_stage":"pre_route_media_validation","classification":"client_protocol_error","source_system":"cst_gateway","content_type":null,"level":"WARN","tripwire":true}
Nov 19 20:12:22 bha-cst-7u9e {"timestamp":"2026-11-19T20:12:22.955Z","level":"INFO","message":"Security ledger event recorded: /session","service":"cst","environment":"production"}
Nov 19 20:12:30 bha-cst-7u9e {"timestamp":"2026-11-19T20:12:30.938Z","type":"SECURITY_LEDGER","tenant_id":null,"actor":"anonymous","role":"unknown","entry_point":"api","tool_or_route":"/session","outcome":"refused","reason":"UNSUPPORTED_CONTENT_TYPE","correlation_id":"prod_live_test_text_plain_002","commercial_impact":"Request rejected due to unsupported Content-Type \"text/plain\" on JSON endpoint","service":"cst","environment":"production","component":"content_type_validator","event_name":"request_rejected","event_type":"security_audit","route":"/session","method":"POST","http_status":400,"error_code":"UNSUPPORTED_MEDIA_TYPE","failure_stage":"pre_route_media_validation","classification":"client_protocol_error","source_system":"cst_gateway","content_type":"text/plain","level":"WARN","tripwire":true}
Nov 19 20:12:30 bha-cst-7u9e {"timestamp":"2026-11-19T20:12:30.942Z","level":"INFO","message":"Security ledger event recorded: /session","service":"cst","environment":"production"}
Nov 19 20:12:36 bha-cst-7u9e {"timestamp":"2026-11-19T20:12:36.438Z","level":"WARN","message":"Malformed JSON payload rejected on /api/v1/web/session: Unexpected token 'i', \"{ invalid_\"... is not valid JSON","service":"cst","environment":"production","component":"content_type_validator","event_name":"malformed_json_rejected","event_type":"protocol_error","correlation_id":"prod_live_test_malformed_json_003","path":"/api/v1/web/session","method":"POST","http_status":400,"error_code":"MALFORMED_JSON","failure_stage":"body_parsing","classification":"client_syntax_error","source_system":"cst_gateway"}
```

### 5.3 Database Write Path Verification & Limitations

- **Application Log Write Path:** `VERIFIED`. The log line `{"message":"Security ledger event recorded: /session"}` is emitted by `DbClient.recordSecurityLedgerEvent(...)` upon execution of the SQL `INSERT INTO security_ledger ...` write path.
- **Direct Database Inspection:** `NOT INDEPENDENTLY VERIFIED`. Direct read-only SQL querying of `security_ledger` rows in datastore `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`) was not performed directly via psql due to private network isolation. The claim of database persistence is based strictly on application runtime logs reporting successful write execution.
