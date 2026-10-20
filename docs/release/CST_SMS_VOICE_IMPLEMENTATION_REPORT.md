# CST SMS & Voice — Implementation Report

**Brief:** "CST SMS & Voice — Codebase Diagnosis and Targeted Fix Instructions"
**Repository:** `bhanetworkgh/bha_cst` (remote `git@github-syedahadbhanetwork:bhanetworkgh/bha_cst.git`)
**Implemented by:** Ahad (`U0AC6RFNP3P`)
**Session:** 2026-10-20T17:20Z → 17:40Z (UTC)
**Repository HEAD:** `b06c68fc5950e56ba140df892929d32c1a78e07a` — **unchanged; nothing committed**
**Production:** `https://bha-cst-7u9e.onrender.com` — **not deployed, not touched**

> **Status of the code below:** every change is local and uncommitted. The brief's "Production-only checks that Claude must not perform" were **not** performed — no Render configuration change, no production SQL, no migration against a remote database, no Twilio SMS or call, no outbound queue dispatch, no credential rotation, no DNS change, no Slack post. The operator checklist in §7 is the outstanding work.
>
> **Correction to the brief's snapshot:** the brief states that "capability checks are inconsistent" (strict `!== 'voice'` in voice ingress, strict `!== 'sms'` in consent-exempt validation) and that the combined capability support is only "partially implemented". **That was already corrected in the working tree before this session** — 0 strict capability comparisons remain in `engine/src` (verified 2026-10-20T17:40Z). The brief's instruction "do not duplicate partial implementations" was followed; the work here is the *remaining* work plus the genuinely new items.

---

## 1. Issue-by-issue status

| # | Issue from the brief | Status | Evidence |
|---|---|---|---|
| 1 | Combined capability support already exists | **FIXED LOCALLY (pre-existing)** | `engine/src/core/types.ts` — `CapabilityType` includes `'sms_voice'`; `matchesCapability()` treats it as both transports. Not re-implemented. |
| 2 | Capability checks are inconsistent (strict `!== 'voice'`, strict `!== 'sms'`) | **FIXED LOCALLY (pre-existing)** | `grep -rnE "capability\s*!==\s*'(sms\|voice)'" engine/src/` → **0 matches**. `matchesCapability` is used in `interfaces/sms/index.ts:59`, `interfaces/voice/index.ts` (2 sites), `transport/twilio/outbound.ts` (2 sites), `core/registry.ts:392`. |
| 3 | Migration seed is stale; a forward migration is needed | **FIXED LOCALLY** | New `db/migrations/021_repair_service_number_bindings.sql` — sets `+19715885823` to `'sms_voice'` and unbinds the phantom `+19715885824`. Idempotent, additive, forward-only. |
| 4 | Messaging Service support already exists in the Twilio wrapper | **FIXED LOCALLY (pre-existing) + verified** | `engine/src/transport/twilio/client.ts` prefers `params.messagingServiceSid \|\| env.TWILIO_MESSAGING_SERVICE_SID` and never sends a conflicting `from`. The call site (`transport/twilio/outbound.ts:430`) passes `from: resolvedFromNumber` but the wrapper's environment SID wins. Payload contract now extracted and unit-tested. |
| 5 | The phantom number remains in an admin default path and in a migration | **FIXED LOCALLY** | `admin/routes.ts` `/numbers/sync` no longer has a no-tenant fallback (now 400 `TENANT_ID_REQUIRED`); `adapters/vfarm/index.ts` `pullCandidateNumbers()` no longer returns a literal list. The real number now appears in `engine/src` only in an explanatory comment. |
| 6 | Gather timing attributes are absent | **FIXED LOCALLY** | **11 of 11** `<Gather input="speech">` tags now carry `speechTimeout="auto" timeout="5"`. No non-speech Gather was touched (there are none). |
| 7 | The voice-turn timeout needs a careful fix (not a bare `Promise.race()`) | **FIXED LOCALLY** | See §3 — abort-based, with persistence checkpoints and a safe fallback. |
| 8 | Outbound sender selection and 21659 handling | **FIXED LOCALLY** (classification + fail-closed) · **BLOCKED ON OPERATOR** (sender pool) | 21659 added to `nonRetriableErrorCodes`; a send with no sender at all is refused before the API call. Whether the production Messaging Service's sender pool contains an owned number is operator-only. |
| 9 | Phantom numbers in all defaults (P1) | **FIXED LOCALLY** | The seed binds only the owned `+19715885823`; candidate numbers come from `VFARM_CANDIDATE_NUMBERS` only. Stale tests that expected `+19715885824` to be bound by default were updated. |
| 10 | Bounded voice-turn processing with a safe TTS fallback (P1) | **FIXED LOCALLY** | See §3. |
| 11 | Speech Gather prompts explicit (P1) | **FIXED LOCALLY** | §2.4. |
| 12 | Voice pointer / project capability consistency (P1) | **FIXED LOCALLY** | `proj-vfarm-dallas` is now `capabilities.voice: false`, `voice_enabled: false`, with the reasoning recorded in code. `proj-vfarm-main` keeps its env-sourced pointer. |
| 13 | Error 21659 not in `nonRetriableErrorCodes` | **FIXED LOCALLY** | Added with the classification basis documented. The installed client (twilio 5.13.1) does not define server-side codes locally, so the code is classified from the provider's documented behaviour, not a local constant. |

