# CST Readiness Evidence — 5R0J · HOFE/NI8F · VJU6

**Repository:** `bhanetworkgh/bha_cst` (remote `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git`)
**Production:** `https://bha-cst-7u9e.onrender.com` · Render service `srv-db8hepqvcj2c73adpus0` · DB `dpg-db8he2qvcj2c73ado3s0-a`
**Prepared by:** Ahad (`U0AC6RFNP3P`)
**Evidence window:** 2026-10-20T11:53Z → 12:30Z (UTC)
**Status:** uncommitted working-tree document. No commit, push, deploy, production configuration change, production SQL write, credential rotation, real call, or SMS send was performed.

**Companion records:** [`docs/task.md`](../task.md) (authoritative ledger) · [`docs/release/CST_MASTER_TASK_AUDIT.md`](CST_MASTER_TASK_AUDIT.md) · [`docs/release/cst-5r0j-security-audit-and-residual-risk.md`](cst-5r0j-security-audit-and-residual-risk.md) · [`docs/release/cst-approval-requests.md`](cst-approval-requests.md) · [`docs/release/cst-readiness-slack-reply.md`](cst-readiness-slack-reply.md)

> **On historical records.** Every previous report is treated as a claim to be re-verified, not as a current fact. Where a prior figure is repeated below it carries its original timestamp and the timestamp of its re-verification. Corrections are dated, and the superseded value is preserved rather than deleted.

---

## 1. Executive readiness summary

| # | Area | Code | Local tests | Staging | Production | Remaining action | Owner |
|---|---|---|---|---|---|---|---|
| 1 | **5R0J** security | Complete | 26/26 + 10/10 (new) | **N/A — no staging environment exists** | Routes verified live 2026-10-20T11:56:13Z (8/8 → 401) | vFarm API Gateway log review (Query 3); one-line deploy confirmation; formal acceptance | Destiny + vFarm gateway owner + Jason |
| 2 | **HOFE** schema | Complete | 38/38 consent | **`STAGING E2E ACCEPTANCE: NOT EVIDENCED`** | Ledger `0 applied, 20 already recorded` — **objects unverified** | Run the §5.2 read-only catalog queries; `DW-96O8` policy decision | Jason / Platform |
| 3 | **NI8F** consent | Complete | 38/38 | **`STAGING E2E ACCEPTANCE: NOT EVIDENCED`** | **NOT VERIFIED** — no carrier round trip | One authorized live SMS: recipient + window + explicit dispatch authorization | Jason |
| 4 | **VJU6** verification | Plane exists | 24/24 dashboard e2e+dry-run | **NOT VERIFIED** | Dashboard ingestion **never proven**; no live delivery | Authoritative VJU6 ID; approved Dashboard test environment | Jason + Dashboard owner |

**Bottom line.** All four areas are **code-complete and locally verified**. None is accepted in production. The path to acceptance is **not** more engineering — it is access, hardware, one external log review, and four sign-offs.

**Three corrections to previously published records** (full detail in §9):

1. **The deployed SHA is `b06c68f`, not `3e88058`.** Verified via the Render API. The four commits from 19 Oct are live, and migration 019 is applied. The earlier "deploy 4 commits" action was based on a stale 2026-10-19T13:53Z observation that was never re-checked.
2. **The `5R0J` audit named two middleware that do not exist in the code** (`requireVfarmProxyAuth`, `requireAdminAuth`). The real gates are `requireVfarmAdminSession` and `requireVfarmAdminSessionOrJwt`.
3. **A new P0 finding, not previously reported:** the programmatic voice API was mounted with **no authentication at all**. See §2.5. A fail-closed guard is now implemented locally and uncommitted.

---

## 2. 5R0J — Security evidence

**Task:** `LOOP-1790790007707-5R0J` · **Related watch:** `DW-1791851358695-JU0D` · **Also tracked under:** `LOOP-1791852954583-46HC` / `DW-1791852954583-46HC`

### 2.1 Route-by-route authentication behavior (from code)

Extracted directly from `engine/src/app.ts` — the actual middleware mounted on each registration, not the intended design:

