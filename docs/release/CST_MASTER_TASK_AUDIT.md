# CST Master Task Audit — Customer Support Twin

**Repository:** `bhanetworkgh/bha-cst` (local path: `customer twin`)
**Assignee of record:** Ahad (`U0AC6RFNP3P`)
**Audit date:** 2026-10-20 (11:00–11:20 UTC)
**Production:** `https://bha-cst-7u9e.onrender.com`
**Launch target:** 31 October 2026
**Report status:** uncommitted working-tree file. No commit, push, deploy, config change, credential rotation, migration, or real call/SMS was performed.

> **Slack/dashboard access limitation.** This environment has no native Slack or Open-Loops dashboard integration (the Open Loops dashboard at `dashboard.bhanetwork.org/open-loops` requires authentication and was not reachable). Loop/watch state below is reconciled from the repository, `docs/task.md`, `docs/release/*` records, and the coordination context supplied in-thread. **Every Slack-derived state is marked `NEEDS OWNER CONFIRMATION`** and must be confirmed against the live Slack thread before it is treated as authoritative. Where Slack would have been authoritative and is unavailable, this is stated rather than guessed.

> ## ⚠ CORRECTION NOTICE — 2026-10-20T12:05Z
>
> **The central deployment claim in the first revision of this report was wrong, and has been corrected below.** The first revision stated that production was running `3e88058` and that **4 commits were undeployed**, naming the Twilio `12300` fix as the top action. That was **not verified against an authoritative source** at the time — it was carried forward from `docs/task.md`, which was itself a stale observation from 2026-10-19T13:53Z.
>
> **Verified truth (Render API, `render deploys list srv-db8hepqvcj2c73adpus0`):** the **Live** deploy is `b06c68fc5950e56ba140df892929d32c1a78e07a` (deploy `dep-dbb7gl9srm7s73dc8phg`, created 2026-10-19T20:06:45Z, finished 20:07:43Z) — **identical to the repository HEAD**. All four commits are deployed. Migration 019 is applied in production (`0 applied, 20 already recorded`).
>
> **The "deploy 4 commits" action is therefore not required and was not requested.** The Twilio `12300` fix (`ac387be`) **is live**. What remains is the *real-call acceptance* that was never performed.
>
> The `render` CLI was available and authenticated in this environment at the time of the first revision; it simply was not used. The lesson is recorded in `docs/task.md` §E and in the Operator Playbook §3.2: **`render deploys list` is the only authority for the deployed SHA.**
>
> Sections §1, §7, §9.1, §10 and §11 of this report have been updated. Historical values are preserved rather than deleted.

---

## 1. Executive summary

The CST codebase is in materially better shape than the tracked task documents indicate. The local suite is **618 passed / 6 skipped / 0 failed**, typecheck and build are clean, and the four previously-unauthenticated vFarm proxy routes are correctly gated with fail-closed middleware — **now re-verified live on 2026-10-20**.

**Most urgent action: perform the one real voice call.** The 2026-10-20 evidence refresh established that **all code is already deployed** (live deploy = repo HEAD `b06c68f`, migration 019 applied) and that the Twilio `12300` content-type fix is **live**. What has never happened is a **real call**: the previous attempt was refused at call creation with Twilio `21210` (unverified `From` number), so there is no Call SID, no transcript, and no two-way speech proof. Everything else on the voice lane is code-complete and locally verified (94/94) — the gap is hardware, credentials, and authorization, not engineering.

**Second-most urgent: the 5R0J historical exposure review is now a bounded question, not an open one.** The authentication gate was committed 2026-10-07, **8 days before the production Render service was created** (2026-10-15T18:11:51Z), and is an ancestor of that service's very first successful deploy. **No production deploy of CST ever ran the unauthenticated code.** The remaining open item is narrowed to the **vFarm API Gateway** access log (Query 3) — the one source that can show whether CST's farm key was ever used to serve tenant data to an unauthorized caller — plus a one-line confirmation from Jason/Destiny that no non-Render CST deployment existed in 2026-09-25 → 2026-10-07.

**Third: credential rotation is now a policy decision, not an automatic remediation step.** It should follow Query 3, not precede it.

**Two second-order findings** (both recorded, neither auto-fixed beyond a narrow dead-code removal):

1. `engine/src/core/registry.ts:185-194` (commit `b06c68f`, **now live**) falls back to the literal string `'eleven_voice_jason_vfarm'` when `VFARM_ELEVENLABS_VOICE_ID` / `ELEVENLABS_VOICE_ID` are unset and the project row has no `elevenlabs_voice_id`. That is **not a valid ElevenLabs voice ID** (the real one is `Hmy97GCI840wuICQesiM`, set by migration 019, which is applied in production). The `NO_VOICE_POINTER` refusal path in `engine/src/interfaces/voice/index.ts:452-489` is designed to refuse generic voice substitution; this backfill would instead *supply* a generic placeholder, causing `SYNTHESIS_FAILED` at the ElevenLabs boundary. **Only reachable if the project row's `elevenlabs_voice_id` is empty** — which migration 019 should have prevented for `proj-vfarm-main`, but the row value itself is not independently verifiable from outside the DB. Fix requires a decision: set the env var in Render, or remove the hardcoded fallback. **This is now the single most likely cause of a failed first real call** and should be checked before placing it.

2. `engine/src/core/engine.ts:841` — `detectOutOfScopeFarmMention()` hardcodes `CoreRegistry.getProjectsForTenant('tenant-vfarm-01')`. This is a tenant-scoped authorization helper with a hardcoded tenant id. Pre-existing, not introduced by this audit, and functionally safe today (single-tenant deployment), but it will silently under-detect out-of-scope farms if a second tenant is onboarded. Recorded as an architecture gap, not fixed.

**Everything else in the "blocked" column is blocked on a human, an authorization, or an external system — not on engineering work.** The engineering surface is essentially complete. The remaining path to 31 October is *acceptance and access*, not code.

---

## 2. Task register

