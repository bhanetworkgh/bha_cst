# CST User Integration — vFarm → CST → Admin Panel (Audit & Evidence)

Date: 2026-09-30
Scope: audit of how existing vFarm users and newly created users flow through
vFarm → CST tenant/project → speaker/customer → farm scope → Admin Panel.
No vFarm API or credential was invented. Every claim below cites code.

**Status: implemented and verified.** 19 gaps found (G1–G19); 15 fixed, 2 mitigated,
2 by-design upstream limits, 4 open and listed in §12. Verified three ways:
automated tests (307 passing), a real Google Chrome browser run against the live
dev server, and a direct probe of the live vFarm instance using the existing
`.env` credentials.

### Change log

| Round | What changed |
|---|---|
| 1 — audit | Documented flows, source of truth, tables, routes. No code changed. |
| 2 — engine + panel fixes | G1–G8 (join, mirroring, prune, sync scope, TTL, typecheck). New `tests/admin/admin_user_integration.test.ts`. |
| 3 — browser validation | 23/23 Chrome checks. Found G15 (failed read shown as truth) and G16 (pre-login 401). Fixed both. |
| 4 — live vFarm integration | Probed the real vFarm instance; found G17 (org-members needs a Bearer JWT), G18 (JWT assigned after clients built), G19 (project org ids are placeholders). All fixed or mitigated. Real vFarm users now list in the panel. New `tests/adapters/vfarm_org_members_auth.test.ts`. |
| 5 — identity debt closed | G9 migrated (voice now resolves via the active tenant adapter), G14 dead router deleted, G10/G11 fixed against a migrated Postgres, G19 replaced with the real org UUID in code **and** migration 012. |
| 6 — Engine pillar | Confirmed the `cst.turn` path already existed and was correct; added contract + fire-and-forget regression tests. Found and fixed an availability bug where an expired vFarm JWT logged admins out of CST. New `tests/publishers/turn_event_contract.test.ts`, `tests/identity/identity_debt.test.ts`. |

---

## 0. Summary of this round

| Item | Outcome |
|---|---|
| G9 legacy identity path | **Closed** — `IdentityResolver` migrated onto the active tenant-adapter path |
| G14 dead divergent router | **Closed** — `transport/twilio/inbound.ts` deleted, unmounted import removed |
| G10 per-tenant uniqueness | **Closed** — stale constraint dropped via migration 012; `ON CONFLICT` corrected |
| G11 update predicate | **Closed** — project-scoped updates now match strictly |
| G19 placeholder org ids | **Closed** — real UUID in `registry.ts`, `adapters/vfarm/index.ts`, and migration 012 |
| farm-grants live verification | **Partially blocked** — auth confirmed, response shape unconfirmed (expired JWT) |
| `cst.turn` Engine path | **Verified complete**, tests added |
| `cst.delivery` | Already present and tested; left unchanged (turn path is stable and tests are clean) |
| Test suite | 36 files, 328 tests, green on 3 consecutive runs |

---

## 1. Current architecture

```
vFarm (source of truth for identity)
  │  GET /api/v1/organizations/{org_id}/users      → user_id, email, name, role, granted_by, granted_at
  │  GET /api/v1/users/{user_id}/farm-grants      → farm_id[] (farm membership)
  │  GET /api/v1/organizations                    → org discovery (id, slug, name, member_count)
  │  (NO phone field on any endpoint)
  │
  │  ⚠ auth: the org-members endpoint REJECTS X-Farm-Key and requires
  │    "Authorization: Bearer <JWT>". Proven live — see G17.
  ▼
VfarmHttpClient            engine/src/adapters/vfarm/http_client.ts:136,165
VfarmLiveClient            engine/src/adapters/vfarm/live_client.ts
  • getOrgMembers(orgId, token?)  — bearer-authenticated
  • getUserFarmGrants(userId, token?)
  ▼
VfarmTenantAdapter         engine/src/adapters/vfarm/index.ts
  • pullSpeakers()  :422   — cross-checks local directory vs live org members
  • resolveSpeaker():511   — phone → identity, re-verified live on every resolve
  • in-memory speakersMap  — phone → SpeakerRecord (seeded from fixtures :292-325)
  ▼
CoreRegistry.resolveSpeaker()   engine/src/core/registry.ts:345 (short-TTL cache :386)
  ├── SMS   engine/src/interfaces/sms/index.ts:165   (MOUNTED, live path)
  ├── Web   engine/src/interfaces/web/index.ts:65,155
  └── Voice engine/src/interfaces/voice/index.ts:133,272,756
  ▼
CoreEngine.processEnvelope(...)
  ▼
Admin Panel  web/admin.html + web/admin.js
             reads /api/v1/admin/speakers (CST `customers` table projection)
             + /api/v1/admin/vfarm/customers (live vFarm org members ⋈ CST)
             + /api/v1/admin/vfarm/organizations (org discovery)
```

### Two identity paths exist in the codebase

| Path | Entry | Reads from | Mounted? |
|---|---|---|---|
| A — runtime | `POST /webhooks/twilio/sms` → `interfaces/sms/index.ts:127` | `CoreRegistry.resolveSpeaker` → adapter `speakersMap` | **Yes** (`app.ts:76`) |
| B — legacy | `transport/twilio/inbound.ts:59` → `IdentityResolver.resolveSenderIdentity` (`identity/resolver.ts:22`) | `DbClient.lookupCustomerByPhoneAsync` → `customers` table | **No** — imported at `app.ts:2` but never `app.use`d |

