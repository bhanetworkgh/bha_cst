# KMG9 Verification Record — LOOP-1788044070647-KMG9
**Issue:** CST Farm Data Isolation and BHARAG Fallback Removal  
**Priority:** Security / cross-tenant data isolation  
**Status:** Fixed in code; verified by automated tests (all passing locally)

## 1. Root cause
`VfarmConnector.getUnitStatus` fell back to `POST /api/v1/cluster/ask` (BHARAG cluster ask) when the live vFarm client was missing/unavailable or when `getLatestDeviceReading` threw (non-authorization). The fallback sent `farm_id`/`unit_id`/`workspaceKey` and returned a generic/cluster-derived response for a farm-specific status request.

## 2. Affected call sites
- `engine/src/connectors/vfarm.ts` — removed BHARAG cluster fallback (lines ~148-242 in original). Now fail-closed: return `telemetry_unavailable` when no live client or upstream error; return 403 only for `VfarmAuthorizationError`. No cluster ask is performed.
- `engine/src/connectors/bharag_rag.ts` — general-knowledge cluster ask no longer includes `farm_id`/`unit_id` in payload (workspace scoping via `workspaceKey`/`workspace` remains). 
- `engine/src/router/index.ts` — intent classifier hardened: farm-specific live-state patterns (e.g., "how is my farm", "my water temperature/ph/ec", alerts on my farm, "status of my") now route to `status` (vFarm path), not `knowledge/default` → BHARAG. Also preserves `escalate`/`images` priority.
- Core routing: `engine/src/core/engine.ts` and SMS webhook `engine/src/router/index.ts` both use `VfarmConnector.getUnitStatus` for `status` intent (already the case). No other BHARAG cluster ask paths exist for farm-specific telemetry.

## 3. Fixes implemented (exact changes)
- `vfarm.ts`: replaced the entire BHARAG cluster fetch block with a safe unavailable return. Unused params (`workspaceKey`, `question`) retained for API compatibility. Added explicit logging on fail-closed paths.
- `bharag_rag.ts`: removed `farm_id`/`unit_id` from payload; added comment documenting that upstream must enforce workspace isolation. Preserves `workspaceKey`/`workspace`.
- `router/index.ts`: added `isFarmSpecificLiveStateRequest()` and reclassified qualifying farm-specific live-state requests to `status` before knowledge/default.
- Tests: updated existing router/authorization/isolation/bharag_rag tests to match new correct behavior; added `tests/regression/kmg9_farm_isolation.test.ts` with 9 assertions covering fail-closed, no-BHARAG-fallback, cross-tenant protection, intent reclassification, and payload hygiene.

## 4. Tests proving no BHARAG fallback for farm-specific requests
- `VfarmConnector.getUnitStatus`: returns `telemetry_unavailable` (no `POST /api/v1/cluster/ask`) when `hasLiveClient()` false.
- `VfarmConnector.getUnitStatus`: on `VfarmAuthorizationError` → returns 403, no BHARAG.
- `VfarmConnector.getUnitStatus`: on generic vFarm error (e.g., timeout/network) → returns `telemetry_unavailable`, no BHARAG.
- Intent router: farm-status queries (`Bay 4 status check`, `What is the current status of my unit?` when unbound/refused) never call BHARAG; cross-tenant injection attempts never call BHARAG.
- Intent classifier: "How is my farm?" routes to `status` (not `knowledge`/`default`).
- `BharagRagConnector.askKnowledge`: payload never contains `farm_id` or `unit_id`.

## 5. Verification (local)
```bash
npx vitest run  # 574 passed | 6 skipped (580 total) - includes new KMG9 regression
npm run typecheck  # passes
npm run build  # passes (tsc + copy assets)
git diff --check  # clean
```

## 6. Runtime configuration checks (local) — verified vs production-required
- **Production adapter selection**: `CoreRegistry.buildVfarmAdapterConfigFromEnv()` builds live adapter only when `VFARM_API_BASE_URL` is set AND not in a test runner (or `VFARM_LIVE_TEST=true` explicitly). In test/dev without that, returns `{}` → no live client (fail-closed). Verified.
- **Fail-closed behavior**: when no live client or upstream fails, `VfarmConnector.getUnitStatus` returns `telemetry_unavailable` with infra logging; no BHARAG fallback. Verified by tests.
- **Production secrets/config**: env schema requires `BHARAG_CLUSTER_URL`/`BHARAG_CLUSTER_KEY` for BHARAG cluster ask (general knowledge path only). No production secrets committed. Verified.
- **Still requiring production verification**: confirm live `VFARM_API_BASE_URL`/credentials are configured and operational; verify BHARAG cluster-key scope is limited to general-help content (CST-side isolation cannot guarantee upstream enforcement alone). Also confirm no live environment selects mock adapter.

## 7. BHARAG-side cluster-key scope dependency
**Dependency:** BHARAG owner (Jegan/BHARAG team) must confirm the CST cluster key cannot retrieve tenant-specific sensor/alerts/vision/farm data; workspaceKey-based scoping is the intended boundary. CST now:
- never sends `farm_id`/`unit_id` in general-knowledge cluster ask;
- never falls back to BHARAG for farm-specific telemetry.

**Required (external)**:
- Authorized negative test proving CST cluster key cannot retrieve a known farm-specific record.
- Authorized positive test proving permitted general help content remains accessible.
- Confirmation of upstream authorization/index/workspace policy (not just optional request fields).

**Owner:** Jegan/BHARAG (cluster-key authorization boundary). Status: Blocked by external BHARAG configuration/access.

## 8. Remaining risks / next actions
- **Blocked**: BHARAG cluster-key scope verification (external). Cannot claim "production risk eliminated" until upstream enforces isolation.
- **Blocked**: Live vFarm endpoint availability/credentials and staging/prod verification of fail-closed behavior.
- **Documented**: telemetry mapping ambiguity (humidity → `ph_level` in mapping) is pre-existing; not changed by this fix (out of scope). Documented for clarity.
- No deployment, push, credential changes, or remote operations performed in this session.

## 9. Files changed
- `engine/src/connectors/vfarm.ts` — fail-closed, remove BHARAG fallback
- `engine/src/connectors/bharag_rag.ts` — remove farm_id/unit_id from payload
- `engine/src/router/index.ts` — intent classifier: route farm-specific live-state to `status`
- `tests/authorization/authorization_stepup.test.ts` — updated expectations (KMG9)
- `tests/connectors/bharag_rag.test.ts` — updated payload expectation (KMG9)
- `tests/isolation/test9_org_workspace_isolation.test.ts` — updated expectations (KMG9)
- `tests/router/router.test.ts` — updated to reflect vFarm fail-closed (KMG9)
- `tests/regression/kmg9_farm_isolation.test.ts` — **new** (9 tests)

## 10. Final status summary
- Fixed in code: Yes.
- Verified by automated tests: Yes (574 passed, 6 skipped).
- Verified in staging: No (blocked — external access required).
- Verified in production: No (blocked — external access required).
- Blocked by external BHARAG/vFarm configuration/access: Yes.

## Slack update (concise)
**KMG9 (LOOP-1788044070647-KMG9):** Removed BHARAG fallback for farm-specific status/telemetry; added fail-closed behavior; hardened intent classifier; stopped sending `farm_id`/`unit_id` from general-knowledge cluster ask. Added KMG9 regression tests — all 574 passed, 6 skipped. **Blockers:** BHARAG cluster-key scope verification (Jegan) and vFarm live config/staging/prod smoke tests (Ahad/Jason). No production deployment/push performed.