---

## 2. What changed

### 2.1 P0 — One owned number serving both SMS and voice

**`db/migrations/021_repair_service_number_bindings.sql` (new)** — the forward fix. Migration `010` seeded `+19715885823` as `'sms'` and `+19715885824` (Dallas) as `'sms'`; `010` is already applied and must not be edited, and the durable row is what production loads via `CoreRegistry.initFromDb()`.

```sql
-- 1. The owned number serves both transports
UPDATE service_number_bindings
SET capability = 'sms_voice', status = 'bound', ...
WHERE phone_e164 = '+19715885823'
  AND tenant_id = 'tenant-vfarm-01' AND project_id = 'proj-vfarm-main'
  AND capability IS DISTINCT FROM 'sms_voice'
  AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = 'proj-vfarm-main')
  AND EXISTS (SELECT 1 FROM organizations o WHERE o.organization_id = 'tenant-vfarm-01');

-- 2. The unowned number is unbound, not deleted (the audit trail survives)
UPDATE service_number_bindings
SET status = 'unbound', unbound_at = NOW()
WHERE phone_e164 = '+19715885824'
  AND tenant_id = 'tenant-vfarm-01' AND project_id = 'proj-vfarm-dallas'
  AND status = 'bound';
```

Both statements are guarded and idempotent. `+19715885825` is deliberately untouched — it was never seeded into the table. **No Dallas sender is invented**: `proj-vfarm-dallas` is left with no bound number, so its outbound SMS fails closed until a real owned number is bound.

### 2.2 P0 — Phantom numbers removed from every default

| Location | Before | After |
|---|---|---|
| `engine/src/admin/routes.ts` `/numbers/sync` (no `tenant_id`) | `numbers = ['+19715885823', '+19715885824', '+19715885825']` | **400 `TENANT_ID_REQUIRED`** — candidates must come from the adapter or configuration |
| `engine/src/admin/routes.ts` `/numbers/sync` (no adapter) | silently returned `[]` | **409 `NO_ADAPTER`** — nothing is added, and the reason is explicit |
| `engine/src/adapters/vfarm/index.ts` `pullCandidateNumbers()` | returned three literal numbers | returns the numbers in `VFARM_CANDIDATE_NUMBERS` (validated E.164), or `[]` with a warning. **No fabricated default.** |
| `engine/src/core/registry.ts` seed | bound `+19715885823` (sms) **and** `+19715885824` (dallas sms) | binds **only** `+19715885823` as `'sms_voice'`; candidate list is `['+19715885823']` |

The unowned number now appears in `engine/src` only in an explanatory comment in `core/registry.ts` recording *why* Dallas is voice-disabled.

### 2.3 P0 — Outbound SMS sender selection

**`engine/src/transport/twilio/client.ts`:**

- **21659 added to `nonRetriableErrorCodes`.** It is a permanent sender-configuration failure: the `From` identity cannot become valid by resending, so retrying only burns quota and delays the operator action. The retry loop in `outbound.ts` now breaks out immediately and the message is stored as permanently failed rather than re-queued.
- **A send with no sender is refused BEFORE the API call** — fail-closed, with a clear message, classified as 21659 and non-retriable. This check runs **before** the mock handler so it applies to every path.
- **The payload builder is extracted and testable**: `TwilioClientWrapper.buildSendSmsPayload(params, env)`. Contract: a Messaging Service SID is sent **alone** (never with a conflicting `from`); without one, the `from` is used; with neither, the send is refused.
- **Customer numbers are masked** in the Twilio logs (`to` was logged in full).