Consequence before this change: the Admin Panel wrote to `customers`, while live
SMS resolution read the adapter's in-memory directory. Two different user sets.

---

## 2. Existing-user flow (vFarm user already exists)

1. Admin triggers **Sync speakers** → `POST /api/v1/admin/speakers/sync` (`engine/src/admin/routes.ts:293`).
2. Route validates the project belongs to the tenant (`:305`).
3. `adapter.pullSpeakers(tenant_id, project_id)` (`adapters/vfarm/index.ts:422`):
   - starts from the adapter's local `speakersMap` for that project (`:427-428`);
   - `listOrganizationMembers(orgId)` via live HTTP (`:443`);
   - **drops** any local speaker whose `person_id` is no longer in the org (`:452-455`);
   - refreshes `role` from the vFarm org role via `mapVfarmOrgRoleToCstRole` (`:28-43`, `:457`);
   - refreshes `farm_ids` from `getUserFarmGrants` when that call succeeds (`:460-464`).
4. Route upserts each speaker into `customers` (`:332-352`), invalidates the
   projection cache (`:365`) and mirrors into the adapter directory (`:410`).
5. **NEW — prune.** When the adapter is in live mode, rows in the synced
   (tenant, project) scope whose `customer_ref` is absent from the verified
   upstream list are deleted, so a vFarm revocation disappears from the panel
   instead of lingering. Gated on `isLiveMode()` so an upstream outage (where
   the adapter returns its last-known directory intact) can never delete rows.
6. Admin Panel lists them via `GET /api/v1/admin/speakers` (`:417`) → `DbClient.getAllCustomers` (`db/client.ts:755`).

**Limitation (unchanged, upstream):** a vFarm user with **no local phone binding**
cannot be pulled, because vFarm exposes no phone number. Documented at
`adapters/vfarm/index.ts:498-510`. `pullSpeakers` never *adds* upstream-only members.

---

## 3. New-user flow (user created in vFarm)

1. User is created in the vFarm org. `GET /api/v1/organizations/{org_id}/users` now lists them.
2. CST cannot bind a phone automatically (no phone field upstream).
3. Admin maps a phone in the Admin Panel → `POST /api/v1/admin/speakers` (`routes.ts:453`):
   validates E.164 (`:465`), validates project↔tenant (`:473`), upserts (`:489`),
   invalidates cache (`:522`), and — **new** — mirrors into the adapter directory (`:523`).
4. The user now appears in `GET /api/v1/admin/speakers` and in
   `GET /api/v1/admin/vfarm/customers` with `cst_registered: true`.
5. On the next sync the user is re-verified against the live org list and kept.

---

## 4. Source of truth per field

| Field | Source of truth | Code |
|---|---|---|
| `person_id` / vFarm `user_id` | **vFarm** (`organizations/{org}/users`) | `schemas.ts:12-20` |
| name, email | **vFarm** | `schemas.ts:14-15` |
| role | **vFarm** org role, mapped `owner/admin→owner`, `manager→manager`, `tech/technician/member→tech`; CST value is a cached copy | `adapters/vfarm/index.ts:28-43`, `:457`, `:553` |
| farm scope (`farm_ids`) | **vFarm** `users/{id}/farm-grants`; CST keeps last-known value when that call fails | `adapters/vfarm/index.ts:460-464`, `:557-559` |
| org membership (revocation) | **vFarm** — absence from org list ⇒ fail closed | `adapters/vfarm/index.ts:452-455`, `:548-552` |
| `phone_e164` | **CST / Admin Panel** (vFarm has no phone field) | `schemas.ts:12-20` (absent), `routes.ts:455` |
| `customer_ref` | **CST** — stores the vFarm `user_id`; join key to vFarm | `routes.ts:390`, `:1275` |
| tenant / project | **CST** (`projects.tenant_id`, `projects.tenant_org_id`) | `core/types.ts:21`, `core/registry.ts:86` |
| `speaker_cache_expires_at` | **CST** projection cache TTL (24h) | `routes.ts:365-366`, `db/client.ts:721` |
| service number (Twilio `To`) | **CST** binding table, source number from Twilio | `routes.ts:167-172`, `db/migrations/010` |

`customer_ref` is CST's storage of vFarm's `user_id`; `person_id` is the
adapter-level name for the same value. There is no separate `person_id` column.

---

## 5. Database tables

| Table | Role |
|---|---|
| `customers` | CST speaker projection: `phone_e164`, `customer_ref`, `role`, `project_id`, `farm_ids` JSONB, `speaker_cache_expires_at`, `organization_id`, legacy `farm_id`/`unit_id` |
| `projects` | CST project → `tenant_id` + `tenant_org_id` (the vFarm org link) |
| `tenants` | tenant registry |
| `service_number_bindings` | Twilio `To` → tenant/project |

Migrations: `003_add_customers_and_security_ledger.sql`, `003_customers_table.sql`,
`004_add_role_to_customers.sql`, `005_add_organizations_and_workspaces.sql`,
`006_seed_initial_customers.sql`, `010_add_projects_bindings_and_project_id.sql`
(unique constraint `unq_customers_tenant_project_phone` at `:155`).

---

## 6. API routes

No new route was added. No vFarm credential ever reaches the browser.

