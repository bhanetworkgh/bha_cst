# CST Task & Evidence Ledger — bha-cst

**Repository:** `bhanetworkgh/bha_cst` (remote `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git`)
**Production:** `https://bha-cst-7u9e.onrender.com` · Render service `srv-db8hepqvcj2c73adpus0` · DB `dpg-db8he2qvcj2c73ado3s0-a`
**Owner of record:** Ahad (`U0AC6RFNP3P`)
**Latest evidence refresh:** **2026-10-20T17:40Z**

> **This file is the authoritative, shareable CST task and evidence ledger.** It replaces the older structure of this file. Detailed evidence lives in linked reports under `docs/release/`; this ledger links to them rather than embedding long logs.
>
> **Mirror:** `docs/release/task.md` is a byte-equivalent copy of this file with link paths adjusted for its directory depth. **`docs/task.md` is canonical** — if the two ever disagree, this file wins and the mirror should be regenerated.

---

## A. Current release status

| Item | Value | How it was verified | When |
|---|---|---|---|
| Branch | `main` | `git branch --show-current` | 2026-10-20T11:54Z |
| Repository HEAD | `b06c68fc5950e56ba140df892929d32c1a78e07a` | `git rev-parse HEAD` | 2026-10-20T11:54Z |
| **Latest verified deployment SHA** | **`b06c68fc5950e56ba140df892929d32c1a78e07a`** — deploy `dep-dbb7gl9srm7s73dc8phg`, created 2026-10-19T20:06:45Z, finished 20:07:43Z | `render deploys list srv-db8hepqvcj2c73adpus0` (Live row) | 2026-10-20T11:55Z |
| **Deployment drift** | **ZERO** — the Live deploy is identical to repository HEAD | same | 2026-10-20 |
| Working tree | 1 modified file + 2 untracked docs (all intentional; see §E) | `git status --porcelain` | 2026-10-20T12:15Z |
| Local verification | **691 passed / 6 skipped / 0 failed** (67 files); typecheck exit 0; build exit 0; `git diff --check` exit 0 — confirmed over consecutive full runs | §E, §C | 2026-10-20T17:37Z |
| Production health | HTTP 200 `{"status":"ok","service":"bha-cst-engine"}`; ~15–22 s cold wake (free tier hibernation after 15 min idle) | `curl` + `render logs` | 2026-10-20T11:56Z |
| Production migration state | `🎉 Migrations complete: 0 applied, 20 already recorded` — **019 is applied** | `render logs` startup lines | 2026-10-20T10:44:03Z, 11:04:47Z |
| Production vFarm connectivity | `[vFarm] Initialized with Live Key. Target Farm: dynamic-discovery` | `render logs` | 2026-10-20T10:44:08Z |
| Production voice traffic | **None observed.** No `SYNTHESIS_FAILED`, no `NO_VOICE_POINTER`, and no voice delivery either | `render logs` (CLI window 2026-10-19T18:07:30Z → 2026-10-20T11:56:47Z) | 2026-10-20 |
| **Production acceptance status** | **NOT ACCEPTED.** No real voice call has ever connected; no real SMS has ever been sent; production schema objects are unverified; DNS/TLS for the CST hostnames does not exist; BHARAG upstream key scope is unproven | §B | 2026-10-20 |
| Overall blockers | 4 external gates: (1) live voice + SMS acceptance, (2) DB schema read access, (3) DNS/TLS, (4) partner sign-offs (Destiny, Jegan) — **plus 1 new P0 found 2026-10-20T12:20Z: the programmatic voice API had no authentication** (fix implemented locally, uncommitted, not deployed) | §B, §D | 2026-10-20T12:30Z |
| **Next checkpoint** | **Set `CST_API_KEY` in Render, then deploy the voice guard** + one real voice call + one real SMS + the voice-pointer query + three sign-offs + the vFarm gateway log review. All are access/hardware/approval items, not engineering | §D | — |

### A.1 ⚠ Correction to a previously published status (2026-10-20)

Earlier versions of this file and of `docs/release/CST_MASTER_TASK_AUDIT.md` stated that **production was running `3e88058` and that four commits were undeployed**, naming the Twilio `12300` fix as the top action. **That was wrong.** It was carried forward from a 2026-10-19T13:53Z observation without being re-checked against the Render API, even though the `render` CLI was available and authenticated in that environment.

**Verified truth:** the Live deploy is `b06c68f` (= HEAD). All four commits from 19 Oct are live, including the Twilio `12300` fix, and migration 019 is applied. **The "deploy the 4 commits" action was never needed and is not requested.** The related drafts and the master audit have been corrected, with the historical values preserved in their change logs.

**Standing rule adopted from this:** `render deploys list` is the only authority for the deployed SHA. A `/health` 200, a document, a previous session's note, or a migration ledger line are not.

### A.2 Voice pointer — RESOLVED analytically on 2026-10-20 (was previously flagged as a risk)

The previous revision flagged a risk that the voice layer would synthesize with the invalid placeholder `'eleven_voice_jason_vfarm'`. **That risk is closed by code and production evidence:**

| # | Fact | Evidence |
|---|---|---|
| 1 | The placeholder is only ever a *seed default* or a *fallback constant*. The seed path (`engine/src/core/registry.ts:103`) is inside `resetToDefault()`, which is guarded by `if (process.env.NODE_ENV !== 'production')` at `engine/src/core/registry.ts:215`. Production sets `NODE_ENV=production` (startup log). | `engine/src/core/registry.ts:66,103,215` |
| 2 | The other occurrence is the backfall at `engine/src/core/registry.ts:186`, which iterates **only rows loaded from the `projects` table** (`DbClient.getAllProjects()`), and only for `project_id === 'proj-vfarm-main'` with an empty `elevenlabs_voice_id`. | `engine/src/core/registry.ts:183-197` |
| 3 | Migration 019 `UPDATE`s that row to `Hmy97GCI840wuICQesiM` when the column is NULL or `''`, and **migrations run before the app starts** (`startCommand: node scripts/migrate.js && npm start`). | `db/migrations/019_backfill_project_voice_pointer.sql`; `render services get -o json` |
| 4 | Migration 019 was **applied**, not skipped: `2026-10-19 20:07:33 Applying migration: 019_backfill_project_voice_pointer.sql… ✓ Successfully applied`. | `render logs` |
| 5 | No registry backfill failure is logged in production. | `render logs --text "backfill"` |

