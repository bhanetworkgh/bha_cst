# CST Approval Requests & External Evidence Matrix

**Prepared by:** Ahad (`U0AC6RFNP3P`)
**Prepared:** 2026-10-20
**Status:** **DRAFTS ONLY — NOT SENT.** Nothing in this document has been posted to Slack, emailed, or sent to any customer. Each draft requires the named owner's action.

**Companion records:** [`docs/task.md`](../task.md) · [`docs/release/CST_MASTER_TASK_AUDIT.md`](CST_MASTER_TASK_AUDIT.md) · [`docs/release/cst-5r0j-security-audit-and-residual-risk.md`](cst-5r0j-security-audit-and-residual-risk.md)

---

## How to use this document

Each request below states: **what is needed**, **why**, **the exact evidence to return**, **which task ID it unblocks**, and **risk if not actioned**. Copy the fenced block verbatim into Slack or email. Do not send without the owner's approval to send.

---

## 1. Jason / Platform — Deployment authorisation for the security and voice build

**Status: A DEPLOY IS NOW NEEDED — and it has a precondition that must be met first.**

**What is needed (in this order):**
1. **Set `CST_API_KEY` in the Render dashboard.** Generate with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and
   store it in 1Password (`BHA Render Production Vault`). **This must be set
   BEFORE the deploy** — the programmatic voice guard fails closed, so deploying
   without it leaves five routes returning 503.
2. **Authorise the deploy** of the uncommitted working tree.
3. **Confirm the migration 020 approval** (see the risk note below).

**Why:** the concern that originally opened this item is resolved — the live
deploy is `b06c68fc5950e56ba140df892929d32c1a78e07a` (`dep-dbb7gl9srm7s73dc8phg`,
2026-10-19T20:06:45Z), identical to the repository HEAD, and the Twilio `12300`
fix (`ac387be`) **is** live. But the working tree now carries changes that are
**not** deployed and that close a real exposure:

| Change | Why it must ship |
|---|---|
| Programmatic voice guard on **five** routes (`/api/v1/voice/turn`, `/api/v1/voice/synthesize`, `/api/v1/voice/status`, `/voice/turn`, `/audio/speak`) | These were anonymously callable. `/api/v1/voice/turn` and `/voice/turn` trust a caller-asserted `from_e164` and resolve the speaker's farm scope from it. |
| `verifyTwilioSignature` on the Twilio-hosted voice status routes | They carried **no** middleware at all. |
| `sms_voice` combined capability on the owned service number, and `matchesCapability` in every capability check | A number that serves both transports could not use either lane. |
| Seed placeholder `eleven_voice_jason_vfarm` replaced with the env-resolved pointer | Removes the invalid-voice fallback. |
| `messagingServiceSid` preferred for A2P routing | Avoids Twilio error 21659 on a number not directly owned. |
| Migration `020_dashboard_publish_outcomes.sql` | Makes Dashboard publish outcomes durable, so a dropped evidence event can be found and replayed. |
| Phone-number masking in retained audit records | Customer numbers were being written into `SECURITY_LEDGER` entries. |

**Migration risk (please read):** migration 020 is **additive** — it creates one
table and three indexes and touches no existing table and no customer data. It
runs automatically on startup because the service's `startCommand` is
`node scripts/migrate.js && npm start`. It has **not** been applied to
production and **will** be applied by this deploy.

**Evidence to return:** confirmation that `CST_API_KEY` is set, and written
authorisation for the deploy.

**Unblocks:** `LOOP-1791243473841-02JU`, `LOOP-1792186847775-63MS`, the 5R0J
production acceptance, and the Dashboard verification plane.

**Risk if not actioned:** the five programmatic voice routes stay anonymously
callable in production, and the Twilio-hosted status routes stay writable
without a signature.

> **Draft — Jason**
>
> **Two steps, in this order: set `CST_API_KEY`, then authorise the deploy.**
>
> **1. `CST_API_KEY` — before the deploy, not after.** The programmatic voice API is now behind a shared secret that **fails closed**. If the variable is absent, five routes (`/api/v1/voice/turn`, `/api/v1/voice/synthesize`, `/api/v1/voice/status`, `/voice/turn`, `/audio/speak`) return 503. The engine still boots and everything else keeps working — I deliberately did not make it abort, because that would take the signed Twilio webhooks, the health endpoints and the outbound worker down with it. But those five routes would be closed until you set it. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and store it in 1Password under `BHA Render Production Vault`.
>
> **2. Deploy authorisation.** Correction to my earlier message: nothing needed deploying *then*, and that was right — the live deploy was already `b06c68f` (= HEAD) with the Twilio `12300` fix live. **Now there is something to deploy**, because the working tree carries a security fix that is not live:
>
> - **Five** programmatic voice routes were anonymously callable. Two of them (`/api/v1/voice/turn` and `/voice/turn`) trust a caller-asserted `from_e164` and resolve the speaker's farm scope from that number — so an anonymous caller could have asserted a known vFarm member's number and received that member's farm-scoped answer. The Twilio-hosted voice status routes also had no signature check. All are now behind the guard, with 21 focused tests.
> - A service number that serves both SMS and voice could not use either lane; the capability checks now understand the combined capability.
> - The seeded project pointed at an invalid ElevenLabs voice placeholder; it now resolves from the environment.
> - Outbound SMS now prefers the messaging service SID, which avoids Twilio 21659.
> - Customer phone numbers were being written into retained audit records; they are now masked.
> - **Migration 020** makes Dashboard publish outcomes durable, so a dropped evidence event can be found and replayed instead of being lost when the log rotates.
>
> **Migration 020 is additive** — one new table and three indexes, no existing table touched, no customer data migrated — and it runs on startup because the start command is `node scripts/migrate.js && npm start`. Please note that as an approval item. It has not been applied to production and will be applied by this deploy.
>
> **The standing hazard:** `autoDeploy: yes` on `commit` for branch `main` means **a push to `main` is a production deployment and a production migration**, with no staging branch. Before this push I will run `npm run typecheck && npm test && npm run build && git diff --check` and read migration 020 end to end. Rollback is Render dashboard → Rollback to a previous deploy; migrations are forward-only, so a bad migration is fixed forward, never by editing an applied file.
>
> If you'd prefer a manual-approval deploy gate for CST, say so and I'll prepare it as a change request.

