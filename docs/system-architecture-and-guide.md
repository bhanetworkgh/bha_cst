# Customer Service Twin (`bha-cst`) — System Architecture & Implementation Guide

This document details the system architecture, design decisions, multi-tenant isolation rules, implementation roadmap, and execution guide for the `bha-cst` (Customer Service Twin) project.

---

## 1. System Overview & Core Stack

`bha-cst` is a multi-tenant conversation engine designed to serve as the unified customer communication gateway for BHA systems. 

- **Repository**: `bha-cst` (separate codebase, not part of `bhavfarm`)
- **Technology Stack**: TypeScript, Express, PostgreSQL
- **Multi-Tenancy Model**: Multi-tenant from day one where the tenancy unit is a **SYSTEM**. vFarm is registered as **System #1** (`system-vfarm-01`). Future twins register as additional systems without creating separate codebases.

---

## 2. System Boundaries & Ownership

`bha-cst` owns exactly the **CONVERSATION** boundary. Subsystems that exist elsewhere in the BHA architecture are strictly reused and **NEVER duplicated** inside CST.

```
+-----------------------------------------------------------------------+
|                       bha-cst (CUSTOMER SERVICE TWIN)                 |
|  - Transcripts & Conversations    - Inbound & Outbound Transport Queues|
|  - Systems Registry               - Webhook Normalization & Dedup     |
|  - IntentRouter & Connectors      - BHARAG RAG Knowledge + Media     |
+-----------------------------------------------------------------------+
         |                     |                    |
         v                     v                    v
+---------------+     +---------------+    +-------------------+
|  vFarm Server |     | BHARAG Engine |    |   Media Server    |
| - Identity    |     | - Knowledge   |    | - Signed URL S3   |
| - Farm Truth  |     |   (Cluster)   |    |   Media Captures  |
+---------------+     +---------------+    +-------------------+
```

### Data Boundaries
| Data Domain | Owner / Source of Truth | Integration Rule |
|-------------|-------------------------|------------------|
| **Conversations & Transcripts** | `bha-cst` | Only place full SMS transcripts live. |
| **Identity & Mapping** | vFarm Customer Registry | Phone numbers are resolved via `GET /api/v1/customers/resolve`. CST never creates a customer identity DB. |
| **Knowledge Base** | BHARAG Cluster (`https://bharag2.duckdns.org/api/v1/cluster/ask`) | Unified endpoint serving BHARAG, vFarm, and Media knowledge. CST calls it with `x-api-key` header. Returns text answers + citations. |
| **Media & Images** | Media Server | CST passes short-lived signed URLs, never stores raw media binaries. |

---

## 3. GAP-AUTH-01 Multi-Tenant Isolation Security Model

Tenant isolation in `bha-cst` follows `SPEC-VFARM-001` and `tenant-isolation-guide.md`. Scope is resolved server-side from trusted context and **fails closed**.

```
Twilio HTTP POST Request
       │
       ▼
1. Signature Verification (X-Twilio-Signature) ──[Invalid]──► 403 Forbidden (No DB touch)
       │ [Valid]
       ▼
2. Receiving Number Lookup (To E.164 -> System) ──[Unknown]──► 404 System Not Found (Refusal logged)
       │ [System Resolved]
       ▼
3. Shared Tenancy Gate (Server-side Context) ──[Mismatch]──► 403 Tenant Scope Violation
       │ [Gate Passed]
       ▼
4. Deduplication (MessageSid) & Ingress Queue
```

### Core Tenancy Rules
1. **Receiving Phone Number Is Tenancy Decision**: For inbound SMS, the receiving `To` E.164 number uniquely identifies the tenant/system. Scope is NEVER derived from SMS text, sender claims, client body parameters, or LLM output.
2. **Pre-Database Signature Check**: `verifyTwilioSignature` executes BEFORE any database lookup. Invalid signatures are rejected with HTTP 403/401 and logged as security tripwires.
3. **Fail Closed**: Any unknown receiving number returns `404 SYSTEM_NOT_FOUND`, creates 0 database rows, and sends no reply.
4. **Unknown Sender Path**: If the receiving number is valid but sender phone is unmapped, CST sends the system's onboarding response and assigns an opaque reference (`opaque_unresolved_<phone>`). Identity is NEVER guessed.
5. **Outbound Cross-Tenant Prevention**: Before calling Twilio Messages API, the worker checks `validateOutboundTenancyScope`. If Tenant A attempts to message a number registered to Tenant B, the send is refused and logged.