| ID | Title | Owner | Status | Priority | Deadline | Latest evidence | Blocker / dependency | Next action |
|---|---|---|---|---|---|---|---|---|
| `LOOP-1790790007707-5R0J` | Unauthenticated vFarm proxy exposure | Ahad → Destiny | **IN PROGRESS** — local work complete, live 401s observed, acceptance pending | P0 | Open | `tests/security/vfarm_proxy_unauth.test.ts` 26/26 (2026-10-20); 4 routes gated at `engine/src/app.ts:102,122,172,208` | Historical Render log review (needs authorized operator); **Destiny's formal sign-off** | Ahad sends audit queries + requests sign-off |
| `DW-1791852954583-46HC` | CST security/consent/verification watch | Ahad | **OPEN** — 3/3 reminders sent, escalates to Jason + Destiny | P0 | Escalating | 3 reminders; Destiny direct nudge ts 1792472809 | Ahad's in-thread reply | **Ahad replies in-thread** (see §11) |
| `LOOP-1791467054702-NI8F` | SMS consent spine | Ahad | **IMPLEMENTED, NOT PRODUCTION-ACCEPTED** | P0 | Open | 38/38 consent tests (2026-10-20); migrations 016/017/018 in code | Live carrier SMS round trip needs approved recipient + window | Ahad requests recipient + window from Jason |
| `LOOP-1791826143428-HOFE` | DB migrations 017/018 + E2E | Ahad → DB operator | **BLOCKED** | P1 | Open | Startup log `0 applied, 19 already recorded` (2026-10-19T13:53:11Z) | Empty DB IP allowlist `[]` blocks direct psql | Authorized operator runs `cst-ho-fe-schema-verification-guide.md` SQL |
| `LOOP-1791852954583-46HC` | (dup ref) | — | **NEEDS OWNER CONFIRMATION** | P1 | — | — | Slack unavailable | Confirm on dashboard |
| `LOOP-1789824812431-IWKX` | CS Twin v1 release readiness | Ahad → Jason | **BLOCKED on 3 external gates** | P0 | 31 Oct 2026 | `cst-v1-release-readiness-assessment.md`; 7/10 criteria verified | OYP9 (infra), HOFE (DB), KMG9 (partner) | Deploy 4 commits, then re-assess |
| `LOOP-1788044070647-KMG9` | Farm-routing safety / BHARAG fallback | Ahad → Jegan | **IMPLEMENTED, NOT PRODUCTION-ACCEPTED** | P0 | Open | `docs/kmg9-verification-record.md`; 9/9 regression (2026-10-20) | **Jegan's BHARAG cluster-key scope proof** (`DW-53P7`); Jason's live smoke test (`DW-19QD`) | Ahad sends Jegan the 3 named negative/positive tests |
| `LOOP-1791243473841-02JU` | Live voice acceptance | Ahad → Jason | **BLOCKED** | P0 | Open | 94/94 voice tests (2026-10-20); Twilio error 12300 root-caused | Real call never placed — Twilio `21210` unverified From number; **needs verified `TWILIO_NUMBER` + live handset** | Ahad requests a verified Twilio number + handset |
| `LOOP-1792186847775-63MS` | Voice/Twilio config | Ahad | **IN PROGRESS** | P0 | Open | `ac387be` fixes error 12300; `b06c68f` adds migration 019 | **Not deployed** | Deploy 4 commits |
| `DW-1792186179087-EWQI` | Voice + KMG9 acceptance | Jason | **OPEN** | P0 | Open | — | Jason's action | Ahad supplies test instructions (exist) |
| `DW-1792187689082-B0M2` | Voice acceptance | Ahad/Jason | **OPEN** | P0 | Open | — | Real handset + authorization | Request authorization |
| `LOOP-1792452150303-J2F6` | Production SMS delivery + ~40-min delay | Ahad | **BLOCKED — no production DB access** | P1 | Open | Worker polls every 5s (`engine/src/server.ts:48`); retry backoff ≤4s — **neither explains 40 min** | Cannot read `messages_out` queue age, `next_retry_at`, `error_message`, or delivery callbacks | Authorized operator runs the §5.2 query; Ahad needs `messages_out` read access |
| `LOOP-1790439082267-OYP9` | DNS/TLS + infra | Jason / Platform | **BLOCKED** | P1 | Open | **`cst.bhanetwork.org` and `cst-admin.bhanetwork.org` do NOT resolve (verified 2026-10-20)** | Platform owner | Jason provisions CNAME + TLS |
| `LOOP-1792104121807-XXHH` | Postgres expiry 14 Nov 2026 | Jason / Platform | **PLAN COMPLETE, AWAITING APPROVAL** | P1 | **14 Nov 2026** | `cst-database-continuity-plan.md`; plan `free`, expires `2026-11-14T18:10:20.49769Z` | **Written approval for $7/mo Starter** | Ahad submits plan to Jason; 25 days remain |
| `LOOP-1791922936305-VU6R` | Client 2 Commissary working session | Ahad → Jason | **OPEN — 20 Oct deadline (today)** | P1 | **20 Oct 2026** | `cst-vu6r-prep.md`, `cst-vu6r-blocker.md` | Client 2 contact identity + session not confirmed | Ahad reports source-check; Jason identifies contact |
| `LOOP-1791848474090-Y5TW` | Operator Playbook SOP | Ahad → Destiny | **DRAFT COMPLETE, NOT PUBLISHED** | P1 | Open | `docs/release/operator-playbook-sop.md` (10 sections, 0 secrets — verified 2026-10-20) | Publication to Codex/SOPs + BHARAG `sop/bays-cst-operations`; Destiny's simulation drill | Ahad publishes + requests drill |
| `LOOP-1790032940977-DMVQ` | Test-suite integrity | Ahad | **RESOLVED** | P2 | — | Historical 57/57 → 26/185 is superseded; current **618/624** | None | None — reconcile in report §6 |
| `LOOP-1790985133889-8D7U` | Registry / person-to-unit / monitoring | Ahad | **IN PROGRESS** | P1 | Open | `4ad161e` vFarm Users & Grants console; `888e22e` registry fixes | Live acceptance | Ahad produces gap list (§9) |
| `LOOP-1789573914064-KZE7` | CS Twin v1 integration | Ahad | **IN PROGRESS** | P1 | Open | Dashboard publisher, Front Door, BHARAG connectors | Live acceptance | Ahad produces gap list (§9) |
| `DW-1791829227726-96O8` | Prod-only vs staging acceptance policy | Jason | **BLOCKED — decision required** | P1 | Open | Decision watch tracked | Owner decision | Jason decides |
| `DW-1792414988891-UJJ2` | VU6R reminder (Tue 20 Oct 14:03 Lagos) | Ahad | **OPEN — today** | P1 | 20 Oct 2026 | Preserved as context | Session status | See VU6R row |
| `DW-1791851358695-JU0D` | (CST watch) | Ahad | **NEEDS OWNER CONFIRMATION** | P0 | — | Not present in repo records | Slack unavailable | Confirm on dashboard |

### 2.1 Explicitly *not* Ahad's work (do not duplicate)

- **Jason Bays** — `DW-19QD` live vFarm smoke test; `DW-96O8` acceptance-policy decision; Render Starter upgrade + DNS/TLS (`OYP9`); Client 2 contact introduction; the three revenue gates `DW-1791980388023-1Z1J` (Destiny), `DW-1791898769276-E3Q5` (Hardik), `DW-1791990783434-UUC8` (Kavin).
- **Destiny Arupi** — 5R0J formal security acceptance; Y5TW publication + simulation drill; intake/Google-Form build spec.
- **Jegan** — BHARAG cluster-key scope proof (`DW-53P7`); the Onshape P1.0 revision named for `cad_revision`/`config_hash`.
- **Hardik** — U902 read-back/idempotency validation + controlled Stripe→Ledger E2E.
- **Kavin** — 2KG0 per-rack SKU wiring + end-to-end Stripe path.
- **Render platform owner** — DB plan upgrade, DB IP allowlist, custom domain.
- **BHARAG key owner** — upstream cluster-key policy/workspace/index scope proof.

**Jegan's watch `DW-1791852954882-0VUU` is self-closing** on the next dashboard pass (owner replied; one open ask is on Hardik, not Ahad). No action.

---

## 3. Completed and verified

