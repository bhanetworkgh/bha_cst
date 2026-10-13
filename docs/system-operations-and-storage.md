# Customer Service Twin (`bha-cst`) — System Operations & Storage Map

This document provides a comprehensive overview of **how key operations are executed** and **where all configurations, state, logs, and data are stored** across the Customer Service Twin platform.

> **Last updated**: 2026-09-14 — Added `Logger.infra()` / `InfraEvent`, `commercial_impact` field on logs, Recording SOP, and Degraded State Spec v0.1. See [§5 — Logging Architecture](#5-logging-architecture) and [§6 — Related Documentation](#6-related-documentation).

---

## 1. How Operations Are Executed (Workflow Guide)

### 1.1 Inbound SMS Webhook Processing
- **Ingress Route**: `POST /webhooks/twilio/sms` (defined in [engine/src/transport/twilio/inbound.ts](engine/src/transport/twilio/inbound.ts))
- **Step 1: Signature Verification**: `verifyTwilioSignature` validates `X-Twilio-Signature` using `TWILIO_AUTH_TOKEN`.
- **Step 2: System & Tenant Resolution**: Resolves target system configuration (`system_id`, `tenant_id`) from `To` phone number.
- **Step 3: Security Isolation Gate**: `enforceTenancyGate` enforces tenant context before touching any business logic or database tables.
- **Step 4: Async Dispatch**: Returns HTTP 204 response immediately to Twilio while queuing async message processing in background.

### 1.2 Customer Identity Resolution
- **Service Connector**: `resolveCustomerIdentity` in [engine/src/identity/resolver.ts](engine/src/identity/resolver.ts)
- **Seam Contract**: Performs HTTP request to `VFARM_RESOLVE_ENDPOINT` with header `x-api-key: VFARM_RESOLVE_API_KEY`.
- **Mapping**: Maps sender phone number (e.g., `+19715885823`) to internal customer reference `customer_ref` (e.g., `cust_vfarm_001_john_doe`).

### 1.3 Intent Detection & Knowledge Querying
- **Engine Router**: `IntentRouter.routeAndHandle()` in [engine/src/router/index.ts](engine/src/router/index.ts)
- **Intents & Actions**:
  1. **Knowledge (`knowledge` / `status`)**: Calls `BharagRagConnector.askKnowledge()` in [engine/src/connectors/bharag_rag.ts](engine/src/connectors/bharag_rag.ts) targeting `BHARAG_CLUSTER_URL` with header `x-api-key: BHARAG_CLUSTER_KEY` and JSON payload `{ query: question }`.
  2. **Images (`images`)**: Queries BHARAG Cluster RAG + fetches signed S3 capture URL via `MediaServerConnector.getLatestCaptureUrl()` from `MEDIA_SERVER_URL`.
  3. **Escalation (`escalate`)**: Queries BHARAG Cluster RAG + files incident ticket via `BharagIncidentsConnector.fileIncident()` at `BHARAG_API_URL`.
  4. **Onboarding (`unknown`)**: Sends system onboarding message `VFARM_ONBOARDING_REPLY`.

### 1.4 Outbound SMS Messaging & Delivery Error Handling
- **Worker & Transport**: [engine/src/transport/twilio/outbound.ts](engine/src/transport/twilio/outbound.ts) and [engine/src/transport/twilio/client.ts](engine/src/transport/twilio/client.ts)
- **Segmentation**: Splits messages > 160 characters into standard GSM SMS segments.
- **Twilio API Delivery**: Executes `client.messages.create()` using `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID`.
- **Error Handling**:
  - Permanent non-retriable codes (e.g., `21211` Invalid To number, `21614` Invalid mobile, `21610` Unverified trial number) trigger immediate failure classification and security ledger logging without redundant retries.
  - Transient errors undergo retries with exponential backoff.

---

## 2. Where Data & Configuration Are Stored

### 2.1 Environment Variables & Configuration
- **Primary Storage File**: [`.env`](.env) (Template in [`.env.example`](.env.example))
- **Schema & Validation**: [engine/src/config/env.ts](engine/src/config/env.ts) validates variables using Zod at runtime boot.

| Variable | Description | Example / Location |
| :--- | :--- | :--- |
| `PORT` | Node.js HTTP server listening port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://postgres:postgres@localhost:5432/bha_cst` |
| `TWILIO_ACCOUNT_SID` | Twilio API Account SID | Defined in `.env` |
| `TWILIO_AUTH_TOKEN` | Twilio API Secret Key | Defined in `.env` |
| `TWILIO_MESSAGING_SERVICE_SID` | Twilio Messaging Service ID | Defined in `.env` |
| `VFARM_RESOLVE_ENDPOINT` | Customer resolution API endpoint | `http://localhost:4000/api/v1/customers/resolve` |
| `VFARM_RESOLVE_API_KEY` | Secret API key for vFarm lookup | Defined in `.env` |
| `BHARAG_CLUSTER_URL` | Unified BHARAG RAG Knowledge API URL | `https://bharag2.duckdns.org/api/v1/cluster/ask` |
| `BHARAG_CLUSTER_KEY` | BHARAG Cluster API Key | `bha_clu_CgIfAKAHfzvOMI0lcZBmMVgy5m9j1xij` |
| `BHARAG_API_URL` | BHARAG Incidents endpoint | `http://localhost:5000/api/v0` |
| `MEDIA_SERVER_URL` | Signed S3 photo capture URL server | `https://media.bhavfarm.com` |
| `S3_MEDIA_BUCKET_URL` | AWS S3 Bucket public URL | `https://vfarm-media-captures.s3.us-east-1.amazonaws.com` |

---

### 2.2 Relational Database Storage (PostgreSQL)

Database connection managed via [engine/src/db/client.ts](engine/src/db/client.ts). Migration files are stored in `db/migrations/`:
- [001_initial_schema.sql](db/migrations/001_initial_schema.sql)
- [002_add_missing_system_config_cols.sql](db/migrations/002_add_missing_system_config_cols.sql)

#### Database Tables Overview:

1. **`systems` Table**
   - **Purpose**: Stores system registry and multi-tenant configurations.
   - **Key Columns**: `system_id`, `tenant_id`, `system_name`, `phone_numbers`, `onboarding_reply`, `bharag_workspace_key`.

2. **`conversations` Table**
   - **Purpose**: Tracks active and historical customer support threads.
   - **Key Columns**: `id`, `tenant_id`, `system_id`, `customer_ref`, `customer_phone`, `status`, `created_at`, `updated_at`.

3. **`messages` Table**
   - **Purpose**: Stores full message history (inbound & outbound audit log).
   - **Key Columns**: `id`, `conversation_id`, `tenant_id`, `direction` (`inbound`/`outbound`), `body`, `media_urls`, `provider_sid`, `status`, `segments`, `created_at`.

4. **`security_ledger` Table**
   - **Purpose**: Centralized, immutable security audit ledger and tripwire log.
   - **Key Columns**: `id`, `timestamp`, `tenant_id`, `actor`, `role`, `entry_point`, `tool_or_route`, `outcome`, `reason`, `correlation_id`, `tripwire`, `level`.

---

### 2.3 Media & Image Captures
- **Storage Location**: AWS S3 Bucket (`vfarm-media-captures` in region `us-east-1`).
- **Access Pattern**: Presigned S3 URLs generated on demand by `MEDIA_SERVER_URL` (`https://media.bhavfarm.com`) and delivered via Twilio MMS `mediaUrl` payloads.

---

### 2.4 Codebase Directory Map

```
customer twin/
├── .env                                  # Real environment secrets (Git-ignored)
├── .env.example                          # Environment template
├── db/
│   └── migrations/                       # SQL migration files (001–006)
├── docs/
│   ├── api-endpoints.md                  # API endpoint reference
│   ├── architecture.md                   # Architecture & tenancy security rules
│   ├── degraded-state-spec-v0.1.md       # [NEW] Degraded telemetry state spec — no fake values policy
│   ├── recording-sop.md                  # [NEW] Recording SOP — Session Type mandatory at recording start
│   ├── system-architecture-and-guide.md  # Comprehensive architectural spec
│   └── system-operations-and-storage.md  # Operational workflows & storage reference (this file)
└── engine/
    ├── src/
    │   ├── app.ts                        # Express server entrypoint
    │   ├── config/
    │   │   ├── env.ts                    # Zod env schema & validation
    │   │   └── logger.ts                 # Logger: info/warn/error/infra/audit — see §5
    │   ├── connectors/                   # External APIs (vfarm.ts, bharag_rag.ts, bharag_incidents.ts, media.ts)
    │   ├── db/                           # PostgreSQL database client & queries
    │   ├── identity/                     # Customer resolution (resolver.ts)
    │   ├── router/                       # Intent detection & route handling (index.ts)
    │   ├── systems/                      # Multi-tenant system registry (registry.ts)
    │   └── transport/
    │       └── twilio/                   # Inbound webhook, signature validation, outbound client
    └── tests/                            # Automated Vitest test suite
```

---

## 5. Logging Architecture

All structured logs are emitted via [`engine/src/config/logger.ts`](engine/src/config/logger.ts). Four log methods are available:

| Method | Output Stream | JSON `type` field | When to Use |
| :--- | :--- | :--- | :--- |
| `Logger.info(message, meta?)` | `stdout` | *(none)* | Routine operational events |
| `Logger.warn(message, meta?)` | `stderr` | *(none)* | Non-critical warnings |
| `Logger.error(message, meta?)` | `stderr` | *(none)* | Errors and exceptions |
| `Logger.infra(event)` | `stderr` | `INFRA_EVENT` | Infrastructure/reliability failures — **requires `commercial_impact`** |
| `Logger.audit(event)` | `stdout`/`stderr` | `SECURITY_LEDGER` | Security & tenancy audit events — supports optional `commercial_impact` |

### 5.1 `InfraEvent` — Infrastructure Reliability Logs

The `InfraEvent` interface (defined in `logger.ts`) is the standard for all infra/reliability log events:

```typescript
interface InfraEvent {
  message: string;
  commercial_impact: string; // REQUIRED — must state business consequence
  meta?: Record<string, unknown>;
}
```

All `Logger.infra()` calls produce a JSON log entry with `type: "INFRA_EVENT"` and a mandatory `commercial_impact` field. This field is **required** — it ensures every infrastructure failure carries an explicit statement of business consequence for triage and escalation.

**Call-sites with `Logger.infra()`:**

| Location | Trigger | `commercial_impact` Summary |
| :--- | :--- | :--- |
| `connectors/vfarm.ts` | Cluster API error/timeout | Customer cannot receive live sensor data |
| `connectors/vfarm.ts` | Cluster returned no usable data | Customer cannot receive live sensor data |
| `transport/twilio/outbound.ts` | Permanent non-retriable Twilio error | Message permanently undeliverable |
| `transport/twilio/outbound.ts` | Outbound send failed after all retries | Customer has not received a reply |
| `app.ts` | Rate limit exceeded | Legitimate Twilio deliveries may be delayed |

### 5.2 `SecurityLedgerEvent` — Security Audit Logs

The `SecurityLedgerEvent` interface now carries an optional `commercial_impact?: string` field. Set this on any audit entry where a security decision has a known business effect (e.g. message delivery failure after all retries).

---

## 6. Related Documentation

| Document | Purpose |
| :--- | :--- |
| [degraded-state-spec-v0.1.md](degraded-state-spec-v0.1.md) | v0.1 spec for degraded/unreachable telemetry states — defines `telemetry_unavailable` contract, prohibits fake sensor values, mandates `commercial_impact` infra log |
| [recording-sop.md](recording-sop.md) | Recording SOP — Session Type mandatory at start of every video/audio/screen recording |
| [architecture.md](architecture.md) | Architecture overview & tenancy isolation rules |
| [api-endpoints.md](api-endpoints.md) | Full API endpoint reference |
| [system-architecture-and-guide.md](system-architecture-and-guide.md) | Comprehensive architectural spec & per-message flow |
