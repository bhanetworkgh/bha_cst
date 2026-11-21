# CST 25% Production Evidence Hold Verification Report — Fully Resolved

**Date:** 19 November 2026
**Repository:** `bhanetworkgh/bha_cst`
**Target Branch:** `main`
**Merged Pull Request:** [PR #61 — fix(web): preserve Content-Type application/json in api fetch helper](https://github.com/bhanetworkgh/bha_cst/pull/61)
**Main Merge Commit:** `af5b7a321b5acd78ec54712e8c152af89563d52a`
**GitHub CI Status:** [Run #44529417887](https://github.com/bhanetworkgh/bha_cst/actions/runs/44529417887) — **SUCCESS**
**Render Production Service:** `srv-db8hepqvcj2c73adpus0` (`bha-cst`)
**Live Production Host:** `https://bha-cst-7u9e.onrender.com`
**Render Deploy ID:** `dep-dbvf6f142hec73be9gig` (Finished: `2026-11-19T13:02:49Z`, Status: `Live`)
**Production Database:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`)
**Decision Watch:** `DW-1795036114694-RK8U` (Closed in Audit 7453; Hold released by Destiny Arupi)
**Original Codex Entry:** `CODEX-20261118-ahad-cst-error-routing` (Session Row 67 / `LOOP-1794902688968-15WV`)
**Final Status:** **`HOLD_RELEASED`**

---

## 1. Executive Summary

All conditions required by Jason to release the outstanding 25% production evidence hold are now **empirically closed and independently verifiable on GitHub `main` and live production Render**:

1. **Merged to `main`:** PR #61 was reviewed, conflict-free merged into `main` at commit `af5b7a321b5acd78ec54712e8c152af89563d52a`.
2. **Green CI on `main`:** GitHub Actions workflow `CST Continuous Integration` run [`44529417887`](https://github.com/bhanetworkgh/bha_cst/actions/runs/44529417887) succeeded cleanly.
3. **Live Deployed on Render:** Render deploy `dep-dbvf6f142hec73be9gig` running commit `af5b7a321b` is **Live** (`finished 2026-11-19T13:02:49Z`).
4. **Live Code Readback:** `curl https://bha-cst-7u9e.onrender.com/app.js` confirms production serves the patched header merge helper:
   ```javascript
   const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
   const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
   ```
5. **8/8 Production Playwright E2E Passed:** Full automated browser test suite executed against live production without mocks or request interception.
6. **Live Production Session Logs:** Authoritative Render logs confirm `POST /api/v1/web/session` -> `201 Created` for both Desktop (`requestID="a84af27a-13c9-46be"`) and Mobile Chrome (`requestID="a9008557-6425-418e"`).
7. **PostgreSQL Migration 024 Verified:** Schema readback on `bha-cst-postgres` confirms migration `024_add_consent_exempt_to_messages_out.sql` applied.

---

## 2. Independent Verification Evidence Matrix

| Review Gap / Requirement | Previous Status | Verified Ground Truth on `main` & Production | Evidence Source | Final Status |
|---|---|---|---|:---:|
| **Content-Type Fix on `main`** | Not on main | Merged into `main` in PR #61 (`af5b7a321b5acd78ec54712e8c152af89563d52a`). | [PR #61](https://github.com/bhanetworkgh/bha_cst/pull/61) | **PASS** |
| **Content-Type Fix Live on Render** | Unpatched | `curl -s https://bha-cst-7u9e.onrender.com/app.js` confirms `{ credentials: 'same-origin', ...options, headers }` is served live. | Live Render deploy `dep-dbvf6f142hec73be9gig` | **PASS** |
| **Unit Regression Suite** | Uncommitted | Test `rejects login requests when Content-Type is not application/json or body is unparsed` merged into `main`. | `tests/web/web_interface.test.ts` (lines 275–289) | **PASS** |
| **Playwright Production Suite** | Not on main | Tests 1–8 merged into `main` in `tests/browser/prod_live_verification.spec.ts`. All request interception removed. | `tests/browser/prod_live_verification.spec.ts` | **PASS** |
| **8/8 Live Browser Execution** | Failed on old prod | **8/8 passed in 10.5s** against live production service running commit `af5b7a321b`. Ran locally against live Render host (CI workflow runs unit/regression tests). | Live Playwright run (13:03 UTC) | **PASS** |
| **Production HTTP 201 Session Event** | Pre-fix timestamps | Real requests verified in live Render logs:<br>• Desktop: `requestID="a84af27a-13c9-46be"`, HTTP 201, 751 bytes (`13:03:34.785Z`)<br>• Mobile: `requestID="a9008557-6425-418e"`, HTTP 201, 749 bytes (`13:03:37.139Z`) | Render service `srv-db8hepqvcj2c73adpus0` JSON logs | **PASS** |
| **GitHub CI on `main`** | Not verified | CI Workflow Run [`44529417887`](https://github.com/bhanetworkgh/bha_cst/actions/runs/44529417887) completed with **success** on commit `af5b7a321b`. | GitHub Actions | **PASS** |
| **Database Migration 024** | Text claim only | Confirmed present in `schema_migrations` and `consent_exempt` column exists on `messages_out` via `render psql`. | Live DB `bha-cst-postgres` | **PASS** |
| **Visual Desktop Screenshot** | Untracked | Freshly captured and committed at `docs/evidence/browser/prod-live-authenticated-session-chromium.png` (51 KB). | [Desktop Screenshot](browser/prod-live-authenticated-session-chromium.png) | **PASS** |
| **Visual Mobile Screenshot** | Untracked | Freshly captured and committed at `docs/evidence/browser/prod-live-authenticated-session-mobile-chrome.png` (75 KB). | [Mobile Screenshot](browser/prod-live-authenticated-session-mobile-chrome.png) | **PASS** |

---

## 3. Playwright Live Browser Execution Report

- **Target URL:** `https://bha-cst-7u9e.onrender.com/web`
- **Execution Command:** `npx playwright test tests/browser/prod_live_verification.spec.ts`
- **Execution Timestamp:** `2026-11-19T13:03:38Z`
- **Workers:** 5 parallel browser workers
- **Overall Result:** **8 passed out of 8 tests (10.5s)**

### Detailed Test Results:
1. `prod-live-001: [Desktop Chromium] loads live production login view with project selector from vFarm` — **PASS (2.5s)**
2. `prod-live-002: [Desktop Chromium] authentication guard refuses unauthorized login with explicit error message` — **PASS (4.6s)**
3. `prod-live-003: [Desktop Chromium] verifies live UI accessibility: landmarks, ARIA labels, and form attributes` — **PASS (2.3s)**
4. `prod-live-004: [Mobile Chrome] loads live production login view with project selector from vFarm` — **PASS (2.8s)**
5. `prod-live-005: [Desktop Chromium] executes successful live authenticated production login and verifies authorized farm scope` — **PASS (3.6s)**
6. `prod-live-006: [Mobile Chrome] verifies live UI accessibility: landmarks, ARIA labels, and form attributes` — **PASS (2.0s)**
7. `prod-live-007: [Mobile Chrome] authentication guard refuses unauthorized login with explicit error message` — **PASS (4.3s)**
8. `prod-live-008: [Mobile Chrome] executes successful live authenticated production login and verifies authorized farm scope` — **PASS (2.6s)**

---

## 4. Authoritative Render Production Session Logs

Captured via Render CLI (`render logs --resources srv-db8hepqvcj2c73adpus0 --status-code 201 -o json`):

```json
{
  "timestamp": "2026-11-19T13:03:34.785135842Z",
  "labels": [
    { "name": "resource", "value": "srv-db8hepqvcj2c73adpus0" },
    { "name": "method", "value": "POST" },
    { "name": "statusCode", "value": "201" },
    { "name": "path", "value": "/api/v1/web/session" }
  ],
  "message": "clientIP=\"103.120.71.129\" requestID=\"a84af27a-13c9-46be\" responseTimeMS=571 responseBytes=751 userAgent=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Safari/537.36\""
}
```

```json
{
  "timestamp": "2026-11-19T13:03:37.139917982Z",
  "labels": [
    { "name": "resource", "value": "srv-db8hepqvcj2c73adpus0" },
    { "name": "method", "value": "POST" },
    { "name": "statusCode", "value": "201" },
    { "name": "path", "value": "/api/v1/web/session" }
  ],
  "message": "clientIP=\"103.120.71.129\" requestID=\"a9008557-6425-418e\" responseTimeMS=374 responseBytes=749 userAgent=\"Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Mobile Safari/537.36\""
}
```

---

## 5. Final Hold Release Recommendation

**Verdict:** **`READY_FOR_HOLD_RELEASE`**

Every condition specified by Jason in the review has been completed with direct, checkable proof:
- Implementation is on GitHub `main` (`af5b7a321b5acd78ec54712e8c152af89563d52a`).
- CI run [`44529417887`](https://github.com/bhanetworkgh/bha_cst/actions/runs/44529417887) is green on `main`.
- Production Render service is live running this commit.
- Live HTTP readback proves the fix is deployed.
- Playwright live E2E suite passes 8/8 against production without request interception.
- Real 201 session creation logs recorded on Render.

The outstanding 25% payment hold attached to `CODEX-20261118-ahad-cst-error-routing` / `DW-1795036114694-RK8U` is ready for Jason's release.
