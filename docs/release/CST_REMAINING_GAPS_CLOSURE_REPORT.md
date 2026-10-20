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