| Route | Method | Actual auth middleware (verified in code) | No credential | Invalid caller vFarm JWT | Admin vFarm JWT fallback? | Evidence |
|---|---|---|---|---|---|---|
| `/api/devices` | GET | `requireVfarmAdminSession` | **401** | **403** | **No** | `engine/src/app.ts:101` · live 2026-10-20T11:56:13Z |
| `/api/v1/devices` | GET | `requireVfarmAdminSession` | **401** | **403** | **No** | `engine/src/app.ts:101` · live 2026-10-20T11:56:13Z |
| `/api/dashboard` | GET | `requireVfarmAdminSession` | **401** | **403** | **No** | `engine/src/app.ts:121` · live 2026-10-20T11:56:13Z |
| `/api/v1/dashboard` | GET | `requireVfarmAdminSession` | **401** | **403** | **No** | `engine/src/app.ts:121` · live 2026-10-20T11:56:13Z |
| `/api/farms` | GET | `requireVfarmAdminSessionOrJwt` | **401** | **401** (upstream rejected the caller's token) | **No** | `engine/src/app.ts:171` · live 2026-10-20T11:56:13Z |
| `/api/v1/farms` | GET | `requireVfarmAdminSessionOrJwt` | **401** | **401** (upstream rejected) | **No** | `engine/src/app.ts:171` · live 2026-10-20T11:56:13Z |
| `/api/tokens` | POST | `requireVfarmAdminSessionOrJwt` | **401** | **401** (upstream rejected) | **No** | `engine/src/app.ts:207` · live 2026-10-20T11:56:13Z |
| `/api/v1/tokens` | POST | `requireVfarmAdminSessionOrJwt` | **401** | **401** (upstream rejected) | **No** | `engine/src/app.ts:207` · live 2026-10-20T11:56:13Z |

### 2.2 Does any route substitute an administrative vFarm JWT when caller authentication fails?

**No. Verified in code, not inferred.**

`engine/src/middleware/vfarm_proxy_auth.ts` grants exactly two modes and never a third:

| Mode | Granted when | Which credential is then used |
|---|---|---|
| `admin_session` | Caller presents a valid **CST admin session** (`x-admin-token`). | CST's own credential — correctly, because the caller *is* an authenticated CST administrator acting on their own behalf (the same authority `/api/v1/admin/*` already carries). |
| `caller_jwt` | Caller presents their **own** vFarm JWT (`Authorization: Bearer …`). | **Only that JWT**, forwarded verbatim. CST's admin JWT and farm key are never substituted. |

Everything else is refused. On the farm-key-scoped routes (`/api/devices`, `/api/dashboard`) a caller-supplied JWT is rejected with **403** rather than re-authenticated as CST, because the upstream read uses `X-Farm-Key` — honouring a JWT there would mean acting with CST's key while implying the caller's authority. On the JWT-scoped routes (`/api/farms`, `/api/tokens`) the caller's token is forwarded and an invalid one is rejected upstream with **401**.

**There is no legacy fallback path.** `requireVfarmAdminSessionOrJwt` never falls back to an administrative JWT when the caller's credential fails. A live check with a synthetic invalid bearer token confirmed it: `/api/devices` → 403, `/api/dashboard` → 403, `/api/farms` → 401 `vFarm rejected the supplied credentials`.

### 2.3 Commit and deployment lineage

| Fact | Value | Verified by | When |
|---|---|---|---|
| Authentication gate commit | `31f3a5f97113aec34316b03f669c0f37c3b9f40d` — *"Audit CST open loops, harden security, verify persistence, Dashboard, and pilot readiness"* | `git log --diff-filter=A -- engine/src/middleware/vfarm_proxy_auth.ts`; `git log -S "requireVfarmAdminSession" -- engine/src/app.ts` | 2026-10-20 |
| Gate commit date | 2026-10-07 01:57:30 +0500 | same | 2026-10-20 |
| Routes first added (unauthenticated) | `9465fd4` — 2026-09-25 03:26:39 +0500 | `git log -S "'/api/devices'" --reverse -- engine/src/app.ts` | 2026-10-20 |
| **Deployed SHA (live)** | **`b06c68fc5950e56ba140df892929d32c1a78e07a`** — deploy `dep-dbb7gl9srm7s73dc8phg`, created 2026-10-19T20:06:45Z, finished 20:07:43Z | `render deploys list srv-db8hepqvcj2c73adpus0` | 2026-10-20T11:55Z |
| Deployment drift | **Zero** — the live deploy is identical to repository HEAD | same | 2026-10-20 |
| Superseded deployed SHA | `3e88058a987b4cad0c72dfc3c94c75c8a353e96d` (deploy `dep-db98vidg1s2s73bun8eg`) — live 2026-10-16T20:57:45Z → 2026-10-19T20:06:45Z | `render deploys list` | 2026-10-20 |
| Auto-deploy behaviour | `autoDeploy: yes`, `autoDeployTrigger: commit`, branch `main`. **A push to `main` is a production deployment and a production migration.** | `render services get -o json` (`serviceDetails.envSpecificDetails.startCommand = "node scripts/migrate.js && npm start"`) | 2026-10-20 |
| Production service creation | **2026-10-15T18:11:51.680767Z** — 8 days *after* the gate commit | `render services get -o json` → `createdAt` | 2026-10-20 |
| Gate inside the first production deploy | `git merge-base --is-ancestor 31f3a5f 953d623` → **true**. `953d623` was the first successful deploy of that service (`dep-db8hi104ufvs73aqglj0`, 2026-10-15T18:19:45Z) | git | 2026-10-20 |
| PR reference | **None exists in this repository.** `git log` shows no merge commit, no PR-numbered subject, and the remote exposes no PR metadata. The commit is recorded by SHA only. | `git log --merges`, subject scan | 2026-10-20 |

### 2.4 Credential rotation status

**No rotation has been performed, and no rotation record exists in the repository.** Stated precisely, distinguishing what is verified from what is unknown:

| Question | Answer | Basis |
|---|---|---|
| Was a farm key or admin JWT rotated? | **No evidence of any rotation.** Not performed by this session (prohibited), and no rotation record, ticket, or commit exists in the repository. | Repository + session record |
| Is the current credential the one exposed pre-patch? | **Unknown.** The `X-Farm-Key` and admin-JWT values themselves are not stored in the repository, so pre-patch and current values cannot be compared. | No credential material in repo |
| Could a pre-patch exposure have occurred on the production service? | **No.** The production service was created 2026-10-15, eight days *after* the authentication gate was committed, and the gate is an ancestor of that service's first successful deploy. No production deploy ever ran the unauthenticated code. | §2.3 lineage |
| Does rotation remain advisable? | **It is now a policy decision, not an evidence-gated remediation step.** It should follow the vFarm gateway log review (§2.6), because rotation is itself a disclosable event and would break live vFarm integrations if performed unnecessarily. | Judgment, stated as such |
| Was a credential present in the repository? | **No.** The ElevenLabs identifier `Hmy97GCI840wuICQesiM` is a **voice-clone pointer**, not a secret — the architecture stores the pointer, not the clone. It was already committed in migration 009 (2026-10-08) before this work. | `db/migrations/009_add_voice_pointer_to_systems.sql` |

### 2.5 New finding — the programmatic voice API had no authentication (P0, not previously reported)

**This is outside the 5R0J route list, so it was never in that loop's scope. It is reported here because it is the same class of exposure and it changes the residual-risk picture.**

`engine/src/app.ts:92` mounts `voiceInterfaceRouter` with **no middleware**. Three routes on it therefore accepted anonymous callers:

| Route | Before the fix (verified live) | Exposure |
|---|---|---|
| `POST /api/v1/voice/turn` | **400 with an empty body, not 401/403** → no auth gate | The caller asserts `from_e164`. `CoreRegistry.resolveSpeaker` resolves that number through the vFarm adapter and returns the person's **role, permissions and `farm_ids`**, and the engine then answers with that speaker's farm scope. An anonymous caller could assert a known vFarm member's number and receive that member's farm-scoped answer. |
| `POST /api/v1/voice/synthesize` | **400 with an empty body, not 401/403** → no auth gate | Arbitrary `text` synthesized with the project's ElevenLabs **voice clone**: unpaid quota consumption and misuse of the clone. |
| `POST /api/v1/voice/status` | **404 `SYSTEM_NOT_FOUND` with an empty body** → reached the handler, no auth gate | Unauthenticated call-status injection. Blast radius is limited (tenant/project are resolved from the receiving-number binding, and client-supplied `tenant_id`/`project_id` is rejected with 403), but it is still an unauthenticated write path. |

**The behaviour was reproducible locally, without touching production.** The pre-existing test `tests/voice/voice_interface.test.ts:551` (*"processes valid voice turn for speaker with farm grants through CoreEngine"*) posts to `/api/v1/voice/turn` with **no credential of any kind** and asserts a 200 `synthesized` response for a known speaker. Its companion test at `:567` proves the scope is bound to the asserted number: a speaker with empty farm grants gets a safe general reply, not farm data. That is the same binding an attacker would exploit.

**The Twilio-hosted variants were correctly protected** and were not affected: `/webhooks/twilio/voice`, `/webhooks/twilio/voice/inbound`, `/twilio/voice`, `/twilio/voice/inbound`, `/webhooks/twilio/voice/turn` and `/twilio/voice/turn` all carry `verifyTwilioSignature`. The **status** routes were the exception — `/webhooks/twilio/voice/status` and `/twilio/voice/status` carried **no signature check at all**, an inconsistency with their sibling inbound routes. `docs/eod-2026-10-14.md:146` records an unsigned manual `POST` to that route returning `HTTP/2 200 OK`, which confirms it was publicly writable.

**Fix implemented locally (uncommitted, not deployed):**

| File | Change |
|---|---|
| `engine/src/middleware/programmatic_api_key.ts` | **New.** Fail-closed shared-secret guard. Requires `x-cst-api-key` matching `CST_API_KEY`, compared with `crypto.timingSafeEqual`. No credential → 401; wrong credential → 403; **secret not configured → 503 `CONFIG_MISSING`**. Every refusal is written to `SECURITY_LEDGER`. No test-mode bypass, so the regression suite cannot go vacuous. |
| `engine/src/interfaces/voice/index.ts` | Guard applied to `/api/v1/voice/turn` and `/api/v1/voice/synthesize`. `/api/v1/voice/status` moved to the programmatic guard; the Twilio-hosted status variants now carry `verifyTwilioSignature`, matching their sibling inbound routes. |
| `tests/security/programmatic_voice_auth.test.ts` | **New.** 10 focused tests: no credential → 401 on all three routes; wrong credential → 403; prefix-of-secret → 403; unset secret → 503; empty secret → 503; correct credential → 200 `synthesized`; the Twilio status route still answers with a signature rejection; refusals are audited. |
| `tests/voice/voice_interface.test.ts` | 12 programmatic call sites now present the credential; 5 status-route call sites present a signature. |
| `tests/voice/voice_guest_access_regression.test.ts` | 3 status-route call sites present a signature. |
| `engine/src/docs/swagger.ts` | `/voice/turn` description now states the `x-cst-api-key` requirement and the fail-closed behaviour. |
| `.env.example` | `CST_API_KEY` documented with the fail-closed note and the "set it in Render before deploying a build containing this guard" warning. |

**Deployment precondition (important):** because the guard **fails closed** when `CST_API_KEY` is unset, deploying this build without first setting that variable in Render would leave all three routes returning 503. The secret must be provisioned **before** the deploy. This is recorded in `docs/task.md` and in the deployment checklist.

**Not verified:** whether the production service already has an unauthenticated caller relying on these routes. A repository-wide search found **no consumer** of these three routes outside the test suite, the parallel agent worktree, and the harness's own copy of the source — so the blast radius of closing them is low, but the owner should confirm.

### 2.6 Current vs historical log evidence, and the exact remaining action

**Query 1 (Render, `200`/`304` on any gated path) — re-run 2026-10-20T12:00Z: zero rows.** The prior report's result (recorded 2026-10-19, re-confirmed 2026-10-20) is unchanged.

**Historical review status — now bounded, and the remaining item is precisely one log system:**

| Window | Status | Basis |
|---|---|---|
| Code-level window where the 4 proxy routes were unauthenticated | 2026-09-25 → 2026-10-07 | §2.3 |
| Was any of that window deployed to production? | **No.** The production service was created 2026-10-15T18:11:51Z, eight days after the gate. | §2.3 |
| Render log window reachable by the CLI | **2026-10-19T18:07:30Z → 2026-10-20T11:56:47Z** (168 rows). `--start` earlier than that returns zero rows. | `render logs --limit 500` |
| Consequence | The pre-2026-10-15 window is **not retrievable from this environment**. Either an operator with Render **Log Explorer** access searches further back, or the deployment-lineage evidence in §2.3 is accepted as the substitute. **That is Destiny's decision, not an engineering call.** | — |
| **vFarm API Gateway** (Query 3) | **NOT RUN — the single remaining technical item.** | — |

**Exactly what the vFarm API Gateway owner must provide:**

| # | Artifact | Form | Why it is the only remaining source |
|---|---|---|---|
| 1 | Access log for the CST service client | Query on the vFarm gateway, e.g. `service_client:"cst-engine"`, over **2026-09-25 → 2026-10-15** (the code-level unauthenticated window) and **2026-10-15 → present** | The gateway is the system that recorded what CST's farm key and admin JWT actually retrieved. Render's logs record CST's *inbound* requests; the gateway records CST's *upstream* reads. A pre-patch anonymous caller would have caused a gateway read that no legitimate CST session accounts for. |
| 2 | Every request made with the CST farm key / admin JWT, with source IP, timestamp, endpoint, and the farm id or unit id touched | Exported log rows, farm identifiers masked | This is the "was tenant data served to an unauthorized caller" question. Nothing in the CST repository can answer it. |
| 3 | A statement of the key's issuance history | Whether the farm key or admin JWT was rotated, when, and by whom, before 2026-10-15 | §2.4 shows the rotation history is unknown from the CST side. |
| 4 | Confirmation that no other CST deployment existed | One line from Jason/Destiny | Covers a staging box, developer machine, or a non-Render platform in the 2026-09-25 → 2026-10-07 window. No evidence of one exists; only the owner can confirm absence. |

**Do not represent the historical review as complete.** The current routes returning 401/403 proves present-state behavior only.

### 2.7 Destiny's outstanding acceptance step

1. Run the §2.2 live re-verification (already done 2026-10-20T11:56:13Z — result in §2.1) and confirm it satisfies the acceptance scope.
2. **Decide** whether the deployment-lineage evidence (§2.3) is accepted in place of the unreachable Render log window, **or** require an operator with Log Explorer access to search further back.
3. **Decide** whether credential rotation is required (§2.4) — after the gateway log review, not before.
4. **Log formal acceptance or rejection** of `LOOP-1790790007707-5R0J` with the reasoning. A generic "looks good" does not close it; the acceptance criteria are enumerated in `docs/release/cst-5r0j-security-audit-and-residual-risk.md` §6.

---

## 3. Deployment and production state (shared across all four areas)

| Item | Value | Verified | When |
|---|---|---|---|
| Branch / HEAD | `main` @ `b06c68fc5950e56ba140df892929d32c1a78e07a` | `git rev-parse HEAD` | 2026-10-20T11:54Z |
| Live deploy | `b06c68fc5950e56ba140df892929d32c1a78e07a` (`dep-dbb7gl9srm7s73dc8phg`) | `render deploys list` | 2026-10-20T11:55Z |
| Health | `GET /health` → 200 `{"status":"ok","service":"bha-cst-engine"}`; ~15–22 s cold wake (free tier hibernates after 15 min idle) | `curl` | 2026-10-20T11:56Z |
| Migration ledger (production) | `🎉 Migrations complete: 0 applied, 20 already recorded` — **019 applied**; the 019 apply itself logged `2026-10-19 20:07:33 Applying migration: 019_backfill_project_voice_pointer.sql… ✓ Successfully applied` | `render logs` | 2026-10-20T10:44:03Z, 11:04:47Z, 11:56:23Z |
| vFarm connectivity | `[vFarm] Initialized with Live Key. Target Farm: dynamic-discovery` | `render logs` | 2026-10-20T10:44:08Z |
| Production voice traffic | **None observed** in the retrievable log window — no `SYNTHESIS_FAILED`, no `NO_VOICE_POINTER`, and no voice delivery either | `render logs` | 2026-10-20 |
| Database | `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`), plan `free`, PG 16, `createdAt 2026-10-15T18:10:20.49769Z`, **`expiresAt 2026-11-14T18:10:20.49769Z`**, `ipAllowList []` | `render postgres get -o json` | 2026-10-20 |
| Direct DB access | **BLOCKED** — "IP allow-list: empty (external connections blocked)". **No bypass was attempted.** | same | 2026-10-20 |
| Container access | `render ssh` → `Permission denied (publickey)`; no key is authorised for this service. No attempt was made to add one. | `render ssh` | 2026-10-20 |
| `cst.bhanetwork.org` / `cst-admin.bhanetwork.org` | **Neither resolves** — no A, AAAA, or CNAME. TLS impossible ("Could not resolve host"). DNS is served by GoDaddy (`ns09/ns10.domaincontrol.com`). | `dig`, `curl -sv` | 2026-10-20T12:00:58Z |
| `bha-cst-7u9e.onrender.com` | Resolves; TLS `CN=onrender.com`, issuer Google Trust Services, `SSL certificate verify ok`, HTTP/2, cert valid 2026-09-21 → 2026-12-20 | `curl -sv` | 2026-10-20T12:00:58Z |