**Conclusion:** in production the row is non-empty (either 019's value or a pre-existing non-empty value), so the backfill cannot fire and the placeholder is unreachable. If the row were absent entirely, the failure mode is a loud "voice not enabled" refusal, not a wrong voice. The remaining check is one line — the §A.2.5 SELECT in `docs/release/cst-approval-requests.md` §A.2 — which still requires DB read access.

---

## B. Priority task register

Status labels: `VERIFIED COMPLETE` · `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` · `BLOCKED — EXTERNAL ACTION REQUIRED` · `IN PROGRESS` · `NOT VERIFIED` · `SUPERSEDED` · `NEEDS OWNER CONFIRMATION`.

### B.1 P0 — Security

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B1.1 | `LOOP-1790790007707-5R0J` | Unauthenticated vFarm proxy exposure on `/api/devices`, `/api/dashboard`, `/api/farms`, `/api/tokens` (+ `/api/v1` aliases). Impact: an anonymous caller could have read farm devices/dashboard, enumerated farms, and minted farm keys. | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | Auth gate implemented (`31f3a5f`, 2026-10-07); 26/26 regression (2026-10-20T12:25:06Z); live 8/8 → 401 re-verified 2026-10-20T11:56:13Z; fail-closed 403/401 with a synthetic invalid JWT; **no credential substitution, no legacy fallback**; exposure window bounded by deployment lineage (production service created 2026-10-15T18:11:51Z, 8 days *after* the gate) | vFarm API Gateway log review (Query 3); one-line confirmation that no non-Render CST deploy existed 2026-09-25→2026-10-07; Destiny's formal acceptance + rotation decision | **Destiny** (acceptance + rotation decision); **vFarm gateway log owner** (Query 3); **Jason** (non-Render deploy confirmation) | Query 3 clean; confirmation given; Destiny accepts | `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md` §2; `docs/release/cst-5r0j-security-audit-and-residual-risk.md` | Ahad sends §6 draft; Destiny decides. Next checkpoint |
| B1.2 | `DW-1791852954583-46HC` | CST security/consent/verification watch. 3/3 reminders sent; escalates to Jason + Destiny on the next pass. | `IN PROGRESS` | Full technical status documented; **two** drafts prepared (per-owner and combined Jason/Destiny/Bays) | Ahad's in-thread reply | **Ahad** | none — Ahad posts | Reply posted with blockers, asks, and checkpoint | `docs/release/cst-readiness-slack-reply.md`; `docs/release/cst-approval-requests.md` §6 | **Ahad posts today** |
| B1.3 | `DW-1791851358695-JU0D` | CST watch referenced in the master prompt. | `NOT VERIFIED` | — | Confirm current state and whether it supersedes B1.2 | **Destiny** | Slack/dashboard confirmation | Status confirmed in Slack | — | Ahad asks Destiny to confirm |
| B1.4 | `DW-1791829227726-96O8` (`DW-96O8`) | Production-only vs staging acceptance policy for schema evidence. | `BLOCKED — EXTERNAL ACTION REQUIRED` | Policy question framed with the exact queries to satisfy either answer | Owner decision | **Jason** | Written policy decision | Decision logged; HOFE acceptance path fixed | `docs/release/cst-approval-requests.md` §4 | Jason decides — blocks B2.1 |
| B1.5 | Credential rotation (vFarm farm key / admin JWT) | Would invalidate live vFarm integrations if performed unnecessarily. | `IN PROGRESS` | Rotation deliberately **not** performed; rationale documented | Decision, after Query 3 | **Jason + Destiny** | Written instruction | Decision recorded with reasoning | §6 draft, 5R0J §4.1 | Decide after Query 3 |
| **B1.6** | **NEW P0 — programmatic voice API had no authentication** | **FIVE** programmatic voice routes were mounted with no middleware: `/api/v1/voice/turn`, `/api/v1/voice/synthesize`, `/api/v1/voice/status` (interfaces/voice) **plus `/voice/turn` and `/audio/speak`** (transport/voice/voice_router — found 2026-10-20T14:30Z; the first fix was incomplete). `/api/v1/voice/turn` and `/voice/turn` trust a caller-asserted `from_e164` and resolve the speaker's role/permissions/`farm_ids` from it; `/audio/speak` let the caller choose `voiceId` outright. The Twilio-hosted status routes also had no signature check. | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` | Confirmed live 2026-10-20T12:05Z (empty body → 400/404, not 401/403). **Fix:** new `engine/src/middleware/programmatic_api_key.ts` (fail-closed `CST_API_KEY`, `timingSafeEqual`, 503 if unset, audited refusals, no test bypass, boot-time config check); guard on all 5 routes; `verifyTwilioSignature` on the Twilio status routes; **21** focused tests in `tests/security/programmatic_voice_auth.test.ts` | **Deploy it**; set `CST_API_KEY` in Render **first**; confirm no production consumer relied on the open routes | **Jason / Platform** (secret + deploy) | 21/21 new tests; 645/651 full suite; routes refuse 401/403/503 without a valid key; Twilio status routes refuse an unsigned request | `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` §3.1, §6 gap 1 | Jason sets `CST_API_KEY`; Ahad confirms consumers, then the fix ships with the next authorized deploy |
| **B1.7** | **P0 — customer phone numbers in retained audit records** | The SMS consent refusal records — the entries an auditor reads to justify a blocked message — carried the **full recipient number** into `SECURITY_LEDGER` and the returned reasons. The pre-existing admin helper masked only **one** character, so it was not masking. | `CLOSED — VERIFIED` (all customer-number sites) | New shared `engine/src/util/privacy.ts` (`maskPhone`: leading hint, masked middle, last four digits); applied to all 4 `canSendSms` audit reasons, both returned reasons, 3 keyword logs and 4 thrown messages in `engine/src/consent/service.ts`, the guest-caller voice reason, and `engine/src/admin/routes.ts` (local helper removed). 6 new tests in `tests/privacy/log_masking.test.ts` | **None open.** All customer-number sites are masked: `identity/resolver.ts:96,127,201`, `adapters/vfarm/index.ts:815`, `admin/routes.ts:645`, `db/client.ts:1034`, and every `SECURITY_LEDGER` `actor` field in the voice and SMS ingress paths. **Service numbers are deliberately left unmasked** — CST owns and publishes them, so they are operationally necessary in a tenancy audit record and are not customer identifiers; the policy is recorded in `engine/src/util/privacy.ts` | — | No raw **customer** number in any retained record; service numbers retained by policy | `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` §3.3, §7.1 | Closed |

### B.2 P0 — Voice, deployment, and Twilio

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B2.1 | `LOOP-1791243473841-02JU` | Real voice acceptance. Impact: voice is the highest-value channel for vFarm onboarding/support; it cannot be represented as ready without a completed call. | `BLOCKED — EXTERNAL ACTION REQUIRED` | 94/94 voice tests; webhook content-type fix (`ac387be`) **deployed**; DID→tenant/project routing; fail-closed paths; transcript persistence implemented; `scripts/e2e/voice_live_e2e.ts` wired for exactly one `--live` call | **One real call.** Prior attempt refused at creation with Twilio `21210` (unverified From). No Call SID, no transcript, no two-way speech proof. | **Jason** (verified Twilio number, handset, authorization) | Verified `TWILIO_NUMBER`; reachable handset; written authorization for one call; destination number | Call SID; greeting spoken; caller speech captured; response spoken; no unexpected disconnect; correct tenant/project; transcript persisted; sanitized logs | `docs/release/cst-voice-live-call-attempt.md`; `docs/release/cst-approval-requests.md` §2 | Ahad requests §2. Check A.2 first |
| B2.2 | `LOOP-1792186847775-63MS` | Voice/Twilio configuration. | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | Raw TwiML with `text/xml; charset=utf-8`; HTTPS action URL reconstruction from `x-forwarded-*`; guest-caller least-privilege ingress; empty-input reprompt; barge-in re-gather; migration 019 applied; `migration_checks.js` effect check for 019 | Live verification (same gate as B2.1) | **Jason** | as B2.1 | as B2.1 | `docs/release/CST_MASTER_TASK_AUDIT.md` §9.1 | Ahad runs the call once authorized |
| B2.3 | `DW-1792186179087-EWQI` | Voice + KMG9 acceptance. | `NEEDS OWNER CONFIRMATION` | Instructions prepared | Jason's live smoke test + acceptance | **Jason** | Live access | as B2.1 | `docs/release/cst-kmg9-live-test-instructions.md` | Jason runs |
| B2.4 | `DW-1792187689082-B0M2` | Voice acceptance. | `NEEDS OWNER CONFIRMATION` | — | Confirm scope against B2.1 | **Jason / Destiny** | Confirmation | Scope agreed | — | Ahad asks |
| B2.5 | Deployment status | Repository vs production drift. | `VERIFIED COMPLETE` | Live deploy = HEAD `b06c68f`; 4 prior commits confirmed deployed; migration 019 applied; **zero drift** | None | — | none | — | `render deploys list` 2026-10-20T11:55Z | None. Only the pre-push checklist is future work |
| B2.6 | Pre-push checklist / rollback | `autoDeploy: yes` on `main` means **a push is a production deploy and a production migration**. | `IN PROGRESS` | Checklist and rollback/incident runbook written | Owner acknowledgement | **Jason** | Acknowledgement | Checklist agreed | `docs/release/operator-playbook-sop.md` §11 | Ahad sends §1 draft |

### B.3 P0 — KMG9 farm-routing safety

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B3.1 | `LOOP-1788044070647-KMG9` | vFarm-specific questions must never silently fall back to a generic BHARAG cluster answer. Impact: cross-tenant farm data disclosure. | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | BHARAG fallback removed from the farm-telemetry path; fail-closed `telemetry_unavailable` on missing client / upstream error / adapter degraded; `VfarmAuthorizationError` → 403; intent classifier routes farm-state live questions to `status`; `farm_id`/`unit_id` removed from the general-knowledge payload; **9/9 regression** re-verified 2026-10-20 | Staging vFarm up/down; production vFarm up/down; cross-tenant refusal; **BHARAG key scope (B3.2)** | **Jason** (env smoke tests) + **Jegan** (key scope) | Live vFarm access; BHARAG key-scope access | Each environment × case: expected vs actual vs evidence ref | `docs/kmg9-verification-record.md`; `docs/release/cst-kmg9-live-test-instructions.md`; §8.1 matrix | Ahad sends §7 and §8 drafts. 2 business days |
| B3.2 | `DW-1792186179087-EWQI` (BHARAG scope half) | Upstream cluster-key scope proof. | `BLOCKED — EXTERNAL ACTION REQUIRED` | Required evidence precisely specified: negative test, positive test, policy/workspace/index scope proof | Three artifacts | **Jegan / BHARAG key owner** | BHARAG key-scope access | 7a denial/empty; 7b success; 7c enforcement doc | §7 | Ahad sends §7. 2 business days |

### B.4 P1 — SMS, consent, and the delivery delay

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B4.1 | `LOOP-1791467054702-NI8F` | Canonical SMS consent spine. Impact: A2P 10DLC compliance and the ability to message customers at all. | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | Schema 016/017/018; server-stamped wording (client version ignored); append-only tenant-consistent audit; STOP/HELP/START; consent **re-checked at dispatch**; `consent_exempt` bypass fenced to platform-originated messages from a project-bound DID; **38/38** re-verified 2026-10-20 | One authorized carrier round trip (provider message ID + delivery callback) | **Jason** | Approved recipient + approved window + explicit dispatch authorization | Real SMS: provider `SM…` ID **and** a delivery-status callback row | `docs/release/cst-sms-consent-verification-record.md`; §3 draft | Ahad requests §3. Next checkpoint |
| B4.2 | `LOOP-1792452150303-J2F6` | ~40-minute production SMS delivery delay. Impact: customer-visible latency on the primary channel. | `BLOCKED — EXTERNAL ACTION REQUIRED` | CST-side causes **ruled out**: worker polls every 5 s (`engine/src/server.ts:48`); in-process retry backoff 2–4 s (`engine/src/transport/twilio/outbound.ts`); `messages_out` schema mapped (`provider_sid`, `next_retry_at`, `retry_count`, `error_message`, `sent_at`, `turn_id`); delivery status persisted to both `messages_out.status` and `messages.delivery_status` | Production queue evidence | **Jason** | `messages_out` read access, or an authorized operator running the §A.1 queries | Query output separating "CST sent late" / "Twilio accepted late" / "carrier delivered late" | `docs/release/cst-approval-requests.md` §A.1 | Ahad requests §3. **Do not upgrade infrastructure before evidence points there** |
| B4.3 | SMS / voice inbound capability routing | Inbound SMS must route against the DID's real enabled capabilities. | `VERIFIED COMPLETE` | Voice route refuses a non-`voice` binding (404 `CAPABILITY_DISABLED`); SMS outbound refuses a non-`sms` binding; consent check runs before the sending-number resolution | — | — | — | — | `engine/src/interfaces/voice/index.ts:724-750`; `engine/src/transport/twilio/outbound.ts:229-250`; `tests/transport/outbound_tenancy.test.ts` | None |

### B.5 P1 — Database, migrations, continuity

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B5.1 | `LOOP-1791826143428-HOFE` | Independent verification of migrations 017/018/019 and their schema objects. Impact: a migration ledger line is a record of intent, not proof the constraints, indexes, FKs, and append-only trigger exist. | `BLOCKED — EXTERNAL ACTION REQUIRED` | Migration files, ordering, idempotency, checksums, advisory locks, triggers, and constraints verified in-repo; `scripts/migration_checks.js` effect checks for 016–019; production ledger reads `0 applied, 20 already recorded` | Actual schema-object verification | **Jason / Platform** | DB IP allowlist entry, or an authorized operator running the §A.2 queries | `information_schema` / `pg_catalog` confirmations for every object in §A.2.1–§A.2.5 | `docs/release/cst-ho-fe-schema-verification-guide.md`; §A.2 | Ahad requests §4. 1 business day |
| B5.2 | `LOOP-1792104121807-XXHH` | Postgres free-tier expiry. Impact: **the production database is deleted on 14 Nov 2026**; transcripts, consent records, voice deliveries, and outbound history all live there. | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | Expiry confirmed authoritatively from the Render API: `plan: free`, `createdAt 2026-10-15T18:10:20.49769Z`, `expiresAt 2026-11-14T18:10:20.49769Z` (exactly +90 days); upgrade plan written: `pg_dump` pre-flight, 5–10 min cutover, post-cutover validation SQL, rollback steps | **Written approval for the Starter tier ($7/mo) and a named window** | **Jason** | Written approval; billing authorization | Plan upgraded; validation SQL passes; zero data loss | `docs/release/cst-database-continuity-plan.md`; `render postgres get` 2026-10-20 | Ahad sends §4. **25 days remain** |
| B5.3 | Migration 019 review | Backfill of the project voice pointer. | `VERIFIED COMPLETE` | SQL reviewed: single guarded `UPDATE`, `COALESCE`/`NULLIF` idempotent, scoped to `project_id = 'proj-vfarm-main'`, forward-only, no DDL, no customer data; `projects.elevenlabs_voice_id` created in migration 010; effect check present in `migration_checks.js`; **applied in production** | — | — | — | — | `db/migrations/019_backfill_project_voice_pointer.sql`; production startup log 2026-10-20T11:04:47Z | None |
| B5.4 | Direct DB access | `ipAllowList: []` blocks external psql. | `BLOCKED — EXTERNAL ACTION REQUIRED` | Allowlist state confirmed via the Render API ("IP allow-list: empty (external connections blocked)"). **No bypass was attempted or attempted-around** | Allowlist entry or a bastion | **Jason / Platform** | Access grant | A read-only `SELECT` returns rows | `render postgres get` 2026-10-20 | Ahad requests §4 |

### B.6 P1 — DNS/TLS, registry, monitoring, v1 acceptance

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B6.1 | `LOOP-1790439082267-OYP9` | `cst.bhanetwork.org` / `cst-admin.bhanetwork.org`. Impact: no stable customer-facing hostname; operator shortcuts point at names that do not resolve; Twilio webhook signatures cannot verify against a stable host. | `BLOCKED — EXTERNAL ACTION REQUIRED` | DNS + TLS measured 2026-10-20T12:00:58Z: both hostnames return **no A, no AAAA, no CNAME** → "Could not resolve host", TLS impossible. `bhanetwork.org` is on GoDaddy NS (`ns09/ns10.domaincontrol.com`). Render CNAME target confirmed as `bha-cst-7u9e.onrender.com`. Render CLI has **no custom-domain subcommand** → dashboard required | Domain added in Render dashboard; CNAME created at GoDaddy; certificate issued | **Jason / Platform** | DNS + dashboard action (production config) | `dig` returns a record; `curl -sv https://cst.bhanetwork.org/health` shows a valid chain | `dig`, `curl -sv`, `render services get` | Ahad sends §5. Before 31 Oct launch |
| B6.2 | `LOOP-1789824812431-IWKX` | CS Twin v1 release readiness (launch target 31 Oct 2026). | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | 7 of 10 checklist criteria verified; deployment part **now proven** (live SHA = HEAD) | 3 external gates: live channels, DB schema, partner acceptance | **Jason**, **Destiny**, **Jegan** | as B1, B2, B3, B4, B5 | Four-part acceptance matrix complete (§8.2) | `docs/release/cst-v1-release-readiness-assessment.md`; §8.2 | Ahad sends §8 |
| B6.3 | `LOOP-1789573914064-KZE7` | CST integration with BHARAG, Front Door, Genie/routing, monitoring, incident/evidence tracking. | `IN PROGRESS` | Publishers, monotonic status guard, `cst.turn`/`cst.delivery` contracts, incident path, alert audit ledger implemented and locally verified | Live Dashboard ingestion never proven | Dashboard owner + **Jason** | `REAL_DASHBOARD_PROOF=1` + live Dashboard credentials + **explicit approval** | 3 real events validated and persisted (dry-run, turn, delivery) | `tests/integration/dashboard_real_proof.test.ts` (6 tests, **skipped**) | Ahad requests approval. **Not to be run unapproved** |
| B6.4 | `LOOP-1790985133889-8D7U` | Registry, person-to-unit authorization, monitoring. | `IN PROGRESS` | `4ad161e` vFarm Users & Grants console; `888e22e` registry fixes; `tests/admin/vfarm_users_and_grants.test.ts` 4/4; `tests/admin/admin_api.test.ts` 14/14; tenancy 8/8 + 6/6 | Live grant exercised end to end | **Jason** | Live vFarm farm access | Live grant resolves through the admin console and the SMS/voice rails | §8.2 part 3 | Ahad requests §8. 2 business days |
| B6.5 | `DW-1792157614347-IPAR` | Referenced in the master prompt; not present in repository records. | `NOT VERIFIED` | — | Confirm relevance and status | **Destiny / Jason** | Slack confirmation | Status recorded | — | Ahad asks |
| **B6.8** | **Dashboard publish-failure durability** | A failed dashboard publish was **logged** but **not persisted**, so a silently dropped evidence event was unrecoverable once the log rotated. | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` | New migration `020_dashboard_publish_outcomes.sql` (additive: one table, three indexes, no existing table touched, no customer data migrated); `DbClient` gains `recordDashboardPublishOutcome` / `getUnpublishedDashboardOutcomes` / `getAllDashboardPublishOutcomes` / `markDashboardOutcomeReplayed`; every publisher path records an outcome (2xx, non-retryable 4xx, exhausted retries, missing configuration, dry-run success and dry-run validation failure); the stored payload is **masked** and size-bounded; `replayUnpublishedDashboardEvents()` re-sends dead-lettered events. 11 new tests | Apply migration 020 (runs on the next authorised deploy). The **monotonic delivery guard is still an in-memory Map**, lost on restart — a separate schema change, still open | **Jason** (migration + deploy approval) | Migration 020 applied; a failed publish visible in `getUnpublishedDashboardOutcomes`; a replay succeeds and clears the row | `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` §7 gap 14; `tests/publishers/dashboard_publish_outcomes.test.ts` | Jason approves the migration with the deploy |
| **B6.7** | **VJU6 — verification / dashboard plane** | The evidence surface a reviewer uses to reconstruct CST's production state. Impact: without it, every other claim rests on assertion. | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | **No authoritative `VJU6` ID exists in this repository** — recorded in `docs/vju6-proposed-verification-record.md`, `docs/cst-v1-readiness-audit.md` §8, `docs/eod-2026-10-12.md:189`; scope reconstructed from the closest authoritative records **`LOOP-1790985133891-1TEN` / `LOOP-1790691898379-S6Q3`** (Dashboard publisher). Health ✓, deployed-SHA ✓, migration ledger ✓, dry-run publisher 24/24 ✓, correlation IDs ✓, `SECURITY_LEDGER` ✓, `/debug/state` correctly 404 in production ✓ | Authoritative VJU6 ID from Jason; **live Dashboard ingestion proof** (6 `dashboard_real_proof` tests never run); live SMS/voice values; production queue read access | **Jason** (ID, Dashboard env) + **Dashboard owner** | ID supplied; the 6 proofs run in an approved environment (or the original live-ingestion run record supplied); the evidence contract in the evidence report §5.4 populated with real correlation IDs and sanitized provider evidence | `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md` §5 | Ahad requests. Next checkpoint |
| B6.6 | Architecture gap: hardcoded tenant in the out-of-scope farm detector | `engine/src/core/engine.ts:841` hardcodes `CoreRegistry.getProjectsForTenant('tenant-vfarm-01')` inside a tenant-scoped authorization helper. Safe today (single tenant) but it will under-detect out-of-scope farms if a second tenant is onboarded. | `IN PROGRESS` | Located and characterized | Fix needs its own test coverage — **not** a "narrow" change | Ahad + review | Review approval | Test covering a second tenant | `engine/src/core/engine.ts:835-862` | Record in the v1 gap list; do not bundle with other work |

### B.7 P1 — Operator Playbook and Client 2

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B7.1 | `LOOP-1791848474090-Y5TW` | Operator Playbook SOP. Impact: lets another operator resolve a CST blocker without Ahad — the difference between a 1-hour outage and a 1-day one. | `IMPLEMENTED — PRODUCTION ACCEPTANCE PENDING` | Draft complete in-repo, 10→12 sections; **2026-10-20: 8 factual errors corrected** (adapter path, admin console path, non-existent `migrate.js --dry-run` flag, stale test-helpers path, migration range, tracker path, wrong Render admin handle, tracker reference) and **2 sections added** — rollback & incident handling, evidence collection & sanitization; 0 secrets | Publication to Codex → SOPs and BHARAG `sop/bays-cst-operations`; **Destiny's live simulation drill** | **Destiny** (drill), BHARAG admin (ingestion) | Publication confirmed; **drill actually run and logged by another operator** | `docs/release/operator-playbook-sop.md` | Ahad publishes; Destiny schedules drill. 2 business days |
| B7.2 | `LOOP-1791922936305-VU6R` | Client 2 Commissary Ops Twin working session. Target due 20 Oct 2026 (today). Impact: the `BOOKED → IN_USE → CLEANED_CLAIMED → READY/NOT_READY` workflow and the append-only signed ledger are design-stage only. | `NOT VERIFIED` | Agenda and validation-table template prepared; 3 open design questions formulated; source-check scope defined | **No evidence anywhere in the repository that the session was held.** The date passing does not mean it happened. Client 2 contact identity still unknown | **Ahad** (source-check report) → **Jason** (identify contact) | Jason to identify and introduce the contact; Ahad must not contact the client directly | Session held; notes recorded; client-confirmed requirements captured | `docs/release/cst-vu6r-prep.md`, `cst-vu6r-blocker.md` | Ahad reports source-check results and sends a neutral follow-up. **Due today** |
| B7.3 | `DW-1792414988891-UJJ2` | VU6R reminder (20 Oct, 14:03 Lagos). | `IN PROGRESS` | Preserved as context | Same as B7.2 | as B7.2 | as B7.2 | as B7.2 | `docs/task.md` history | Fold into B7.2 |

### B.8 P2 — Test integrity and external carrier dependency

| # | Task ID | Description & practical impact | Status | Completed | Remaining | Owner / dependency | Approval or access needed | Acceptance criteria | Evidence | Next action / date |
|---|---|---|---|---|---|---|---|---|---|---|
| B8.1 | `LOOP-1790032940977-DMVQ` | Historical test-suite regression report (57/57 → 26/185). Impact: a stale regression record can mask a real regression. | `SUPERSEDED` | History reconciled: 574/580 → 584/590 → 611+6 → **618/624 (current, 2026-10-20)**. The 57/57 → 26/185 figure is superseded. No skipped/disabled/flaky test was reclassified to inflate the count. The known voice flake did **not** reproduce. | — | — | — | — | §E command log | None |
| B8.2 | `LOOP-1791243473841-02JU` (test half) | Circular-initialization / test-discovery integrity. | `VERIFIED COMPLETE` | Full suite green across 61 files; 6 skipped are operator-gated, not disabled; no config change was made to make the suite pass | — | — | — | — | §E | None |
| B8.3 | External carrier / handset dependency | Real SMS and voice acceptance both need a real carrier and a real handset. | `BLOCKED — EXTERNAL ACTION REQUIRED` | Dependencies named precisely | Carrier path + handset | **Jason** | See B2.1, B4.1 | — | §2, §3 drafts | Jason |
| B8.4 | `dashboard_real_proof.test.ts` — 6 tests behind `REAL_DASHBOARD_PROOF=1` | Live Dashboard ingestion proof. | `NOT VERIFIED` | Gated in code; **never run** | Approved Dashboard test environment + explicit approval | Dashboard owner + **Jason** | Explicit approval | 3 real events validated and persisted | §B6.3 | Ahad requests approval. **Not to be run unapproved** |

### B.9 Not Ahad's work — do not duplicate

| Task ID | Owner | Substance |
|---|---|---|
| `DW-1791980388023-1Z1J` | Destiny | Intake-2 front door + Client 2 completion + Google Form build spec |
| `DW-1791898769276-E3Q5` | Hardik | U902 read-back/idempotency validation + Stripe→Ledger acceptance |
| `DW-1791990783434-UUC8` | Kavin | 2KG0 per-rack SKU wiring + end-to-end Stripe path |
| `DW-19QD` | Jason | Live vFarm smoke test (KMG9) |
| `DW-53P7` | Jegan | BHARAG cluster-key scope proof |
| `LOOP-1790985133891-1TEN` / `LOOP-1790691898379-S6Q3` | CST | **Dashboard publisher** — `cst.turn`/`cst.delivery` correlation via `turn_id`, retry with backoff on 5xx, fail-fast on 4xx, `MISSING_CONFIGURATION` no-op, fire-and-forget, monotonic delivery guard, dry-run. **This is the closest authoritative scope match for VJU6** — see B6.7. Live Dashboard ingestion remains unproven. |
| `LOOP-1790985133890-XKWD` | CST | Conversation persistence honours the FK contract — `resolveSystemIdForTenant` resolves a real `system_id`; a failed conversation INSERT raises `ConversationPersistenceError` instead of being swallowed. |
| `LOOP-1790985133892-4DSK` | CST | vFarm timeout/retry — shared timeout budget, categorised `VfarmApiError`, retry/backoff. |
| `LOOP-1791243473842-LMCL` | CST | Real carrier E2E for SMS/voice — the live leg of `LOOP-1791243473841-02JU`; requires a live Twilio number, a real handset, and carrier delivery. |
| `LOOP-1791243473843-S777` | CST | Commercial pilot (Loop E) — end-to-end stack integration. |
| `LOOP-1791991972916-G718` | CST | Clone-Quality Gate Step 2 — KMG9 fail-closed verified locally (9/9); blocked on `DW-19QD` (Jason) and `DW-53P7` (Jegan). |
| `DW-1791852954882-0VUU` | Jegan | **Self-closing** — owner replied; its one open ask is on Hardik (Onshape P1.0 revision for `cad_revision`/`config_hash`). No Ahad action. |
| Render plan / DB upgrade / DNS / allowlist | Jason / Platform | Infrastructure |
| vFarm API Gateway logs | vFarm / BHARAG owner | Query 3 |

---

## C. Completed and verified evidence

**Local code/test verification and production acceptance are recorded separately on purpose.** A green local suite is code evidence; it is never production acceptance.

| Item | Local code + test proof | Staging | Production | Verified |
|---|---|---|---|---|
| Public vFarm proxy routes are not an unauthenticated privileged proxy | `tests/security/vfarm_proxy_unauth.test.ts` — **26/26** | — | **8/8 → 401** live; caller-JWT on farm-key routes → **403**, on JWT routes → **401 upstream**; zero successful hits in the retrievable log window | 2026-10-20T12:25:06Z |
| Programmatic voice API is authenticated (NEW) | `tests/security/programmatic_voice_auth.test.ts` — **10/10** | — | **NOT VERIFIED** — the fix is local and uncommitted | 2026-10-20T12:25:08Z |
| SMS consent spine (capture, audit, STOP/HELP/START, dispatch-time enforcement) | `tests/consent/consent_spine.test.ts` 28/28 + `a2p_operational_acceptance.test.ts` 10/10 = **38/38** | **`STAGING E2E ACCEPTANCE: NOT EVIDENCED`** (no staging environment exists) | **NOT VERIFIED** (no carrier round trip) | 2026-10-20T12:25:08Z |
| KMG9 farm-routing fail-closed, no BHARAG fallback | `tests/regression/kmg9_farm_isolation.test.ts` — **9/9** | **NOT VERIFIED** | **NOT VERIFIED** | 2026-10-20T12:25:12Z |
| Voice interface, guest ingress, tenancy, failure paths, health signal | `tests/voice/` — **94/94** across 6 files | — | **NOT VERIFIED** (no call; no production voice traffic observed) | 2026-10-20T12:25:10Z |
| Tenant isolation / project routing | `platform_tenancy.test.ts` 8/8, `project_org_id_mapping.test.ts` 6/6 | — | — | 2026-10-20 |
| Admin UI + vFarm Users & Grants | `vfarm_users_and_grants.test.ts` 4/4, `admin_api.test.ts` 14/14 | — | Live grant **NOT VERIFIED** | 2026-10-20 |
| Full local suite | **628 passed / 6 skipped / 0 failed (634)** across 62 files | — | — | 2026-10-20T12:25:31Z |
| Typecheck / build / diff check | exit 0 / exit 0 / exit 0 | — | — | 2026-10-20T12:02Z |
| Deployed SHA == repository HEAD | — | — | **PROVEN** via `render deploys list` | 2026-10-20T11:55Z |
| Migrations 016–019 recorded in production | Code + effect checks verified in-repo | — | Ledger: `0 applied, 20 already recorded`. **Objects themselves unverified** (B5.1) | 2026-10-20T11:04Z |
| vFarm upstream connectivity | — | — | `[vFarm] Initialized with Live Key` | 2026-10-20T10:44Z |
| DNS/TLS for CST hostnames | — | — | **FAILS** (no A/AAAA/CNAME) | 2026-10-20T12:00Z |
| Operator Playbook SOP | Complete, 12 sections, 0 secrets | — | **NOT VERIFIED** (unpublished, no drill) | 2026-10-20 |
| Exposure window bounded by deployment lineage | `git merge-base --is-ancestor 31f3a5f 953d623` → true | — | Service `createdAt 2026-10-15T18:11:51Z` > gate commit 2026-10-07 | 2026-10-20 |

---

## D. Blockers and approvals

**Ownership is recorded only where the owner is known from the task record or from the repository — never guessed.**

| # | Blocker | Named owner | Exact action requested | Evidence to return | Unblocks | Realistic ETA |
|---|---|---|---|---|---|---|
| D1 | **Historical exposure review** | Destiny (acceptance) + vFarm gateway log owner (Query 3) + Jason (non-Render deploy confirmation) | Run vFarm gateway log query; one-line confirmation; formal accept/reject | Gateway log result; confirmation; decision | `5R0J`, `46HC`, `IWKX` | 1–2 business days |
| D2 | **Real voice call** | Jason | Verified Twilio `TWILIO_NUMBER`; reachable handset; written authorization for exactly one call; destination number | Call SID, greeting, speech, response, no disconnect, tenant/project, transcript, sanitized logs | `02JU`, `63MS`, `EWQI`, `B0M2` | 2 business days |
| D3 | **Real SMS round trip + delay diagnosis** | Jason | Approved recipient + approved window + explicit dispatch authorization; `messages_out` read access or an operator to run §A.1 | Provider `SM…` ID + delivery callback; §A.1 query output | `NI8F`, `J2F6` | 1–2 business days |
| D4 | **DB read access** | Jason / Platform | Add Ahad's IP to the allowlist, or have an operator run §A.2 | Query output | `HOFE`, `96O8`, and the A.2.5 voice-pointer check | 1 business day |
| D5 | **Postgres Starter decision** | Jason | Written approval for $7/mo + a named window | Approval + scheduled window | `XXHH` | **Before 2026-11-14T18:10:20Z** (25 days) |
| D6 | **DNS/TLS** | Jason / Platform | Add the custom domain in the Render dashboard; create the CNAME at GoDaddy → `bha-cst-7u9e.onrender.com` | `dig` result + valid certificate chain | `OYP9` | 3 business days |
| D7 | **BHARAG key scope** | Jegan / BHARAG key owner | Negative test, positive test, policy/workspace/index scope proof | Request/response pairs (masked) + policy excerpt | `KMG9`, `8D7U` | 2 business days |
| D8 | **KMG9 environment smoke tests** | Jason | Run the 5-case matrix (staging up/down, production up/down, cross-tenant refusal) | Request id + sanitized log per case | `KMG9`, `EWQI` | 2 business days |
| D9 | **`DW-96O8` acceptance policy** | Jason | Decide production-only vs staging acceptance for schema evidence | Written decision | `HOFE`, `IWKX` | 1 business day |
| D10 | **Operator Playbook publication + drill** | Ahad (publish) → Destiny (drill) | Publish to Codex → SOPs and BHARAG `sop/bays-cst-operations`; schedule the unannounced drill | Publication confirmation + a logged drill result | `Y5TW` | 2 business days |
| D11 | **Client 2 contact + session** | Jason (introduce) → Ahad (run) | Identify and introduce the designated contact | Session notes and client-confirmed requirements | `VU6R` | **Due 2026-10-20** |
| D12 | **Live Dashboard proof** | Jason + Dashboard owner | Approve a Dashboard test environment and authorize `REAL_DASHBOARD_PROOF=1` | The 3 validated events | `IWKX` part 4, `8D7U` | On approval |
| D13 | **Watch `DW-1791851358695-JU0D`, `DW-1792157614347-IPAR`** | Destiny / Jason | Confirm relevance and current state | Status confirmation | — | 1 business day |

### D.1 Actions deliberately **not** taken in this session (no authorization)

| Action | Why not | What would unblock it |
|---|---|---|
| Commit / push / merge / branch switch | No explicit authorization | Jason's authorization; note `autoDeploy` makes a push to `main` a production deploy |
| Deploy / trigger a deployment | No authorization — and **not needed**: the live deploy already equals HEAD | — |
| Change production config, env vars, DNS, DB allowlist, plan | No authorization | Jason / Platform |
| Run production migrations or any production SQL write | No authorization; the IP allowlist is empty and **no bypass was attempted** | D4, D5 |
| Rotate credentials | No authorization, and rotation would be premature before Query 3 | D1 |
| Place a call / send an SMS | No authorization, no verified number, no handset, no approved recipient | D2, D3 |
| Enable `REAL_DASHBOARD_PROOF=1` | Explicitly prohibited without an approved environment | D12 |
| Post to Slack or close any watch | Prohibited | Owner posts; Ahad's drafts are in `docs/release/cst-approval-requests.md` |
| Modify the vFarm application | Out of scope | — |

---

## E. Change and verification log

### E.1 Session — 2026-10-20T11:53Z → 12:20Z (Ahad)

**Evidence sources inspected:** `render deploys list`, `render postgres get -o json`, `render services get -o json`, `render logs` (CLI window measured 2026-10-19T18:07:30Z → 2026-10-20T11:56:47Z, 168 rows), `git log`/`merge-base`/`rev-list`, `dig`, `curl -sv`, `openssl`, the full `docs/release/` set, `db/migrations/`, `engine/src/{app,core,router,interfaces/voice,transport/twilio,middleware,consent,db,publishers}`, `scripts/{migrate,migration_checks}.js`, `render.yaml`, `package.json`.

**Files inspected (not changed):** `docs/release/CST_MASTER_TASK_AUDIT.md`, `docs/release/cst-5r0j-security-audit-and-residual-risk.md`, `docs/release/operator-playbook-sop.md`, `docs/release/cst-vu6r-prep.md`, `docs/release/cst-vu6r-blocker.md`, `docs/release/cst-voice-live-call-attempt.md`, `docs/release/cst-voice-live-e2e-*.md`, `docs/release/cst-voice-config-check.md`, `docs/release/cst-voice-corrected-preflight.md`, `docs/release/cst-database-continuity-plan.md`, `docs/release/cst-ho-fe-schema-verification-guide.md`, `docs/release/cst-kmg9-live-test-instructions.md`, `docs/release/cst-v1-release-readiness-assessment.md`, `docs/release/cst-sms-consent-verification-record.md`, `docs/release/cst-loops-status-2026-10-19.md`, `docs/release/cst-reconciliation-summary.md`, `docs/kmg9-verification-record.md`, `docs/eod-2026-10-19.md`, `docs/release/task.md`, `render.yaml`, `package.json`, all 19 files in `db/migrations/`.

**Files changed (4):**

| File | Change | Behaviour before → after |
|---|---|---|
| `docs/task.md` | Rewritten in place into the A–F structure | Old tracker (7 task sections, "As of 19 October 2026", stale deployed SHA `3e88058`) → authoritative ledger with the corrected deployed SHA, the 4-commit correction, full B.1–B.9 register, blockers D1–D13, change log, and handoff |
| `docs/release/CST_MASTER_TASK_AUDIT.md` | Correction notice added; §1, §7, §9.1, §10, §11, §12 updated | Stale "4 commits undeployed" claim → verified-live status with the history preserved |
| `docs/release/cst-5r0j-security-audit-and-residual-risk.md` | §2 middleware names corrected; §3 replaced with verified lineage + §3.1 correction + §3.2 live evidence; §4.1 added; §4.2 CLI translation added; §5 and §6 updated; §7 change log added | `requireVfarmProxyAuth`/`requireAdminAuth` (nonexistent names) → `requireVfarmAdminSession`/`requireVfarmAdminSessionOrJwt`; "audit pending" → bounded by deployment lineage with the vFarm gateway log as the one remaining item |
| `docs/release/operator-playbook-sop.md` | 8 factual errors corrected; §3.1 authoritative records, §3.2 normal operating procedure, §3.3 AI-assistant (renumbered), §11 rollback & incident handling, §12 evidence collection & sanitization added | A playbook with wrong paths, a nonexistent `--dry-run` flag, a wrong admin handle, and no rollback/evidence procedure → a verified, operationally complete document |
| `docs/release/cst-approval-requests.md` | **New** | 8 copy-ready approval drafts + the read-only operator query appendix (SMS delay, schema verification, 5R0J log queries) |

**Code changed (1, uncommitted):**

| File | Change | Before → after | Risk |
|---|---|---|---|
| `engine/src/transport/twilio/outbound.ts` | Removed a duplicated `isSmsCapabilityEnabled(msg)` block (23 lines) that ran immediately after an identical check. The first capability check, the consent gate, the DID resolution, and the `consent_exempt` fence are untouched and in their original order. | Before: the second identical check was unreachable dead code (the first already `continue`d). After: identical observable behaviour, one fewer redundant branch. | **None.** Behaviour-preserving. |

**Commands run, with exit codes:**

| Command | Exit | Result |
|---|---|---|
| `git rev-parse --show-toplevel` / `remote -v` / `branch --show-current` / `rev-parse HEAD` / `status --porcelain` / `log --oneline -30` | 0 | root `/Users/HaMi/Documents/Jason/customer twin`; remote `bhanetworkgh/bha_cst`; `main`; `b06c68f`; 1 modified + 2 untracked |
| `git merge-base --is-ancestor 3e88058 HEAD` | 0 | `3e88058` **is** an ancestor; `git rev-list --count 3e88058..HEAD` = **4** |
| `git merge-base --is-ancestor 31f3a5f 953d623` | 0 | **true** — the auth gate is in the first successful production deploy |
| `git log --diff-filter=A -- engine/src/middleware/vfarm_proxy_auth.ts` | 0 | gate introduced in `31f3a5f`, 2026-10-07 |
| `git log -S "'/api/devices'" --reverse -- engine/src/app.ts` | 0 | routes first added `9465fd4`, 2026-09-25 |
| `render deploys list srv-db8hepqvcj2c73adpus0` | 0 | **Live = `b06c68f`**, deploy `dep-dbb7gl9srm7s73dc8phg`; 4 prior deploys Inactive; 3 Build Failed (2026-10-15) |
| `render postgres get dpg-db8he2qvcj2c73ado3s0-a -o json` | 0 | `plan: free`, `expiresAt 2026-11-14T18:10:20.49769Z`, `createdAt 2026-10-15T18:10:20.49769Z`, `ipAllowList: []`, `version 16`, `status available` |
| `render services get srv-db8hepqvcj2c73adpus0 -o json` | 0 | `autoDeploy: yes`, `autoDeployTrigger: commit`, `branch: main`, `plan: free`, `createdAt 2026-10-15T18:11:51.680767Z`, `serviceDetails.url = https://bha-cst-7u9e.onrender.com` |
| `render logs -r srv-db8hepqvcj2c73adpus0` (+ `--path`, `--status-code`, `--limit`, `--start`) | 0 | 168 rows, window 2026-10-19T18:07:30Z → 2026-10-20T11:56:47Z; migration ledger `0 applied, 20 already recorded`; 019 applied; `[vFarm] Initialized with Live Key` |
| `curl` unauthenticated probe — 8 gated variants | 0 | **8/8 → 401** at 2026-10-20T11:56:13Z |
| `curl` fail-closed probe — synthetic invalid bearer token | 0 | `/api/devices` 403, `/api/dashboard` 403, `/api/farms` 401 (upstream rejected) — **no CST credential substitution** |
| `curl -s https://bha-cst-7u9e.onrender.com/health` | 0 | `{"status":"ok","service":"bha-cst-engine"}` |
| `dig`/`curl -sv` for `cst.bhanetwork.org`, `cst-admin.bhanetwork.org`, `bha-cst-7u9e.onrender.com` | 0 | both CST hostnames: **no A/AAAA/CNAME**; render host: valid cert (`CN=onrender.com`, Google Trust Services, `SSL certificate verify ok`, HTTP/2) |
| `npx vitest run tests/security/vfarm_proxy_unauth.test.ts` | 0 | **26 passed (26)** |
| `npx vitest run tests/consent/` | 0 | **38 passed (38)** — 28 + 10 |
| `npx vitest run tests/voice/` | 0 | **94 passed (94)** — 6 files |
| `npx vitest run tests/regression/kmg9_farm_isolation.test.ts` | 0 | **9 passed (9)** |
| `npm test` | 0 | **61 files passed; 618 passed / 6 skipped (624); 0 failed**; 18.28 s |
| `npm run typecheck` | 0 | `tsc --noEmit -p engine/tsconfig.json` — 0 errors |
| `npm run build` | 0 | `tsc -b` + `copy_web_assets: copied 8 entries to dist/web` |
| `git diff --check` | 0 | clean |

**Working-tree impact:** `M engine/src/transport/twilio/outbound.ts` (preserved from the previous session), `M docs/task.md`, `M docs/release/CST_MASTER_TASK_AUDIT.md`, `M docs/release/cst-5r0j-security-audit-and-residual-risk.md`, `M docs/release/operator-playbook-sop.md`, `?? docs/release/CST_MASTER_TASK_AUDIT.md` (untracked, from the previous session), `?? docs/release/cst-approval-requests.md`. **No commit, push, deploy, or production mutation.**

**Failed or blocked checks in this session (recorded, not hidden):**

| Check | Outcome |
|---|---|
| `render logs --start 2026-10-07T00:00:00Z` (and earlier) | **0 rows.** The CLI's retention floor is 2026-10-19T18:07:30Z. The pre-2026-10-15 window is not retrievable from this environment — this is why the 5R0J historical review cannot be closed here and needs Log Explorer access or the lineage evidence to be accepted. |
| Direct `psql` to `dpg-db8he2qvcj2c73ado3s0-a` | **Not attempted** — the IP allowlist is empty and bypassing it is prohibited. Schema objects remain unverified (B5.1). |
| `bha-cst.onrender.com` (legacy slug) | Does not resolve — confirms a single CST host. |
| `render` CLI custom-domain command | **Does not exist** (`render services` offers only create/delete/instances/update) → the DNS request must specify the dashboard path. |

**Actions not performed because approval was missing:** see §D.1 — no commit, push, deploy, config change, DNS change, plan change, migration, credential rotation, real call, real SMS, dashboard proof run, or Slack post.

### E.1b Session — 2026-10-20T12:11Z → 12:30Z (Ahad)

**Focus:** the four P0 readiness deliverables (5R0J · HOFE/NI8F · VJU6 · last passing test run), plus one new P0 discovered during the work.

**Files inspected (not changed):** `docs/task.md`, `docs/release/task.md`, `docs/release/CST_MASTER_TASK_AUDIT.md`, `docs/release/cst-5r0j-security-audit-and-residual-risk.md`, `docs/release/cst-approval-requests.md`, `docs/release/cst-ho-fe-schema-verification-guide.md`, `docs/release/cst-sms-consent-verification-record.md`, `docs/kmg9-verification-record.md`, `docs/vju6-proposed-verification-record.md`, `docs/cst-v1-readiness-audit.md`, `docs/cst-pilot-checklist.md`, `docs/eod-2026-10-12.md`, `docs/eod-2026-10-14.md`, `docs/release/cst-closure-checklist.md`, `docs/release/cst-production-readiness-audit.md`, `engine/src/app.ts`, `engine/src/middleware/vfarm_proxy_auth.ts`, `engine/src/admin/auth.ts`, `engine/src/admin/routes.ts`, `engine/src/interfaces/voice/index.ts`, `engine/src/interfaces/web/index.ts`, `engine/src/core/registry.ts`, `engine/src/transport/twilio/signature.ts`, `engine/src/config/runtime.ts`, `engine/src/config/env.ts`, `engine/src/publishers/dashboard.ts`, `engine/src/publishers/delivery.ts`, `engine/src/docs/swagger.ts`, `db/migrations/016`–`019`, `scripts/migrate.js`, `scripts/migration_checks.js`, `render.yaml`, `.env.example`, `web/phone-test-console.html`, `tests/voice/voice_interface.test.ts`, `tests/voice/voice_guest_access_regression.test.ts`, `tests/security/vfarm_proxy_unauth.test.ts`, `tests/integration/dashboard_real_proof.test.ts`.

**Files changed (7):**

| File | Change |
|---|---|
| `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md` | **New.** The four-deliverable evidence report: route-by-route 5R0J table, lineage + rotation status, consent migration inventory, staging assessment, VJU6 verification inventory, test evidence, blocked checks, acceptance criteria, operator queries. |
| `docs/release/cst-readiness-slack-reply.md` | **New.** Copy-ready draft for Jason/Destiny/Bays. Not sent. |
| `docs/task.md` | This ledger — §A refreshed, §A.2 rewritten, B1.1/B1.2/B1.6/B4.1/B5.1/B6.7 added or updated, §C refreshed, §E.1b added, §F refreshed. |
| `docs/release/task.md` | Mirror of this file, path-adjusted. |
| `engine/src/middleware/programmatic_api_key.ts` | **New.** Fail-closed shared-secret guard for the programmatic voice API. |
| `engine/src/interfaces/voice/index.ts` | Guard applied to the 3 programmatic routes; `verifyTwilioSignature` added to the Twilio-hosted status routes. |
| `tests/security/programmatic_voice_auth.test.ts` | **New.** 10 focused security tests. |
| `tests/voice/voice_interface.test.ts` | 12 programmatic call sites now present the credential; 5 status-route call sites present a signature. |
| `tests/voice/voice_guest_access_regression.test.ts` | 3 status-route call sites present a signature. |
| `engine/src/docs/swagger.ts` | `/voice/turn` description states the `x-cst-api-key` requirement and fail-closed behaviour. |
| `.env.example` | `CST_API_KEY` documented with the fail-closed and set-before-deploy warnings. |
| `docs/release/cst-approval-requests.md` | Corrected the §A.2.3 index name to `idx_sms_consent_prompts_active_lookup` (the earlier name was not the one in migration 018). |

**Commands run, with exit codes and UTC timestamps:**

| Command | UTC start | Exit | Result |
|---|---|---|---|
| `render deploys list srv-db8hepqvcj2c73adpus0` | 12:12Z | 0 | Live = `b06c68f`, deploy `dep-dbb7gl9srm7s73dc8phg`; 4 prior deploys Inactive; 3 Build Failed (2026-10-15) |
| `render logs --text "019_backfill_project_voice_pointer"` | 12:12Z | 0 | `Applying migration: 019…` → `✓ Successfully applied` at 2026-10-19 20:07:33Z; 4× `already applied, skipping` since |
| `render postgres get … -o json` / `render services get … -o json` | 12:12Z | 0 | expiry `2026-11-14T18:10:20.49769Z`; `ipAllowList []`; `autoDeploy: yes`; `createdAt 2026-10-15T18:11:51.680767Z` |
| `curl` unauthenticated probe — 8 gated variants | 11:56Z | 0 | **8/8 → 401** |
| `curl` fail-closed probe — synthetic invalid bearer token | 11:56Z | 0 | farm-key routes → 403; JWT routes → 401 upstream; no CST credential substitution |
| `curl` empty-body probe — 3 programmatic voice routes | 12:05Z | 0 | 400 / 400 / 404 → **no auth gate** (the P0 finding) |
| `curl` `/debug/state` | 12:05Z | 0 | **404** in production (correctly disabled) |
| `render ssh srv-db8hepqvcj2c73adpus0` | 12:16Z | 1 | `Permission denied (publickey)` — no key authorised; **not worked around** |
| `npx vitest run tests/security/vfarm_proxy_unauth.test.ts` | 12:25:06Z | 0 | 26 passed (26), 2 s |
| `npx vitest run tests/security/programmatic_voice_auth.test.ts` | 12:25:08Z | 0 | 10 passed (10), <1 s |
| `npx vitest run tests/consent/` | 12:25:08Z | 0 | 38 passed (38), 2 s |
| `npx vitest run tests/voice/` | 12:25:10Z | 0 | 94 passed (94), 2 s |
| `npx vitest run tests/regression/kmg9_farm_isolation.test.ts` | 12:25:12Z | 0 | 9 passed (9), 1 s |
| `npx vitest run tests/integration/dashboard_e2e.test.ts tests/integration/dashboard_dry_run.test.ts` | 12:25:13Z | 0 | 24 passed (24), 10 s |
| `npx vitest run tests/integration/dashboard_real_proof.test.ts` | 12:25:23Z | 0 | 1 passed / **6 skipped** — gated, not run |
| `npm test` | 12:25:31Z | 0 | **628 passed / 6 skipped (634), 0 failed**, 62 files, 10.39 s |
| `npm run typecheck` | 12:25:41Z | 0 | 0 errors |
| `npm run build` | 12:25:43Z | 0 | clean; 8 web assets |
| `git diff --check` | 12:25:45Z | 0 | clean |

**Failures encountered and preserved (not hidden):**

| Failure | Cause | Resolution |
|---|---|---|
| `tests/voice/voice_interface.test.ts` — *"Transform failed … Expected ")" but found "')'"* | An edit script double-wrapped `.post('/api/v1/voice/turn')` into `.post('.post('/api/v1/voice/turn')')`. | **Repaired**; the file collects and passes. |
| 8 call sites returned 401 instead of 200/403 | The Twilio-hosted voice status route previously had **no** middleware at all; adding `verifyTwilioSignature` changed its contract. | **Resolved** by presenting a signature in the affected tests, and by signing the Twilio-hosted status routes so they match their sibling inbound routes. |
| `tests/security/programmatic_voice_auth.test.ts` — 1 failure, `expected 404 to be 200` | The seeded voice DID was not bound in the new file. | **Fixed** by binding `+1971…5826` with `capability: 'voice'` in the new file's `beforeEach`. |