| Item | Evidence | Verification date |
|---|---|---|
| Public vFarm proxy routes are not an unauthenticated privileged proxy | `tests/security/vfarm_proxy_unauth.test.ts` — **26/26**; middleware at `engine/src/middleware/vfarm_proxy_auth.ts:134,190`; mounting at `engine/src/app.ts:102,122,172,208` | 2026-10-20 |
| SMS consent spine (capture, audit, STOP/HELP/START, dispatch-time enforcement) | `tests/consent/consent_spine.test.ts` 28/28 + `tests/consent/a2p_operational_acceptance.test.ts` 10/10 = **38/38** | 2026-10-20 |
| KMG9 farm-routing fail-closed, no BHARAG fallback | `tests/regression/kmg9_farm_isolation.test.ts` — **9/9**; record at `docs/kmg9-verification-record.md` | 2026-10-20 |
| Voice interface, guest ingress, tenancy, failure paths, health signal | `tests/voice/` — **94/94** across 6 files | 2026-10-20 |
| Tenant isolation / project routing | `tests/tenancy/platform_tenancy.test.ts` 8/8; `tests/tenancy/project_org_id_mapping.test.ts` 6/6 | 2026-10-20 |
| Admin UI + vFarm Users & Grants | `tests/admin/vfarm_users_and_grants.test.ts` 4/4; `tests/admin/admin_api.test.ts` 14/14 | 2026-10-20 |
| Full local suite | **618 passed / 6 skipped / 0 failed (624)** | 2026-10-20 11:04 UTC |
| Typecheck | `tsc --noEmit -p engine/tsconfig.json` — exit 0 | 2026-10-20 |
| Build | `tsc -b engine/tsconfig.json && copy_web_assets` — clean, 8 web assets copied | 2026-10-20 |
| Production service health | `GET https://bha-cst-7u9e.onrender.com/health` → `{"status":"ok","service":"bha-cst-engine"}` (20.0s cold wake, then 200) | 2026-10-20 11:06 UTC |
| Twilio voice content-type defect root-caused and fixed in code | `ac387be`; evidence Call SID `CAf4643166002591fe639a9349d91d21d3`, Twilio error 12300 | 2026-10-19 21:55 PKT |
| Operator Playbook SOP drafted, zero secrets | `docs/release/operator-playbook-sop.md` — 10 sections, 4 blocker areas, escalation SLAs, access directory, simulation exercise | 2026-10-20 (re-read) |
| Migrations 016–019 present with schema-effect checks | `db/migrations/` (19 files + duplicate `003` prefix pair); `scripts/migration_checks.js` checks 016/017/018/019 | 2026-10-20 |

**Explicitly NOT verified (do not claim):** production DB schema objects, live carrier SMS delivery, real voice call completion, BHARAG upstream key scope, historical log exposure review, DNS/TLS for custom domains.

---

## 4. Implemented but not production-accepted

| Loop | Code | Local tests | Production/staging acceptance |
|---|---|---|---|
| 5R0J | Complete | 26/26 | **No** — 401s observed live 2026-10-19; historical exposure review + Destiny sign-off outstanding |
| NI8F | Complete | 38/38 | **No** — no live carrier round trip |
| KMG9 | Complete | 9/9 | **No** — BHARAG key scope unproven; live vFarm smoke test outstanding |
| Voice (02JU/63MS) | Complete, **and deployed** (live SHA = HEAD) | 94/94 | **No** — no call ever connected (Twilio `21210`), and no production voice traffic observed |
| HOFE | Complete | 38/38 | **No** — direct SQL blocked by allowlist `[]` |
| Y5TW | Complete | n/a | **No** — unpublished; no simulation drill |
| IWKX | 7/10 criteria | 618/624 | **No** — 3 external gates open |

---

## 5. Open and blocked items

### 5.1 Blocked on a named human

| # | Item | Owner | Requested action | ETA |
|---|---|---|---|---|
| 1 | `DW-1791852954583-46HC` reply | **Ahad** | Post in-thread reply (text in §11) | **Today** |
| 2 | 5R0J formal security sign-off | **Destiny** | Accept or reject the documented audit scope + residual risk | 1 business day |
| 3 | Render Starter upgrade ($7/mo) | **Jason** | Written approval; execute before **14 Nov 2026** | 25 days to deadline |
| 4 | DB IP allowlist / operator DB access | **Jason / Platform** | Add Ahad's IP or run the SQL guide on a bastion | 1 business day |
| 5 | BHARAG cluster-key scope (`DW-53P7`) | **Jegan** | 3 named tests (§5.3) | 2 business days |
| 6 | Live vFarm smoke test (`DW-19QD`) | **Jason** | Run `cst-kmg9-live-test-instructions.md` | 1 business day |
| 7 | Verified Twilio From number + live handset | **Jason / Twilio account owner** | Supply a verified `TWILIO_NUMBER` and a reachable handset | 2 business days |
| 8 | Live SMS test recipient + approved window | **Jason** | Name a recipient and a window | 1 business day |
| 9 | Custom domain DNS/TLS (`OYP9`) | **Jason / Platform** | CNAME + cert for `cst.*`, `cst-admin.*` | 3 business days |
| 10 | Client 2 contact identity (`VU6R`) | **Jason** | Introduce the contact; deadline is **today** | Today |
| 11 | `DW-96O8` acceptance policy | **Jason** | Decide prod-only vs staging acceptance | 1 business day |
| 12 | `Y5TW` publication + drill | **Ahad → Destiny** | Publish to Codex/SOPs + BHARAG, schedule drill | 2 business days |

### 5.2 The ~40-minute SMS delay (J2F6) — evidence-based narrowing

Local code inspection **eliminates** the two obvious infrastructure causes:

- `engine/src/server.ts:48` — the outbound worker polls every **5 s**. A 40-minute queue age is not a polling-interval problem.
- `engine/src/transport/twilio/outbound.ts:527` — in-process retry backoff is `2^attempt` **seconds** (max 2s/4s at 3 attempts). Not 40 minutes.

The remaining candidates all require production data CST cannot read: a `messages_out` row parked with a future `next_retry_at` (migration 014), a non-retriable Twilio error recorded on the row (e.g. `21215` geo-permission, which the code stores self-describing), Render free-tier hibernation between enqueue and dispatch, or carrier-side filtering after Twilio accepted the message.

**Required query — needs an authorized operator with `messages_out` read access:**

```sql
SELECT id, tenant_id, project_id, to_e164, status, retry_count,
       created_at, next_retry_at, provider_sid, error_message,
       EXTRACT(EPOCH FROM (COALESCE(next_retry_at, NOW()) - created_at))/60 AS minutes_waiting
FROM messages_out
WHERE created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 100;
```

Plus the delivery-callback history for the affected `provider_sid` values, to separate "CST sent late" from "Twilio accepted late" from "carrier delivered late".

**Do not upgrade infrastructure on the current evidence.** The 5 s poll and 2–4 s backoff mean capacity is not the indicated cause, and Rule 6 forbids upgrading before evidence points there.

### 5.3 BHARAG cluster-key scope — the exact evidence to collect (for Jegan)

Per `docs/kmg9-verification-record.md` §7, CST-side isolation cannot guarantee upstream enforcement. Three artifacts are required:

1. **Negative test** — the CST cluster key cannot retrieve a known farm-specific sensor/alert/vision record (expect denial or empty scope).
2. **Positive test** — permitted general-help content remains accessible (expect success).
3. **Policy proof** — upstream authorization/workspace/index scope for the CST key, showing enforcement rather than an optional request field.

### 5.4 Live voice acceptance — controlled real-call plan (requires explicit authorization)

Preconditions: a **verified** Twilio From number (the current one fails `21210`), a reachable handset, `CST_VOICE_TWIML_URL` or `CST_SERVICE_URL` set to the public HTTPS URL, and the voice pointer confirmed in production for the target project.

