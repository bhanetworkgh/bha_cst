# CST Readiness Reply — Draft for Jason, Destiny and Bays

> **STATUS: DRAFT — NOT SENT.** Nothing in this file has been posted to Slack. Per the operating rules, no Slack message is sent and no decision watch is closed on anyone's behalf. This is a copy-ready draft for the owner to review and send.

**Task:** `LOOP-1790790007707-5R0J` (5R0J) · `LOOP-1791826143428-HOFE` (HOFE) · `LOOP-1791467054702-NI8F` (NI8F) · VJU6 (verification plane)
**Prepared by:** Ahad (`U0AC6RFNP3P`) · 2026-10-20
**Evidence report:** [`docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md`](CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md)
**Ledger:** [`docs/task.md`](../task.md)
**Closure report (supersedes the test numbers below):** [`docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md`](CST_REMAINING_GAPS_CLOSURE_REPORT.md)

> ## ⚠ UPDATE — 2026-10-20T14:45Z (read before sending)
>
> This draft was prepared at ~12:30Z and has since been **extended and partly corrected**. Changes:
>
> 1. **The programmatic voice API fix was incomplete.** A full route inventory found **two further unauthenticated programmatic voice routes** the earlier fix missed — `POST /voice/turn` (the same caller-asserted-`from_e164` impersonation path) and `POST /audio/speak` (caller-chosen `voiceId`). Both are now behind the same guard, with 21 focused tests. The §1 paragraph below that said the fix covered the exposure was **too narrow** and is superseded by the closure report §3.1.
> 2. **The guard was failing closed silently.** It now reports a missing `CST_API_KEY` once at boot and writes a `SECURITY_LEDGER` entry — deliberately without aborting the process.
> 3. **Customer phone numbers were in retained audit records.** The consent refusal entries carried the full recipient number; they are now masked to the last four digits, and the pre-existing admin mask (which hid only one character) was replaced by a shared helper.
> 4. **New evidence for 5R0J:** the repository has **no CI workflow, no Dockerfile, no Terraform, no Kubernetes manifest, no Procfile and no deploy script** — `render.yaml` is the only deployment manifest in the tree.
> 5. **New gap for VJU6:** a failed dashboard publish is logged but **not persisted**, there is no dashboard dead-letter table in any of the 19 migrations, and the monotonic delivery guard is an in-memory map lost on restart. Documented, not started (it needs a migration).
> 6. **Test numbers are now 645 passed / 6 skipped / 0 failed across 63 files** (was 628/6/0). §4 below is superseded by the table in the closure report §5.
>
> **The copy-ready draft text in the "Draft message" section below has been updated in place to carry these corrections.**

---

## Draft message

Hi Jason, Destiny — CST production-readiness record for 5R0J, HOFE/NI8F and the verification plane. Everything below is reproducible from `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md` and `docs/task.md`. No approvals, deploys, production changes, migrations, rotations, calls or SMS were made.

**First, a correction to my own earlier report.** The deployed commit is **`b06c68f`**, not `3e88058` — verified via the Render API. All four commits from 19 Oct are live, and migration 019 is applied (`0 applied, 20 already recorded`). My earlier "deploy 4 commits" recommendation came from a stale 19 Oct 13:53Z note that I carried forward without re-checking, even though the Render CLI was available. So the deployment gap I raised does not exist, and the Twilio `12300` content-type fix is already live. The voice gap is operational, not a deploy: the call was refused at creation with Twilio `21210` because our From number is unverified.

---

**1) 5R0J — security**

Route-by-route, from the actual middleware in `engine/src/app.ts` (not the intended design):

| Route | Actual middleware | No credential | Invalid caller vFarm JWT | Admin JWT fallback? |
|---|---|---|---|---|
| `/api/devices`, `/api/v1/devices` | `requireVfarmAdminSession` | 401 | 403 | **No** |
| `/api/dashboard`, `/api/v1/dashboard` | `requireVfarmAdminSession` | 401 | 403 | **No** |
| `/api/farms`, `/api/v1/farms` | `requireVfarmAdminSessionOrJwt` | 401 | 401 (upstream rejected) | **No** |
| `/api/tokens`, `/api/v1/tokens` | `requireVfarmAdminSessionOrJwt` | 401 | 401 (upstream rejected) | **No** |