No test was disabled, skipped, or reclassified to inflate a count; no test configuration was changed to make the suite pass.

**Actions deliberately NOT taken (no authorization):** no commit, push, merge, branch change, or history rewrite; no deploy; no production configuration, DNS, DB allowlist, or plan change; no production migration or SQL write (and no allowlist bypass); no credential rotation; no real call or SMS; `REAL_DASHBOARD_PROOF` not enabled and the 6 live-Dashboard proofs not run; no Slack post and no watch closed; the vFarm application untouched.

**Blocked checks recorded:** vFarm API Gateway log review; production schema-object verification (DB allowlist empty); `DW-96O8` policy decision; live SMS round trip; live voice call; live Dashboard ingestion; the authoritative `VJU6` identifier; credential-rotation decision; `CST_API_KEY` provisioning.

### E.1c Session — 2026-10-20T12:11Z → 14:45Z (Ahad)

**Focus:** close every remaining actionable gap; Priority 0 programmatic voice authentication, 5R0J security acceptance and lineage, HOFE/NI8F consent acceptance, Priority 1 dashboard/VJU6 evidence, production operations.

**Key outcome: the previous session's voice fix was incomplete.** A programmatic extraction of every route registration in `engine/src` found **two further unauthenticated programmatic voice routes** the earlier fix had missed — `POST /voice/turn` and `POST /audio/speak`, both in `engine/src/transport/voice/voice_router.ts` (mounted at `engine/src/app.ts:91` with no middleware). `POST /voice/turn` is the same caller-asserted-`from_e164` impersonation path; `POST /audio/speak` let the caller choose `voiceId` outright.

