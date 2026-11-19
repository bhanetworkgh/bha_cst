# LOOP-1795035800169-NVLF — Pre-Route Content-Type Validation Middleware Evidence Report

**Document Date:** 2026-11-20  
**Loop Identifier:** `LOOP-1795035800169-NVLF`  
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`  
**Decision Watch Reference:** `DW-1795036114694-RK8U`  
**Primary Slack Discussion:** [https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1795035800416699](https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1795035800416699)  
**Target Repository:** `bhanetworkgh/bha_cst`  
**Status:** `READY_FOR_PR` / `CODE_VERIFIED` / `LOCAL_TEST_VERIFIED`

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
- Verified in tests: Twilio requests with `application/x-www-form-urlencoded` pass through without media-type rejection, and missing/invalid signatures are refused with HTTP 401.

---

## 4. Automated Test Scenarios & Execution Proof

Test file: [tests/middleware/content_type_validation.test.ts](../../tests/middleware/content_type_validation.test.ts)

| Scenario | Request | Header | Expected Result | Actual Result | Proof Type |
|---|---|---|---|---|---|
| Missing Content-Type | `POST /api/v1/web/session` | None / unset | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, structured envelope | `LOCAL_TEST_VERIFIED` |
| Text/plain | `POST /api/v1/web/session` | `Content-Type: text/plain` | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, correlation ID preserved | `LOCAL_TEST_VERIFIED` |
| Multipart form data | `POST /api/v1/web/session` | `Content-Type: multipart/form-data` | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, rejected pre-route | `LOCAL_TEST_VERIFIED` |
| Webhook text/plain | `POST /webhooks/elevenlabs` | `Content-Type: text/plain` | HTTP 400 UNSUPPORTED_MEDIA_TYPE | HTTP 400, rejected pre-route | `LOCAL_TEST_VERIFIED` |
| Valid JSON | `POST /api/v1/web/session` | `Content-Type: application/json` | Passes to handler (HTTP 201) | HTTP 201 Created | `LOCAL_TEST_VERIFIED` |
| Malformed JSON body | `POST /api/v1/web/session` | `Content-Type: application/json` | HTTP 400 MALFORMED_JSON | HTTP 400 MALFORMED_JSON | `LOCAL_TEST_VERIFIED` |
| Twilio Form Post | `POST /webhooks` | `application/x-www-form-urlencoded` | Passes media check (not 400) | Not rejected with 400 | `LOCAL_TEST_VERIFIED` |
| Twilio Signature Gate | `POST /webhooks/voice/inbound` | Missing signature | HTTP 401 UNAUTHORIZED | HTTP 401 UNAUTHORIZED | `LOCAL_TEST_VERIFIED` |
| GET Request | `GET /api/v1/web/projects` | No Content-Type | Passes normally (HTTP 200) | HTTP 200 OK | `LOCAL_TEST_VERIFIED` |
| Allowlisted Logout | `POST /api/v1/web/logout` | No body, no Content-Type | Passes normally (HTTP 204) | HTTP 204 No Content | `LOCAL_TEST_VERIFIED` |
| Sensitive Data Redaction | `POST /api/v1/web/session` | `password=secret` in text body | Credentials omitted from logs/response | Zero credentials leaked | `LOCAL_TEST_VERIFIED` |

### Vitest Test Execution Output:
```
 RUN  v4.1.12 /Users/HaMi/Documents/Jason/customer twin

 ✓ tests/middleware/content_type_validation.test.ts (11 tests) 31ms
   ✓ LOOP-1795035800169-NVLF: Content-Type Validation, Observability & Error Handling (11)
     ✓ rejects POST to JSON endpoint without Content-Type with HTTP 400 and structured envelope 14ms
     ✓ rejects POST to JSON endpoint with text/plain with HTTP 400 2ms
     ✓ rejects unsupported media type multipart/form-data on JSON endpoint with HTTP 400 1ms
     ✓ rejects POST to webhook JSON endpoint with text/plain with HTTP 400 2ms
     ✓ allows POST to JSON endpoint with application/json and valid body 2ms
     ✓ catches malformed JSON on application/json requests and returns HTTP 400 MALFORMED_JSON 3ms
     ✓ does NOT reject Twilio webhook POST with application/x-www-form-urlencoded 1ms
     ✓ rejects Twilio webhook when signature is missing (proves signature gate intact) 1ms
     ✓ does NOT reject GET requests to any endpoint without Content-Type 1ms
     ✓ allows empty-body POST to allowlisted logout route without Content-Type 1ms
     ✓ does not expose credentials or sensitive parameters in error responses or audit logs 1ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  638ms
```

---

## 5. Security & Commercial Impact

- **Fail-Closed Gate:** Malformed requests can no longer trigger unexpected default states or empty bodies in session management.
- **Tripwire Alerting:** All invalid media type attempts are registered in the security audit ledger and emit `level: WARN`, `tripwire: true` console logs.
- **Traceability:** Ingress correlation IDs (`X-Correlation-ID` or `X-Request-ID`) are guaranteed to be captured and reflected in all early rejections.