---

## 4. HOFE — Consent schema and migration evidence

**Task:** `LOOP-1791826143428-HOFE` · **Related consent task:** `LOOP-1791467054702-NI8F` · **Related watch:** `DW-1791829227726-96O8`

### 4.1 Exact migration inventory (paths and names confirmed on disk)

| File | Bytes | Schema effect |
|---|---|---|
| `db/migrations/016_sms_consent_spine.sql` | 4433 | `CREATE TABLE IF NOT EXISTS sms_consents` (with `ck_consent_status` CHECK), `CREATE TABLE IF NOT EXISTS sms_consent_audit`, unique index `unq_sms_consents_tenant_project_phone`, plus `idx_sms_consents_phone/_tenant/_status/_opted_out`, `idx_sms_consent_audit_consent/_phone/_tenant/_correlation`, `set_sms_consents_updated_at()` + trigger `trg_sms_consents_updated_at` |
| `db/migrations/017_sms_consent_audit_fk.sql` | 1265 | `CREATE UNIQUE INDEX IF NOT EXISTS unq_sms_consents_id_tenant`; `ALTER TABLE sms_consent_audit ADD CONSTRAINT fk_sms_consent_audit_consent`; `enforce_sms_consent_audit_append_only()` + trigger `trg_sms_consent_audit_append_only` |
| `db/migrations/018_sms_consent_prompts.sql` | 2088 | `CREATE TABLE IF NOT EXISTS sms_consent_prompts`; unique index `unq_sms_consent_prompts_active`; `idx_sms_consent_prompts_consent/_active_lookup/_phone/_tenant` |
| `db/migrations/019_backfill_project_voice_pointer.sql` | 523 | Voice-pointer backfill for `proj-vfarm-main` (not consent) — reviewed, idempotent, single guarded `UPDATE`, **applied in production** |