**Files inspected (not changed):** `docs/task.md`, `docs/release/task.md`, `docs/release/CST_MASTER_TASK_AUDIT.md`, `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md`, `docs/release/cst-readiness-slack-reply.md`, `docs/release/cst-approval-requests.md`, `docs/release/cst-5r0j-security-audit-and-residual-risk.md`, `docs/release/operator-playbook-sop.md`, `docs/release/cst-ho-fe-schema-verification-guide.md`, `docs/release/cst-database-continuity-plan.md`, `docs/cst-pilot-checklist.md`, `docs/cst-v1-readiness-audit.md`, `docs/eod-2026-10-12.md`, `docs/eod-2026-10-14.md`, `engine/src/app.ts`, `engine/src/middleware/vfarm_proxy_auth.ts`, `engine/src/middleware/programmatic_api_key.ts`, `engine/src/transport/voice/voice_router.ts`, `engine/src/transport/voice/voice_lane.ts`, `engine/src/interfaces/voice/index.ts`, `engine/src/interfaces/sms/index.ts`, `engine/src/interfaces/web/index.ts`, `engine/src/admin/auth.ts`, `engine/src/admin/routes.ts`, `engine/src/consent/service.ts`, `engine/src/core/registry.ts`, `engine/src/publishers/dashboard.ts`, `engine/src/publishers/delivery.ts`, `engine/src/config/logger.ts`, `engine/src/config/runtime.ts`, `engine/src/server.ts`, `engine/src/docs/swagger.ts`, `db/migrations/001`–`019`, `render.yaml`, `package.json`, `.env.example`.

