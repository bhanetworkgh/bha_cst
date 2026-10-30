# Production Environment Audit — 2026-10-30

| Variable | Required by code? | Current supplied status | Expected format/role | Finding | Action |
|---|---|---|---|---|---|
| VFARM_API_JWT / VFARM_JWT | YES — engine/src/core/registry.ts:46,58; engine/src/adapters/vfarm/index.ts:155,218; env.ts:23 (optional) | Both consumed; registry prefers VFARM_API_JWT, falls back VFARM_JWT. Render sets both (render.yaml:109,112). | vFarm admin Bearer JWT (7-day lifetime) | EXPIRED — expiry 2026-10-23T20:05:24Z (docs/evidence/cst-user-integration-admin-panel.md:526,636,791) | EXPIRED → rotate fresh JWT / enable auto-relogin |
| BHARAG_API_URL | YES — engine/src/config/env.ts:59 (required url); engine/src/connectors/bharag_rag.ts:47, bharag_incidents.ts:47 | SET in prod (54 vars list, docs/evidence/2026-10-29-render-live-evidence-entry-399.md:50) | Trusted prod URL https://bharag2.duckdns.org/api/v1/cluster/ask (cst-e2e/CONFIG_REQUIRED.md:52) vs .env.example localhost:5000 | VERIFY consistency vs trusted prod URL | VERIFY |
| VFARM_RESOLVE_ENDPOINT | YES — engine/src/config/env.ts:50 (url); systems/registry.ts:46 | SET in prod | Trusted prod endpoint not documented; .env.example http://localhost:4000/api/v1/customers/resolve | VERIFY authoritative prod endpoint | VERIFY |
| VFARM_WORKSPACE_ID | NO (optional) — systems/registry.ts:29 (workspaceId = env \|\| orgId) | MISSING/empty in prod (CST_FINAL_ACCEPTANCE_REPORT_2026-10-29.md:147) | Optional legacy workspace id | Optional with orgId fallback | OPTIONAL |
| BHARAG_WORKSPACE_KEY | YES — engine/src/config/env.ts:61 (min 1); bharag_rag.ts:45; bharag_incidents.ts:46 | SET in prod | Bearer workspace key for incidents/ask | VERIFY validity/scope | VERIFY |
| CST_ADMIN_PASSWORD_HASH | YES — engine/src/admin/auth.ts:89 (in-memory compare) | SET in prod; .env.example SHA-256 of 'admin' (8c6976e5...) | SHA-256 hex of strong password | Insecure default hash → CHANGE | CHANGE |
| VFARM_DEFAULT_DEVICE_COUNT | Optional — render.yaml:163 | SET=0 in prod | Seed count for device discovery | 0 means no default devices seeded | OPTIONAL |
| DATABASE_URL | YES — engine/src/db/client.ts:253; env.ts:38 (default localhost) | Wired from managed Postgres in render.yaml:54 | postgresql://... managed | VERIFY managed wiring & migrations | VERIFY |
| VFARM_API_BASE_URL vs VFARM_BASE_URL | Both consumed — registry.ts:41 (VFARM_API_BASE_URL \|\| VFARM_BASE_URL), :53 (process.env same); routes.ts:1122 uses VFARM_BASE_URL | Both SET in prod | Single trusted prod base URL | Redundant fallback; must be consistent | VERIFY consistency |
| Startup validation | Partial — env.ts validates some (VFARM_API_BASE_URL optional, DATABASE_URL default, VFARM_RESOLVE_ENDPOINT required url, BHARAG_* required) | Missing vars may not fail safely | Fail-closed for identity/auth | Partial validation; missing values may not fail safely | VERIFY |

## Twilio callback defect
Application/DB logic, NOT env. Trace: message creation → outbound DB insert → Twilio send → SID persistence → delivery callback → SID lookup → status update → cst.delivery publication. outbound_row_found=false occurs because rows are not persisted with tenant/project before callback arrives. Same DATABASE_URL; no env var causes DB mismatch. Fix in application/DB persistence layer.

## Render variables to update
- VFARM_API_JWT / VFARM_JWT → rotate to fresh unexpired JWT (or rely on VFARM_ADMIN_EMAIL/PASSWORD auto-relogin).
- CST_ADMIN_PASSWORD_HASH → replace SHA-256('admin') with strong password hash.
- VERIFY consistency of VFARM_API_BASE_URL/VFARM_BASE_URL and BHARAG_API_URL against trusted prod URLs.
- VERIFY DATABASE_URL managed wiring and migration state.
- VERIFY BHARAG_WORKSPACE_KEY and VFARM_RESOLVE_ENDPOINT validity.

## Values to remain unchanged
- VFARM_DEFAULT_DEVICE_COUNT=0 (intentional no-seed).
- VFARM_WORKSPACE_ID (optional, orgId fallback) unless legacy consumer requires.
- DATABASE_URL schema (managed).

## Local tests
- typecheck: `npm run typecheck` → PASS (tsc --noEmit).
- build: `npm run build` → PASS (tsc -b + copy_web_assets, 8 entries).
- tests: `npm run test` → 102 files, 1055 passed, 6 skipped (1061 total), 14.39s. DB-gated tests (CST_DB_TESTS=1) skipped without DATABASE_URL.
No secret values printed.