All are `IF NOT EXISTS`-guarded and re-runnable. `scripts/migration_checks.js` carries schema-effect checks for 016/017/018/019.

### 4.2 The five layers of consent evidence, kept separate

| Layer | What it proves | Status | Evidence |
|---|---|---|---|
| **1. Schema / migration implementation** | The DDL, constraints, indexes, FK and append-only trigger exist in the repository | **VERIFIED** | §4.1; `db/migrations/016`–`018`; `scripts/migration_checks.js` |
| **2. Local regression results** | The consent behaviour holds under the local suite | **VERIFIED — 38/38** | `npx vitest run tests/consent/` → 2 files, 38 passed, exit 0, 2026-10-20T12:25:08Z |
| **3. Production migration-ledger observation** | The migration runner recorded 016–019 as applied | **OBSERVED ONLY** — `0 applied, 20 already recorded` (2026-10-20T11:56:23Z) | `render logs` |
| **4. Actual staging E2E evidence** | A staging environment ran a real consent round trip | **`STAGING E2E ACCEPTANCE: NOT EVIDENCED`** | §4.3 |
| **5. Production consent acceptance** | A carrier round trip with a provider message ID and a delivery callback | **NOT VERIFIED** | No authorized live SMS has ever been sent |

**Layer 3 is not layer 1.** A ledger line is a *record of intent* by the runner; it is not proof that the constraint, index, foreign key, or trigger physically exists in the production database. Confirming that requires the read-only catalog queries in §5.2.

### 4.3 Staging E2E assessment

> **`STAGING E2E ACCEPTANCE: NOT EVIDENCED`**

**Why, concretely:**

| Finding | Evidence |
|---|---|
| **There is no staging environment for the CST database.** | `docs/release/cst-ho-fe-schema-verification-guide.md:78` — *"Because Render free tier hosting does not include a dedicated mirror staging database…"*. The Render account holds one web service and one Postgres instance, both the only instances, on `free`. |
| Staging consent E2E was recorded as **not run** on 2026-10-12 and never closed. | `docs/eod-2026-10-12.md:142` — *"Staging consent E2E \| Not run \| No staging access or credentials available \| BLOCKED"*; `:177` — *"Staging E2E was not run, and no centralized deployment record was created."* |
| The staged work items were still **open** as of the 14 Oct review. | `docs/eod-2026-10-14.md:163` — **MIG-01**: *"Staging PostgreSQL database missing migrations 017 and 018"*. `docs/vju6-proposed-verification-record.md:79` — action *"Apply migrations 017 & 018 to staging"*, owner Backend Engineer / Ops Lead, due 2026-10-14 15:00 PKT. |
| The closure checklist still lists staging migration evidence as outstanding. | `docs/release/cst-closure-checklist.md:24,26` — *"Migrations applied on staging: 017…, 018…"* and *"Render/staging logs showing successful `node scripts/migrate.js` run"* — both unchecked. |
| No record anywhere identifies a staging environment, timestamp, harness, migration state, literal output, and consent/dispatch result. | Repository-wide search across `docs/` and `docs/release/`. |

**Consequence for the acceptance path:** because no staging environment exists, staging E2E **cannot** be produced without creating one. The alternative — and the one the code and docs already anticipate — is production schema verification under the `DW-1791829227726-96O8` decision: *"does verified production schema evidence satisfy the acceptance criteria?"* (§5.2 gives the exact queries, and `docs/release/cst-ho-fe-schema-verification-guide.md` §3 lays out the argument). **That decision belongs to Jason, and it is the gate on HOFE.**

