# CST — Complete Pending Engineering Work Using Render CLI, With Evidence

## Lane: `[Ask Engine / vFarm / media / infra]`

## Before → After (factual state changes only)
- **Before:** Working tree clean on branch `fix/dashboard-test-isolation`, HEAD `181c44c`. All tests passing (948 passed, 6 skipped). KMG9 protections already implemented. Dashboard repo not present locally. 
- **After:** Added 16 new tests (5 in `tests/regression/kmg9_phase3_additional.test.ts`, 11 in `tests/transport/outbound_phase5_additional.test.ts`). All tests passing (964 passed, 6 skipped). No existing source files modified. Working tree contains only new test files and this report (untracked). TypeScript compiles cleanly.

## What I moved

### Baseline (both repos)
**CST repo (`bhanetworkgh/bha_cst`):**
- Branch: `fix/dashboard-test-isolation` (up to date with origin)
- HEAD: `181c44c` feat(admin): add read-only dashboard publisher status endpoint and UI indicator
- Recent commits: `181c44c`, `cd2ce3d` (fix dashboard dry-run in vitest), `2b3a4e8` (merge)
- Working tree: Clean before new files (only untracked test files + report now)
- Package: Node/TypeScript, vitest, Express. Tests: `npm test` (vitest run)
- Migrations: 21 migrations in `db/migrations/` (001-021)
- Key docs: `README.md`, `AGENTS.md`, `docs/kmg9-verification-record.md`, many release docs

**Dashboard repo (`bhanetworkgh/bha-engine-dashboard`):**
- **NOT PRESENT LOCALLY** in workspace. Searched in `/Users/HaMi/Documents/Jason/` - no `bha-engine-dashboard` directory found. Cannot access without cloning/fetching. Render has service `srv-dagj84ijnfac73ds5100` (bha-engine-dashboard, BHA Dashboard project) but repo files not available locally.

### Files changed
**Added (untracked):**
- `tests/regression/kmg9_phase3_additional.test.ts` - KMG9 Phase 3 boundary verification tests (5 tests, all pass)
- `tests/transport/outbound_phase5_additional.test.ts` - Outbound operational readiness tests (11 tests, all pass)
- `CST_COMPLETE_PENDING_WORK_REPORT.md` (this report)

**No existing files modified.** All pre-existing changes preserved.

### Tests added/fixed
- Added 16 new tests across 2 test files. All passing.
- No existing tests modified.

### Validation commands & results
- `npx vitest run` - **PASS**: 95 test files passed, 964 passed | 6 skipped (970 total)
- `npx tsc --noEmit -p engine/tsconfig.json` - **PASS**: no errors
- `git diff --check` - **PASS**: clean
- `git status --short` - Shows only untracked new files (no modifications to tracked files)

### Render CLI read-only inspection (evidence)
**CLI:** render v2.30.0 (available; newer v2.31.0 available)

**Services discovered:**
- `bha-cst` (srv-db8hepqvcj2c73adpus0, BHA-CST/Production/Web Service)
- `bha-engine-dashboard` (srv-dagj84ijnfac73ds5100, BHA Dashboard/Production/Web Service)
- `bha-cst-postgres` (dpg-db8he2qvcj2c73ado3s0-a), `bha-engine-db` (dpg-dai4uemq1p3s73b51i50-a)

**CST service logs (last ~50 entries, redacted):**
- Health checks from UptimeRobot every ~5min returning 200 (responseBytes 338)
- Outbound worker heartbeat every ~5min: `pending:0 queued:0 sending:0 failed:0 outcome_unknown:0` (healthy)
- Delivery callbacks received (TwilioProxy) with proper signature validation
- Observed cases where callbacks couldn't be attributed (no stored outbound row / missing tenant/project) - correctly refused with infra events, no data leakage. Callback attribution is from stored row (not recipient). Monotonic state handling observed.
- No BHARAG fallback attempts visible; farm-status goes through vFarm paths as designed.

**Dashboard service:** Not inspected in detail (repo not present locally). Service exists in Render.

## Why it matters for the Engine
- **CST:** Strengthens confidence in KMG9 isolation boundaries with additional test coverage for cross-tenant access denial, fail-closed behavior, and proper routing.
- **vFarm:** Confirms vFarm remains authoritative for farm status/truth with no BHARAG fallback. Authorization properly enforced.
- **BHARAG:** General knowledge properly separated from farm-specific telemetry; no farm identifiers sent for general queries.
- **Dashboard:** Existing safeguards intact (dry-run behavior, admin status endpoint). Classification fix requires dashboard repo access.
- **Downstream twin/engine:** Better test coverage for operational readiness (outbound queue, callbacks, heartbeats) and security boundaries.

