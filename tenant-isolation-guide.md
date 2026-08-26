# Tenant Isolation Guide - bha-cst (Customer Service Twin)

For: Ahad (+ Syed) · From: Jegan · Date: 2026-08-26
Home: this file ships in `bha-cst/docs/tenant-isolation-guide.md`
Sources: SPEC-VFARM-001 (vFarm Tenancy & Genie Gating v1, approved by Jason 2026-08-21),
GAP-AUTH-01 (the 27-route leak), bha-cst architecture spec v1.0 §10.

Read this before writing any code. The transport module you own is one of the two front doors
into this system (the other is the admin panel), and both must follow the same isolation rules
from the first commit.

---

## 1. Why this guide exists: GAP-AUTH-01, the cautionary tale

On 2026-08-17 a sweep of vFarm's 57 live GET routes with a *zero-grant JWT* (a real login with
no roles and no orgs at all) found *27 routes returning real tenant data with no check*. Worst
cases: `/readings/export` streamed 30 days of any sensor's history to nobody, and `/users`
returned the full user directory. Root causes were mundane: routes that only verified the API
key and never checked permission, and a permission helper with an "if no farm_id, allow"
branch.

Two lessons you must carry into CS Twin:

1. Isolation failures are not exotic. They are a missing middleware call and a default that
   allows instead of refuses.
2. The fix is structural, not per-route: ONE shared gate that every request passes through, so
   there is one place to audit and one place to get right.

## 2. The vFarm model (the template we copy)

vFarm's approved model, in five pieces:

*Hierarchy.* `org -> farm -> workspace`. Each farm is isolated: its own workspace, sensor
stream, logs, incidents.

*Roles.*

| Role | Sees | Never |
|---|---|---|
| farm_admin | their farm(s) in their org | any other farm or org |
| regional_ops | a named group of farms in ONE org | cross-org |
| bha_admin | across farms + orgs, every cross-farm read logged | silent access |
| viewer | read-only within granted scope | writes |

*The one rule.* Scope is resolved SERVER-SIDE from the caller's verified identity. Never from
tool arguments, never from the UI, never from anything an LLM produced. Every tool fails
closed: unresolved scope means refuse, never "all."

*The gate.* A single shared middleware resolves `(org_id, farm_ids, role)` from the JWT before
any tool runs, and every query is scoped to that. If an argument names a farm outside the
resolved set, the answer is `403 TENANT_SCOPE_VIOLATION` and nothing is read. A jailbroken
prompt can change the QUESTION, never the SCOPE.

*Impersonation.* A bha_admin supporting a farm runs INSIDE that farm's exact view and the
ledger row says `role: bha_as_farm` with the real actor. There is no silent super-view.

*Logging.* Every request writes a typed ledger row: org, scope, actor, role, entry_point,
lane, tool, outcome (`ok | refused | error`). `refused` rows are the tripwire: a spike means a
probe or a gate regression.

SPEC-VFARM-001 §6 makes this a standing rule: every new front door in BHA MUST reuse this
pattern and extend the vocab. CS Twin is a new front door. This guide is that reuse.

## 3. How it maps to bha-cst