**Trace of the outbound path** (as the brief asked): `processOutboundQueue()` → `resolveOutboundSendingNumber(msg)` → `fromBinding.capability` checked with `matchesCapability` → `TwilioClientWrapper.sendSms({ from: resolvedFromNumber, … })` → the wrapper's **environment** `TWILIO_MESSAGING_SERVICE_SID` wins, so `from` is not sent. `TWILIO_MESSAGING_SERVICE_SID` is **required** by the env schema (`z.string().min(1)`), so a correctly configured deployment always has a sender.

### 2.4 P1 — Speech Gather prompts explicit

All **11** `<Gather input="speech">` tags across the six TwiML templates now carry `speechTimeout="auto" timeout="5"`:

```
<Gather input="speech" speechTimeout="auto" timeout="5" action="…" method="POST">
```

Covered paths: initial greeting, normal turn response, refusal/re-prompt, fallback, and the two self-closing follow-up gathers. The existing `action` and `method` attributes and the XML escaping are unchanged. There are **no non-speech Gather blocks** in the file, so none could be modified accidentally.

### 2.5 P1 — Bounded voice-turn processing with a safe fallback

**The problem:** a voice turn includes a CoreEngine round trip and an ElevenLabs synthesis. Unbounded, a slow or cold instance holds the Twilio webhook response open.

**The fix is not a bare `Promise.race()`.** `Promise.race` leaves the losing promise running, and that promise persists a transcript, a voice-delivery row and an audit entry — a duplicate turn and a duplicate billed synthesis for a response the caller never received.

| Element | Implementation |
|---|---|
| Bounded deadline | `VoiceInterface.processVoiceTurnWithDeadline()`; `DEFAULT_VOICE_TURN_DEADLINE_MS = 7000`, overridable with `CST_VOICE_TURN_DEADLINE_MS`, clamped to 1000–20000 ms. |
| Real cancellation | An `AbortController` is passed into the turn as `input.signal` and threaded down to the synthesizer's `fetch` (`AudioSynthesisInput.signal` → `customFetch(..., { signal })`). An abort during TTS surfaces as `AbortError` and is reported as a timeout, not a provider failure. |
| Checkpoint before synthesis | If the deadline fired while the engine was working, the turn is abandoned **before** any synthesis or persistence. |
| Checkpoint after synthesis | If the deadline fired during synthesis, the audio is discarded and **no** transcript, voice-delivery or alert-audit row is written. A `synthesized` row would assert a turn that was never delivered. |
| Safe fallback | The deadline returns `status: 'failed'`, `error: 'TURN_TIMEOUT'`, `httpStatus: 504`. The **existing** failure branch renders it as a short static `<Say>` ("I apologize, but I am currently experiencing technical difficulties…") plus `<Hangup/>` and **HTTP 200** — Twilio needs 200 to process the TwiML. The fallback carries no customer content, no exception text and no phone number. |
| Recorded | A `SECURITY_LEDGER` entry with the timeout, the deadline in ms and the **correlation id**. |
| Boundary | The deadline is applied at the **webhook handler** (`processVoiceTurnWithDeadline` is called from all three webhook branches), so it protects the HTTP response, not just the TTS call. The programmatic JSON route keeps its honest `504`. |
| Voice preserved | On success the real ElevenLabs voice is used unchanged. The fallback is Twilio's built-in `<Say>` and is only used on the failure path. |

**Known limit, stated:** if the synthesizer ignores the abort signal (a mock, or a provider that has already accepted the request), the TTS request may still complete and consume provider quota. It cannot produce a duplicate *turn* — no transcript, no voice-delivery row, no duplicate audio to the caller — because the abort checkpoints prevent persistence.

### 2.6 P1 — Dallas voice capability reconciled

`proj-vfarm-dallas` now has `capabilities.voice: false` and `voice_enabled: false`, with the reasoning recorded in the source: it has no voice pointer and no owned voice service number, so advertising `voice: true` would let the voice lane accept a Dallas call and then fail at synthesis. `capabilities.sms` stays `true` — the project *may* be SMS-enabled once a real number is bound, and the **binding** removal is what makes Dallas outbound fail closed today.

### 2.7 Files changed (14 source/config, 11 test)

