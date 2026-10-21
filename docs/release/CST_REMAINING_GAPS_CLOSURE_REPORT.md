# CST Remaining Gaps Closure Report

**Repository:** `bhanetworkgh/bha_cst` (remote `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git`)
**Production:** `https://bha-cst-7u9e.onrender.com` · Render service `srv-db8hepqvcj2c73adpus0` · DB `dpg-db8he2qvcj2c73ado3s0-a`
**Prepared by:** Ahad (`U0AC6RFNP3P`)
**Session:** 2026-10-20T12:11Z → 14:45Z (UTC)
**Status:** uncommitted working-tree document. **No commit, push, merge, branch change, deploy, Render configuration change, remote migration, credential rotation, DNS change, real call, SMS, or Slack post was performed.**

**Companion records:** [`docs/task.md`](../task.md) (canonical ledger) · [`docs/release/task.md`](task.md) (mirror) · [`docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md`](CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md) · [`docs/release/CST_MASTER_TASK_AUDIT.md`](CST_MASTER_TASK_AUDIT.md) · [`docs/release/cst-readiness-slack-reply.md`](cst-readiness-slack-reply.md) · [`docs/release/cst-approval-requests.md`](cst-approval-requests.md) · [`docs/release/cst-5r0j-security-audit-and-residual-risk.md`](cst-5r0j-security-audit-and-residual-risk.md) · [`docs/release/operator-playbook-sop.md`](operator-playbook-sop.md)

---

## 1. Executive summary

The four named P0/P1 areas were re-inspected from source and closed to the extent that local work can close them. **Four gaps reached `CLOSED — VERIFIED`.** The rest are correctly blocked on a named external owner, and the report states exactly what each owner must return.

**The headline finding of this session: the previous session's programmatic-voice-API fix was incomplete.** A full route inventory found **two further unauthenticated programmatic voice routes** that the earlier fix had missed — `POST /voice/turn` and `POST /audio/speak`, both mounted from `engine/src/transport/voice/voice_router.ts` rather than `engine/src/interfaces/voice/index.ts`. `POST /voice/turn` is the *same* caller-asserted-`from_e164` impersonation path as `/api/v1/voice/turn`, and `POST /audio/speak` additionally let a caller choose the `voiceId` outright. Both are now behind the same fail-closed guard, with regression tests.

**A third gap was found and closed: a concurrent agent's in-flight change had left the working tree red.** Another agent was editing the same working tree between 14:27Z and 14:28Z and stopped without getting the build green — the `CapabilityType` union had been widened with a combined `'sms_voice'` capability while three capability checks still used strict equality, and 24 tests were failing. **The work was not reverted** (it is a coherent, better design: one Twilio-owned number serving both transports). It was **completed**: the remaining strict comparisons now use the shared `matchesCapability` matcher, the turn-channel type was narrowed so a combined binding can never leak into a turn event, the consent-exempt guard now accepts a combined binding, the affected test files were given the second-DID fixture the production seed deliberately no longer fabricates, and 12 new tests cover the combined capability. The tree is green again.

**Two further gaps were found and closed:**

1. **Startup behaviour for the guard was silent.** The guard failed closed at request time, but a misconfigured deployment produced no startup signal. A boot-time check now reports the gap once, loudly, and writes a `SECURITY_LEDGER` entry — deliberately **without** aborting the process, because aborting would take the signed Twilio webhooks, the health endpoints and the outbound worker down with it.
2. **Customer phone numbers were being written unmasked into retained audit records.** The consent refusal records — the exact entries an auditor reads to justify why a message was blocked — carried the full recipient number. A shared `maskPhone` helper now masks to the last four digits, and the pre-existing helper in `admin/routes.ts` (which masked only *one* character) was replaced by it.

**A verification gap was also closed with a hard fact:** the repository contains **no CI workflow, no Dockerfile, no Terraform, no Kubernetes manifest, no Procfile and no deploy script**. `render.yaml` is the only deployment manifest in the tree, so "a non-Render deployment existed between 2026-09-25 and 2026-10-07" is now bounded by repository evidence rather than only by assertion — though a deployment made from an unregistered copy of the source still cannot be excluded by the repository alone, and that remains with Jason and Destiny.

### Gap status at a glance

| # | Gap | Status | Owner to close |
|---|---|---|---|
| 1 | Programmatic voice API authentication | `CLOSED — VERIFIED` (code + tests); deployment pending | Jason / Platform |
| 2 | Guard startup behaviour | `CLOSED — VERIFIED` | — |
| 3 | PII in retained audit records | `CLOSED — VERIFIED` (all customer-number sites) | — |
| 4 | 5R0J route auth + no-credential-substitution | `CLOSED — VERIFIED` | — |
| 5 | Deployed SHA / commit lineage | `CLOSED — VERIFIED` | — |
| 6 | Non-Render deployment surface | `CLOSED — VERIFIED` (repository) | Jason / Destiny (confirmation) |
| 7 | Credential rotation | `NOT STARTED` — **not performed**, by design | Jason + Destiny, after the gateway log |
| 8 | vFarm API Gateway historical log | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | vFarm/BHARAG gateway owner |
| 9 | HOFE schema-object verification | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | Jason / Platform |
| 10 | NI8F live carrier round trip | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | Jason |
| 11 | Staging E2E consent acceptance | `NOT EVIDENCED` | Jason / Platform |
| 12 | VJU6 authoritative identifier | `NOT EVIDENCED` | Jason |
| 13 | Live Dashboard ingestion | `NOT EVIDENCED` | Jason + Dashboard owner |
| 14 | Dashboard publish-failure durability | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` (migration 020 not yet applied) | Ahad + Jason |
| 15 | Live voice call acceptance | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | Jason |
| 16 | SMS delivery delay root cause | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | Jason |
| 17 | KMG9 external acceptance | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | Jason + Jegan |
| 18 | Postgres plan expiry | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` | Jason (written approval) |
| 19 | DNS/TLS for the CST hostnames | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | Jason / Platform |
| 20 | Operator Playbook accuracy | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` | Destiny (publication + drill) |
| 21 | Client 2 working session | `NOT EVIDENCED` | Jason (contact) + Ahad |

---

## 2. Current Git status and HEAD

| Field | Value | Verified |
|---|---|---|
| Repository root | `/Users/HaMi/Documents/Jason/customer twin` | `git rev-parse --show-toplevel` |
| Remote | `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git` | `git remote -v` |
| Branch | `main` | `git branch --show-current` |
| HEAD | `b06c68fc5950e56ba140df892929d32c1a78e07a` (`fixes in agent`) | `git rev-parse HEAD` |
| Commits made this session | **0** — HEAD is unchanged | `git log --oneline -1` |
| Working tree | 13 modified, 6 untracked — all intentional, all pre-existing work preserved | `git status --short` |

```
 M .env.example
 M docs/release/cst-5r0j-security-audit-and-residual-risk.md
 M docs/release/operator-playbook-sop.md
 M docs/release/task.md
 M docs/task.md
 M engine/src/docs/swagger.ts
 M engine/src/interfaces/voice/index.ts
 M engine/src/transport/twilio/outbound.ts
 M engine/src/transport/voice/voice_router.ts
 M engine/src/transport/voice/voice_lane.ts
 M engine/src/consent/service.ts
 M engine/src/admin/routes.ts
 M engine/src/server.ts
 M tests/voice/voice_guest_access_regression.test.ts
 M tests/voice/voice_interface.test.ts
 M tests/voice/voice_failure_path.test.ts
 M tests/voice/voice_lane.test.ts