| vFarm | bha-cst |
|---|---|
| org / farm | tenant (= system; vFarm is tenant #1) |
| workspace | the tenant's conversation space (conversations, messages, queues) |
| farm_admin | tenant_admin (their tenant's config + conversations) |
| regional_ops | (dormant for now, same as vFarm shipped it: defined, unused until needed) |
| bha_admin | cst_super_admin (creates tenants; cross-tenant reads logged) |
| bha_as_farm | super_as_tenant (support runs inside the tenant's view, logged) |
| viewer | viewer |
| JWT identity -> org/farms/role | panel: member identity -> tenant_id/role. Transport: receiving NUMBER -> owning tenant (systems registry) |
| the shared resolver middleware | one shared scope middleware in engine/, used by BOTH front doors |

The transport door is special and it is yours, so be precise about it: an inbound SMS carries
no JWT. Its identity chain is `receiving number -> systems registry -> tenant`, then
`sender phone -> that tenant's resolve endpoint -> customer_ref`. Two hard rules fall out:

- The receiving-number lookup IS the tenancy decision for inbound. If the number is not in the
  systems registry: refuse (log, no reply). Never guess a default tenant.
- The Twilio signature check is part of isolation, not just security hygiene: an unsigned or
  bad-signature webhook is an unauthenticated caller trying to write into a tenant's
  conversation store. Reject before touching anything.

Everything downstream is stamped: every row in conversations, messages, messages_in,
messages_out carries `tenant_id`, and every query filters by the server-resolved tenant, never
by anything the request body claims.

## 4. The enforcement checklist (apply to every PR)

- [ ] Scope comes from the shared middleware (panel: member identity; transport: number ->
      systems registry). No route resolves scope on its own. No second code path.
- [ ] Fail closed everywhere: unresolved tenant, unknown number, missing membership, empty
      scope -> refuse. There is no "if no tenant_id, allow" branch anywhere. That exact branch
      caused 2 of GAP-AUTH-01's 27 leaks.
- [ ] `tenant_id` is NOT NULL on every table that holds tenant data, and present in every
      WHERE clause. No global reads outside super-admin paths.
- [ ] Cross-tenant argument check: any id supplied by a caller (conversation_id, customer_ref,
      queue item) is verified to belong to the resolved tenant before use, else 403 and a
      refused row.
- [ ] The admin panel's tenant picker changes what the UI requests, never what the server
      allows. (This is the exact super-admin picker gap Destiny flagged in the BHARAG incidents
      UI. We do not rebuild it here.)
- [ ] Impersonation only through the explicit super_as_tenant path, logged with the real actor.
- [ ] Typed log row per request: tenant_id, actor (member or customer_ref or twilio), role,
      entry_point (`webhook | admin_panel | api`), tool/route, outcome (`ok | refused | error`).
      Ledger events to BHARAG carry opaque customer_ref only, never a phone number.
- [ ] Secrets: only Bitwarden refs in the DB, values in memory only, nothing in the repo.
      (vFarm's tile list includes a hard-coded bypass key that had to be pulled from a repo.
      We start clean.)
- [ ] Rate limiting and allowlists are server config, never a client-set header; count real
      proxy hops rather than trusting X-Forwarded-For (two more vFarm tiles that bit them).

## 5. Tests that PROVE isolation (write these with the feature, not after)

1. *Cross-tenant 403.* Tenant A agent requests a tenant B conversation id: 403, nothing read,
   one refused row logged.
2. *Unresolved scope refusal.* Authenticated member with no tenant membership hits every
   endpoint: refused on all. This is the zero-grant sweep that found GAP-AUTH-01, run as a
   standing test instead of a one-off audit.
3. *Unknown receiving number.* Inbound webhook to a number not in the systems registry:
   refused + logged, no conversation row created, no reply sent.
4. *Bad signature.* Inbound webhook with an invalid X-Twilio-Signature: rejected before any
   DB touch.
5. *Unknown sender path.* Valid number, unknown sender phone: the tenant's configured
   onboarding/lead reply fires; no customer data is guessed; conversation is tagged
   unresolved-identity.
6. *Picker does not widen scope.* Super admin selects tenant A in the panel, hand-crafts a
   request for tenant B data with the same session: server refuses unless the explicit
   super-admin path (which logs) is used.
7. *Impersonation visibility.* A super_as_tenant session produces rows attributable to the
   real actor, and its view is byte-identical to what the tenant_admin would see.
8. *Outbound cannot cross.* A messages_out row whose to_e164 belongs to another tenant's
   customer is refused at the worker (the worker re-checks tenant ownership before send).

Definition of done for the transport module now includes tests 3, 4, 5, and 8 green.

## 6. Where to look in vFarm while you build

- SPEC-VFARM-001 (Plan folder: vfarm/2026-08-21-spec-vfarm-tenancy-genie-gating-v1.md, also
  as PDF) - the model, the tool-gate table, the three example ledger rows, the edge-case tiles.
- GAP-AUTH-01 (vfarm/2026-08-17-GAP-AUTH-01-27-route-leak.md) - the route-by-route anatomy of
  the leak; read the two causes, they are the two bugs this guide's checklist forbids.
- bhavfarm repo: docs/vfarm_atlas/subsystems/03-auth-orgs-tenancy.md and the auth middleware
  (auth_middleware.py) - see how the single resolver is placed, then mirror the placement in
  engine/ (TypeScript) rather than the code.

## 7. Start here (your first week against this guide)

1. Read this guide + SPEC-VFARM-001 §0-§3. Post questions in the CS twin thread; unclear is
   free now and expensive later.
2. Build the transport module against the frozen contract (webhook in, outbound worker), with
   the number->tenant lookup and signature rejection as the FIRST code paths, and tests 3, 4,
   5, 8 alongside.
3. When Jegan's scaffold lands (shared scope middleware + systems registry + `handle()` stub),
   your module plugs into the middleware; nothing in your code should need to change except
   the import.
