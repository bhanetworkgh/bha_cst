# BHA Customer Service Twin (`bha-cst`) — API Endpoints Reference

This document provides a comprehensive technical reference for all HTTP endpoints exposed by the **BHA Customer Service Twin (`bha-cst`)** engine.

Both the **Deployed Production URL** on Render and the **Local Development URL** are provided for all endpoints and curl examples.

---

## 🌐 Base Environments

| Environment | Base URL | Description |
|---|---|---|
| **Production (Render)** | `https://bha-cst.onrender.com` | Live deployed multi-tenant instance |
| **Local Development** | `http://localhost:3000` | Local development server (`npm run dev`) |

---

## 📑 Endpoints Summary

| Method | Endpoint | Access / Auth | Description |
|---|---|---|---|
| `GET` | `/` | Public | Redirects (`302`) directly to `/api-docs` |
| `GET` | `/api-docs` | Public | Interactive Swagger UI API documentation |
| `GET` | `/api-docs.json` | Public | OpenAPI 3.0.3 specification in raw JSON |
| `POST` | `/webhooks/twilio/sms` | `X-Twilio-Signature` | Inbound Twilio SMS/MMS webhook (8-step pipeline) |
| `POST` | `/webhooks/twilio/delivery-status` | `X-Twilio-Signature` | Twilio delivery receipt status callback |
| `GET` | `/health` | Public | Liveness probe for Render / AWS ALB |
| `GET` | `/debug/state` | Dev/Test Only | In-memory DB state snapshot (404 in Production) |

---

## 1. Root Redirect (`GET /`)

Redirects root visitors directly to the interactive Swagger UI documentation.

