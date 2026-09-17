# CST Platform Tenancy, Projects, Capabilities & Number Binding

**Status:** Draft requirements (not implementation)  
**Date:** 2026-09-17  
**Owner:** CST  
**Audience:** CST, vFarm, BHARAG  

This document defines how Customer Service Twin (CST) must stand as a **core customer-service platform**, with **vFarm as tenant #1**, not as a vFarm-hardcoded engine.

---

## 0. Why this exists

Today CST behaves as if vFarm *is* the product:

- One env-built “system” (`system-vfarm-01`) with one tenant id and one hardcoded workspace (`ws-vfarm-main`).
- Twilio numbers come from `VFARM_PHONE_NUMBERS`.
- Known callers are a **seeded local `customers` table**, not a live pull of vFarm orgs / projects / farm owners.
- Ingress tenancy is only “which Twilio `To` number was texted.”
- Farm/unit scope is a static column on that seed row.

That cannot survive a second tenant, a second vFarm project, or “only this farm owner may query this farm.”

CST must invert: **CST is the platform; a tenant (vFarm) registers, CST pulls that tenant’s projects, each project opts into capabilities (SMS first), numbers are synced and bound, and speak/query rights come from the tenant’s identity — not from CST guessing.**

---

## 1. Vocabulary (CST owns these words)

| CST term | Meaning | vFarm example |
|---|---|---|
| **Platform** | CST itself. No customer data of its own except conversations, queues, bindings, audit. | `bha-cst` |
| **Tenant** | A product/company that uses CST. Top isolation boundary. | vFarm |
| **Project** | A support surface inside a tenant. CST **pulls** projects from the tenant; it does not invent them. | A vFarm org mapped to a CST project (see §3) |
| **Capability** | A channel the project has enabled. Off until selected. | `sms` now; later `whatsapp`, `voice`, `email` |
| **Service number** | A provider endpoint (Twilio DID / Messaging Service) bound to `tenant + project + capability`. | `+19715885823` receives SMS for Project A |
| **Speaker number** | A human’s phone. Routing hint only; **not** a credential. | Farm owner’s mobile |
| **Resource scope** | What that speaker may read/write **inside** the project, resolved by the tenant. | The farms that owner owns |
| **Adapter** | Tenant-specific connector. CST core never contains `farm_id` as a first-class CST type. | vFarm adapter: orgs, projects, farms, owners |

**Hard rule:** Phone numbers never authenticate. They select a candidate identity. The tenant adapter confirms identity + role + resource scope. Unresolved → onboarding reply, zero farm data.

---

## 2. Target structure (how the tree stands)

```
CST Platform
└── Tenant: vFarm
    ├── Credentials / adapter config (resolve API, BHARAG keys, Twilio account ref)
    └── Project: <mapped from vFarm org>          ← CST pulls these
        ├── Capability: SMS (enabled | disabled)
        ├── Service numbers (Twilio sync + bind policy)
        ├── Speaker policy (allowlist | all_project_owners)
        ├── Speaker bindings (phone → tenant person id, synced)
        └── Conversations (CST-owned), scoped tenant_id + project_id
            └── Query execution uses tenant-resolved resource scope (farms)
```

A second tenant later is another tree under CST, not a fork of the engine.

**Non-goals for this requirements set**

- Building WhatsApp/voice (capability slots only).
- CST becoming source of truth for orgs, farms, or people.
- Executing equipment control from SMS (control stays gated / out of band).

---

## 3. Mapping: tenant org → CST project

### Decision required of vFarm (recorded recommendation)

vFarm has org / farm / workspace. CST needs a **project** grain for support configuration (which number, which capability, which speakers).

**Recommended mapping (Option A):**

| vFarm object | CST object |
|---|---|
| vFarm product (the company on CST) | **Tenant** |
| vFarm **Organization** | **CST Project** |
| vFarm Farm | **Resource inside project** (never a CST tenant, never a CST project) |
| vFarm farm owner / manager / tech | **Speaker** with server-resolved role + farm list |

Why: support config (Twilio number, SMS on/off, who may text) is an **org-level** choice. Farm isolation is an **authorization** problem inside that project, not a separate inbound number per farm unless the tenant later binds extra service numbers.

**Rejected for v1**

- **Option B — one CST project per farm:** explodes Twilio numbers and onboarding; only use if a farm must have a private DID.
- **Option C — one CST project for all of vFarm:** cannot isolate org A’s customers from org B’s farms; fails the user’s “pull different projects” requirement.

If vFarm later introduces a first-class “Project” entity distinct from org, CST maps to **that** object and org remains the parent tenant-side container. CST must not assume the label “org” forever — it maps to the tenant’s **project-shaped** id.

### Pull contract (CST ← tenant)

CST must be able to, on a schedule and on demand:

1. List projects for a tenant (`project_id`, name, status, tenant-side org id).
2. For each project, list **resource scopes** needed for routing display (farms) — ids only.
3. For each project, list **eligible speakers** (person id, role, E.164 phones, farm ids they may query).
4. Optionally list **candidate service numbers** the tenant wants CST to use (if vFarm stores Twilio config) **or** numbers from the Twilio account CST is authorized to read.