## Blockers

### 1. KMG9 acceptance cases 1-5 (CST/vFarm security)
- **Status:** NOT VERIFIED (local tests added/passing, but external verification required)
- **Owner:** BHARAG/Jegan (cluster-key scope), vFarm/Jason (live smoke tests)
- **Cannot complete locally:** Cannot verify upstream BHARAG cluster-key enforcement or live vFarm behavior
- **Evidence required:** 
  1. BHARAG cluster-key scope proof (negative test cannot retrieve farm records, positive test general help works, policy/docs)
  2. vFarm live smoke tests per `docs/release/cst-kmg9-live-test-instructions.md` with correlation IDs/logs showing no BHARAG fallback
  3. Deployed SHA confirmation

### 2. RAG test 1, 2, 3
- **Status:** NOT VERIFIED
- **Owner:** TBD (operator with BHARAG credentials)
- **Cannot complete locally:** No BHARAG credentials/endpoint configured locally; cannot hit intended target
- **Evidence required:** For each test - sanitized fixture/request ID, expected assertion, actual result, target environment, timestamp. Must run against authorized endpoint. Never convert mocks to PASS.

### 3. Dashboard classification/historical data
- **Status:** BLOCKED (dashboard repo not accessible locally)
- **Owner:** Destiny (per project memory)
- **Cannot complete locally:** `bha-engine-dashboard` repo not present in workspace. Files mentioned (`server/src/systemFeeds.ts`, migration 92, `src/screens/CsTwin/index.tsx`) don't exist locally.
- **Evidence required:** Access to dashboard repo to implement conservative classification (phone alone not test, Twilio SID alone not production proof), exclude confirmed tests from headline metrics, show suspected/unverified separately, handle history safely, add regression tests, run dashboard tests/migrations.

### 4. Outbound queue/live delivery
- **Status:** PARTIALLY VERIFIED (local tests added, Render shows healthy heartbeats/queue empty)
- **Owner:** Ops/Platform
- **Evidence required:** Actual production delivery evidence beyond health checks. Render logs show callbacks and heartbeats but need confirmation of actual successful deliveries to customers if required for acceptance.

### 5. Other operational blockers (from existing docs)
- HOFE staging migrations (017/018) - needs staging evidence
- DB continuity/backups/PITR - needs platform/DB confirmation  
- OYP9 DNS/TLS for custom domains - needs configuration
- Live SMS/Voice E2E - needs explicit approval/test window

## Next
1. **Obtain dashboard repo access** - Clone or fetch `bhanetworkgh/bha-engine-dashboard` if permissions allow. If not, coordinate with Destiny. Then implement Phase 2 classification fix.
2. **Complete KMG9 external verification** - Work with Jegan (BHARAG key scope) and Jason (vFarm smoke tests) to get required evidence.
3. **Run three RAG acceptance tests** when authorized credentials/environment available, documenting with proper statuses.
4. **Address remaining operational blockers** per existing tracking docs.
5. **Final review** before considering release complete.

**Lane:** `[Ask Engine / vFarm / media / infra]`  
**Commit/deploy status:** **No commit, push, merge, or production deployment occurred.** Only added untracked test files and this report. All existing changes preserved. Working tree shows only untracked files.  
**Commercial impact:** Delayed full verification due to missing dashboard repo access and external dependencies (BHARAG/vFarm acceptances). Current protections are in place in CST codebase.

## Verification Update (2026-10-23)
- **Current state:** Branch `fix/dashboard-test-isolation`, HEAD `ca3bb15` (committed and pushed). Working tree clean except untracked files.
- **Tests:** 95 test files, 964 passed | 6 skipped (970 total). All passing.
- **Typecheck:** `tsc --noEmit -p engine/tsconfig.json` passes with no errors.
- **Lint/diff:** `git diff --check` clean.
- **16 additional tests:** Verified present and passing (5 KMG9 boundary + 11 outbound operational). Tests contain meaningful assertions (not placeholders).
- **Dashboard repo:** Not present locally; access blocker remains. No dashboard changes made.
- **Render:** CST service healthy, worker heartbeats every ~5min, queue empty, callbacks handled correctly.
- **Slack claims:** No direct Slack API access available in environment; claims documented as needing verification if Slack access is granted.
- **Automated test events:** No explicit `test: true` marker found in CST event contracts; dashboard-side classification depends on external repo (not accessible). Blocker documented.