Re-verified live **2026-10-20T11:56:13Z** — all eight variants 401, and with a synthetic invalid bearer token the farm-key routes return 403 while the JWT routes return 401 "vFarm rejected the supplied credentials". **There is no credential substitution and no legacy fallback**: the middleware grants only a valid CST admin session (the caller's own authority) or the caller's own JWT, forwarded verbatim. Two corrections to my 19 Oct audit: it named `requireVfarmProxyAuth` and `requireAdminAuth`, and **neither name exists in the code**; the real gates are the two above. It also had the deployed SHA wrong.

**Credential rotation: none has been performed, and I can prove only this much.** There is no rotation record in the repo, and the key values were never in the repo, so I cannot compare pre-patch and current credentials. What I can now say with evidence is that **no production deploy ever ran the unauthenticated code** — the auth gate was committed 2026-10-07 and the production service was created 2026-10-15T18:11:51Z, eight days later, and the gate is an ancestor of that service's first successful deploy. So rotation is now a **policy decision for the two of you**, not an automatic remediation step, and I would rather it follow the gateway log review than precede it — rotation is itself a disclosable event and it would break live vFarm integrations.

**One new piece of evidence that bounds the deployment question:** the repository contains **no CI workflow, no Dockerfile, no Terraform, no Kubernetes manifest, no Procfile and no deploy script** — `render.yaml` is the only deployment manifest in the tree, and `package.json` has no deploy target. So "a non-Render production deployment existed" is now bounded by repository evidence rather than by assertion. The residual is a deployment from an unregistered copy of the source, which only you two can confirm.

**The historical review is not closed, and I am not presenting it as closed.** The Render CLI's log window only reaches back to 2026-10-19T18:07:30Z, so the pre-2026-10-15 period is not retrievable from my side. Query 1 (any 200/304 on a gated path) returned **zero rows** in the window I can see. That leaves exactly one external source, and it is the vFarm side: **the API Gateway log for the CST service client over 2026-09-25 → present**, showing every read made with CST's farm key or admin JWT with the farm ids touched, plus the key's issuance/rotation history. That is the only place that can answer "was tenant data ever served to an unauthorized caller". Destiny — I also need your decision on whether the deployment-lineage evidence above is accepted in place of the unreachable Render window, or whether someone with Log Explorer access searches further back. Jason — one line confirming no non-Render CST deployment existed between 2026-09-25 and 2026-10-07 would close that gap.

**One new P0 that was outside the 5R0J route list, so it was never in scope — and it is now fixed locally. My first fix was incomplete, and I am correcting that here.** Five programmatic voice routes were mounted with **no authentication at all** (confirmed live: an empty body gets 400/404, not 401/403). `POST /api/v1/voice/turn`, `/api/v1/voice/synthesize` and `/api/v1/voice/status` were the first three I found; a full route inventory this session found **two more that I had missed** because they live in a different router: `POST /voice/turn` — the *same* caller-asserted-`from_e164` impersonation path — and `POST /audio/speak`, which let the caller pick the `voiceId` outright, so anyone could synthesize arbitrary text with an arbitrary voice at our quota. The Twilio-hosted status routes had no signature check either, unlike their sibling inbound routes. All five are now behind one fail-closed shared-secret guard (`CST_API_KEY`, constant-time compare, 503 if unset, audited refusals, 21 focused tests), and the Twilio status routes now require a signature. The guard was also failing closed *silently*; it now reports a missing secret once at boot and writes a `SECURITY_LEDGER` entry — deliberately **without** aborting the process, because aborting would take the signed Twilio webhooks, the health endpoints and the outbound worker down with it, so a misconfigured secret becomes a closed door on five routes rather than a total outage. **All of it is local and uncommitted.** One deployment precondition: `CST_API_KEY` must be set in Render **before** any deploy containing it, or those five routes return 503 — please treat that as a two-step sequence, not one.

Separately, the consent refusal records were writing the **full recipient phone number** into retained audit records — exactly the entries an auditor reads to justify why a message was blocked. Those are now masked to the last four digits, and the pre-existing helper in the admin console masked only *one* character, so I replaced it with a shared one.

---

**2) HOFE and NI8F — consent and migrations**