---

## 4. End-to-End Per-Message Execution Flow

```
Customer SMS ──► Twilio Rail ──► POST /webhooks/twilio/sms
                                          │
    ┌─────────────────────────────────────┴─────────────────────────────────────┐
    │ 1. verifyTwilioSignature (Middleware)                                      │
    │ 2. SystemsRegistry.resolveSystemByPhoneNumber(To) (Middleware)            │
    │ 3. enforceTenancyGate (Middleware)                                        │
    │ 4. DbClient.saveInboundMessage(MessageSid) -> Return 204 Fast to Twilio   │
    └─────────────────────────────────────┬─────────────────────────────────────┘
                                          │ (setImmediate Async Pipeline)
                                          ▼
                         IdentityResolver.resolveSenderIdentity()
                                          │
                                          ▼
                              handle(InboundMessage, IdentityContext)
                                           │ (Generates Reply via Connectors:
                                           │   • BHARAG RAG Knowledge Connector (all intents)
                                           │   • Media Server Connector (images only -> media_url)
                                           │)
                                           ▼
                                DbClient.saveOutboundMessage()
                                           │
                                           ▼
                               processOutboundQueue()
                                           │
                                           ▼
                         TwilioClientWrapper.sendSms() ──► Customer SMS Reply
```

### 4.1 Intent Detection & Connector Routing

`IntentRouter.detectIntent(body)` performs keyword-based classification (still active for audit trail) and produces one of: `status`, `knowledge`, `images`, `escalate`, `default`. The actual reply generation now flows through **two connectors**:

1. **BHARAG RAG Knowledge Connector** (`engine/src/connectors/bharag_rag.ts`) — the **primary source for ALL text responses**, regardless of detected intent. It calls the unified BHARAG Cluster endpoint:

   ```http
   POST https://bharag2.duckdns.org/api/v1/cluster/ask
   Headers:
     accept: application/json
     x-api-key: <BHARAG_CLUSTER_KEY>
     Content-Type: application/json
   Body:
     { "query": "<customer message body>" }
   ```

   The cluster endpoint returns `answer`, `confidence`, `has_context`, and `citations` spanning BHARAG, vFarm, and Media knowledge bases. CST appends citations context to its audit log and uses the `answer` field as the outbound SMS body. If `confidence < 0.3` or `has_context === false`, CST returns a polite "no information found" message.

2. **Media Server Connector** (`engine/src/connectors/media.ts`) — invoked **only when intent === 'images'**. It requests a short-lived signed S3 URL from `https://media.bhavfarm.com/api/v1/captures/latest?unit_id=<unitId>` and attaches it as `media_url` to the outbound message, which Twilio delivers as MMS.

Both connectors are wired in `engine/src/router/index.ts` (the `routeAndHandle` method). The async pipeline is:

```
inbound → IntentRouter.detectIntent() → BharagRagConnector.askKnowledge() (text)
                                       ↓
                          if intent === 'images' → MediaServerConnector.getSignedMediaUrl() (media_url)
                                       ↓
                          DbClient.saveOutboundMessage(body, media_url) → outbound queue → Twilio
```

---

## 4.2 Connector Wiring — Current State

Only two external adapters are active (others — vFarm Telemetry Connector and BHARAG Incidents Connector — have been removed). All text knowledge comes from the BHARAG cluster endpoint; media comes from the Media Server.

### BHARAG RAG Knowledge Connector

| Property | Value |
|---|---|
| **File** | `engine/src/connectors/bharag_rag.ts` |
| **Class** | `BharagRagConnector` |
| **Method** | `askKnowledge(question: string, workspaceKey?: string): Promise<string>` |
| **Endpoint** | `POST https://bharag2.duckdns.org/api/v1/cluster/ask` |
| **Auth** | `x-api-key: <BHARAG_CLUSTER_KEY>` |
| **Timeout** | 5s |
| **Request body** | `{ "query": "<customer message>" }` |
| **Response** | `{ "answer": "...", "confidence": 0.0-1.0, "has_context": true/false, "citations": [...] }` |
| **Env vars** | `BHARAG_CLUSTER_URL` (default: `https://bharag2.duckdns.org/api/v1/cluster/ask`), `BHARAG_CLUSTER_KEY` |

### Media Server Connector