`scripts/e2e/voice_live_e2e.ts` is already wired to place exactly one outbound call with `--live` (non-live is preflight-only) and to write a masked JSON transcript to `var/transcripts/`.

The run must produce all of: call connection; **actual speech** in both directions; a generated response; correct tenant/project resolution; transcript persistence; provider Call SID; and server logs. A `200` from the webhook or a simulated Twilio request is **not** acceptance.

**Known risk to check first:** the registry voice-pointer backfill (finding #1, §1). If migration 019 has not applied in production and the env vars are unset, the call will reach ElevenLabs with an invalid voice ID and fail with `SYNTHESIS_FAILED`.

### 5.5 DB schema verification (HOFE) — operator SQL

`docs/release/cst-ho-fe-schema-verification-guide.md` holds the non-mutating checklist. The specific objects to confirm: `sms_consents` / `sms_consent_audit` / `sms_consent_prompts` tables; `fk_sms_consent_audit_consent`; `unq_sms_consents_id_tenant`; `unq_sms_consent_prompts_active`; `idx_sms_consent_prompts_active_unique`; the `trg_sms_consent_audit_append_only` trigger; and `projects.elevenlabs_voice_id` for `proj-vfarm-main`.

**A migration-ledger line is not proof of schema objects.** Direct psql is blocked: `Error: IP address (103.120.71.129) not in allow list for bha-cst-postgres`, allowlist `[]`.

---

## 6. Test results

**Environment:** local workspace, macOS (darwin), Node/TypeScript project `bha-cst@1.0.0`. **Run date:** 2026-10-20, 11:00–11:05 UTC.

| Command | Result |
|---|---|
| `npm test` | **Test Files 61 passed (61)** · **Tests 618 passed \| 6 skipped (624)** · **0 failed** · duration 10.27s · start 16:04:07 (local) |
| `npm run typecheck` | `tsc --noEmit -p engine/tsconfig.json` → exit 0, **0 errors** |
| `npm run build` | `tsc -b engine/tsconfig.json && node scripts/copy_web_assets.js` → **clean**; `copy_web_assets: copied 8 entries to dist/web` |
| `npx vitest run tests/voice/` | 6 files, **94 passed (94)** |
| `npx vitest run tests/security/vfarm_proxy_unauth.test.ts tests/consent/ tests/regression/kmg9_farm_isolation.test.ts` | 4 files, **73 passed (73)** |
| `git diff --check` | clean (no whitespace errors) |

**Skipped tests (6 of 624 — 0.97%; NOT counted as passing):** all 6 are in `tests/integration/dashboard_real_proof.test.ts`, gated behind `REAL_DASHBOARD_PROOF=1` and requiring real `ENGINE_DASHBOARD_URL` / `ENGINE_DASHBOARD_KEY`. They send exactly 3 events to the live Dashboard. **They have never been run** — no evidence of live Dashboard ingestion exists.

**Historical reconciliation (DMVQ):** the reported 57/57 → 26/185 regression is superseded and resolved. The sequence of record is 574/580 → 584/590 → 611+6 → **618/624 (current)**. No skipped, disabled, or flaky test was reclassified to inflate the count. The known voice flake under the full suite did **not** reproduce in this run.

---

## 7. Deployment / database status

| Item | Value | Verified |
|---|---|---|
| Repository | `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git` → `bhanetworkgh/bha_cst` | 2026-10-20 |
| Repository branch | `main` | 2026-10-20 |
| Repository HEAD | `b06c68fc5950e56ba140df892929d32c1a78e07a` | 2026-10-20 |
| Working tree | clean at audit start; **1 file modified by this audit** (`engine/src/transport/twilio/outbound.ts`, −23 lines) + 2 untracked docs | 2026-10-20 |
| **Deployed commit on Render** | **`b06c68fc5950e56ba140df892929d32c1a78e07a`** — deploy `dep-dbb7gl9srm7s73dc8phg`, service `srv-db8hepqvcj2c73adpus0`, created 2026-10-19T20:06:45Z, finished 20:07:43Z. **Identical to repository HEAD — zero deployment drift.** | 2026-10-20 11:55Z |
| Superseded value | `3e88058a987b4cad0c72dfc3c94c75c8a353e96d` (deploy `dep-db98vidg1s2s73bun8eg`) — was live 2026-10-16T20:57:45Z → 2026-10-19T20:06:45Z, when 4 further commits auto-deployed | 2026-10-20 |
| Auto-deploy behaviour | `autoDeploy: yes`, `autoDeployTrigger: commit`, branch `main`, repo `bhanetworkgh/bha_cst`. **A push to `main` is a production deployment.** | 2026-10-20 (Render API) |
| Service health | HTTP 200 `{"status":"ok","service":"bha-cst-engine"}`; ~15–22 s cold wake (free tier hibernation after 15 min idle) | 2026-10-20 11:56Z |
| Migration ledger (production) | `🎉 Migrations complete: 0 applied, 20 already recorded` — **019 is applied** | 2026-10-20 10:44:03Z, 11:04:47Z |
| Migrations in repo | 19 files (`003` prefix duplicated by design — apply in filename order; **do not rename**) | 2026-10-20 |
| DB resource | `dpg-db8he2qvcj2c73ado3s0-a` (`bha-cst-postgres`), plan `free`, PG 16, `createdAt 2026-10-15T18:10:20.49769Z`, `expiresAt 2026-11-14T18:10:20.49769Z` (exactly +90 days), `ipAllowList []` | 2026-10-20 (Render API) |
| Direct DB access | **BLOCKED** — Render CLI reports "IP allow-list: empty (external connections blocked)" | 2026-10-20 |
| `cst.bhanetwork.org` | **does not resolve** — no A, AAAA, or CNAME; TLS impossible ("Could not resolve host"). DNS is served by GoDaddy (`ns09/ns10.domaincontrol.com`) | 2026-10-20 12:00:58Z |
| `cst-admin.bhanetwork.org` | **does not resolve** — same | 2026-10-20 12:00:58Z |
| `bha-cst-7u9e.onrender.com` | resolves → `gcp-us-west1-1.origin.onrender.com` → Cloudflare CDN; TLS `CN=onrender.com`, issuer Google Trust Services, `SSL certificate verify ok`, HTTP/2, cert valid 2026-09-21 → 2026-12-20 | 2026-10-20 12:00:58Z |
| `bha-cst.onrender.com` (legacy slug) | **does not resolve** — confirms a single CST host | 2026-10-20 |
| vFarm adapter | `[vFarm] Initialized with Live Key. Target Farm: dynamic-discovery` — live upstream connectivity confirmed | 2026-10-20 10:44:08Z, 11:04:51Z |
| Render log retention (CLI) | CLI reaches back only to **2026-10-19T18:07:30Z**; 168 rows retrievable. The pre-2026-10-15 window is **not** CLI-reachable. | 2026-10-20 12:00Z |

**Deployment discrepancies: none.** Repository HEAD equals the production deploy. The only remaining discrepancy is in the *documentation*, which this refresh corrects (§1 correction notice, §7 above, and `docs/release/cst-5r0j-security-audit-and-residual-risk.md` §3.1).

**Migration 019 — reviewed, applied, idempotent, correctly scoped:**

```sql
UPDATE projects
SET elevenlabs_voice_id = COALESCE(NULLIF(elevenlabs_voice_id, ''), 'Hmy97GCI840wuICQesiM'),
    elevenlabs_model_id = COALESCE(NULLIF(elevenlabs_model_id, ''), 'eleven_turbo_v2_5'),
    voice_enabled       = TRUE,
    updated_at          = NOW()
WHERE project_id = 'proj-vfarm-main' AND (elevenlabs_voice_id IS NULL OR elevenlabs_voice_id = '');
```

Single-row, guarded, forward-only, no DDL, no customer data. `projects.elevenlabs_voice_id` is created in migration 010. `scripts/migration_checks.js` carries a matching effect check for 019, so a legacy database cannot silently adopt it. **Already applied in production — no deployment action remains.**

---

## 8. Security and consent evidence

### 8.1 Route-by-route status (4 previously-unauthenticated routes)

| Route(s) | Middleware | No credentials | With a vFarm JWT | With CST admin session |
|---|---|---|---|---|
| `/api/devices`, `/api/v1/devices` | `requireVfarmAdminSession` | **401** | **403** — fail-closed; CST's farm key is **not** substituted | 200 (CST acts on the admin's own behalf) |
| `/api/dashboard`, `/api/v1/dashboard` | `requireVfarmAdminSession` | **401** | **403** — same | 200 |
| `/api/farms`, `/api/v1/farms` | `requireVfarmAdminSessionOrJwt` | **401** | 200, **caller's own JWT only** | 200 (CST's own credential) |
| `/api/tokens`, `/api/v1/tokens` | `requireVfarmAdminSessionOrJwt` | **401** | 200, **caller's own JWT only** | 200 (CST's own credential) |