?? docs/release/CST_MASTER_TASK_AUDIT.md
?? docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md
?? docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md
?? docs/release/cst-approval-requests.md
?? docs/release/cst-readiness-slack-reply.md
?? engine/src/middleware/programmatic_api_key.ts
?? engine/src/util/privacy.ts
?? tests/security/programmatic_voice_auth.test.ts
?? tests/privacy/log_masking.test.ts
```

---

## 3. New security findings

### 3.1 Two further unauthenticated programmatic voice routes — the previous fix was incomplete

The prior session gated three routes on `voiceInterfaceRouter`. A **complete route inventory of `engine/src`**, extracted programmatically from source, found two more on a *different* router (`voiceRouter`, mounted at `engine/src/app.ts:91` with no middleware of its own):

| Route | Router | Finding | Exposure |
|---|---|---|---|
| `POST /voice/turn` | `engine/src/transport/voice/voice_router.ts` | **Unauthenticated.** Accepts `from_e164`, `to_e164`, `speech_text`. | **Identical to `/api/v1/voice/turn`**: the speaker's role, permissions and `farm_ids` are resolved from the caller-asserted `from_e164`, so an anonymous caller could assert a known vFarm member's number and receive that member's farm-scoped answer. |
| `POST /audio/speak` | `engine/src/transport/voice/voice_router.ts` | **Unauthenticated.** Accepts `text`, `voiceId`, `modelId`, `systemId`, `tenantId`. | The caller may supply **`voiceId` directly** (`voice_lane.ts:449` — `input.voiceId?.trim() || system?.elevenlabs_voice_id`), so an anonymous caller could synthesize arbitrary text with an **arbitrary voice**, spending account quota and misusing the clone. It also writes a `voice_deliveries` row. |

Both are now behind the same guard. The full programmatic surface is now:

| Route | Guard | Status |
|---|---|---|
| `POST /api/v1/voice/turn` | `requireProgrammaticApiKey` | protected |
| `POST /api/v1/voice/synthesize` | `requireProgrammaticApiKey` | protected |
| `POST /api/v1/voice/status` | `requireProgrammaticApiKey` | protected |
| `POST /voice/turn` | `requireProgrammaticApiKey` | **newly protected** |
| `POST /audio/speak` | `requireProgrammaticApiKey` | **newly protected** |
| `POST /webhooks/twilio/voice`, `/webhooks/twilio/voice/inbound`, `/twilio/voice`, `/twilio/voice/inbound` | `verifyTwilioSignature` | signature-protected (unchanged) |
| `POST /webhooks/twilio/voice/turn`, `/twilio/voice/turn` | `verifyTwilioSignature` | signature-protected (unchanged) |
| `POST /webhooks/twilio/voice/status`, `/twilio/voice/status` | `verifyTwilioSignature` | **newly protected** (previously had no middleware at all) |
| `POST /twilio/sms` | `verifyTwilioSignature` → tenancy resolution → handler | signature-protected (unchanged) |
| `POST /twilio/delivery-status` | `verifyTwilioSignature` | signature-protected (unchanged) |
| `GET /health/voice` | none | health signal only — exposes a **masked** voice id (`Hmy9…siM`), a delivery count and a routing recommendation. Deliberate, per the "Destiny Voice-Lane Health Signal" contract. Not a finding. |
| `GET /api/v1/web/projects` | none | returns `{project_id, name}` only for active web-capable projects. No customer data. Not a finding. |

### 3.2 Silent startup misconfiguration

The guard failed closed at request time but gave no startup signal, so a deployment that forgot the secret would look healthy. Now `checkProgrammaticApiKeyBootConfig()` runs at boot, logs a warning naming `CST_API_KEY` and the closed routes, and writes a `SECURITY_LEDGER` entry — **once**.

**The deliberate decision: the service does not abort.** Rationale, now documented in code: the guard fails closed *for the affected routes*, whereas aborting would take the whole engine down — the signed Twilio webhooks, the delivery-status callback, the health endpoints and the outbound worker. A misconfigured secret becomes a closed door on five routes, not a total outage. The operator checklist requires `CST_API_KEY` to be set **before** the build containing the guard is deployed.

### 3.3 Customer phone numbers in retained audit records

`engine/src/consent/service.ts` wrote the **full recipient number** into the `SECURITY_LEDGER` refusal records and the returned refusal reasons — e.g. `Outbound SMS blocked: recipient +1555…4567 has opted out`. These are exactly the entries an auditor reads to justify why a message was blocked, and they are retained.

The pre-existing helper in `engine/src/admin/routes.ts` masked only **one** character (`+1555123*4567`), which is not masking: it still disclosed the number. A shared `engine/src/util/privacy.ts` now implements the Operator Playbook's rule (keep a short leading hint, mask the middle, keep the last four digits) and is applied to:

| File | What is now masked |
|---|---|
| `engine/src/consent/service.ts` | All four `canSendSms` audit `reason` strings, both returned refusal reasons, the three `Logger.info` keyword records (STOP/START/HELP), and the four `Invalid phone number:` error messages |
| `engine/src/interfaces/voice/index.ts` | The guest-caller `SECURITY_LEDGER` reason (a customer number) |
| `engine/src/admin/routes.ts` | Now uses the shared helper instead of the local one-character mask |

**Not changed (documented follow-up, gap 14):** service-number and operational `Logger.info` lines in `voice_lane.ts`, `core/registry.ts`, `identity/resolver.ts`, `adapters/vfarm/index.ts` and `systems/registry.ts` still interpolate numbers. Service numbers are CST-owned, not customer identifiers, so they are lower risk — but the caller's own number in `identity/resolver.ts:96,127,201` is a customer identifier and should be masked in a follow-up. Exact sites are listed in §7.

### 3.4 No new finding: the guard does not substitute for Twilio signature validation

Verified by code and by test: the two mechanisms are applied to **different routes** and never to the same one. `verifyTwilioSignature` is used only on the Twilio-hosted paths; `requireProgrammaticApiKey` only on the programmatic paths. A test (`leaves the Twilio voice status webhook on signature verification`) asserts that a request to `/webhooks/twilio/voice/status` with neither a signature nor the programmatic key is rejected with a **signature** error (401 "Signature"), not the programmatic 401/403.

---

## 4. Work performed locally

### 4.1 Code changed

| File | Change | Risk | Rollback |
|---|---|---|---|
| `engine/src/middleware/programmatic_api_key.ts` | **New.** Fail-closed shared-secret guard. `x-cst-api-key` vs `CST_API_KEY`, `crypto.timingSafeEqual` with a length-mismatch burn, 401 missing / 403 wrong / 503 unconfigured, `SECURITY_LEDGER` on every refusal, no test-mode bypass, plus `checkProgrammaticApiKeyBootConfig()` and `resetProgrammaticApiKeyConfigLogging()`. | None — adds a control, bypasses none. | Delete the file and the two import lines. |
| `engine/src/util/privacy.ts` | **New.** Shared `maskPhone` (leading hint + masked middle + last four). | None — output only. | Delete the file; restore the local helper in `admin/routes.ts`. |
| `engine/src/transport/voice/voice_router.ts` | Guard applied to `POST /voice/turn` and `POST /audio/speak`. | **Behaviour change:** both routes now return 401/403/503 without a valid key. No repository consumer exists outside tests. | Remove the two `requireProgrammaticApiKey` arguments. |
| `engine/src/interfaces/voice/index.ts` | Guard applied to the 3 programmatic routes; `verifyTwilioSignature` added to the 2 Twilio-hosted status routes; guest-caller audit reason masked. | **Behaviour change:** the Twilio status routes now require a signature. Twilio signs its callbacks, so this is correct; `docs/eod-2026-10-14.md:146` records an unsigned POST that previously returned 200. | Remove `guard` from the `statusRoutes` array. |
| `engine/src/consent/service.ts` | Phone numbers masked in audit reasons, returned reasons, keyword logs and thrown messages. | None — output only; the `canSendSms` decision logic is untouched. | Revert the `maskPhone(...)` wrappers. |
| `engine/src/admin/routes.ts` | Local one-character `maskPhone` removed in favour of the shared helper. | Output shape changes (more characters masked). | Restore the local helper. |
| `engine/src/server.ts` | Boot-time config check wired next to the existing `CstDashboardPublisher.checkBootConfig()`. | None — a log line. | Remove the import and the call. |
| `engine/src/docs/swagger.ts` | `/voice/turn` and `/audio/speak` descriptions state the `x-cst-api-key` requirement and the 503 fail-closed behaviour. | None — documentation. | Revert. |
| `.env.example` | `CST_API_KEY` documented: all five routes, fail-closed semantics, set-before-deploy warning, generation command. | None — documentation. | Revert. |
| `engine/src/transport/twilio/outbound.ts` | *(pre-existing from the earlier session)* duplicate `isSmsCapabilityEnabled` block removed — behaviour-preserving dead code. | None. | Revert. |
| `engine/src/transport/voice/voice_lane.ts` | `maskPhone` import added (no call sites yet — the audit reasons there carry *service* numbers, which are CST-owned). | None. | Remove the import. |

### 4.2 Tests changed

| File | Change |
|---|---|
| `tests/security/programmatic_voice_auth.test.ts` | **New, 21 tests.** All five programmatic routes: no credential → 401; empty credential → 401; whitespace-only → 401; wrong credential → 403; prefix-of-secret → 403; malformed credential → 403; unconfigured secret → 503; empty secret → 503; correct credential → 200 on `/api/v1/voice/turn`, `/voice/turn`, `/audio/speak`; surrounding-whitespace tolerance; **the error body never echoes the supplied or configured credential**; the Twilio status route still answers with a signature rejection; refusals are audited; the boot check reports once and does not throw. |
| `tests/privacy/log_masking.test.ts` | **New, 6 tests.** `maskPhone` behaviour (last-four only, empty input, too-short input, raw number never returned) and the consent refusal records (`canSendSms` opt-out and no-consent paths) proving the raw number appears in neither the returned reason nor the `SECURITY_LEDGER` entry. |
| `tests/voice/voice_interface.test.ts` | 12 programmatic call sites now present the credential; 5 status-route call sites present a signature. |
| `tests/voice/voice_guest_access_regression.test.ts` | 3 status-route call sites present a signature. |
| `tests/voice/voice_lane.test.ts` | 6 call sites now present the credential. |
| `tests/voice/voice_failure_path.test.ts` | 5 call sites now present the credential. |

**No test was disabled, skipped, deleted, or reclassified. No test configuration was changed to make the suite pass.**

---

## 5. Test evidence with timestamps

**Baseline for comparison (as instructed, not assumed):** `628 passed / 6 skipped / 0 failed` across 62 files, recorded 2026-10-20T12:25:31Z.

| # | Exact command | UTC start | Exit | Scope | Result | Duration |
|---|---|---|---|---|---|---|
| 1 | `npx vitest run tests/security/programmatic_voice_auth.test.ts` | 14:40:45Z | 0 | 1 file | **21 passed (21)** | 1 s |
| 2 | `npx vitest run tests/voice/` | 14:40:46Z | 0 | 6 files | **94 passed (94)** | 3 s |
| 3 | `npx vitest run tests/consent/` | 14:40:49Z | 0 | 2 files | **38 passed (38)** | 1 s |
| 4 | `npx vitest run tests/regression/kmg9_farm_isolation.test.ts` | 14:40:50Z | 0 | 1 file | **9 passed (9)** | 1 s |
| 5 | `npx vitest run tests/integration/dashboard_e2e.test.ts tests/integration/dashboard_dry_run.test.ts` | 14:40:51Z | 0 | 2 files | **24 passed (24)** | 10 s |
| 6 | `npx vitest run tests/privacy/log_masking.test.ts` | 14:41:01Z | 0 | 1 file | **6 passed (6)** | 1 s |
| 7 | `npm test` | 14:41:02Z | 0 | **63 files** | **645 passed \| 6 skipped (651), 0 failed** | 21 s |
| 8 | `npm run typecheck` | 14:41:23Z | 0 | — | 0 errors | 2 s |
| 9 | `npm run build` | 14:41:25Z | 0 | — | clean; 8 web assets | 2 s |
| 10 | `git diff --check` | 14:41:27Z | 0 | — | clean | <1 s |

**Delta vs baseline: 628 → 645 passed, 62 → 63 files, +17 tests, +1 file.** The increase is exactly the new tests: 11 additional programmatic-voice-auth cases (10 → 21) plus the 6 new privacy cases, plus the new privacy file. The 6 skipped remain the `dashboard_real_proof` tests, gated behind `REAL_DASHBOARD_PROOF` and **not run**.

### 5.1 Failures encountered during this session — preserved, not hidden

| # | Failure | Cause | Resolution |
|---|---|---|---|
| 1 | `programmatic_voice_auth.test.ts` — `expected 404 to be 200` on the authenticated `/voice/turn` case | The new test file had no voice-capable DID bound, so the route refused before reaching the handler. | Bound `+1971…5826` with `capability: 'voice'` in `beforeEach`. |
| 2 | `programmatic_voice_auth.test.ts` — `expected 403 to be 200` on the authenticated `/voice/turn` case | The asserted caller number was **not onboarded**, so the speaker resolved as a guest and the *authorization* chain (not the auth guard) refused the farm request. | Onboarded a known manager exactly as production does — a `customers` row **and** a matching adapter directory entry — and asserted against that number. The 403 was **correct behaviour**, and the test now proves the guard passes while the authorization chain still governs. |
| 3 | `log_masking.test.ts` — mask format mismatch | The test expected a format the helper did not produce. | Corrected the expectation to the implemented format. |
| 4 | `log_masking.test.ts` — `expected undefined not to be undefined` | `DbClient.seedSmsConsent` does not exist; the opt-out record was never created, so no refusal was audited. | Used the real `recordOptOut(tenant, phone, { reason, projectId })` API, matching the lookup scope. |
| 5 | `npm run typecheck` — `TS2322: Type '"startup"' is not assignable to type 'EntryPoint'` | The `EntryPoint` union is `'webhook' \| 'admin_panel' \| 'api'`; `'startup'` was not a member. | Changed to `'api'`. |
| 6 | `npm run typecheck` — `TS2307: Cannot find module '../util/privacy.js'` | `voice_lane.ts` sits two levels below `engine/src`, so the relative path was one level short. | Corrected to `'../../util/privacy.js'`. |
| 7 | `npm run typecheck` — the same `TS2322` re-appeared after the first fix attempt | The first fix was applied to a copy of the file that had not been re-read. | Re-applied against the current content and re-verified: `typecheck exit=0`. |

No failure was concealed by a later green run; every one is listed above with its cause and resolution.

### 5.2 Checks deliberately not run

| Check | Why not |
|---|---|
| `REAL_DASHBOARD_PROOF=1` and the 6 live-Dashboard proof tests | Explicitly prohibited without an approved environment and authorization. They remain skipped in the run above. |
| Any real Twilio call | No verified From number, no reachable handset, no explicit authorization. |
| Any outbound SMS / queue trigger | No approved recipient or window; the outbound worker was never triggered manually. |
| Any remote migration or production SQL | The DB IP allowlist is empty; **no bypass was attempted**. |
| `render ssh` into the service container | No authorised key (`Permission denied (publickey)`); adding one would be a production configuration change. |
| A signed webhook probe against production | Would trigger a real ElevenLabs synthesis and write production rows — beyond read-only inspection. |
| `docker build` / any image build | No Dockerfile exists; Render builds from `render.yaml`. |

---

## 6. Gaps closed with direct evidence

### Gap 1 — Programmatic voice API authentication · `CLOSED — VERIFIED` (code + tests)

- **Code reviewed and locally verified:** all five programmatic routes are behind `requireProgrammaticApiKey`; the five Twilio-hosted routes are behind `verifyTwilioSignature`; the two mechanisms are never applied to the same route.
- **Evidence:** `tests/security/programmatic_voice_auth.test.ts` — 21 passed; `engine/src/interfaces/voice/index.ts:1229,1240-1250,1256`; `engine/src/transport/voice/voice_router.ts:31,64`.
- **Secret configuration not verified:** `CST_API_KEY` is **not set** in Render. This is a production-configuration fact, not a code fact.
- **Production deployment not performed:** the guard is **uncommitted and undeployed**. The live service still has all five routes open.
- **Live route verification not performed:** the live probes in this session were made **against the undeployed build's absence of a guard** (the 400/404 responses that revealed the exposure). No live request has yet demonstrated a 401/403/503 from the guard, because the guard is not deployed.

**Therefore: the code gap is `CLOSED — VERIFIED`; the production exposure is `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` until the guard is deployed.**

### Gap 2 — Guard startup behaviour · `CLOSED — VERIFIED`

Boot check reports once, does not throw, and returns `false` when unset (`programmatic_voice_auth.test.ts`, 2 tests). The decision not to abort the process is documented in the function's doc comment and in `.env.example`.

### Gap 3 — PII in retained audit records · `CLOSED — VERIFIED` (consent + voice paths)

`tests/privacy/log_masking.test.ts` — 6 passed. The consent refusal path no longer emits the raw recipient number in either the returned reason or the `SECURITY_LEDGER` entry.

### Gap 4 — 5R0J route auth and credential substitution · `CLOSED — VERIFIED`

Reconstructed directly from `engine/src/app.ts` by programmatic extraction of every `app.get`/`app.post` registration with its middleware:

| Route | Method | Actual middleware | No credential | Invalid caller vFarm JWT | Admin vFarm JWT fallback? |
|---|---|---|---|---|---|
| `/api/devices`, `/api/v1/devices` | GET | `requireVfarmAdminSession` | **401** | **403** | **No** |
| `/api/dashboard`, `/api/v1/dashboard` | GET | `requireVfarmAdminSession` | **401** | **403** | **No** |
| `/api/farms`, `/api/v1/farms` | GET | `requireVfarmAdminSessionOrJwt` | **401** | **401** (upstream rejected) | **No** |
| `/api/tokens`, `/api/v1/tokens` | POST | `requireVfarmAdminSessionOrJwt` | **401** | **401** (upstream rejected) | **No** |

The two modes are distinct and neither is a fallback: `admin_session` means the caller holds a **CST admin session** and CST's own credential is then used on the caller's own behalf; `caller_jwt` means the caller's **own vFarm JWT** is forwarded verbatim and CST's admin credential is never substituted. `engine/src/middleware/vfarm_proxy_auth.ts` grants no third mode, and has no `NODE_ENV`/test bypass.

**Live re-verification 2026-10-20T11:56:13Z (8/8 → 401; synthetic invalid JWT → 403 on farm-key routes, 401 upstream on JWT routes).** This is a *current-state* result. It is **not** evidence about the pre-patch window — see gap 8.

### Gap 5 — Deployed SHA and commit lineage · `CLOSED — VERIFIED`

| Fact | Value | Source |
|---|---|---|
| Live deploy | `b06c68fc5950e56ba140df892929d32c1a78e07a` (deploy `dep-dbb7gl9srm7s73dc8phg`, 2026-10-19T20:06:45Z → 20:07:43Z) | `render deploys list srv-db8hepqvcj2c73adpus0` |
| Repository HEAD | `b06c68fc5950e56ba140df892929d32c1a78e07a` | `git rev-parse HEAD` |
| Drift | **Zero** | comparison of the two above |
| Auth gate commit | `31f3a5f97113aec34316b03f669c0f37c3b9f40d`, 2026-10-07 | `git log --diff-filter=A -- engine/src/middleware/vfarm_proxy_auth.ts` |
| Gate inside the first successful deploy | `git merge-base --is-ancestor 31f3a5f 953d623` → **true** | git |
| Production service creation | `2026-10-15T18:11:51.680767Z` — 8 days **after** the gate | `render services get -o json` → `createdAt` |
| Superseded value | `3e88058…` was live 2026-10-16T20:57:45Z → 2026-10-19T20:06:45Z | `render deploys list` |

**Deployed state is not inferred from the current branch** — it comes from the Render deploy list, and the branch/HEAD is used only to measure drift.

### Gap 6 — Non-Render deployment surface · `CLOSED — VERIFIED` (repository)

An exhaustive search of the repository found:

| Searched | Result |
|---|---|
| `.github/workflows/` | **Does not exist** — no CI/CD pipeline |
| Dockerfile / docker-compose / Procfile / Terraform / Kubernetes | **None** anywhere in the tree |
| `*.yml` / `*.yaml` | Only `render.yaml` and `model_capabilities.yaml` |
| Deploy/release/publish scripts | **None** in `scripts/` |
| `package.json` scripts | `build`, `start`, `start:dev`, `dev`, `db:migrate`, `db:seed`, `typecheck`, `test`, `test:watch`, `test:verbose`, `test:ci` — **no deploy or publish script** |

**`render.yaml` is the only deployment manifest in the repository.** The only other way to run the engine is locally (`npm run dev` / `npm start`), which is not a deployment. This substantially bounds the "a non-Render production deployment existed" question.

**Residual limit (stated, not glossed):** a deployment made from an unregistered **copy** of the source, or from a developer's own machine, would not appear in this repository. That residual cannot be closed by repository evidence and stays with Jason and Destiny.

### Gap 18 — Postgres continuity · `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING`

Re-verified read-only at 2026-10-20T14:39Z: `plan = free`, `expiresAt = 2026-11-14T18:10:20.49769Z`, `ipAllowList = []`, `status = available`. The expiry is **exactly 90 days** after `createdAt 2026-10-15T18:10:20.49769Z`, consistent with the free-tier limit. The upgrade plan, `pg_dump` pre-flight, cutover window, validation SQL and rollback steps exist in `docs/release/cst-database-continuity-plan.md`. **No plan, billing, backup or database change was made.** 25 days remain.

### Gap 19 — DNS/TLS · `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED`

Re-verified read-only at 2026-10-20T14:39Z:

| Hostname | DNS | TLS | Application |
|---|---|---|---|
| `cst.bhanetwork.org` | **No A, AAAA or CNAME** — does not resolve | **Cannot be attempted** (no resolution → "Could not resolve host") | n/a |
| `cst-admin.bhanetwork.org` | **No A, AAAA or CNAME** — does not resolve | **Cannot be attempted** | n/a |
| `bha-cst-7u9e.onrender.com` | Resolves | **Valid** — `CN=onrender.com`, issuer Google Trust Services, `SSL certificate verify ok`, HTTP/2, cert 2026-09-21 → 2026-12-20 | `/health` → 200 `{"status":"ok","service":"bha-cst-engine"}` |

**The three failure modes are distinguished:** this is a **DNS failure**, not a certificate failure and not an application failure. `bhanetwork.org` is served by GoDaddy (`ns09/ns10.domaincontrol.com`), so the CNAME must be created there, pointing at `bha-cst-7u9e.onrender.com`; the domain must be added in the Render dashboard first. The Render CLI has **no** custom-domain subcommand (`render services` offers only create/delete/instances/update), and `render services update` must not be used for this. No DNS or certificate setting was touched.

### Gap 20 — Operator Playbook accuracy · `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING`

Re-checked against source this session. The playbook's previously corrected errors remain corrected (adapter path, admin console path, the non-existent `migrate.js --dry-run` flag, the stale test-helpers path, the migration range, the tracker path, the Render admin handle).

> **Correction (2026-10-20T16:20Z).** An earlier revision of this report stated that the `CST_API_KEY` deployment precondition and the boot-time fail-closed behaviour had "now been updated" in the playbook. **They had not** — the edit was described but never made. The claim was not verified against the file before it was written. The playbook has now actually been updated: **§6 Area 5** ("Programmatic Voice Routes Return 503") gives the symptom, the diagnostic command, the remediation and the rationale for not aborting the process, and **§11.1** now carries the "set `CST_API_KEY` before deploying a build containing the guard" precondition with a verification command. Verified by reading the file back after the edit.

**The playbook is still not claimed to be operationally tested** — it has not been published and Destiny's simulation drill has not been run.

---

## 7. Gaps still open, and why

| # | Gap | Status | Why it is not closed |
|---|---|---|---|
| 7 | **Credential rotation** | `NOT STARTED` | **Deliberately not performed.** No rotation record exists in the repository, and the key values were never in the repository, so pre-patch vs current cannot be compared. The production exposure window is bounded by deployment lineage, so rotation is now a **policy decision** for Jason and Destiny — and it should follow the gateway log review, not precede it, because rotation is itself a disclosable event and would break live vFarm integrations. |
| 8 | **vFarm API Gateway historical log** | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | The gateway is outside Render and outside this repository. No access. **The single remaining technical item for 5R0J.** |
| 9 | **HOFE schema-object verification** | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | The DB IP allowlist is empty; direct psql is refused and no bypass was attempted. The ledger says `0 applied, 20 already recorded`, but **a ledger line is a record of intent, not proof the objects exist**. The read-only catalog queries are in §9. |
| 10 | **NI8F live carrier round trip** | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | No approved recipient, no approved window, no explicit dispatch authorization. No provider message ID and no delivery callback exist. |
| 11 | **Staging E2E consent acceptance** | `NOT EVIDENCED` | **There is no staging environment.** Render free tier has no mirror staging database for this service (`docs/release/cst-ho-fe-schema-verification-guide.md:78`). Staging consent E2E was recorded "Not run" on 2026-10-12 (`docs/eod-2026-10-12.md:142,177`), MIG-01 was still open on 2026-10-14 (`docs/eod-2026-10-14.md:163`), and the closure checklist still has the staging migration and staging-log evidence unchecked (`docs/release/cst-closure-checklist.md:24,26`). **This cannot be produced without creating a staging environment.** |
| 12 | **VJU6 authoritative identifier** | `NOT EVIDENCED` | No `VJU6` identifier exists in the repository, its git history, its specs or its documentation. Recorded independently in `docs/vju6-proposed-verification-record.md:4`, `docs/cst-v1-readiness-audit.md:312-316`, `docs/release/cst-production-readiness-audit.md:33` and `docs/eod-2026-10-12.md:189`. **Not invented.** Scope reconstructed from the closest authoritative records: `LOOP-1790985133891-1TEN` / `LOOP-1790691898379-S6Q3` (Dashboard publisher). |
| 13 | **Live Dashboard ingestion** | `NOT EVIDENCED` | The 6 `dashboard_real_proof.test.ts` tests are gated behind `REAL_DASHBOARD_PROOF=1` and have **never been run**. The claim at `docs/cst-pilot-checklist.md:35` ("Verified live against `https://dashboard.bhanetwork.org` — HTTP 200 with row insertion confirmed") records **no date, no harness and no literal response**, so it is not reproducible evidence. **A working publisher and a successful dry run do not prove production ingestion.** |
| 14 | **Dashboard publish-failure durability** | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` | **Closed locally.** New migration `020_dashboard_publish_outcomes.sql` creates a durable outcome table (one row per publish attempt, TTL-bounded, indexed for the dead-letter view). `DbClient` gains `recordDashboardPublishOutcome`, `getUnpublishedDashboardOutcomes`, `getAllDashboardPublishOutcomes` and `markDashboardOutcomeReplayed`. Every publisher path now records an outcome — 2xx, non-retryable 4xx, exhausted retries, missing configuration, dry-run success and dry-run validation failure. The stored payload is **masked** (phone numbers replaced, size-bounded) so the evidence table cannot become an unbounded store of customer content. `replayUnpublishedDashboardEvents()` re-sends dead-lettered events and clears them on success. 11 new tests in `tests/publishers/dashboard_publish_outcomes.test.ts`. **Not yet applied to production** — migration 020 runs on the next authorised deploy. The **monotonic delivery guard is still an in-memory `Map`** (`engine/src/publishers/delivery.ts:53`), so it is still lost on restart; making it durable would need a schema change to the delivery table and is separate work. |
| 15 | **Live voice call acceptance** | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | The previous attempt was refused **at call creation** with Twilio `21210` (unverified From number). It is a **rejected call-creation attempt, not a completed call** — no Call SID, no transcript, no two-way speech. The `12300` content-type fix is live, but no production voice traffic has been observed. |
| 16 | **SMS delivery delay root cause** | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | CST-side causes are ruled out by code: the outbound worker polls every **5 s** (`engine/src/server.ts:48`) and in-process retry backoff is **2–4 s** (`engine/src/transport/twilio/outbound.ts`). Neither produces ~40 minutes, so **the cause is not asserted**. Production queue evidence is required — see the read-only queries in §9. |
| 17 | **KMG9 external acceptance** | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` | Local regression is 9/9, but that is CST-side isolation only. Upstream enforcement by the BHARAG cluster key is unproven. The 5-case environment matrix (staging up/down, production up/down, cross-tenant refusal) and the 3 key-scope artifacts are still outstanding. |
| 21 | **Client 2 working session** | `NOT EVIDENCED` | No record anywhere in the repository that the 2026-10-20 session was held. The date passing is not evidence. |

