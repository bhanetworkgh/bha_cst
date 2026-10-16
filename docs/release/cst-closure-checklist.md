# CST Closure Checklist

## 1. KMG9 (Farm Routing)
**Status:** LOCAL-VERIFIED | LIVE-ACCEPTANCE-BLOCKED

**Local evidence:**
- Router: `engine/src/router/index.ts` — farm-specific live-state phrases classified as `status`; enforces bound farm/unit from identity.unit_context; refuses if unbound (no BHARAG fallback). (Lines ~38, 53-90, 310-364)
- Connector: `engine/src/connectors/vfarm.ts` — fail-closed on auth errors, upstream errors, missing live client; returns telemetry_unavailable; explicit "no BHARAG fallback" log lines. (Lines ~126-200)
- Tests: `tests/regression/kmg9_farm_isolation.test.ts` — 9/9 passing locally (farm-specific routed to vFarm/status, no BHARAG; auth error no fallback; generic error no fallback; unbound refused; cross-tenant injection respects verified context).

**Live acceptance required (Jason):**
- Confirm deployed SHA on `https://bha-cst-7u9e.onrender.com` matches intended commit (4ad161e or expected).
- Test 1: Unbound caller asks farm-specific question (e.g., "How is my farm?"). Expect refusal (not linked to active vFarm unit) and **no BHARAG cluster ask** call. Capture correlation/request ID and response.
- Test 2: Bound caller with no/insufficient access to that farm/unit. Expect access refusal/fail-closed (403) with telemetry_unavailable, **no BHARAG fallback**. Capture evidence.
- Test 3: General knowledge control (e.g., "How do I clean the filter?") still routes to BHARAG (non-farm-specific). Verify connector behavior unchanged.
- Evidence to collect: request/correlation IDs, full response bodies, server logs (if accessible), and confirmation no BHARAG request occurred for farm-specific cases.

**Owner:** Jason (with Ahad if vFarm access needed). **Closure:** All three scenarios evidenced by Jason; no unauthorized BHARAG fallback observed.

## 2. HOFE (Staging Migrations 017/018)
**Status:** BLOCKED

**Required evidence:**
- Migrations applied on staging: `017_sms_consent_audit_fk.sql`, `018_sms_consent_prompts.sql`
- Migration ledger: `schema_migrations` entries showing applied_at, checksum, filename for both files (matching repo versions)
- Render/staging logs showing successful `node scripts/migrate.js` run (no errors)
- SMS consent E2E passing on staging (consent_audit FK integrity, prompts constraints, append-only behavior per requirements)
- No destructive operations or partial application

**Owners:** Claude on Render / Ops/DB admin (staging). **Next action:** Provide ledger rows + logs + consent E2E results. Do not apply locally/prod.

## 3. Database Continuity
**Status:** BLOCKED

**Required evidence:**
- Postgres expiry date for deployed DB instance (reported Nov 14, 2026) — confirm actual expiry from Render dashboard/DB details
- Automated backups enabled? Point-in-time recovery (PITR) status? Retention window?
- Render plan upgrade status (free → starter+) — affects hibernation and expiry/continuity
- Assigned owner for DB continuity; action plan if expiry < acceptable window

**Owner:** Platform team/DB owner. **Closure:** Confirmed expiry, backup policy/retention, upgrade scheduled/completed, owner assigned.

## 4. OYP9 (DNS/TLS + Render Plan)
**Status:** PARTIALLY SATISFIED (onrender.com healthy) / BLOCKED (custom domains)

**Current state:**
- `https://bha-cst-7u9e.onrender.com` healthy: /health 200 OK; root redirects to /api-docs (200). TLS valid. No 503 observed in probes.

**Required:**
- CNAMEs for custom domains (cst.* and cst-admin.*) → Render target, dig verification
- Custom domain TLS certs issued/valid
- Render plan upgrade to starter+ (prevent hibernation/503s on idle) — linked to DB continuity
- Confirmation no hibernation under expected load/idle window

**Owners:** Domain Admin / Platform Ops. **Closure:** CNAME + TLS verified; plan confirmed upgraded; smoke against custom domains passes.

## 5. SMS/Voice + Four Pillars
**Status:** LOCAL-VERIFIED / LIVE-ACCEPTANCE-BLOCKED

**Local evidence:**
- Tests: 584 passed, 6 skipped (590). Key: security (5R0J), admin Tab 10, production hardening (11/11), KMG9 farm isolation (9/9), outbound tenancy, voice interface tests present.
- Four pillars: INTEGRATED AND VERIFIED (documented in cst-four-pillar-integration-matrix.md).
- SMS consent spine/migrations 016-018 implemented; delivery callbacks with monotonic guards; signature validation enforced (per tests).

**Live acceptance required:**
- SMS E2E with approved test number/recipient + authorized window (inbound signature validation, dedup, outbound delivery/callbacks, consent enforcement). Do not run unauthorized.
- Voice E2E with approval (call flow, status callbacks, audio synthesis fail-closed behavior). 
- KMG9 live test as above; vFarm Users & Grants Tab 10 live data check (authenticated admin session) — safe read-only if authorized.
- Live pillar verification only where feasible without destructive actions.

**Owners:** Jason (approval) + relevant teams. **Closure:** Only with actual evidence from approved live tests.