**On the "fallback to the vFarm admin JWT" question — the answer is now precise.** There is no credential substitution on any of the four routes:

- On farm-key-scoped routes (`/devices`, `/dashboard`), a caller-supplied JWT is **rejected with 403** rather than silently re-authenticating as CST. The upstream device/health reads authenticate with `X-Farm-Key`, so honouring a JWT would have meant acting with CST's key while implying the caller's authority.
- On JWT-scoped routes (`/farms`, `/tokens`), the caller's JWT is forwarded **verbatim** and is never replaced by a CST credential. A bogus JWT gains nothing — vFarm rejects it.
- The only path that uses CST's own credentials is a **valid CST admin session**, where the caller *is* an authenticated CST administrator acting on their own behalf — the same authority `/api/v1/admin/*` already has.

`engine/src/middleware/vfarm_proxy_auth.ts` has **no NODE_ENV/test bypass** — deliberately, so the regression suite cannot become vacuous.

### 8.2 Credential exposure and rotation status

- **No farm key, admin JWT, API key, or password is present in the repository.** The ElevenLabs identifier `Hmy97GCI840wuICQesiM` is a **voice-clone pointer**, not a secret — the architecture explicitly stores the pointer, not the clone, and it was already committed in migration 009 and referenced across the test suite.
- **Rotation status: NOT VERIFIED, and it is a real gap.** Rejecting unauthenticated requests *now* does not establish that no exposure occurred *before* the patch. The audit scope, log filters, and residual-risk statement are in `docs/release/cst-5r0j-security-audit-and-residual-risk.md`.
- **Do not rotate without authorization.** Rotation would itself be an event requiring disclosure to affected parties. The correct next step is the **historical log review by an authorized operator**, then Destiny's decision on whether rotation is warranted.
- The local suite provides **no evidence of exposure** and is not a substitute for it.

### 8.3 SMS consent — schema, capture, audit, STOP/HELP/INFO

- **Schema:** `sms_consents` (016) + `sms_consent_audit` (017, append-only trigger, FK, tenant-consistency unique index) + `sms_consent_prompts` (018, 24 h TTL, active-prompt unique index).
- **Capture:** the canonical wording snapshot and version are stamped **server-side**; a client-supplied `wording_version` is ignored, so evidence cannot be tampered with.
- **Audit:** every transition is written to `sms_consent_audit` with previous/new status, wording snapshot, source, actor, and correlation id.
- **STOP/HELP/INFO:** `STOP` → opt-out recorded even with no prior consent, and the recipient is then blocked from all non-carrier-required SMS. `START` → re-subscribe prompt (24 h TTL). `HELP` → canonical reply. Both re-subscribe and HELP responses are permitted to an opted-out recipient because carriers require them — the exemption is content-matched, not a blanket bypass.
- **Dispatch-time enforcement:** `engine/src/transport/twilio/outbound.ts:254-329` re-reads consent **at send time**, not merely at enqueue time, and refuses with an audited `SECURITY_LEDGER` entry naming the commercial impact.
- **The `consent_exempt` bypass is fenced.** It is refused unless the sending number is a service number bound to the **exact** tenant+project with `sms` capability. This is the fix from the 9 Oct 2026 outbound-consent incident: `validateConsentExempt` now runs **after** `resolveOutboundSendingNumber`, so a platform message queued without an explicit `from_e164` is still authorized — but a customer-originated sender can never set the flag for itself. The bypass is reserved for platform-originated messages only.

### 8.4 Production verification / evidence surface

| Records | Missing |
|---|---|
| `SECURITY_LEDGER` audit entries (route, outcome, reason, correlation id) | No historical pre-patch log review |
| `sms_consent_audit` (append-only, tenant-consistent) | No live consent audit query result |
| `voice_deliveries` ledger (status, voice_id, bytes, error code) | No real delivery row (no call ever connected) |
| `messages_out` (status, provider_sid, retry_count, next_retry_at, error_message) | No production query result — allowlist blocks it |
| `cst.turn` / `cst.delivery` dashboard events (fire-and-forget, monotonic guard) | No live Dashboard ingestion proof — the 6 proof tests have never run |
| Render startup migration log | No independent schema-object proof |

**How a reviewer reproduces the checks:** `npm test` (618/624), `npm run typecheck`, `npm run build` reproduce the local layer. The production layer requires the SQL guide (HOFE), the Render log filters (5R0J), a real call (voice), a real handset (SMS), and `REAL_DASHBOARD_PROOF=1` with live Dashboard credentials (dashboard).

---

## 9. Voice / SMS acceptance

### 9.1 Voice

