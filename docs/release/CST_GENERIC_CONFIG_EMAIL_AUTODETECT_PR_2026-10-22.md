# Generic multi-project configuration + vFarm email self-service detection

**Branch:** `feature/generic-project-config-email-autodetect` (off `main`)
**Base:** `main` — **do not merge until the open questions below are signed off.**

## What changed

### 1. Project/tenant configuration is now fully data-driven

The two hardcoded worlds — two projects, one vFarm organization, three farms, four speakers,
one service number, one ElevenLabs voice id — were compiled into the production binary.

* `VfarmTenantAdapter.initDefaultData()` seeded **two hardcoded projects and three FABRICATED
  farm ids in production**. A tenant that had neither project still carried them, pointing at
  an organization it might not own, with invented farm scopes in the scope map (migration 015
  had already cleared those same ids from the `customers` table for exactly that reason).
* `CoreRegistry.resetToDefault()` held the matching literals.

**Now:** those values live in `engine/src/adapters/vfarm/dev_seed.ts`, explicitly labelled
**DEV / TEST FIXTURE — NOT PRODUCTION CONFIGURATION**. The adapter seeds from it only when
`seedDemoDirectory` is on (default `NODE_ENV !== 'production'`); the registry seeds from it
only in a test runner or when the database is empty and not production.

Production tenancy comes from the database (`CoreRegistry.initFromDb()`) and, optionally, from
live vFarm discovery. **No new endpoint was invented** — live discovery already existed and
was verified against the live contract:

| Capability | Endpoint | Status |
|---|---|---|
| vFarm org → CST project | `GET /api/v1/organizations` | already implemented (`pullProjects()`) |
| vFarm farm → CST resource scope | `GET /api/v1/farms?org_id=` | already implemented (`pullResourceScopes()`) |

Adding a tenant + project end-to-end now requires only admin API calls or DB rows — no source
edit. Covered by `tests/adapters/generic_project_config.test.ts`.

### 2. Email-based vFarm self-service detection (feature flag, default OFF)

**The upstream constraint, verified against the LIVE vFarm OpenAPI contract (171 paths):**
`phone`, `e164`, `msisdn`, `mobile`, `whatsapp`, `sms_number` and `telephone` occur **zero
times in the entire specification**. `GET /api/v1/organizations/{org_id}/users` returns
`user_id`, `email`, `name`, `role`, `granted_by`, `granted_at` — **no phone field**.

So "look this phone number up against vFarm" is **not implementable today**. The only
correlation CST can make is the one a person can make: the person confirms the email address
on their vFarm account, and CST matches it against that organization's member list.

The flow (`engine/src/identity/email_verification.ts`, wired into **SMS only**):

1. An unknown number messages CST → CST asks for the vFarm account email.
2. Their next message is checked for exactly one email address.
3. That address is matched (case-insensitively) against the org member list.
4. On a match CST creates the phone → `user_id` binding with the **upstream** role, invalidates
   the speaker cache, and the caller is recognised from their **next** message.

**Safety properties**

* **OFF by default** (`CST_EMAIL_VERIFICATION_ENABLED=true` to enable).
* It creates a **binding only**. The role comes from the upstream member record and the farm
  scope is re-read from the upstream grant list by the existing fail-closed resolve path — a
  self-verified caller is never pre-authorised by this flow.
* No client-supplied farm id, project id or role is trusted.
* The member lookup is the **same** authenticated, read-only endpoint CST already uses for the
  authoritative membership check.
* **No enumeration**: an unknown address and an address that is not a member produce the *same*
  reply, so the flow cannot be used to discover an organization's member list.
* **Bounded**: at most 3 attempts per number per project per tenant, expiring after 15 minutes.
* An **unreadable upstream is not a failed verification**: it is not counted as an attempt and
  does not tell the customer their address was rejected.
* Voice is **deliberately excluded** — asking a caller to speak an email address is poor UX, and
  the same person can verify over SMS and be recognised on their next call.

Covered by `tests/identity/email_verification.test.ts` (17 tests).

### 3. Supporting change

* `DbClient.upsertCustomer()` — one persistence path for the CST-owned phone → identity
  binding, shared by the admin route and the verification flow.
* `VfarmTenantAdapter.findOrgMemberByEmail()` — a read-only wrapper over the confirmed
  org-members endpoint. No new endpoint, no new field.

## Open questions — reviewer sign-off required

1. **Where should the "awaiting email verification" state live?** It is an in-memory, TTL-bounded
   map. A restart forgets a pending verification (the person replies again); a durable table
   would survive restarts and let an operator see who is stuck, at the cost of a migration.
   *Recommendation: a table, if the flow is going to be enabled.*
2. **Rate limiting / abuse.** Currently per (number, tenant, project). Should there also be a
   per-IP or per-organization limit? A single caller can currently make 3 member-list reads.
   The member-list read itself is authenticated and bounded, so the abuse surface is small, but
   the limit is a policy choice.
3. **Scope.** SMS only today. Should web be included? Voice is recommended against, but a
   product owner may want a spoken fallback.
4. **Which identity does the email prove?** The flow binds the number to the upstream user id,
   but it does not prove the person texting owns that vFarm account — anyone who knows an
   address could claim it. The current limit is that the address must belong to a member of the
   *same vFarm organization the project is bound to*. Is that sufficient, or is a second factor
   (a code sent to the email, or a one-time code to the phone) required before this is enabled?
   **This is the question I would most want answered before enabling the flag.**
5. **Does the email disclosure itself need consent?** The flow asks the caller to send their
   account email over SMS, where it is stored in the transcript. That may need a privacy
   note and a retention rule.

## Verification

| Check | Result |
|---|---|
| `npx vitest run` | **88 files · 908 passed · 6 skipped · 0 failed** |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `git diff --check` | clean |

Existing coverage was not reduced. The identity-resolution timeout/parallelisation fixes
(`SPEAKER_RESOLVE_TIMEOUT_MS`, the parallel org-members/farm-grants call) and the
`VOICE_TURN_TIMEOUT_MS` wrapper in `interfaces/voice/index.ts` are untouched.

## Not done in this PR

* No production deploy, no change to production configuration.
* No change to `Project`, `Tenant`, `ServiceNumberBinding` or `CapabilityType` — they already
  model multi-project and multi-capability correctly.
* No vFarm endpoint or field was invented.