**Source / config:**
`db/migrations/021_repair_service_number_bindings.sql` (new) · `engine/src/admin/routes.ts` · `engine/src/adapters/vfarm/index.ts` · `engine/src/core/registry.ts` · `engine/src/core/types.ts` · `engine/src/core/envelope.ts` · `engine/src/interfaces/sms/index.ts` · `engine/src/interfaces/voice/index.ts` · `engine/src/transport/twilio/client.ts` · `engine/src/transport/twilio/outbound.ts` · `engine/src/audio/synthesis.ts` · `.env.example`

**Tests:**
`tests/voice/voice_turn_deadline.test.ts` (new, 9) · `tests/transport/twilio_sender_selection.test.ts` (new, 12) · `tests/identity/sms_voice_capability.test.ts` (new, 12) · `tests/voice/voice_interface.test.ts` · `tests/voice/voice_guest_access_regression.test.ts` · `tests/voice/voice_failure_path.test.ts` · `tests/voice/voice_lane.test.ts` · `tests/tenancy/platform_tenancy.test.ts` · `tests/tenancy/tenancy_verification.test.ts` · `tests/tenancy/db_tenancy.test.ts` · `tests/transport/outbound_tenancy.test.ts` · `tests/identity/runtime_identity_model.test.ts` · `tests/admin/admin_api.test.ts`

**Test fixture change:** the real unowned number `+19715885824` was replaced by the clearly-synthetic `+19715550100` in every test that needed a second DID, so the unowned number appears in the codebase only in the migration that unbinds it and the regression test that guards it.

---

## 3. Verification

All runs are local. No live SMS, no live call, no remote migration, no gated live-proof test.

| # | Command | UTC start | Exit | Scope | Result |
|---|---|---|---|---|---|
| 1 | `npx vitest run tests/identity/runtime_identity_model.test.ts` | 2026-10-20T17:34:55Z | 0 | 1 file | **8 passed (8)** |
| 2 | `npx vitest run tests/transport/outbound.test.ts tests/transport/outbound_tenancy.test.ts` | 2026-10-20T17:34:56Z | 0 | 2 files | **26 passed (26)** |
| 3 | `npx vitest run tests/voice/voice_interface.test.ts tests/voice/voice_lane.test.ts tests/voice/voice_failure_path.test.ts tests/voice/voice_guest_access_regression.test.ts` | 2026-10-20T17:34:58Z | 0 | 4 files | **86 passed (86)** |
| 4 | `npx vitest run tests/admin/` | 2026-10-20T17:34:59Z | **1 (fixed) → 0** | 3 files | first run 1 failed / 36 passed; after the fix **39 passed (39)** |
| 5 | `npx vitest run tests/consent/` | 2026-10-20T17:35:03Z | 0 | 2 files | **38 passed (38)** |
| 6 | `npm run typecheck` | 2026-10-20T17:35:04Z | 0 | — | 0 errors |
| 7 | `npm run build` | 2026-10-20T17:35:06Z | 0 | — | clean |
| 8 | `git diff --check` | 2026-10-20T17:35:07Z | 0 | — | clean |
| 9 | `npm test` | 2026-10-20T17:35:41Z | 0 | 67 files | **691 passed \| 6 skipped (697), 0 failed** — 10 s |
| 9 | `npm test` (repeat) | 2026-10-20T17:35:51Z | 0 | 67 files | **691 passed \| 6 skipped (697), 0 failed** — 12 s |
| — | `npx vitest run tests/voice/voice_turn_deadline.test.ts tests/transport/twilio_sender_selection.test.ts tests/identity/sms_voice_capability.test.ts` | 2026-10-20T17:36Z | 0 | 3 files | **33 passed (33)** |

**Baseline comparison:** the previous session's baseline was **668 passed / 6 skipped (674)** across 65 files. The suite is now **691 / 697** across 67 files — **+23 tests, +2 files**, all new coverage.

### 3.1 Failures encountered in this session — preserved, not hidden

