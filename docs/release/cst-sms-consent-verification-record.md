# SMS Consent Spine Verification & Evidence Record

**Loop:** `LOOP-1791467054702-NI8F`
**Lane:** CST
**Component:** Engine SMS Consent Spine (`engine/src/consent/`, `engine/src/transport/twilio/outbound.ts`, `engine/src/db/client.ts`)
**Associated Migrations:** `016_sms_consents.sql`, `017_sms_consent_audit_fk.sql`, `018_sms_consent_prompts.sql`, `024_add_consent_exempt_to_messages_out.sql` (proposed)
**Approved Sender DID:** `+1 (971) 588-5823` (`+19715885823`)
**Test Suites:**
- `tests/consent/consent_spine.test.ts` (28/28 passed)
- `tests/consent/a2p_operational_acceptance.test.ts` (10/10 passed)
- `tests/consent/sms_consent_spine_acceptance.test.ts` (11/11 passed)
**Date:** 16 November 2026
**Status:** READY FOR OPERATOR REVIEW (49/49 TESTS PASS; PRE-DISPATCH & RETRY RE-CHECKS ENFORCED; PROPOSED MIGRATION 024 PREPARED)

---

## 1. Authoritative Requirements & Regulatory Standard

The CST SMS Consent Spine implements the strict opt-in, revocation, and audit standards mandated by CTIA / A2P 10DLC compliance and Bays tenant isolation policies:
1. **Explicit Opt-In Required**: Outbound messages cannot be queued or dispatched without an active, verified consent record for the specific `(tenant_id, project_id, phone_number)` tuple.
2. **Canonical STOP Keywords**: Automatic and immediate opt-out upon receiving any of: `STOP`, `CANCEL`, `QUIT`, `UNSUBSCRIBE`, `END`, or conversational stop phrases (e.g. `please stop`, `I want to unsubscribe`).
3. **Resubscribe Safeguards**: Inbound messages from opted-out numbers must not automatically resume consent. They must trigger an explicit opt-in confirmation prompt.
4. **Append-Only Tamper-Evident Audit**: Every consent state change (opt-in, opt-out, withdrawal, system prompt) writes to `sms_consent_audit` with a PostgreSQL trigger preventing `UPDATE` or `DELETE`.

---

## 2. End-to-End Consent Lifecycle Architecture

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant Twilio as Twilio Webhook
    participant Inbound as Transport Inbound
    participant Consent as Consent Service
    participant DB as Postgres (sms_consents)
    participant Outbound as Outbound Worker

    Customer->>Twilio: Inbound SMS (e.g. "START" or reply)
    Twilio->>Inbound: POST /transport/twilio/sms/inbound
    Inbound->>Consent: handleInboundConsentMessage()
    alt Matches Opt-In / Active Prompt
        Consent->>DB: recordConsent(status='active', source='sms_reply')
        Consent->>DB: sms_consent_audit (append-only trigger)
    else Matches STOP / Opt-Out
        Consent->>DB: recordSmsOptOut(status='opted_out')
        Consent->>DB: sms_consent_audit (append-only trigger)
        Consent-->>Customer: Standardized STOP confirmation message
    end

    Note over Outbound: Later Outbound Attempt
    Outbound->>Consent: getConsentStatus(tenant, project, phone)
    alt Consent is Active
        Outbound->>Twilio: Dispatch Outbound SMS
    else Consent is Missing, Refused, or Opted-Out
        Outbound->>Outbound: Suppress Message / Drop to Dead Letter
        Outbound->>DB: SECURITY_LEDGER (outcome='suppressed')
    end