| Property | Value |
|---|---|
| **File** | `engine/src/connectors/media.ts` |
| **Class** | `MediaServerConnector` |
| **Method** | `getSignedMediaUrl(unitId?: string): Promise<string>` |
| **Endpoint** | `GET https://media.bhavfarm.com/api/v1/captures/latest?unit_id=<unitId>` |
| **Timeout** | 1.5s |
| **Response** | Signed S3 URL string (e.g. `https://s3...amazonaws.com/...`) |
| **Fallback** | `https://vfarm-media-captures.s3.us-east-1.amazonaws.com/units/{unitId}/latest_snap.jpg` |
| **Env vars** | `MEDIA_SERVER_URL` |

### Connector Usage in IntentRouter

| Intent | Text source | Media source |
|---|---|---|
| `status` | BHARAG RAG | — |
| `knowledge` | BHARAG RAG | — |
| `images` | BHARAG RAG | Media Server (`media_url` on outbound) |
| `escalate` | BHARAG RAG | — |
| `default` | BHARAG RAG | — |

---

## 5. Database Schema

### Migration 001 — Initial Schema (`db/migrations/001_initial_schema.sql`)

All tables carrying tenant data enforce `tenant_id VARCHAR(64) NOT NULL`.

```sql
-- Systems Registry Table
CREATE TABLE systems (
  system_id            VARCHAR(64) PRIMARY KEY,
  tenant_id            VARCHAR(64) NOT NULL UNIQUE,
  name                 VARCHAR(255) NOT NULL,
  status               VARCHAR(32) NOT NULL DEFAULT 'active',
  phone_numbers        JSONB NOT NULL DEFAULT '[]'::jsonb,
  onboarding_reply     TEXT NOT NULL,
  resolve_endpoint_url TEXT,
  bharag_workspace_key TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Conversations Table
CREATE TABLE conversations (
  conversation_id VARCHAR(64) PRIMARY KEY,
  tenant_id       VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  system_id       VARCHAR(64) NOT NULL REFERENCES systems(system_id),
  customer_ref    VARCHAR(255) NOT NULL,
  channel         VARCHAR(32) NOT NULL DEFAULT 'sms',
  state           VARCHAR(32) NOT NULL DEFAULT 'open',
  incident_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Only incident_id refs; data lives in BHARAG
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Messages Table (Transcripts — only place full SMS text lives)
CREATE TABLE messages (
  message_id       VARCHAR(64) PRIMARY KEY,
  conversation_id  VARCHAR(64) NOT NULL REFERENCES conversations(conversation_id),
  tenant_id        VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  direction        VARCHAR(16) NOT NULL,   -- 'inbound' | 'outbound'
  from_e164        VARCHAR(32) NOT NULL,
  to_e164          VARCHAR(32) NOT NULL,
  body             TEXT NOT NULL,
  media_refs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider_sid     VARCHAR(128),
  delivery_status  VARCHAR(32) NOT NULL DEFAULT 'received'
);

-- Messages In Queue (Deduplication Ledger — keyed by Twilio MessageSid)
CREATE TABLE messages_in (
  message_id     VARCHAR(128) PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  from_e164      VARCHAR(32) NOT NULL,
  to_e164        VARCHAR(32) NOT NULL,
  body           TEXT NOT NULL,
  media          JSONB NOT NULL DEFAULT '[]'::jsonb,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status         VARCHAR(32) NOT NULL DEFAULT 'enqueued',
  correlation_id VARCHAR(128) NOT NULL
);

-- Messages Out Queue (Outbound Worker Queue)
CREATE TABLE messages_out (
  id             VARCHAR(64) PRIMARY KEY,
  tenant_id      VARCHAR(64) NOT NULL REFERENCES systems(tenant_id),
  from_e164      VARCHAR(32),              -- Twilio number that sent the message (GAP-5)
  to_e164        VARCHAR(32) NOT NULL,
  body           TEXT NOT NULL,
  media_url      TEXT,
  correlation_id VARCHAR(128) NOT NULL,
  status         VARCHAR(32) NOT NULL DEFAULT 'pending', -- pending | sent | failed | refused
  retry_count    INT NOT NULL DEFAULT 0,
  error_message  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at        TIMESTAMPTZ
);
```

### Migration 002 — Missing System Config Columns (`db/migrations/002_add_missing_system_config_cols.sql`)

Adds the 4 per-system config columns required by spec §2 that were missing from 001, plus `from_e164` on `messages_out`:

```sql
ALTER TABLE systems ADD COLUMN IF NOT EXISTS messaging_service_sid TEXT;
ALTER TABLE systems ADD COLUMN IF NOT EXISTS media_base_url TEXT;
ALTER TABLE systems ADD COLUMN IF NOT EXISTS escalation_rules JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE systems ADD COLUMN IF NOT EXISTS routing_rules JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE messages_out ADD COLUMN IF NOT EXISTS from_e164 VARCHAR(32);
```

### `SystemConfig` TypeScript Type (seeded at boot in `systems/registry.ts`)

All registered systems must conform to this shape:

```ts
interface SystemConfig {
  system_id:              string;            // e.g. 'system-vfarm-01'
  tenant_id:              string;            // e.g. 'tenant-vfarm-01'
  name:                   string;
  status:                 'active' | 'suspended';
  phone_numbers:          string[];          // E.164 Twilio numbers for this system
  messaging_service_sid?: string;            // Twilio Messaging Service SID ref (spec §2)
  onboarding_reply:       string;            // SMS sent to unknown senders
  resolve_endpoint_url?:  string;            // vFarm GET /api/v1/customers/resolve
  bharag_workspace_key?:  string;            // CST workspace key for BHARAG ask + incidents.v0
  media_base_url?:        string;            // Media server base URL for signed URLs
  escalation_rules?:      EscalationRule[];  // When/how to file incidents in BHARAG incidents.v0
  routing_rules?:         RoutingRule[];     // Per-intent: auto-answer, escalate, quiet hours
}

interface EscalationRule {
  trigger:    string;                              // e.g. 'escalate' | 'fault'
  subsystem:  'CUSTOMER_TWIN';                     // Always CUSTOMER_TWIN per spec §3
  engine:     string;                              // e.g. 'VFARM'
  priority?:  'low' | 'medium' | 'high' | 'critical';
}

interface RoutingRule {
  intent:        string;                           // e.g. 'status' | 'knowledge' | 'escalate'
  action:        'auto_reply' | 'escalate' | 'knowledge' | 'images' | 'queue';
  canned_reply?: string;                           // For action: 'auto_reply'
  quiet_hours?:  { start: string; end: string; timezone: string };
}
```

---

## 6. API Endpoints & Request/Response Schemas

### 1. Inbound Twilio SMS Webhook
- **Endpoint**: `POST /webhooks/twilio/sms`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Headers**:
  - `X-Twilio-Signature`: `string` (Required HMAC signature hash)
- **Request Body Parameters (`application/x-www-form-urlencoded`)**:
  ```http
  POST /webhooks/twilio/sms HTTP/1.1
  Host: localhost:3000
  Content-Type: application/x-www-form-urlencoded
  X-Twilio-Signature: 2/Y8k9z...

  MessageSid=SM100200300400500600700800900a&From=%2B15551234567&To=%2B15550001111&Body=Need+help+with+Bay+4&NumMedia=0
  ```
  | Field | Type | Description |
  |---|---|---|
  | `MessageSid` | `string` | Twilio unique message ID used for deduplication. |
  | `From` | `string` (E.164) | Sender customer phone number (e.g. `+15551234567`). |
  | `To` | `string` (E.164) | Receiving system phone number (e.g. `+19715885823`) — **Sole Inbound Tenancy Decision**. |
  | `Body` | `string` | Text content of inbound SMS message. |
  | `NumMedia` | `string` | Count of attached media files (e.g. `"0"`, `"1"`). |
  | `MediaUrl0`, `MediaUrl1`... | `string` (URL) | (Optional) Signed URLs for attached MMS images. |

- **Response Schemas**:
  - **`204 No Content`** (Success - Fast return to Twilio):
    ```http
    HTTP/1.1 204 No Content
    ```
  - **`401 Unauthorized`** (Missing signature header):
    ```json
    {
      "error": "UNAUTHORIZED",
      "message": "Missing Twilio signature header"
    }
    ```
  - **`403 Forbidden`** (Invalid signature hash OR Tenant Scope Violation):
    ```json
    {
      "error": "FORBIDDEN",
      "message": "Invalid Twilio signature"
    }
    ```
  - **`404 Not Found`** (Unknown receiving `To` number not in Systems Registry):
    ```json
    {
      "error": "SYSTEM_NOT_FOUND",
      "message": "Unknown receiving number"
    }
    ```
  - **`400 Bad Request`** (Missing `To` number):
    ```json
    {
      "error": "BAD_REQUEST",
      "message": "Missing receiving To number"
    }
    ```

---

### 2. Twilio Delivery Status Callback
- **Endpoint**: `POST /webhooks/twilio/delivery-status`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Headers**:
  - `X-Twilio-Signature`: `string` (Required — signature verified before processing, same rule as inbound)
