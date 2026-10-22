# CST Operations Checklist — Read-Only Verification Items

**Date:** 2026-10-22
**Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`) — `https://bha-cst-7u9e.onrender.com`
**Status:** Documentation only. No production changes were made.

---

## 1. PostgreSQL plan and backup/restore

- [ ] Confirm the intended plan for `bha-cst-postgres` (currently **free**, `expiresAt: 2026-11-14T18:10:20Z`).
- [ ] If staying on free, document the expiry and set a calendar reminder for 2026-11-07.
- [ ] Verify an approved export/restore path exists (Render dashboard → database → backup).
- [ ] Confirm `ipAllowList: []` is intentional (no network restriction beyond credentials).
- [ ] Confirm `highAvailabilityEnabled: false` and `readReplicas: []` are acceptable for production load.

**Do not upgrade or change the plan without authorization.**

## 2. Database IP allowlist

- [ ] The production database has `ipAllowList: []` (no restriction).
- [ ] Before applying any restriction, verify which IPs Render's web service uses to connect.
- [ ] Test the restriction in a staging environment first.
- [ ] Confirm the connection still works after any change.

**Do not apply a restriction without testing.**

## 3. Express `trust proxy` measurement

- [ ] `app.set('trust proxy', true)` trusts ALL proxies (left-most `X-Forwarded-For`).
- [ ] `req.ip` is used by the webhook rate limiter (120 req/min).
- [ ] Measure the actual `X-Forwarded-For` chain on Render (how many hops).
- [ ] Set `trust proxy` to the exact hop count (e.g. `1` for a single edge hop).
- [ ] Verify the rate limiter still works correctly after the change.

**Do not change `trust proxy` without measuring the chain first.** Guessing wrong is worse than the current state.

## 4. Outbound queue pause controls

- [ ] `PAUSE_OUTBOUND_QUEUE` does not exist anywhere in the codebase, `render.yaml`, service env, or `.env`.
- [ ] `DRY_RUN` exists only in `publishers/dashboard.ts` and gates **Dashboard publication only**.
- [ ] `quiet_hours` exists only as a type field and is never read.
- [ ] The queue worker is an in-process `setInterval` (5s) — it only runs while the process is alive.
- [ ] Confirm whether a queue pause/replay mechanism is needed for operational safety.

**No pause control exists. If one is needed, it must be designed and implemented.**

## 5. Production environment variables

Verify the following are configured on `bha-cst` (names only, never values):

- [ ] `DATABASE_URL` — production database connection
- [ ] `VFARM_BASE_URL` / `VFARM_API_BASE_URL` — vFarm upstream
- [ ] `VFARM_FARM_KEY` / `VFARM_API_KEY` — vFarm farm key
- [ ] `VFARM_JWT` / `VFARM_API_JWT` — vFarm admin JWT
- [ ] `VFARM_TENANT_ORG_ID` — vFarm organization UUID
- [ ] `VFARM_ADMIN_EMAIL` / `VFARM_ADMIN_PASSWORD` — vFarm admin login
- [ ] `CST_ADMIN_EMAIL` / `CST_ADMIN_PASSWORD_HASH` — CST admin auth
- [ ] `CST_API_KEY` — programmatic API key
- [ ] `BHARAG_API_URL` — BHARAG API base
- [ ] `BHARAG_CLUSTER_URL` — BHARAG cluster ask URL
- [ ] `BHARAG_CLUSTER_KEY` — BHARAG cluster key
- [ ] `BHARAG_WORKSPACE_KEY` — BHARAG workspace key
- [ ] `DRY_RUN` — confirm value (if `true`, Dashboard publication is suppressed)
- [ ] `NODE_ENV` — should be `production`
- [ ] `VFARM_ELEVENLABS_VOICE_ID` / `ELEVENLABS_VOICE_ID` — voice pointer
- [ ] `VFARM_ELEVENLABS_MODEL_ID` / `ELEVENLABS_MODEL_ID` — voice model

**Do not print values. Confirm presence and non-emptiness only.**

## 6. Post-deployment acceptance steps

After an authorized deployment:

1. [ ] `Outbound background worker starting` appears in logs within 60s of boot.
2. [ ] `Outbound worker heartbeat` appears every 5 minutes with aggregate counts only.
3. [ ] `Durable registry bootstrap confirmed` with `attempts: 1, on_retry: false`.
4. [ ] `GET /health` returns 200 with `{"status":"ok"}`.
5. [ ] `GET /api/health` returns 200 with `vfarm.status: "healthy"` and a measured `latency_ms`.
6. [ ] `GET /health/voice` returns truthful status (503 if no deliveries in 24h).
7. [ ] `GET /api/v1/admin/health/verification` reports `dashboard_publisher.dry_run` correctly.
8. [ ] `GET /debug/state` returns 404 (not exposed in production).
9. [ ] Unknown routes return 404, not a misleading success.
10. [ ] Unauthenticated admin requests return 401.
11. [ ] Unauthenticated vFarm proxy requests return 401 + SECURITY_LEDGER tripwire entry.
12. [ ] Worker heartbeat includes `outcome_unknown` count (requires the fix to be deployed).

## 7. Rollback criteria

Roll back if any of the following occur after deployment:

- Worker heartbeat stops appearing.
- `GET /api/health` returns `unavailable` for more than 3 minutes.
- Twilio callbacks start timing out (11203).
- A customer receives farm data for a farm they are not authorized for.
- A customer receives a fabricated or invented telemetry value.
- The Dashboard stops receiving events when `DRY_RUN` is `false`.
- Any unhandled exception or unhandled rejection appears in logs.

## 8. vFarm user-to-device contract (external dependency)

**Owner:** vFarm team
**Status:** Not implemented upstream. CST cannot solve this.

Required contract:
- A user-to-device/zone/location assignment endpoint.
- Authorization and farm-scope validation.
- Assignment lifecycle (create, move, revoke, stale-binding handling).
- Stable device and farm identifiers.
- Behavior when a user has multiple possible devices.
- Safe behavior when no assignment exists.

Until this contract exists, CST answers farm-level questions (status, device counts, zones) but cannot answer per-device readings ("what's the temperature in bay 4?"). The response honestly states the limitation.

## 9. BHARAG permission boundary (external dependency)

**Owner:** BHARAG / Jegan
**Status:** Proposed, not provisioned.

Required:
- `cst-help` cluster containing only approved help workspaces.
- `cst-help-read` key with `['ask']` permissions only.
- Separate incidents-only key with `['incidents']` permissions.
- Confirmation that the knowledge key cannot access farm workspaces.
- Confirmation of the supported ask request body (whether `workspaceKey`/`workspace` must be removed).
- Permission-boundary evidence without creating a real incident.