| Requirement | Status | Evidence |
|---|---|---|
| Production webhook URL | Configured as `https://bha-cst-7u9e.onrender.com`; `getVoiceTurnActionUrl()` prefers `PUBLIC_WEBHOOK_URL`/`CST_SERVICE_URL`, then `x-forwarded-proto`/`x-forwarded-host`, then host header | `engine/src/interfaces/voice/index.ts:69-92` |
| Twilio signature verification | **Enforced** on inbound-call and speech-turn routes; invalid signature rejected before DB access | `engine/src/interfaces/voice/index.ts:1212,1223` |
| Voice-number binding | Bound via `service_number_binding` → tenant + project; unbound receiving number → 404 | `engine/src/interfaces/voice/index.ts:706-738` |
| Tenant/project routing | Resolved from the receiving DID, never from client payload; client-supplied `tenant_id`/`project_id` → 403 `TENANT_SCOPE_VIOLATION` | `engine/src/interfaces/voice/index.ts:758-775`, `1104-1124` |
| HTTPS action URLs | Yes — `https://` derived from forwarded proto | `engine/src/interfaces/voice/index.ts:76-89` |
| Voice pointer / migration 019 | **Applied in production** (`0 applied, 20 already recorded`); `projects.elevenlabs_voice_id` column created in migration 010 | 2026-10-20 11:04:47Z |
| Greeting | `project.onboarding_reply` spoken inside a `<Gather input="speech">` | `engine/src/interfaces/voice/index.ts:934-936` |
| Speech capture | `SpeechResult` / `speech_text` / `Body` accepted | `engine/src/interfaces/voice/index.ts:854`, `970` |
| Empty-input handling | Reprompt TwiML, then a second gather, then hangup | `engine/src/interfaces/voice/index.ts:984-998` |
| Barge-in | `<Gather>` re-opens after each reply; the caller may continue | `engine/src/interfaces/voice/index.ts:876`, `1029` |
| Response generation | `CoreEngine.processEnvelope` → role, step-up, farm-scope and unknown-speaker gates | `engine/src/core/engine.ts` |
| ElevenLabs synthesis | Per-project voice id, `eleven_turbo_v2_5`; **generic fallback forbidden** (422 `NO_VOICE_POINTER`) | `engine/src/interfaces/voice/index.ts:451-489` |
| Safe failure | `SYNTHESIS_FAILED` → apology + hangup; `ADAPTER_DEGRADED` → 503 before any tenant data | `engine/src/interfaces/voice/index.ts:511-534`, `277-313` |
| Transcript persistence | Inbound + outbound rows written; `voice_deliveries` ledger row per turn | `engine/src/interfaces/voice/index.ts:537-575`, `650-663` |
| **Twilio 12300 fix (`ac387be`) — LIVE** | Deployed 2026-10-19T16:57:08Z as `dep-dbb4np142hec7385cna0`; raw TwiML with `text/xml; charset=utf-8` | `render deploys list` |
| **Real call** | **NEVER EXECUTED** — Twilio `21210` "From is not a valid phone number" (unverified `+141...2671`); no call created, no transcript | `docs/release/cst-voice-live-call-attempt.md` |
| **Call SID** | **None from a successful call.** The only SID in evidence, `CAf4643166002591fe639a9349d91d21d3`, is from the **error-12300** call — a failed call, not a completed one | commit `ac387be` |
| Guest callers | Admitted as restricted guests, zero farm data, audit-logged | `b5697b4`; `tests/voice/voice_guest_access_regression.test.ts` |
| Live production voice traffic | **None observed** in the retrievable Render log window — no `SYNTHESIS_FAILED`, no `NO_VOICE_POINTER`, and no voice delivery either. The voice lane has no production traffic, so its live behaviour is entirely unproven. | `render logs` 2026-10-20 |

**Outbound calling requirement: CONFIRMED required** (a real call is the only way to prove the voice lane), and the runner is already wired for exactly one call with `--live`.

### 9.2 SMS

| Requirement | Status | Evidence |
|---|---|---|
| Consent → queue → dispatcher → provider → provider message id | Implemented; `provider_sid` persisted on success | `engine/src/transport/twilio/outbound.ts:447-460` |
| Status callback | `POST /twilio/delivery-status`, Twilio-signature verified, DID → tenant/project, monotonic guard, `cst.delivery` published only when tenancy resolves | `engine/src/transport/twilio/outbound.ts:588-692` |
| Real handset receipt | **NO EVIDENCE** — no authorized live SMS has been sent | §5.1 item 8 |
| Consent enforced at dispatch | Yes, re-checked at send time | `engine/src/transport/twilio/outbound.ts:254-329` |
| Opt-out audited | Yes, with commercial impact | same |
| **~40-minute delay** | **UNRESOLVED** — 5 s poll and 2–4 s backoff rule out the obvious causes; needs production query | §5.2 |
| Inbound routing vs DID capabilities | Enforced — a DID bound `sms` cannot serve voice and vice versa | `engine/src/interfaces/voice/index.ts:724-738`; `engine/src/transport/twilio/outbound.ts:229-250` |
| Message IDs | **NONE for production** — no production `provider_sid` in evidence | — |

---

## 10. Commercial relevance

Stated without invented figures. No revenue number is claimed, because none is measured.

**The three revenue gates (Jason's directive) are the commercial critical path**, and none of them is blocked on CST engineering:

- **Destiny — `DW-1791980388023-1Z1J`:** Intake-2 front door + Client 2 completion + the Google Form build spec. This is the *customer entry* gate. CST's role: the Intake-2 submission must land in a system that can later trigger U902 validation — so the intake form and the CST intake/identity path must agree on the identifiers that flow into the U902 read-back (Hardik's gate). If Intake-2 and CST disagree on any key, the U902 validation silently fails and the whole chain stalls.
- **Hardik — `DW-1791898769276-E3Q5`:** U902 read-back + idempotency + controlled Stripe→Ledger E2E. CST's role: the Stripe→Ledger path must terminate in a ledger CST can read back, and the CST `cst.turn` / `cst.delivery` events must carry `turn_id === correlation_id` so a payment can be joined to the customer turn that produced it. `/vfarm` correctly stays `interest_only_live` until this clears.
- **Kavin — `DW-1791990783434-UUC8`:** 2KG0 per-rack SKU wiring + end-to-end Stripe path. CST's role: the SKU must be bound to a project and a unit that CST's `service_number_binding` and `projects` registry already model, or the order will not resolve to a tenant.

**What CST's open gates cost commercially, stated as mechanism rather than money:**

- **5R0J unresolved** → the platform that customers and operators depend on has an open question about whether farm data or admin JWTs were previously exposed. **The 2026-10-20 evidence refresh materially narrowed this**: the authentication gate was committed 8 days *before* the production service was created, so no production deploy ever ran the unauthenticated code. The remaining open item is the vFarm API Gateway log (Query 3) plus a one-line confirmation that no non-Render CST deployment existed in the 2026-09-25 → 2026-10-07 code window. The unresolved question is now narrow and closable — it is no longer "we don't know if we were exposed", it is "here is the bounded window, here is the one external log that can close it".
- **Live voice unproven** → the voice lane is the highest-friction, highest-value onboarding and support channel, and it is the channel that most needs a human on the line. **The Twilio `12300` fix is live** (deployed 2026-10-19T16:57:08Z). The remaining blocker is purely operational: Twilio refused call creation with `21210` because the From number is unverified. One verified number and one handset close it.
- **Live SMS unproven** → A2P 10DLC registration risk attaches to traffic on numbers that have not been exercised end-to-end. A 40-minute delivery delay on a live number is a support-ticket generator, and it points at a queue or carrier behaviour nobody has inspected yet. The `21215` geo-permission class of error is already stored self-describing on the row, which makes the diagnosis a query away once DB access exists.
- **DB expiry 14 Nov 2026** → a hard free-tier cut-off, now **confirmed authoritatively** via the Render API (`expiresAt: 2026-11-14T18:10:20.49769Z`, exactly +90 days from `createdAt`). After that date the service loses its database, and the plan, the `pg_dump` pre-flight, the 5–10 minute cutover window, the validation SQL, and the rollback steps are already written. The only thing missing is the written approval and a calendar slot. **25 days remain** — this is the highest deadline-pressure item in the register and the cheapest to close.
- **DNS/TLS not provisioned** → `cst.bhanetwork.org` and `cst-admin.bhanetwork.org` **do not resolve** (confirmed 2026-10-20T12:00:58Z: no A, AAAA, or CNAME; TLS impossible). DNS for `bhanetwork.org` is served by GoDaddy, so the CNAME must be created there, pointing at `bha-cst-7u9e.onrender.com`, after the domain is added in the Render dashboard. Every internal link, operator shortcut, and any customer-facing surface pointed at those names is dead. A working custom domain with TLS is the difference between an internal tool and a customer-facing one, and it is the precondition for Twilio webhook signatures on a stable hostname.
- **BHARAG key scope unproven** → CST's own code will not route farm-specific questions to BHARAG and will not send `farm_id`/`unit_id` from the general-knowledge path. But CST cannot guarantee upstream enforcement. Until Jegan's three artifacts exist, the guarantee is "CST-side isolation is in place", not "the farm data cannot be reached through the cluster key".
- **Deployment drift: NONE.** The 2026-10-20 refresh confirmed the live deploy is identical to the repository HEAD, with migration 019 applied. This removes what the previous revision of this report called the top action. The remaining path to 31 October is *acceptance and access*, not code.

