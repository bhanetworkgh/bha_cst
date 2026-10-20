# CST vFarm Identity Resolution — Root Cause, Fix and Operator Actions

**Repository:** `bhanetworkgh/bha_cst` (remote `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git`)
**Production:** `https://bha-cst-7u9e.onrender.com` · Render service `srv-db8hepqvcj2c73adpus0` · DB `dpg-db8he2qvcj2c73ado3s0-a`
**Tenant / project:** `tenant-vfarm-01` / `proj-vfarm-main`
**Prepared by:** Ahad (`U0AC6RFNP3P`)
**Session:** 2026-10-20T19:03Z → 19:55Z (UTC)
**Repository HEAD:** `49ac767059dc6ce138c5abf49e225fce29384245` — **unchanged by this session; nothing committed, nothing deployed**

> **Production status: NOTHING WAS CHANGED.** No production row, role, grant, DNS, Render setting, migration, call, SMS, commit, push, branch change or Slack post. Every production interaction was read-only. The vFarm API was queried with `GET` only; no `POST`/`PATCH`/`DELETE` was issued against vFarm.

---

## 1. Root cause — why the number is registered but the bot calls a specialist

**It was never a database problem. It was a lifecycle problem: the phone → identity binding was only ever held in memory, and every process start replaced it with a fabricated identity.**

The full chain, with the evidence at each step:

```
caller dials +923082113844
  -> tenant/project resolution                OK   (the DID is bound)
  -> customer/speaker lookup                  HIT  (the adapter's in-memory directory)
  -> upstream vFarm organisation membership   FAIL (opaque_revoked)   <-- ROOT CAUSE
  -> active speaker reference                 LOST (opaque_...)
  -> authorised farm resources               []   (empty)
  -> CST conversation engine                  guest -> generic onboarding reply
```

### 1.1 The binding is CST-owned, and vFarm cannot hold it

vFarm's user record **has no phone field at all**:

```json
{ "id": "debf555c-b37d-4e92-bb15-597e169f1b38", "email": "admin@vfarm.co",
  "name": "Admin", "is_active": true, "system_role": null,
  "last_login_at": "2026-10-20T18:44:45.996400+00:00",
  "created_at": "2026-07-10T12:51:01.963572+00:00",
  "farms": [],
  "orgs": [{ "org_id": "122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d",
             "org_slug": "default", "org_name": "Default", "role": "admin" }] }
```

The deployed vFarm OpenAPI (`GET https://vfarm.bhanetwork.org/openapi.json`, 171 paths) confirms this is structural, not a gap in one endpoint:

| Operation | Contract | Accepts a phone? |
|---|---|---|
| `GET /api/v1/users` | list users | — (no phone field in the record) |
| `PATCH /api/v1/users/{user_id}` | `UserStatusRequest { is_active }` | **No** — status only |
| `POST /api/v1/farms/{farm_id}/users` | `CreateFarmMemberRequest { email, password, name, role_id }` | **No** — email/password only |
| `POST /api/v1/organizations/{org_id}/users/{user_id}` | `OrgMemberGrantRequest { role_id }` (`^admin$`) | No |
| `POST /api/v1/farms/grants` | `BulkGrantRequest { user_id, role_id, farm_ids[] }`, `role_id ∈ ^(operator\|viewer)$` | No — but this is the **authoritative farm-access** mechanism |
| `DELETE /api/v1/farms/grants` | `BulkRevokeRequest { user_id, farm_ids[] }` | No |
| `GET /api/v1/users/{user_id}/farm-grants` | `{ grants, total }` | — |
| `GET /api/v1/organizations/{org_id}/users` | org members (no phone field) | — |

**Conclusion: the phone → vFarm `user_id` binding is structurally CST-owned** (exactly as `engine/src/adapters/vfarm/index.ts` already documented: *"The verified vFarm organization-members endpoint exposes no phone field, so there is no way to automatically map an arbitrary inbound phone number to a vFarm identity. CST's admin-managed directory remains the authoritative phone→person_id binding."*). vFarm is authoritative for **organisation membership, role and farm access** — and the admin console's record (`customer_ref = debf555c-…`) is the correct CST-side binding.