### 4.4 Consent behaviour verified locally (38/38)

`npx vitest run tests/consent/` — 2 files, 38 passed, exit 0, 2026-10-20T12:25:08Z.

| Requirement | Verified by | Local result |
|---|---|---|
| Canonical **server-stamped** wording (client-supplied version ignored) | `tests/consent/consent_spine.test.ts` | PASS |
| **Tenant-consistent, append-only** consent audit | `tests/consent/consent_spine.test.ts` | PASS |
| **STOP / HELP / START** handling | `tests/consent/consent_spine.test.ts` | PASS |
| **Dispatch-time** consent re-validation (not only at enqueue) | `tests/consent/a2p_operational_acceptance.test.ts` | PASS |
| Suppression of queued messages after STOP | `tests/consent/a2p_operational_acceptance.test.ts` | PASS |
| Resubscription | `tests/consent/consent_spine.test.ts` | PASS |
| Duplicate prompt behaviour | `tests/consent/consent_spine.test.ts` | PASS |
| Audit persistence | `tests/consent/consent_spine.test.ts` | PASS |
| `consent_exempt` bypass fenced to platform-originated messages from a project-bound DID | `tests/consent/a2p_operational_acceptance.test.ts`; `engine/src/transport/twilio/outbound.ts:254-329` | PASS |

**Not covered by any local test:** a real carrier round trip. A2P registration and carrier delivery remain external.

---

## 5. VJU6 — Verification and dashboard evidence

### 5.1 The VJU6 identifier — not found, and not invented

**`VJU6` has no authoritative task ID in this repository.** This has been searched and recorded repeatedly, and the finding is unchanged:

| Record | Statement |
|---|---|
| `docs/vju6-proposed-verification-record.md:4` | *"A comprehensive search of the repository, Git history, and project documentation found no authoritative `VJU6` issue or loop identifier… Please provide the link or identifier for the authoritative tracker record."* |
| `docs/cst-v1-readiness-audit.md:312-316` | *"A comprehensive repository search was conducted across all files, Git logs, and documentation for the token `VJU6`… `VJU6` does not exist in this repository's codebase, specifications, or Git history. Its scope will not be fabricated."* |
| `docs/release/cst-production-readiness-audit.md:33,137` | *"External/unclear — no authoritative repo reference found… Tracker link/ID if it refers to external ticket."* |
| `docs/eod-2026-10-12.md:189-191` | *"VJU6 — Authoritative Record Required."* |

**The closest authoritative records for the verification/Dashboard scope** (from `docs/cst-pilot-checklist.md:34-36`) are:

| ID | Scope |
|---|---|
| **`LOOP-1790985133891-1TEN`** / **`LOOP-1790691898379-S6Q3`** | **Dashboard publisher** — `cst.turn` / `cst.delivery` correlation via `turn_id`, retry with backoff on 5xx, fail-fast on 4xx, `MISSING_CONFIGURATION` no-op, fire-and-forget, monotonic delivery guard, dry-run (`DRY_RUN=true` validates and logs locally, makes no HTTP request, persists nothing), and the `serializeForDashboard` flat-contract layer. |
| `LOOP-1790985133890-XKWD` | Conversation persistence honours the FK contract (`ConversationPersistenceError` instead of a swallowed failure). |
| `LOOP-1790985133892-4DSK` | vFarm timeout/retry budget, `VfarmApiError` categorisation. |
| `LOOP-1791243473842-LMCL` / `LOOP-1791243473841-02JU` | Real carrier E2E for SMS/voice (live Twilio number, real handset, carrier delivery). |
| `LOOP-1791243473843-S777` | Commercial pilot. |
| `LOOP-1791991972916-G718` | Clone-Quality Gate Step 2 (blocked on KMG9). |

**Action:** Jason to supply the authoritative `VJU6` identifier. The scope is reconstructed above from the closest real records; the identifier is **not** invented.

### 5.2 Verification-surface inventory

| Evidence capability | Exists? | Verified environment | Actual evidence available | Gap / owner |
|---|---|---|---|---|
| **Service health** | Yes — `GET /health` and `GET /api/health` | **Production, live** | 200 `{"status":"ok","service":"bha-cst-engine"}` (2026-10-20T11:56Z). `GET /api/health` additionally reports vFarm adapter health. | Proves the process is up — **not** which commit, not ingestion, not delivery. |
| **Deployed-SHA evidence** | Yes — Render deploy list | **Production, live** | `b06c68f` = HEAD, deploy `dep-dbb7gl9srm7s73dc8phg` | None. Adopted as the authoritative source. |
| **Migration evidence** | Yes — startup log + `schema_migrations` | **Production, ledger only** | `0 applied, 20 already recorded` | Object-level proof still missing → §5.2 queries, owner Jason/Platform |
| **Local automated tests** | Yes | **Local** | 628 passed / 6 skipped / 0 failed (2026-10-20T12:25:31Z) | None. |
| **Security regression** | Yes | **Local** | 26/26 + 10/10 | None. |
| **Consent regression** | Yes | **Local** | 38/38 | None. |
| **Voice regression** | Yes | **Local** | 94/94 | None. |
| **KMG9 regression** | Yes | **Local** | 9/9 | None. |
| **Dashboard publisher — dry-run** | Yes | **Local** | `DRY_RUN=true` validates and logs, makes no HTTP request, persists nothing — 24/24 across `dashboard_e2e` + `dashboard_dry_run` | None locally. Dry-run is **not** ingestion proof. |
| **Dashboard publisher — live ingestion** | Yes | **NOT VERIFIED in production** | `docs/cst-pilot-checklist.md:35` claims *"Verified live against `https://dashboard.bhanetwork.org` — HTTP 200 with row insertion confirmed"*, but **no run record identifies the date, harness, or literal output**, so it is not reproducible evidence. The 6 real-proof tests have **never been run** in this environment. | **Dashboard owner + Jason** — approve a Dashboard test environment, or supply the missing run record. |
| **Staging integration proof** | **No** | — | **`STAGING E2E ACCEPTANCE: NOT EVIDENCED`** (§4.3) — no staging environment exists | Jason/Platform — create one, or accept production evidence under `DW-96O8` |
| **Live production SMS delivery** | Implemented | **NOT VERIFIED** | No authorized live SMS has been sent. No provider message ID, no delivery callback. | **Jason** — approved recipient + window + explicit dispatch authorization |
| **Live production voice delivery** | Implemented | **NOT VERIFIED** | No call has ever connected. The last attempt was refused at call creation with Twilio `21210` (unverified From number). The `12300` content-type fix is live, but no production voice traffic has been observed. | **Jason** — verified Twilio number + reachable handset + authorization |
| **Correlation / trace IDs** | Yes | **Local + production code** | `correlation_id` on the envelope, `turn_id` on `messages_out` and on `cst.turn`/`cst.delivery`, `provider_sid` joining `messages_out`, `voice_deliveries`, and `messages.delivery_status` | None for the mechanism. The gap is *populated* values, which need the live channels. |
| **Audit ledger** | Yes | **Local + production code** | `SECURITY_LEDGER` entries (route, outcome, reason, correlation id) on every refusal; `sms_consent_audit` append-only, tenant-consistent | None for the mechanism. |
| **Operator console** | Yes | **Local** | `web/phone-test-console.html` — a browser console for admin login, tenants, projects, speakers, number bind/unbind, bindings, and health. Exercises `/api/v1/admin/*` and `/api/v1/auth/login`. | Live use requires a CST admin session, which this environment does not hold. |
| **`/debug/state` snapshot** | Yes — **correctly disabled in production** | Production (verified) | Returns **404** in production (`process.env.NODE_ENV === 'production'` guard, `engine/src/app.ts:269-273`). | None. Verified live 2026-10-20T12:05Z. |
| **Reproducible evidence another operator can collect** | **Partial** | — | Read-only Render CLI (deploys, Postgres metadata, logs) and the public health endpoint are reproducible today. The `messages_out` queue, the schema objects, and the Dashboard ingestion are **not** — all three need access grants. | Jason/Platform + Dashboard owner |