**Files changed (10) + created (4):**

| File | Change |
|---|---|
| `engine/src/transport/voice/voice_router.ts` | Guard applied to `POST /voice/turn` and `POST /audio/speak` — **the two missed routes** |
| `engine/src/middleware/programmatic_api_key.ts` | Boot-time config check (`checkProgrammaticApiKeyBootConfig`) + `resetProgrammaticApiKeyConfigLogging`; documents the deliberate no-abort decision |
| `engine/src/server.ts` | Boot check wired next to `CstDashboardPublisher.checkBootConfig()` |
| `engine/src/util/privacy.ts` | **New.** Shared `maskPhone` |
| `engine/src/consent/service.ts` | Phone numbers masked in all audit reasons, returned reasons, keyword logs and thrown messages |
| `engine/src/admin/routes.ts` | Local one-character `maskPhone` removed; shared helper used |
| `engine/src/interfaces/voice/index.ts` | Guest-caller audit reason masked; `maskPhone` import |
| `engine/src/transport/voice/voice_lane.ts` | `maskPhone` import (no call sites yet — those audit reasons carry CST-owned service numbers) |
| `engine/src/docs/swagger.ts` | `/voice/turn` and `/audio/speak` state the `x-cst-api-key` requirement and 503 fail-closed |
| `.env.example` | All five routes named; fail-closed and set-before-deploy semantics stated |
| `tests/security/programmatic_voice_auth.test.ts` | **New.** 10 → 21 tests: all five routes, empty/whitespace/malformed/wrong/prefix credentials, unconfigured and empty secret, credential-never-echoed, boot check |
| `tests/privacy/log_masking.test.ts` | **New.** 6 tests: `maskPhone` behaviour + consent refusal records contain no raw number |
| `tests/voice/voice_interface.test.ts` | 12 programmatic call sites now present the credential; 5 status-route sites present a signature |
| `tests/voice/voice_guest_access_regression.test.ts` | 3 status-route sites present a signature |
| `tests/voice/voice_lane.test.ts` | 6 call sites now present the credential |
| `tests/voice/voice_failure_path.test.ts` | 5 call sites now present the credential |
| `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` | **New.** The 12-section closure report |
| `docs/release/cst-readiness-slack-reply.md` | Updated with a dated correction block and the new evidence |
| `docs/task.md` / `docs/release/task.md` | This ledger + mirror |