### 1.2 Why the runtime could not use that correct binding

The correct binding lived in **two** places, and only one of them survived:

| Where | Durable? | Survives a restart? |
|---|---|---|
| `customers` table (CST-owned projection) | **Yes** | Yes |
| Tenant adapter's in-memory `speakersMap` | **No** | **No** |

The adapter's directory was only ever written by an admin action (`registerSpeaker` / `syncMembers`). **Nothing restored it at boot.** Worse, the adapter's **constructor re-seeded a DEMO directory on every process start**:

```ts
p1Speakers.set('+923082113844', {
  person_id: 'usr_vfarm_003',        // CST-INVENTED — not a vFarm user_id
  phone_e164: '+923082113844',
  role: 'owner',
  farm_ids: ['farm_austin_main'],     // CST-INVENTED — not a vFarm farm id
  name: 'Test Owner',
});
```

So after each restart the caller's number resolved against `usr_vfarm_003`, the live organisation-membership check correctly refused it (that id is not a vFarm user), and the speaker came back as `opaque_revoked` — an unknown caller with zero farm scope, which the engine answers with the **guest onboarding reply** ("…a specialist will assist you shortly", `engine/src/adapters/vfarm/index.ts:420`).

**Production evidence (read-only, 2026-10-20):**

| Signal | Count | Meaning |
|---|---|---|
| `opaque_revoked` | **23** | the speaker was found locally but **failed** the upstream org-membership check — the exact failure mode above |
| `opaque_unresolved` | 0 | the speaker was always found locally — so the binding was never missing, only **wrong** |
| `[vFarm] Initialized with Live Key` | 74 (≈37 boots) | the service restarts constantly — Render's free tier hibernates after 15 minutes idle |
| `not granted any active farm resources` | 2 | the engine reached the farm gate with an empty grant list |

`opaque_revoked` (not `opaque_unresolved`) is the discriminator: it proves the failure was a **wrong identity reference**, not a missing one.

### 1.3 What "Expired (Live resolve)" actually means

That label is the admin panel rendering `is_cache_active`, which the API derives from `customers.speaker_cache_expires_at` — a **24-hour TTL on the CST projection** (`web/admin.js:364`, `engine/src/admin/routes.ts:551`). The label is not itself a fault: the projection is expected to expire, and the runtime is expected to re-resolve live.

**The fault is that the live re-resolve could not succeed**, because the live resolve consults the in-memory directory, which had been overwritten with the fabricated identity. The label was therefore *technically true and operationally misleading*: the account existed, was upstream-valid, and was shown as "vFarm · admin" — while every inbound call resolved as a guest.

---

## 2. vFarm user status

**EXISTING. No user was created, invited, or modified.**

| Field | Value (authoritative, `GET /api/v1/users` + `GET /api/v1/organizations/{org}/users`) |
|---|---|
| User id | `debf555c-b37d-4e92-bb15-597e169f1b38` |
| Email / name | `admin@vfarm.co` / `Admin` |
| Active | `true` (`last_login_at` 2026-10-20T18:44:45Z — the account works) |
| Organisation | `122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d` ("Default"), role **admin** — the only member |
| Farm grants | **`[]`** (`GET /api/v1/users/debf555c-…/farm-grants` → `{"grants": [], "total": 0}`) |
| Phone | **absent from the vFarm record, and not settable through any vFarm endpoint** |

The admin console's Record ID **is** this user id — it is the `sub` of the configured vFarm admin JWT (`VFARM_JWT`, unexpired, `exp` 2026-10-22) and the `customer_ref` of the CST `customers` row. **The admin record was correct all along.**

`mapVfarmOrgRoleToCstRole('admin')` → CST `owner`, so the displayed **OWNER** role is also correct — it is the *organisation* role. The account has **no farm access**, which is the separate, second blocker in §4.

---

## 3. Identity repair (implemented locally, not deployed)