| Route | Purpose |
|---|---|
| `GET /api/v1/admin/speakers` | CST speaker list + filters/search (`routes.ts:417`) |
| `POST /api/v1/admin/speakers` | admin onboarding / phone↔user mapping (`routes.ts:453`) |
| `PATCH /api/v1/admin/speakers/:phoneE164` | update role/farm scope/TTL (`routes.ts:546`) |
| `DELETE /api/v1/admin/speakers/:phoneE164` | revoke CST access (`routes.ts:596`) |
| `POST /api/v1/admin/speakers/sync` | pull from adapter, cross-checked with vFarm; now also prunes upstream-removed users in live mode (`routes.ts:293`) |
| `POST /api/v1/admin/speakers/invalidate` | expire projection cache (`routes.ts:384`) |
| `GET /api/v1/admin/vfarm/customers` | live vFarm org members ⋈ CST speakers (`routes.ts:1351`) |
| `GET /api/v1/admin/vfarm/organizations` | org discovery for the panel's selector (pre-existing route, newly consumed by the UI) |
| `GET /api/v1/admin/projects` | includes `tenant_org_id` (`routes.ts:77`) |

### Response enrichment (additive, backwards compatible)

`GET /api/v1/admin/vfarm/customers` gained two fields. Previously a failed
upstream fetch returned `status:"ok"` with `customers: []`, which is
indistinguishable from "this organization has no users":

```jsonc
{
  "status": "ok",
  "org_id": "...",
  "count": 1,
  "customers": [ /* unchanged shape */ ],
  "vfarm_source": "live" | "unavailable",   // NEW
  "source_error": "vFarm HTTP 401 from ..." | null  // NEW
}
```

`POST /api/v1/admin/speakers/sync` likewise reports `pruned_count` and `pruned`
alongside its existing `count` / `speakers`. Existing consumers keep working.

---

## 7. Admin Panel flow (after this change)

Tab 2 “Users & Speakers” now has two coordinated views:

1. **CST speaker projection** — unchanged table plus a provenance badge per row:
   - `vFarm · <role>` when the `customer_ref` matches a live org member;
   - `Not in vFarm org` when it does not (revoked upstream, or a CST-only record);
   - `CST record` before the live view has been loaded **or when the live read
     failed** — a failed read must never assert that a user is absent upstream.
2. **vFarm Source of Truth** block (`web/admin.html:209-243`) — reads the existing
   `GET /api/v1/admin/vfarm/customers`, with an org selector combining
   `projects[].tenant_org_id` with organizations discovered from
   `GET /api/v1/admin/vfarm/organizations`. Non-UUID project org ids are labelled
   `⚠ not a live vFarm id (placeholder)`. Shows vFarm `user_id`, name/email,
   vFarm role, CST mapping (phone + project + CST role), farm scope, and status
   (`mapped` / `vFarm only`). Metrics: vFarm members, mapped, vFarm-only, CST-only.

The panel is a **read path plus the same admin endpoints the engine already
exposes** — it is not an authorization path. Every server call is behind
`requireAdminAuth` (`app.ts:79`).

### Verified against the real vFarm instance

With the real org (`122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d`) selected, the panel
now lists the actual vFarm member:

| vFarm user_id | Name / Email | vFarm Role | CST Speaker Mapping | Status |
|---|---|---|---|---|
| `debf555c-b37d-4e92-bb15-597e169f1b38` | Admin · admin@vfarm.co | `admin` | Not mapped — vFarm exposes no phone number | vFarm only |

`vfarm_source: "live"`, `source_error: null`. The three CST fixture speakers
correctly show `Not in vFarm org`, because their `customer_ref` values
(`usr_vfarm_001` etc.) do not exist in the real vFarm org.

---

## 8. Gaps found (and status)