- **Request Body Parameters**:
  ```http
  POST /webhooks/twilio/delivery-status HTTP/1.1
  Content-Type: application/x-www-form-urlencoded
  X-Twilio-Signature: 2/Y8k9z...

  MessageSid=SM100200300400500600700800900a&MessageStatus=delivered&To=%2B15550001111&From=%2B15551234567
  ```
  | Field | Type | Description |
  |---|---|---|
  | `MessageSid` | `string` | Provider SID of the sent outbound message. |
  | `MessageStatus` | `string` | Delivery status: `sent`, `delivered`, `failed`, `undelivered`. |
  | `To` | `string` (E.164) | **System Twilio number** that sent the message — used to resolve `tenant_id` for audit ledger. |
  | `From` | `string` (E.164) | Destination customer phone number. |
  | `ErrorCode` | `string` | (Optional) Twilio error code if delivery failed. |

- **Response Schemas**:
  - **`204 No Content`** (Signature valid, delivery status audit-logged with `tenant_id`):
    ```http
    HTTP/1.1 204 No Content
    ```
  - **`401 Unauthorized`** (Missing `X-Twilio-Signature` header):
    ```json
    { "error": "UNAUTHORIZED", "message": "Missing Twilio signature header" }
    ```
  - **`403 Forbidden`** (Invalid signature hash):
    ```json
    { "error": "FORBIDDEN", "message": "Invalid Twilio signature" }
    ```

> **Note**: The `To` field must be the **system's Twilio number** (the `From` on the original outbound send), not the customer's number. This is how `tenant_id` is resolved for the audit ledger row.


---

### 3. Service Health & State Verification Endpoints
- **Health Endpoint**: `GET /health`
  - **Response (`200 OK`)**:
    ```json
    {
      "status": "ok",
      "service": "bha-cst-engine"
    }
    ```

- **Debug State Endpoint**: `GET /debug/state`
  - **Description**: Returns live JSON snapshot of stored conversations, message transcripts, `messages_in` queue, and `messages_out` queue.
  - **Response (`200 OK`)**:
    ```json
    {
      "conversations": [
        {
          "conversation_id": "conv_e3b1c9d2",
          "tenant_id": "tenant-vfarm-01",
          "system_id": "system-vfarm-01",
          "customer_ref": "cust_vfarm_001_john_doe",
          "state": "open",
          "incident_ids": []
        }
      ],
      "transcripts": [
        {
          "message_id": "SM_CURL_KNOWN_001",
          "conversation_id": "conv_e3b1c9d2",
          "direction": "inbound",
          "from_e164": "+15551234567",
          "body": "Hello vFarm Support, Bay 4 temperature check"
        }
      ],
      "messages_in": [
        {
          "message_id": "SM_CURL_KNOWN_001",
          "tenant_id": "tenant-vfarm-01",
          "status": "enqueued"
        }
      ],
      "messages_out": [
        {
          "id": "out_f4a2b1c0",
          "tenant_id": "tenant-vfarm-01",
          "to_e164": "+15551234567",
          "body": "Echo: Hello vFarm Support, Bay 4 temperature check",
          "status": "sent"
        }
      ]
    }
    ```

---

### 4. External Subsystem Seam Contracts (vFarm & BHARAG)

### 4. External Subsystem Seam Contracts

#### BHARAG Cluster Knowledge Endpoint
- **Endpoint**: `POST https://bharag2.duckdns.org/api/v1/cluster/ask`  
- **Headers**:
  - `accept: application/json`
  - `x-api-key: <BHARAG_CLUSTER_KEY>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "query": "<customer message body>"
  }
  ```
- **Response Schemas**:
  - **`200 OK`** (Success):
    ```json
    {
      "answer": "Text response from knowledge base...",
      "confidence": 0.85,
      "has_context": true,
      "citations": [
        {
          "chunk_id": "uuid",
          "document_id": "uuid",
          "title": "Document Title",
          "excerpt": "Relevant excerpt...",
          "score": 0.365,
          "workspace_id": "workspace-uuid",
          "workspace_slug": "workspace-slug"
        }
      ]
    }
    ```
  - **`4xx/5xx`**: CST catches network errors and falls back to heuristic domain knowledge responses (e.g., for filter cleaning, pH balance, lighting cycles, irrigation rules).