---

## 2. Jason / Platform — Verified Twilio From number, reachable handset, authorization for one real voice call

**What is needed:**
1. A **verified** Twilio `From` number (the current one fails with Twilio `21210` "From is not a valid phone number").
2. A **reachable handset** owned by an authorized tester, able to speak and to hear.
3. **Explicit written authorization** to place exactly one outbound call.
4. Confirmation of the intended destination number.

**Why:** the voice lane has **never been exercised in production**. The previous attempt was refused at call creation, so there is **no Call SID, no transcript, and no two-way speech proof**. Local coverage is 94/94, but a unit test is not a call. The webhook side of the path is now correct (the `12300` fix is live) and unproven in anger.

**Exact evidence to return:** Call SID; the greeting was spoken; the caller's spoken query was captured; the agent's generated response was spoken back; the call did not disconnect unexpectedly; tenant/project resolution was correct; the transcript was persisted; and the sanitized server log lines.

**Unblocks:** `LOOP-1791243473841-02JU`, `DW-1792186179087-EWQI`, `DW-1792187689082-B0M2`, `LOOP-1792186847775-63MS`.

**Risk if not actioned:** the voice channel cannot be represented as ready. For vFarm onboarding and support, voice is the highest-value channel for customers who cannot or prefer not to use SMS, and it stays unproven indefinitely.

**Before the call — one check to run first.** `engine/src/core/registry.ts:185-194` (live since `b06c68f`) falls back to the literal string `'eleven_voice_jason_vfarm'` — **not a valid ElevenLabs voice ID** — if `VFARM_ELEVENLABS_VOICE_ID` / `ELEVENLABS_VOICE_ID` are unset *and* the `proj-vfarm-main` row's `elevenlabs_voice_id` is empty. Migration 019 is applied and should have populated that row with `Hmy97GCI840wuICQesiM`, but the row value is not independently verifiable from outside the database. If the row is empty, the call will fail at the ElevenLabs boundary with `SYNTHESIS_FAILED`. **Confirm the row value (or set the env var) before placing the call.** A single query is in §4.

> **Draft — Jason**
>
> I need three things to close CST voice acceptance, and one thing to check first.
>
> **Needed:**
> 1. A **verified** Twilio `From` number. The current one is rejected at call creation with Twilio `21210` ("From is not a valid phone number"), so no call has ever connected.
> 2. A **reachable handset** with an authorized tester who can speak and hear.
> 3. **Written authorization to place exactly one outbound call** to a destination number you nominate. The runner places one call, no retries, numbers masked, no secrets printed.
>
> **What the call must produce to count as accepted:** a Twilio Call SID; the greeting spoken; the caller's spoken query captured; the agent's response spoken back; no unexpected disconnect; correct tenant/project resolution; the transcript persisted; and the sanitized server log lines. A 200 from the webhook or a simulated request does not count, and I will not report it as if it did.
>
> **Check first (important, and it may be why a first attempt fails):** the live registry backfill in `engine/src/core/registry.ts` falls back to a placeholder string `'eleven_voice_jason_vfarm'` if `VFARM_ELEVENLABS_VOICE_ID` / `ELEVENLABS_VOICE_ID` are unset and the `proj-vfarm-main` row's `elevenlabs_voice_id` is empty. That is not a real ElevenLabs voice ID, and it would make the call fail at synthesis with `SYNTHESIS_FAILED` rather than fail loudly on configuration. Migration 019 is applied and should have set the row to the correct clone, but I cannot read the row from here (the DB IP allowlist is empty). Could you either confirm the `elevenlabs_voice_id` value for `proj-vfarm-main`, or set `VFARM_ELEVENLABS_VOICE_ID` in the Render environment? I can also run the one-line query in §4 if you grant DB access.
>
> **Note:** `autoDeploy` is on for `main`, so I'm not pushing anything while we do this.

---

## 3. Jason / Platform — SMS recipient, test window, and `messages_out` read access (the ~40-minute delay)