| Failure | Cause | Resolution |
|---|---|---|
| `tests/admin/admin_api.test.ts` — "syncs candidate numbers" expected `numbers.length > 0` | The sync no longer fabricates numbers | Rewritten into three tests: configured candidates are returned, no configuration yields an empty list and nothing fabricated, and a missing `tenant_id` is 400 |
| `tests/voice/*` — 5 TwiML assertions expected `<Gather input="speech" action=…` | The Gather attributes were added | Assertions updated to the new attribute form |
| `voice_turn_deadline` — "late completion" found a `synthesized` voice-delivery row | **A real defect in this session's first implementation**: `synthesizeSpokenAudio` wrote the delivery row *before* the abort checkpoint could stop it | The synthesizer now refuses to record a delivery for an aborted synthesis; a dedicated test covers it |
| `voice_turn_deadline` — the HTTP-boundary test got 504, not 200 | The test request omitted `Accept: text/xml`, so it was treated as a JSON caller | Test corrected to match a genuine Twilio request. The code was right: a Twilio request gets 200 + TwiML, a JSON caller gets 504 |
| `twilio_sender_selection` — 2 failures, "Required environment variables are missing" | The test deleted `TWILIO_MESSAGING_SERVICE_SID`, which the env schema **requires** | The environment is now left intact; the tests assert the real production contract (the env SID always wins) |
| `twilio_sender_selection` — `expected Error:` on the no-sender case | `getEnv()` threw before the fail-closed guard could run | The no-sender check was moved **before** the mock handler so it applies to every path, and the test now mocks the payload builder to reach it |

---

## 4. What the code does NOT do

| Item | Status | Why |
|---|---|---|
| `+19715885823` ownership in Twilio | **BLOCKED ON OPERATOR** | The brief's operator table says it is owned for SMS and voice. The code binds it; only the account owner can confirm the account state. |
| `TWILIO_MESSAGING_SERVICE_SID` and its sender pool | **BLOCKED ON OPERATOR** | The code sends through the environment's Messaging Service. Whether its pool contains an owned number supporting the destination's A2P registration is account-only. A Messaging Service cannot make an unowned number a valid sender. |
| Removing the `+19715885824` production binding | **BLOCKED ON OPERATOR** | Migration 021 unbinds it on the next authorised deploy. It has **not** been applied. |
| `proj-vfarm-main` voice pointer in production | **BLOCKED ON OPERATOR** | The code resolves the pointer from the project record / environment. The production row value still needs the read-only query in `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` §14.5. |
| A live SMS and a live voice test | **BLOCKED ON OPERATOR** | Not performed. |
| Production deployment of any of this | **BLOCKED ON OPERATOR** | Not performed; `autoDeploy` means a push to `main` deploys and runs migrations. |

---

## 5. Relationship to the CST gate chain

This work does not close any of the three revenue gates, and does not change their status. It **removes the technical blockers** that would otherwise have made the voice lane fail on its first real call, and it removes an unauthorised-sender surface from the SMS lane:

- **Destiny (`1Z1J`), Hardik (`E3Q5`), Kavin (`UUC8`)** — untouched. None of their work was started or duplicated.
- **Voice acceptance (`02JU` / `LMCL`)** — the Twilio `12300` content-type fix is live, and the webhook now answers within a bounded deadline with a safe fallback instead of risking a provider timeout on a cold instance. The remaining blockers are a verified From number, a handset and an authorized test.
- **Consent/A2P (`NI8F`)** — unchanged and still green (38/38). The dispatch-time consent gate and the `consent_exempt` fence are untouched.
- **5R0J** — unchanged. The `matchesCapability` work does not weaken any gate; the project-level capability gate is still separate and still refuses a channel the project has disabled.

---

## 6. Not-reproduced and not-changed

| Item | Status | Note |
|---|---|---|
| "Twilio error 21659 corresponds to a request containing `from`" | **NOT REPRODUCED** | CST sends through the environment's Messaging Service, so `from` is not sent. The 21659 risk in production is therefore a **sender-pool** problem, not a `from` problem — which is why the operator check in §7.1 is the sender pool, not the code. |
| The brief's `engine/src/transport/twilio/voice_router.ts` | **PATH CORRECTED** | The file is `engine/src/transport/voice/voice_router.ts`. |
| `tests/voice/voice_ingress_tenancy.test.ts` | **EXISTS, UNCHANGED** | It passed in the full suite; no change was needed. |
| The monotonic delivery guard (in-memory `Map`) | **NOT CHANGED** | Making it durable needs a schema change to the delivery table — separate work, not in this brief's scope. |
| `db/migrations/010_…` and `019_…` | **UNTOUCHED** | Historical reference only, as the brief requires. |
| `db/migrations/020_dashboard_publish_outcomes.sql` | **PRE-EXISTING** | From the previous session, not part of this brief. It is additive and will be applied by the same deploy. |

---

## 7. Operator checklist (not performed)