Exact migrations, confirmed on disk: `db/migrations/016_sms_consent_spine.sql` (`sms_consents` + `sms_consent_audit`, `ck_consent_status` CHECK, tenant/phone/status indexes, updated-at trigger), `017_sms_consent_audit_fk.sql` (`unq_sms_consents_id_tenant`, FK `fk_sms_consent_audit_consent`, `enforce_sms_consent_audit_append_only()` + `trg_sms_consent_audit_append_only`), `018_sms_consent_prompts.sql` (`sms_consent_prompts`, `unq_sms_consent_prompts_active`). All are `IF NOT EXISTS`-guarded and re-runnable, and `scripts/migration_checks.js` carries effect checks for each.

Local regression: `npx vitest run tests/consent/` → **38 passed (38)**, exit 0, 2026-10-20T12:25:08Z. That covers server-stamped canonical wording, tenant-consistent append-only audit, STOP/HELP/START, dispatch-time re-validation, suppression of queued messages after STOP, resubscription, duplicate-prompt behaviour and audit persistence.

**`STAGING E2E ACCEPTANCE: NOT EVIDENCED`.** I looked for it rather than assuming it, and here is the specific reason: **there is no staging environment.** Render free tier has no mirror staging database for this service (this is stated in the HOFE guide itself, §3), the 12 Oct EOD records staging consent E2E as "Not run — no staging access or credentials available", the 14 Oct review still lists MIG-01 "staging PostgreSQL database missing migrations 017 and 018" as open, and the closure checklist still has the staging migration and staging-log evidence unchecked. I am not going to dress up a local suite or a migration ledger as staging proof, so I am not claiming it.

Production migration state, observed: `0 applied, 20 already recorded` — which means the runner recorded 016–019 as applied. **I am explicitly not treating that as proof the objects exist**: a ledger line is a record of intent, and the constraints, indexes, FK and append-only trigger need a catalog query to confirm. The read-only `information_schema`/`pg_constraint`/`pg_indexes`/`pg_trigger` queries are written out in §5.2 of the evidence report, phone numbers untouched, all `SELECT`. They need either my IP added to the DB allowlist (it is empty — I did not try to work around it) or one operator running them.

Destiny — the `DW-96O8` decision is what unblocks this: does verified **production** schema evidence satisfy HOFE, or do we have to stand up a staging database first? On the current facts I would rather we decided that than keep HOFE open against a staging environment that does not exist.

For NI8F: consent is implemented and locally verified, but **no authorized live SMS has ever been sent**, so there is no provider message ID and no delivery callback. I need an approved recipient, an approved window, and explicit authorization before dispatching anything. The reported ~40-minute delivery delay remains **unexplained by CST's own code** — the outbound worker polls every 5 s and the in-process retry backoff is 2–4 s, neither of which produces 40 minutes — so I am not recommending an infrastructure upgrade, and I need read access to `messages_out` to find the real cause. The read-only queue queries are in the approval document.

---

**3) VJU6 — the verification plane**

**I could not find an authoritative `VJU6` identifier and I am not going to invent one.** This is the same finding recorded in `docs/vju6-proposed-verification-record.md`, `docs/cst-v1-readiness-audit.md` §8 and the 12 Oct EOD — VJU6 does not exist as a loop ID in this repository, its codebase, its specs or its git history. Jason, please send me the tracker ID. The closest authoritative records for that scope are **`LOOP-1790985133891-1TEN` / `LOOP-1790691898379-S6Q3`** (the Dashboard publisher: `cst.turn`/`cst.delivery` correlation, retry/backoff, monotonic delivery guard, dry-run), and I have reconstructed the scope from those.

What the plane actually gives us today:

| Capability | Verified where | Real evidence | Gap / owner |
|---|---|---|---|
| Health | **Production, live** | 200 on `/health` and `/api/health` | Proves the process is up, not which commit |
| Deployed SHA | **Production, live** | `b06c68f` = HEAD | — |
| Migration ledger | Production (ledger only) | `0 applied, 20 already recorded` | Object proof needs §5.2 |
| Dashboard dry-run | Local | 24/24 (`dashboard_e2e` + `dashboard_dry_run`) | Dry-run is **not** ingestion |
| **Dashboard live ingestion** | **NOT VERIFIED** | None reproducible | Dashboard owner + Jason |
| **Live SMS delivery** | **NOT VERIFIED** | No provider ID, no callback | Jason |
| **Live voice delivery** | **NOT VERIFIED** | No call has ever connected | Jason |
| Correlation IDs | Mechanism in code | `correlation_id`, `turn_id`, `provider_sid` join the turn to the provider event | Values unpopulated until the live channels run |
| `/debug/state` | Production | 404 — correctly disabled | — |

**The six `dashboard_real_proof` tests remain unrun.** I did not set `REAL_DASHBOARD_PROOF=1` and did not run them. They are gated, they need a live Dashboard URL and key, and they have never been executed here — so there is **no production Dashboard ingestion evidence**. The pilot checklist claims live ingestion was "verified against `https://dashboard.bhanetwork.org` — HTTP 200 with row insertion confirmed", but it records no date, no harness and no literal response, so it is not reproducible evidence. Either you can point me at that original run record, or we need an approved Dashboard test environment and explicit authorization to run the six. I am not treating a healthy `/health` as ingestion proof or as carrier-delivery proof.

The gap here is **not the mechanism** — the contracts, correlation IDs, audit ledger and publisher all exist and are locally verified. The gap is the **populated values**: one real SMS, one real call, one real Dashboard ingestion, and read access to the production queue. With those four, the evidence contract (deployed SHA, environment, timestamp, scope, result, correlation/trace IDs, sanitized provider evidence) is satisfiable today.

---

**4) Test evidence**

Last passing run before this session: **`npm test` → 618 passed / 6 skipped (624), 0 failed**, 61 files, 2026-10-20T12:02Z, exit 0.

This session (2026-10-20T12:25Z), all exit 0:

| Command | Result |
|---|---|
| `npx vitest run tests/security/vfarm_proxy_unauth.test.ts` | 26 passed (26) |
| `npx vitest run tests/security/programmatic_voice_auth.test.ts` (new) | 21 passed (21) |
| `npx vitest run tests/privacy/log_masking.test.ts` (new) | 6 passed (6) |
| `npx vitest run tests/consent/` | 38 passed (38) |
| `npx vitest run tests/voice/` | 94 passed (94) |
| `npx vitest run tests/regression/kmg9_farm_isolation.test.ts` | 9 passed (9) |
| `npx vitest run tests/integration/dashboard_e2e.test.ts tests/integration/dashboard_dry_run.test.ts` | 24 passed (24) |
| `npx vitest run tests/integration/dashboard_real_proof.test.ts` | 1 passed / **6 skipped** — gated, not run |
| **`npm test`** | **645 passed / 6 skipped (651), 0 failed**, 63 files, 21 s |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | exit 0 |

The +17 and +1 file are exactly the new tests: 11 additional programmatic-voice-auth cases (10 → 21) plus the 6 new privacy cases. No test was disabled, skipped or reclassified to inflate the count, and the 6 live-Dashboard tests stay skipped. **Seven** failures occurred during the work and every one is recorded in the closure report §5.1 rather than hidden behind the green run — including one that was **correct behaviour** (a 403 from the authorization chain, because that test had not onboarded a speaker, which is exactly the impersonation scoping the guard is meant to sit in front of).

**Checks I could not run, and why:** the 6 live-Dashboard proofs (no approved environment, and I was told not to run them); any staging run (no staging environment exists); direct production SQL (the DB IP allowlist is empty — I did not attempt to bypass it); `render ssh` into the container (no authorised key, and adding one would be a production config change); any live carrier test (no verified number, no approved recipient, no authorization). I also did not probe the voice webhook with a signed request, because that would trigger a real ElevenLabs synthesis and write production rows — that is beyond read-only inspection, and the one-line SQL check that confirms the voice pointer is in the evidence report instead.

