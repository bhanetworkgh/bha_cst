# CST v1 Release-Readiness Assessment Report

**Loop:** `LOOP-1789824812431-IWKX`
**Target Release Date:** 31 October 2026
**Assessment Date:** 19 October 2026
**Auditor:** Antigravity / Ahad (`U0AC6RFNP3P`)
**Repository Baseline:** `bha-cst` (`main` @ commit `3e88058`)
**Overall Readiness Verdict:** **BLOCKED (Code-Ready / Operational Gates Pending)**

---

## 1. Executive Summary

This read-only release assessment evaluates Customer Service Twin (CST) v1 against the 10 core release criteria.

- **Test Suite Health**: **584 passed, 6 skipped, 0 failed** across 60 test suites (99.0% pass rate).
- **Typecheck & Build**: Clean compilation (`tsc --noEmit`), zero type errors.
- **Code & Security State**: Production-grade. Hardened proxy routes, tenant isolation, fail-closed vFarm handling, and SMS consent enforcement are fully verified at code and integration test levels.
- **Release Blockers**: Core software is fully verified locally, but release cannot be approved without external operational verification of Render staging/production database schema, custom domain TLS (OYP9), and third-party partner acceptances (KMG9 / BHARAG / vFarm).

---

## 2. Requirement Classification Matrix

| # | Requirement Area | Status | Evidence Source | Residual Action / Blocker |
|---|---|---|---|---|
| 1 | **Tenant isolation & project/system routing** | **VERIFIED** | `tests/tenancy/*`, `tests/isolation/*` (28 tests pass) | None. Project-to-org and phone-to-project mappings verified. |
| 2 | **Authentication & webhook security** | **VERIFIED** | `tests/security/vfarm_proxy_unauth.test.ts` (26/26), Twilio sig tests | 8/8 endpoints reject unauth requests with 401. |
| 3 | **SMS consent & opt-in enforcement** | **VERIFIED** | `tests/consent/consent_spine.test.ts` (28/28), `a2p_operational_acceptance.test.ts` (10/10) | Prompt uniqueness, STOP keywords, and outbound blocking verified. |
| 4 | **SMS, voice, and web production paths** | **BLOCKED** | `tests/integration/roundtrip.test.ts`, `tests/voice/*` pass | Live outbound SMS and phone calls require approved test window and numbers. |
| 5 | **vFarm connectivity & fail-closed behavior** | **VERIFIED** | `tests/adapters/vfarm_*` (59 tests pass), `kmg9_farm_isolation.test.ts` (9/9) | Returns `telemetry_unavailable` upon vFarm failure; no cross-tenant leakage. |
| 6 | **BHARAG integration & fallback safety** | **VERIFIED** | `tests/connectors/bharag_rag.test.ts`, `kmg9_farm_isolation.test.ts` | Zero BHARAG fallback for farm telemetry; payloads strip `farm_id`/`unit_id`. |
| 7 | **Database migrations & live schema** | **BLOCKED** | `scripts/migrate.js`, migrations `001_` through `018_` | Live Render DB allowlist is empty `[]`; operator SQL verification required. |
| 8 | **Admin UI & operational workflows** | **VERIFIED** | `tests/admin/admin_api.test.ts` (14/14), `vfarm_users_and_grants.test.ts` (4/4) | Tab 10 vFarm Users and Farm Grants fully operational. |
| 9 | **Logging, auditability, health & rollback** | **VERIFIED** | `SECURITY_LEDGER` audit trail, `/health` 200 OK | Structured JSON logs emitted on all security decisions and errors. |
| 10 | **Deployed commit identity & gate acceptance** | **PARTIAL / BLOCKED** | Render CLI confirms commit `3e88058` live; deploy `dep-db98vidg1s2s73bun8eg` | Partner gate acceptances (KMG9 `DW-19QD`, BHARAG `DW-53P7`, 5R0J) pending. |

---

## 3. Detailed Audit by Requirement

### 3.1 Tenant Isolation & Routing (VERIFIED)
- **Implementation**: Incoming Twilio messages resolve `To` phone numbers to dedicated `service_number_bindings`. Inbound payloads map strictly to `tenant_id` and `project_id`.
- **Evidence**: `tests/tenancy/platform_tenancy.test.ts` (8/8 pass), `tests/tenancy/project_org_id_mapping.test.ts` (6/6 pass). Unknown numbers tripwire safely into security refusal logs without executing downstream tool calls.