### 7.1 Confirm the Messaging Service and its sender pool
- [ ] `TWILIO_MESSAGING_SERVICE_SID` in the Render environment is the intended Messaging Service.
- [ ] Its **sender pool** contains a number the account owns (the brief's table: `+19715885823` and `+19452985504` are owned; `+19715885824` is not).
- [ ] The pool supports the destination's A2P 10DLC registration and the target countries.
- [ ] Confirm the pool does **not** contain `+19715885824`. If it does, that is the 21659 source.

### 7.2 Confirm number ownership
- [ ] `+19715885823` is owned and SMS+voice capable in the Twilio console.
- [ ] `+19715885824` is confirmed NOT owned; if it is in fact owned, migration 021 must be revisited before it is applied.

### 7.3 Remove the phantom production binding
- [ ] Apply `db/migrations/021_repair_service_number_bindings.sql` (additive; unbind only, no delete; the audit trail is preserved).
- [ ] Verify afterwards:
```sql
SELECT phone_e164, tenant_id, project_id, capability, status, unbound_at
FROM service_number_bindings
WHERE phone_e164 IN ('+19715885823', '+19715885824');
-- expect: +19715885823 -> proj-vfarm-main, capability 'sms_voice', status 'bound'
--         +19715885824 -> proj-vfarm-dallas, status 'unbound', unbound_at set
```

### 7.4 Verify the project voice pointer and capabilities
- [ ] `projects` for `proj-vfarm-main`: `elevenlabs_voice_id` is the real clone pointer, `voice_enabled` true.
- [ ] `projects` for `proj-vfarm-dallas`: `capabilities->>'voice'` is false and `voice_enabled` is false, matching the code default.
- [ ] The `VFARM_CANDIDATE_NUMBERS` variable is set to the owned numbers, so the admin sync and the vFarm adapter can offer real candidates.

### 7.5 One explicitly authorized SMS test
- [ ] Confirm the sender, then send exactly one message to an approved recipient.
- [ ] Capture the provider message ID (`SM…`), the delivery-status callback, and the `messages_out` row.
- [ ] Confirm the `sent_at - created_at` interval — this is also the outstanding diagnostic for the ~40-minute delay.

### 7.6 One explicitly authorized voice test
- [ ] Confirm a verified From number, a reachable handset, and the recorded authorization.
- [ ] Place exactly one call; capture the Call SID, the greeting, the spoken query, the generated response, the transcript, and the sanitized server log.
- [ ] Confirm the webhook answered inside the deadline (`CST_VOICE_TURN_DEADLINE_MS`, default 7000 ms) and that a `<Gather input="speech" speechTimeout="auto" timeout="5" …>` was returned.

### 7.7 Deployment note
- [ ] The service has `autoDeploy: yes` on `commit` for branch `main`, and `startCommand` is `node scripts/migrate.js && npm start`. **A push to `main` deploys and runs migrations.** Set `CST_API_KEY` and `VFARM_CANDIDATE_NUMBERS` in Render **before** the push, and expect migrations 020 and 021 to apply.

---

## 8. Supporting evidence

| Evidence | Path |
|---|---|
| This report | `docs/release/CST_SMS_VOICE_IMPLEMENTATION_REPORT.md` |
| Master readiness audit | `docs/release/CST_READINESS_EVIDENCE_5R0J_HOFE_VJU6.md` |
| Gap closure report (21 gaps, per-gap status) | `docs/release/CST_REMAINING_GAPS_CLOSURE_REPORT.md` |
| Canonical task ledger | `docs/task.md` (mirror `docs/release/task.md`) |
| Approval drafts (8, unsent) | `docs/release/cst-approval-requests.md` |
| Operator Playbook | `docs/release/operator-playbook-sop.md` |
| Binding repair migration | `db/migrations/021_repair_service_number_bindings.sql` |
| Combined-capability tests | `tests/identity/sms_voice_capability.test.ts` |
| Voice deadline tests | `tests/voice/voice_turn_deadline.test.ts` |
| Twilio sender-selection tests | `tests/transport/twilio_sender_selection.test.ts` |
| Programmatic voice auth tests | `tests/security/programmatic_voice_auth.test.ts` |

---

*Implemented 2026-10-20 by Ahad (`U0AC6RFNP3P`). Uncommitted. No production change, deploy, migration, call, SMS, credential rotation, DNS change or Slack post was performed. No secrets, raw authentication headers, customer PII or unmasked phone numbers are included.*