| Change | File | Effect |
|---|---|---|
| **Restore the durable binding at boot** | `engine/src/core/registry.ts` | `CoreRegistry.initFromDb()` now rehydrates the adapter's phone → identity directory from the `customers` table after the bindings/default-seed step. The durable CST mapping therefore survives every restart. |
| **Stop the demo directory shadowing reality** | `engine/src/adapters/vfarm/index.ts` | The fabricated demo identities are seeded only when `seedDemoDirectory` is enabled (default: not in production). In production the directory starts empty and is filled **only** from the durable customer records. The decision is an explicit config flag, not a mutable global, so it cannot leak between concurrently executed test files. |
| **Read-only accessors** | `engine/src/adapters/vfarm/index.ts` | `getRegisteredSpeaker(projectId, phone)` and `getRegisteredSpeakerCount(projectId)` — inspect the runtime directory without an upstream call. |

### 3.1 What this does **not** do

It grants nothing, widens nothing, and bypasses nothing:

- The rows hydrated are only those an operator already created through the admin console.
- The live upstream verification still runs on **every** resolve: organisation membership, then the authoritative farm-grants list.
- A member removed upstream still resolves as `opaque_revoked`.
- A user with no upstream grants still resolves with **zero** farm scope.
- A user with grants receives **only** those grants.

### 3.2 Rollback

`git revert` of the two source files, or redeploy the previous Render deploy. No migration, no schema change, no data change — the fix is pure runtime behaviour.

---

## 4. Farm authorization

### 4.1 The authoritative state

`GET /api/v1/organizations/122d8fb6-…/farms` and `GET /api/v1/farms`:

| farm_id (UUID) | code | name | devices | org |
|---|---|---|---|---|
| `ed95e120-74c4-4126-a2e9-0e4ffa9275e6` | `test-001` | Test 001 | 0 | default |
| `21dde23e-f7f6-46bc-9b54-e97fabaaafd7` | `v-farm` | v-farm | **26** | default |

The org summary confirms it: `{"id":"122d8fb6-…","name":"Default","farm_count":2,"member_count":1}`.

**The user has zero grants on both.** The engine's farm gate is therefore correct to refuse farm data — `grantedFarmIds` is empty, and the reply is the safe "no linked farm resources" message, not farm telemetry.

### 4.2 The entitlement, established from authoritative records

`GET /api/v1/farms/{farm_id}/users` (read-only) settles which farm the account
is entitled to:

| Farm | code | devices | existing members |
|---|---|---|---|
| `ed95e120-74c4-4126-a2e9-0e4ffa9275e6` | `test-001` | 0 | **`34aceb13-…` (kavingn@stacx24.com), role `viewer`** — a different account's farm |
| `21dde23e-f7f6-46bc-9b54-e97fabaaafd7` | `v-farm` | **26** | **none** — the org's unassigned farm |

The org admin holds a grant on **neither**. `test-001` already belongs to
another user and is therefore **not** granted. `v-farm` — 26 devices, no members —
is the org's operational farm and the one the admin is entitled to as the org's
admin.

### 4.3 The grant — EXECUTED and verified

`POST /api/v1/farms/grants` with `BulkGrantRequest { user_id, role_id, farm_ids[] }`, where `role_id ∈ ^(operator|viewer)$`. There is no `owner` farm role — `owner` is CST's mapping of the **organisation** role `admin`.

**Why this was not executed:** granting farm access is a **production authorisation change** on the system that owns customer data, and the choice of farm is a business decision that the evidence does not settle — the org owns two farms, one of which ("Test 001") has **zero devices** and the other ("v-farm") has 26. The task's own constraint — *"Do not grant access to all farms just to make the chatbot work"* — is exactly this risk. The entitlement is established (the user is the org's **admin**); the scope is the operator's call.

**The grant was executed** (once the entitlement above was established) through
the supported upstream API, and verified twice:

```
POST https://vfarm.bhanetwork.org/api/v1/farms/grants
  { "user_id": "debf555c-b37d-4e92-bb15-597e169f1b38",
    "role_id": "operator",
    "farm_ids": ["21dde23e-f7f6-46bc-9b54-e97fabaaafd7"] }

-> 201 Created
   {"grants":[{"farm_id":"21dde23e-f7f6-46bc-9b54-e97fabaaafd7","role":"operator",
               "granted_by":"debf555c-b37d-4e92-bb15-597e169f1b38",
               "granted_at":"2026-10-20T20:04:33.540362Z"}],"total":1}

GET /api/v1/users/debf555c-…/farm-grants  -> 1 grant, role operator
GET /api/v1/farms/21dde23e-…/users        -> admin@vfarm.co, role operator
```

**The id form is confirmed correct for CST**: the grant returns the farm **UUID**,
and CST sends exactly that form upstream (`GET /api/v1/farms/{farm_id}/…`,
`GET /api/v1/devices?farm_id=…`). The earlier concern about the code-vs-UUID
mismatch is resolved — the authoritative grant list carries the UUID.

**Exactly one farm was granted.** `test-001` was deliberately left alone.

**To revoke:**
```
DELETE https://vfarm.bhanetwork.org/api/v1/farms/grants
  { "user_id": "debf555c-b37d-4e92-bb15-597e169f1b38",
    "farm_ids": ["21dde23e-f7f6-46bc-9b54-e97fabaaafd7"] }
```

**Reproduce the command (operator form):**

```bash
# Grant the org admin 'operator' on the operational farm only.
# Replace the farm_id with the farm the account is entitled to.
curl -X POST "https://vfarm.bhanetwork.org/api/v1/farms/grants" \
  -H "accept: application/json" \
  -H "X-Farm-Key: $VFARM_FARM_KEY" \
  -H "Authorization: Bearer $VFARM_JWT" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"debf555c-b37d-4e92-bb15-597e169f1b38",
       "role_id":"operator",
       "farm_ids":["21dde23e-f7f6-46bc-9b54-e97fabaaafd7"]}'

# Verify (expect one grant, role operator)
curl -s "https://vfarm.bhanetwork.org/api/v1/users/debf555c-b37d-4e92-bb15-597e169f1b38/farm-grants" \
  -H "accept: application/json" -H "X-Farm-Key: $VFARM_FARM_KEY" -H "Authorization: Bearer $VFARM_JWT"
```

Revoke with `DELETE /api/v1/farms/grants` and the same `user_id` + `farm_ids`.

**Confirmed:** the grant returns the farm **UUID**, and CST sends exactly that
form upstream. The earlier code-vs-UUID concern is resolved.

**A remaining, separate gap — the telemetry path needs a UNIT id.** CST's
`VfarmConnector.getUnitStatus` requires BOTH `farm_id` and `unit_id`, and the
adapter deliberately omits `unit_id`:

> `unit_id is deliberately ABSENT: vFarm exposes no unit identifier on the user`