**Path to 31 October:** the launch target is not gated on more engineering. It is gated on (1) deploying 4 commits, (2) one real voice call, (3) one authorized live SMS, (4) three sign-offs, (5) DNS/TLS, and (6) the DB plan decision before 14 November. Items 1, 4, 5, and 6 are owner decisions. Items 2 and 3 need hardware and authorization. The engineering work that would be required to hit 31 October is complete.

---

## 11. Proposed Slack replies (NOT posted)

### 11.1 For `DW-1791852954583-46HC` — CST security / consent / verification (the watch awaiting Ahad)

> **Ahad — CST security / consent / verification status (DW-1791852954583-46HC)**
>
> Nothing is blocking me on the engineering side. Here is the honest state, and the three things I need from someone else.
>
> **Security (5R0J) — code complete, acceptance pending.** All four previously-unauthenticated proxy routes (`/api/devices`, `/api/dashboard`, `/api/farms`, `/api/tokens` plus their `/api/v1` aliases) are gated. No credential substitution: on the farm-key routes a caller-supplied vFarm JWT is refused with 403 rather than silently re-authenticated as CST, and on the JWT-scoped routes the caller's own JWT is forwarded verbatim. 26/26 regression tests pass. The remaining item is the **historical Render log review** — rejecting unauthenticated requests now does not prove there was no exposure before the patch. I need an authorized operator to run the queries in `docs/release/cst-5r0j-security-audit-and-residual-risk.md`, then **Destiny's formal sign-off**. I am not rotating any key before that review, because rotation would itself be a disclosable event.
>
> **Consent (NI8F) — implemented, not production-accepted.** Full spine implemented: server-stamped canonical wording, append-only tenant-consistent audit trail, STOP/HELP/START, and consent re-checked at dispatch time rather than only at enqueue. 38/38 local tests pass. What is missing is a **live carrier round trip**, which needs an approved recipient and a window. Local tests are not carrier proof and I will not present them as such.
>
> **Verification surface — what a reviewer can and cannot reproduce.** Reproducible today: `npm test` 618 passed / 6 skipped / 0 failed, typecheck clean, build clean, and live `/health` returning 200. Not reproducible today: production schema objects (direct psql is blocked — the DB IP allowlist is empty), a real voice call (Twilio rejected the call with 21210 on an unverified From number), a real SMS delivery, and live Dashboard ingestion (the 6 proof tests need `REAL_DASHBOARD_PROOF=1` with real credentials and have never been run). The **~40-minute SMS delay** is not explained by CST code — the outbound worker polls every 5 s and the in-process retry backoff is 2–4 s — so I need read access to `messages_out` to see the actual queue age, `next_retry_at` and stored provider error.
>
> **What I need, from whom:**
> 1. **Jason** — a verified Twilio From number and a reachable handset for one authorized live voice call; an approved SMS recipient and window; read access to `messages_out` (or an operator to run the query I will supply).
> 2. **Jason / platform owner** — the Postgres IP allowlist or a bastion, so migrations 017/018 and the voice pointer can be confirmed by schema inspection rather than by a ledger line. The DB expires **14 Nov 2026**; the Starter upgrade plan, pre-flight dump, cutover window, validation SQL and rollback steps are written and need written approval.
> 3. **Destiny** — formal acceptance of the 5R0J audit scope and residual risk, and the Operator Playbook drill date once the SOP is published.
>
> **One thing I should flag proactively:** the deployed commit is `b06c68f` and it **matches the repository HEAD** — all four commits from 19 Oct are live, including the Twilio `12300` fix, and migration 019 is applied (`0 applied, 20 already recorded`). So the voice webhook is no longer returning JSON-wrapped TwiML. The live voice gap is now purely operational: the call was refused at creation with Twilio `21210` because our From number is unverified, and there has been no production voice traffic since. A verified number and a handset are what that gate needs.
>
> **Next checkpoint:** within one business day of the above, I will post the real call SID, the transcript, the live SMS provider message ID and the delivery callback, or a specific statement of what is still blocked. I am not proposing to close this watch on the strength of local tests.
>
> No commits, pushes, deploys, production config changes, secret rotations, migrations, or real calls/SMS have been made.

### 11.2 For Jason — deployment, DB, and the revenue-gate dependency

> **Ahad — CST: four commits ready to deploy, and the DB decision that is closest to its deadline**
>
> 1. **Deployment: nothing to approve — already done.** `main` is at `b06c68f` and Render's **Live** deploy is `b06c68f` (deploy `dep-dbb7gl9srm7s73dc8phg`, 2026-10-19T20:06:45Z). The four commits from 19 Oct are all live, including the Twilio `12300` fix, and migration 019 is applied (`0 applied, 20 already recorded`). Earlier notes that said `3e88058` were true on 19 Oct at 13:53Z and are now stale. One thing to flag: `autoDeploy` is on `commit` for branch `main`, so **a push to `main` is a production deployment** — there is no staging branch, and migrations run on startup.
> 2. **Postgres expires 14 Nov 2026** (free tier, `dpg-db8he2qvcj2c73ado3s0-a`, `expiresAt 2026-11-14T18:10:20.49769Z` — confirmed via the Render API, exactly +90 days after creation). The plan, the `pg_dump` pre-flight, the 5–10 minute cutover window, the post-cutover validation SQL and the rollback steps are written in `docs/release/cst-database-continuity-plan.md`. I need your written approval for the $7/mo Starter tier and a window. This is the item closest to a hard deadline.
> 3. **DB access.** The IP allowlist is empty, so direct psql is refused and I cannot confirm migrations 017/018/019, the append-only trigger, or the project voice pointer by schema inspection — only by a ledger line. Adding my IP, or running one SQL checklist, closes it.
> 4. **DNS/TLS.** `cst.bhanetwork.org` and `cst-admin.bhanetwork.org` do not resolve — no A, AAAA, or CNAME, so TLS cannot even be attempted. `bhanetwork.org` is on GoDaddy nameservers, so the CNAME has to be created there (pointing at `bha-cst-7u9e.onrender.com`) after the domain is added in the Render dashboard. Until then there is no stable customer-facing hostname for the Twilio webhook signatures.
> 5. **Live voice and live SMS** each need one authorized real event: a verified Twilio number plus a handset, and an approved recipient plus a window.
> 6. **On your three revenue gates:** CST's dependency on **Destiny's Intake-2** is that the intake identifiers must match what U902 read-back keys on, or the validation fails silently. On **Hardik's Stripe→Ledger**: CST's `cst.turn`/`cst.delivery` events join on `turn_id === correlation_id`, so a payment can only be tied to a customer turn if Hardik's ledger carries that correlation id. On **Kavin's 2KG0 SKU**: the SKU must resolve to a project and unit that CST's `service_number_binding` and `projects` registry already model. I have not started any of their work and have not touched their scopes.
>
> `/vfarm` correctly stays `interest_only_live` until Hardik's controlled E2E clears.