### 5.3 The six `dashboard_real_proof.test.ts` tests — recorded status

**Not run. Not enabled. `REAL_DASHBOARD_PROOF` was not set in this session.**

| Fact | Value | Verified |
|---|---|---|
| Gate | `describe.skipIf(!process.env.REAL_DASHBOARD_PROOF)` — `tests/integration/dashboard_real_proof.test.ts:83` | code |
| Recorded result this session | `1 passed \| 6 skipped (7)`, exit 0 — the 6 are skipped by the gate, **not** counted as passing | `npx vitest run tests/integration/dashboard_real_proof.test.ts`, 2026-10-20T12:25:23Z |
| What the 6 would prove | (1) dry-run makes no remote request; (2) the live Dashboard accepts `cst.turn`; (3) it accepts `cst.delivery` correlated to the same `turn_id`; (4) auth is sent as both `x-dashboard-key` and `Authorization: Bearer`; (5) the `cst.turn` contract fields are present in the HTTP body; (6) the delivery event carries the correlation | test file |
| Required to run | `REAL_DASHBOARD_PROOF=1` plus a live `ENGINE_DASHBOARD_URL` and `ENGINE_DASHBOARD_KEY` | test file header |
| **Status** | **NEVER RUN — no production Dashboard ingestion evidence exists** | repository-wide search |

### 5.4 Minimum evidence contract for a usable production verification surface

A reviewer must be able to reconstruct any claim from a single artifact. The minimum contract:

| Field | Requirement | Exists today |
|---|---|---|
| **Deployed SHA** | The exact commit the evidence was produced on, from `render deploys list` | Yes — `b06c68f` |
| **Environment** | Named explicitly (production / staging / local), with the hostname | Yes |
| **Timestamp** | UTC, ISO-8601, of the run | Yes |
| **Test scope** | Which suites, how many files/tests, and what was *not* covered | Yes |
| **Result** | passed / failed / skipped, with failures preserved verbatim | Yes |
| **Correlation / trace IDs** | `correlation_id`, `turn_id`, `provider_sid`, Call SID — enough to join the customer turn to the provider event | Mechanism exists; **values are unpopulated** pending live channels |
| **Sanitized provider / ingestion evidence** | The provider message ID and the Dashboard acceptance response, with phone numbers and identifiers masked | **Missing** — pending D2/D3/D12 |
| **Access and reproduction instructions** | The exact commands another operator runs | Partially — §5.2 queries and §5.2 log commands exist |

**The gap is not the mechanism; it is the populated values.** The contracts, the correlation IDs, the audit ledger, and the publisher all exist and are locally verified. What is missing is one real SMS, one real call, one real Dashboard ingestion, and read access to the production queue — after which the contract above is satisfiable today.

### 5.5 The precise external action needed

| # | Action | Owner | Evidence to return | Unblocks |
|---|---|---|---|---|
| 1 | Supply the authoritative `VJU6` tracker identifier | **Jason** | The loop/issue ID and link | Correct tracker linkage for the verification loop |
| 2 | Approve a Dashboard test environment and authorize `REAL_DASHBOARD_PROOF=1` — **or** supply the missing run record for the claim at `docs/cst-pilot-checklist.md:35` (date, harness, literal HTTP response) | **Jason** + **Dashboard owner** | The 6 proof results, or the original run record | `1TEN`/`S6Q3`; verification plane part 4 |
| 3 | Provide read access to the production DB, or run the §5.2 catalog queries and the `messages_out` queries | **Jason / Platform** | Query output | HOFE object-level proof; the SMS delay diagnosis; the voice-pointer confirmation |
| 4 | Name a verified Twilio From number, a reachable handset, and authorize one call | **Jason** | Call SID, greeting, speech, response, tenant/project, transcript, sanitized logs | `02JU`/`LMCL`; voice acceptance |
| 5 | Name an approved SMS recipient and window, and authorize one dispatch | **Jason** | Provider message ID + delivery callback | `NI8F`; A2P carrier evidence |

---

## 6. Test evidence

### 6.1 Last passing run before this session

| Field | Value |
|---|---|
| Timestamp (UTC) | **2026-10-20T12:02Z** |
| Command | `npm test` |
| Result | **618 passed \| 6 skipped (624), 0 failed**, 61 test files, duration 13.1 s |
| Exit code | 0 |
| Focused suites in that run | security proxy 26/26 · consent 38/38 · voice 94/94 · KMG9 9/9 |
| Other checks that session | `npm run typecheck` exit 0 · `npm run build` exit 0 · `git diff --check` exit 0 |
| Note | This run preceded the programmatic-voice-API guard in §2.5. It is superseded by §6.2. |

### 6.2 This session's runs (2026-10-20T12:25Z)