#### Media Server (for images intent only)
- **Endpoint**: `GET https://media.bhavfarm.com/api/v1/captures/latest?unit_id=<unitId>`
- **Auth**: None (public endpoint)
- **Response**: JSON `{ "signed_url": "https://s3.amazonaws.com/.../latest_snap.jpg?Expires=..." }`
- **Timeout**: 1.5s with exponential backoff retry (handled by connector fallback)

#### Internal Seams (still used by CST)
While the following subsystems are still configured in CST, their APIs are not directly called by connector code in the current simplified setup:
- **vFarm Customer Registry Resolver** (`GET /api/v1/customers/resolve?phone=<E164>`) - used by `IdentityResolver`
- **vFarm Telemetry APIs** (reserved for future `VfarmConnector` reactivation)
- **BHARAG Incidents API** (`POST /api/v0/incidents`) - reserved for future `BharagIncidentsConnector` reactivation

---

## 7. Implementation Roadmap & Phases

- **Phase 1**: Inspection of source specifications and security standards.
- **Phase 2**: Initialization of TypeScript, Express, database migrations, and folder structure.
- **Phase 3**: Configuration module with Zod validation (`engine/src/config/env.ts`) and structured JSON security logger (`engine/src/config/logger.ts`).
- **Phase 4**: Dedicated Twilio signature verification (`engine/src/transport/twilio/signature.ts`).
- **Phase 5**: Systems Registry number-to-tenant lookup (`engine/src/systems/registry.ts`).
- **Phase 6**: Server-side tenancy scope middleware (`engine/src/middleware/tenancy.ts`).
- **Phase 7**: Mandatory Isolation Tests 3 (Unknown Number) & 4 (Bad Signature).
- **Phase 8-10**: Inbound normalization, MessageSid deduplication, HTTP 204 fast return, and canned `handle()` echo stub.
- **Phase 11**: Unknown sender onboarding response path.
- **Phase 12-14**: Outbound worker, SMS segmentation, retry logic, delivery callbacks, and Mandatory Isolation Test 8 (Outbound Cross-Tenant Prevention).
- **Phase 15-17**: Complete Mandatory Isolation Test 5 and verify end-to-end SMS round-trip.
- **Phase 18-20**: Connector consolidation - replaced vFarm Telemetry and BHARAG Incidents connectors with single BHARAG Cluster Ask endpoint for all knowledge queries while retaining Media Server for image handling. Updated IntentRouter to route all intents through BharagRagConnector with media URL attachment for images intent only.

---

## 7. How to Run & Test the Codebase

### Prerequisites
- Node.js (v20+ recommended)
- npm (v10+ recommended)

### 1. Environment Setup
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Ensure `.env` contains test/dev values:
```env
PORT=3000
NODE_ENV=development
TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000
TWILIO_AUTH_TOKEN=00000000000000000000000000000000
TWILIO_MESSAGING_SERVICE_SID=MG00000000000000000000000000000000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bha_cst
VFARM_RESOLVE_ENDPOINT=http://localhost:4000/api/v1/customers/resolve
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Type Checking
To verify TypeScript compilation across engine and test files:
```bash
npm run typecheck
```

### 4. Run Automated Test Suite
To run all unit, isolation, and integration tests:
```bash
npm test
```
Or directly using Vitest:
```bash
npx vitest run
```

#### Expected Test Output:
```
 ✓ tests/isolation/test3_unknown_number.test.ts  (1 test)
 ✓ tests/isolation/test4_bad_signature.test.ts   (1 test)
 ✓ tests/isolation/test5_unknown_sender.test.ts  (1 test)
 ✓ tests/isolation/test8_outbound_cross_tenant.test.ts (2 tests)
 ✓ tests/transport/inbound.test.ts               (2 tests)
 ✓ tests/transport/outbound.test.ts              (2 tests)
 ✓ tests/integration/roundtrip.test.ts           (1 test)

 Test Files  7 passed (7)
      Tests  10 passed (10)
