# SMS Consent Spine

## Overview

The SMS Consent Spine is CST's mechanism for tracking and enforcing whether a
phone number has consented to receive SMS messages. It is a **strictly
separate** concern from vFarm identity and farm authorization.

## Why consent is separate from identity

```
phone → CST SMS consent      → opted_in / opted_out / not_consented  (consent spine)
phone → vFarm person_id       → farm grants → farm authorization     (identity resolver)
```

This separation means:

- A phone can be a valid vFarm member (authorized) but **not** consented —
  outbound SMS to this phone is blocked.
- A phone can be consenting but **unknown** in vFarm — it may still receive
  the safe generic onboarding reply (which is how CST collects consent).
- Identity data (farm grants, unit access) is never derived from consent
  state, and consent state is never derived from identity data.

## Canonical consent wording

The consent text is defined in one canonical location:
`engine/src/consent/wording.ts`

- **Version:** `cst_sms_consent_v1`
- **Text:** `"I agree to receive text messages from Customer Service Twin for
  vFarm monitoring, account verification, subscription and appointment
  confirmations, and 1:1 support."`

All opt-in surfaces (SMS onboarding reply, future Early Access, kiosk, app)
**must** call `getConsentWording()` to retrieve this text. The wording version
and snapshot are stamped server-side at recording time — client-supplied
wording versions are ignored.

## STOP keywords

The canonical STOP keyword set is defined in `engine/src/consent/wording.ts`
as `STOP_KEYWORDS`. This is the minimal Twilio-required set:

| Keyword |
|---------|
| stop |
| stopall |
| unsubscribe |
| quit |
| end |
| cancel |

STOP detection uses word-boundary matching (case-insensitive), so "please
stop" and "I want to unsubscribe" are detected, while "stopped" is not.

## Database schema

Migration: `db/migrations/016_sms_consent_spine.sql`

### `sms_consents`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | PK |
| `tenant_id` | text | Tenant scope (NOT NULL) |
| `project_id` | text | Project scope (nullable = tenant-wide) |
| `phone_e164` | text | Phone number in E.164 format (NOT NULL) |
| `consent_status` | text | CHECK: `opted_in` \| `opted_out` \| `not_consented` |
| `consented_at` | timestamp | When consent was granted |
| `opted_out_at` | timestamp | When consent was revoked |
| `wording_version` | text | The canonical wording version stamped at recording |
| `wording_snapshot` | text | The exact wording text shown to the user |
| `source` | text | How consent was recorded |
| `created_at` | timestamp | Row creation time |
| `updated_at` | timestamp | Last update time |

**Uniqueness:** `(tenant_id, COALESCE(project_id, ''), phone_e164)` — one
consent record per phone per tenant/project scope.

### `sms_consent_audit`

Immutable audit trail of all consent state changes.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | PK |
| `consent_id` | UUID | FK to `sms_consents` |
| `tenant_id` | text | Tenant scope |
| `project_id` | text | Project scope |
| `phone_e164` | text | Phone number |
| `action` | text | `consent_granted` \| `consent_revoked` |
| `previous_status` | text | Status before change |
| `new_status` | text | Status after change |
| `wording_version` | text | Wording version at time of action |
| `wording_snapshot` | text | Wording text at time of action |
| `source` | text | How the action was initiated |
| `actor` | text | Who/what recorded the action |
| `reason` | text | Reason for the action |
| `correlation_id` | text | Traceability correlation ID |
| `created_at` | timestamp | When the audit row was written |

## Consent service API

`engine/src/consent/service.ts`

| Function | Description |
|----------|-------------|
| `recordConsent(tenantId, phoneE164, opts?)` | Record an opt-in. Stamps canonical wording version/snapshot server-side. |
| `recordOptOut(tenantId, phoneE164, opts?)` | Record an opt-out (STOP or admin revoke). Works even if no prior consent exists. |
| `getConsentStatus(tenantId, phoneE164, projectId?)` | Returns `{ status, record }`. `not_consented` when no record exists. |
| `canSendSms(tenantId, phoneE164, projectId?)` | Returns `{ allowed, status, reason }`. Fail-closed: blocks `opted_out` and `not_consented`. |
| `handleInboundConsentMessage(tenantId, phoneE164, body, projectId?, correlationId?)` | Detects STOP keywords in inbound SMS body. Returns null for non-STOP messages. |

## Outbound enforcement

The outbound SMS queue (`engine/src/transport/twilio/outbound.ts`) calls
`canSendSms()` before every Twilio API call. Blocked messages are marked
`status='refused'` with an audit log entry and **never reach Twilio**.

**Exception:** Onboarding replies (CoreEngine status `'onboarding'`) are marked
`consent_exempt: true` at save time in the SMS ingress pipeline
(`engine/src/interfaces/sms/index.ts`). This is necessary because the safe
generic onboarding reply is how CST initially collects consent — blocking it
would deadlock. All other reply types go through the normal consent gate.

## Inbound STOP handling

When a STOP keyword is received (in
`engine/src/interfaces/sms/index.ts`):

1. The message body is checked with `isOptOutMessage()`.
2. If it matches, `recordOptOut()` is called to mark the phone as opted out.
   This works even for phones with no prior consent record (unknown callers).
3. An audit log entry is written.
4. A confirmation reply is sent (marked `consent_exempt`):
   `"You have been unsubscribed. Reply START to re-subscribe. Msg&data rates may apply."`
5. Processing stops — the message is not passed to CoreEngine.

## Admin API endpoints

All under `POST /api/v1/admin/sms-consent/*`:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/sms-consent/wording` | Returns canonical consent wording + version |
| `POST` | `/sms-consent` | Grant or revoke consent (body: tenant_id, phone_e164, action, project_id?) |
| `GET` | `/sms-consent/:phoneE164` | Look up current consent state for a phone |
| `GET` | `/sms-consent` | List all consent records (filters: tenant_id, project_id, status, search) |
| `GET` | `/sms-consent/:phoneE164/history` | Audit history for a phone |

## Admin Panel

The Admin Panel includes a dedicated **SMS Consent** tab (tab 7) that provides:
- Canonical wording display (version + text)
- Phone lookup (tenant + phone input)
- Grant / Revoke consent buttons
- Current consent state display
- Audit history per phone
- Table of all consent records (masked phone numbers)

## Test suite

- `tests/consent/consent_spine.test.ts` — 21 tests covering:
  - Canonical wording version & STOP keyword set
  - `isOptOutMessage` matching (exact + word-boundary)
  - Consent recording with server-side wording stamping
  - Tenant and project isolation
  - Outbound enforcement (`canSendSms` blocks opted_out / not_consented)
  - STOP from inbound pipeline (`handleInboundConsentMessage`)
  - Audit trail integrity