```

---

## 3. Key Components Traced in Code

### 3.1 Detection & Keyword Parsing
- **File**: `engine/src/consent/wording.ts`
- **Functions**:
  - `isOptOutMessage(body)`: Matches exact keywords `stop`, `cancel`, `quit`, `unsubscribe`, `end` case-insensitively and with word boundary regex.
  - `isResubscribeRequest(body)`: Detects `start`, `unstop`, `subscribe`.
  - `isConsentResponse(body)`: Validates positive confirmation against active prompts.

### 3.2 Consent Service & Lifecycle Methods
- **File**: `engine/src/consent/service.ts`
- **Methods**:
  - `getConsentStatus()`: Queries active consent scoped strictly by `(tenant_id, project_id, phone_number)`.
  - `recordConsent()`: Inserts or updates consent state; requires valid prompt reference.
  - `recordSmsOptOut()`: Updates status to `opted_out`, sets `opted_out_at`, writes audit entry.
  - `activateConsentViaPrompt()`: Safely transitions pending prompt to active consent upon customer confirmation.

### 3.3 Outbound Unified Enforcement Boundary & Pre-Dispatch Re-Verification
- **File**: `engine/src/transport/twilio/outbound.ts`
- Outbound worker exports and invokes `evaluateOutboundConsent(msg: OutboundMessage)`:
  - Fails closed (`status: 'lookup_error'`) if PostgreSQL experiences any error or connection timeout.
  - Re-checks consent immediately before `TwilioClientWrapper.sendSms()` on every attempt inside the retry loop (`while (attempt < maxRetries && !success)`).
  - Guarantees that if a recipient texts `STOP` while an outbound message is queued or during backoff between retries, delivery is aborted immediately and marked `status: 'refused'` without hitting Twilio.
  - Guards `consent_exempt: true` via `validateConsentExempt()` so only verified project-bound DIDs can dispatch platform transactional replies (onboarding, STOP confirmation, HELP).
  - Logged with `SECURITY_LEDGER` under `tool_or_route: "processOutboundQueue"`.

---

## 4. Test Verification Evidence

The entire consent suite was executed locally and completed with 100% pass rate (49/49 passing tests):

### 4.1 Unit & Spine Verification (`tests/consent/consent_spine.test.ts`)
- **Total Tests**: 28 passed | 0 failed
- **Key Assertions**:
  - `isOptOutMessage`: handles uppercase, lowercase, punctuation, and multi-word phrases (7/7 pass).
  - Consent prompt creation & single active prompt constraint (4/4 pass).
  - Outbound suppression on missing consent (3/3 pass).
  - Opt-out state transition and confirmation text generation (6/6 pass).
  - Append-only audit integrity (4/4 pass).
  - Cross-tenant isolation: Tenant A's opt-out never suppresses Tenant B's consent (4/4 pass).

### 4.2 A2P Operational Acceptance (`tests/consent/a2p_operational_acceptance.test.ts`)
- **Total Tests**: 10 passed | 0 failed
- **Key Assertions**:
  - Full opt-in -> message -> STOP -> blocked -> resubscribe cycle (10/10 pass).

### 4.3 NI8F Canonical Acceptance Suite (`tests/consent/sms_consent_spine_acceptance.test.ts`)
- **Total Tests**: 11 passed | 0 failed
- **Coverage of 12 Authoritative Criteria**:
  1. Explicit opt-in permits an eligible SMS.
  2. Explicit opt-out blocks an SMS.
  3 & 4. Unknown and missing consent records fail closed and block SMS.
  5. Consent database errors fail closed (`lookup_error`) and log audit warnings without dispatching.
  6. Opt-out after queue insertion aborts delivery before Twilio dispatch.
  7. Retry processing re-checks consent before every retry attempt; an opt-out during backoff aborts delivery.
  8. Repeated STOP callbacks are idempotent and do not duplicate audit records or throw errors.
  9 & 10. Consent is strictly isolated by `(tenant_id, project_id)` and never leaks across tenants.
  11. Voice interface (`voice_lane.ts`) operates independently and is unaffected by SMS consent state.
  12. All outbound SMS paths enforce consent before delivery.
  13. International E.164 normalization and lifecycle verification with live masked phone logging (`+9230****3844`).

---

## 5. Schema Reconciliation (Migrations 016, 017, 018, 024)

| Migration | Target Table / Object | Enforced Constraint / Safety Feature | Verified in Code |
|---|---|---|---|
| `016_sms_consents.sql` | `sms_consents` | Primary key `(id)`, foreign key `(tenant_id, project_id)`. | Yes |
| `017_sms_consent_audit_fk.sql` | `sms_consent_audit` | Composite FK `(consent_id, tenant_id)`, PostgreSQL `BEFORE UPDATE OR DELETE` raise exception trigger. | Yes |
| `018_sms_consent_prompts.sql` | `sms_consent_prompts`| Unique index `idx_sms_consent_prompts_active_unique` on `(tenant_id, project_id, phone_number)` where `status = 'pending'`. | Yes |
| `024_add_consent_exempt_to_messages_out.sql` (Proposed) | `messages_out` | Adds `consent_exempt BOOLEAN NOT NULL DEFAULT FALSE` to durably persist exemption flags across server restarts. | Migration file prepared |

---

## 6. Next Steps for Complete Acceptance

1. **Staging / Production DB Check**: Run the read-only queries in `docs/release/cst-ho-fe-schema-verification-guide.md` to confirm migrations 017 and 018 triggers are active in PostgreSQL.
2. **Authorized Live Smoke Test**: Conduct one live test with an approved internal cell number to demonstrate real Twilio STOP receipt and automatic suppression.
