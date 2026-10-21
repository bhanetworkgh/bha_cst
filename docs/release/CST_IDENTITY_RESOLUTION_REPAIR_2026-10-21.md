# CST — vFarm Identity Resolution: Root Cause and Operator Repair Procedure

**Date:** 2026-10-21
**Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`) — `https://bha-cst-7u9e.onrender.com`
**Live release at the time of writing:** `a646c4514254179c0c04ec3aa1bbdc7b383a696f`
**Status of the CST-side fix: LOCAL ONLY — not deployed.**

---

## 1. Root cause

**A registered vFarm customer is refused farm data because the customer reference CST stores is a
PHONE NUMBER instead of the vFarm user id, so the live membership check can never match it.**

The authoritative chain is:

```
inbound call/SMS
  -> service_number_binding            -> tenant + project
  -> CoreRegistry.resolveSpeaker        -> vFarm tenant adapter
  -> adapter.resolveSpeaker             -> GET /api/v1/organizations/{org}/users   (MEMBERSHIP = authority)
                                     -> GET /api/v1/users/{user_id}/farm-grants   (SCOPE = authority)
  -> role + farm_ids
```

The adapter matches the caller by comparing the locally stored reference
(`customers.customer_ref`, restored as the speaker's `person_id`) against the upstream member's
`user_id`, `email` and `name`. When no member matches, the adapter returns `opaque_revoked` —
fail closed, no role, no farm scope — and the caller is served the generic onboarding reply.

**The evidence, in order:**

1. **The upstream is healthy and correctly configured.** A read-only probe of the configured vFarm
   organization (using CST's own credentials and header combination) returned **HTTP 200 with 2
   organization members**, both with role `admin`, both with **UUID** `user_id` values. Their
   farm-grant lists returned **1 and 2 grants** respectively, all with **UUID** farm ids.
   *(Read-only probe; no identifier, email, name, grant or phone number was printed or stored.)*
2. **The upstream mapping is therefore correct**: an upstream `admin` maps to the CST role `owner`
   (`mapVfarmOrgRoleToCstRole`), and a member with 2 grants produces exactly the **two farm scopes**
   the production customer record already carries.
3. **The local reference cannot match.** `customers.customer_ref` is documented in the schema as
   *"Opaque ID from the owning system (vFarm)"*, but the row seeded by
   `db/migrations/006_seed_initial_customers.sql` stores a **phone number** there. Migration 015
   already established the rule this breaks — *"Real vFarm identifiers are UUIDs … any value on this
   column that is not a UUID is fabricated seed data"* — and it cleared the fabricated `unit_id` and
   `farm_id` columns, but `customer_ref` was left as a phone number.
4. **The production log confirms the branch.** The identity path logged `opaque_revoked`, `role:
   unknown`, `farm_ids: []` while the customer record itself was complete (owner role,
   organization/project mapping, two farm scopes, future speaker-cache expiry). That is exactly what
   a non-matching reference produces.
5. **The failing branch was completely silent.** The `!upstream` branch returned `opaque_revoked`
   **with no log statement at all**, which is why the logs could not distinguish "vFarm denied this
   caller" from "the reference identifies no member" from "the project points at the wrong
   organization". All three are different problems with different fixes.

**Why CST cannot derive the mapping automatically:** vFarm exposes **no phone field on a user**
(confirmed across the whole OpenAPI spec). The phone → vFarm user id binding is therefore CST-owned
and can only be established by an operator who knows both values.

---

## 2. What was fixed in CST (local only)

| Change | File | Why |
|---|---|---|
| The refusal branch now **logs a redacted classification** — `upstream_organization_has_no_members` (a mapping problem) vs `local_reference_matches_no_member` (a customer-record problem) — plus the member count. No identifier, email, name or phone number is logged. | `engine/src/adapters/vfarm/index.ts` | The failure was undiagnosable from the logs. |
| The upstream member id comparison is **normalised** (trim + case) like the email and name comparisons already were. | `engine/src/adapters/vfarm/index.ts` | An exact, untrimmed, case-sensitive id comparison could silently fail to match. It can only ever select the *same* upstream record. |
| The admin speaker sync now distinguishes its two deactivation outcomes: a genuinely revoked vFarm user is **removed**; a row whose reference is a **phone number** (i.e. never a vFarm id) is **deactivated, not deleted**, and reported separately as `deactivated`. | `engine/src/admin/routes.ts` | The sync used to hard-DELETE any row it could not confirm upstream — including the phone-shaped reference that an operator has to repair. vFarm cannot supply that mapping, so deleting the row destroyed the only record of which customer the number belongs. |
| New `DbClient.expireCustomer()` deactivates a binding without destroying it, using the repository's existing "not active" mechanism. | `engine/src/db/client.ts` | Backs the change above. |
| The voice **inbound webhook** now treats a degraded identity lookup as a service failure (503) instead of admitting the caller as a guest. | `engine/src/interfaces/voice/index.ts` | The voice *turn* path already did this; the inbound path did not, so the same failure produced two different answers depending on the entry point. A registered customer was being greeted with the generic onboarding text because the upstream was briefly unavailable. |

**Authorization is unchanged and still fail-closed.** A degraded lookup still yields `is_known: false`,
`role: 'unknown'`, `permissions: []`, `farm_ids: []`; the only thing that changes is the honest reason
the customer is given. No default role, wildcard farm scope, fallback tenant or unrestricted farm
lookup was introduced, and no upstream check was skipped or softened.

---

## 3. Operator repair procedure

The mapping has to be entered once per customer, because vFarm cannot supply it. **No production
write has been performed and no migration is required.**

### 3.1 Find the affected rows (read-only)

```sql
-- Customer rows whose reference is not a vFarm identifier.
-- vFarm identifiers are UUIDs; a phone number here is the defect.
SELECT phone_e164, customer_ref, role, project_id, tenant_id, farm_ids
  FROM customers
 WHERE customer_ref ~ '^\+?[0-9]{7,}$';
```

### 3.2 Identify the caller's vFarm user id (read-only)

For each affected customer, look the person up in the vFarm organization member list. The
authoritative source is the same endpoint CST already calls for the membership check:

```
GET /api/v1/organizations/{VFARM_TENANT_ORG_ID}/users
```

Match the member by **email or name** — vFarm has no phone field, so the customer record's email or
the name on the account is the only correlation available. Verify the member's `role` is `admin`
(→ CST role `owner`) and read their farm grants:

```
GET /api/v1/users/{user_id}/farm-grants
```

### 3.3 Write the mapping (the one write)

```
POST /api/v1/admin/speakers
x-admin-token: <admin session token>
Content-Type: application/json

{
  "phone_e164":   "<the customer's number>",
  "customer_ref": "<the vFarm user id from 3.2>",
  "tenant_id":    "tenant-vfarm-01",
  "project_id":   "proj-vfarm-main",
  "role":         "owner",
  "farm_ids":     ["<farm id>", "<farm id>"],
  "ttl_hours":    24
}
```

`customer_ref` **must be the vFarm user id**, not the phone number. The endpoint upserts the row and
refreshes the speaker-cache expiry.

> `role` and `farm_ids` in this request are CST's **projection** only. The authoritative role and
> farm scope are re-read from vFarm at resolve time, so a wrong projection cannot grant access.

### 3.4 Verify

1. Place a voice call or send an SMS from the customer's number to the CST receiving number.
2. In the production log the identity line should now read `Resolved identity for … via tenant
   adapter (… role=owner)` instead of `opaque_revoked_…`.
3. `GET /api/v1/admin/speakers?tenant_id=tenant-vfarm-01` should report
   `identity_resolution: "bound"` for that number.
4. The customer should receive the farm-scoped answer instead of the generic onboarding reply.

### 3.5 Do NOT run the speaker sync before step 3.3

`POST /api/v1/admin/speakers/sync` is now safe for phone-shaped references (it deactivates rather
than deletes them), but it will still **remove** rows whose reference is a real vFarm id that the
upstream no longer lists. Repair the references first, then sync.

---

## 4. What is still external

* **The phone → vFarm user id mapping is an operator action** and cannot be automated: vFarm
  exposes no phone field on a user, so there is no upstream correlation for CST to use.
* **The user-to-location/device association is a separate, still-absent vFarm contract.** A valid
  identity with no device/location data is now reported as a *known identity with an empty scope* —
  distinct from an identity failure — but CST still cannot name a device, a zone or a live unit.
  Owner: the vFarm team. The contract must define the user identity, the farm, the
  zone/location/device, the effective authorisation, and the mapping lifecycle.
* **The live vFarm organisation mapping must be validated for the project actually serving the
  call.** The new log classification distinguishes "the organization has no members" (a mapping
  problem) from "the reference matches no member" (a record problem) — whichever appears in the
  production log identifies the fix.

---

## 5. Verification

| Check | Command | Result |
|---|---|---|
| Identity/authorization regression suite | `npx vitest run tests/identity/identity_resolution_authorization.test.ts` | **17 passed** |
| Admin sync deactivation suite | `npx vitest run tests/admin/admin_sync_deactivation.test.ts` | **2 passed** |
| Full suite | `npx vitest run` | **86 files · 886 passed · 6 skipped · 0 failed** |
| Typecheck | `npm run typecheck` | clean |
| Production build | `npm run build` | clean |
| Diff whitespace | `git diff --check` | clean |

**Pre-existing failures:** none at the start of this work. One intermittent failure was observed
once during a full-suite run (`voice_guest_access_regression.test.ts` expecting 403 and receiving
404 on the voice turn webhook). It is **not reproducible in isolation** (31/31 pass) and two
consecutive full runs immediately afterwards were green. It matches the repository's documented
load-dependent intermittent failures and is **not** attributable to these changes — they touch the
adapter's diagnostics, the admin sync's deactivation outcomes, a new DB method, and the voice
inbound degraded branch; none affects signature validation or route matching.