```

### 5. Run E2E Roundtrip Test Specifically
To execute the end-to-end simulated SMS roundtrip test:
```bash
npx vitest run tests/integration/roundtrip.test.ts
```

### 6. Run Local Development Server
To launch the Express engine service locally:
```bash
npm run dev
```
The server will boot on port `3000` (or the configured `PORT`). You can check service health at:
```bash
curl http://localhost:3000/health
```
Output:
```json
{"status":"ok","service":"bha-cst-engine"}
```

---

## 8. Summary of Mandatory Security Tests

| Test | Description | Command | Verification |
|---|---|---|---|
| **Test 3** | Unknown Receiving Number | `npx vitest run tests/isolation/test3_unknown_number.test.ts` | 404 response, 0 DB rows, 0 Twilio calls |
| **Test 4** | Bad Signature | `npx vitest run tests/isolation/test4_bad_signature.test.ts` | 403 Forbidden before DB access |
| **Test 5** | Unknown Sender | `npx vitest run tests/isolation/test5_unknown_sender.test.ts` | Onboarding reply dispatched, opaque customer ref |
| **Test 8** | Outbound Cross-Tenant | `npx vitest run tests/isolation/test8_outbound_cross_tenant.test.ts` | Outbound worker refuses cross-tenant send |

---

## 9. Live System Testing & Ready-to-Use `curl` Commands

Make sure the dev server is running locally on `http://localhost:3000` via `npm run dev` before executing these test commands.

### Scenario 1: Engine Health Check
```bash
curl -i http://localhost:3000/health
```
**Expected Response**: `HTTP/1.1 200 OK`
```json
{"status":"ok","service":"bha-cst-engine"}
```

---

### Scenario 2: Valid Inbound SMS (Known Customer John Doe)
Simulates an inbound SMS from a registered vFarm customer (`+15551234567`) to vFarm System #1 (`+19715885823`).
```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_KNOWN_001" \
  -d "From=%2B15551234567" \
  -d "To=%2B15550001111" \
  -d "Body=Hello+vFarm+Support%2C+Bay+4+temperature+check"
```
**Expected Response**: `HTTP/1.1 204 No Content`
*(Engine normalizes message, returns 204 fast, generates canned echo reply `Echo: Hello vFarm Support, Bay 4 temperature check`, and processes outbound worker queue.)*

---