### 7.1 PII masking — customer numbers closed, service numbers deliberately kept

**Closed (customer identifiers):** every `SECURITY_LEDGER` `actor` field and every
operational log that carried a **caller's or recipient's** number is now masked —
`engine/src/interfaces/voice/index.ts` (voice `actor` fields and the guest
reason), `engine/src/transport/voice/voice_lane.ts` (`actor`),
`engine/src/interfaces/sms/index.ts` (SMS sender `actor`),
`engine/src/consent/service.ts` (all audit reasons, returned reasons, keyword
logs and thrown messages), `engine/src/identity/resolver.ts` (lines 96, 127, 201),
`engine/src/adapters/vfarm/index.ts` (line 815), `engine/src/admin/routes.ts`
(line 645) and `engine/src/db/client.ts` (line 1034).

**Deliberately kept unmasked (CST-owned service numbers):** a service number is
the number CST owns and publishes to customers, so it is operationally necessary
in a tenancy audit record and is not a customer identifier. The affected sites
are `engine/src/transport/voice/voice_lane.ts` (audit reasons carrying the
*receiving* service number), `engine/src/core/registry.ts` (service-number
binding logs) and `engine/src/systems/registry.ts`. This is a stated policy
decision, not an oversight — it is recorded in `engine/src/util/privacy.ts`.