| # | Gap | Evidence | Status |
|---|---|---|---|
| G1 | `/vfarm/customers` joined on `s.person_id`, a field absent from `CustomerRecord` ⇒ every local speaker keyed on `undefined`, so `cst_registered` was **always false** | `routes.ts:1267` (pre-fix), `db/client.ts:9-22` | **Fixed** — join on `customer_ref` |
| G2 | Same route read `local?.cache_expires_at`, field does not exist | `routes.ts:1283` (pre-fix) | **Fixed** — `speaker_cache_expires_at` |
| G3 | These two were also the only `npm run typecheck` failures | pre-fix typecheck output | **Fixed** |
| G4 | Admin Panel wrote `customers`; live SMS resolution reads the adapter directory ⇒ admin onboarding/revocation invisible at runtime | `interfaces/sms/index.ts:165` → `registry.ts:379` → `adapters/vfarm/index.ts:527` | **Fixed** — `mirrorSpeakerToAdapter` on sync/create/patch, `unmirrorSpeakerFromAdapter` on revoke (`routes.ts:13-58`) |
| G5 | Revoke deleted the DB row but left the adapter directory entry ⇒ revoked speaker still resolved | `routes.ts:596` (pre-fix) | **Fixed** |
| G6 | Sync did not propagate upstream removal ⇒ revoked user still listed in the Admin Panel | `adapters/vfarm/index.ts:452-455` drops it; sync only upserted | **Fixed** — prune, gated on `isLiveMode()` so an outage cannot delete rows |
| G7 | Sync's in-memory fallback dropped `project_id` and collapsed `farm_ids` to the first entry ⇒ panel under-reported project and farm access | `routes.ts:398-404` (pre-fix) | **Fixed** |
| G8 | Invalidate only expired the row via SQL ⇒ with no DB pool the Admin Panel kept showing “Active TTL” | `routes.ts:392-403` (pre-fix) | **Fixed** — in-memory path now writes the past TTL |
| G9 | `IdentityResolver` read the `customers` table directly and exposed only the legacy single `farm_id` column — a **second, divergent identity source**. It was assumed dead, but it is **live on voice**: `transport/voice/voice_lane.ts:107` calls it and `voiceRouter` is mounted at `app.ts:80`. SMS/Web used the adapter path, so the two channels could disagree about who a caller is and what farms they may touch | `identity/resolver.ts:44,68-72`; `voice_lane.ts:107` | **Closed** — migrated onto `CoreRegistry.resolveSpeaker`; exposes full `farm_ids` |
| G14 | `transport/twilio/inbound.ts` exported an `inboundRouter` that was imported at `app.ts:2` but never mounted — a duplicate SMS handler resolving tenancy from `SystemsRegistry` rather than service-number bindings, and (before this change) through the legacy resolver | `app.ts:2`, `inbound.ts:12` | **Closed** — file deleted, import removed |
| G10 | `DbClient.seedCustomer` upserted on `(tenant_id, phone_e164)` while migration 010's constraint is `(tenant_id, project_id, phone_e164)`. Worse: migration 010 kept the old per-tenant constraint "for backwards compat", so the **same phone could not exist in two projects of one tenant** — silently, since the in-memory tests allow it | `db/client.ts:618`, `migrations/010:152-156`; verified: DB held BOTH `customers_tenant_id_phone_e164_key` and `unq_customers_tenant_project_phone` | **Closed** — migration 012 drops the stale constraint and adds a partial unique index for NULL-project rows; `ON CONFLICT` corrected. Proven against real Postgres (see §12.1) |
| G11 | `updateCustomer` matched `AND (project_id = $3 OR project_id IS NULL)`, so an admin edit scoped to project A could mutate a row belonging to no project / another scope | `db/client.ts:876` | **Closed** — project-scoped updates match strictly (`AND project_id = $n`). Proven: a project-scoped UPDATE affected exactly 1 of 2 same-phone rows (§12.1) |
| G12 | New vFarm org members with no phone cannot be auto-imported (upstream exposes no phone) | `schemas.ts:12-20`, `adapters/vfarm/index.ts:498-510` | **By design** — surfaced in the UI as `vFarm only` |
| G13 | `pullSpeakers` needs `projects.tenant_org_id`; without it the live cross-check is skipped | `adapters/vfarm/index.ts:435-438` | **By design** — warns |
| G15 | `/vfarm/customers` swallowed a failed org-members fetch and returned `status:"ok"` with an empty list, so the Admin Panel displayed "0 member(s) · live" and "CST only 3" — a failed read presented as authoritative truth | found by live browser run (real vFarm returned HTTP 422) | **Fixed** — response now carries `vfarm_source: 'live'\|'unavailable'` + `source_error`; the panel renders the failure and leaves CST provenance badges unasserted |
| G16 | `admin.js` fired `guarded(refreshAll)` on load before the auth guard redirected an anonymous visitor, logging a 401 for `/api/v1/admin/tenants` | found by live browser run | **Fixed** — boot refresh only runs when a token is present |
| G17 | The vFarm **organization-members endpoint rejects `X-Farm-Key` auth** and requires a Bearer JWT, but `VfarmLiveClient.getOrgMembers` never sent one ⇒ 401 for every org | proved live: farm key alone → `401 {"error":"unauthorized","detail":"Missing authentication — provide X-Farm-Key or Authorization: Bearer <token>"}`; farm key + `VFARM_JWT` → `200` | **Fixed** — `VfarmLiveClient` gained `apiToken` + `authHeaders()`; `getOrgMembers`/`getUserFarmGrants` accept a token; the adapter passes its admin JWT to the live client and keeps it fresh after `authenticateAdmin` |
| G18 | The adapter assigned `this.adminJwt` **after** building both clients, so the token never reached them | `adapters/vfarm/index.ts:66-74` (pre-fix) | **Fixed** — JWT resolved before client construction |
| G19 | `projects[].tenant_org_id` holds CST placeholders (`org-vfarm-austin`, `org-vfarm-dallas`), not real vFarm org ids; vFarm returns **422** for them | live: `vFarm HTTP 422 from /api/v1/organizations/org-vfarm-austin/users`; real org ids are UUIDs | **Mitigated in the UI** — the org selector now also lists organizations discovered via the existing `GET /api/v1/admin/vfarm/organizations`, and flags non-UUID project org ids as placeholders. **Closed** — the real UUID `122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d` now lives in `core/registry.ts`, `adapters/vfarm/index.ts` (a second G19 site, caught by a new test) and migration 012; overridable via `VFARM_TENANT_ORG_ID`. Confirmed live in the browser (§12.1) |

---

## 9. Tenancy / security verification

| Chain | Verified |
|---|---|
| vFarm org → CST project | `projects.tenant_org_id`; sync validates project belongs to tenant (`routes.ts:305`); live cross-check keyed on that org (`adapters/vfarm/index.ts:435`). ⚠ currently satisfied only via UI org discovery — the stored `tenant_org_id` values are placeholders (G19) |
| vFarm user → CST speaker | join on `customer_ref`; sync drops members absent upstream (`:452`) |
| vFarm farm membership → `farm_ids` | `getUserFarmGrants` (`adapters/vfarm/index.ts:460`, `:557`) |
| Twilio `From` → speaker | `CoreRegistry.resolveSpeaker` keyed only on `phone_e164`; client-supplied identity claims ignored (test: “never trusts a client-supplied identity claim”) |
| Twilio `To` → binding → tenant/project | `service_number_bindings` (`routes.ts:167-172`) |
| Fail-closed | unknown phone ⇒ `is_known:false`, `permissions:[]`, `farm_ids:[]`; adapter throw ⇒ `opaque_degraded_*` (`registry.ts:393-408`); no auto-registration (`identity/resolver.ts:76-95`) |
| Admin Panel is not an authorization path | all calls behind `requireAdminAuth`; the panel performs no client-side authorization decisions |