**Commands run, with UTC timestamps and exit codes:**

| Command | UTC start | Exit | Result |
|---|---|---|---|
| `npx vitest run tests/security/programmatic_voice_auth.test.ts` | 14:40:45Z | 0 | 21 passed (21) |
| `npx vitest run tests/voice/` | 14:40:46Z | 0 | 94 passed (94) |
| `npx vitest run tests/consent/` | 14:40:49Z | 0 | 38 passed (38) |
| `npx vitest run tests/regression/kmg9_farm_isolation.test.ts` | 14:40:50Z | 0 | 9 passed (9) |
| `npx vitest run tests/integration/dashboard_e2e.test.ts tests/integration/dashboard_dry_run.test.ts` | 14:40:51Z | 0 | 24 passed (24) |
| `npx vitest run tests/privacy/log_masking.test.ts` | 14:41:01Z | 0 | 6 passed (6) |
| `npm test` | 14:41:02Z | 0 | **645 passed / 6 skipped (651), 0 failed**, 63 files, 21 s |
| `npm run typecheck` | 14:41:23Z | 0 | 0 errors |
| `npm run build` | 14:41:25Z | 0 | clean; 8 web assets |
| `git diff --check` | 14:41:27Z | 0 | clean |
| `render deploys list srv-db8hepqvcj2c73adpus0` | 14:39Z | 0 | Live = `b06c68f`, zero drift |
| `render postgres get dpg-db8he2qvcj2c73ado3s0-a -o json` | 14:39Z | 0 | `plan=free`, `expiresAt=2026-11-14T18:10:20.49769Z`, `ipAllowList=[]`, `status=available` |
| `dig` + `curl -sv` for the two CST hostnames | 14:39Z | 0 | Neither resolves (no A/AAAA/CNAME) — a **DNS** failure, not a certificate or application failure |
| `curl -s https://bha-cst-7u9e.onrender.com/health` | 14:39Z | 0 | 200 `{"status":"ok","service":"bha-cst-engine"}` |
| `find`/`grep` for CI, Docker, Terraform, k8s, Procfile, deploy scripts | 14:37Z | 0 | **None exist.** `render.yaml` is the only deployment manifest |

**Failures encountered and preserved (7, none hidden):** two in the new security test (a missing DID binding, and an un-onboarded speaker producing a **correct** 403 from the authorization chain); two in the new privacy test (a mask-format expectation, and `DbClient.seedSmsConsent` not existing — replaced with the real `recordOptOut`); two in typecheck (`'startup'` is not a valid `EntryPoint` — the union is `'webhook' | 'admin_panel' | 'api'`; and a wrong relative import depth in `voice_lane.ts`). All are itemised in `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` §5.1.

**Actions deliberately NOT taken:** no commit, push, merge, branch change or history rewrite; no deploy or restart; no Render configuration, environment variable, DNS or certificate change; no remote migration or production SQL (and no allowlist bypass); no credential rotation; no real call or SMS; no outbound queue trigger; `REAL_DASHBOARD_PROOF` not enabled and the 6 live-Dashboard proofs not run; no Slack post and no watch closed; the vFarm application untouched; no pre-existing modification discarded.

### E.1d Session — 2026-10-20T15:54Z → 16:30Z (Ahad)

**Focus:** continue the remaining work — complete the PII masking, close the Dashboard publish-failure durability gap, fix the unfulfilled Operator Playbook claim, and keep the tree green.

**Headline: a concurrent agent had left the working tree red.** Another agent was editing this same working tree between 14:27Z and 14:28Z (`engine/src/core/types.ts`, `engine/src/core/registry.ts`, `engine/src/transport/twilio/client.ts`, plus a new `Archive.zip`) and stopped without getting the build green. Their change was **not reverted** — it is a coherent, better design:

| Their change | Status |
|---|---|
| `CapabilityType` widened with a combined `'sms_voice'` capability + a `matchesCapability` matcher | Preserved |
| The one service number CST actually owns bound as `sms_voice`; the fictional candidate numbers and the dallas sms binding removed from the production seed | Preserved |
| `resolveServiceNumber` and the SMS ingress tenancy check using `matchesCapability` | Preserved |
| The seeded voice pointer replaced with the env-resolved pointer (removing the invalid `eleven_voice_jason_vfarm` placeholder) | Preserved |
| `messagingServiceSid` preferred for A2P routing (avoids Twilio 21659) | Preserved |

**What I completed on top of it (never reverting their work):**

| Fix | Why |
|---|---|
| `engine/src/core/types.ts` — added `TurnChannel = Exclude<CapabilityType, 'sms_voice'>` | A combined capability is a *binding* property; one turn is always on one transport. The turn-channel type now tracks `CapabilityType` automatically, so widening the capability set can never silently widen the turn channel. |
| `engine/src/core/envelope.ts` — `channel` narrowed to `TurnChannel` | The two `cst.turn` event assignments then type-check against the event contract, which correctly excludes `sms_voice`. |
| `engine/src/transport/twilio/outbound.ts` — `validateConsentExempt` and the queued-`from_e164` check now use `matchesCapability` | Their change had updated the SMS ingress path but missed these two, so a legitimate `sms_voice` number was refused the consent-exempt bypass and could not be used as the sending number. **This was the defect that produced 17 of the 24 failures.** |
| `engine/src/interfaces/voice/index.ts` — the two voice capability checks use `matchesCapability` | A `sms_voice` binding was refused by the voice lane — the number was bound but neither lane could use it. |
| 5 test files given a second-DID fixture | The production seed deliberately no longer fabricates numbers CST does not own, so tests that need a second project's DID must bind their own — the same pattern used in `tests/security/programmatic_voice_auth.test.ts`. |
| `tests/voice/voice_interface.test.ts` voice-id assertion | It asserted the **invalid placeholder**; it now asserts the configured pointer **and** that the placeholder is not used — a stronger assertion than before. |

**Files changed (13) + created (5):**