### Scenario 3: Unknown Sender Path (Mandatory Security Isolation Test 5)
Simulates an inbound SMS from an unmapped sender (`+15559998888`) to valid vFarm System #1 (`+19715885823`).
```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_UNKNOWN_SENDER_001" \
  -d "From=%2B15559998888" \
  -d "To=%2B15550001111" \
  -d "Body=Hi+I+just+purchased+a+new+farm+unit"
```
**Expected Response**: `HTTP/1.1 204 No Content`
*(Engine assigns opaque customer reference `opaque_unresolved_15559998888` without guessing identity and dispatches vFarm's onboarding response.)*

---

### Scenario 4: Unknown Receiving Phone Number (Mandatory Security Isolation Test 3)
Simulates an inbound SMS to an unregistered receiving number (`+19998887777`).
```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_BAD_NUMBER_001" \
  -d "From=%2B15551234567" \
  -d "To=%2B19998887777" \
  -d "Body=Hello+on+unregistered+number"
```
**Expected Response**: `HTTP/1.1 404 Not Found`
```json
{"error":"SYSTEM_NOT_FOUND","message":"Unknown receiving number"}
```
*(Engine refuses request, logs tripwire warning, creates 0 database rows, and produces no reply.)*

---

### Scenario 5: Bad / Missing Twilio Signature (Mandatory Security Isolation Test 4)
Simulates an unauthenticated webhook payload with an invalid `X-Twilio-Signature`.
```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Twilio-Signature: invalid_bogus_signature_hash" \
  -d "MessageSid=SM_CURL_BAD_SIG_001" \
  -d "From=%2B15551234567" \
  -d "To=%2B15550001111" \
  -d "Body=Unauthorized+payload"
```
**Expected Response**: `HTTP/1.1 403 Forbidden`
```json
{"error":"FORBIDDEN","message":"Invalid Twilio signature"}
```
*(Signature middleware rejects request BEFORE any database touch.)*

---

### Scenario 6: Outbound Delivery Callback (with required Twilio signature bypass)

Simulates a Twilio delivery status webhook. **Note**: This endpoint now requires a Twilio signature (GAP-6 fix). Use the dev bypass header for local testing.

```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/delivery-status \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_KNOWN_001" \
  -d "MessageStatus=delivered" \
  -d "To=%2B15550001111" \
  -d "From=%2B15551234567"
```
**Expected Response**: `HTTP/1.1 204 No Content`

> ⚠️ **`To` must be the system Twilio number** (`+19715885823`), not the customer number. This is used to resolve `tenant_id` for the audit ledger.

---

### Scenario 7: Delivery Callback with FAILED status

Simulates a failed delivery report:

```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/delivery-status \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_KNOWN_001" \
  -d "MessageStatus=failed" \
  -d "ErrorCode=30008" \
  -d "To=%2B15550001111" \
  -d "From=%2B15551234567"
```
**Expected Response**: `HTTP/1.1 204 No Content`

*(Audit ledger row emitted with `outcome: error`, `ErrorCode: 30008` in reason.)*

---

### Scenario 8: Delivery Callback Without Signature (Security Test)

Verifies delivery-status is now guarded by signature check:

```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/delivery-status \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "MessageSid=SM_CURL_KNOWN_001" \
  -d "MessageStatus=delivered" \
  -d "To=%2B15550001111" \
  -d "From=%2B15551234567"
```
**Expected Response**: `HTTP/1.1 401 Unauthorized`
```json
{"error":"UNAUTHORIZED","message":"Missing Twilio signature header"}
```

---

### Scenario 9: Query System State (Dev/Test only)

Verify all conversations, transcripts, and queues after running scenarios 2–5:

```bash
curl -i http://localhost:3000/debug/state
```
**Expected Response**: `HTTP/1.1 200 OK` (with full JSON snapshot)

New `from_e164` field now appears on `messages_out` entries:
```json
{
  "messages_out": [
    {
      "id": "out_801e...",
      "tenant_id": "tenant-vfarm-01",
      "from_e164": "+19715885823",
      "to_e164": "+15551234567",
      "body": "Echo: Hello vFarm Support, Bay 4 temperature check",
      "status": "sent"
    }
  ]
}
```

---

### Scenario 10: Query System State in Production Mode (Security Test)

Verifies `/debug/state` is hidden in production:

```bash
NODE_ENV=production curl -i http://localhost:3000/debug/state
```
**Expected Response**: `HTTP/1.1 404 Not Found`
```json
{"error":"NOT_FOUND"}
```


---

## 10. How to Verify Data & System State (3 Methods)

You can verify whether inbound SMS messages, deduplication, tenancy checks, conversations, and outbound responses are working using any of the following 3 methods:

### Method 1: Query the Live Debug State Endpoint (`curl`)
Execute `curl` against `http://localhost:3000/debug/state` after sending test requests:
```bash
curl http://localhost:3000/debug/state
```
This returns a full JSON snapshot of:
- `conversations`: Active conversation records created in memory/Postgres.
- `transcripts`: Full inbound & outbound transcript log.
- `messages_in`: Inbound transport queue & deduplication ledger.
- `messages_out`: Outbound worker queue status (`pending`, `sent`, `refused`).

---

### Method 2: Inspect Structured Console Logs & Security Audit Events
When the service runs (`npm run dev`), inspect stdout for JSON log lines:

1. **Successful Execution Event**:
   ```json
   {"timestamp":"...","type":"SECURITY_LEDGER","tenant_id":"tenant-vfarm-01","actor":"cust_vfarm_001_john_doe","role":"customer","entry_point":"webhook","tool_or_route":"handle()","outcome":"ok","reason":"canned echo reply generated"}
   {"timestamp":"...","type":"SECURITY_LEDGER","tenant_id":"tenant-vfarm-01","actor":"outbound_worker","role":"transport_worker","entry_point":"api","tool_or_route":"processOutboundQueue","outcome":"ok","reason":"Twilio send succeeded"}
   ```
2. **Security Refusal Event (Tripwire Warning)**:
   ```json
   {"timestamp":"...","type":"SECURITY_LEDGER","tenant_id":null,"actor":"twilio_webhook","role":"untrusted_ingress","entry_point":"webhook","tool_or_route":"resolveSystemByPhoneNumber","outcome":"refused","reason":"Unknown receiving phone number +19998887777","level":"WARN","tripwire":true}
   ```

---

### Method 3: Database Verification via PostgreSQL Queries
When connected to a PostgreSQL database (`DATABASE_URL`), run the following SQL queries to inspect state:

```sql
-- 1. Check created conversations
SELECT conversation_id, tenant_id, system_id, customer_ref, state, created_at 
FROM conversations;

-- 2. Check message transcripts
SELECT message_id, conversation_id, tenant_id, direction, from_e164, to_e164, body 
FROM messages;

-- 3. Check inbound queue & deduplication ledger
SELECT message_id, tenant_id, from_e164, to_e164, status, received_at 
FROM messages_in;

-- 4. Check outbound worker queue & delivery status
SELECT id, tenant_id, to_e164, body, status, retry_count, error_message, sent_at 
FROM messages_out;
```