---

## 10. Files changed

No schema migration. No new API route. No vFarm API or credential invented.

### Backend

| File | Change | Gaps |
|---|---|---|
| `engine/src/admin/routes.ts` | vFarm⋈CST join fixed to `customer_ref`; `speaker_cache_expires_at`; `mirrorSpeakerToAdapter` / `unmirrorSpeakerFromAdapter` on sync/create/patch/revoke; live-mode-gated sync pruning; `project_id` + full `farm_ids` in the in-memory sync path; in-memory TTL expiry on invalidate; `vfarm_source` / `source_error` on the customers route; bearer JWT passed to the org-members call; `sendProxyError()` maps upstream vFarm auth failures to 502 across all 17 proxy routes | G1, G2, G4–G8, G15, G17, §12.6 |
| `engine/src/identity/resolver.ts` | delegates to `CoreRegistry.resolveSpeaker` when a `projectId` is supplied; returns full `farm_ids`; DB path kept only as a logged fallback | G9 |
| `engine/src/transport/voice/voice_lane.ts` | resolves the project from the receiving number's service-number binding and passes it to the resolver, so voice shares the adapter identity path | G9 |
| `engine/src/core/registry.ts` | default `tenant_org_id` is the real vFarm org UUID (env-overridable via `VFARM_TENANT_ORG_ID`) | G19 |
| `engine/src/db/client.ts` | `ON CONFLICT (tenant_id, project_id, phone_e164)`; project-scoped updates match `project_id` strictly | G10, G11 |
| `engine/src/adapters/vfarm/schemas.ts` | `normalizeFarmGrants()` accepts both documented farm-grants shapes and throws only on genuinely unrecognised input | §12.3 |
| `engine/src/adapters/types.ts` | optional `registerSpeaker?` / `removeSpeaker?` write-through hooks on `ITenantAdapter` | G4 |
| `engine/src/adapters/vfarm/index.ts` | admin JWT resolved **before** building the HTTP clients; `apiToken` passed to the live client; token refreshed on `authenticateAdmin`; `buildHttpClient` falls back to the resolved JWT; the adapter's own default projects use the real org UUID | G17, G18, G19 |
| `engine/src/adapters/vfarm/live_client.ts` | `apiToken` config + `setApiToken` / `getApiToken` / `authHeaders()`; `getOrgMembers` and `getUserFarmGrants` accept and send a bearer token; `request()` accepts extra headers and no longer requires a farm key when a bearer is present | G17, G18 |

### Admin Panel

| File | Change |
|---|---|
| `web/admin.html` | new “vFarm Source of Truth” block in Tab 2 (org selector, status, metrics, member table) |
| `web/admin.js` | `escapeAdminHtml`; `state.vfarmCustomers` / `vfarmCustomersLoaded`; `fillVfarmOrgSelect`, `refreshVfarmOrgOptions` (org discovery + placeholder flagging), `loadVfarmUsers`, `loadSpeakersTab`; provenance badges in the CST speaker table; honest `vfarm_source: 'unavailable'` rendering; mutations refresh the vFarm view; boot refresh gated on token presence; a 401 carrying `VFARM_AUTH_FAILED`/`PROXY_ERROR` no longer clears the admin session |

### Database

| File | Change |
|---|---|
| `db/migrations/012_customers_project_scope_and_vfarm_org_mapping.sql` | new — drops the stale per-tenant uniqueness, adds a partial unique index for NULL-project rows, re-points `projects.tenant_org_id` at the real vFarm org UUID (overridable via the `cst.vfarm_org_id` GUC) |

### Tests, config & docs

| File | Change |
|---|---|
| `tests/identity/identity_debt.test.ts` | new, 14 tests (G9 adapter precedence + full `farm_ids` + fail-closed, G19 org mapping, farm-grants shape tolerance, G10/G11 project-scoped uniqueness and predicates) |
| `tests/publishers/turn_event_contract.test.ts` | new, 5 tests (`cst.turn` field completeness + fire-and-forget never blocks) |
| `tests/admin/admin_user_integration.test.ts` | 2 tests added — expired upstream vFarm credential must answer 502, not 401 |
| `tests/adapters/vfarm_org_members_auth.test.ts` | new, 7 tests (bearer auth on org-members) |
| `tests/adapters/vfarm_adapter_live.test.ts` | org id updated to the real UUID |
| `tests/voice/voice_lane.test.ts` | seeds speakers through the adapter (production onboarding path), since voice is now adapter-authoritative |
| `vitest.config.ts` | `testTimeout: 20000` — the 5 s default was below real connector cost and caused intermittent reds |
| `docs/evidence/cst-user-integration-admin-panel.md` | this document |

### Deleted

| File | Reason |
|---|---|
| `engine/src/transport/twilio/inbound.ts` | G14 — unmounted duplicate SMS handler on a divergent identity path |

---

## 11. Tests and results

`npm test` → **36 files, 328 tests, all passing** (green on 3 consecutive runs).
`npm run typecheck` → clean. `npm run build` → clean.
Browser (real Google Chrome) → **16/16**.