| File | Change |
|---|---|
| `engine/src/core/types.ts` | `TurnChannel` added; the other agent's `CapabilityType`/`matchesCapability` preserved |
| `engine/src/core/envelope.ts` | `channel` narrowed to `TurnChannel` |
| `engine/src/transport/twilio/outbound.ts` | `matchesCapability` in the consent-exempt and queued-from checks; `maskPhone` import |
| `engine/src/interfaces/voice/index.ts` | `matchesCapability` in the two voice capability checks; `maskPhone` in every `actor` field and the guest reason |
| `engine/src/transport/voice/voice_lane.ts` | `maskPhone` in the `actor` fields; `maskPhone` import |
| `engine/src/interfaces/sms/index.ts` | `maskPhone` in the SMS sender `actor` field; `matchesCapability` import |
| `engine/src/consent/service.ts` | All remaining phone interpolations masked (keyword logs, thrown messages) |
| `engine/src/identity/resolver.ts` | Caller's number masked in 3 log lines |
| `engine/src/adapters/vfarm/index.ts` | Caller's number masked in 1 log line |
| `engine/src/admin/routes.ts` | Onboarded-speaker number masked |
| `engine/src/db/client.ts` | **Dashboard outcome store + 4 methods + `clearAll`/`clearInMemory` clearing** |
| `engine/src/publishers/dashboard.ts` | `recordOutcome` on every path; `maskEventForStorage`; `replayUnpublishedDashboardEvents` |
| `engine/src/server.ts` | Boot-time config check wired (previous session) |
| `db/migrations/020_dashboard_publish_outcomes.sql` | **New.** Durable, TTL-bounded, masked publish-outcome table |
| `tests/identity/sms_voice_capability.test.ts` | **New.** 12 tests for the combined capability |
| `tests/publishers/dashboard_publish_outcomes.test.ts` | **New.** 11 tests for durable outcomes, dead-letter, replay, masking, isolation |
| `tests/privacy/log_masking.test.ts` | **New.** 6 tests (previous session) |
| `tests/identity/runtime_identity_model.test.ts` | Capability assertions updated to the combined binding; dallas DID fixture |
| `tests/tenancy/platform_tenancy.test.ts` | dallas DID fixture |
| `tests/tenancy/tenancy_verification.test.ts` | dallas DID fixture |
| `tests/transport/outbound_tenancy.test.ts` | dallas DID fixture |
| `tests/voice/voice_interface.test.ts` | Voice-id assertion strengthened; credential + signature headers |
| `docs/release/operator-playbook-sop.md` | **§6 Area 5** and the **§11.1 `CST_API_KEY` precondition** actually added (a previous report had claimed this without making the edit) |
| `docs/release/cst-approval-requests.md` | §1 rewritten from "nothing to deploy" to a real deployment request with the `CST_API_KEY` precondition and the migration 020 approval item |
| `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` | Concurrency finding, gap 3 and gap 14 status, the playbook correction |

**Commands run, with UTC timestamps and exit codes:**

| Command | UTC start | Exit | Result |
|---|---|---|---|
| `npx vitest run tests/security/programmatic_voice_auth.test.ts` | 14:40:45Z | 0 | 21 passed (21) |
| `npx vitest run tests/voice/` | 14:40:46Z | 0 | 94 passed (94) |
| `npx vitest run tests/consent/` | 14:40:49Z | 0 | 38 passed (38) |
| `npx vitest run tests/regression/kmg9_farm_isolation.test.ts` | 14:40:50Z | 0 | 9 passed (9) |
| `npx vitest run tests/integration/dashboard_e2e.test.ts tests/integration/dashboard_dry_run.test.ts` | 14:40:51Z | 0 | 24 passed (24) |
| `npx vitest run tests/privacy/log_masking.test.ts` | 14:41:01Z | 0 | 6 passed (6) |
| `npm test` | 14:41:02Z | 0 | 645 passed / 6 skipped (651), 0 failed, 63 files |
| `npm run typecheck` / `build` / `git diff --check` | 14:41:23–27Z | 0 / 0 / 0 | clean |
| `npm test` ×3 (post-fix) | ~16:20Z | 0, 0, 0 | **668 passed / 6 skipped (674), 0 failed, 65 files** each run |
| `npm run typecheck` / `build` / `git diff --check` | ~16:25Z | 0 / 0 / 0 | clean |

**Failures encountered and preserved (not hidden):**

| Failure | Cause | Resolution |
|---|---|---|
| 24 tests failing across 8 files after the concurrent agent's change | Three strict capability comparisons still used `=== 'sms'` / `!== 'voice'`, so a combined binding was refused by both lanes | Completed their change with `matchesCapability`; the consent-exempt guard was the single defect behind 17 of the 24 |
| `TS2322: Type 'CapabilityType' is not assignable to type '"sms" \| "voice" \| ...'` | The turn event's channel cannot be a combined capability | Added `TurnChannel` and narrowed the envelope channel |
| `TS2304: Cannot find name 'matchesCapability'` in `interfaces/voice/index.ts` | The import guard matched an existing `core/types.js` substring and skipped the import | Added the import to the existing `core/types.js` import line |
| `TS2307: Cannot find module '../util/privacy.js'` in `adapters/vfarm/index.ts` | Wrong relative depth — the file is two levels below `engine/src` | Corrected to `'../../util/privacy.js'` |
| `programmatic_voice_auth` — `expected 404 to be 200` | The new test file had no voice-capable DID bound | Bound one in `beforeEach` |
| `programmatic_voice_auth` — `expected 403 to be 200` | The asserted caller was not onboarded, so the **authorization** chain (not the auth guard) refused the farm request | Onboarded a known manager as production does; the 403 was **correct behaviour** |
| `log_masking` — mask format mismatch, and `DbClient.seedSmsConsent` does not exist | Test expectations were wrong | Corrected the expectation; used the real `recordOptOut` API |
| `sms_voice_capability` — `expected 'sms_voice' to be 'sms'`, and `expected undefined to be 'proj-vfarm-dallas'` | Two of my new assertions misread the API: `resolveServiceNumber` takes one argument, and `resolveOutboundSendingNumber` prefers the project's own binding | Rewrote both against the real semantics; the rewritten test is **stronger** (it asserts the combined binding satisfies *both* transports) |
| `sms_voice_capability` — `Expected ")" but found "s"` | An unescaped apostrophe in a test title | Renamed the test |
| `sms_voice_capability` — `Project "proj-voice-only-test" not found` | The project must exist for `resolveProjectServiceNumber` | Registered the test project |
| `dashboard_publish_outcomes` — `expected [ …2 items… ] to have a length of 1` | **A real defect in my own change**: the new outcome store was not cleared by `DbClient.clearAll()`, so one test file's publishes surfaced in the next file's dead-letter view | Added the clear to `clearAll()` (and confirmed it in `clearInMemory()`), with a dedicated isolation test |
| `e2e_production_hardening` — `expected undefined to be 'SYSTEM_NOT_FOUND'` (once, in the full suite only) | An **intermittent ordering flake** — the test passes in isolation and in three subsequent full runs | Investigated: every engine 404 carries an `error` field, so the body was not JSON, which points at shared static state across files in a worker. **Not reproduced in three consecutive full-suite runs** (668/674 each). Recorded as a known intermittent of the same class as the documented voice flake, not hidden behind the green run. |

**Actions deliberately NOT taken:** no commit, push, merge, branch change or history rewrite; no deploy or restart; no Render configuration or environment variable change; no remote migration or production SQL (and no allowlist bypass); no credential rotation; no real call or SMS; no outbound queue trigger; `REAL_DASHBOARD_PROOF` not enabled and the 6 live-Dashboard proofs not run; no Slack post and no watch closed; the vFarm application untouched; **the concurrent agent's changes were completed, not reverted**; no pre-existing modification discarded.

### E.1e Session — 2026-10-20T17:20Z → 17:40Z (Ahad)

**Focus:** implement the SMS & voice brief: one owned number serving both transports, phantom-number removal, outbound sender selection, bounded voice-turn processing, explicit Gather timing, and the Dallas capability reconciliation.

**Files changed (12 source/config, 13 test) + created (4):**

