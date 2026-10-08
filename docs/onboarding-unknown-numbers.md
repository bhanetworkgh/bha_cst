# Onboarding Unknown Phone Numbers to CST

## Overview

CST does **not** have its own user registration system. Identity for every
caller is resolved through **vFarm** — the vFarm org member directory is the
single source of truth for speakers. This document explains how to register
a phone number that CST currently treats as unknown.

This document also references the **SMS Consent Spine** — a separate
opt-in/opt-out mechanism for SMS that is distinct from vFarm identity and
farm authorization. See [docs/sms-consent-spine.md](sms-consent-spine.md)
for the full consent documentation.

## Why CST can't register users directly

Identity resolution lives in **`engine/src/identity/resolver.ts`**. The
resolver takes an inbound phone number (`phone_e164`) and looks it up in the
vFarm org member directory via the vFarm adapter
(`engine/src/adapters/vfarm/live_client.ts`).

This invariant is pinned by the test suite:

- `tests/identity/runtime_identity_model.test.ts`
  - *"the unscoped customers-table fallback cannot authorize farm scope"*
  - *"no runtime code resolves a farm/unit from VFARM_DEFAULT_FARM_ID or VFARM_DEFAULT_UNIT_ID"*
  - *"outbound transport does not select a sending number from the systems registry"*

## Step-by-step: register a new caller

### 1. Add the person in vFarm

1. Sign in to the vFarm admin panel for the tenant
   (e.g. `https://bhavfarm1.duckdns.org`).
2. Navigate to **Organization → Members**.
3. Add a new member with:
   - **Phone number** — E.164 format (e.g. `+15551234567`)
   - **Role** — one of `owner`, `manager`, or `tech`
   - **Farm assignments** — which farms the person belongs to
   - **Unit context** — the specific unit(s) they can query or control
   - **person_id / customer_ref** — the internal vFarm identifier CST will use

### 2. Wait for CST's adapter sync

CST's vFarm adapter fetches the org member list from
`GET /api/v1/orgs/{org_id}/members`. This happens:

- On CST process startup
- Periodically (configured via the adapter's polling interval)
- On-demand when an unknown caller texts (the adapter retries the lookup)

No restart of CST is required in most cases, but you can force a fresh sync by
checking `engine/src/adapters/vfarm/live_client.ts` for the sync interval.

### 3. Verify the caller is now known

After the sync completes, the caller should receive the appropriate response
instead of the onboarding message:

- **Known + authorized** → can query unit status, get knowledge answers
- **Known but unauthorized role** (e.g. `tech` trying equipment control) →
  receives a "Role 'tech' is not authorized" reply
- **Still unknown** → receives the onboarding welcome message

Test this locally:

```bash
npm test -- tests/identity/identity_roles.test.ts
```

## What an unknown caller currently receives

When CST receives an SMS from a number not in the vFarm directory, the
flow is:

```
Twilio webhook
  → engine/src/transport/twilio/inbound.ts (normalize)
  → CoreEngine.processEnvelope()
  → engine/src/identity/resolver.ts (resolve speaker)
  → IdentityContext.is_known_customer === false
  → IntentRouter.routeAndHandle()
  → returns safe onboarding reply:
    "Welcome to vFarm Support. If you're a team member,
     please register your phone number in the vFarm admin panel
     so we can verify your role and farm scope."
```

This is verified by:
```
tests/authorization/authorization_stepup.test.ts
  → "returns safe onboarding reply when unknown user attempts an account or device action"
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Caller still gets onboarding after vFarm add | Wait for adapter sync (check sync interval in `live_client.ts`) |
| Caller resolves but can't access farm data | Verify farm assignments in vFarm — `farm_ids` must be non-empty |
| Caller gets "refused" or "step-up required" | Their role doesn't grant the required permission — adjust in vFarm |
| Caller's farm/unit shows empty | Verify `unit_context` is set in vFarm for the person's farm |

## Related files

| Purpose | File |
|---|---|
| Identity resolution | `engine/src/identity/resolver.ts` |
| vFarm adapter (member sync) | `engine/src/adapters/vfarm/live_client.ts` |
| Inbound Twilio webhook | `engine/src/transport/twilio/inbound.ts` |
| Route handling | `engine/src/router/index.ts` |
| Authorization logic | `engine/src/identity/stepup.ts` |
| Test helper for seeded customers | `tests/helpers/seed_customers.ts` |

## SMS Consent (separate from identity)

Even after a phone number is registered in vFarm and recognized by CST, the
phone may not consent to receiving SMS. The consent spine is a **separate**
path:

```
phone → CST SMS consent      → opted_in / opted_out / not_consented  (consent spine)
phone → vFarm person_id       → farm grants → farm authorization     (identity resolver)
```

- A phone can be a valid vFarm member (authorized) but **not** consented —
  outbound SMS to this phone is blocked.
- A phone can be consenting but **unknown** in vFarm — it may still receive
  the safe generic onboarding reply (which is how CST collects consent).

See [docs/sms-consent-spine.md](sms-consent-spine.md) for details on:
- The canonical consent wording (`cst_sms_consent_v1`)
- STOP keyword handling (Twilio canonical set)
- Consent API endpoints (`POST/GET /api/v1/admin/sms-consent/*`)
- Consent enforcement in the outbound SMS path
- Admin Panel consent management