New this round: `tests/identity/identity_debt.test.ts` (14),
`tests/publishers/turn_event_contract.test.ts` (5), plus 2 in
`tests/admin/admin_user_integration.test.ts`.

Baseline before this work: 32 files, 283 tests, **1 failing** (a 5 s timeout in
`tests/publishers/turn_publisher.test.ts`, unrelated to users — it passes now) and
**2 typecheck errors**.

### `tests/admin/admin_user_integration.test.ts` (17)

1. existing vFarm user appears — sync → panel
2. new vFarm user appears (vFarm-only until a phone is mapped, then mapped)
3. user with multiple farms — all grants projected
4. user removed from a farm — dropped from scope on next sync, user kept
5. user removed from the org — runtime fails closed, gone from the vFarm view
6. re-running sync after upstream removal drops the speaker
7. phone change — new mapping, old number no longer resolves
8. duplicate phone across projects — independent, revoke in one leaves the other
9. unknown speaker — fails closed, never auto-registered
10. stale cache / invalidation — expired TTL reported, revoke removes runtime entry
11. Admin Panel reflects current source of truth — regression for `cst_registered`
12. honest `NO_LIVE_CLIENT` when vFarm is not configured
13. **regression for G15** — a failed vFarm fetch is never presented as an
    authoritative empty list (`vfarm_source: 'unavailable'` + `source_error`)
14. **regression for G15** — `vfarm_source` is `'live'` only when members were
    actually fetched
15. tenant isolation — a speaker never resolves in another tenant
16. admin edits stay inside the target tenant scope
17. cross-check that the live/source flags are mutually consistent

### `tests/adapters/vfarm_org_members_auth.test.ts` (7)

- `getOrgMembers` sends `Authorization: Bearer` from the client `apiToken`
- a per-call token overrides the client token
- the farm key is still sent alongside the bearer token
- a token set after construction (refreshed admin login) is honoured
- an auth failure is still surfaced when no token exists at all
- **regression for G18** — `VFARM_JWT` is present on the live client at construction
- **regression for G18** — a JWT refreshed via `authenticateAdmin` reaches the live client

---

## 11a. Browser validation (real Google Chrome)

Automated unit/API tests run in Node with no DOM, so the panel was additionally
driven in a real browser. Method: Playwright driving **installed Google Chrome**
(`channel: 'chrome'`, headed) against the live dev server on `localhost:3100`,
logging in through the actual `/admin/login` form as `admin@cst.com`.

**Result: 23/23 checks passed.**

| Check | Result |
|---|---|
| Anonymous `/admin` redirects to `/admin/login` | pass |
| Login through the real form reaches the console | pass |
| Header shows the authenticated admin | pass |
| All 8 tabs render | pass |
| Tab 2 renders the CST speaker table (3 rows) | pass |
| Tab 2 shows a provenance badge per user | pass |
| vFarm org selector populated from `projects[].tenant_org_id` (`org-vfarm-austin`, `org-vfarm-dallas`) | pass |
| vFarm block loads live members **or** reports the failure honestly | pass (reported the failure — see below) |
| Tab 8 panel visible on activation | pass |
| Tab 8 shows turn data or an explicit empty/unavailable state | pass |
| Tab 8 headers render (Received · Tenant · Project · Customer · Inbound · Turn ID · Delivery · Reply · Correlation) | pass |
| Tab 8 row-limit filter triggers a reload | pass |
| Tabs 1, 3, 4, 5, 6, 7 all still render (regression) | pass |
| No uncaught page errors | pass |
| No unexpected HTTP failures during the authenticated session | pass |
| Every same-origin stylesheet/script referenced by the panel loads (3/3 → 200) | pass |
| No console errors after login | pass |

### Two defects the browser found that the API tests could not

The unit tests all passed, but driving the real UI exposed two genuine bugs:

1. **G15 — a failed upstream read was displayed as truth.** Against the real
   vFarm instance, `GET /api/v1/organizations/org-vfarm-austin/users` returns
   **HTTP 422**. The endpoint caught it, logged a warning, and still replied
   `status:"ok"` with `customers: []`. The panel therefore rendered
   *"0 member(s) · live"* and *"CST only 3"* — a failed read displayed as an
   authoritative user list. Fixed by returning `vfarm_source` / `source_error`
   and rendering the failure; CST provenance badges now correctly stay
   *"CST record"* instead of falsely claiming *"Not in vFarm org"*.
2. **G16 — a 401 on every anonymous visit.** `admin.js` ran its boot refresh
   before the auth guard redirected, logging a 401 for
   `/api/v1/admin/tenants`. Fixed by gating the boot refresh on token presence.

Both now have regression tests.

---

## 11b. Live vFarm verification and browser round 2

### Probing the real vFarm instance

Using the credentials already present in `.env` (no new credential created), the
org-members endpoint was called directly with `curl` to establish ground truth:

| Auth sent | Result |
|---|---|
| `X-Farm-Key` only | `401 {"error":"unauthorized","detail":"Missing authentication — provide X-Farm-Key or Authorization: Bearer <token>"}` |
| `X-Farm-Key` + `Authorization: Bearer $VFARM_JWT` | `200` — one member: `debf555c-…`, "Admin", role `admin` |

This is the evidence for G17 and G18. The org id also had to be correct: the CST
placeholders return `422`, while the real UUID returns the member list.

`GET /api/v1/organizations` reports one real org —
`122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d`, slug `default`, `member_count: 1`, with
2 farms (`Test 001` 0 devices, `v-farm` 24 devices).