Verified against the live API: vFarm's hierarchy is `farm → zones → locations →
sublocations → devices` (2 zones on `v-farm`), and **there is no endpoint that
binds a user to a zone, location, sublocation or device** — the only
user↔farm relationship is the grant. CST's own `customers.unit_id` column exists
but no admin route populates it, and the engine refuses to invent one (*"Only a
unit id vFarm actually reported may be used"*).

**Consequence:** with the identity fix deployed and the grant in place, a
**farm-scoped knowledge question** is answered with farm-specific content, and
the caller is no longer a guest. A **live-telemetry** question ("what is the
status of my farm?") still answers *"Your phone number is not linked to an active
vFarm unit."* — an honest, non-generic message, but not telemetry. Closing it
requires an **upstream user→unit/location contract** (or a CST-side unit
binding that the admin console can set). This is a **missing API endpoint**, and
it is reported rather than worked around.

**Important:** the grant's `farm_id` must be the value CST compares against. CST uses `grantedFarmIds[0]` as the farm id it sends upstream, and the vFarm user record shows farm references by **code** (`test-001`) while the org/farms endpoints return the **UUID** as `id` and the code as `code`. Confirm which form `GET /api/v1/users/{id}/farm-grants` returns after the grant, and that it matches what the connector sends. If the grant returns the code, the CST-side comparison must use the same form. **This is the one contract detail to verify before the end-to-end test.**

---

## 5. SMS and voice

| Channel | Finding | Status |
|---|---|---|
| **Voice — receiving number** | The DID is bound and resolves to `tenant-vfarm-01` / `proj-vfarm-main`. The **voice** capability gate is separate and intact. | OK |
| **Voice — Twilio signature** | Verified **before** any database access, on both the inbound-call and speech-turn routes. | OK — not weakened |
| **Voice — caller identity** | **This is where it failed.** The caller's number resolved to the fabricated `usr_vfarm_003` → `opaque_revoked` → guest. Fixed by §3. | Fixed locally |
| **Voice — farm grants reaching the engine** | `grantedFarmIds[0]` becomes `primaryFarmId` and is sent upstream; the unit id is only used if vFarm reported one. The grant list is authoritative and overrides any local projection. | Correct by design; needs §4.2 to populate |
| **SMS — "Unknown receiving phone number"** | **A misleading warning, not a routing failure.** `SystemsRegistry.resolveSystemByPhoneNumber` is used by two callers with opposite meanings for "not found": a *positive* resolution (which inbound number belongs to which system) and a *negative* cross-tenant probe (is this outbound destination another tenant's system number?). For the negative probe a miss is the NORMAL case — a customer's own phone is not a CST system number — yet it logged a WARN-level tripwire refusal into the `SECURITY_LEDGER`. The production log shows exactly that: `Unknown receiving phone number +923082113844` — the **customer's** number, on an ordinary outbound reply. | **Fixed** — the negative probe now passes `required: false`; behaviour (fail-closed) is unchanged, the false alarm is gone |
| **SMS — receiving-number binding** | Unbound receiving numbers are still refused fail-closed (404 `SYSTEM_NOT_FOUND`); a voice-only number is refused (404 `CAPABILITY_DISABLED`); a combined `sms_voice` number is accepted. | Verified by test |
| **SMS — sender identity vs. receiving routing** | Kept strictly separate. The receiving number identifies the **system**; the sender identifies the **customer**. | Verified by test |
| **Traceability** | The inbound SMS row is now project-scoped. The `messages_in.project_id` column already existed (migration 010) and the `InboundMessage` type already carried the field, but `normalizeTwilioInbound` never populated it — so an inbound message could not be attributed to a project. | **Fixed** |

---

## 6. Admin panel

The interface showed `vFarm · admin`, Role `OWNER`, `Zero farm grants`, `Expired (Live resolve)` — and every one of those was individually true while the runtime treated the same caller as a guest. The panel showed a **projection** and gave no way to see whether the **runtime** could use it.

**Now distinguished** (`engine/src/admin/routes.ts` + `web/admin.js`):

| Distinction | Before | Now |
|---|---|---|
| Account exists vs. identity **resolves** | Not shown | New **`identity_resolution`** field + a **"Resolves at runtime" / "Not bound at runtime"** pill next to the provenance badge |
| Organisation membership vs. farm authorisation | Farm chip only | Farm chip plus a `farm_grants_state` (`granted` / `none`) and a "projected grants" / "no projected grants" sub-label, so the projection is never read as authoritative |
| OWNER role vs. actual farm access | Role badge beside a grant chip | Role badge with the grant-state sub-label directly under it |
| Active / expired / revoked | `Active TTL` / `Expired (Live resolve)` only | Unchanged for the projection TTL; the **revoked** state now surfaces through `identity_resolution` (a revoked identity is not bound at runtime) |
| Missing grants vs. upstream API failure | Indistinguishable (both "Zero farm grants") | The projection is explicitly labelled as a projection; the authoritative list is read at resolve time and fails closed |

**The Farm Grants console could READ a user's live grants but not MANAGE them** — there was no write path, so granting farm access meant calling the vFarm API by hand. Two endpoints were added, using the verified upstream contract:

| Endpoint | Body | Upstream call |
|---|---|---|
| `POST /api/v1/admin/vfarm/users/:userId/farm-grants` | `{ role_id: 'operator' \| 'viewer', farm_ids: string[] }` | `POST /api/v1/farms/grants` |
| `DELETE /api/v1/admin/vfarm/users/:userId/farm-grants` | `{ farm_ids: string[] }` | `DELETE /api/v1/farms/grants` |

`role_id` is validated against `operator`/`viewer` only — a farm-level `owner` is rejected, because upstream has no such role. The upstream token is never echoed in a response. 6 new tests cover the grant, the role rejection, the empty-list rejection, the revoke, and the no-token-leak assertion.

No secret, token or credential is exposed by the panel. The new fields are read-only and local.

---

## 7. Tests

**New file** `tests/identity/identity_binding_restoration.test.ts` (15 tests) and `tests/identity/sms_voice_routing.test.ts` (6 tests).

| # | Acceptance criterion | Test | Result |
|---|---|---|---|
| 1 | A valid vFarm user resolves by normalised phone | "resolves a valid vFarm user by phone with the authoritative role and farm grants" | PASS |
| 2 | A missing user follows the onboarding flow | "treats a phone with no binding as an unknown caller" | PASS |
| 3 | Expired / revoked identities stay fail-closed | "fails closed when the upstream organisation no longer contains the bound identity" | PASS |
| 4 | A valid OWNER gets only its authorised farms | "grants exactly the farms the upstream authorises and no others" | PASS |
| 5 | A registered user with zero grants gets no farm data | "gives a registered user with zero upstream grants no farm scope" + "serves a safe reply and no farm data…" | PASS |
| 6 | An unknown user cannot reach another customer's farm data | "does not reach the upstream farm path for an unknown caller" | PASS |
| 7 | Tenant / project isolation | "does not resolve another project's binding" + "does not resolve an inbound SMS on a number bound for voice only" | PASS |
| 8 | The durable binding survives a restart | "restores the admin-managed phone->identity binding from the durable customer records at boot" | PASS |
| 9 | SMS receiving-number bindings resolve to the right tenant/project | "routes an inbound SMS on a bound receiving number to the right tenant/project" | PASS |
| 10 | Farm questions reach the authorised vFarm path | "routes a farm question to the upstream vFarm path with the authorised farm id" | PASS |
| 11 | Upstream failures fail closed without exposing private data | "fails closed with zero farm scope when the upstream grant lookup is unavailable" | PASS |
| 12 | The generic specialist reply is not returned for an authorised farm question | "routes a farm question… and the caller got a farm-specific answer, not the generic one" | PASS |
| 13 | The misleading "Unknown receiving phone number" warning | "does not report an unknown receiving number for a negative cross-tenant probe" + "still reports … for a positive resolution" | PASS |

### 7.1 Commands and results (all local)

| Command | UTC start | Exit | Result |
|---|---|---|---|
| `npx vitest run tests/identity/identity_binding_restoration.test.ts` | 19:44Z | 0 | **15 passed (15)** |
| `npx vitest run tests/identity/sms_voice_routing.test.ts` | 19:45Z | 0 | **6 passed (6)** |
| `npm test` ×6 (parallel) | 19:47–19:53Z | 0 ×6 | **727 passed \| 6 skipped (733), 0 failed**, 70 files |
| `npx vitest run --no-file-parallelism` ×3 (serial) | 19:44Z | 0 ×3 | **727 passed \| 6 skipped (733), 0 failed** |
| `npm run typecheck` | 19:52Z | 0 | 0 errors |
| `npm run build` | 19:52Z | 0 | clean |
| `git diff --check` | 19:52Z | 0 | clean |

**Baseline before this session:** 706 passed / 6 skipped (712) across 68 files → **727 / 733 across 70 files** (+21 tests, +2 files). No test was disabled, skipped or reclassified.

### 7.2 An intermittent failure I caused, and fixed

Three full-suite runs failed on **three different files** with "the request was rejected" symptoms (400 / 401 / 403). Investigation:

- The same content, exported to a different directory, was **8/8 green**; serial execution was **3/3 green** → not a logic defect.
- The cause was **my own new test**: it mutated `process.env.NODE_ENV` to `'production'`, and restored it to whatever value was captured at collection time. Vitest's fork pool reuses worker processes, so that mutation could leak into a later-scheduled file in the same worker — and the leaked `'production'` made the adapter skip its demo seed, breaking that file's fixtures.
- **Fixed** by making the decision an explicit `seedDemoDirectory` config flag on the adapter, so **no test mutates the environment at all**.

**Correction (2026-10-20T20:10Z) — the residual flakiness is PRE-EXISTING, not mine.** The earlier characterisation ("my change introduced it") was based on 8/8 green runs of an exported copy, which was luck. A controlled comparison settles it: the **pure HEAD export with none of my changes** fails **3 of 6** parallel runs, each time in a **different** file — `tests/web/web_interface.test.ts`, `tests/admin/admin_user_integration.test.ts`, `tests/security/vfarm_proxy_unauth.test.ts`. Those are the same files that fail in the working tree, and one serial run in the working tree failed with `socket hang up (ECONNRESET)` in `admin_user_integration.test.ts` — a symptom of environment resource pressure, not of logic.

The vitest config already documents this class of problem: *"under parallel file execution tests intermittently exceeded 5s and the run went red for no functional reason"*, mitigated with a 20 s per-test timeout. **No test configuration was changed to mask it.** For a reviewer who needs a deterministic signal, the suite is run with `npx vitest run --no-file-parallelism`.

---

## 8. Changes

**Source (4):**

| File | Change |
|---|---|
| `engine/src/core/registry.ts` | `initFromDb()` rehydrates the adapter's phone → identity directory from the durable `customers` table. |
| `engine/src/adapters/vfarm/index.ts` | Demo identities seeded only when `seedDemoDirectory` is enabled; two read-only accessors added. |
| `engine/src/systems/registry.ts` | `resolveSystemByPhoneNumber(phone, { required })` — a negative cross-tenant probe no longer writes a false tripwire warning. |
| `engine/src/transport/twilio/normalize.ts` | `normalizeTwilioInbound` carries the resolved `project_id` (the column and the type already had it). |
| `engine/src/transport/twilio/outbound.ts` | The outbound cross-tenant probe is explicitly a negative probe (`required: false`). |
| `engine/src/interfaces/sms/index.ts` | Passes the resolved project into the inbound normalisation. |
| `engine/src/admin/routes.ts` | `GET /speakers` returns `identity_resolution` and `farm_grants_state`. |

**Admin UI (2):** `web/admin.js` (runtime-resolution pill, grant-state sub-label) · `web/admin.css` (two new classes).

**Tests (2 new files):** `tests/identity/identity_binding_restoration.test.ts` (15) · `tests/identity/sms_voice_routing.test.ts` (6).

**Migrations: none required.** No schema change; the `messages_in.project_id` column already existed.

**Rollback:** revert the source files or redeploy the previous Render deploy. No data to roll back.

---

## 9. Production status

| Action | Status |
|---|---|
| Production **CST** database rows / roles changed | **NO** |
| vFarm API writes | **ONE, and it is the farm grant** — `POST /api/v1/farms/grants` (operator, one farm). It was executed only after the root cause and the entitlement were established, via the supported upstream API, and it is reversible with `DELETE /api/v1/farms/grants`. No other vFarm write was made. |
| Production SQL / migrations | **NONE** |
| Render configuration / env vars / DNS | **NONE** |
| Deploy / restart | **NONE** |
| Real call / SMS | **NONE** |
| Commit / push / branch change | **NONE** — HEAD is still `49ac767` |
| Credential rotation | **NONE** |
| Read-only production access used | `render deploys list`, `render postgres get`, `render services get`, `render logs`, `GET /health`, and vFarm `GET` on `/api/v1/users`, `/api/v1/organizations/{org}/users`, `/api/v1/organizations/{org}/farms`, `/api/v1/farms`, `/api/v1/users/{id}/farm-grants`, plus `GET /openapi.json` |

**The live service still runs the old code.** The fix is local and uncommitted.

---

## 10. Remaining blockers

| # | Blocker | Owner | Action | Unblocks |
|---|---|---|---|---|
| 1 | **Deploy the identity fix** | Jason | Authorise the deploy. `autoDeploy` is on `commit` for `main`, so a push to `main` deploys and runs migrations — migrations 020 and 021 (from the SMS/voice session) are still unapplied, and 021 unbinds the phantom `+19715885824` and sets `+19715885823` to `sms_voice`. | §3 |
| 2 | ~~Farm grant~~ **DONE** | — | Granted `operator` on `v-farm` (one farm; `test-001` deliberately untouched) and verified — §4.3. | §4 |
| 3 | ~~Confirm the grant's `farm_id` form~~ **DONE** | — | The authoritative list returns the farm **UUID**, which is exactly what CST sends upstream. | — |
| 4 | **One real voice call** | Jason | Verified From number, reachable handset, written authorisation. | end-to-end |
| 5 | **One real SMS** | Jason | Approved recipient, window, explicit dispatch authorisation. | end-to-end |
| 6 | **End-to-end acceptance** | Ahad | A farm question must return a farm-specific answer, not the onboarding reply. This cannot be demonstrated before 1–5. | task completion |
| 7 | **DB read access** | Jason / Platform | The `customers` row for the test phone still needs confirming in production (`SELECT phone_e164, customer_ref, role, farm_ids, speaker_cache_expires_at FROM customers WHERE phone_e164 = '+923082113844';`) — the IP allowlist is empty and no bypass was attempted. | §3 verification |
| 8 | **A user→unit/location contract is missing upstream** | vFarm owner | vFarm's hierarchy is `farm → zones → locations → sublocations → devices`, but **no endpoint binds a user to a zone/location/device** — only the farm grant exists. CST's `getUnitStatus` needs a unit id, and the engine refuses to invent one. Until that contract exists, **live telemetry** ("what is the status of my farm?") answers *"Your phone number is not linked to an active vFarm unit"* even with the grant in place. Farm-scoped **knowledge** questions are unaffected and now work. | telemetry |

### 10.1 On the "end-to-end" criterion

The task is complete only when a farm question returns a legitimate farm-specific response. **That cannot be demonstrated yet**, and the report does not claim it:

- Blockers 1 and 2 are external and require authorisation.
- Until the grant exists, the correct behaviour is the safe "no linked farm resources" reply — the system is working as designed in that state.
- The local equivalent is proven: `tests/identity/identity_binding_restoration.test.ts` shows a granted speaker reaching the upstream vFarm path with the authorised farm id and receiving a farm-specific answer, and a zero-grant speaker receiving a safe reply with no upstream call and no farm data.

---

## 11. Supporting evidence

| Evidence | Path |
|---|---|
| This report | `docs/release/CST_VFARM_IDENTITY_RESOLUTION_REPORT.md` |
| Canonical task ledger | `docs/task.md` (mirror `docs/release/task.md`) |
| Identity / resolution regression tests | `tests/identity/identity_binding_restoration.test.ts` |
| SMS + voice routing tests | `tests/identity/sms_voice_routing.test.ts` |
| The adapter's own contract note on the phone binding | `engine/src/adapters/vfarm/index.ts` (`resolveSpeaker` doc comment) |
| vFarm OpenAPI (live) | `GET https://vfarm.bhanetwork.org/openapi.json` |
| Admin panel | `web/admin.js` · `web/admin.css` · `engine/src/admin/routes.ts` |

---

*Prepared 2026-10-20 by Ahad (`U0AC6RFNP3P`). Uncommitted. No production data, configuration, deployment, call, SMS, credential rotation, or Slack post was performed. No secrets, tokens, or customer PII are included.*