| File | Change |
|---|---|
| `db/migrations/021_repair_service_number_bindings.sql` | **New.** Forward fix: `+19715885823` → `'sms_voice'`; the unowned `+19715885824` is **unbound, not deleted** (the schema's `status`/`unbound_at` preserve the audit trail). Idempotent, additive, guarded on the FK targets. No Dallas sender invented. |
| `engine/src/admin/routes.ts` | `/numbers/sync` no longer fabricates candidates: no `tenant_id` → 400 `TENANT_ID_REQUIRED`; no adapter → 409 `NO_ADAPTER`. |
| `engine/src/adapters/vfarm/index.ts` | `pullCandidateNumbers()` returns only `VFARM_CANDIDATE_NUMBERS` (validated E.164) or `[]` with a warning. **No fabricated default.** |
| `engine/src/core/registry.ts` | Seed binds only the owned `+19715885823` as `'sms_voice'`; `proj-vfarm-dallas` is now `capabilities.voice: false` / `voice_enabled: false` with the reasoning recorded. |
| `engine/src/transport/twilio/client.ts` | **21659 added to `nonRetriableErrorCodes`** (permanent sender-configuration failure). The payload builder is extracted and testable; a Messaging Service SID is sent **alone**, never with a conflicting `from`. A send with **no sender at all** is refused before the API call (fail-closed, checked before the mock handler). Customer numbers masked in the Twilio logs. |
| `engine/src/interfaces/voice/index.ts` | **Bounded voice-turn deadline** (default 7000 ms, `CST_VOICE_TURN_DEADLINE_MS`, clamped 1000–20000). An `AbortController` is threaded into the turn and down to the synthesizer's `fetch`, with abort checkpoints **before synthesis** and **after synthesis** so an abandoned turn persists no transcript, no voice-delivery row and no alert-audit row. All **11** `<Gather input="speech">` tags now carry `speechTimeout="auto" timeout="5"`. |
| `engine/src/audio/synthesis.ts` | `AudioSynthesisInput.signal` — the TTS HTTP request is genuinely cancellable, and an abort is reported as an abort, not a provider failure. |
| `engine/src/core/types.ts`, `core/envelope.ts` | `TurnChannel = Exclude<CapabilityType,'sms_voice'>`; the envelope channel is narrowed so a combined binding can never leak into a turn event. |
| `.env.example` | Documented the Messaging Service sender-pool requirement, `VFARM_CANDIDATE_NUMBERS`, and `CST_VOICE_TURN_DEADLINE_MS`. |
| `tests/voice/voice_turn_deadline.test.ts` | **New, 9 tests.** Fast turn; slow CoreEngine; slow synthesis; synthesis rejection; late completion; no persistence; deadline configuration/clamping; HTTP-boundary TwiML; no security-gate bypass. |
| `tests/transport/twilio_sender_selection.test.ts` | **New, 12 tests.** Payload contract; env SID wins; no conflicting `from`; fail-closed with no sender; 21659 permanent; neighbouring codes not swept in. |
| `tests/identity/sms_voice_capability.test.ts` | **New, 12 tests.** The combined capability matches both transports and neither unrelated channel. |
| `tests/admin/admin_api.test.ts` | The stale "sync returns numbers" test replaced by three: configured candidates returned, none configured → empty and nothing fabricated, missing `tenant_id` → 400. |
| `tests/tenancy/db_tenancy.test.ts` | The stale assertion that `+19715885824` was a default binding is now a **regression test** that the phantom is never bound. |
| 5 further test files | The real unowned number `+19715885824` replaced by the synthetic `+19715550100` in every second-DID fixture; the stale voice-id assertion strengthened. |

**Commands run, with UTC timestamps and exit codes:**

| Command | UTC start | Exit | Result |
|---|---|---|---|
| `npx vitest run tests/identity/runtime_identity_model.test.ts` | 17:34:55Z | 0 | 8 passed (8) |
| `npx vitest run tests/transport/outbound.test.ts tests/transport/outbound_tenancy.test.ts` | 17:34:56Z | 0 | 26 passed (26) |
| `npx vitest run tests/voice/{voice_interface,voice_lane,voice_failure_path,voice_guest_access_regression}.test.ts` | 17:34:58Z | 0 | 86 passed (86) |
| `npx vitest run tests/admin/` | 17:34:59Z | **1 → 0** | first run 1 failed / 36 passed; after the fix **39 passed (39)** |
| `npx vitest run tests/consent/` | 17:35:03Z | 0 | 38 passed (38) |
| `npm run typecheck` / `build` / `git diff --check` | 17:35:04–07Z | 0 / 0 / 0 | clean |
| `npm test` ×2 | 17:35:41Z, 17:35:51Z | 0, 0 | **691 passed / 6 skipped (697), 0 failed, 67 files** each |
| `npm test` (final) | 17:37:31Z | 0 | 691 passed / 6 skipped (697), 0 failed |

**Failures encountered and preserved (6):** the stale admin sync test; 5 stale TwiML Gather assertions; **a real defect in this session's first deadline implementation** (`synthesizeSpokenAudio` wrote the voice-delivery row before the abort checkpoint could stop it — now refused for an aborted synthesis, with a dedicated test); an HTTP-boundary test that omitted `Accept: text/xml` and was therefore correctly treated as a JSON caller; and two Twilio tests that deleted a **required** env var, which made `getEnv()` throw before the code under test ran.

**Actions deliberately NOT taken:** no commit, push, deploy, Render configuration change, production SQL, remote migration, real call, SMS, outbound queue dispatch, credential rotation, DNS change, `REAL_DASHBOARD_PROOF` run, or Slack post. Migration 021 has **not** been applied anywhere. The Twilio sender pool and the number ownership remain operator-only checks.

**Report:** `docs/release/CST_SMS_VOICE_IMPLEMENTATION_REPORT.md` — every issue marked `FIXED LOCALLY`, `BLOCKED ON OPERATOR` or `NOT REPRODUCED`, with the operator checklist in §7.

### E.2 Earlier sessions (history preserved)

| Date | Summary |
|---|---|
| 2026-10-19 | Security hardening (5R0J), consent spine (NI8F), migration 017/018 (HOFE), DB continuity plan (XXHH), Operator Playbook draft (Y5TW), v1 readiness assessment (IWKX). Baseline recorded as 584 passed / 6 skipped, deployed SHA `3e88058` — **both later superseded** (see §A.1). |
| 2026-10-19 21:26–2026-10-20 01:06 | 4 commits authored and auto-deployed: `b5697b4` (guest voice ingress), `ac387be` (raw TwiML, Twilio 12300 fix), `438a162` (docs), `b06c68f` (voice-pointer backfill, migration 019, `migration_checks.js`). |
| 2026-10-20 11:00–11:20 | Master audit produced; **its central deployment claim was wrong** — corrected in this session. |
| 2026-10-19 | `LOOP-1791467054702-NI8F` outbound-consent incident fixed: `validateConsentExempt` reordered after `resolveOutboundSendingNumber`; `resolvedFromE164` added; duplicate `canSendSms` declarations removed. |
| 2026-10-05 | Voice flake investigated: passes 6/6 in isolation; flake appears only under the full suite. Did **not** reproduce on 2026-10-20. |
| 2026-10-13 | CST readiness verification: 551 tests passing, typecheck and build clean; production blocked on DNS/TLS, config, and acceptance. |
| 2026-10-15 | Voice guest access allowed as restricted guests (least-privilege) — `b5697b4`. |
| 2026-10-09 | Critical outbound consent fix — see above. |
| 2026-10-15 (earlier) | DST/security/consent/verification watch `DW-1791852954583-46HC` opened. |

---

## F. Handoff and sharing

### F.1 Where everything is

| Artifact | Repository-relative path |
|---|---|
| **This ledger (authoritative)** | **`docs/task.md`** |
| Master audit (full reconciliation) | `docs/release/CST_MASTER_TASK_AUDIT.md` |
| **Readiness evidence report (5R0J · HOFE/NI8F · VJU6 · tests)** | **`docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md`** |
| **Remaining-gaps closure report (21 gaps, status per gap, evidence)** | **`docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md`** |
| **Combined Jason/Destiny/Bays reply draft (not sent)** | **`docs/release/cst-readiness-slack-reply.md`** |
| **Approval drafts (8, not sent) + operator queries** | **`docs/release/cst-approval-requests.md`** |
| 5R0J security audit, residual risk, sign-off criteria | `docs/release/cst-5r0j-security-audit-and-residual-risk.md` |
| Operator Playbook SOP (12 sections) | `docs/release/operator-playbook-sop.md` |
| KMG9 verification record | `docs/kmg9-verification-record.md` |
| DB upgrade / cutover / rollback plan | `docs/release/cst-database-continuity-plan.md` |
| DB schema verification checklist (operator) | `docs/release/cst-ho-fe-schema-verification-guide.md` |
| SMS consent verification record | `docs/release/cst-sms-consent-verification-record.md` |
| CST v1 release-readiness assessment | `docs/release/cst-v1-release-readiness-assessment.md` |
| KMG9 live smoke-test instructions (for Jason) | `docs/release/cst-kmg9-live-test-instructions.md` |
| VU6R agenda / validation table / blocker | `docs/release/cst-vu6r-prep.md`, `docs/release/cst-vu6r-blocker.md` |
| Voice live E2E runner | `scripts/e2e/voice_live_e2e.ts` |
| Log queries for 5R0J | `docs/release/cst-approval-requests.md` §A.3 · `cst-5r0j-security-audit-and-residual-risk.md` §4.2 |

### F.2 Copy-ready status summary

> **CST status — 20 Oct 2026 (Ahad)**
>
> **Local verification:** **668 passed / 6 skipped / 0 failed** across 65 files, typecheck clean, build clean, `git diff --check` clean — confirmed over three consecutive full runs.
>
> **Production:** the live deploy is `b06c68f` — **identical to `main` HEAD, zero drift**. Migration 019 is applied (`0 applied, 20 already recorded`). vFarm is connected live. All four commits from 19 Oct are live, including the Twilio `12300` content-type fix.
>
> **Correction to my previous message:** the programmatic voice API fix was **incomplete**. A full route inventory found **two further unauthenticated routes** — `POST /voice/turn` (the same caller-asserted-`from_e164` impersonation path) and `POST /audio/speak` (caller-chosen `voiceId`). **Five** routes were open, not three. All five are now behind one fail-closed guard with 21 tests, and the guard reports a missing secret at boot without aborting the process.
>
> **Another correction:** I said the Operator Playbook had been updated for the `CST_API_KEY` precondition. **It had not** — the edit was described but never made. It has now actually been made (§6 Area 5 and the §11.1 precondition) and verified by reading the file back.
>
> **Also closed:** customer phone numbers were in retained audit records (the consent refusals carried the full recipient number; the pre-existing admin mask hid only one character) — all customer-number sites are now masked, with service numbers deliberately kept (CST owns and publishes them). And a failed Dashboard publish is now **durable** — migration 020 adds a TTL-bounded, masked outcome table, every publisher path records an outcome, and dead-lettered events can be replayed.
>
> **5R0J:** 8/8 gated routes return 401 unauthenticated (live 2026-10-20T11:56:13Z); no credential substitution, no legacy fallback. The exposure window is bounded by deployment lineage — the gate was committed 8 days *before* the production service existed. The repo has no CI, Dockerfile, Terraform, k8s, Procfile or deploy script: `render.yaml` is the only deployment manifest. Remaining: the vFarm API Gateway log (including `POST /api/v1/tokens` key-issuance records), one confirmation line, and Destiny's acceptance + rotation decision. **Rotation: not performed.**
>
> **A concurrent agent's in-flight change was completed, not reverted:** the combined `sms_voice` capability, the single owned service number, the env-resolved voice pointer and the A2P messaging-service routing are all preserved; the three strict comparisons their change missed were finished, and the affected tests were given the second-DID fixture the production seed deliberately no longer fabricates.
>
> **Blockers, all access/approval:** set `CST_API_KEY` in Render **then** deploy (the deploy also applies migration 020) · one real voice call · one live SMS · DB read access · the vFarm gateway log · `DW-96O8` · DNS/TLS (neither hostname resolves) · Postgres Starter approval — **the free tier expires 2026-11-14T18:10:20Z, 25 days** · sign-offs from Destiny, Jason, Jegan and the Dashboard owner.
>
> **Reports:** `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` · `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md` · `docs/release/cst-readiness-slack-reply.md` (draft, not sent) · `docs/release/cst-approval-requests.md` (8 per-owner drafts). Ledger: `docs/task.md`.
>
> No commits, pushes, deploys, config changes, migrations, rotations, calls, SMS sends or Slack posts were made.

### F.3 The next operator's exact steps

1. **Read, in this order:** `docs/task.md` → §D (blockers) → `docs/release/cst-approval-requests.md` → §B of the master audit.
2. **Confirm nothing has drifted:**
   ```bash
   cd /path/to/customer\ twin
   git status --short
   git rev-parse HEAD
   render deploys list srv-db8hepqvcj2c73adpus0   # expect Live == HEAD
   render postgres get dpg-db8he2qvcj2c73ado3s0-a  # check expiresAt
   npm run typecheck && npm test && npm run build && git diff --check
   ```
3. **Post the `DW-1791852954583-46HC` reply** — drafts in `docs/release/cst-readiness-slack-reply.md` and `docs/release/cst-approval-requests.md` §6. This is the only item still on Ahad and it escalates on the next pass.
4. **Send the remaining 7 drafts** (§1–§5, §7, §8) to their named owners. Update §B and §D of this ledger with what was sent and when.
5. **Before any real call:** run the voice-pointer query (closure report §14.5) and confirm `projects.elevenlabs_voice_id` for `proj-vfarm-main` is `Hmy97GCI840wuICQesiM`, not the placeholder.
5b. **Before the next deploy, set `CST_API_KEY` in Render.** The programmatic voice guard **fails closed**: without that variable the five programmatic voice routes return 503. Set the secret first, then deploy. The boot check reports a missing secret once and writes a `SECURITY_LEDGER` entry; it deliberately does not abort the process.
6. **When a call/SMS is authorized:** run it, then record the Call SID / provider message ID, the delivery callback, and the sanitized logs in §C, and update the relevant row in §B from `BLOCKED` to `VERIFIED COMPLETE`.
7. **After every work session:** append to §E with the UTC timestamp, the files touched, the exact commands and exit codes, the test results, the working-tree impact, the external evidence checked, and the actions skipped for want of approval. Keep §F.2 current — it is what gets shared.
8. **Before the next deploy, provision `CST_API_KEY` in Render.** The new programmatic-voice guard **fails closed**: without that variable the three programmatic voice routes return 503. Set the secret first, then deploy.
9. **Never** commit or push without explicit authorization, and remember that on this service **`autoDeploy` makes a push to `main` a production deployment and a production migration**. Use the pre-push checklist in `docs/release/operator-playbook-sop.md` §11.1.

### F.4 Sanitization

This ledger contains no credentials, API keys, tokens, passwords, or private keys. Phone numbers and identifiers are masked or are test fixtures. The ElevenLabs identifier `Hmy97GCI840wuICQesiM` is a **voice-clone pointer**, not a secret — the architecture stores the pointer, not the clone — and it was already committed in migration 009 before this session.

---

*Ledger maintained by Ahad (`U0AC6RFNP3P`). Last evidence refresh 2026-10-20T12:20Z. Uncommitted — no production changes were made.*