| UTC start | Command | Scope | Exit | Duration | Result |
|---|---|---|---|---|---|
| 12:25:06Z | `npx vitest run tests/security/vfarm_proxy_unauth.test.ts` | 1 file | 0 | 2 s | **26 passed (26)** |
| 12:25:08Z | `npx vitest run tests/security/programmatic_voice_auth.test.ts` | 1 file (new) | 0 | <1 s | **10 passed (10)** |
| 12:25:08Z | `npx vitest run tests/consent/` | 2 files | 0 | 2 s | **38 passed (38)** |
| 12:25:10Z | `npx vitest run tests/voice/` | 6 files | 0 | 2 s | **94 passed (94)** |
| 12:25:12Z | `npx vitest run tests/regression/kmg9_farm_isolation.test.ts` | 1 file | 0 | 1 s | **9 passed (9)** |
| 12:25:13Z | `npx vitest run tests/integration/dashboard_e2e.test.ts tests/integration/dashboard_dry_run.test.ts` | 2 files | 0 | 10 s | **24 passed (24)** |
| 12:25:23Z | `npx vitest run tests/integration/dashboard_real_proof.test.ts` | 1 file | 0 | 1 s | **1 passed \| 6 skipped (7)** — the 6 gated by `REAL_DASHBOARD_PROOF`, not run |
| **12:25:31Z** | **`npm test`** | **62 files** | **0** | **10 s** | **628 passed \| 6 skipped (634), 0 failed** — duration 10.39 s |
| 12:25:41Z | `npm run typecheck` | — | 0 | 2 s | 0 errors |
| 12:25:43Z | `npm run build` | — | 0 | 2 s | clean; `copy_web_assets: copied 8 entries to dist/web` |
| 12:25:45Z | `git diff --check` | — | 0 | <1 s | clean |

**Delta vs the previous run:** 618 → 628 passed, 61 → 62 files, +10 tests, +1 file. The increase is exactly the new `tests/security/programmatic_voice_auth.test.ts`. No test was disabled, skipped, or reclassified to inflate the count.

### 6.3 Tests executed in this session, and tests not run

| Executed | Not run — and why |
|---|---|
| security proxy 26/26 · programmatic voice auth 10/10 · consent 38/38 · voice 94/94 · KMG9 9/9 · dashboard e2e + dry-run 24/24 · full suite 628/634 · typecheck · build · diff-check | The 6 `dashboard_real_proof` tests — gated behind `REAL_DASHBOARD_PROOF=1`; explicit approval and an approved environment were not given, and the instruction was to run neither. |
| | Any staging run — **no staging environment exists** (§4.3). |
| | Direct production SQL — the DB IP allowlist is empty; **no bypass attempted**. |
| | `render ssh` into the container — no authorised key; not requested, and adding one would be a production config change. |
| | Any live carrier test — no verified Twilio number, no approved recipient, no explicit authorization. |
| | A signed webhook probe against production — it would trigger a real ElevenLabs synthesis and write production rows, which exceeds read-only inspection. The operator procedure is documented instead. |

### 6.4 Failures encountered and preserved

Two failures occurred mid-session while the §2.5 guard was being wired, and both are recorded here rather than hidden:

1. `tests/voice/voice_interface.test.ts` failed to collect — *"Transform failed … Expected ")" but found "')'"*. Cause: an edit script double-wrapped `.post('/api/v1/voice/turn')` into `.post('.post('/api/v1/voice/turn')')`. **Repaired**; the file now collects and passes.
2. Eight call sites failed with `401` instead of `200`/`403` — the Twilio-hosted status route now requires a signature. Cause: the route previously had **no** middleware at all. **Resolved** by presenting a signature in the affected tests and by adding `verifyTwilioSignature` to the Twilio-hosted status variants.

Neither failure was suppressed, and no test configuration was changed to make the suite pass.

---

## 7. Blocked checks and their owners

| # | Blocked check | Owner | Exact evidence required | Next action |
|---|---|---|---|---|
| 1 | vFarm API Gateway log review (Query 3) | vFarm / BHARAG gateway log owner | The 4 artifacts in §2.6 | Ahad sends the request; the gateway owner returns the logs |
| 2 | Confirmation that no non-Render CST deployment existed 2026-09-25 → 2026-10-07 | Jason / Destiny | One line | Ahad asks in the Slack draft |
| 3 | Production schema-object verification (HOFE) | Jason / Platform | §5.2 catalog query output | Ahad requests DB access or an operator run |
| 4 | `DW-1791829227726-96O8` — production-only vs staging acceptance | Jason | Written decision | Ahad requests |
| 5 | Live SMS round trip (NI8F) + the ~40-minute delay diagnosis | Jason | Approved recipient + window + dispatch authorization; `messages_out` read access | Ahad requests |
| 6 | Live voice call (02JU / LMCL) | Jason | Verified Twilio number + handset + authorization | Ahad requests; check the voice pointer first |
| 7 | Live Dashboard ingestion proof | Jason + Dashboard owner | An approved test environment, or the missing run record for the `cst-pilot-checklist.md:35` claim | Ahad requests |
| 8 | Authoritative `VJU6` identifier | Jason | The tracker ID and link | Ahad requests |
| 9 | Credential-rotation decision | Jason + Destiny | A decision recorded with reasoning, after item 1 | Ahad requests |
| 10 | DB plan upgrade before 2026-11-14T18:10:20Z | Jason | Written approval + a named window | Ahad submits the plan |
| 11 | DNS/TLS for the two CST hostnames | Jason / Platform | Render dashboard custom domain + a GoDaddy CNAME → `bha-cst-7u9e.onrender.com` | Ahad requests |
| 12 | `CST_API_KEY` provisioning before the §2.5 guard is deployed | Jason / Platform | The secret set in Render | **Before** any deploy containing the guard |

---

## 8. Acceptance criteria for each remaining item

| Item | Acceptance criteria |
|---|---|
| **5R0J** | (1) Gateway log reviewed over 2026-09-25 → present, with the CST client's reads enumerated; (2) no unexplained read of a farm id by the CST client; (3) rotation history stated; (4) confirmation that no other CST deployment existed; (5) Destiny's accept/reject logged with reasoning, including the decision on lineage evidence vs Log Explorer, and on rotation. |
| **HOFE** | (1) The §5.2 catalog queries return the expected tables, constraints, indexes and the append-only trigger; (2) `projects.elevenlabs_voice_id` for `proj-vfarm-main` confirmed; (3) `DW-96O8` decided, and the HOFE acceptance path fixed by that decision; (4) the HOFE guide's output pasted into `docs/release/cst-ho-fe-verification.md`. |
| **NI8F** | (1) One authorized carrier round trip with the provider message ID; (2) the delivery-status callback row; (3) the `messages_out` row showing dispatch-time consent enforcement; (4) the audit row proving server-stamped wording; (5) STOP demonstrated to suppress a queued message on the live path. |
| **VJU6** | (1) The authoritative ID supplied; (2) the six real-proof tests run in an approved environment with the three validated events, **or** the original run record for the live-ingestion claim; (3) the evidence contract in §5.4 populated with real correlation IDs and sanitized provider evidence. |
| **Voice** | Call SID · greeting spoken · caller speech captured · response spoken · no unexpected disconnect · correct tenant/project · transcript persisted · sanitized logs. A 200 or a simulated webhook does not count. |
| **Voice pointer (pre-call check)** | `projects.elevenlabs_voice_id` for `proj-vfarm-main` confirmed non-empty and equal to the real clone pointer `Hmy97GCI840wuICQesiM` — **not** the placeholder `eleven_voice_jason_vfarm`. **Analytically closed 2026-10-20:** the placeholder is unreachable in production (the registry backfill is guarded by `NODE_ENV !== 'production'`, and the migration 019 `UPDATE` runs before the app starts, so the row cannot be empty when the backfill would fire). It still needs the one-line confirmation from §5.2 query 5. |

