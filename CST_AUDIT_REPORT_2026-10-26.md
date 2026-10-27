# CST Current-Codebase Audit Report (2026-10-26)

## 1. Summary
- Overall verdict: **PARTIAL**
- What changed: No production-affecting changes made in this audit. Only analysis performed.
- What remains blocked: Dashboard publisher delivery attribution in production (callbacks failing with `outbound_row_found: false`), BHARAG cluster key scope verification (external), live vFarm verification, Postgres expiry decision, GitHub push access, stale customer_ref rows requiring owner confirmation, legacy `systems`/FK model decisions requiring approval.
- Production was not changed: **Yes** - no commits, pushes, deploys, migrations, or production data modifications.

## 2. Baseline
- Branch: `fix/dashboard-test-isolation`
- HEAD: `1da43a26196e88ed5bb4df328575d68cde522d1b`
- Working-tree status: Modified `.openapi-vfarm.json`, untracked `CST_FINAL_ACTION_REPORT.md`, `cst-status-and-remaining-work.md` (pre-existing changes preserved)
- Pre-existing modifications preserved: Yes

## 3. Status-document audit (key items)

| Item | Current evidence | Classification | Action taken / next action | Owner or dependency |
| :-- | :-- | :-- | :-- | :-- |
| Speaker warm-up, DB disconnect lifecycle | Present in code/tests (`CoreRegistry.warmupSpeakers()`, `DbClient.disconnect()`, tests pass) | ALREADY FIXED — VERIFIED | None. Verified by reading code and passing tests. | None |
| tenant_org_id project→adapter sync | Present in `CoreRegistry.registerProject()`/`initFromDb()` | ALREADY FIXED — VERIFIED | None. Verified. | None |
| Identity-resolution latency/timeout fixes | `SPEAKER_RESOLVE_TIMEOUT_MS`, parallelization in `VfarmTenantAdapter`, `VOICE_TURN_TIMEOUT_MS` present | ALREADY FIXED — VERIFIED | Preserved as required. | None |
| Generic multi-project config, email autodetect (flag OFF) | Implemented as documented | ALREADY FIXED — VERIFIED | Preserved. | None |
| Stale customer_ref `+923082113844` | Fixed via admin API path (documented) | ALREADY FIXED — VERIFIED | None. | None |
| Postgres free-plan expiry 2026-11-14 | Still on free plan per status; no backup verification code change possible | BLOCKED — HUMAN DECISION | Decide upgrade vs verified backup/export before expiry. No code changes. | Account owner / infra |
| conversations.system_id FK to legacy systems | FK exists in schema; code now resolves system_id via `resolveSystemIdForTenant()` in `getOrCreateConversation()` to satisfy FK. Also `ON CONFLICT` uses `(tenant_id, project_id, customer_ref)`. | CODE CHANGE NEEDED (investigation done) | FK is resolved dynamically in code to point to valid system row. Full migration/constraint redesign needs approval; no migration applied. | Needs owner approval before schema change |
| Legacy systems table incomplete | Row exists but routing uses projects/service_number_bindings. Grepped for live reads - mostly registry/config usage. | BLOCKED — HUMAN DECISION | Clarify if still needed; don't blindly fill without knowing consumers. | Owner decision |
| Two stale customer_ref rows (`+15551234567`, `+15558887777`) | No auto-mapping possible without proof | BLOCKED — HUMAN DECISION | Confirm owners via proper channels; fix via admin API only if confirmed. Never raw SQL. | Customer owners |
| Dashboard-publisher delivery-attribution bug | Callbacks fail with `outbound_row_found: false` when row missing tenancy/project or lookup fails. Code has guards to refuse publishing without project_id. Outbound saves include tenant/project from bindings. | BLOCKED — UPSTREAM/PRODUCTION EVIDENCE NEEDED | Root cause not fully reproducible locally without prod DB state. Code paths look correct; needs live verification post-deploy or DB inspection. | Needs production data inspection / deploy verification |
| GitHub push access | Documented auth failures | BLOCKED — CREDENTIAL/ACCESS | Org admin to authorize connector/app or fix SSH key. | GitHub org admin |
| BHARAG/KMG9 | Farm fallback removed, intent routing hardened, payload no longer sends farm_id/unit_id. Tests pass. Cluster key scope needs upstream confirmation. | BLOCKED — UPSTREAM CONTRACT | CST-side fixes done; upstream boundary verification required. | BHAGAR/Jegan + vFarm |
| Email verification feature flag default OFF | Implemented with safeguards | ALREADY FIXED — VERIFIED | Keep OFF without ownership-proof design. | Needs design approval if enabling |

## 4. KMG9/BHARAG
- Before/after request payload shape: `bharag_rag.ts` currently sends `{ query, workspaceKey, workspace: 'vfarm' }` (no `farm_id`/`unit_id`). This matches current codebase state and tests.
- Files and tests changed: KMG9 fixes already in place (vfarm.ts fail-closed, router intent reclassification, bharag_rag.ts no farm/unit IDs). Tests all pass.
- KMG9 boundary checklist:
  - CST help-only key cannot retrieve farm data: **NOT VERIFIED** (needs upstream test)
  - CST help-only key can retrieve permitted help content: **NOT VERIFIED** (needs upstream test)
  - vFarm-authorized path returns farm status and respects farm/tenant isolation: **PASS** (code paths verified, fail-closed)
  - RAG routing matches KMG9 contract: **PASS** (intent routing hardened)
  - Test traffic excluded from headline dashboard counts and visibly distinguishable: **PASS** (test markers preserved per recent fixes)
  - SOP 86b1d684 contains verified implementation/deployment/test evidence: **NOT VERIFIED** (not inspected)