**What is needed:**
1. An **approved test recipient** and an **approved test window** for exactly one live SMS.
2. **Read access to `messages_out`** (either add Ahad's IP to the DB allowlist, or have an authorized operator run the queries in §3.1 and return the output).
3. **Explicit authorization before the message is dispatched.**

**Why:** the reported ~40-minute delivery delay is **unexplained by CST's own code**, and the code inspection rules out the two obvious causes:

- `engine/src/server.ts:48` — the outbound worker polls every **5 seconds**. A 40-minute queue age is not a polling-interval problem.
- `engine/src/transport/twilio/outbound.ts` — in-process retry backoff is `2^attempt` **seconds** (2 s, then 4 s at 3 attempts). Not 40 minutes.

The remaining candidates all live in production data nobody can currently read: a row parked with a future `next_retry_at` (migration 014), a non-retriable provider error recorded on the row (e.g. `21215` geo-permission — the code stores these self-describing), Render free-tier hibernation between enqueue and dispatch, or carrier-side filtering after Twilio accepted the message. **Inferring the cause from intervals alone is not acceptable, and the infrastructure should not be upgraded before the evidence points there.**

**Exact evidence to return:** the output of the §3.1 queries (read-only `SELECT` only), plus the delivery-callback history for the affected `provider_sid` values, so "CST sent late" can be separated from "Twilio accepted late" from "carrier delivered late".

**Unblocks:** `LOOP-1792452150303-J2F6`, `LOOP-1791467054702-NI8F`.

**Risk if not actioned:** SMS is the primary customer channel and its A2P registration risk cannot be retired without one real round trip. An unexplained 40-minute delay on a live number is a support-ticket generator whose root cause is still unknown.

> **Draft — Jason**
>
> Two asks on SMS: one diagnostic, one live test.
>
> **1. The ~40-minute delay — I need read access, not a guess.** I inspected the CST path end to end and the two obvious causes are ruled out: the outbound worker polls every **5 seconds** (`engine/src/server.ts:48`) and the in-process retry backoff is **2–4 seconds** (`engine/src/transport/twilio/outbound.ts`). Neither produces a 40-minute delay, so capacity and plan limits are *not* the indicated cause and I am not recommending an infrastructure upgrade yet.
>
> What remains is production data nobody can currently read: a row parked with a future `next_retry_at`, a stored provider error (the code records things like `21215` geo-permission self-describing on the row), Render free-tier hibernation between enqueue and dispatch, or carrier-side filtering after Twilio accepted the message.
>
> **Could you either add my IP to the DB allowlist, or have an authorized operator run the read-only queries in §3.1 and send me the output?** All `SELECT`, no writes, and the queries mask phone numbers.
>
> **2. One live SMS.** I'd like to send exactly one message to an approved test recipient in an approved window, to get the provider message ID and the delivery-status callback. Consent for a real carrier round trip needs an approved recipient and window — I won't send anything without both, and I won't send anything before that authorization.
>
> This also retires the A2P 10DLC exposure: we're currently carrying traffic risk on numbers that have never completed an end-to-end round trip.
>
> Note: the consent gate itself is working and I am not touching it. `canSendSms` re-checks consent at *dispatch*, not just at enqueue, and the `consent_exempt` bypass is fenced to platform-originated messages from a project-bound DID. 38/38 consent tests pass. The gap is carrier proof, not enforcement.

---

## 4. Jason / Platform — DB allowlist / bastion, schema verification, and the Postgres Starter decision

**What is needed — three separate items:**

| # | Need | Deadline | Owner |
|---|---|---|---|
| 4a | DB IP allowlist entry for Ahad, **or** a bastion/operator to run the §4.1 read-only SQL | Before the real voice call (voice pointer check) and before closing HOFE | Jason / Platform |
| 4b | **Written approval** for the Render Postgres **Starter** plan ($7/mo) and a maintenance window | **Before 2026-11-14T18:10:20Z** | Jason |
| 4c | Confirmation of the exact approval path for any future plan change (4b covers it) | — | Jason |

**Why:**

- **(4a)** The DB IP allowlist is empty — Render reports "IP allow-list: empty (external connections blocked)" and direct psql exits with `IP address (103.120.71.129) not in allow list`. That blocks *independent* schema verification: a migration ledger line is a record of intent, **not proof** that the constraints, indexes, foreign keys, and triggers actually exist. It also blocks the voice-pointer check in §2 and the delay diagnosis in §3.
- **(4b)** The expiry is now confirmed authoritatively from the Render API, not inferred: `expiresAt: 2026-11-14T18:10:20.49769Z`, `plan: free`, `createdAt: 2026-10-15T18:10:20.49769Z` — exactly the 90-day free-tier limit. After that instant the service loses its database. The plan, the `pg_dump` pre-flight export, the 5–10 minute cutover window, the post-cutover validation SQL, and the rollback steps are already written in `docs/release/cst-database-continuity-plan.md`. **This is the item closest to a hard deadline.**

**Exact evidence to return:** the §4.1 query output, and a written approval for 4b with a named window.

**Unblocks:** `LOOP-1791826143428-HOFE`, `DW-1791829227726-96O8` (policy decision also needed), `LOOP-1792104121807-XXHH`, and the voice pointer check in §2.

**Risk if not actioned:** on 14 November the production database is deleted. Every conversation transcript, consent record, voice delivery row, and outbound message record goes with it, and there is no plan-tier automatic backup on the free tier.

> **Draft — Jason**
>
> Three things, one of which has a hard deadline.
>
> **1. The deadline: Postgres expires 14 November.** I confirmed it from the Render API rather than from an old note: `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`), plan `free`, `createdAt 2026-10-15T18:10:20.49769Z`, `expiresAt 2026-11-14T18:10:20.49769Z` — exactly the 90-day free-tier limit. At that instant the database is deleted, and the free tier has no automatic backup. Conversations, consent records, voice delivery rows, and outbound message history all live there.
>
> The upgrade plan is ready: `pg_dump` pre-flight export, a 5–10 minute cutover window, post-cutover data-validation SQL, and rollback steps, all in `docs/release/cst-database-continuity-plan.md`. **I need your written approval for the Starter tier ($7/mo) and a named maintenance window.** 25 days remain. I have not changed the plan and will not trigger any billing without your approval.
>
> **2. DB read access.** The IP allowlist is empty — Render reports "IP allow-list: empty (external connections blocked)" and a direct psql attempt is refused by IP. That means I can only confirm migrations 017/018/019 from the startup ledger, which is a *record of intent*, not independent proof that the constraints, indexes, foreign keys, and the append-only trigger actually exist. **Either add my IP to the allowlist, or have an authorized operator run the read-only SQL in §4.1 and send me the output.** The same access unblocks the voice-pointer check and the SMS delay diagnosis, so it's the highest-leverage single access grant we can make.
>
> **3. A policy decision on `DW-96O8`:** does CST v1 acceptance require production-only schema evidence, or is a staging verification acceptable? That decision is yours, and it determines whether item 2 blocks the 31 October launch or not.
>
> For reference, `0 applied, 20 already recorded` in the startup log means every migration file, including 019, is recorded as applied — which is a ledger statement, not an object-level proof.