---

## 8. External owners and exact actions required

### 8.1 vFarm / BHARAG gateway log owner — the single remaining 5R0J technical item

**Provide, over 2026-09-25 → present:**

| # | Artifact | Form |
|---|---|---|
| 1 | Access log for the CST service client (e.g. `service_client:"cst-engine"`) | Log rows |
| 2 | Every request made with the CST farm key or admin JWT — source IP, timestamp, endpoint, and the farm id / unit id touched | Farm identifiers masked |
| 3 | **Key issuance records for `POST /api/v1/tokens`** — the precise audit action already specified in `docs/cst-pilot-checklist.md:107`: *"check the vFarm API key issuance records (`POST /api/v1/tokens` on the vFarm API) for any keys issued between 2026-09-25 and 2026-10-07. If any are found that were not initiated by a known CST admin, rotate those farm keys and the CST admin JWT."* | Issuance log, 2026-09-25 → 2026-10-07 |
| 4 | A statement of the farm key's and admin JWT's issuance and rotation history | Text |

**Why this cannot be substituted:** the gateway recorded what CST's credentials actually *retrieved*. Render's logs record CST's *inbound* requests. A pre-patch anonymous caller would have caused a gateway read that no legitimate CST session accounts for.

### 8.2 Jason

| # | Action | Unblocks |
|---|---|---|
| 1 | **Set `CST_API_KEY` in Render** — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Must be done before the guard is deployed.** | Gaps 1, 2 |
| 2 | Authorize deployment of the voice-guard build (and decide whether the Twilio-status signature change goes in the same deploy) | Gap 1 |
| 3 | Provide DB read access (allowlist entry or a bastion), or have an operator run the §9.1 queries | Gap 9, and the voice-pointer confirmation |
| 4 | Decide `DW-1791829227726-96O8` — does verified **production** schema evidence satisfy HOFE, or must a staging database be created? | Gaps 9, 11 |
| 5 | Provide a **verified** Twilio From number, a reachable handset, and written authorization for exactly one call | Gap 15 |
| 6 | Provide an approved SMS recipient, an approved window, and explicit dispatch authorization | Gap 10, 16 |
| 7 | Approve the Postgres Starter tier and name a window, before **2026-11-14T18:10:20Z** | Gap 18 |
| 8 | Add the custom domain in the Render dashboard; create the CNAME at GoDaddy → `bha-cst-7u9e.onrender.com` | Gap 19 |
| 9 | Supply the authoritative `VJU6` identifier | Gap 12 |
| 10 | Approve a Dashboard test environment for `REAL_DASHBOARD_PROOF=1`, **or** produce the original live-ingestion run record behind `docs/cst-pilot-checklist.md:35` (date, harness, literal response) | Gap 13 |
| 11 | Confirm in one line that no non-Render CST deployment existed 2026-09-25 → 2026-10-07 (repository evidence bounds this; the confirmation closes the residual) | Gap 6 |
| 12 | Introduce the Client 2 contact | Gap 21 |

### 8.3 Destiny

| # | Action | Unblocks |
|---|---|---|
| 1 | Formal accept/reject of `LOOP-1790790007707-5R0J`, with reasoning | Gap 4/8 |
| 2 | Decide whether the deployment-lineage evidence is accepted in place of the unreachable Render log window, or whether someone with Log Explorer access searches further back | Gap 8 |
| 3 | Decide on **credential rotation**, after the gateway log review | Gap 7 |
| 4 | Publish the Operator Playbook to Codex → SOPs and BHARAG `sop/bays-cst-operations`; schedule the unannounced blocker-triage drill | Gap 20 |
| 5 | Confirm the status of `DW-1791851358695-JU0D` and `DW-1792157614347-IPAR` (not present in repository records) | Tracker hygiene |

### 8.4 Jegan / BHARAG key owner

| # | Action | Unblocks |
|---|---|---|
| 1 | **Negative test** — the CST cluster key cannot retrieve a known farm-specific sensor/alert/vision record (expect denial or empty scope, not a generic answer) | Gap 17 |
| 2 | **Positive test** — permitted general-help content remains reachable through the same key | Gap 17 |
| 3 | **Policy / workspace / index scope proof** showing upstream *enforcement*, not an optional request field | Gap 17 |

### 8.5 Dashboard owner

| # | Action | Unblocks |
|---|---|---|
| 1 | Provide an approved test environment and credentials for `REAL_DASHBOARD_PROOF=1`, or the original live-ingestion run record | Gap 13 |
| 2 | Confirm what the Dashboard consumes from `cst.turn` / `cst.delivery` and what it retains, so the evidence contract can be specified | Gap 13 |
| 3 | Advise whether dashboard publish failures need a durable dead-letter path (gap 14) | Gap 14 |

---

## 9. Approval and authorization requirements

| # | Approval | Action | Risk if approved | Risk if not approved | Owner | Needed before |
|---|---|---|---|---|---|---|
| A1 | `CST_API_KEY` provisioning | Generate a 32-byte hex secret, set it in the Render dashboard, and store it in the 1Password vault | Low — a new secret, no existing credential rotated | **The five programmatic voice routes stay open** | Jason / Platform | The guard deploy |
| A2 | Deploy the voice-guard build | Push to `main` (Render `autoDeploy: yes` on commit → an immediate production deploy and migration run) | Low — one guarded route group and one signature check; migrations run but 019 is already applied | The exposure stays open | Jason | — |
| A3 | DB read access | Add Ahad's IP to the allowlist, or run the §9.1 queries on a bastion | Low — read-only `SELECT` only | HOFE stays open; the SMS delay and the voice pointer stay unconfirmed | Jason / Platform | — |
| A4 | Postgres Starter upgrade | Change the plan to Starter | $7/mo; a 5–10 minute cutover with a `pg_dump` pre-flight and rollback steps | **The production database is deleted on 2026-11-14T18:10:20Z** | Jason | **25 days** |
| A5 | One live voice call | Supply a verified number + handset; authorize one call | One call; a `voice_deliveries` row; a transcript | Voice acceptance stays open | Jason | — |
| A6 | One live SMS | Supply an approved recipient + window; authorize one dispatch | One message; a `messages_out` row; a delivery callback | NI8F and A2P carrier evidence stay open | Jason | — |
| A7 | Dashboard live proof | Approve an environment and `REAL_DASHBOARD_PROOF=1` | 3 events sent to a live Dashboard | Dashboard ingestion stays unproven | Jason + Dashboard owner | — |
| A8 | DNS/TLS | Add the custom domain in Render; create the GoDaddy CNAME | Low | The two CST hostnames stay dead | Jason / Platform | Before the 31 Oct launch |

**Rollback for A2** (the only code deploy): Render dashboard → the previous deploy → "Rollback to this deploy". The guard is additive — reverting the commit restores the previous route behaviour exactly. Migrations are forward-only; 019 is already applied and the guard adds no migration, so **no schema rollback is needed for this change**.

**Rollback for A4** is documented in `docs/release/cst-database-continuity-plan.md` (pre-flight dump, cutover, validation SQL, rollback steps).

---

## 10. Rollback considerations

| Change | Rollback | Data impact |
|---|---|---|
| Programmatic voice guard | Revert `voice_router.ts` + `interfaces/voice/index.ts` to the previous commit, or redeploy the previous Render deploy | **None** — no migration, no schema change, no data written by the guard |
| Twilio status signature check | Remove `guard` from the `statusRoutes` array | None. Twilio signs its callbacks, so this is forward-compatible |
| `CST_API_KEY` boot check | Remove the call in `server.ts` | None |
| PII masking | Revert the `maskPhone(...)` wrappers | None — log output only. Note: masked log output is **not** reversible; historical unmasked entries remain in the log store |
| Shared `maskPhone` util | Restore the local helper in `admin/routes.ts` | None |
| Test changes | Revert the test files | None |
| Documentation | Revert | None |

**Not deployed, therefore nothing to roll back in production.** The working tree holds all changes.

---

## 11. Production actions explicitly NOT performed

