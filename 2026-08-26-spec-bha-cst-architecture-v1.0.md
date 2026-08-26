# SPEC - bha-cst (Customer Service Twin) architecture v1.0

Date: 2026-08-26 · subsystem: CUSTOMER_TWIN · status: DECIDED direction (Jegan, in session)
Builds on: 2026-08-26-spec-customer-service-twin-architecture-v0.1.md (component map + tenancy
reasoning stand; this doc supersedes v0.1 on three points, listed below).

Decisions folded in from Jegan today:
1. Separate system, multi-tenant the way BHARAG is. The tenant unit is called a *system*;
   vFarm is system #1.
2. Incidents are NOT stored in bha-cst. The incident system already exists in RAG (BHARAG
   incidents.v0); CST files incidents there and keeps only the reference.
3. bha-cst has two parts, like bharag: an *engine* (API + workers) and an *admin panel*.
   (v0.1 said the staff view lands in vFarm UI; superseded - CST owns its own panel,
   vFarm UI deep-links to it.)

---

## 1. Shape of the system

```
bha-cst
├── engine/          TypeScript/Express + Postgres + workers (same stack as bharag)
│   ├── transport/   Twilio webhook + outbound worker (Ahad + Syed, §11 contract)
│   ├── identity/    resolve caller via the owning system's API (vFarm first)
│   ├── router/      intent routing: status / knowledge / images / escalate
│   └── connectors/  per-system: vFarm APIs, BHARAG ask + incidents, media server
└── admin/           React admin panel (like bharag /ui)
```

A *system* is a registered tenant: it brings its own phone number, its own identity resolver,
its own BHARAG workspace key, and its own escalation rules. Onboarding the next customer-facing
twin means registering a system, not writing a new service.

## 2. What bha-cst HOLDS, and why

| Data | Why it lives here and nowhere else |
|---|---|
| *Systems registry* - system_id, name, status; per-system config: Twilio number + messaging-service SID ref, identity-resolve endpoint URL + key ref, BHARAG workspace key ref, media base URL, escalation rules | This IS the multi-tenancy, same role workspaces play in RAG. Config is per system because every tenant brings its own number and its own system of record |
| *Conversations* - conversation_id, system_id, customer_ref (opaque id from the owning system), channel (sms/whatsapp/voice-later), state (open/waiting/closed), incident_refs[] | The conversation is the one thing CST owns. customer_ref is opaque: CST never stores the phone-to-person mapping, it re-resolves through the system's API |
| *Messages* - direction, body, media_ref, provider_sid (Twilio), delivery status, timestamps | Transcripts are PII; keeping them ONLY here is what keeps BHARAG common and clean |
| *Transport queues* - messages_in, messages_out, retries, dead-letter | Ahad's §11 contract needs a durable seam between webhook and logic; same DLQ discipline as the rest of the engine |
| *Routing rules per system* - which intents auto-answer, which escalate, canned replies, quiet hours | Behavior differs per tenant; it is config, not code |
| *Admin users + roles* - panel logins, per-system scoping, super-admin | Separate service means its own auth, mirroring the bharag console model (super-admin sees all systems, system staff see theirs) |
| *Audit log* - who read/replied/closed what, manual takeovers | Customer-facing lane; every staff action must be attributable |

## 3. What bha-cst does NOT hold, and why (the boundaries)

| Not held | Lives in | Reasoning |
|---|---|---|
| Incidents / tickets | *BHARAG incidents.v0* (existing incident system) | Decided today: we already have an incident system - ledger, lifecycle, history, boards, Genie/NS/RT read it. CST duplicating it would split the truth Jason's inspection and monitoring story depends on. CST files via its own workspace key (shared mailbox model), subsystem=CUSTOMER_TWIN, engine typed per system (e.g. engine=VFARM), customer_ref opaque, and stores only incident_id on the conversation. Escalation = incident row + the existing alert/paging path; resolution state is read back from the ledger to tell the customer |
| Phone ↔ customer ↔ unit mapping | The owning system (vFarm server customer registry) | The number association is a vFarm-domain fact behind vFarm auth. CST resolves per message, caches nothing durable |
| Device / farm truth | vFarm server APIs | CST always reads live; a stale copy of monitoring state answering a customer is worse than no answer |
| Knowledge / docs | BHARAG RAG corpus | Already the engine's knowledge substrate; CST asks with its workspace key |
| Images | Media server (S3 + media API) | CST passes short-lived signed URLs, never copies media |
| Twilio creds in code | Bitwarden -> env vars | Key policy; per-system messaging config holds references, not secrets |

