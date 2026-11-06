# Customer Service Twin (`bha-cst`)

`bha-cst` is a production-grade, multi-tenant automated **Customer Service Twin** engine. It serves as the primary automated receptionist and support dispatcher for hydroponic systems (System #1 is **vFarm**).

---

## 🔒 Security, Identity & Tenancy Rules

> **1. Organization Boundary**: Organization is the top-level tenant boundary.
> **2. Workspaces/Projects**: Workspaces/projects exist inside an organization.
> **3. Workspace Isolation**: Workspace/project access cannot cross organization boundaries.
> **4. Identity Rule**: Caller phone numbers are routing hints, not authentication credentials.
> **5. Known/Unknown Rule**: Only onboarded users receive personalized/account-level information.
> **6. Server-Side Roles**: Roles are server-resolved (`owner`, `manager`, `tech`).
> **7. Role Matrix**: Each role has explicit permissions.
> **8. Step-Up Rule**: Sensitive write/action operations require step-up authentication regardless of role.
> **9. BHARAG Cluster**: CST uses BHARAG Cluster Search rather than selecting an arbitrary workspace.
> **10. Server Scope Authority**: Organization/workspace scope cannot be supplied or overridden by customer or LLM.
> **11. Incidents Ownership**: Incidents remain owned by BHARAG `incidents.v0`.
> **12. Fail Closed**: Unresolved or conflicting tenancy scope produces an immediate refusal.

### Roles & Authorization Model
* **owner**: Full read, view status, BHARAG cluster search, file incidents, manage workspace users & permissions, perform sensitive operations (**with step-up auth only**).
* **manager**: Read context, view status, BHARAG cluster search, file incidents, operational actions (**with step-up auth only**).
* **tech**: Read context, view status, BHARAG cluster search, investigate issues, file incidents. Cannot manage users/roles or execute control actions.
* **unknown**: Safe generic onboarding response (`systemConfig.onboarding_reply`); zero account/device access.

---

Per `2026-08-26-spec-bha-cst-architecture-v1.0.md`, `bha-cst` maintains strict system boundaries:

### What `bha-cst` OWNS
* **Conversations & Transcripts**: SMS/MMS message logs, active chat threads, and state (`open` / `waiting` / `closed`).
* **Transport Queues**: `messages_in` (Twilio `MessageSid` deduplication) and `messages_out` (outbound delivery queue).
* **Systems Registry**: Multi-tenant configurations mapping receiving phone numbers to tenant systems (`system-vfarm-01`).
* **Intent Router**: Rule-based intent classification (`status`, `knowledge`, `images`, `escalate`, `default`).

### What `bha-cst` DOES NOT OWN (External Subsystem Seams)
| Subsystem | External Authority | Integration Seam & Credentials | Boundary Rule |
|---|---|---|---|
| **Identity** | vFarm Customer Registry | `GET /api/v1/customers/resolve?phone=<E164>` via `VFARM_RESOLVE_API_KEY` | CST stores **zero customer accounts**; caller identity is resolved per message via DB/API. |
| **Incidents** | BHARAG `incidents.v0` | `POST /api/v0/incidents` via `BHARAG_WORKSPACE_KEY` | CST files tickets into BHARAG (`subsystem=CUSTOMER_TWIN`, `engine=VFARM`); stores **only `incident_id` reference** on conversation. |
| **Knowledge** | BHARAG RAG Corpus | `POST /api/v0/ask` via `BHARAG_WORKSPACE_KEY` | CST holds no documentation locally; queries common BHARAG substrate. |
| **Media** | Media Server | `GET /api/v1/captures/latest` | CST passes short-lived signed S3 URLs; **never stores raw image binaries**. |

---

## 🔄 How the System Works (5-Step Pipeline)

```
Customer Cell Phone ──► Twilio SMS Webhook ──► /webhooks/twilio/sms
                                                       │
  ┌────────────────────────────────────────────────────┴────────────────────────────────────┐
  │ Step 1: Pre-DB Security Gate                                                            │
  │ - Verifies digital X-Twilio-Signature (Rejects unauthorized callers with 403)           │
  │ - Resolves receiving phone (+19715885823 -> system-vfarm-01). Refuses unknown with 404.  │
  │ - Returns HTTP 204 fast to Twilio                                                       │
  └────────────────────────────────────────────────────┬────────────────────────────────────┘
                                                       │ (Async setImmediate)
                                                       ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────────┐
  │ Step 2: Identity Lookup & Intent Router                                                 │
  │ - Looks up sender E.164 (+923082113844) in DB customers table                            │
  │ - Known customer ➔ Route message through IntentRouter (status/knowledge/images/escalate)│
  │ - Unknown customer ➔ Trigger system onboarding reply                                    │
  └────────────────────────────────────────────────────┬────────────────────────────────────┘
                                                       │
                                                       ▼
  ┌─────────────────────────────────────────────────────────────────────────────────────────┐
  │ Step 3: Outbound Transport Worker & Delivery Callback                                   │
  │ - Enforces cross-tenant destination scope check                                         │
  │ - Calls Twilio API with exponential backoff retry (up to 3 attempts)                    │
  │ - Receives Twilio delivery status callback at /webhooks/twilio/delivery-status          │
  └─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚙️ Environment & Database Setup

### 1. Configure Environment Variables
Copy `.env.example` to `.env` and configure your credentials:

```bash
cp .env.example .env
```

Ensure the following variables are set in `.env`:
* `PORT=3000`
* `TWILIO_ACCOUNT_SID=...`
* `TWILIO_AUTH_TOKEN=...`
* `TWILIO_MESSAGING_SERVICE_SID=...`
* `VFARM_PHONE_NUMBERS=+19715885823`
* `VFARM_RESOLVE_API_KEY=vfarm_cst_secret_key`
* `BHARAG_WORKSPACE_KEY=workspace_vfarm_cst_key`

### 2. Database Schema Setup (PostgreSQL)
Run the SQL migration files in order:

```bash
# Create database
createdb bha_cst

# Run migrations
psql -d bha_cst -f db/migrations/001_initial_schema.sql
psql -d bha_cst -f db/migrations/002_add_missing_system_config_cols.sql
psql -d bha_cst -f db/migrations/003_customers_table.sql

# Seed vFarm test customers
psql -d bha_cst -f db/seeds/001_vfarm_customers.sql
```

---

## 🚀 Running the Project

### Install Dependencies
```bash
npm install
```

### Development Mode (with Live Reload)
```bash
npm run dev
```

### Type Checking & Automated Test Suite
```bash
# Run TypeScript compiler check
npm run typecheck

# Run Vitest test suite (472 tests across 50 test files)
npm test
```

### Production Build & Launch (Render / AWS)
```bash
# Compile TypeScript to dist/
npm run build

# Launch production server
npm start
```

---

## 🧪 Testing Webhooks & Endpoints via `curl`

> **Note**: For local manual testing without a live Twilio signature, set header `-H "x-test-bypass-signature: true"`.

### 1. Health Check & Debug State
```bash
# Check server health
curl -i http://localhost:3000/health

# Inspect in-memory messages in, messages out, transcripts, and conversations
# (Requires NODE_ENV=development in .env)
curl -i http://localhost:3000/debug/state
```

### 2. Inbound SMS — Known Customer Status Query
Simulate an SMS from registered customer `+923082113844` to vFarm support number `+19715885823`:

```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_TEST_STATUS_001" \
  -d "From=%2B923082113844" \
  -d "To=%2B19715885823" \
  -d "Body=Bay+4+status+check"
```
* **Expected Response**: `HTTP 204 No Content` (fast response).
* **Async Output**: Intent router detects `status` intent and enqueues status response to outbound queue.

### 3. Inbound SMS — Knowledge RAG Question
```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_TEST_RAG_001" \
  -d "From=%2B923082113844" \
  -d "To=%2B19715885823" \
  -d "Body=How+to+clean+nutrient+filter%3F"
```

### 4. Inbound SMS — Incident Escalation
```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_TEST_FAULT_001" \
  -d "From=%2B923082113844" \
  -d "To=%2B19715885823" \
  -d "Body=Pump+alarm+water+leak+emergency%21"
```

### 5. Inbound SMS — Unknown Sender Onboarding Path
Simulate an SMS from an unregistered phone number (`+15550009999`):

```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_TEST_UNKNOWN_001" \
  -d "From=%2B15550009999" \
  -d "To=%2B19715885823" \
  -d "Body=Hello"
```
* **Expected Result**: Receives system onboarding reply (`Welcome to vFarm Support!...`).

### 6. Twilio Delivery Status Callback
Simulate Twilio notifying CS Twin of message delivery:

```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/delivery-status \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_CURL_TEST_STATUS_001" \
  -d "MessageStatus=delivered"
```

### 7. Security Isolation Test — Unknown Receiving Phone Number (Refusal)
Send an SMS to an unregistered receiving number (`+19998887777`):

```bash
curl -i -X POST http://localhost:3000/webhooks/twilio/sms \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "x-test-bypass-signature: true" \
  -d "MessageSid=SM_BAD_NUMBER_001" \
  -d "From=%2B923082113844" \
  -d "To=%2B19998887777" \
  -d "Body=Test"
```
* **Expected Response**: `HTTP 404 Not Found` (refused before DB touch).

---

## 📖 API Documentation (Swagger / OpenAPI)

Interactive API documentation is built-in and accessible directly from the running engine:

* **Production Swagger UI**: [https://bha-cst.onrender.com/api-docs](https://bha-cst.onrender.com/api-docs)
* **Production OpenAPI Spec (JSON)**: [https://bha-cst.onrender.com/api-docs.json](https://bha-cst.onrender.com/api-docs.json)
* **Local Swagger UI**: [http://localhost:3000/api-docs](http://localhost:3000/api-docs)
* **Local OpenAPI Spec (JSON)**: [http://localhost:3000/api-docs.json](http://localhost:3000/api-docs.json)

The Swagger documentation covers:
* Webhook ingestion (`POST /webhooks/twilio/sms`) with form-urlencoded schemas, headers, error responses, and 8-step pipeline details.
* Twilio delivery status callbacks (`POST /webhooks/twilio/delivery-status`).
* Engine health checks (`GET /health`).
* In-memory debug state snapshots (`GET /debug/state`).

---

## 📚 Documentation References
* [API Endpoints Reference](docs/api-endpoints.md)
* [System Architecture & Implementation Guide](docs/system-architecture-and-guide.md)
* [Tenant Isolation Guide](docs/tenant-isolation-guide.md)
* [Architecture Blueprint](2026-08-26-spec-bha-cst-architecture-v1.0.md)

## PBT5 relay tracing (draft, opt-in)

`CST_RELAY_TRACE=true` adds structured webhook/DB/dispatch IDs and a Slack trace
marker without changing relay routing or retry behavior. It defaults off.
`scripts/pbt5_slack_receipt.mjs` is a separate read-only operator tool using
`PBT5_SLACK_READ_TOKEN` to bind a dispatch marker to the exact Slack message.
See [the traced relay drill](docs/reports/PBT5_TRACED_RELAY_DRILL.md) for ID
semantics, required read permissions, evidence limits and approval gates.