| Action | Status |
|---|---|
| Commit, push, merge, rebase, branch switch, history rewrite | **NOT PERFORMED.** HEAD remains `b06c68f`; all changes are uncommitted in the working tree. |
| Deploy, restart, or trigger a Render deployment | **NOT PERFORMED.** `render deploys` was read-only. |
| Change Render configuration, environment variables, secrets | **NOT PERFORMED.** `CST_API_KEY` was **not** set in Render. |
| Run a remote migration or any production SQL | **NOT PERFORMED.** The DB IP allowlist is empty; no bypass was attempted. |
| Change the database plan, billing, or backup configuration | **NOT PERFORMED.** |
| Rotate credentials | **NOT PERFORMED** — deliberately, and recorded as `NOT STARTED`. |
| Change DNS or certificates | **NOT PERFORMED.** |
| Initiate a real call or send an SMS | **NOT PERFORMED.** The outbound queue was never triggered manually. |
| Run `REAL_DASHBOARD_PROOF=1` or the 6 live-Dashboard proof tests | **NOT PERFORMED.** They remain skipped. |
| Post to Slack or close any watch | **NOT PERFORMED.** Drafts only. |
| Modify the vFarm application or its data | **NOT PERFORMED.** |
| Discard or reset any pre-existing modification | **NOT PERFORMED.** All pre-existing work is preserved. |

---

## 12. Copy-ready Slack update draft

> **DRAFT — NOT SENT.** Prepared for Jason, Destiny and Bays. No Slack message was posted and no decision watch was closed.

Hi Jason, Destiny — closing out the CST gaps from the readiness audit. Everything is in `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md`, with `docs/task.md` as the canonical ledger. No commits, deploys, config changes, migrations, rotations, calls or SMS were made.

**First, a correction to my own previous message.** I said the programmatic voice API fix was complete across three routes. **It was incomplete.** A full route inventory of the engine found **two more** unauthenticated programmatic voice routes I had missed, because they live in a different router:

- `POST /voice/turn` — the *same* caller-asserted-`from_e164` impersonation path as `/api/v1/voice/turn`, so an anonymous caller could have asserted a known vFarm member's number and received that member's farm-scoped answer.
- `POST /audio/speak` — let the caller pick the `voiceId` outright, so anyone could have synthesized arbitrary text with an arbitrary voice at our quota.

Both are now behind the same fail-closed guard as the other three, with 21 focused tests. The complete programmatic surface is five routes; the Twilio-hosted ones stay on signature verification and the two mechanisms are never mixed.

**Also closed this session.** The guard was failing closed but *silently* — a deployment that forgot the secret would have looked healthy. It now reports the gap once at boot and writes a `SECURITY_LEDGER` entry. I deliberately did **not** make it abort the process: aborting would take the signed Twilio webhooks, the health endpoints and the outbound worker down with it, so a misconfigured secret becomes a closed door on five routes rather than a total outage. Separately, the consent refusal records were carrying the **full recipient phone number** into retained audit records — exactly the entries an auditor reads to justify a blocked message. Those are now masked to the last four digits, and the pre-existing helper in the admin console masked only *one* character, so I replaced it with a shared one.

**5R0J.** Reconstructed the route table directly from source rather than from a report: `/api/devices` and `/api/dashboard` (plus `/api/v1` aliases) sit behind `requireVfarmAdminSession`, `/api/farms` and `/api/tokens` behind `requireVfarmAdminSessionOrJwt`. **No route substitutes an administrative vFarm JWT when caller authentication fails** — the two modes are distinct, and a caller JWT is forwarded verbatim or refused. The deployed SHA is `b06c68f`, matching HEAD, zero drift, confirmed from the Render deploy list rather than inferred from the branch. The gate was committed 2026-10-07 and the production service was created 2026-10-15, so no production deploy ever ran the unauthenticated code.

One new piece of evidence I can give you: **the repository has no CI workflow, no Dockerfile, no Terraform, no Kubernetes manifest, no Procfile and no deploy script** — `render.yaml` is the only deployment manifest in the tree. That bounds the "was there a non-Render deployment" question much more tightly than an assertion would. The residual is a deployment from an unregistered copy of the source, which only you two can confirm — one line from either of you closes it.

**Still open, and I am not presenting it as closed.** The vFarm API Gateway log is the one thing I cannot reach, and it is the only source that can show whether CST's farm key was ever used to serve tenant data to an unauthorized caller. The precise ask is now written down: the CST service client's access log for 2026-09-25 → present, every read made with the farm key or admin JWT with the farm ids touched, and the **key issuance records for `POST /api/v1/tokens` between 2026-09-25 and 2026-10-07** — the audit `docs/cst-pilot-checklist.md:107` already specifies. Recent Render logs showing no matching requests say nothing about that window, and I am not claiming they do. Rotation is recorded as **not performed**: there is no rotation record, the key values were never in the repository, and rotation is itself a disclosable event — so it should follow the gateway log, not precede it.

**HOFE / NI8F.** The three consent migrations are confirmed on disk with their constraints, tenant scoping, FK, append-only trigger, active-prompt uniqueness and timestamp triggers; `canSendSms` is tenant- and project-scoped and fails closed for both opt-out and no-record. 38/38 local. **`STAGING E2E ACCEPTANCE: NOT EVIDENCED`** — there is no staging environment for this service, so staging E2E cannot be produced without creating one; that is a decision for you, not something I can assert my way past. The production ledger says `0 applied, 20 already recorded`, and I am treating that as a record of intent, not proof the objects exist: the read-only catalog queries are written out and need either my IP added to the allowlist or one operator to run them.

**VJU6.** The authoritative identifier still does not exist anywhere in the repository — recorded independently since 12 Oct, and I am not inventing one. The closest authoritative records for that scope are `LOOP-1790985133891-1TEN` / `LOOP-1790691898379-S6Q3`, the Dashboard publisher. **`LIVE DASHBOARD INGESTION: NOT EVIDENCED`**: the six proof tests have never been run, and the "verified live against dashboard.bhanetwork.org" claim in the pilot checklist has no date, harness or literal response behind it, so it is not reproducible. A working publisher and a successful dry run do not prove production ingestion. I also found a new gap while checking this: a failed dashboard publish is **logged but not persisted**, there is no dashboard dead-letter table in any of the 19 migrations, so there is no replay path — and the monotonic delivery guard is an in-memory map that a restart loses. That needs a migration, so I have documented it rather than started it.

**Tests.** Baseline was 628 passed / 6 skipped / 0 failed. This session: programmatic voice auth **21/21**, voice **94/94**, consent **38/38**, KMG9 **9/9**, dashboard dry-run + e2e **24/24**, privacy **6/6**, full suite **645 passed / 6 skipped / 0 failed across 63 files**, typecheck clean, build clean, `git diff --check` clean. The six live-Dashboard tests remain skipped. Seven failures occurred during the work — including one that was **correct behaviour** (a 403 from the authorization chain because the test had not onboarded a speaker) — and every one is listed in §5.1 of the report rather than hidden behind the green run.

**Decisions I need:**

| # | Ask | Owner |
|---|---|---|
| 1 | Set `CST_API_KEY` in Render — **before** the guard is deployed, or those five routes stay open (or closed, depending on order) | Jason / Platform |
| 2 | Authorize the guard deploy, and confirm the Twilio-status signature change ships with it | Jason |
| 3 | vFarm gateway logs + `POST /api/v1/tokens` key issuance records, 2026-09-25 → present | vFarm / BHARAG owner |
| 4 | 5R0J accept/reject; lineage-vs-Log-Explorer decision; rotation decision | Destiny |
| 5 | DB read access, or one operator running the read-only queries | Jason / Platform |
| 6 | `DW-96O8` — production schema evidence, or stand up staging | Jason |
| 7 | Verified Twilio number + handset + authorization for one call | Jason |
| 8 | Approved SMS recipient + window + dispatch authorization | Jason |
| 9 | Postgres Starter approval — **the free tier expires 2026-11-14T18:10:20Z, 25 days** | Jason |
| 10 | Custom domain in Render + CNAME at GoDaddy for the two CST hostnames (neither resolves today) | Jason / Platform |
| 11 | Authoritative `VJU6` ID; Dashboard test environment, or the original live-ingestion run record | Jason + Dashboard owner |
| 12 | One line: no non-Render CST deployment existed 2026-09-25 → 2026-10-07 | Jason / Destiny |
| 13 | BHARAG key-scope negative + positive + policy proof | Jegan |
| 14 | Client 2 contact introduction | Jason |

**Nearest hard deadline is still 14 November.** The upgrade plan, dump, cutover, validation SQL and rollback steps are written; only approval and a window are missing.

**And to be explicit: CST is not production-ready.** Voice has never completed a call, SMS has never completed a carrier round trip, production schema objects are unverified, Dashboard ingestion is unproven, the custom domains do not resolve, and the guard that closes the voice exposure is not yet deployed. The code is complete and locally verified; what remains is deployment, access, and sign-off.

---

## 13. Supporting repository evidence

| Evidence | Path |
|---|---|
| Canonical task/evidence ledger | `docs/task.md` (mirror `docs/release/task.md`) |
| This report | `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` |
| Four-deliverable readiness evidence | `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md` |
| Master audit | `docs/release/CST_MASTER_TASK_AUDIT.md` |
| 5R0J security audit + sign-off criteria | `docs/release/cst-5r0j-security-audit-and-residual-risk.md` |
| Per-owner approval drafts + operator queries | `docs/release/cst-approval-requests.md` |
| Combined Slack draft (not sent) | `docs/release/cst-readiness-slack-reply.md` |
| Operator Playbook (12 sections) | `docs/release/operator-playbook-sop.md` |
| HOFE schema guide + `DW-96O8` argument | `docs/release/cst-ho-fe-schema-verification-guide.md` |
| DB continuity plan | `docs/release/cst-database-continuity-plan.md` |
| KMG9 verification record | `docs/kmg9-verification-record.md` |
| Pilot checklist — authoritative loop-ID mapping + key-issuance audit | `docs/cst-pilot-checklist.md:34-36,107` |
| Staging-E2E "not run" records | `docs/eod-2026-10-12.md:142,177` · `docs/eod-2026-10-14.md:163` · `docs/release/cst-closure-checklist.md:24,26` |
| **Programmatic API guard (new)** | `engine/src/middleware/programmatic_api_key.ts` |
| **Privacy helper (new)** | `engine/src/util/privacy.ts` |
| **Programmatic voice auth tests (new)** | `tests/security/programmatic_voice_auth.test.ts` |
| **PII masking tests (new)** | `tests/privacy/log_masking.test.ts` |
| 5R0J auth middleware | `engine/src/middleware/vfarm_proxy_auth.ts` |
| Route registration | `engine/src/app.ts` |
| Voice interface / voice router | `engine/src/interfaces/voice/index.ts` · `engine/src/transport/voice/voice_router.ts` |
| Consent service | `engine/src/consent/service.ts` |
| Dispatch-time enforcement | `engine/src/transport/twilio/outbound.ts` |
| Consent migrations | `db/migrations/016_sms_consent_spine.sql` · `017_sms_consent_audit_fk.sql` · `018_sms_consent_prompts.sql` |
| Dashboard publisher + delivery guard | `engine/src/publishers/dashboard.ts` · `engine/src/publishers/delivery.ts` |
| Gated live-Dashboard proofs | `tests/integration/dashboard_real_proof.test.ts` |
| Deployment manifest (the only one) | `render.yaml` |

---

## 14. Read-only operator queries

All `SELECT` only, no writes, no credentials, no unmasked phone numbers. Run against `bha_cst_1sh0`.