### 11.3 For Destiny — security acceptance, and the two CST artifacts

> **Ahad — CST: 5R0J security acceptance request, and the Operator Playbook**
>
> **5R0J — the fix is deployed and observable; the acceptance is yours.** The four previously-unauthenticated vFarm proxy routes are gated with no credential substitution: on the farm-key-scoped routes a caller-supplied vFarm JWT is refused with 403 rather than silently re-authenticated as CST's own key, and on the JWT-scoped routes the caller's own JWT is forwarded verbatim. 26/26 regression tests pass, the gate has no NODE_ENV/test bypass (so the suite cannot go vacuous), and production returned 401 across all eight endpoint variants with matching `SECURITY_LEDGER` refusals. **The one thing I cannot do is prove there was no historical exposure** — rejecting unauthenticated requests now says nothing about the window before the patch. The audit scope, log query filters and residual-risk statement are in `docs/release/cst-5r0j-security-audit-and-residual-risk.md`. I have asked an authorized operator for the historical log review. Once that lands, I need your formal accept/reject. I have deliberately **not** rotated any credential: rotation is itself a disclosable event and should follow the review, not precede it.
>
> **Operator Playbook (Y5TW).** The draft is complete in the repository and contains no secrets, tokens, passwords or raw credentials — it records *where* access lives and how it is provisioned, never the value. It covers the daily availability window, the heads-down handoff protocol, the AI-assistant connection procedure, the responsibility matrix and second operators (Primary Ahad, Second Syed, Backup Jegan), the single-point-of-failure actions only I can perform, four core blocker areas with step-by-step fixes, the 1-hour escalation ladder, the access directory, and the live simulation exercise. It is **not yet published** — it still needs to go to Codex → SOPs and BHARAG under `sop/bays-cst-operations`, and then your unannounced blocker-triage drill, which is the acceptance test. It is not complete until that drill passes.
>
> **A note on the voice lane**, since it affects what you may test: the deployed build returns JSON-wrapped TwiML, which Twilio rejects (error 12300). That is fixed in the repository but not yet deployed. A real end-to-end call has never completed — the call was refused at creation with Twilio 21210 because the From number is unverified. I am not claiming voice readiness from a 200 or a simulated webhook.
>
> **Ask:** your 5R0J acceptance (after the log review), a publication slot for the SOP, and a drill date. The local baseline for you to check me against is 618 passed / 6 skipped / 0 failed, typecheck clean, build clean.

---

## 12. Next 24 hours

| # | Action | Owner | Artifact |
|---|---|---|---|
| 1 | Reply in-thread on `DW-1791852954583-46HC` with §11.1 — this is the only item still sitting on Ahad, and it escalates to Jason + Destiny on the next pass | **Ahad** | Slack thread reply |
| 2 | ~~Request deployment authorization for the 4 undeployed commits~~ — **NO LONGER NEEDED: verified live 2026-10-20.** Replaced by: confirm the production voice pointer value before the first real call (registry fallback risk) | **Ahad** (DB access, see row 6) | §1 finding 1 |
| 3 | Request a **verified** Twilio From number + a reachable handset for one authorized live voice call | **Ahad → Jason** | §5.4 |
| 4 | Request an approved SMS recipient + window, and `messages_out` read access (or a run of the supplied query) to diagnose the ~40-minute delay | **Ahad → Jason** | §5.2 |
| 5 | Submit the Postgres Starter upgrade plan for written approval and schedule the cutover **before 14 Nov 2026** | **Ahad → Jason** | `cst-database-continuity-plan.md` |
| 6 | Request the DB IP allowlist addition, or hand the SQL checklist to an authorized operator; run the same for the 5R0J historical log review | **Ahad → platform owner** | `cst-ho-fe-schema-verification-guide.md` |
| 7 | Send Jegan the 3 named BHARAG key-scope artifacts (negative test, positive test, upstream policy proof) | **Ahad → Jegan** | §5.3 |
| 8 | Report the VU6R source-check results; ask Jason to identify the Client 2 contact — **the VU6R deadline is today** | **Ahad** | `cst-vu6r-blocker.md` |
| 9 | Publish the Operator Playbook SOP to Codex → SOPs and BHARAG `sop/bays-cst-operations`; ask Destiny to schedule the simulation drill | **Ahad** | `operator-playbook-sop.md` |
| 10 | Verify the registry voice-pointer fallback: confirm `projects.elevenlabs_voice_id` for `proj-vfarm-main` in production; if empty, set `VFARM_ELEVENLABS_VOICE_ID` in Render (or remove the `'eleven_voice_jason_vfarm'` fallback) | **Ahad** | §1 finding 1 |
| 11 | Update `docs/task.md` and `docs/release/task.md` to the 618/624 baseline, the 4-commit deployment drift, and the DNS resolution failures | **Ahad** | tracker refresh |
| 12 | Ask Destiny to confirm the final state of `DW-1791851358695-JU0D` (not present in repository records) | **Ahad → Destiny** | §2 register |

---

## 13. Change log for this audit

**Files modified (1, uncommitted):**

| File | Change | Behavior before → after | Risk |
|---|---|---|---|
| `engine/src/transport/twilio/outbound.ts` | Removed a duplicated `isSmsCapabilityEnabled(msg)` block (23 lines) that ran immediately after an identical check. The **first** capability check — and the consent gate, the DID resolution, and the `consent_exempt` fence — are untouched and in their original order. | Before: the second identical capability check was unreachable (the first already `continue`d) — dead code. After: identical observable behavior, one fewer redundant DB-free branch. | **None.** Behavior-preserving. Verified by the full suite. |

**Deliberately NOT changed, with reasons:**

| Item | Why not |
|---|---|
| `engine/src/core/registry.ts:185-194` — `'eleven_voice_jason_vfarm'` fallback | Fixing it correctly requires a decision (set the Render env var vs. remove the fallback) and a production-voice acceptance run. Blindly editing could disable a working voice path. Recorded as finding #1 with the exact remediation. |
| `engine/src/core/engine.ts:841` — hardcoded `'tenant-vfarm-01'` in `detectOutOfScopeFarmMention` | Pre-existing and not a regression. Changing tenant-scoping logic is not a "narrow" fix and needs its own test coverage. Recorded as an architecture gap. |
| Migration 019 / 020 | Production migrations require authorization. |
| Any deploy, commit, push, secret rotation, or real call/SMS | Rule 1 — explicit authorization required. |

**Verification after the change:** `npm test` → **61 files passed, 618 passed / 6 skipped / 0 failed**; `npm run typecheck` → exit 0; `npm run build` → clean.

---

*End of report. Prepared by Ahad (U0AC6RFNP3P), 2026-10-20. Uncommitted. No production changes made.*
