# CST Live Production Verification Report

## Phase 1: Baseline
- Branch: main
- HEAD: 4ad161e1f1ac70f611c3ca44ace77c5b6158428d
- Working tree: M tests/admin/vfarm_users_and_grants.test.ts; ?? docs/release/ (5 files including addendum)
- Render start: node scripts/migrate.js && npm start (per render.yaml)
- Health: /health returns {"status":"ok","service":"bha-cst-engine"} (200)
- Root: redirects to /api-docs (302) then serves Swagger UI (200)

## Phase 2: Live Render Service
- GET / (root): 302 -> /api-docs; final 200 serving Swagger UI (static). No 503 observed in limited probes.
- GET /health: 200 {"status":"ok","service":"bha-cst-engine"} (reproducible). Indicates app running; likely previous 503 was transient cold start or not observed now.
- GET /api/v1/health: 404 (NOT_FOUND) — confirms only /health as public health endpoint (matches codebase).
- Observation: Service is up and serving; homepage redirect to Swagger UI is expected behavior for API service.
- Cannot determine deployed SHA from public endpoints (no version header). Render may show SHA in internal logs; external evidence of deployed SHA not accessible from public HTTP.

## Phase 3: KMG9 Farm-Routing (local evidence; live unverified from public endpoints)
- Local implementation: engine/src/router/index.ts detects farm-specific live-state phrases and classifies as 'status'; enforces bound farm/unit from identity.unit_context; refuses if unbound (no BHARAG). VfarmConnector fails closed (auth errors, upstream errors, missing live client) with telemetry_unavailable and no BHARAG fallback. (lines verified in prior audit).
- Tests/regression/kmg9_farm_isolation.test.ts: 9/9 passing locally.
- Live E2E: Requires authorized test identity and approved test path (SMS/webhook or authenticated API). Public endpoints (/health, root) don’t exercise routing. Cannot claim live acceptance without exercising the actual inbound path with valid auth/test identity.
- Recommendation: Prepare exact test steps for Jason to run against deployed instance (or staging with same code) using approved test numbers/identity. Do not attempt unauthenticated webhook testing or send real SMS.

## Phase 4: SMS/Voice (public view)
- Webhook routes exist (per transport/twilio/* and tests). Signature validation enforced before DB access (per tests). Public health check doesn’t validate SMS/voice.
- No safe public endpoint to test Twilio flows without credentials/signature. Live SMS/voice acceptance requires approval + designated test recipient + authorized window. Cannot verify end-to-end from public HTTP alone.

## Phase 5: Live vFarm Integration
- Admin routes and adapter exist; vFarm base URL configurable via env (per code). Public endpoints don’t expose adapter state. Cannot verify live credentials/connectivity or Users & Grants live data from unauthenticated public requests.
- If authorized, safe read-only checks require authenticated admin session; no admin auth attempted here.

## Phase 6: HOFE Staging Migrations (017, 018)
- Migrations present: db/migrations/017_sms_consent_audit_fk.sql, db/migrations/018_sms_consent_prompts.sql. Runner (scripts/migrate.js) uses ledger with checksums/advisory lock.
- Cannot inspect staging Render DB/migration ledger from public endpoints. Claude on Render reportedly handled staging migrations; need execution logs/evidence (schema_migrations entries, applied_at/checksums) and consent E2E on staging. Mark BLOCKED until evidence provided.

## Phase 7: OYP9 DNS/TLS
- Service reachable via https://bha-cst-7u9e.onrender.com (HTTP 200 after redirect, valid TLS). DNS resolves; TLS valid (cloudflare/Render edge). This matches the deployed service URL.
- Remaining items from prior audit: custom domain CNAMEs (cst.* / cst-admin.*), Render plan upgrade to starter+ (prevent hibernation/503s), and confirmation of no 503 under normal load. Current probes show no 503.
- Evidence needed: CNAME resolution (dig), custom domain TLS cert issuance, plan confirmation, production hibernation behavior under idle. Status: PARTIALLY SATISFIED for current *.onrender.com URL; BLOCKED for custom domains + plan.

## Phase 8: Other Blockers (KMG9 external, DB continuity)
- KMG9/DW-19QD (vFarm smoke) and DW-53P7 (BHARAG cluster-key scope): external owners (Ahad/Jason, Jegan). No public evidence collected. BLOCKED.
- DB continuity: PostgreSQL expiry (Nov 14 2026), backup policy, Render plan upgrade. No public evidence. BLOCKED.

## Verification (Local)
- Typecheck: tsc --noEmit clean (engine/root). Build: succeeds. Tests: 584 passed, 6 skipped (590). No new failures. git diff --check clean. Working tree unchanged except existing test/doc files.

## Summary
- PASS locally (code/routing/tests/build/typecheck). 
- Live public endpoints: /health 200 OK; root 302->api-docs 200 (Swagger). No 503 observed now. 
- BLOCKED for live E2E acceptance: SMS/voice, live vFarm Users & Grants, HOFE staging migration evidence, KMG9 external acceptance, custom domains/OYP9 plan, DB continuity. 
- Farm-routing: already correct and tested locally (9/9). Live KMG9 acceptance requires authorized test execution by Jason/approved path (not possible via public unauthenticated probes).