```sql
-- 14.1 Consent spine tables and columns.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('sms_consents', 'sms_consent_audit', 'sms_consent_prompts')
ORDER BY table_name, ordinal_position;

-- 14.2 Constraints: expect fk_sms_consent_audit_consent and unq_sms_consents_id_tenant.
SELECT conname, contype, conrelid::regclass::text AS relation
FROM pg_constraint
WHERE conname IN ('fk_sms_consent_audit_consent', 'unq_sms_consents_id_tenant')
ORDER BY conname;

-- 14.3 Indexes: expect unq_sms_consent_prompts_active and idx_sms_consent_prompts_active_lookup.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('unq_sms_consent_prompts_active', 'idx_sms_consent_prompts_active_lookup')
ORDER BY indexname;

-- 14.4 The append-only trigger on sms_consent_audit.
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definition
FROM pg_trigger
WHERE tgname = 'trg_sms_consent_audit_append_only' AND NOT tgisinternal;

-- 14.5 *** PRE-CALL VOICE POINTER CHECK ***
--      If this returns 'eleven_voice_jason_vfarm' or NULL, the first real voice
--      call will fail at synthesis with SYNTHESIS_FAILED.
SELECT project_id, elevenlabs_voice_id, elevenlabs_model_id, voice_enabled
FROM projects
WHERE project_id = 'proj-vfarm-main';

-- 14.6 Outbound queue diagnostics for the ~40-minute delay.
--      Separates "CST sent late" from "Twilio accepted late" from
--      "carrier delivered late". Phone numbers masked.
SELECT
  left(id, 8) AS message_id,
  right(to_e164, 4) AS to_masked,
  status,
  retry_count,
  created_at,
  next_retry_at,
  sent_at,
  ROUND(EXTRACT(EPOCH FROM (sent_at - created_at)) / 60, 2) AS minutes_to_send,
  left(coalesce(provider_sid, ''), 12) AS provider_sid_prefix,
  left(coalesce(error_message, ''), 160) AS provider_error
FROM messages_out
WHERE sent_at IS NOT NULL
  AND sent_at - created_at > INTERVAL '10 minutes'
  AND created_at > NOW() - INTERVAL '14 days'
ORDER BY sent_at - created_at DESC;

-- 14.7 Status distribution over the window.
SELECT status, count(*) AS n, min(created_at) AS oldest, max(created_at) AS newest,
       count(DISTINCT left(coalesce(error_message, ''), 60)) AS distinct_errors
FROM messages_out
WHERE created_at > NOW() - INTERVAL '14 days'
GROUP BY status ORDER BY n DESC;
```

---

*Prepared 2026-10-20 by Ahad (`U0AC6RFNP3P`). Uncommitted. No production change, commit, push, deploy, migration, rotation, real call, SMS or Slack post was performed. No secrets, raw authentication headers, customer PII or unmasked phone numbers are included.*

---

## 11. Session 2026-10-21 — durable per-customer identity mapping and the AlertAuditLog foreign-key defect

**Scope:** close the identity-mapping gaps for *every* legitimate customer (not one test account), and investigate the `AlertAuditLog` foreign-key failure seen in the production log. **Local only: nothing committed, pushed, merged, deployed, or changed in production.**

### 11.1 Two fail-open paths found in the identity resolution

The authoritative upstream check is gated by two conditions that were both silently satisfiable:

```ts
// engine/src/adapters/vfarm/index.ts — resolveSpeaker()
if (this.httpClient) {                       // (A) no live client  -> check skipped
  const orgId = this._getProjectOrgId(projectId);
  if (orgId) {                                // (B) no vFarm org id -> check skipped
    ... membership check + authoritative grant override ...
  }
}
// falls through: the LOCAL record is trusted, including its locally-recorded farm_ids
```

| # | Fail-open path | Consequence | Fix |
|---|---|---|---|
| **A** | The adapter has **no live vFarm client** (no `baseUrl` configured) | The organisation-membership check and the authoritative farm-grant override never run. The local `customers` projection is trusted as if it were authoritative — a stale grant would still grant farm scope. | In **production**, a missing live client now **fails closed** (`opaque_revoked`) with an error log. The no-client path is retained for dev/test, where there is no upstream to consult. |
| **B** | The project has **no `tenant_org_id`** | Same: the membership check cannot be performed for that project, and the local record was trusted. A dynamically registered project, or a row predating the G19 org-id fix, could authorise anyone. | In live mode, a project with no vFarm organisation id now **fails closed** (`opaque_revoked`) with a warning. |

Both are now fail-closed, and both are covered by regression tests. Neither weakens an existing control; each converts a silent fail-open into an explicit refusal.

### 11.2 The `AlertAuditLog` foreign-key defect — root cause and fix

**Production evidence (read-only, current log window):** `alert_audit_log_outbound_message_id_fkey` ×4, `AlertAuditLog.write failed` ×2, with the failing identifier `CAea9e42…` — a **Twilio Call SID**.

**Root cause:** `alert_audit_log.outbound_message_id` is `NOT NULL REFERENCES messages_out(id) ON DELETE CASCADE` — the table models **one audit row per outbound SMS message**. Two call sites used it for **voice**:

| Call site | Identifier passed | A `messages_out` row? |
|---|---|---|
| `transport/twilio/outbound.ts` (SMS) | `msg.id` | ✔ yes — correct |
| `transport/voice/voice_lane.ts:361` | `outboundMessage.id` | ✔ yes — correct (a real SMS is sent) |
| `transport/voice/voice_lane.ts` (`/audio/speak`) | `speak_<uuid>` — **fabricated** | ✘ never persisted → FK violation |
| `interfaces/voice/index.ts` (the voice turn) | the `correlation_id` — a **Call SID** in the webhook path | ✘ never persisted → FK violation |

So the voice lane was writing a *voice* turn into the *SMS* audit table with a non-existent reference. The write always failed, so **no alert-audit row was ever stored for a voice turn** — the error log was the only symptom.

**Fix (code-only, no migration):** the two offending call sites no longer write to the SMS alert-audit table. The reason is recorded in the code at both sites: a voice turn is not an outbound SMS message and produces no `messages_out` row, so there is nothing valid to reference, and inventing a `messages_out` row to satisfy the FK would fabricate a message that was never sent.

**No auditability is lost.** The voice turn was already recorded, in the stores that actually model it: the `voice_deliveries` row (status, voice_id, model_id, character_count, audio_bytes, mime_type, correlation_id), the conversation transcript row (the rendered reply text, project, tenant, direction) and the structured `Logger.audit` entry. The FK keeps its meaning — *one audit row per outbound SMS message* — and is asserted by a test so it cannot be quietly dropped.

### 11.3 Identity mapping for every customer

| Requirement | Where it is satisfied | Evidence |
|---|---|---|
| Durable source of truth | `CoreRegistry.initFromDb()` rehydrates the adapter's phone → identity directory from the `customers` table, using the project's own E.164 matching and the project-scoped key | `engine/src/core/registry.ts` |
| Survives restart / adapter reconstruction | The rehydration runs **after** the default-seed step, so the durable record always wins over a seed; the adapter rebuilt during boot is rehydrated too | new test file, "keeps every mapping across an application restart" |
| Missing / duplicate / stale / conflicting records | Missing `project_id` → skipped with a warning. Project belonging to another tenant → skipped (tenant isolation). Two references for one (project, phone) → **neither** is bound. A legacy tenant-scoped row never shadows a project-scoped one | new test file, 4 cases |
| No seeded identity in real resolution | The demo seed is behind an explicit `seedDemoDirectory` flag, off by default outside production; a missing mapping never falls back to a seed | new test file, 2 cases |
| Authoritative authorization | The live organisation-membership check and the authoritative farm-grant list still run on **every** resolve; a revoked member yields `opaque_revoked` with zero farm scope, even when the durable record and the upstream grant list both still name a farm | new test file, 2 cases |
| Cache invalidation | 60 s TTL cache, with per-tenant/project invalidation wired to the admin endpoint; invalidation forces a live re-resolve, so a revoke is not masked by the cache | new test file, 1 case |
| Cross-channel consistency | SMS (`interfaces/sms/index.ts`), voice (`interfaces/voice/index.ts`), web (`interfaces/web/index.ts`) and the standalone resolver all call `CoreRegistry.resolveSpeaker` | new test file, 1 case |

**No new migration was required.** The `customers` schema already carries `project_id`, `customer_ref`, `role` and `farm_ids`; migration 012 already established project-scoped uniqueness (`unq_customers_tenant_project_phone`), and `DbClient.updateCustomer` already narrows strictly by project.

### 11.4 Test evidence — 2026-10-21T11:57Z

| Command | Exit | Result |
|---|---|---|
| `npx vitest run tests/identity/` | 0 | 90 passed (90) |
| `npx vitest run tests/security/` | 0 | 47 passed (47) |
| `npx vitest run tests/voice/` | 0 | 118 passed (118) |
| `npx vitest run tests/consent/` | 0 | 38 passed (38) |
| `npx vitest run tests/adapters/` | 0 | 66 passed (66) |
| `npx vitest run tests/audit/` | 0 | 4 passed (4) |
| `npx vitest run tests/admin/` | 0 | 45 passed (45) |
| `npx vitest run tests/tenancy/` | 0 | 25 passed (25) |
| **`npm test`** | 0 | **748 passed \| 6 skipped (754), 0 failed**, 63 files, 13 s |
| `npm run typecheck` | 0 | 0 errors |
| `npm run build` | 0 | clean |
| `git diff --check` | 0 | clean |

**Baseline for comparison:** 733 passed / 6 skipped (739) → **748 / 754** (+15 new tests, 1 new file). The prior checkpoint's numbers are not proof of the current tree; every figure above is from this session's run.

**One real defect in my own new test, found and fixed:** the first version stubbed a *per-instance* vFarm client, which the boot-time rehydration discards — so the authoritative path was never exercised and the revoke case wrongly passed. The stub was moved to the `VfarmHttpClient` **prototype**, so the adapter that `initFromDb()` builds is the one under test. The suite has a documented history of order-dependent flakiness under parallel execution (a pure-HEAD export fails ~3 of 6 parallel runs, in a different file each time); the stable path is `npx vitest run --no-file-parallelism`.

### 11.5 Render evidence (read-only)

| Check | Result |
|---|---|
| Deployed commit | **`63a221964506a0cb6163cda7ee8fa7ed7c2ac0e1a`** (deploy `dep-dbbrodpsrm7s73fb6sl0`, finished 2026-10-20T19:09:24Z) — **the fixes in this report are NOT deployed** |
| Service health | `GET /health` → 200 `{"status":"ok","service":"bha-cst-engine"}` |
| `CST_API_KEY` | **NOT configured.** The engine's own boot check reports it missing on every boot. The value was never printed, and the Render API does not expose environment variable names to this tooling. The five programmatic voice routes are therefore **closed with 503** in production today. |
| Identity failures in the current log window | `opaque_revoked` ×23, `opaque_unresolved` ×0, `not granted any active farm resources` ×2 |
| Audit-log failures in the current log window | `alert_audit_log_outbound_message_id_fkey` ×4, `AlertAuditLog.write failed` ×2 |
| Database | IP allowlist empty — **not bypassed**; the production `customers` row could not be read from here |

### 11.6 Lane classification and engine/twin status

**Primary lane: CST identity/tenancy infrastructure.** The work is the CST customer-identity resolution path, the durable customer registry, and the tenant/project authorisation boundary.

**Engine/twin status: engine-facing prerequisite, NOT a completed BHA engine integration.** The mechanism by which authorised identity and scope reach the CST engine is:

1. An inbound caller (SMS, voice or web) presents a number.
2. The receiving number resolves to a tenant/project through the `service_number_bindings` registry — a **number** identifies the *system*.
3. The caller's number resolves to a *customer* through the durable `customers` record, and that record's `customer_ref` is the **vFarm user id**.
4. The adapter re-verifies that id against the **live vFarm organisation-members list** and replaces the farm scope with the **authoritative vFarm farm-grant list**.
5. Only then is the identity handed to `CoreEngine.processEnvelope`, which applies the farm-scope gate, so the engine sees `speaker.farm_ids` it may act on.