## 4. How the pieces talk (per message)

1. Twilio -> `POST /webhooks/twilio/sms` (engine/transport): verify signature, dedup MessageSid,
   normalize, enqueue, 204.
2. identity/: look up which system owns the receiving number (systems registry), call that
   system's resolve endpoint (`GET vfarm/api/v1/customers/resolve?phone=` with the scoped key)
   -> customer_ref + unit context. Unknown number -> the system's configured onboarding/lead reply.
3. router/: intent -> connector:
   - status -> vFarm read APIs (unit-scoped)
   - knowledge -> BHARAG ask (CST workspace key)
   - images -> media server signed URL
   - escalate/fault -> *file incident in BHARAG incidents.v0* (subsystem=CUSTOMER_TWIN,
     engine=VFARM, opaque customer_ref), store incident_id on the conversation, trigger the
     existing alert path
4. Reply -> messages_out -> transport outbound worker -> Twilio (retries, segmenting,
   delivery callback logged). Everything written to conversations/messages.

## 5. Admin panel (what it shows, per system)

- Thread list + live conversation view; manual takeover / staff reply; close/reopen.
- Incident links on a conversation: deep-link into the existing BHARAG incidents UI - the panel
  does not re-render incident lifecycle, it links to the system that owns it.
- System config: numbers, resolve endpoint, workspace key ref, routing rules, canned replies.
- Metrics v1: open conversations, first-response time, escalation rate per system.
- Auth: CST's own logins; super-admin across systems, staff scoped to their system.
  vFarm UI gets a deep-link ("Support threads") rather than an embedded copy.

## 6. Engine integration summary (who reads/writes what)

- CST -> vFarm: resolve-by-phone + unit status + open alerts. Scoped service key, read-only.
- CST -> BHARAG: ask (knowledge) + incidents.v0 write/read. One CST workspace key per system
  keeps attribution clean on the shared ledger.
- CST -> media server: signed URL fetch only.
- vFarm -> CST (v1.1, worth planning now): an outbound-notify API so vFarm alerts can message a
  customer proactively through the same rail ("your pump incident is resolved") - the alert
  subsystem gets a customer channel without touching Twilio itself.
- Genie/NS/RT: read the lane through the ledger events + incidents, as with every other lane.
  No direct DB access into CST, ever.

## 7. Build order (unchanged for Ahad, one addition for Jegan)

1. Ahad + Syed: transport module against the frozen §11 contract (webhook in, outbound worker,
   round-trip done bar). Unchanged.
2. Jegan: bha-cst scaffold (engine + admin skeleton), `handle()` stub, conversations/messages DDL,
   systems registry with vFarm seeded as system #1; vFarm resolve-by-phone endpoint (static seed
   v0); mint the CST workspace key in BHARAG.
3. Wire escalation to incidents.v0 (file + read-back) - this replaces the v0.1 "ticket store" step.
4. Admin panel v1: thread list + conversation view + manual reply.
5. Then: intent routing config, BHARAG ask wiring, media URLs, vFarm outbound-notify API,
   voice (Kaiqi) and WhatsApp as additional transports.

## 8. Open items

- Repo name final (bha-cst suggested) + deploy target.
- Twilio number + messaging-service SID [fill] into the vFarm system config.
- Incident read-back contract: which incidents.v0 status transitions trigger a customer-facing
  message (needs a short agree with Destiny, since his error-handler patterns write the same ledger).
- Admin panel auth: fresh users vs reusing an existing SSO - decide at scaffold time.