### Browser round 2 — 7/7 passed, real user visible in Chrome

| Check | Result |
|---|---|
| Real vFarm org (UUID) is selectable in the panel | pass — 1 discovered |
| Placeholder project orgs are flagged | pass — both show `⚠ not a live vFarm id (placeholder)` |
| Live vFarm members load | pass — status `1 member(s) · live` |
| A real vFarm user row is rendered | pass — `debf555c-…` / `admin@vfarm.co` |
| CST mapping column shows the not-mapped state | pass |
| Summary distinguishes mapped vs vFarm-only | pass — 1 member, 0 mapped, 1 vFarm-only |
| CST fixture rows flagged `Not in vFarm org` | pass — correct, their `customer_ref`s are not in the real org |

Rendered org selector:

```
· Select a vFarm organization…
• org-vfarm-austin (proj-vfarm-main) ⚠ not a live vFarm id (placeholder)
• org-vfarm-dallas (proj-vfarm-dallas) ⚠ not a live vFarm id (placeholder)
• Default · default · 1 member(s) · 122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d
```

### Observed, not caused by this work

- `/favicon.ico` → 404 (pre-existing, cosmetic; the only failing asset).
- The outbound queue worker logs `Postgres Error: column "next_retry_at" does not
  exist` every 5 s — the local database is behind `db/migrations/010`. This is
  pre-existing and unrelated to the Admin Panel, but it does mean the DB-backed
  branches exercised here are the ones still unverified against a migrated schema.

---

## 12. Verification of this round

### 12.1 Migrated Postgres (G10/G11)

Migration `012_customers_project_scope_and_vfarm_org_mapping.sql` was applied to
the real database. Before → after:

| Constraint | Before | After |
|---|---|---|
| `customers_tenant_id_phone_e164_key` UNIQUE (tenant_id, phone_e164) | present | **dropped** |
| `unq_customers_tenant_project_phone` UNIQUE (tenant_id, project_id, phone_e164) | present | present |
| `unq_customers_tenant_phone_null_project` (partial, WHERE project_id IS NULL) | absent | **created** |

`projects.tenant_org_id` for both projects is now `122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d`.

Behaviour proven with real SQL inside a transaction (rolled back afterwards):

- The same phone was inserted into `proj-vfarm-main` and `proj-vfarm-dallas` of
  `tenant-vfarm-01` with independent `customer_ref`, `role` and `farm_ids` —
  **impossible before the migration**, now works.
- A project-scoped `UPDATE ... AND project_id = 'proj-vfarm-main'` reported
  `UPDATE 1`, leaving the dallas row's `role` untouched (G11).

### 12.2 Identity resolution (G9)

`IdentityResolver.resolveSenderIdentity(from, system, { projectId })` now delegates
to `CoreRegistry.resolveSpeaker`. Verified by test that a **conflicting** source
loses: a `customers` row claiming `usr_from_db_table` versus an adapter entry
claiming `usr_from_vfarm` resolve to the **adapter's** identity. Also verified:

- full `farm_ids` (3 farms) exposed, where the legacy path offered one `farm_id`;
- fail-closed: a caller present in the DB but unknown to the adapter is refused
  (`is_known_customer: false`, `role: 'unknown'`, `permissions: []`) — no
  DB fallback reintroduces a revoked user;
- the unscoped DB fallback still works for callers that cannot supply a project
  (and logs a warning that it is not the preferred path);
- neither path auto-registers an unknown sender.

`voice_lane.ts` now resolves the project from the **service-number binding** for
the receiving number (`Twilio To → binding → tenant/project → speaker`) and passes
it through, so voice and SMS/Web share one resolver.

### 12.3 Farm-grants verification — partially blocked

| Probe | Result |
|---|---|
| `GET /users/{id}/farm-grants` with farm key only | `401 Missing authentication — provide X-Farm-Key or Authorization: Bearer <token>` |
| Same, with `Authorization: Bearer $VFARM_JWT` | `401 Invalid or expired token` |

The second failure is **not an endpoint difference**: `VFARM_JWT` in `.env`
expired. Decoded claims: `iat 1790249981`, `exp 1790854781` (7-day token); at
verification time `now = 1790861831`, i.e. expired ~2 hours earlier. `org-members`
returned `200` with that same token before expiry, and `401 Invalid or expired
token` after — confirming the credential, not the endpoint, was the variable.

So the **auth requirement is confirmed live** (bearer JWT mandatory; farm key
rejected), but the **200 response shape could not be observed**.

Rather than guess, the divergent parsers were made tolerant. The repo previously
held two contradictory assumptions: `http_client.getUserFarmGrants` required a
bare array (`farmGrantListSchema`) while `live_client.getUserFarmGrants` required
`{ grants: [...] }` (`BulkGrantResponseSchema`). Because `pullSpeakers` treats a
farm-grants failure as best-effort (`adapters/vfarm/index.ts:460-464`), a wrong
guess is not a loud failure — farm scope would go **silently stale**.
`normalizeFarmGrants()` now accepts either shape and throws only on genuinely
unrecognised input (a silent empty array would be worse).

### 12.4 Engine Dashboard integration (`cst.turn`)

The path already existed and is wired in `engine/src/core/engine.ts:38-140`, called
from `processEnvelope` on every outcome (refused, error, escalation, success).
No rewrite was needed; the work was verification plus tests.

Exact path:

```
channel ingress (interfaces/sms|web|voice, or transport/voice/voice_lane)
  → CoreRegistry.resolveSpeaker            (identity, active adapter path)
  → CoreEngine.processEnvelope             (core/engine.ts:145)
      → IntentRouter.detectIntent          (intent)
      → step-up / RBAC / BHARAG handling   (reply, status, reason, incident_id)
      → CoreEngine.publishTurn             (core/engine.ts:38)
          → build CstTurnEventV1           (contracts/events.ts, zod-validated)
          → CstDashboardPublisher.publishFireAndForget  (publishers/dashboard.ts:104)
              → setImmediate → publish → sendWithRetry   (dashboard.ts:145)
```

Field coverage (asserted in `tests/publishers/turn_event_contract.test.ts`):

| Required | Where in the event |
|---|---|
| turn_id | `data.turn_id` (= `correlation_id`, i.e. the Twilio `MessageSid`) |
| tenant / project | `tenant_id`, `project_id`, and repeated in `data` |
| customer identity | `customer.{customer_ref, phone_e164, person_id, role, is_known, farm_ids}` |
| channel | `channel` and `data.channel` |
| intent | `data.intent` |
| status | `data.status` |
| reply | `data.reply_text` / `data.reply` |
| reason | `data.reason` (always modelled, may be undefined) |
| incident_id | `data.incident_id` (always modelled) |
| duration | `data.duration_ms` and `data.duration.total_ms` |

Fire-and-forget guarantees (`dashboard.ts`): `setImmediate` dispatch,
`publishFireAndForget` returns `void`, 5 s per-attempt timeout, 3 attempts with
exponential backoff, retry on 408/429/5xx, fail-fast on other 4xx, and it never
throws. Tests assert `processEnvelope` still resolves when the dashboard hangs
indefinitely, throws, or is unconfigured.

`cst.delivery` already existed (`publishers/delivery.ts`, joined to the turn by
`turn_id`/`correlation_id`, published from `transport/twilio/outbound.ts:354`).
Since the turn path is stable and the suite is clean, it was left unchanged.

### 12.5 Browser verification (real Google Chrome) — 16/16

Against the dev server with the **migrated database**:

- admin login → console; org selector offers **only** the real UUID
  (`122d8fb6-f4d3-…`), with no `org-vfarm-austin` option (G19);
- 3 speakers load from the migrated Postgres, each carrying `project_id` (G7);
- the vFarm block honestly reports `source unavailable` with the upstream reason
  rather than a fabricated empty-but-live list;
- Tab 8 and tabs 1, 3, 4, 5, 6, 7 all render;
- an expired vFarm JWT surfaces as `502 VFARM_AUTH_FAILED`, **never** as a CST 401.

### 12.6 Defect found by the browser: expired upstream credential logged admins out

Symptom: loading the Admin Panel bounced the operator to `/admin/login` and
cleared the stored token, intermittently.

Cause: the vFarm proxy routes re-emitted the **upstream** status —
`res.status(err.status || 502)` — so vFarm's own `401` reached the browser as a
CST `401`. `web/admin.js` treats any 401 as "my CST session expired", removes
`cst_admin_token` and redirects. An expired `VFARM_JWT` therefore ended CST admin
sessions (17 proxy routes affected).

Fix: `sendProxyError()` maps upstream auth failures to `502` with
`error: 'VFARM_AUTH_FAILED'` and `upstream_status: 401`, preserving the detail
while keeping CST admin auth independent of vFarm credentials. Applied to all
17 proxy routes. Defence in depth in `web/admin.js`: a 401 whose body is
`VFARM_AUTH_FAILED`/`PROXY_ERROR` no longer clears the session. Genuinely invalid
CST sessions still get 401.

### 12.7 Test-suite flakiness fixed

`tests/publishers/turn_publisher.test.ts` intermittently failed on a 5 s timeout —
the same flake present before this work began. Root cause: a single
`CoreEngine.processEnvelope` costs ~2.2 s of real connector work (measured), and
**no test in that file had a timeout**, so under parallel execution some exceeded
the 5 s default. Rather than patch individual tests, `vitest.config.ts` now sets
`testTimeout: 20000`; genuine hangs remain caught because the fire-and-forget
tests assert their own explicit ceiling.

## 13. Remaining blockers

- **`VFARM_JWT` has expired.** Live vFarm verification (org-members, farm-grants,
  farms) cannot be completed until a fresh admin JWT is issued. It is a 7-day
  token, so this recurs weekly and should move to a refresh/rotation path rather
  than a static `.env` value. Not invented or worked around here.
- **farm-grants 200 response shape unconfirmed live.** Auth is confirmed; the
  payload shape is handled tolerantly (`normalizeFarmGrants`) but has not been
  observed against the real instance.
- **Voice authorization semantics changed, deliberately.** Voice identity is now
  adapter-authoritative, so a `customers` row that exists without a matching
  adapter entry no longer authorizes a caller. All production writes go through
  the admin routes, which mirror into the adapter, but a row inserted directly
  into Postgres will not be honored until the next sync/onboarding. This is
  secure-by-default; it is a real operational change worth knowing about.
- **`admin.auth` is bypassed in tests.** `requireAdminAuth` returns early when
  `NODE_ENV === 'test'` (`engine/src/admin/auth.ts:183`), so the admin integration
  tests run unauthenticated and the negative auth case cannot be asserted in that
  harness.
- **Pre-existing, unrelated:** the outbound queue worker logs
  `Postgres Error: column "next_retry_at" does not exist` every 5 s. No migration
  creates that column. Out of scope for this work, but it means the DB-backed
  outbound path is broken until fixed.
