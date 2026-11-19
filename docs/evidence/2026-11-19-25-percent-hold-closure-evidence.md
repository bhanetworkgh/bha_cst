# CST 25% Production Evidence Hold Verification Report

**Date:** 19 November 2026  
**Repository:** `bhanetworkgh/bha_cst`  
**Working Branch:** `fix/iwkx-pr55-acceptance-queue`  
**Working HEAD SHA:** `994403bdf24a593d36ac4a07867bc5e3bcc0708e`  
**Remote `origin/main` SHA:** `f5951a3c43da5187ef5f0f70c9fbf013cc09bde6`  
**Render Live Deploy ID:** `dep-dbv0v06i0phs73c3dh50`  
**Render Live Commit:** `ee0a69e4fbafa4999c5df9f2a512183c81d5bef1` (PR #55 merge commit)  
**Target Production Service:** `https://bha-cst-7u9e.onrender.com`  
**Report File:** `docs/evidence/2026-11-19-25-percent-hold-closure-evidence.md`

---

## A. Original Hold Reference

- **Original Codex Entry:** `CODEX-20261118-ahad-cst-error-routing` (Session Row 67 / `LOOP-1794902688968-15WV`)
- **Primary Slack Instruction:** [Slack Thread p1795035800416699](https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1795035800416699)
- **Decision Watch ID:** `DW-1795036114694-RK8U`
- **Original Report Link:** [docs/evidence/2026-11-18-15wv-relog-alignment-evidence.md](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-11-18-15wv-relog-alignment-evidence.md)
- **Exact Reason for the 25% Hold:**
  Jason approved the submission at 75% with a 25% payment hold due to `INSUFFICIENT_PROOF` regarding independent verification on GitHub `main`:
  1. The Playwright production E2E suite and valid-login assertions had not been independently verified on `main`.
  2. The Content-Type header merge defect in `web/app.js` was uncommitted and not present on `main`.
  3. Visual evidence screenshots and evidence reports were not committed or accessible on GitHub.
  4. Referenced CI runs did not execute the production Playwright browser tests.
  5. PR #55 had not been verified as live with real database tests and error class receipts.

---

## B. Defect Analysis & Exact Fix in `web/app.js`

### 1. Root Cause
In `web/app.js`, the `api()` fetch wrapper merged options using:
```javascript
// DEFECT: ...options spread after default headers overwrote 'Content-Type'
const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
```
When `options` contained a `headers` property (even an empty object `{}`), spreading `...options` at the end wiped out the merged `{ 'Content-Type': 'application/json' }`. Standard browsers default a string payload to `Content-Type: text/plain`, causing `express.json()` on the server to leave `req.body` as `{}` and triggering a `401 AUTH_REQUIRED` refusal.

### 2. Exact Implementation
```javascript
// FIXED in web/app.js
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.message || data?.error || 'Request failed');
  return data;
}
```

### 3. Regression Test
Added test to `tests/web/web_interface.test.ts`:
- `rejects login requests when Content-Type is not application/json or body is unparsed`
- **Result:** `15 passed (15)` in 636ms via `npx vitest run tests/web/web_interface.test.ts`.

---

## C. What Was Independently Verified

| Item | Method Used | Exact Result | Timestamp / Reference | Evidence Link |
|---|---|---|---|---|
| **Content-Type Header Merge Fix** | Code audit & edit in `web/app.js` | Caller headers merge safely without deleting `application/json`. | 2026-11-19 11:51 UTC | [web/app.js](file:///Users/HaMi/Documents/Jason/customer%20twin/web/app.js#L8-L13) |
| **Content-Type Regression Suite** | `npx vitest run tests/web/web_interface.test.ts` | 15/15 passed in 636ms. | 2026-11-19 11:52:44 UTC | [tests/web/web_interface.test.ts](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/web/web_interface.test.ts#L275-L289) |
| **Authoritative Render Production Login Logs** | `render logs --resources srv-db8hepqvcj2c73adpus0 --path "/api/v1/web/session" -o json` | Verified real `POST /api/v1/web/session` -> `201 Created` requests from acceptance runs:<br>1. Desktop Chrome: `requestID="ecbb0839-baeb-46d9"`, status 201, 750 bytes.<br>2. Mobile Chrome: `requestID="8707db19-5b14-4ed5"`, status 201, 750 bytes.<br>3. Automated Node client: `requestID="8912baff-a72e-44dc"`, status 201, 750 bytes. | `2026-11-18T20:59:30Z`<br>`2026-11-18T20:59:33Z`<br>`2026-11-18T18:32:51Z` | Render service `srv-db8hepqvcj2c73adpus0` |
| **Schema Migration 024 Applied** | Direct SQL query via `render psql bha-cst-postgres` | Migration `024_add_consent_exempt_to_messages_out.sql` present in `schema_migrations` (applied `2026-11-16 21:05:48 UTC`). Column `consent_exempt boolean NOT NULL DEFAULT false` confirmed on table `messages_out`. | 2026-11-19 11:15 UTC | Live DB `dpg-db8he2qvcj2c73ado3s0-a` |
| **Render Production Service Deployment** | `render deploys list srv-db8hepqvcj2c73adpus0` | Live deploy `dep-dbv0v06i0phs73c3dh50` is running merge commit `ee0a69e4fbafa4999c5df9f2a512183c81d5bef1` (PR #55 merge). | Finished `2026-11-18T20:51:02Z` | Render service `srv-db8hepqvcj2c73adpus0` |
| **Visual Screenshot Proof Files** | Filesystem inspection (`ls -lh`) | Verified valid PNG image files exist locally:<br>- Desktop: `docs/evidence/browser/prod-live-authenticated-session-chromium.png` (51 KB, 1280x720)<br>- Mobile: `docs/evidence/browser/prod-live-authenticated-session-mobile-chrome.png` (75 KB, 375x667) | 2026-11-19 11:30 UTC | [Desktop PNG](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/browser/prod-live-authenticated-session-chromium.png)<br>[Mobile PNG](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/browser/prod-live-authenticated-session-mobile-chrome.png) |

---

## D. What Remains Unverified & Current Blockers

1. **Fixes Not Committed or Merged to `main`:**
   - The `web/app.js` Content-Type header merge fix is currently an uncommitted working tree modification on `fix/iwkx-pr55-acceptance-queue`. It is NOT on `main`.
   - The production Playwright test additions (tests 7 and 8) in `tests/browser/prod_live_verification.spec.ts` are uncommitted and NOT on `main`.
   - The new regression test in `tests/web/web_interface.test.ts` is uncommitted and NOT on `main`.
2. **Artefacts Not Committed to Git / GitHub:**
   - Both screenshots (`prod-live-authenticated-session-chromium.png` and `prod-live-authenticated-session-mobile-chrome.png`) are untracked in Git (`??`). They do not exist on GitHub `main` or any remote branch.
   - The evidence report `docs/evidence/2026-11-18-15wv-relog-alignment-evidence.md` is untracked in Git (`??`) and not on GitHub `main`.
3. **GitHub Actions CI Does Not Run Playwright:**
   - The repository workflow `.github/workflows/ci.yml` contains only Vitest unit tests (`npm test`), build, and typecheck.
   - Playwright browser tests are not configured in GitHub Actions.
   - Referenced CI run `43956414824` ran on `main` at commit `26778c2` but ran only Vitest.
   - Referenced CI run `44339767870` ran on `fix/iwkx-pr55-acceptance-queue` at commit `994403b` (NOT `main`), and ran only Vitest.
4. **Live Render Production Code Lacks the `web/app.js` Fix:**
   - Direct verification via `curl https://bha-cst-7u9e.onrender.com/app.js` confirmed that production still serves the unpatched version where `...options` overwrites headers.
   - When Playwright runs without request interception against the currently deployed service, tests 1–6 pass (login view, empty credentials, bad credentials, accessibility), but tests 7 & 8 fail because the live unpatched `web/app.js` omits the JSON Content-Type header.
   - The live service is running commit `ee0a69e4`, which preceded the working copy fix.

---

## E. Before vs After Comparison

| Area | Prior Claimed Status | Verified Ground Truth |
|---|---|---|
| **Content-Type Fix** | Claimed fixed in previous session | Was broken in `web/app.js` because `...options` clobbered `headers`. Now fixed in working tree and verified by regression test, but still uncommitted and absent from `main` and production. |
| **Playwright Suite** | Claimed 8/8 passed in CI | Suite passes 8/8 only when executed locally against a server with the patched `web/app.js`. Does NOT run in GitHub CI. Tests 7–8 exist only on local working branch, not on `main`. |
| **Production Login Event** | Claimed HTTP 201 at `2026-11-19T11:27:14Z` | Authoritative Render server logs confirm real `201 Created` events occurred at `2026-11-18T20:59:30Z` (desktop) and `2026-11-18T20:59:33Z` (mobile) with request IDs `ecbb0839-baeb-46d9` and `8707db19-5b14-4ed5`. |
| **Visual Artefacts** | Claimed committed and linked | Files exist locally on disk as valid PNGs, but are untracked by Git and cannot be accessed via GitHub links. |
| **Branch Alignment** | Claimed aligned with production | Render is running PR #55 merge commit `ee0a69e4`, but new fixes and tests are uncommitted on `fix/iwkx-pr55-acceptance-queue`. |

---

## F. Acceptance Checklist

| Requirement | Description | Status | Evidence Reference |
|---|---|:---:|---|
| **1. Content-Type Fix in Code** | Safe header merge in `web/app.js` | **PASS** (Local) | [web/app.js](file:///Users/HaMi/Documents/Jason/customer%20twin/web/app.js#L8-L13) |
| **2. Unit Regression Coverage** | Vitest test for missing/unparsed JSON headers | **PASS** (Local) | [web_interface.test.ts](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/web/web_interface.test.ts#L275-L289) |
| **3. Playwright E2E Execution** | Genuine browser tests without request interception | **PASS** (Local Server) / **FAIL** (Unpatched Prod URL) | `tests/browser/prod_live_verification.spec.ts` |
| **4. Real Production 201 Event** | Correlated Render request logs | **PASS** | Request IDs `ecbb0839-baeb-46d9`, `8707db19-5b14-4ed5` in Render logs |
| **5. Migration 024 Presence** | Live DB schema readback | **PASS** | Render PostgreSQL `bha-cst-postgres` |
| **6. Fix Committed to Git** | Changes tracked in Git commit | **FAIL** | All changes are dirty working copy edits |
| **7. Code & Tests on `main`** | Merged into GitHub `main` branch | **FAIL** | Not in `origin/main` |
| **8. Visual Artefacts on GitHub** | Committed and viewable via GitHub URL | **FAIL** | Files are untracked (`??`) locally |
| **9. GitHub CI Executing Playwright** | Automated browser E2E in GitHub Actions | **NOT_VERIFIED** | Not configured in `.github/workflows/ci.yml` |
| **10. Deployed to Production** | Render live service running patched commit | **BLOCKED** | Blocked on commit, PR merge, and deploy |

---

## G. Outstanding Deployment & Post-Deployment Requirements

1. **Commit & PR:**
   - Commit `web/app.js`, `tests/web/web_interface.test.ts`, `tests/browser/prod_live_verification.spec.ts`, and track evidence files (`docs/evidence/browser/*.png`, `docs/evidence/*.md`).
   - Push to `origin/fix/iwkx-pr55-acceptance-queue` and open PR to `main`.
2. **Merge & Render Deploy:**
   - Merge PR into `main`.
   - Render automatically triggers deploy for the new merge commit.
3. **Post-Deploy Smoke Verification:**
   - Verify `curl -s https://bha-cst-7u9e.onrender.com/app.js | grep -A 3 "const headers"` serves the patched header merge.
   - Execute `npx playwright test tests/browser/prod_live_verification.spec.ts` against the live deployed URL without route interception to confirm 8/8 pass.

---

## H. Final Recommendation

**Status:** **`BLOCKED_ON_MAIN_MERGE`**

The 25% hold cannot be released until the PR is merged to `main`, deployed to Render, and verified live.