**What is explicitly not true:** this data is **not** wired into Slack Genie's ledger, the Monitoring Twin, or any other BHA engine surface. The authoritative identity and farm scope reach the **CST engine** and the **CST audit/verification plane** only. Any claim of a completed BHA engine integration would be unsupported.

### 11.7 Tracked decision item (existing ID — nothing was created)

| Field | Value |
|---|---|
| **ID** | `LOOP-1792186179087-EWQI` (existing voice + KMG9 acceptance watch). **No new card was created.** |
| **Decision required** | Whether vFarm gains a **phone field / phone→user binding** (an upstream product change), or CST permanently owns the phone→`customer_ref` binding and vFarm owns only organisation membership, role and farm grants. |
| **Why it is a decision, not a bug** | vFarm's user model has **no phone field** and no endpoint accepts one, and there is **no user→zone/location/device binding**. CST can therefore never bind a caller to a *unit*, so **live telemetry** cannot be served, and the phone binding can never be validated upstream. |
| **Options** | (a) vFarm adds a phone field to the user record plus a user→location binding; (b) CST keeps the phone binding and vFarm adds only a user→location binding; (c) live telemetry stays out of scope and CST serves farm-scoped knowledge only. |
| **Accountable owner** | vFarm product owner (the CST owner cannot change the upstream contract) |
| **Deadline** | Before the 31 October 2026 launch target, for option (a)/(b); option (c) needs no deadline |
| **Interim** | CST is not blocked: with the identity fix deployed, a registered caller resolves to their real vFarm identity with the authorised farm scope, and farm-scoped knowledge questions are answered with farm-specific content. Only live *telemetry* is blocked, and it answers honestly ("your phone number is not linked to an active vFarm unit") rather than with a generic message. |

**No other new commercial decision was identified** in this session.

### 11.8 Gap status for this session

| Gap | Status |
|---|---|
| Programmatic voice API authentication (5 routes) | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` (deploy + `CST_API_KEY`) |
| Programmatic API guard startup behaviour | `CLOSED — VERIFIED` |
| Customer phone numbers in retained audit records | `CLOSED — VERIFIED` |
| Live mode without a vFarm client trusts the local record | `CLOSED — VERIFIED` |
| Live mode without a project vFarm org id trusts the local record | `CLOSED — VERIFIED` |
| `AlertAuditLog` foreign-key failure (voice → SMS audit table) | `CLOSED — VERIFIED` |
| Durable per-customer mapping for all customers | `CODE COMPLETE — EXTERNAL ACCEPTANCE PENDING` (deploy) |
| vFarm user→unit/location contract | `NOT VERIFIED` — missing upstream interface, tracked on `LOOP-1792186179087-EWQI` |
| 5R0J historical gateway log | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` |
| Production `customers` row confirmation | `BLOCKED — EXTERNAL OWNER/AUTHORIZATION REQUIRED` (DB allowlist empty) |

---

## 12. Session 2026-10-21T12:07Z — final gap-closure sprint

**Local only. Nothing committed, pushed, merged, deployed, or changed in production.**

### 12.1 Baseline (verified, not assumed)

| Fact | Value |
|---|---|
| Branch / HEAD | `fix/cst-identity-resolution-farm-access` / `1fb7697` |
| Working tree | 8 modified + 2 untracked, **nothing staged** |
| Deployed commit | **`63a2219`** (deploy `dep-dbbrodpsrm7s73fb6sl0`, finished 2026-10-20T19:09:24Z) |
| Local fixes in the deployed SHA | **absent** — live-client guard 0, rehydration 0, and the mis-placed voice alert write **still present** (1) |
| `/health` | 200 `{"status":"ok","service":"bha-cst-engine"}` |
| `CST_API_KEY` | **not configured** — all five programmatic voice routes return **503 `CONFIG_MISSING`** in production today (verified by live POST to each) |
| Production log window | `opaque_revoked` ×23, `opaque_unresolved` ×0, `alert_audit_log_outbound_message_id_fkey` ×4, `AlertAuditLog.write failed` ×2 |

### 12.2 New gap found and closed — the voice-lane path had no deadline

The bounded deadline was implemented on the **voice-interface** path only. `VoiceLaneService.processVoiceTurn` — behind `POST /voice/turn` and `POST /audio/speak` — had **no deadline at all**. Today those routes 503 (the guard), so the gap is latent; but it becomes live **the moment `CST_API_KEY` is set**, which is the very next operator action.

**Fix:** the deadline was extracted into `engine/src/transport/voice/turn_deadline.ts` — a leaf module, so it can be shared by both implementations without a cycle — and both paths now use it. The voice-lane synthesis is abortable, and an aborted synthesis records **no** `voice_deliveries` row, so a timeout cannot leave a false "delivered" record.

### 12.3 The voice audit trail — verified complete, not merely de-errored

The two voice call sites that wrote into the **SMS** `alert_audit_log` table (FK → `messages_out(id)`) were removed. The model is now coherent, and the distinction is the point:

| Path | Creates a `messages_out` row? | Alert-audit write |
|---|---|---|
| SMS outbound (`transport/twilio/outbound.ts`) | ✔ yes | ✔ valid — **kept** |
| Voice-lane (`transport/voice/voice_lane.ts`) — routes through `IntentRouter.routeAndHandle`, which **persists** a `messages_out` row | ✔ yes | ✔ valid — **kept** |
| Voice-interface (`interfaces/voice/index.ts`) — writes a transcript + a `voice_deliveries` row, and **no** `messages_out` row | ✘ no | ✔ **removed** — there was nothing valid to reference |

Acceptance criteria verified: no voice code writes a Call SID or a fabricated id into the SMS FK; a successful turn has a `voice_deliveries` row, a transcript row (with `provider_sid = correlation_id`) and a structured `Logger.audit` entry; a **failed** turn records a `failed` delivery row with `error_code`; an **aborted/timed-out** turn writes no delivery row and no transcript; the FK is still enforced (asserted by a test); and the SMS audit behaviour is untouched. Audit failures are not swallowed — `AlertAuditLog.write` logs at error level, and the timeout is additionally recorded as a correlated `SECURITY_LEDGER` tripwire entry.

### 12.4 Identity resolution — every path audited, no bypass found

| Path | Resolver |
|---|---|
| SMS ingress | `interfaces/sms/index.ts` → `CoreRegistry.resolveSpeaker` |
| Voice ingress / turn | `interfaces/voice/index.ts` (3 sites) → `CoreRegistry.resolveSpeaker` |
| Web session + web message | `interfaces/web/index.ts` (2 sites) → `CoreRegistry.resolveSpeaker` |
| Standalone resolver | `identity/resolver.ts` → `CoreRegistry.resolveSpeaker` |
| Background jobs | **none** resolve identity — no scheduler bypasses the shared resolver |
| Direct reads of the adapter's speaker directory | one, read-only, in the admin route (for the UI) |

### 12.5 Phase 5 items — verification, not rework

| Item | Result |
|---|---|
| **A — 5R0J readiness** | No new gateway evidence exists. The Render log window still shows `opaque_revoked`; the vFarm API Gateway log for the CST client remains the outstanding external artifact. Local code verification and production acceptance are kept distinct in the docs. |
| **B — HOFE / migrations** | 020 and 021 are **applied in production** (`0 applied, 22 already recorded`). The schema/catalog assertions **cannot** be verified here: the DB IP allowlist is empty and was not bypassed. The read-only queries remain prepared for an authorized operator. **No migration was added or re-applied.** |
| **C — Consent (NI8F)** | `tests/consent/` → **38/38**, exit 0. Enforcement is at dispatch time in `transport/twilio/outbound.ts`. The live carrier round trip remains unverified. |
| **D — Voice deadline** | **Both** turn paths now bounded by the shared deadline (12.2). Abort propagation verified: the synthesizer receives the signal, and an abort suppresses the delivery row. Live handset acceptance stays operator-controlled. |
| **E — SMS delay** | The instrumentation exists (queue age via `next_retry_at`, `retry_count`, `provider_sid`, `error_message`, `sent_at`, plus the delivery callback). The **cause remains unproven** — the 5 s poll and 2–4 s backoff are ruled out, and no production queue read was possible. Nothing was triggered. |
| **F — Operator Playbook** | **Updated**: new §6 Area 6 (a registered caller resolves as guest — the four causes and which must not be "fixed") and §6 Area 7 (a voice turn never answers — the shared deadline, abort semantics, and the rule that a voice turn never enters the SMS alert-audit table). Publication and the drill are still **not** evidenced. |
| **G — Client 2 (VU6R)** | **No evidence** of a session or its outcome. Status preserved as unresolved; owner action is Jason introducing the contact. Nothing fabricated. |
| **H — vFarm unit/location contract** | Unchanged. Confirmed again against the live API and the deployed OpenAPI: no user→zone/location/device binding and no phone field exist. The three options and the decision required are restated in §12.7 on the **existing** `LOOP-1792186179087-EWQI`. |

### 12.6 Test evidence — 2026-10-21T12:14Z

| Command | Exit | Result |
|---|---|---|
| `npx vitest run tests/identity/` | 0 | 90 passed (90) |
| `npx vitest run tests/voice/` | 0 | 123 passed (123) |
| `npx vitest run tests/security/` | 0 | 47 passed (47) |
| `npx vitest run tests/consent/` | 0 | 38 passed (38) |
| `npx vitest run tests/admin/` | 0 | 45 passed (45) |
| `npx vitest run tests/tenancy/` | 0 | 25 passed (25) |
| **`npm test`** ×3 (parallel) | 0, 0, 0 | **753 passed \| 6 skipped (759), 0 failed**, 13–18 s each |
| `npx vitest run --no-file-parallelism` | 0 | 753 passed \| 6 skipped (759), 47 s |
| `npm run typecheck` | 0 | 0 errors |
| `npm run build` | 0 | clean |
| `git diff --check` | 0 | clean |

**Baseline:** 748 passed / 6 skipped (754) → **753 / 759** (+5 new tests, +1 new file).

**Failures encountered and preserved:** (1) my refactor removed `VoiceInterface.voiceTurnDeadlineMs()`, breaking the existing deadline test — the test now uses the shared helper. (2) Three admin tests failed once in an isolated admin run and passed in isolation (3/3) and in every full-suite run — the known order-dependent parallel-execution flake of this suite, documented at `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` §5.3. Neither was masked and no unrelated test was modified to manufacture a green result.

### 12.7 Commercial risk — tracked decision items

No new card was created and no ID was invented. All items sit on **existing** IDs.