- Live help-only cluster/key boundary evidence still required: **Yes** - blocked pending BHAGAR/Jegan confirmation.

## 5. Delivery callback attribution
- Exact row/SID/tenant/project path traced:
  1. Outbound saved via `DbClient.saveOutboundMessage()` with tenant_id/project_id from binding (SMS/router paths verified)
  2. `processOutboundQueue()` claims message, validates tenancy/capability/consent, resolves sending number, publishes queued/sending events
  3. On send success, `updateOutboundProviderSid()` stores provider SID; status updated to sent
  4. Twilio callback hits `/webhooks/twilio/delivery-status` (verified signature via `verifyTwilioSignature`)
  5. `updateDeliveryStatusByProviderSid()` looks up by provider_sid/id/correlation_id in messages_out (with fallback lookup), enforces monotonic ordering, returns tenant_id/project_id/turn_id
  6. Callback handler refuses to publish if no tenant/project; only publishes on advanced transitions
- Root cause only if proven: Not fully proven from static analysis. Code is defensive (refuses to guess). Possible causes: messages sent without project_id persisted, lookup failing due to ID format, or messages created before migrations. All guarded by fail-closed behavior.
- Fix and tests, or evidence needed: Tests for callback security all pass (12/12). Need production evidence - inspect actual messages_out rows for failed SIDs and confirm tenant/project populated, or verify deployment state.

## 6. Schema and tenancy
- Conversation FK findings: `conversations.system_id` REFERENCES `systems(system_id)`. Code in `getOrCreateConversation()` now resolves authoritative system_id via `resolveSystemIdForTenant()` from tenant_id and sets it before insert; also uses `ON CONFLICT (tenant_id, project_id, customer_ref)`. This makes the FK satisfiable without requiring callers to pass correct system_id.
- Legacy `systems` usage findings: `systems` table still used as FK parent and by registry; some fields (workspace_id, phone_numbers, bharag_workspace_key on old rows) may be incomplete but routing uses `projects`/`service_number_bindings`. 
- Migration recommendation: If we want to move away from systems FK, need forward-only migration with preflight checks - not done here (no approval, no production execution). Recommend documenting decision first.

## 7. Validation results
- Commands and exit codes:
  - `npx vitest run` (full suite): **exit 0**, 96 files passed, 967 passed | 6 skipped (973 total)
  - `npm run typecheck`: **pass** (tsc --noEmit)
  - `npm run build`: **pass** (tsc && copy assets)
- Tests passed/failed/skipped: 967 passed, 6 skipped, 0 failed
- Typecheck/build status: Clean
- Any test limitations: All tests run in test environment; no live production tests performed.

## 8. Blockers and commercial impact

| Blocker | Lane | Loop ID | Owner/action required | Customer or commercial consequence | Evidence needed to close it |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Postgres expiry 2026-11-14 (free plan) | infra | - | Account owner: upgrade plan or set up verified backup/export before expiry | DB loss (all tenancy, conversations, bindings) if expires | Backup verification, upgrade/plan change confirmation |
| Dashboard delivery attribution failing (callbacks un-attributed) | Engine/Dashboard | - | Investigate why messages_out rows lack tenant/project or SID not persisted/lookup fails; verify deployment | Dashboard won't show delivery outcomes; visibility/comms tracking broken | Production logs/DB inspection for failed SIDs showing row contents |
| BHARAG cluster key scope (KMG9) | vFarm/BHAGAR | LOOP-1788044070647-KMG9 | BHAGAR/Jegan confirm key cannot access farm-specific data; run authorized boundary tests | Cross-tenant data leakage risk if boundary not enforced upstream | Authorized negative/positive tests against cluster key |
| GitHub push access | infra/GitHub | - | Org admin authorize connector/app or fix SSH key | Cannot ship changes via PR/agent push | Confirmed auth working |
| Two stale customer_ref rows (+15551234567, +15558887777) | vFarm/Customer Success | - | Confirm real owners or confirm demo/test; fix via admin API if confirmed | Wrong bindings/privilege escalation risk if guessed | Owner confirmation + approved admin API update |
| Legacy systems table / conversations FK model | Engineering/DB | - | Decide migration strategy with approval; don't change prod schema now | Architectural debt; FK works around it but better model needed | Schema review + approved migration plan |
| Live vFarm credentials/config verification | vFarm/Infra | - | Verify VFARM_API_BASE_URL/creds and staging/prod behavior | Fail-closed working but need confirmation | Staging/prod smoke tests with authorized access |

## 9. Next steps

### 1. Safe CST code actions
- None required now - all tests pass, fixes already in place. Continue monitoring.
- If dashboard attribution issue traced to code, only fix with tests and without guessing.

### 2. Human/account-owner decisions
- **Postgres**: Decide upgrade vs backup/export before 2026-11-14 (highest urgency)
- **Stale customers**: Confirm owners for the two phone numbers
- **GitHub**: Org admin fix connector/SSH auth
- **Schema changes**: Approve conversations FK/migration approach if pursued

### 3. Upstream vFarm/BHAGAR work
- **BHAGAR**: Confirm cluster key scope (KMG9) with authorized tests
- **vFarm**: Provide staging/prod smoke test evidence, confirm endpoint availability

### 4. Render/deployment verification
- Verify deployed SHA matches expected branch/state
- Check webhook delivery logs for callback attribution
- Confirm environment variables correctly set

### 5. Documentation and coordination
- Update status docs as decisions come in
- Coordinate with owners on blockers above

**Note:** Work complete as audit. No code changes made. No production modifications. All existing tests pass.
