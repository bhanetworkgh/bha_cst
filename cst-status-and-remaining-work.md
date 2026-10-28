# CST — Status Snapshot and Remaining Work

Generated from a live Render/Postgres audit + accumulated session history. Repo: `bhanetworkgh/bha_cst`. Production service: `bha-cst` (`srv-db8hepqvcj2c73adpus0`, https://bha-cst-7u9e.onrender.com). Production DB: `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`).

This is a status report, not a spec — verify everything below against current `main` before acting, since some findings were made against a stale local checkout (flagged inline where that applies) and the repo moves fast.

---

## ✅ Done — confirmed, don't redo

- **Speaker warm-up + DB disconnect lifecycle.** `CoreRegistry.warmupSpeakers()`, `DbClient.disconnect()`, server shutdown wiring, `tests/tenancy/speaker_warmup.test.ts`, `tests/db/db_lifecycle.test.ts` — all present, code-reviewed, correct.
- **`tenant_org_id` project→adapter sync.** `CoreRegistry.registerProject()` / `initFromDb()` now push `tenant_org_id` into the live vFarm adapter's internal projection (`ITenantAdapter.addProject()`), fixing live org-member resolution for any project beyond the original two hardcoded defaults.
- **Identity-resolution latency/timeout fixes.** `SPEAKER_RESOLVE_TIMEOUT_MS` (6s backstop around `CoreRegistry.resolveSpeaker()`'s adapter call), `listOrganizationMembers`/`getUserFarmGrants` now run in parallel (`Promise.allSettled`) instead of sequentially in `VfarmTenantAdapter.resolveSpeaker()`, `VOICE_TURN_TIMEOUT_MS` (9s wrapper around `VoiceInterface.processVoiceTurn`, falls back to a spoken apology + hangup instead of dead air). **Do not touch these without good reason — they fixed a real production latency issue.**
- **Generic multi-project config.** Per a prior Kilo run (commit `17ac697`, branch `feature/generic-project-config-email-autodetect` — confirm merge status before assuming this is on `main`): hardcoded project/org literals moved out of `initDefaultData()`/`resetToDefault()` into a clearly-labeled dev/test fixture file (`engine/src/adapters/vfarm/dev_seed.ts`); production tenancy now comes from DB/live discovery only.
- **Email-based vFarm auto-detection (feature flag, default OFF).** Same Kilo run: `engine/src/identity/email_verification.ts`, SMS-only, binds phone→`user_id` on a verified email match against org-members, bounded attempts (3 per number/project/tenant, 15-min TTL), no client-trusted role/farm data. **Still has an open design question nobody has answered: does matching an email actually prove the texter owns that vFarm account?** No second factor exists today. Do not flip this flag on without that being resolved.
- **Stale `customer_ref` for `+923082113844`.** Fixed via the proper admin API path (`PATCH /api/v1/admin/speakers/...`), independently confirmed against both the `customers` table and Render's request log.
- **LOOP-1792632542284-WTII's underlying risk (free-plan spin-down for the web service).** `bha-cst`'s plan is now `0.5c-512mb` (paid), not free — spin-down is no longer a risk for the *web service*. (No cron/keep-alive mechanism was actually built — the risk was resolved by a plan upgrade instead. Note this in case the plan ever gets downgraded.)

---

## 🔴 Not done — concrete, actionable gaps

### 1. Postgres free-plan expiry — most urgent, time-bound
`bha-cst-postgres` is still on the **free plan**, still **expires 2026-11-14**. No backup verification, no migrate/upgrade decision has been made. This is the single highest-risk open item — if it expires, the database (all tenancy data, speaker bindings, conversations) goes with it.
**Action needed:** decide — upgrade the Postgres plan, or set up a verified backup/export pipeline, before 2026-11-14. This is a decision for the account owner, not something to silently execute.

### 2. `conversations` table FK points at the dead legacy `systems` table
`conversations.system_id` has `FOREIGN KEY (system_id) REFERENCES systems(system_id)` — the pre-tenancy legacy table (1 row, mostly unused), not the current `projects`/`tenant_id` model everything else uses. It hasn't blocked all conversation creation (2 conversations, 33 messages exist in production as of this audit), but it's an architectural mismatch exactly as originally flagged (LOOP-1790985133890-XKWD: "conversation_system_id FK and conversation_id FK").
**Action needed:** trace how `conversation_id`/`system_id` get populated on insert (check `engine/src/db/client.ts` save-conversation path and whatever calls it from `interfaces/sms|voice|web`), decide whether the FK should move to reference `projects`/`tenant_id` instead, write a migration, and confirm no existing rows would violate the new constraint before applying it.

### 3. Legacy `systems` table is incomplete
`systems` row for `system-vfarm-01` has `workspace_id: null`, `phone_numbers: []`, `bharag_workspace_key: null`. The real routing path uses `projects`/`service_number_bindings` instead (which **are** fully populated), so this may be moot — but it's exactly what LOOP-1789573914064-KZE7 asked to be completed, as literally written.
**Action needed:** clarify with whoever owns this loop whether the legacy `systems` row still matters for anything (grep for live reads of `systems.workspace_id`/`phone_numbers`/`bharag_workspace_key` to check), or whether this loop should just be closed as superseded by the `projects` model. Don't blindly fill in those fields without knowing if anything still reads them.

### 4. Two more stale `customer_ref` rows
`customers` rows for `+15551234567` (`customer_ref: cust_vfarm_001_john_doe`) and `+15558887777` (`customer_ref: cust_vfarm_002_alice_smith`) still don't match any real vFarm org member — confirmed deliberately left unfixed last time because there was no real person to map them to (matching a stranger's number to a real vFarm identity would be a privilege-escalation bug, not a fix).
**Action needed:** confirm with the real owners of these two phone numbers which vFarm account each belongs to (or confirm they're pure demo/test numbers and should just be deleted), then apply via the same admin API `PATCH` path — never raw SQL.

### 5. Dashboard-publisher delivery-attribution bug
Every real Twilio delivery-status callback observed since the dashboard-publisher deploy (`1c3410e3`, 12 distinct messages, 24 log lines) failed with: `"Delivery callback for SM... could not be attributed to a tenant project"` / `outbound_row_found: false`. Zero successful dashboard-publish events observed in logs since that deploy — no init log line, no "mode: live" success line, no outbound HTTP 2xx evidence either.
**Action needed:** the outbound `messages`/`messages_out` row being matched against the callback's `message_sid` isn't carrying `tenant_id`/`project_id`, or the lookup is failing to find the row at all. Needs tracing in `engine/src/publishers/delivery.ts` (confirm exact current file — my local copy predates this logic) and the outbound-save path that's supposed to stamp `tenant_id`/`project_id` on the row at send time.

### 6. GitHub push access
Both my own GitHub connector (OAuth-based) and a prior Kilo run's SSH key hit access failures against `bhanetworkgh/bha_cst` from two independent credential paths. This blocks any agent from opening PRs directly unless run from a machine/credential that's actually authorized.
**Action needed:** whoever administers the `bhanetworkgh` GitHub org needs to either authorize the connector app, or confirm/fix the SSH key authorization, before an agent can push.

---

## ⚪ Not independently verified — needs investigation or is a human/coordination task, not a code fix

These were in the original 41-loop list and weren't checked against live evidence this round. Some are pure coordination/doc tasks (no code to check); others are plausible code tasks nobody has traced yet. Don't assume either way:

**Pure coordination/doc/scheduling (not code-verifiable):** follow-up with Jignathan/Yang on media system; coordinate with external vFarm/LM7W owners for live docs; secure external carrier test resource; rerun acceptance package; publish operator playbook SOP; draft Twin Handoff template; ground/retract a specific "188/188" test-count claim from an old session; schedule Client 2 working session; CST v1 Pilot Execution Plan doc; commercial pilot plan doc; naming-consistency pass (VFA/VFAM/VFOM/LM7W/LM73); map tenancy console audit data to a BHA pillar; document device-auth semantics changes; add Monitoring/Research Twin/Front Door lines to admin panel log; lock 3 flags into Engine verification view; CST clone-quality gate step 2 (gated on another loop closing first).

**Plausible code tasks, unverified this round:**
- vFarm user-facing "choosers" endpoint — does one exist? Not checked.
- vFarm form-scope mapping completion.
- VFAM API timeout budget validated against real upstream observability data (current default is a flat 5000ms per-call constant, `VFARM_DEFAULT_TIMEOUT_MS` in `engine/src/adapters/vfarm/live_client.ts` — not validated against real measured latency distribution).
- GHA engine dashboard URL/API configuration.
- VFAM person-to-unit authorization contract (vs. "fabricated unit data").
- Business ID / LM7W serial-number mapping.
- One specific flaky test (156/157) — re-run on a stable connection to confirm it was environmental.
- Device-readings → graphical/chart view in the admin panel. Last checked (stale): no charting library or `/vfarm/users`-style endpoint existed yet in `web/admin.js`/`admin.html`. May have changed since — re-check before building.
- DNS/TLS hostname pinning (`cst.bhanetwork.org`, `cst-admin.bhanetwork.org`) — not checked, needs DNS lookups.
- End-to-end trace of the form-to-device data workflow to find where it actually breaks.
- Outbound calling requirement/implementation for voice (currently inbound-only per the loop description — not independently confirmed).
- Voice callback messages for silence/unclear-speech/timeout/out-of-scope-question handling in the real voice path.

---

## Guardrails for whoever/whatever picks this up

- **Read-only investigation before any write**, for every item above — several of these (FK model, legacy `systems` table) need their actual current read-paths traced before changing anything, since this status doc may already be stale by the time it's acted on.
- **Never write to `customers`, `conversations`, or any production table via raw SQL.** Use the admin API where one exists (e.g. `PATCH /api/v1/admin/speakers/:phone` for customer_ref fixes); it handles cache invalidation and adapter sync that a direct SQL write would skip.
- **No destructive Postgres plan changes without explicit sign-off** — item 1 is a real decision (cost, downtime, migration risk), not a default-yes.
- **No guessing at phone→vFarm-user mappings** (item 4) — wrong mappings grant real people the wrong role/farm access. Confirm with a human before writing.
- **No bypassing GitHub auth** (item 6) — report the exact failure, don't try alternate credentials or keys.
- **Don't re-verify item by re-sending real SMS/voice/synthetic events to production** unless explicitly authorized — this is a live customer-facing service.
- **Preserve the identity-resolution timeout/parallelization fixes** listed under "Done" — several of the remaining items (FK tracing, dashboard-publisher bug) touch adjacent code; don't regress those fixes while working nearby.

## Suggested priority order

1. Postgres expiry decision (time-bound, ~3 weeks out as of this writing)
2. Dashboard-publisher attribution bug (actively failing on every real delivery right now)
3. `conversations` FK model correction
4. GitHub access (blocks shipping anything else that needs a PR)
5. Remaining two stale `customer_ref` rows (low urgency, same pattern as #4's blocker — need real owners)
6. Everything else, roughly in the order listed above