| # | ID (existing) | Owner | Deadline | Decision required | Options / trade-off | Commercial impact | Evidence to close |
|---|---|---|---|---|---|---|---|
| 1 | `LOOP-1791848474090-Y5TW` (playbook) + the deploy it gates | Jason | Before the next deploy | Configure `CST_API_KEY` in Render **before** the guard build is deployed, and authorise the deploy | (a) set the secret, then deploy — the five programmatic voice routes open for the operator; (b) deploy without it — they stay 503 (closed) while the Twilio webhook lanes and the identity fix still work | Until (a), the programmatic voice API is unavailable in production; a caller on a programmatic path gets no answer | Render dashboard shows the variable present; a live POST to `/api/v1/voice/synthesize` returns 401/403 rather than 503 |
| 2 | `LOOP-1791826143428-HOFE` | Jason / Platform | Before the 31 Oct launch | Grant read access to the production `customers` record (allowlist entry or an operator running the prepared read-only query) | (a) allowlist entry — immediate; (b) bastion/operator run — no network exposure | The customer record behind the identity fix is unverified; a mismatch would be found only at the first call | The query output showing `phone_e164`, `customer_ref`, `role`, `farm_ids` for the number |
| 3 | `LOOP-1792186179087-EWQI` (existing decision) | vFarm product owner | Proposal: before the 31 Oct launch | Whether vFarm gains a **phone field / phone→user binding** and a **user→location binding**, or CST keeps the phone binding and vFarm adds only the location binding, or live telemetry is formally out of scope | (a) vFarm adds phone + location — CST can bind a unit and serve live telemetry; (b) vFarm adds location only — CST keeps the phone binding, telemetry becomes possible; (c) telemetry out of scope — farm-scoped knowledge only, no live sensor answers | Live telemetry cannot be served for any customer until (a) or (b); a customer asking for a sensor reading gets an honest "not linked to an active vFarm unit" rather than an answer | An upstream endpoint or an explicit scope decision |
| 4 | `LOOP-1790790007707-5R0J` (5R0J) | vFarm / BHARAG gateway owner | Proposal: before 5R0J acceptance | Provide the vFarm API Gateway access log for the CST service client, 2026-09-25 → present, with farm ids touched, and the key issuance history | (a) provide the logs — the historical exposure question closes on evidence; (b) accept the deployment-lineage evidence as a substitute — a documented acceptance decision | Until then the 5R0J historical-exposure question cannot be closed by evidence, only by decision | The gateway log extract, or a recorded acceptance of the substitute |
| 5 | `LOOP-1791243473841-02JU` / `LOOP-1792187689082-B0M2` | Jason | Proposal: before the 31 Oct launch | Authorise one voice call and one SMS against a verified number and an approved recipient | (a) authorise — the carrier and handset evidence is produced; (b) defer — voice/SMS acceptance stays open | No live carrier or handset evidence exists; the end-to-end claim cannot be made | Call SID + transcript + provider message ID + delivery callback, with a real handset |
| 6 | `LOOP-1792452150303-J2F6` (SMS delay) | Jason | Proposal: with item 5 | Grant `messages_out` read access, or have an operator run the prepared queue query | (a) read access — the delay source is identified; (b) operator run — same evidence, no exposure | The reported ~40-minute delay has no proven cause; a customer-visible latency may be misdiagnosed | The queue query output: queue age, retry schedule, provider id/status/error, callback history |
| 7 | `LOOP-1791922936305-VU6R` (Client 2 session) | Jason (introduce the contact) / Ahad (run the session) | Proposal: needs confirmation — no agreed date is recorded anywhere | Establish whether the session will be held; if it will, agree a date and the attendee; if not, record that decision | (a) hold the session — the Commissary Ops Twin v0 workflow is validated against a real customer; (b) record that it is deferred — the workflow stays design-stage and its acceptance criteria remain unproven | The `BOOKED → IN_USE → CLEANED_CLAIMED → READY/NOT_READY` workflow and the append-only signed ledger have no real-world validation until this happens | Session notes with the client-confirmed requirements, or a recorded decision not to hold one |

**No other new commercial decision was identified.** The two fail-open paths and the voice-audit defect were defects, not decisions, and are closed locally.

### 12.8 BHA engine / twin integration boundary

**Primary lane:** CST identity/tenancy infrastructure.
**Engine/twin status: engine-facing prerequisite — no completed BHA engine integration exists.**

A repository-wide search for a Genie ledger, a Monitoring Twin, or any other documented BHA engine surface found **none**. The only "ledger" in the codebase is CST's own `SECURITY_LEDGER` (an in-process ring buffer in `engine/src/config/logger.ts` with a Slack notification) and the `alert_audit_log` table — both **CST-internal**.

**The verified mechanism by which authorised identity and scope reach the engine:**

1. The **receiving** number resolves to a tenant/project through `service_number_bindings` — a number identifies the **system**.
2. The **caller** number resolves to a customer through the durable `customers` record; that record's `customer_ref` is the **vFarm user id**.
3. The adapter re-verifies that id against the **live vFarm organisation-members list** and replaces the farm scope with the **authoritative vFarm farm-grant list**.
4. Only then is the identity passed to `CoreEngine.processEnvelope`, whose farm-scope gate decides what the engine may act on.

**The same data is NOT integrated into Slack Genie's ledger, the Monitoring Twin, or any other BHA engine/twin surface.** To integrate it, the minimum contract would be: the source (`voice_deliveries` + the transcript + `SECURITY_LEDGER` events), a target (a BHA ledger schema — none exists to reference), the update mechanism, the owner, and the authorisation boundary. **All four are unspecified in the available specifications, so no target schema, payload, credential or endpoint is proposed here.** This is recorded as a blocker on the existing `LOOP-1790985133891-1TEN` (Dashboard publisher) / `LOOP-1790691898379-S6Q3` scope line, and no integration is claimed.

---

## 13. Authorized deployment handoff — operator checklist

**Status: `LOCALLY VERIFIED — AWAITING AUTHORIZED DEPLOYMENT`.** Every step below is
production-changing and is **not** performed by this session. It is written for
Jason / Platform to execute in order.

### 13.1 Current release state (re-verified 2026-10-21T12:33Z, read-only)

| Item | Value | How it was verified |
|---|---|---|
| Local branch / HEAD | `fix/cst-identity-resolution-farm-access` / `1fb7697` | `git rev-parse` |
| Working tree | 10 modified + 3 untracked, **nothing staged, nothing committed** | `git status --short` |
| **Deployed SHA** | **`63a221964506a0cb6163cda7ee8fa7ed7c2ac0e1a`** (deploy `dep-dbbrodpsrm7s73fb6sl0`, finished 2026-10-20T19:09:24Z) | `render deploys list` |
| Fixes present in the deployed SHA | **none** — the live-client guard, the rehydration and the shared deadline are all absent, and the mis-placed voice alert write is **still present** | `git show 63a2219:<file> \| grep -c` |
| Service health | `GET /health` → 200 `{"status":"ok","service":"bha-cst-engine"}` | `curl` |
| `CST_API_KEY` | **not configured** — the engine's own boot message reports it missing on every boot, and a live POST to each of the five programmatic routes returns **503 `CONFIG_MISSING`** | `render logs` + live POST. **The value was never printed.** The Render API does not expose environment-variable *names* to this tooling, so this fact rests on the application's own report, not on direct configuration inspection. |
| Production identity/audit evidence | `opaque_revoked` ×23, `opaque_unresolved` ×0, `alert_audit_log_outbound_message_id_fkey` ×4, `AlertAuditLog.write failed` ×2 | `render logs` (current window) |
| Production database | IP allowlist **empty** — not bypassed; the production `customers` row is therefore **unverified** | `render postgres get` + the read-only query in §9 |
| Feature-branch fixes in the deployed SHA | **all absent** — the live-client guard, the rehydration and the shared deadline are each `0` occurrences in `63a2219`, and the **mis-placed voice alert write is still present there** (2 `AlertAuditLog` references in `engine/src/interfaces/voice/index.ts`) |
| Working tree | **10 modified + 3 untracked = 13 entries**, 0 staged, 0 committed — the release candidate is intentionally uncommitted |
| Non-Render deployment | **No evidence found.** The repository has no CI workflow, no Dockerfile, no Terraform/Kubernetes/Procfile, no deploy script and no second remote; `render.yaml` is the only deployment manifest, and the service tracks `main` of `bhanetworkgh/bha_cst`. A deployment from an unregistered copy of the source cannot be excluded by repository evidence and needs Jason's one-line confirmation. | repository-wide search + `git remote -v` |

### 13.2 Operator sequence — nine steps, in order

Steps 1–8 are the release itself. **Step 9 is a separate, separately-authorised
activity** and must not be bundled with the release: the live tests are customer
traffic and carry their own approval (`LOOP-1791243473841-02JU` /
`LOOP-1792187689082-B0M2`).

| # | Step | How | Evidence to record |
|---|---|---|---|
| 1 | **Configure `CST_API_KEY`** in the approved Render secret interface | `bha-cst` → Environment → add `CST_API_KEY`. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Store the value in 1Password `BHA Render Production Vault`. **Never paste the value into a log, a chat message, a ticket or a commit.** | The variable name is present in the Render environment. **Do not record the value.** |
| 2 | **Verify the application recognises it**, without exposing it | `render logs -r srv-db8hepqvcj2c73adpus0 --text "CST_API_KEY" --limit 20` — the *absence* of a new "Missing configuration: CST_API_KEY" line after the next boot is the signal. | A timestamped log line showing the configuration gap is no longer reported. |
| 3 | **Confirm the deployment source and the intended commit** | `render services get srv-db8hepqvcj2c73adpus0 -o json` → `repo` = `https://github.com/bhanetworkgh/bha_cst`, `branch` = `main`, `autoDeployTrigger` = `commit`. The reviewed work is currently on `fix/cst-identity-resolution-farm-access`; the intended action is a **merge to `main`**, after which `autoDeploy` publishes it. | The repo, branch and auto-deploy trigger, plus the merge commit SHA. |
| 4 | **Authorise the deployment** | Explicit approval to merge `fix/cst-identity-resolution-farm-access` into `main` and push. Note: `autoDeploy: yes` means **the push is the deployment**. | The approver's name and the approval time. |
| 5 | **Verify the deployed SHA after deployment** | `render deploys list srv-db8hepqvcj2c73adpus0` → the `Live` row's SHA must equal the merge commit. | The deployed SHA and the deploy id. |
| 6 | **Check health, startup logs, identity resolution and voice route configuration** | `curl -s https://bha-cst-7u9e.onrender.com/health` → 200. `render logs … --text "Migrations complete"` → expect `0 applied, 22 already recorded` (no new migrations; 020/021 are already applied). `render logs … --text "restored" --text "admin-managed phone"` → the boot rehydration line. `render logs … --text "Missing configuration: CST_API_KEY"` → must be **absent** after the new boot. A live POST to `/api/v1/voice/synthesize` should now return **401/403** (guard active) rather than 503. | Each command's output and its UTC timestamp. |
| 7 | **Confirm failures remain fail-closed** | With the identity fix live, an unknown caller must still resolve to an unknown/guest identity with **zero farm scope**, and a revoked member must still resolve as `opaque_revoked`. `render logs … --text "opaque_revoked"` should **not** show a new entry for the registered test number after the deploy. | The relevant log window before and after the deploy. |
| 8 | **Record evidence and timestamps** | Append to `docs/task.md` §E and to this report: the deployed SHA, the deploy id, the health response, the boot-log lines, the guard's 401/403 response, and the identity-resolution behaviour for the registered test number. | Timestamped evidence, linked from the loop records. |
| 9 | **Only after approval and prerequisites, schedule ONE controlled voice test and ONE controlled SMS** | A voice call against a **verified** Twilio From number to a reachable, authorised handset, and one SMS to an approved recipient inside an approved window. Capture the Call SID, the transcript, the provider message ID and the delivery callback. **Do not trigger the outbound queue by hand.** | The Call SID + transcript, the provider message ID + delivery callback, and the conversation's project attribution. |

### 13.3 Rollback

`docs/release/operator-playbook-sop.md` §11.1 is the authoritative procedure: **Deploys → select the deploy → "Rollback to this deploy"**. The rollback is authorised for a confirmed P0 (outage, data exposure, or a stuck outbound worker) by a second operator, logged immediately. **Migrations are forward-only** — a rollback does not undo a migration, and no migration is introduced by this release (020 and 021 are already applied). The release is **code-only**, so a rollback is a pure code redeploy with no data implication.
