# Proposed VJU6 Verification Record

> **STATUS:** PROPOSED ENTRY ONLY — PENDING CANONICAL TRACKER CONFIRMATION  
> **NOTE TO LEAD (JASON):** A comprehensive search of the repository, Git history, and project documentation found no authoritative `VJU6` issue or loop identifier. This proposed verification entry has been prepared to capture all canonical verification evidence in one place. Please provide the link or identifier for the authoritative tracker record so this can be linked into your central tracking system.

---

## 1. Metadata & Execution Baseline

- **Repository:** `bhanetworkgh/bha-cst`
- **Branch:** `main`
- **Current HEAD Commit SHA:** `0ac8c5d` (`docs: document CST production readiness and acceptance gaps`)
- **Target Readiness Deadline:** October 14, 2026, 5:00 PM PKT
- **Audit Timestamp:** 2026-10-13T22:20:00+05:00 (17:20:00 UTC)
- **Evaluator / Responsible Operator:** Antigravity IDE (Pair Programmer)
- **Verification Environment:** Darwin arm64 (macOS 15.3), Node.js v20.18.0, Vitest v1.6.1, PostgreSQL 16.

---

## 2. Test Commands & Quality Results

| Test Command | Scope / Files | Passed | Skipped | Failed | Notes |
|:---|:---|:---:|:---:|:---:|:---|
| `npm test` | All 56 test files in `tests/` | 551 | 6 | 0 | 6 tests skipped in `dashboard_real_proof.test.ts` (gated by `REAL_DASHBOARD_PROOF=1`); 557 total. |
| `REAL_DASHBOARD_PROOF=1 npx vitest run tests/integration/dashboard_real_proof.test.ts` | Live Dashboard ingestion | 7 | 0 | 0 | **Verified live against https://dashboard.bhanetwork.org/api/engine/cst-events** (HTTP 200, row inserted). |
| `npm run typecheck` | `tsc --noEmit -p engine/tsconfig.json` | Clean | 0 | 0 | 0 TypeScript errors across codebase. |
| `npm run build` | `tsc -b engine/tsconfig.json && copy_web_assets.js` | Clean | 0 | 0 | `dist/` created; 7 web assets copied to `dist/web`. |
| `npx vitest run tests/security/vfarm_proxy_unauth.test.ts` | 5R0J route regression suite | 18 | 0 | 0 | 100% pass; verifies fail-closed 401/403 and zero upstream calls. |
| `npx vitest run tests/consent/` | All consent suites (2 files) | 37 | 0 | 0 | Verifies canonical wording, opt-in/opt-out, resubscription, prompt idempotency & evidence. |
| `npx vitest run tests/transport/outbound_tenancy.test.ts` | Tenancy, DID binding & callbacks | 22 | 0 | 0 | Verifies project binding, capability check, turn-id correlation. |
| `npx vitest run tests/adapters/vfarm_live_contract.test.ts` | vFarm live client contracts | 18 | 0 | 0 | Verifies layout parsing, headers, auth forwarding, timeout budgets. |

---

## 2.1 Release Decision & Gate Status: NO-GO
Live CST pilot traffic is marked **NO-GO**. Live traffic must not be routed until:
1. Deployed availability on Render is restored (`503 hibernate-wake-error` resolved via plan upgrade or configuration).
2. Staging migrations 017 and 018 are applied to the Render PostgreSQL instance.
3. Operational key-issuance audit for 2026-09-25 to 2026-10-07 is conducted on vFarm.
4. Custom domain DNS CNAMEs and TLS certificates are provisioned for `cst.bhanetwork.org`.

---

## 3. Loop Acceptance Decisions

### 3.1 Security Loop — `LOOP-1790790007707-5R0J`
- **Acceptance Decision:** **CODE FIXED & LOCALLY VERIFIED / OPERATIONAL AUDIT BLOCKED**
- **Route Matrix Summary:**
  - `GET /api/devices`, `GET /api/v1/devices`: Requires CST admin session (`x-admin-token`). Rejects Bearer JWT (403), rejects missing token (401). 0 upstream calls on failure.
  - `GET /api/dashboard`, `GET /api/v1/dashboard`: Requires CST admin session (`x-admin-token`). Rejects Bearer JWT (403), rejects missing token (401). 0 upstream calls on failure.
  - `GET /api/farms`, `GET /api/v1/farms`: Accepts CST admin session OR caller Bearer JWT. Forwards caller JWT verbatim; rejects expired JWT (401); never falls back to CST `VFARM_ADMIN_*` credentials.
  - `POST /api/tokens`, `POST /api/v1/tokens`: Accepts CST admin session OR caller Bearer JWT. Rejects unauthenticated callers (401). Ignores body-supplied tokens.
- **Key-Rotation Status:** `BLOCKED`.
  - An operational audit of keys minted in vFarm between **2026-09-25 and 2026-10-07** must be executed by the vFarm database owner.

### 3.2 Consent Loop — `LOOP-1791826143428-HOFE`
- **Acceptance Decision:** **CODE READY & LOCALLY VERIFIED / STAGING GATE OPEN**
- **Schema & Migration Verification:**
  - `017_sms_consent_audit_fk.sql`: Creates `unq_sms_consents_id_tenant`, foreign key `fk_sms_consent_audit_consent`, and trigger `trg_sms_consent_audit_append_only`. Verified present in local PostgreSQL.
  - `018_sms_consent_prompts.sql`: Creates `sms_consent_prompts` table with prompt evidence tracking and TTL. Verified present in local PostgreSQL.
- **Staging Status:** Unapplied on the remote Render managed PostgreSQL instance (`bha-cst-postgres`). Requires operator execution of `node scripts/migrate.js`.

### 3.3 DNS/TLS Loop — `LOOP-1790439082267-OYP9`
- **Acceptance Decision:** **BLOCKED**
- **Observed Host Evidence:**
  - `cst.bhanetwork.org`: NXDOMAIN on public DNS (1.1.1.1 and 8.8.8.8). No TLS certificate issued.
  - `cst-admin.bhanetwork.org`: NXDOMAIN on public DNS. No TLS certificate issued.
  - `bha-cst.onrender.com`: Resolves to Render GCP origin (`216.24.57.18`, `216.24.57.16`). Live HTTP probe returned `HTTP 503` with header `x-render-routing: hibernate-wake-error` (container hibernated on free tier and timed out on cold wake).

---

## 4. Remaining Blockers & Next Actions Matrix

| Workstream | Issue / Gate | Owner | Next Action Required | Target Date |
|:---|:---|:---|:---|:---:|
| **Security 5R0J** | vFarm historical token-issuance audit (2026-09-25 to 2026-10-07) | vFarm Platform Lead (Destiny) / Jason | Query vFarm token issuance table, revoke unknown keys, rotate CST credentials. | 2026-10-14 12:00 PKT |
| **DNS/TLS OYP9** | CNAME creation & Render domain mapping | Domain Admin / Platform Ops | Add CNAMEs for `cst` and `cst-admin` pointing to `bha-cst.onrender.com`. Upgrade Render service to `starter` plan to prevent 503 hibernate errors. | 2026-10-14 14:00 PKT |
| **Migrations HOFE** | Apply migrations 017 & 018 to staging | Backend Engineer / Ops Lead | Run `node scripts/migrate.js` on Render staging database and execute E2E consent test. | 2026-10-14 15:00 PKT |
| **Upstream 8D7U** | vFarm person-to-unit mapping endpoint missing | vFarm API Team | Operate with farm-scope fallback until unit mapping API is published by vFarm. | Post-v1 Pilot |