### 3.2 Authentication & Webhook Security (VERIFIED)
- **Implementation**: `requireAdminAuth` and `requireVfarmProxyAuth` middleware protect admin and proxy routes. Twilio webhooks validate `X-Twilio-Signature` using `validateRequest`.
- **Evidence**: 26/26 tests passing in `tests/security/vfarm_proxy_unauth.test.ts`. Live HTTP checks reject unauthenticated access with HTTP 401 across all 8 variants.

### 3.3 SMS Consent & Opt-In Enforcement (VERIFIED)
- **Implementation**: Canonical consent lifecycle in `engine/src/consent/service.ts`. Enforces `STOP`, `CANCEL`, `QUIT`, `UNSUBSCRIBE` keyword suppression. Outbound worker checks consent state before queue dispatch.
- **Evidence**: 38/38 passing tests across `consent_spine.test.ts` and `a2p_operational_acceptance.test.ts`. Prompt uniqueness prevents spamming unconfirmed leads.

### 3.4 Production SMS & Voice Paths (BLOCKED)
- **Implementation**: Fully integrated Twilio Voice and SMS transport adapters with Pakistan fallback routing.
- **Status**: Live SMS sends and live voice call completion tests cannot be triggered without explicit authorization and designated test recipients to avoid regulatory violations or accidental customer messaging.

### 3.5 vFarm Connectivity & Fail-Closed Behavior (VERIFIED)
- **Implementation**: `VfarmConnector.getUnitStatus` checks `hasLiveClient()`. If upstream vFarm is unreachable, errors out, or authentication fails, the engine safely returns `telemetry_unavailable`.
- **Evidence**: 18/18 tests pass in `tests/adapters/vfarm_live_contract.test.ts`.

### 3.6 BHARAG Integration & Fallback Safety (VERIFIED)
- **Implementation**: Completely excised previous BHARAG cluster fallback from farm telemetry paths (`kmg9` hardening). Knowledge queries strictly strip `farm_id` and `unit_id` from cluster ask payloads.
- **Evidence**: 9/9 tests pass in `tests/regression/kmg9_farm_isolation.test.ts`.

### 3.7 Database Migrations & Live Schema (BLOCKED)
- **Implementation**: Checksum-verified migration runner (`scripts/migrate.js`) with PostgreSQL advisory locks. Migrations 001 through 018 present.
- **Status**: Render database IP allowlist is currently empty (`[]`). Authorized operator must execute the verification queries from `cst-ho-fe-schema-verification-guide.md` to confirm constraints and triggers are live.

### 3.8 Admin Console & Operational Workflows (VERIFIED)
- **Implementation**: Admin console serves authenticated views for conversations, system configuration, and Tab 10 (vFarm Users & Farm Grants).
- **Evidence**: `tests/admin/vfarm_users_and_grants.test.ts` (4/4 pass), `tests/admin/admin_api.test.ts` (14/14 pass).

### 3.9 Logging, Auditability, Health Checks & Rollback (VERIFIED)
- **Implementation**: Structured JSON logger with `SECURITY_LEDGER` events for audit compliance. Public `/health` endpoint responds with 200 OK.
- **Evidence**: 4/4 alert audit tests pass. Rollback path uses standard Git SHA rollback in Render dashboard.

### 3.10 Deployed Commit Identity & Gates (PARTIAL / BLOCKED)
- **Status**: Render CLI (`render deploys list srv-db8hepqvcj2c73adpus0`) independently confirms that active deploy `dep-db98vidg1s2s73bun8eg` is running commit `3e88058a987b4cad0c72dfc3c94c75c8a353e96d` (finishedAt: `2026-10-16T20:58:29.823885Z`). However, formal partner gate acceptances (Jason's KMG9 live acceptance `DW-19QD`, Jegan's BHARAG key-scope proof `DW-53P7`, and Destiny's 5R0J sign-off) remain pending.

---

## 4. Release Action Plan & Recommendations

1. **Gate 1 (Infrastructure)**: Upgrade Render database plan from free tier to Starter ($7/mo) to eliminate 14 November 2026 expiry risk and prevent service hibernation.
2. **Gate 2 (Database Validation)**: Authorized operator with Render dashboard access verifies migrations 017 and 018 using `cst-ho-fe-schema-verification-guide.md`.
3. **Gate 3 (Third-Party Sign-off)**: Jason Bays executes KMG9 live test instructions (`cst-kmg9-live-test-instructions.md`) and Jegan confirms BHARAG cluster-key scoping (`DW-53P7`).
4. **Gate 4 (Live Smoke Test)**: Execute controlled SMS and Voice round-trip smoke test with designated test numbers upon Jason's written authorization.