---

**What I need, from whom**

| # | Ask | Owner | Unblocks |
|---|---|---|---|
| 1 | vFarm API Gateway logs for the CST service client, 2026-09-25 → present, with reads/farm ids and key issuance history | vFarm / BHARAG gateway owner | 5R0J historical review |
| 2 | Confirm no non-Render CST deployment existed 2026-09-25 → 2026-10-07 | Jason / Destiny | 5R0J |
| 3 | Accept or reject 5R0J; decide lineage-vs-Log-Explorer; decide rotation | Destiny | 5R0J, `DW-1791852954583-46HC` |
| 4 | Read access to the production DB, or one operator running the §5.2 queries | Jason / Platform | HOFE, the SMS delay, the voice-pointer check |
| 5 | `DW-96O8` — production schema evidence vs standing up staging | Jason | HOFE |
| 6 | Verified Twilio From number + reachable handset + authorization for one call | Jason | Voice acceptance |
| 7 | Approved SMS recipient + window + explicit dispatch authorization | Jason | NI8F, A2P carrier evidence |
| 8 | Authoritative `VJU6` tracker ID | Jason | Verification-plane tracking |
| 9 | Dashboard test environment + authorization, **or** the original live-ingestion run record | Jason + Dashboard owner | `1TEN`/`S6Q3` |
| 10 | `CST_API_KEY` set in Render **before** the voice-guard deploy | Jason / Platform | The §1 voice fix |
| 10b | Authorize the guard deploy, and confirm the Twilio-status signature change ships with it | Jason | The §1 voice fix |
| 10c | One line: no non-Render CST deployment existed 2026-09-25 → 2026-10-07 | Jason / Destiny | 5R0J residual |
| 10d | vFarm **key issuance records for `POST /api/v1/tokens`**, 2026-09-25 → 2026-10-07 (the audit `docs/cst-pilot-checklist.md:107` already specifies) | vFarm / BHARAG owner | 5R0J historical review |
| 11 | Postgres Starter approval — the free tier expires **2026-11-14T18:10:20Z** | Jason | `XXHH` |
| 12 | DNS/TLS: `cst.bhanetwork.org` and `cst-admin.bhanetwork.org` still do not resolve; CNAME → `bha-cst-7u9e.onrender.com` at GoDaddy | Jason / Platform | `OYP9` |

**Nearest hard deadline:** the Postgres free tier expires **14 November** (confirmed from the Render API: `expiresAt 2026-11-14T18:10:20.49769Z`, exactly 90 days after creation). The upgrade plan, `pg_dump` pre-flight, cutover window, validation SQL and rollback steps are already written in `docs/release/cst-database-continuity-plan.md` — it needs an approval and a window, nothing else. 25 days.

**And to be explicit about what I am not claiming:** CST is **not** production-ready. Voice has never completed a call, SMS has never completed a carrier round trip, the production schema objects are unverified, the Dashboard ingestion is unproven, and the custom domains do not resolve. The code is complete and locally verified; what is missing is acceptance evidence and access.

No commits, pushes, deploys, production config changes, migrations, rotations, calls or SMS sends were made. `docs/task.md` is the authoritative ledger.

---

## Notes for the reviewer (not part of the message)

- **Do not send without owner approval.** Adjust tone/length as appropriate.
- **Claims deliberately excluded:** any staging success, any rotation history, any live Dashboard ingestion, any completed carrier round trip, any completed voice call, and any statement that 5R0J is closed.
- **If sent before §1 is deployed**, add a line that the programmatic-voice guard is local and uncommitted, and that `CST_API_KEY` must be set in Render before deploying it.
- **The factual basis for every claim** is in `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md`, with per-item evidence paths and timestamps. §5.2 holds the read-only operator queries; `docs/release/cst-approval-requests.md` holds the per-owner drafts and the `messages_out` queue queries.