CST stores a **projection** (cache) with `synced_at`. Tenant remains source of truth. Stale/conflict → fail closed for personalized answers, not “best guess.”

---

## 4. Capabilities

Each project independently selects capabilities. Unselected capability = CST does not accept or send on that channel for that project.

| Capability | v1 | Behavior |
|---|---|---|
| `sms` | Required | Inbound Twilio webhook + outbound SMS worker |
| `whatsapp` | Slot only | Same identity/scope rules when enabled |
| `voice` | Slot only | Step-up / identity later |
| `email` | Slot only | Out of scope |

**Requirements**

- R-CAP-1: Enabling SMS on a project is a **server-side config write** (admin/service), never inferred from a customer message.
- R-CAP-2: A webhook for SMS is accepted only if: signature valid **and** `To` is a service number bound to a project **and** that project has `sms=enabled`.
- R-CAP-3: Disabling SMS stops new ingress and outbound for that project; existing transcripts remain.
- R-CAP-4: Capabilities do not grant data rights. SMS-on does not mean “can query all farms.”

---

## 5. Two number populations (do not collapse these)

### 5.1 Service numbers (Twilio configuration)

These are **how CST is reached**.

**Sync**

- R-NUM-S1: CST can sync numbers from the configured Twilio account (Messaging Service / incoming numbers) **and/or** from the tenant adapter if the tenant publishes intended DIDs.
- R-NUM-S2: A synced number is **candidate** until an admin (or tenant policy) **binds** it to exactly one `(tenant_id, project_id, capability)`.
- R-NUM-S3: One service number **must not** bind to two projects. Collision → refuse bind, audit log.
- R-NUM-S4: Unbound or unknown `To` on inbound → HTTP 404 / no DB conversation / no reply (same fail-closed as today).
- R-NUM-S5: Twilio secrets stay in env/secret manager. DB holds SIDs and E.164, not auth tokens.

**Bind policies (per project, SMS capability)**

| Policy | Meaning |
|---|---|
| `explicit_bind` (default) | Only numbers explicitly attached to this project receive for it. |
| `all_account_unbound` | Dangerous; **not allowed in production**. Would let every Twilio number on the account hit a project. |

v1 production: **explicit bind only**. Sync is discovery; bind is authorization.

### 5.2 Speaker numbers (who may connect and speak)

These are **who is texting**.

Because in vFarm **only the respective farm owner (and other tenant-granted roles) may query those farms**, speaker policy is separate from Twilio DIDs.

**Per-project speaker policies**

| Policy | Meaning |
|---|---|
| `allowlist` | Only E.164s present in the project’s synced speaker list may receive **account-level** replies (status/farms). Unknown → onboarding, no farm data. |
| `all_project_members` | Any phone the tenant adapter currently lists as a member of **this project** (owner/manager/tech with at least one farm grant) may speak. Still not “anyone who texts the DID.” |

There is **no** policy `anyone_who_knows_the_number`. That would leak farm telemetry.

**Requirements**

- R-NUM-P1: Speaker list is **synced from the tenant**, not typed into CST as the source of truth. CST may cache.
- R-NUM-P2: Exact E.164 match only. Partial/national format mismatch → unknown.
- R-NUM-P3: Same phone in two tenants is allowed; scope is `tenant + project` of the **service number they texted**.
- R-NUM-P4: Same phone in two projects of one tenant: conversation and data scope follow the **project of the DID they used**. They cannot reach Project B farms by texting Project A’s number.
- R-NUM-P5: Removing a person in vFarm (or revoking farm grants) must take effect on next message after sync (or live resolve). CST must not keep immortal farm access because a seed row exists.
- R-NUM-P6: Transcripts may store `from_e164` (conversation PII). Identity mapping used for **authorization** must re-resolve; do not authorize from an old transcript.

---

## 6. Identity & farm query authorization (vFarm tenant)

Ingress chain (server-side only):

```
Twilio To  →  service number binding  →  tenant_id + project_id + capability
Twilio From → speaker resolve via tenant adapter (scoped to that project)
           → person_id, role, farm_ids[]   (resource scope)
```

**Requirements**

- R-ID-1: CST core calls `TenantAdapter.resolveSpeaker({ tenant_id, project_id, phone_e164 })`. vFarm implementation hits vFarm registry; other tenants have other adapters.
- R-ID-2: CST **must not** use SMS body, LLM output, or client fields to choose org, project, farm, or unit.
- R-ID-3: Status/telemetry/images that expose farm state require a **non-empty farm scope** from the adapter. Empty scope → refuse personalized data (same class of response as unbound unit today).
- R-ID-4: If the speaker is a farm owner, queries run **only** for farms in `farm_ids[]` returned for that person in **this project**. Cross-farm and cross-org is refuse + audit `refused`.
- R-ID-5: If a message names another farm (“bay 4 on Alice’s site”), CST still uses **bound scope**, not the name. Out-of-scope mention → refuse that slice, do not widen.
- R-ID-6: Roles (`owner` / `manager` / `tech`) remain **server-resolved**. Tech cannot control; writes still need step-up. This requirements set does not open a control lane.
- R-ID-7: Unknown speaker: generic project/tenant onboarding copy; opaque unresolved ref; no farms, no telemetry, no RAG that includes tenant-private context.
- R-ID-8: Local `customers` seed is **dev/test only**. Production identity is adapter + cache with TTL. Cache miss → live resolve; adapter down → degraded: no farm data (honest unavailable), not a stale owner’s farms.