---

## 9. Corrections to previously published records (dated)

| Date (UTC) | Correction | Basis |
|---|---|---|
| 2026-10-20T11:55Z | **Deployed SHA is `b06c68f`, not `3e88058`.** All four 19 Oct commits are live; migration 019 is applied. The earlier "deploy 4 commits" action was based on a stale 2026-10-19T13:53Z observation that was never re-verified, although the Render CLI was available and authenticated. | `render deploys list`; `render logs` |
| 2026-10-20T12:05Z | **The 5R0J audit's middleware names were wrong.** It documented `requireVfarmProxyAuth` and `requireAdminAuth`; neither exists in the code. The real gates are `requireVfarmAdminSession` and `requireVfarmAdminSessionOrJwt`. | `engine/src/app.ts`, `engine/src/middleware/vfarm_proxy_auth.ts` |
| 2026-10-20T12:05Z | **The 5R0J audit's §5 "rotation recommended" was reframed.** Rotation is a policy decision for Jason and Destiny *after* the gateway log review, not an automatic remediation step, because the production exposure window is bounded by deployment lineage. | §2.3, §2.4 |
| 2026-10-20T12:20Z | **New P0: the programmatic voice API had no authentication.** §2.5. A fail-closed guard is implemented locally with 10 focused tests; it is **uncommitted and not deployed**. | Live probe 2026-10-20T12:05Z; `tests/voice/voice_interface.test.ts:551` |
| 2026-10-20T12:23Z | **The Twilio-hosted voice status routes had no signature verification**, unlike their sibling inbound routes. Now signed. `docs/eod-2026-10-14.md:146` recorded an unsigned POST returning 200, confirming they were publicly writable. | `engine/src/interfaces/voice/index.ts`; the 14 Oct EOD record |
| 2026-10-20T12:25Z | **The 5R0J historical-exposure item is narrowed** from "pending log review" to "one external log system (the vFarm API Gateway) plus one confirmation line". The Render log window is not reachable further back from this environment. | `render logs --limit 500`; §2.6 |

---

## 10. Supporting repository evidence

| Evidence | Path |
|---|---|
| Authoritative task/evidence ledger | `docs/task.md` (mirror: `docs/release/task.md`) |
| Master audit | `docs/release/CST_MASTER_TASK_AUDIT.md` |
| 5R0J security audit, residual risk, sign-off criteria | `docs/release/cst-5r0j-security-audit-and-residual-risk.md` |
| Approval drafts (8, unsent) + operator queries | `docs/release/cst-approval-requests.md` |
| Slack reply draft (unsent) | `docs/release/cst-readiness-slack-reply.md` |
| HOFE schema verification guide + `DW-96O8` argument | `docs/release/cst-ho-fe-schema-verification-guide.md` |
| Consent verification record | `docs/release/cst-sms-consent-verification-record.md` |
| KMG9 verification record | `docs/kmg9-verification-record.md` |
| VJU6 proposed record (awaiting the authoritative ID) | `docs/vju6-proposed-verification-record.md` |
| Pilot checklist — authoritative loop-ID mapping | `docs/cst-pilot-checklist.md` |
| Staging-E2E "not run" records | `docs/eod-2026-10-12.md:142,177` · `docs/eod-2026-10-14.md:163` · `docs/release/cst-closure-checklist.md:24,26` |
| Security middleware | `engine/src/middleware/vfarm_proxy_auth.ts` |
| **Programmatic API guard (new)** | `engine/src/middleware/programmatic_api_key.ts` |
| **Programmatic voice API regression (new)** | `tests/security/programmatic_voice_auth.test.ts` |
| Route registration and middleware | `engine/src/app.ts` |
| Consent implementation | `engine/src/consent/service.ts` · `engine/src/consent/wording.ts` |
| Dispatch-time consent enforcement | `engine/src/transport/twilio/outbound.ts` |
| Consent migrations | `db/migrations/016_sms_consent_spine.sql` · `017_sms_consent_audit_fk.sql` · `018_sms_consent_prompts.sql` |
| Migration effect checks | `scripts/migration_checks.js` |
| Dashboard publisher + delivery guard | `engine/src/publishers/dashboard.ts` · `engine/src/publishers/delivery.ts` |
| Gated live-Dashboard proof tests | `tests/integration/dashboard_real_proof.test.ts` |
| Operator console | `web/phone-test-console.html` |
| Deployment config | `render.yaml` |
| Voice live-call runner | `scripts/e2e/voice_live_e2e.ts` |

---

## 11. §5.2 read-only verification queries (for an authorized operator)

All `SELECT` only, no writes, no credentials. Run against `bha_cst_1sh0`.

```sql
-- 5.2.1 Consent spine tables and columns.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('sms_consents', 'sms_consent_audit', 'sms_consent_prompts')
ORDER BY table_name, ordinal_position;

-- 5.2.2 Constraints: expect fk_sms_consent_audit_consent and unq_sms_consents_id_tenant.
SELECT conname, contype, conrelid::regclass::text AS relation
FROM pg_constraint
WHERE conname IN ('fk_sms_consent_audit_consent', 'unq_sms_consents_id_tenant')
ORDER BY conname;

-- 5.2.3 Indexes: expect unq_sms_consent_prompts_active and idx_sms_consent_prompts_active_lookup.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('unq_sms_consent_prompts_active', 'idx_sms_consent_prompts_active_lookup')
ORDER BY indexname;

-- 5.2.4 The append-only trigger on sms_consent_audit.
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgname = 'trg_sms_consent_audit_append_only' AND NOT tgisinternal;

-- 5.2.5 *** PRE-CALL VOICE POINTER CHECK ***
--      If this returns 'eleven_voice_jason_vfarm' or NULL, the first real voice
--      call will fail at synthesis with SYNTHESIS_FAILED.
SELECT project_id, elevenlabs_voice_id, elevenlabs_model_id, voice_enabled
FROM projects
WHERE project_id = 'proj-vfarm-main';
```

**The `messages_out` queue queries for the ~40-minute SMS delay** are in `docs/release/cst-approval-requests.md` §A.1. They are read-only, mask phone numbers, and separate "CST sent late" from "Twilio accepted late" from "carrier delivered late".

---

*Prepared 2026-10-20 by Ahad (`U0AC6RFNP3P`). Uncommitted. No production changes were made. No secrets, raw authentication headers, customer PII, or unmasked phone numbers are included.*