---

## 5. Jason / Platform — DNS/TLS for the two CST hostnames

**What is needed:**
1. Add the custom domain(s) in the **Render dashboard** → `bha-cst` → Custom Domains. Target: `bha-cst-7u9e.onrender.com` (the service's own URL, confirmed via the Render API `serviceDetails.url`).
2. Create the corresponding **CNAME at GoDaddy** — `bhanetwork.org` is served by `ns09/ns10.domaincontrol.com`, so the record must be created there, not at Render.
3. Once the CNAME resolves, Render provisions and auto-renews the TLS certificate.

| Hostname | Current DNS | Action |
|---|---|---|
| `cst.bhanetwork.org` | **no A, no AAAA, no CNAME** | CNAME → `bha-cst-7u9e.onrender.com` |
| `cst-admin.bhanetwork.org` | **no A, no AAAA, no CNAME** | CNAME → `bha-cst-7u9e.onrender.com` |

**Why:** measured 2026-10-20T12:00:58Z — both names fail to resolve, so TLS cannot even be attempted ("Could not resolve host"). Every internal link, operator shortcut, and any customer-facing surface pointed at those names is dead. A working custom domain with a valid certificate is also the precondition for Twilio webhook signatures to be verifiable against a stable hostname rather than a Render subdomain.

**Note on tooling:** the Render CLI has **no custom-domain subcommand** (`render services` offers only create/delete/instances/update), so the domain must be added in the dashboard. `render services update` must **not** be used for this — it edits service configuration.

**Exact evidence to return:** `dig +short cst.bhanetwork.org` and `cst-admin.bhanetwork.org` returning the CNAME/A record, and `curl -sv https://cst.bhanetwork.org/health` showing a valid certificate chain.

**Unblocks:** `LOOP-1790439082267-OYP9`.

**Risk if not actioned:** CST remains reachable only on a Render subdomain. No customer-facing or stable hostname exists, and the operator shortcuts in the playbook point at names that do not resolve.

> **Draft — Jason**
>
> The two CST custom domains don't exist in DNS. I checked at 12:00:58Z today: `cst.bhanetwork.org` and `cst-admin.bhanetwork.org` both return no A, no AAAA, and no CNAME, so TLS can't even be attempted — the connection fails with "Could not resolve host".
>
> **Two steps, and the second one isn't at Render:**
> 1. Add the custom domain in the Render dashboard → `bha-cst` → Custom Domains. The CNAME target is `bha-cst-7u9e.onrender.com` (the service's own URL).
> 2. Create the CNAME at **GoDaddy** — `bhanetwork.org` is on `ns09/ns10.domaincontrol.com`, so the record has to live there. Render then provisions and auto-renews the certificate.
>
> I can't do either step myself: the Render CLI has no custom-domain command (only create/delete/instances/update), and DNS changes are production config. Please also don't use `render services update` for this — it edits service configuration, and the domain belongs in the dashboard.
>
> Why it matters: CST is currently only reachable on a Render subdomain. Beyond cosmetics, a stable hostname with a valid certificate is the precondition for Twilio webhook signatures to verify against something other than a Render subdomain, and the operator shortcuts in the playbook point at names that don't resolve.
>
> To confirm it's working, `dig +short cst.bhanetwork.org` should return a record and `curl -sv https://cst.bhanetwork.org/health` should show a valid certificate chain.

---

## 6. Destiny — 5R0J formal acceptance, vFarm gateway log review, and the Operator Playbook drill

**What is needed:**
1. **Formal acceptance of `LOOP-1790790007707-5R0J`** (or a rejection with reasons).
2. A decision on **whether the deployment-lineage evidence (§6.1) is accepted as a substitute** for the Render log window the CLI cannot reach.
3. A decision on **whether credential rotation is required** (now a policy call, not an automatic remediation step).
4. **One-line confirmation** that no non-Render deployment of CST existed between 2026-09-25 and 2026-10-07.
5. **vFarm API Gateway log review** (Query 3) by whoever holds gateway log access.
6. **Publication slot** for the Operator Playbook SOP and a **simulation-drill date**.

**Why:** the technical work is done and the evidence has moved. Live re-verification on 2026-10-20T11:56:13Z returned 401 on all eight gated endpoint variants, and 403/401 (fail-closed, no CST credential substitution) with a synthetic invalid bearer token. The 5R0J audit's §4.1 now bounds the exposure window by deployment lineage, and the Render-side log query returned **zero** successful (200/304) requests to any gated endpoint across the retrievable window.

**Exact evidence to return:** (a) the acceptance decision and its reasoning; (b) the gateway log result for `service_client:"cst-engine"`; (c) the one-line confirmation; (d) a drill date; (e) publication confirmation for Codex → SOPs and BHARAG `sop/bays-cst-operations`.

**Unblocks:** `LOOP-1790790007707-5R0J`, `LOOP-1791848474090-Y5TW`, `DW-1791852954583-46HC` (closure), and `LOOP-1789824812431-IWKX` (release readiness input).

**Risk if not actioned:** the loop stays open with an unbounded "pending review" status even though the reviewable scope has narrowed to one external log system plus one confirmation line. A2P and customer-trust posture both depend on consent and security being formally closed, not merely locally green.

> **Draft — Destiny**
>
> 5R0J is ready for your decision, and the evidence has moved since the 19 Oct report.
>
> **Re-verified live today (2026-10-20T11:56:13Z):** all eight gated endpoint variants return 401 unauthenticated — `/api/devices`, `/api/v1/devices`, `/api/farms`, `/api/v1/farms`, `/api/dashboard`, `/api/v1/dashboard`, `/api/tokens`, `/api/v1/tokens`. With a synthetic invalid bearer token, the farm-key routes (`/api/devices`, `/api/dashboard`) return **403** and the JWT-scoped routes (`/api/farms`) return **401 "vFarm rejected the supplied credentials"** — i.e. the caller's token is forwarded verbatim and CST's own credentials are never substituted. There is no anonymous path and no `NODE_ENV` bypass, so the 26/26 regression suite can't go vacuous.
>
> **I also corrected two errors in my own 19 Oct report.** The middleware table named `requireVfarmProxyAuth` / `requireAdminAuth` — neither name exists in the code; the real gates are `requireVfarmAdminSession` and `requireVfarmAdminSessionOrJwt`. And the reported deployed SHA `3e88058` was stale: the live deploy is `b06c68f`, matching HEAD, with migration 019 applied. Both are fixed in `docs/release/cst-5r0j-security-audit-and-residual-risk.md` with the change log kept.
>
> **The historical-exposure question is now bounded, not open-ended.** The authentication gate was committed 2026-10-07 — **8 days before the production Render service was created** (2026-10-15T18:11:51Z) — and it is an ancestor of that service's *first successful* deploy. So no production deploy of CST ever ran the unauthenticated code. The code-level window where the routes were unauthenticated (2026-09-25 → 2026-10-07) predates the service's existence. On the Render side, the log query for any successful (200/304) request to a gated endpoint returned **zero** rows.
>
> **Two honest limits.** First, the Render CLI's log retention only reaches back to 2026-10-19T18:07:30Z, so the pre-2026-10-15 window is not retrievable from my side — an operator with Log Explorer access can extend it, or we can accept the lineage evidence. **That is your call, not mine.** Second, the one log I genuinely cannot reach is the **vFarm API Gateway** (Query 3) — it's the system that would show whether CST's farm key was ever used to serve tenant data to an unauthorized caller. That's now the single highest-value open technical item.
>
> **What I need from you:**
> 1. Formal acceptance or rejection of `LOOP-1790790007707-5R0J`.
> 2. Your decision on accepting the deployment-lineage evidence in place of the unreachable Render log window.
> 3. Your decision on **credential rotation**. I've deliberately not rotated anything: rotation is itself a disclosable event, and now that the exposure window is bounded, it should follow the gateway log review rather than precede it.
> 4. One-line confirmation that no non-Render deployment of CST existed between 2026-09-25 and 2026-10-07.
> 5. Whoever holds vFarm gateway log access to run Query 3.
>
> **Operator Playbook (Y5TW):** the draft is complete in the repository and contains no secrets, tokens, passwords, or raw credentials. I corrected several factual errors in it on 20 Oct — wrong adapter path, wrong admin console path, a non-existent `migrate.js --dry-run` flag, a stale test-helpers path, an outdated migration range, and the wrong Render admin account handle — and added the two sections that were missing for operational handover: **rollback & incident handling**, and **evidence collection & sanitization** (including the rule that a migration ledger line is not proof of a schema object, and the masking rules before anything is shared). It still needs publication to Codex → SOPs and BHARAG `sop/bays-cst-operations`, and then your unannounced blocker-triage drill. **I'm not claiming it's operationally tested until that drill is actually run and logged.**

---

## 7. Jegan — BHARAG cluster-key scope: negative, positive, and policy evidence

**What is needed — three artifacts, and the third is the one that actually matters:**

| # | Artifact | Expected result | Why it cannot be substituted by a CST-side test |
|---|---|---|---|
| 7a | **Negative test** — the CST cluster key cannot retrieve a known farm-specific sensor / alert / vision record | Denial or empty scope. A refusal, not a generic answer. | CST strips `farm_id`/`unit_id` from the general-knowledge payload and never falls back to BHARAG for farm telemetry, but CST cannot control what the upstream key can reach. |
| 7b | **Positive test** — permitted general-help content remains reachable through the same key | Success with legitimate content. | A key that is blocked from everything is not a security posture; it breaks the support channel. |
| 7c | **Policy / workspace / index scope proof** for the CST cluster key | Documented upstream authorization showing enforcement, not merely an optional request field. | Request-field omission is client-side hygiene. Only upstream policy makes it a guarantee. |

**Why:** KMG9's CST-side work is complete and locally verified — the BHARAG cluster-ask fallback was removed from the farm-specific telemetry path, the intent classifier routes farm-state questions to the fail-closed vFarm path, and `farm_id`/`unit_id` are no longer sent on the general-knowledge path. 9/9 regression tests pass. **But CST-side isolation cannot guarantee upstream enforcement**, and the KMG9 gate cannot be closed on local tests alone.

**Exact evidence to return:** the request/response pair (with the farm identifiers masked) for 7a and 7b, and the policy or configuration excerpt for 7c.

**Unblocks:** `LOOP-1788044070647-KMG9` closure, `DW-1792186179087-EWQI`, `LOOP-1790985133889-8D7U` (clone-quality gate Step 2), and one of the three `IWKX` external gates.

**Risk if not actioned:** the guarantee stays "CST will not send farm identifiers to BHARAG" rather than "farm data cannot be reached through the cluster key". Those are different claims, and only the second one is a security boundary.

> **Draft — Jegan**
>
> KMG9 needs the BHARAG-side evidence to close. The CST side is done and locally verified — I removed the cluster-ask fallback from the farm-specific telemetry path, hardened the intent classifier so farm-state questions route to the fail-closed vFarm path, and stopped sending `farm_id`/`unit_id` on the general-knowledge path. 9/9 regression tests pass.
>
> **But CST-side isolation can't guarantee upstream enforcement**, so I can't close the gate on our tests alone. Three artifacts, and the third is the one that actually matters:
>
> 1. **Negative test** — the CST cluster key cannot retrieve a known farm-specific sensor/alert/vision record. Expected: denial or empty scope, *not* a generic answer. (Farm identifiers masked is fine.)
> 2. **Positive test** — permitted general-help content is still reachable through the same key. Expected: success. A key blocked from everything isn't a security posture, it breaks the support channel.
> 3. **Policy / workspace / index scope proof** for the CST cluster key — showing upstream *enforcement*, not just an optional request field. This is the one that actually closes the boundary: not sending farm identifiers is client-side hygiene, and only upstream policy makes it a guarantee.
>
> If any of the three fails, please send me the failing request/response and I'll fix the CST side — I'd much rather find that now than during a customer's escalation.
>
> Separately, and small: you're waiting on Hardik for the named Onshape revision for the P1.0 document so `cad_revision` can be written against `config_hash`. That one's on him, not on you.

---

## 8. Relevant owners — KMG9 environment smoke tests and the remaining four-part CST v1 acceptance evidence

**What is needed — the four-part CST v1 acceptance, with the environment smoke tests called out separately.**

### 8.1 KMG9 environment smoke tests (`LOOP-1788044070647-KMG9`)

| # | Environment | Case | Expected | Actual | Evidence to return | Owner |
|---|---|---|---|---|---|---|
| 1 | Staging | vFarm **up** | Farm-specific status answered from vFarm telemetry for the caller's own bound farm; **no** BHARAG cluster-ask call in the logs | | request id, sanitized log line, and a log excerpt showing no `cluster/ask` | Jason (instructions already prepared) |
| 2 | Staging | vFarm **down** / degraded | `telemetry_unavailable`; **no** BHARAG fallback; no generic cluster answer | | sanitized log line showing the fail-closed path | Jason |
| 3 | Production | vFarm **up** | As #1, against `https://bha-cst-7u9e.onrender.com` | | same | Jason |
| 4 | Production | vFarm **down** / degraded | As #2, against production | | same | Jason |
| 5 | Production | Cross-tenant access attempt | Request for another farm/unit is refused with an audited refusal and **no** data in the response | | `SECURITY_LEDGER` entry (redacted) | Jason |

Existing instructions: `docs/release/cst-kmg9-live-test-instructions.md`.

### 8.2 The four-part CST v1 acceptance evidence (`LOOP-1789824812431-IWKX`)

| Part | Gate | What must be proven | Current state | Owner |
|---|---|---|---|---|
| 1 | **Deployment** | The deployed commit is the intended commit, and the build path is the one in `render.yaml` | **PROVEN** — live deploy `b06c68f` = HEAD; `npm ci --include=dev && npm run build`; migrations run on startup | closed by Ahad |
| 2 | **Live channel** | One real voice call and one real SMS, end to end | **BLOCKED** — no call ever connected; no SMS ever sent | Jason (§2, §3) |
| 3 | **vFarm grant** | Live vFarm user→farm→unit grant resolves correctly through the admin console and the SMS/voice rails | **PARTIAL** — code and 4/4 admin tests pass; live grant not exercised | Jason |
| 4 | **Four-pillar integration + traceability** | CST turn, delivery, incident, and audit records join end to end and are reproducible | **PARTIAL** — publishers, monotonic guard, and audit ledger verified locally (618/624); live Dashboard ingestion **never proven** (the 6 `dashboard_real_proof.test.ts` tests need `REAL_DASHBOARD_PROOF=1` with a live Dashboard and have never been run) | Jason + BHARAG/Dashboard owner |

**Explicitly NOT requested here:** the six real-dashboard proof tests will not be run without an approved test environment and explicit approval. They are gated in code and remain skipped.

> **Draft — Jason (and the BHARAG/Dashboard owner for part 4)**
>
> Here's the complete acceptance picture for CST v1, split into the four parts and with the environment smoke tests called out, so nothing is implied that isn't been proven.
>
> **Part 1 — Deployment: proven.** Live deploy `b06c68f` = `main` HEAD (deploy `dep-dbb7gl9srm7s73dc8phg`, 2026-10-19T20:06:45Z); build is `npm ci --include=dev && npm run build`; migrations run on startup and the ledger reads `0 applied, 20 already recorded`. Closed.
>
> **Part 2 — Live channel: blocked, and it's the real gap.** No voice call has ever connected and no SMS has ever been sent. That needs the three things in my other message (verified Twilio number, handset, authorized recipient + window) plus the SMS/voice DB access. 94/94 voice tests and 38/38 consent tests pass, but that is not a call and not a carrier round trip, and I won't present either as one.
>
> **Part 3 — vFarm grant: partial.** The grant model and the vFarm Users & Grants console are implemented and covered by 4/4 admin tests, and the live vFarm adapter is confirmed connected in production (`[vFarm] Initialized with Live Key`). But a live grant has not been exercised end to end through the admin console and the SMS/voice rails. That needs your access to a live farm.
>
> **Part 4 — Four-pillar integration and traceability: partial, and I want to be explicit about the gap.** The publishers, the monotonic status guard, the `cst.turn`/`cst.delivery` contracts, the incident path, and the audit ledger are all verified locally. **Live Dashboard ingestion has never been proven** — the six `dashboard_real_proof.test.ts` tests are gated behind `REAL_DASHBOARD_PROOF=1` with a real `ENGINE_DASHBOARD_URL` and `ENGINE_DASHBOARD_KEY`, and they have never been run. I am not going to enable them against production on my own authority. If you can give me an approved Dashboard test environment and say go, I'll run them and return the three events; otherwise this stays marked as unproven rather than quietly green.
>
> **KMG9 environment smoke tests** are in the table in §8.1 — vFarm up and down, in staging and production, plus a cross-tenant refusal, each with a request id and a sanitized log excerpt. The instructions already exist at `docs/release/cst-kmg9-live-test-instructions.md`. Jegan's cluster-key scope evidence (§7) is the other half of that gate.
>
> The 31 October target is not blocked on more engineering. It's blocked on access, hardware, and four sign-offs.

---

## Appendix A — Read-only operator queries (for §3 and §4)

### A.1 SMS delay diagnosis (§3.1)

**Read-only. No writes. Run against `bha_cst_1sh0` on `dpg-db8he2qvcj2c73ado3s0-a`.**
Phone numbers are masked; no credentials or keys are selected.

```sql
-- A.1.1 Recent outbound messages with queue-age and retry diagnostics.
--      status values actually written by the worker: pending | queued | sending |
--      sent | delivered | failed | undelivered | refused
SELECT
  left(id, 8)                        AS message_id,
  tenant_id,
  project_id,
  right(to_e164, 4)                  AS to_masked,
  status,
  retry_count,
  created_at,
  next_retry_at,
  left(provider_sid, 12)             AS provider_sid_prefix,
  left(coalesce(error_message, ''), 120) AS provider_error,
  EXTRACT(EPOCH FROM (NOW() - created_at)) / 60   AS age_minutes_now,
  CASE WHEN next_retry_at IS NOT NULL
       THEN EXTRACT(EPOCH FROM (next_retry_at - created_at)) / 60
       ELSE NULL END                  AS scheduled_wait_minutes,
  sent_at
FROM messages_out
WHERE created_at > NOW() - INTERVAL '14 days'
ORDER BY created_at DESC
LIMIT 200;

-- A.1.2 Messages that sat longer than 10 minutes between creation and send.
--      This is the direct test for the reported ~40-minute delay.
SELECT
  left(id, 8) AS message_id,
  right(to_e164, 4) AS to_masked,
  status,
  retry_count,
  created_at,
  sent_at,
  ROUND(EXTRACT(EPOCH FROM (sent_at - created_at)) / 60, 2) AS minutes_to_send,
  left(coalesce(error_message, ''), 160) AS provider_error
FROM messages_out
WHERE sent_at IS NOT NULL
  AND sent_at - created_at > INTERVAL '10 minutes'
  AND created_at > NOW() - INTERVAL '14 days'
ORDER BY sent_at - created_at DESC;

-- A.1.3 Status distribution and failure reasons over the window.
--      A spike in 'refused' with a provider_error would indicate a capability,
--      consent, or tenancy gate rather than a delay.
SELECT status,
       count(*)                        AS n,
       min(created_at)                 AS oldest,
       max(created_at)                 AS newest,
       count(DISTINCT left(coalesce(error_message,''), 60)) AS distinct_errors
FROM messages_out
WHERE created_at > NOW() - INTERVAL '14 days'
GROUP BY status
ORDER BY n DESC;

-- A.1.4 Delivery-status callbacks observed for the same window.
--      This separates "CST sent late" from "Twilio accepted late" from
--      "the carrier delivered late".
SELECT
  right(to_e164, 4) AS to_masked,
  delivery_status,
  count(*)         AS n,
  min(created_at)  AS oldest,
  max(created_at)  AS newest
FROM messages
WHERE created_at > NOW() - INTERVAL '14 days'
  AND delivery_status IS NOT NULL
GROUP BY delivery_status, right(to_e164, 4)
ORDER BY n DESC;
```

### A.2 Schema verification (§4.1)

**Read-only. Confirms migrations 017/018/019 independently of the migration ledger.**
This is the check that turns "the ledger says applied" into "the objects exist".

```sql
-- A.2.1 Consent spine tables and columns.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('sms_consents', 'sms_consent_audit', 'sms_consent_prompts')
ORDER BY table_name, ordinal_position;

-- A.2.2 Constraints: expect fk_sms_consent_audit_consent and
--      unq_sms_consents_id_tenant.
SELECT conname, contype, conrelid::regclass::text AS relation
FROM pg_constraint
WHERE conname IN ('fk_sms_consent_audit_consent', 'unq_sms_consents_id_tenant')
ORDER BY conname;

-- A.2.3 Indexes: expect unq_sms_consent_prompts_active and
--      idx_sms_consent_prompts_active_lookup.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('unq_sms_consent_prompts_active', 'idx_sms_consent_prompts_active_lookup')
ORDER BY indexname;

-- A.2.4 The append-only trigger on sms_consent_audit.
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgname = 'trg_sms_consent_audit_append_only'
  AND NOT tgisinternal;

-- A.2.5 Voice pointer for proj-vfarm-main (migration 019). *** THIS IS THE
--      CHECK NEEDED BEFORE THE FIRST REAL VOICE CALL. *** If this returns
--      'eleven_voice_jason_vfarm' or NULL, the call will fail at synthesis.
SELECT project_id,
       elevenlabs_voice_id,
       elevenlabs_model_id,
       voice_enabled
FROM projects
WHERE project_id = 'proj-vfarm-main';

-- A.2.6 Migration ledger for the consent migrations (context only — a ledger
--      line is NOT proof of the objects above).
--      Table/columns verified against scripts/migrate.js:124-134
--      -> schema_migrations(filename, checksum, applied_at)
SELECT filename, applied_at
FROM schema_migrations
WHERE filename LIKE '016%' OR filename LIKE '017%'
   OR filename LIKE '018%' OR filename LIKE '019%'
ORDER BY filename;
```

> **Note.** §A.2.6's table and column names were verified against `scripts/migrate.js:124-134` — the ledger is `schema_migrations(filename, checksum, applied_at)`. §A.2.1 through §A.2.5 read PostgreSQL catalogs directly and do not depend on the ledger's shape at all.

### A.3 5R0J log queries (§6, also in the 5R0J audit §4.2)

```bash
# Query 1 — successful (200/304) requests to any gated endpoint.
#           2026-10-20 run: ZERO rows returned.
render logs -r srv-db8hepqvcj2c73adpus0 \
  --path "/api/devices,/api/v1/devices,/api/farms,/api/v1/farms,/api/dashboard,/api/v1/dashboard,/api/tokens,/api/v1/tokens" \
  --status-code "200,304" --limit 500

# All hits on the gated paths regardless of status (expect 401 refusals only).
render logs -r srv-db8hepqvcj2c73adpus0 \
  --path "/api/devices,/api/v1/devices,/api/farms,/api/v1/farms,/api/dashboard,/api/v1/dashboard,/api/tokens,/api/v1/tokens" \
  --limit 500

# Query 2 — credential material appearing in a URL path/query string.
render logs -r srv-db8hepqvcj2c73adpus0 --text "token="  --limit 200
render logs -r srv-db8hepqvcj2c73adpus0 --text "jwt="    --limit 200
render logs -r srv-db8hepqvcj2c73adpus0 --text "secret=" --limit 200
```

**Measured retention ceiling:** the CLI reaches back only to **2026-10-19T18:07:30Z** (168 rows retrievable). `--start` filters earlier than that return zero rows. An operator with Render **Log Explorer** access can search further back.

---

## Appendix B — Request summary

| # | Request | Owner | Unblocks | Deadline |
|---|---|---|---|---|
| 1 | Deployment status correction + pre-push checklist (nothing to deploy) | Jason | `02JU`, `63MS` | none |
| 2 | Verified Twilio number, handset, one-call authorization, voice-pointer check | Jason | `02JU`, `EWQI`, `B0M2`, `63MS` | next checkpoint |
| 3 | SMS recipient + window + `messages_out` read access | Jason | `J2F6`, `NI8F` | next checkpoint |
| 4 | DB allowlist/bastion + **Postgres Starter approval (before 14 Nov)** + `DW-96O8` policy | Jason / Platform | `HOFE`, `96O8`, `XXHH` | **2026-11-14** |
| 5 | DNS/TLS for `cst.*` and `cst-admin.*` | Jason / Platform | `OYP9` | before 31 Oct launch |
| 6 | 5R0J acceptance + gateway log review + rotation decision + drill date | Destiny | `5R0J`, `Y5TW`, `46HC`, `IWKX` | next checkpoint |
| 7 | BHARAG cluster-key scope: negative, positive, policy proof | Jegan | `KMG9`, `EWQI`, `8D7U` | 2 business days |
| 8 | KMG9 environment smoke tests + four-part v1 acceptance evidence | Jason + Dashboard owner | `KMG9`, `IWKX` | 2 business days |

---

*Prepared 2026-10-20. Nothing in this document has been sent. All production access used to compile it was read-only.*