---

## 7. What CST stores vs what it must not

**CST stores**

- Tenants, projects (ids + display + sync cursors).
- Capability flags.
- Service number bindings.
- Speaker projection cache (phone, person ref, role, farm id list, expiry).
- Conversations/messages/queues stamped with `tenant_id` **and** `project_id`.
- Audit / security ledger (actor, role, project, outcome).

**CST does not store as source of truth**

- Org charts, farm membership, sensor truth, incident lifecycle, media blobs, Twilio auth tokens.

**PII rule:** BHARAG incidents continue to receive opaque `customer_ref` / person id, not raw phone, unless a later privacy review says otherwise.

---

## 8. Data / control (unchanged product stance)

This tenancy work does **not** create a control lane.

- **Data path:** status, knowledge, images — scoped to adapter farm list.
- **Control path:** detect and refuse (step-up / role), no actuation API.
- **Escalate:** BHARAG incident tagged `subsystem=CUSTOMER_TWIN`, `engine` from tenant (e.g. `VFARM`), plus `tenant_id` / `project_id` in details.

---

## 9. Fail-closed matrix

| Condition | Outcome |
|---|---|
| Bad Twilio signature | 403, no DB |
| Unknown or unbound service number | 404, no conversation |
| Project SMS capability off | 404 or 403, no processing |
| Speaker not on project policy list | Onboarding, no farm data |
| Adapter identity unknown | Same as unknown speaker |
| Adapter down | No personalized farm data; optional generic “temporarily unavailable” |
| Farm id not in speaker’s grant | Refuse that query |
| Outbound to a number that is another project’s **service** DID | Refuse (keep today’s cross-tenant send check, extend to project) |
| Client-supplied tenant/project/farm in webhook body | Ignore; mismatch if present → 403 |

---

## 10. Admin / onboarding flow (requirements, not UI spec)

When introducing vFarm as a tenant:

1. Register **Tenant vFarm** in CST (adapter URLs, keys, Twilio account ref).
2. **Pull projects** (vFarm orgs → CST projects). Operator confirms mapping.
3. Per project: **enable SMS**.
4. **Sync Twilio numbers**; **bind** one (or more) DID(s) to that project’s SMS capability.
5. Choose speaker policy: `allowlist` or `all_project_members`.
6. **Sync speakers** (farm owners’ phones + farm grants).
7. Only then does that project “speak.”

Success criteria: a farm owner texts the project DID and receives **only their farms**; a different org’s owner texting the same DID (if they are not members) gets onboarding; they must use **their** project’s DID.

---

## 11. Test requirements (must ship with the model)

1. Two vFarm orgs → two CST projects → two DIDs; owner A cannot get owner B farms.
2. Owner A texts project B’s DID with a number not on B’s speaker list → onboarding.
3. Owner with farms `{F1}` cannot get telemetry for `{F2}` even if they type F2 in SMS.
4. Unbound Twilio number → no rows.
5. SMS capability disabled → no handle.
6. Speaker removed in vFarm (after sync) → next SMS loses farm data.
7. Number bind collision across projects refused.
8. Adapter timeout → no synthetic telemetry (existing degraded-state spec).

---

## 12. Gap vs current code (for planning later)

| Current | Required |
|---|---|
| One env system = tenant = workspace | Tenant → many pulled projects |
| `VFARM_PHONE_NUMBERS` | Synced + explicitly bound service numbers per project |
| Seeded `customers` | Tenant adapter speaker sync + live resolve |
| `tenant_id` only on messages | `tenant_id` + `project_id` |
| Farm/unit frozen on seed row | Farm list from adapter grants, per message |
| vFarm types in core router | Tenant adapter interface; vFarm is implementation #1 |

---

## 13. Open decisions (do not block the model)

1. **Mapping grain:** Confirm org = CST project (Option A) with vFarm.
2. **Live vs cache:** Prefer live resolve per inbound with short cache, or sync-only? Recommendation: **live resolve with short TTL cache**.
3. **Multiple DIDs per project:** Allowed (R-NUM-S2); default one DID per project for v1 ops simplicity.
4. **Who binds numbers:** CST admin vs vFarm admin pushing config. Recommendation: CST admin bind, vFarm can *propose* numbers via adapter.

---

## 14. Recommended build order (requirements sequencing, not tasks)

1. Introduce `tenant` / `project` / `capability` / `service_number_binding` as CST core types; keep vFarm as the only tenant behind an adapter facade.
2. Ingress: `To` → binding → project, not → hardcoded system.
3. Speaker sync + resolve; delete production dependence on seed as identity.
4. Enforce farm grant list on status/images.
5. Admin: pull projects, enable SMS, bind numbers.
6. Only then consider a second tenant or WhatsApp capability.
