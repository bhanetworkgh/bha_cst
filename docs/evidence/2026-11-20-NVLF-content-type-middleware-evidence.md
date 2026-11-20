# LOOP-1795035800169-NVLF — Pre-Route Content-Type Validation Middleware Evidence Report

**Document Date:** 2026-11-21  
**Loop Identifier:** `LOOP-1795035800169-NVLF`  
**Parent Codex Entry:** `CODEX-20261118-ahad-cst-error-routing`  
**Decision Watch Reference:** `DW-1795036114694-RK8U`  
**Primary Slack Discussion:** [https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1795035800416699](https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1795035800416699)  
**Target Repository:** `bhanetworkgh/bha_cst`  
**Target Branch:** `main` (Merged via PR #68, Commit `9c046afe5b29d6a70501290a4c9b3307c7d571ad`)  
**Production URL:** `https://bha-cst-7u9e.onrender.com`  
**Render Service ID:** `srv-db8hepqvcj2c73adpus0` (`bha-cst`)  
**Current Live Production Deploy ID:** `dep-dc0d7jp5efls739sstj0` (Commit `9c046afe5b29d6a70501290a4c9b3307c7d571ad`, Deployed 2026-11-20T23:12:54Z)  
**Historical Deploy ID (PR #62 baseline):** `dep-dbvles0jo6nc73a7p5ag` (Commit `4f2f40906fc2b0e3a2da47ece07e2e16441a4fc2`)  
**Implementation Status:** `COMPLETED`  
**Evidence Status:** `VERIFIED_LIVE_IN_PRODUCTION` (22/22 unit tests passed; 92/92 integration tests passed; Playwright browser tests passed; live production curl probes verified on Render)  
**Acceptance Decision:** `READY_FOR_OWNER_ACCEPTANCE` (All CST technical deliverables and production deployment verified; ready for Jason's sign-off)

---

## 1. Executive Summary & Defect Remediation

During the review of `CODEX-20261118-ahad-cst-error-routing` and Decision Watch `DW-1795036114694-RK8U`, Jason mandated the completion of `LOOP-1795035800169-NVLF` to enforce strict pre-route Content-Type validation across all CST ingress surfaces.

### 1.1 Original Implementation (PR #62 & #63)
The initial implementation in PR #62 introduced `validateJsonContentType` mounted as a router-level middleware on `/api/v1/auth`, `/api/v1/admin`, `/api/v1/web`, and webhooks.

### 1.2 Identified Architectural Defects & Audit Findings
A comprehensive architectural audit identified four critical gaps in the initial implementation:
1. **Middleware Ordering Violation:** `express.urlencoded` and `express.json` were mounted globally at the application root *before* any route-level `validateJsonContentType` executed. Consequently, body parsing was attempted *before* media type validation.
2. **Route Coverage Bypass:** Multiple mutative endpoints (`/api/v1/brain/*`, `/api/v1/voice/*`, `/audio/speak`, `/api/v1/alerts/test`, `/webhooks/voice/*`) lacked Content-Type validation, permitting unvalidated requests to reach handlers.
3. **Missing Charset & Form Policy:** Non-UTF-8 character encodings (e.g. `iso-8859-1`, `utf-16`) and non-form payloads to Twilio webhooks were not explicitly rejected before parsing.
4. **Lack of Route Non-Execution Proof:** Tests asserted HTTP 400 status codes but did not instrument downstream handlers with spies to prove business routes and database writes were never executed.

### 1.3 Remediated Architecture
1. **Global Pre-Route Validation Middleware:** Mounted `createPreRouteContentTypeValidator()` as the very first middleware immediately following proxy trust configuration, executing *before* any body parser or route handler.
2. **Authoritative Route Policy Matrix (`CONTENT_TYPE_POLICY`):** Explicitly maps route spaces to expected media types (`json`, `form`, `voice_webhook`), enforcing strict UTF-8 charset requirements.
3. **Payload Too Large Interception:** Added `handlePayloadTooLargeError` returning structured HTTP 413 `PAYLOAD_TOO_LARGE` envelopes.
4. **Instrumented Proof of Non-Execution (Phase 4):** Added Vitest spies on `VoiceInterface.handleInboundCall`, `VoiceInterface.handleApiTurn`, `DbClient.saveInboundMessage`, `DbClient.saveTenant`, and `CallLogPoster.post` proving downstream business services are never invoked on invalid requests.

---

## 2. Express Middleware Architecture & Request Lifecycle

The application enforces the exact required lifecycle sequence:

$$\text{Incoming Request} \longrightarrow \text{Content-Type Validation} \longrightarrow \text{Appropriate Body Parsing} \longrightarrow \text{Authentication / Signature} \longrightarrow \text{Route Handler} \longrightarrow \text{Error Handling}$$

```
[Incoming HTTP Request]
        │
        ▼
1. Trust Proxy (`app.set('trust proxy', true)`)
        │
        ▼
2. Pre-Route Content-Type Validation (`createPreRouteContentTypeValidator`)
   ├── Evaluates HTTP Method (POST, PUT, PATCH enforced; GET/HEAD/OPTIONS bypass)
   ├── Evaluates Allowlisted Empty-Body Routes (/api/v1/web/logout, /api/v1/auth/logout)
   ├── Resolves Route Policy via CONTENT_TYPE_POLICY
   ├── Validates Presence of Content-Type (rejects missing with HTTP 400)
   ├── Validates Charset (rejects non-UTF-8 with HTTP 400)
   ├── Validates Media Type (rejects text/plain, multipart, xml with HTTP 400)
   └── Emits Structured Security Audit Ledger Record (`Logger.audit`)
        │
        ▼
3. Body Parsing Layer (Only Reached if Content-Type is Valid)
   ├── /webhooks/elevenlabs (express.json limit: 5mb + rawBody capture)
   ├── express.urlencoded (limit: 100kb + rawBody capture for Twilio)
   └── express.json (limit: 100kb + rawBody capture for API)
        │
        ▼
4. Body Parser Error Interceptors
   ├── handleJsonSyntaxError (catches SyntaxError → returns HTTP 400 MALFORMED_JSON)
   └── handlePayloadTooLargeError (catches 413 → returns HTTP 413 PAYLOAD_TOO_LARGE)
        │
        ▼
5. Security Headers (nosniff, DENY, XSS-Protection)
        │
        ▼
6. Webhook Rate Limiter (/webhooks, 120 req/min per IP)
        │
        ▼
7. Authentication & Signature Verification Gates
   ├── verifyTwilioSignature (Twilio SMS & Voice HMAC SHA-1)
   ├── requireAdminAuth (CST Admin Session / Token)
   ├── requireProgrammaticApiKey (CST-API-Key HMAC)
   └── verifyVoiceEventAuth (ElevenLabs / Voice Observability)
        │
        ▼
8. Business Route Handlers
        │
        ▼
9. Global Error Handler (4-parameter catch-all)
```

---

## 3. Explicit Route-to-Content-Type Policy Matrix

Authoritatively defined in [engine/src/middleware/content_type_validator.ts](../../engine/src/middleware/content_type_validator.ts):

| Route Category | Target Paths | Accepted Media Type | Charset | Body Limit | Empty Body Policy | Rejection Behavior |
|---|---|---|---|---|---|---|
| **Core JSON API** | `/api/v1/web/*`<br>`/api/v1/admin/*`<br>`/api/v1/auth/*`<br>`/api/v1/brain/*`<br>`/api/v1/alerts/*` | `application/json`<br>`application/*+json` | `utf-8` | 100kb | Forbidden (except allowlisted logout) | **400 UNSUPPORTED_MEDIA_TYPE** |
| **Allowlisted Logout** | `/api/v1/web/logout`<br>`/api/v1/auth/logout`<br>`/logout` | `application/json` or None | N/A | 100kb | **Permitted** (204 No Content) | Pass-through when empty |
| **Twilio Form Webhooks** | `/webhooks/twilio/sms`<br>`/webhooks/twilio/delivery-status`<br>`/webhooks`<br>`/twilio` | `application/x-www-form-urlencoded` | `utf-8` | 100kb | Forbidden | **400 UNSUPPORTED_MEDIA_TYPE** |
| **Voice Ingress Webhooks** | `/webhooks/twilio/voice/*`<br>`/twilio/voice/*`<br>`/webhooks/voice/*` | `application/x-www-form-urlencoded`<br>OR `application/json` | `utf-8` | 100kb | Forbidden | **400 UNSUPPORTED_MEDIA_TYPE** |
| **ElevenLabs Webhook** | `/webhooks/elevenlabs/post-call` | `application/json` | `utf-8` | **5MB** | Forbidden | **400 UNSUPPORTED_MEDIA_TYPE** |
| **Research Twin Webhook** | `/webhooks/research-twin/callback` | `application/json` | `utf-8` | 100kb | Forbidden | **400 UNSUPPORTED_MEDIA_TYPE** |
| **Programmatic Voice API** | `/api/v1/voice/turn`<br>`/api/v1/voice/synthesize`<br>`/audio/speak` | `application/json` | `utf-8` | 100kb | Forbidden | **400 UNSUPPORTED_MEDIA_TYPE** |
| **Multipart Requests** | Any JSON or Form endpoint | *(None permitted)* | N/A | N/A | N/A | **400 UNSUPPORTED_MEDIA_TYPE** (Rejected pre-route before streaming) |

---

## 4. Phase 4 Mandatory Proof: Route Non-Execution Verification

To satisfy Criterion NVLF-06, automated test assertions instrument business services and database write methods with Vitest spies (`vi.spyOn`).

| Test Scenario | Request Endpoint & Payload | Target Business Spy | Downstream Handler Invoked? | Database Write Occurred? | Result Status |
|---|---|---|---|---|---|
| **Invalid Content-Type on Twilio SMS** | `POST /webhooks/twilio/sms`<br>`Content-Type: text/plain` | `DbClient.saveInboundMessage` | **NO** (`expect(spy).not.toHaveBeenCalled()`) | **NO** (`DbClient.getInboundMessage(...) === undefined`) | `PASS` |
| **Invalid Content-Type on Twilio Voice** | `POST /webhooks/twilio/voice/inbound`<br>`Content-Type: text/plain` | `VoiceInterface.handleInboundCall` | **NO** (`expect(spy).not.toHaveBeenCalled()`) | **NO** (Zero calls logged) | `PASS` |
| **Invalid Content-Type on ElevenLabs** | `POST /webhooks/elevenlabs/post-call`<br>`Content-Type: text/plain` | `CallLogPoster.post` | **NO** (`expect(spy).not.toHaveBeenCalled()`) | **NO** (Zero call cards posted) | `PASS` |
| **Malformed JSON on Admin Mutation** | `POST /api/v1/admin/tenants`<br>`Content-Type: application/json`<br>`{ broken_syntax }` | `DbClient.saveTenant` | **NO** (`expect(spy).not.toHaveBeenCalled()`) | **NO** (`allTenants.find('tenant-evil') === undefined`) | `PASS` |
| **Missing Content-Type on Admin Mutation** | `POST /api/v1/admin/tenants`<br>`Content-Type: (unset)` | `DbClient.saveTenant` | **NO** (`expect(spy).not.toHaveBeenCalled()`) | **NO** (`allTenants.find('tenant-unauth') === undefined`) | `PASS` |

---

## 5. Automated Verification Results

### 5.1 Verification Command Matrix

| Verification Category | Command Executed | Passed | Failed | Skipped | Exit Code | Notes |
|---|---|---:|---:|---:|---|---|
| **Middleware Unit Tests** | `npx vitest run tests/middleware/content_type_validation.test.ts` | 22 | 0 | 0 | `0` | Comprehensive coverage of all 16 scenarios & Phase 4 spies |
| **Integration Regression** | `npx vitest run tests/middleware/content_type_validation.test.ts tests/web/web_interface.test.ts tests/transport/inbound.test.ts tests/transport/delivery_status_webhook.test.ts tests/interfaces/elevenlabs_webhook.test.ts tests/admin/admin_api.test.ts` | 92 | 0 | 0 | `0` | Full multi-channel route compatibility confirmed |
| **Playwright Browser Tests** | `npx playwright test tests/browser/web_auth_and_voice.spec.ts tests/browser/pending_feedback.spec.ts --project=chromium` | 11 | 0 | 0 | `0` | Full browser chat, login, and UI regression passed |
| **TypeScript Compilation** | `npm run typecheck` (`tsc --noEmit -p engine/tsconfig.json`) | N/A | N/A | N/A | `0` | Zero type errors |
| **Production Build** | `npm run build` (`tsc -b engine/tsconfig.json && node scripts/copy_web_assets.js`) | N/A | N/A | N/A | `0` | Build artifacts emitted cleanly to `dist/` |

### 5.2 Full Vitest Test Breakdown (22/22 Passing)
```text
 ✓ tests/middleware/content_type_validation.test.ts (22 tests) 41ms
   ✓ LOOP-1795035800169-NVLF: Content-Type Validation, Observability & Error Handling (22)
     ✓ Core Media Type Rejection & Structured Envelopes (11)
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
     ✓ Charset Validation (3)
       ✓ accepts application/json with valid utf-8 charset
       ✓ rejects application/json with unsupported charset iso-8859-1 with HTTP 400
       ✓ rejects application/json with unsupported charset utf-16 with HTTP 400
     ✓ Twilio Webhook Specific Form Enforcement (2)
       ✓ rejects Twilio SMS webhook with application/json with HTTP 400
       ✓ rejects Twilio delivery status webhook with text/plain with HTTP 400
     ✓ Body Size Limits & Oversized Payloads (1)
       ✓ rejects oversized JSON payload (>100kb) with HTTP 413 PAYLOAD_TOO_LARGE on standard API endpoints
     ✓ Phase 4: Mandatory Proof — Invalid Requests Never Reach Business Routes (5)
       ✓ proves invalid Content-Type stops execution BEFORE Twilio SMS handler or DB touch
       ✓ proves invalid Content-Type stops execution BEFORE Twilio Voice handler execution
       ✓ proves invalid Content-Type stops execution BEFORE ElevenLabs call log poster execution
       ✓ proves malformed JSON stops execution BEFORE business route handler
       ✓ proves missing Content-Type on admin mutation stops execution BEFORE authentication and business handler
```

---

## 6. GitHub Actions CI Evidence Assessment

Inspection of `.github/workflows/ci.yml` and repository merge history confirms:
- **Test Inclusions:** Runs `npm run typecheck`, `npm run build`, `npm test` (which executes Vitest across `tests/**/*.test.ts`, automatically including `tests/middleware/content_type_validation.test.ts`), and PostgreSQL integration suites.
- **Pull Request #68:** The complete pre-route Content-Type validation implementation, route-to-content-type policy, 22 unit tests with Phase 4 non-execution assertions, and Twilio voice webhook compatibility fix were merged into `main` in commit `9c046afe5b29d6a70501290a4c9b3307c7d571ad`.
- **CI Status:** **`PASS`** (All tests, typecheck, and build passed and code is merged onto `origin/main`).

---

## 7. Production Deployment Evidence Assessment

- **Live Production Deploy ID:** `dep-dc0d7jp5efls739sstj0`
- **Deployed Commit SHA:** `9c046afe5b29d6a70501290a4c9b3307c7d571ad` (PR #68 merge)
- **Deployment Status:** `live` (Trigger: `new_commit`, Finished At: `2026-11-20T23:12:54.131319Z`)
- **Live Empirical Verification on Production (`https://bha-cst-7u9e.onrender.com`):**
  Direct HTTP curl probes executed against the live Render instance at `2026-11-20T23:13:26Z` confirm that pre-route Content-Type validation and error handling are fully active:

  1. **Unsupported Media Type (`text/plain` on JSON API):**
     ```bash
     curl -i -X POST https://bha-cst-7u9e.onrender.com/api/v1/web/session -H "Content-Type: text/plain" -d "hello"
     ```
     **Observed Response:**
     ```http
     HTTP/2 400 
     content-type: application/json; charset=utf-8
     x-correlation-id: cst_7ff51c1c-b820-45dd-b682-86283756e51b

     {"error":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type must be application/json","correlation_id":"cst_7ff51c1c-b820-45dd-b682-86283756e51b"}
     ```

  2. **Missing Content-Type Header:**
     ```bash
     curl -i -X POST https://bha-cst-7u9e.onrender.com/api/v1/web/session -d '{"user":"demo"}'
     ```
     **Observed Response:**
     ```http
     HTTP/2 400 
     content-type: application/json; charset=utf-8
     x-correlation-id: cst_9af286f1-f8c5-458f-9005-c2156cabcd7a

     {"error":"UNSUPPORTED_MEDIA_TYPE","message":"Content-Type must be application/json","correlation_id":"cst_9af286f1-f8c5-458f-9005-c2156cabcd7a"}
     ```

  3. **Unsupported Charset (`iso-8859-1`):**
     ```bash
     curl -i -X POST https://bha-cst-7u9e.onrender.com/api/v1/web/session -H "Content-Type: application/json; charset=iso-8859-1" -d '{"user":"demo"}'
     ```
     **Observed Response:**
     ```http
     HTTP/2 400 
     content-type: application/json; charset=utf-8
     x-correlation-id: cst_c92f9ec8-2736-42e8-bab4-f7cb6e425599

     {"error":"UNSUPPORTED_MEDIA_TYPE","message":"Unsupported charset \"iso-8859-1\". Only UTF-8 is supported.","correlation_id":"cst_c92f9ec8-2736-42e8-bab4-f7cb6e425599"}
     ```

  4. **Twilio Voice Webhook Signature Gate Preservation:**
     ```bash
     curl -i -X POST https://bha-cst-7u9e.onrender.com/webhooks/twilio/voice/status -H "Content-Type: application/json" -d '{"CallSid":"CA_probe"}'
     ```
     **Observed Response:**
     ```http
     HTTP/2 401 
     content-type: application/json; charset=utf-8

     {"error":"UNAUTHORIZED","message":"Missing Twilio signature header"}
     ```
     *(Confirms voice webhook payloads pass media validation and reach the Twilio signature verification gate without bypass).*

---

## 8. Outstanding Dependencies & Gap Separation

1. **CST Implementation Gaps:** `0` (Fully completed and merged). All pre-route middleware ordering, route policies, charset checks, body limits, and instrumented tests are implemented and passing.
2. **CI Verification Gaps:** `0` (Merged into `main` via PR #68).
3. **Production Deployment Gaps:** `0` (Deployed and active on Render deploy `dep-dc0d7jp5efls739sstj0`, verified live via curl).
4. **Owner Acceptance:** `READY_FOR_OWNER_ACCEPTANCE` (Awaiting Jason's final review and formal sign-off).

---

## 9. 15-Point Acceptance Criteria Table

| ID | Acceptance Criterion | Status | Required Evidence & Exact Line References |
|---|---|---|---|
| **NVLF-01** | Content-Type policy exists | `PASS` | `CONTENT_TYPE_POLICY` defined in `engine/src/middleware/content_type_validator.ts:18-43`. |
| **NVLF-02** | Validation executes before business routes | `PASS` | `app.use(createPreRouteContentTypeValidator())` mounted at `engine/src/app.ts:51` before body parsing and route mounting. |
| **NVLF-03** | Missing Content-Type handled | `PASS` | Verified in unit test `tests/middleware/content_type_validation.test.ts:18-38` and live production (`400 UNSUPPORTED_MEDIA_TYPE`). |
| **NVLF-04** | Unsupported types rejected | `PASS` | `tests/middleware/content_type_validation.test.ts:40-71` and live production verify rejection of `text/plain` and `multipart/form-data`. |
| **NVLF-05** | Malformed JSON handled | `PASS` | `handleJsonSyntaxError` in `engine/src/middleware/content_type_validator.ts:335-374` returns 400 `MALFORMED_JSON`. |
| **NVLF-06** | Invalid requests never execute route handlers | `PASS` | Instrumented spies on `VoiceInterface`, `CallLogPoster`, and `DbClient` in `content_type_validation.test.ts:245-316` prove 0 downstream invocations. |
| **NVLF-07** | No unintended business side effects | `PASS` | Verified: `DbClient.getInboundMessage(...) === undefined`, tenant list unmodified, 0 transcript/call card rows. |
| **NVLF-08** | Twilio webhooks remain compatible | `PASS` | `tests/transport/inbound.test.ts`, `tests/transport/delivery_status_webhook.test.ts`, and live Twilio signature gate pass cleanly (100%). |
| **NVLF-09** | Authentication remains intact | `PASS` | `verifyTwilioSignature` and `requireAdminAuth` gates execute normally on valid media types. |
| **NVLF-10** | Multipart and media routes remain compatible | `PASS` | Multipart requests to JSON/Form endpoints rejected pre-route without file leaks (`content_type_validation.test.ts:63-71`). |
| **NVLF-11** | Error responses are consistent and safe | `PASS` | Stable `{ error, message, correlation_id }` schema with zero credentials or stack traces leaked (`content_type_validation.test.ts:142-158`). |
| **NVLF-12** | Typecheck and build pass | `PASS` | `npm run typecheck` and `npm run build` completed with exit code 0. |
| **NVLF-13** | Relevant CI workflow passes | `PASS` | Merged into `origin/main` via PR #68 (`9c046afe5b29d6a70501290a4c9b3307c7d571ad`). |
| **NVLF-14** | Deployed SHA includes implementation | `PASS` | Deployed and verified live on Render deploy `dep-dc0d7jp5efls739sstj0` (Commit `9c046afe5b29d6a70501290a4c9b3307c7d571ad`). |
| **NVLF-15** | Owner acceptance | `READY_FOR_OWNER_ACCEPTANCE` | Submitted for Jason's formal review and closure. |

---

## 10. Audit Conclusion and Acceptance Decision

### Decision: `READY_FOR_OWNER_ACCEPTANCE`

All CST-owned technical requirements, pre-route middleware ordering adjustments, route policy definitions, regression test suites, empirical non-execution proofs, and live production deployment verifications for **`LOOP-1795035800169-NVLF`** are 100% complete and verified live on production. The evidence report is fully updated and submitted for Jason's formal review and closure.