* **Production URL**: [`https://bha-cst.onrender.com/`](https://bha-cst.onrender.com/)
* **Local URL**: [`http://localhost:3000/`](http://localhost:3000/)
* **Status Code**: `302 Found`
* **Response Header**: `Location: /api-docs`

```bash
# Production
curl -i https://bha-cst.onrender.com/

# Local
curl -i http://localhost:3000/
```

---

## 2. Interactive Swagger UI (`GET /api-docs`)

Provides a web-based, interactive Swagger UI interface to inspect all schemas, models, headers, and endpoints.

* **Production URL**: [`https://bha-cst.onrender.com/api-docs`](https://bha-cst.onrender.com/api-docs)
* **Local URL**: [`http://localhost:3000/api-docs`](http://localhost:3000/api-docs)
* **Status Code**: `200 OK`
* **Content-Type**: `text/html; charset=utf-8`

---

## 3. OpenAPI 3.0 Specification JSON (`GET /api-docs.json`)

Returns the raw OpenAPI 3.0.3 specification JSON object for automated tooling, Postman import, or contract testing.

* **Production URL**: [`https://bha-cst.onrender.com/api-docs.json`](https://bha-cst.onrender.com/api-docs.json)
* **Local URL**: [`http://localhost:3000/api-docs.json`](http://localhost:3000/api-docs.json)
* **Status Code**: `200 OK`
* **Content-Type**: `application/json; charset=utf-8`

```bash
# Production
curl https://bha-cst.onrender.com/api-docs.json

# Local
curl http://localhost:3000/api-docs.json
```

---

## 4. Inbound Twilio SMS Webhook (`POST /webhooks/twilio/sms`)

Receives inbound SMS and MMS messages from Twilio, verifies digital HMAC signatures, resolves tenancy and sender role server-side, routes intent, and queries the BHARAG cluster knowledge base.

* **Production URL**: `https://bha-cst.onrender.com/webhooks/twilio/sms`
* **Local URL**: `http://localhost:3000/webhooks/twilio/sms`
* **Content-Type**: `application/x-www-form-urlencoded`
* **Rate Limit**: 120 requests / minute per client IP

### Security & Authentication
* **Header**: `X-Twilio-Signature` (HMAC-SHA1 computed over full URL and parameters using Twilio Auth Token).
* **Bypass (Dev/Test Only)**: `-H "x-test-bypass-signature: true"` bypasses signature verification in development environments.

### Request Body Parameters (Form URL-Encoded)

| Parameter | Type | Required | Description | Example |
|---|---|---|---|---|
| `MessageSid` | String | **Yes** | Unique Twilio identifier for deduplication | `SM1234567890abcdef1234567890abcdef` |
| `AccountSid` | String | **Yes** | Twilio Account SID owning the number | `ACd2e42fdd546d411bc100642e84b00353` |
| `From` | String (E.164) | **Yes** | Sender phone number | `+923082113844` |
| `To` | String (E.164) | **Yes** | Registered receiving system number | `+19715885823` |
| `Body` | String | **Yes** | Message text to classify and answer | `What is the recommended pH for vFarm?` |
| `NumMedia` | String | No | Count of media attachments (MMS) | `0` |
| `MediaUrl0` | String (URL) | No | Attachment URL (if NumMedia > 0) | `https://api.twilio.com/...` |

### Internal 8-Step Processing Pipeline
1. **Signature Verification**: Validates `X-Twilio-Signature`. Rejects invalid callers with `403 FORBIDDEN`.
2. **Tenancy Resolution**: Server-side lookup maps receiving `To` number (`+19715885823`) to system `system-vfarm-01` and tenant `tenant-vfarm-01`. Unknown receiving numbers are rejected with `404 SYSTEM_NOT_FOUND` before any DB touch.
3. **Tenancy Gate**: Enforces server-side tenant boundary (fail-closed).
4. **Normalization & Deduplication**: Checks `MessageSid` in DB. Duplicate requests immediately return `204` without re-processing.
5. **Fast 204 Return**: Returns `HTTP 204 No Content` to Twilio within <500 ms to satisfy Twilio webhook timeout limits.
6. **Async Identity Resolution**: Looks up sender E.164 (`From`) in the PostgreSQL `customers` table.
   * **Known Customer (e.g. `+923082113844`)**: Resolves role (`owner`), permissions, `unit_id`, and `farm_id`.
   * **Unknown Customer**: Returns `is_known_customer: false`, serves safe generic `VFARM_ONBOARDING_REPLY`.
7. **Role & Step-Up Security Check**: Blocks forbidden operations by role (e.g. `tech` executing control commands) and enforces Step-Up Authentication for sensitive write actions.
8. **Connector Dispatch & Delivery**:
   * Knowledge queries dispatched to unified **BHARAG Cluster Ask** (`https://bharag2.duckdns.org/api/v1/cluster/ask`).
   * Outbound message enqueued into `messages_out` table; worker loop delivers outbound SMS via Twilio.

### Responses

| Status Code | Code | Reason | Body |
|---|---|---|---|
| `204 No Content` | - | Message accepted for asynchronous processing | Empty |
| `400 Bad Request` | `BAD_REQUEST` | Missing `To`, `From`, or `MessageSid` | `{"error": "BAD_REQUEST", "message": "..."}` |
| `403 Forbidden` | `FORBIDDEN` / `TENANT_SCOPE_VIOLATION` | Invalid signature or tenant override attempt | `{"error": "FORBIDDEN", "message": "Invalid Twilio signature"}` |
| `404 Not Found` | `SYSTEM_NOT_FOUND` | Receiving number (`To`) not registered in system | `{"error": "SYSTEM_NOT_FOUND", "message": "Unknown receiving number"}` |
| `429 Too Many Requests` | `TOO_MANY_REQUESTS` | Exceeded 120 req/min rate limit | `{"error": "TOO_MANY_REQUESTS", "message": "Rate limit exceeded"}` |
| `500 Internal Error` | `INTERNAL_SERVER_ERROR` | Unhandled error | `{"error": "INTERNAL_SERVER_ERROR"}` |

### Example cURL Commands

#### A. Registered Customer (`+923082113844` - Owner) Query
```bash
# Production (Render)
curl -i -X POST https://bha-cst.onrender.com/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_PROD_TEST_001" \
  -d "AccountSid=ACd2e42fdd546d411bc100642e84b00353" \
  -d "From=%2B923082113844" \
  -d "To=%2B19715885823" \
  -d "Body=What+is+the+recommended+pH+and+temperature+for+vFarm%3F"

# Local
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_LOCAL_TEST_001" \
  -d "AccountSid=ACd2e42fdd546d411bc100642e84b00353" \
  -d "From=%2B923082113844" \
  -d "To=%2B19715885823" \
  -d "Body=What+is+the+recommended+pH+and+temperature+for+vFarm%3F"
```

#### B. Unknown Customer (Safe Onboarding Path)
```bash
# Production (Render)
curl -i -X POST https://bha-cst.onrender.com/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_UNKNOWN_001" \
  -d "AccountSid=ACd2e42fdd546d411bc100642e84b00353" \
  -d "From=%2B15550009999" \
  -d "To=%2B19715885823" \
  -d "Body=Hello+can+you+help+me"

# Local
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_UNKNOWN_001" \
  -d "AccountSid=ACd2e42fdd546d411bc100642e84b00353" \
  -d "From=%2B15550009999" \
  -d "To=%2B19715885823" \
  -d "Body=Hello+can+you+help+me"
```

#### C. Unregistered Receiving Number (Refused with 404)
```bash
# Production (Render)
curl -i -X POST https://bha-cst.onrender.com/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_INVALID_NUMBER" \
  -d "From=%2B923082113844" \
  -d "To=%2B19998887777" \
  -d "Body=Testing+unknown+system"
```

---

## 5. Twilio Delivery Status Callback (`POST /webhooks/twilio/delivery-status`)

Twilio calls this webhook when an outbound SMS message transitions state (`sent`, `delivered`, `failed`, `undelivered`).

* **Production URL**: `https://bha-cst.onrender.com/webhooks/twilio/delivery-status`
* **Local URL**: `http://localhost:3000/webhooks/twilio/delivery-status`
* **Content-Type**: `application/x-www-form-urlencoded`
* **Authentication**: `X-Twilio-Signature` (or `x-test-bypass-signature: true` in dev/test)

### Request Parameters

| Parameter | Type | Required | Description | Example |
|---|---|---|---|---|
| `MessageSid` | String | **Yes** | Twilio Message SID of the outbound message | `SM1234567890abcdef1234567890abcdef` |
| `MessageStatus` | String | **Yes** | `sent`, `delivered`, `failed`, `undelivered` | `delivered` |
| `To` | String (E.164) | No | Destination phone number | `+923082113844` |
| `From` | String (E.164) | No | System sending number | `+19715885823` |
| `ErrorCode` | String | No | Twilio error code if failed or undelivered | `30003` |

### Status Code Mapping

| Twilio `MessageStatus` | CST Internal Status | Notes |
|---|---|---|
| `sent` | `sent` | Outbound carrier handed off message |
| `delivered` | `delivered` | Handset confirmed delivery |
| `failed` | `failed` | Send failure recorded in audit log |
| `undelivered` | `undelivered` | Carrier undelivered; recorded with ErrorCode |

### Example cURL Commands

```bash
# Production (Render)
curl -i -X POST https://bha-cst.onrender.com/webhooks/twilio/delivery-status \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM1234567890abcdef1234567890abcdef" \
  -d "MessageStatus=delivered" \
  -d "To=%2B923082113844" \
  -d "From=%2B19715885823"

# Local
curl -i -X POST http://localhost:3000/webhooks/twilio/delivery-status \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM1234567890abcdef1234567890abcdef" \
  -d "MessageStatus=delivered" \
  -d "To=%2B923082113844" \
  -d "From=%2B19715885823"
```

---

## 6. Liveness Health Check (`GET /health`)

Lightweight health probe queried by Render and AWS Application Load Balancers to determine whether the service is alive and ready to receive HTTP traffic.

* **Production URL**: [`https://bha-cst.onrender.com/health`](https://bha-cst.onrender.com/health)
* **Local URL**: [`http://localhost:3000/health`](http://localhost:3000/health)
* **Status Code**: `200 OK`
* **Content-Type**: `application/json`

### Response Payload
```json
{
  "status": "ok",
  "service": "bha-cst-engine"
}
```

```bash
# Production
curl -i https://bha-cst.onrender.com/health

# Local
curl -i http://localhost:3000/health
```

---

## 7. In-Memory Debug State (`GET /debug/state`)

Exposes a snapshot of active conversations, transcripts, inbound message deduplication cache, and outbound delivery queue.

> 🔒 **Security Guard**: When `NODE_ENV=production`, this endpoint automatically returns `404 NOT_FOUND` to ensure zero internal state or customer phone numbers are exposed in production.

* **Production URL**: `https://bha-cst.onrender.com/debug/state` → Returns `404 Not Found`
* **Local URL**: [`http://localhost:3000/debug/state`](http://localhost:3000/debug/state) → Returns `200 OK` with full state
* **Content-Type**: `application/json`

### Response Payload (Development / Test Only)
```json
{
  "conversations": [
    {
      "conversation_id": "conv_a35d862f-a4db-4e09-baf7-548a17822c7d",
      "tenant_id": "tenant-vfarm-01",
      "organization_id": "tenant-vfarm-01",
      "workspace_id": "ws-vfarm-main",
      "system_id": "system-vfarm-01",
      "customer_ref": "cust_vfarm_003_test_user",
      "channel": "sms",
      "state": "open",
      "incident_ids": []
    }
  ],
  "transcripts": [],
  "messages_in": [],
  "messages_out": []
}
```

```bash
# Local Development Only
curl http://localhost:3000/debug/state
```

---

## 🔒 Security Headers Applied Globally

Every response from the engine includes strict defensive HTTP security headers:
```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
```
*(The `X-Powered-By: Express` header is removed to avoid server fingerprinting).*
