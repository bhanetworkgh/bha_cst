# Admin Dashboard — vFarm Live E2E

## Prerequisites

1. **CST server** running with live vFarm credentials in `.env`:
   - `VFARM_FARM_KEY` — farm-scoped key (`X-Farm-Key` on upstream calls)
   - `VFARM_BASE_URL` — defaults to `https://bhavfarm1.duckdns.org`
   - Optional: `VFARM_JWT` for organization listing
2. **Admin login** — DB `admin_users` or in-memory `CST_ADMIN_EMAIL` / `CST_ADMIN_PASSWORD_HASH`

## UI verification (section by section)

1. Start the engine: `npm run dev`
2. Open [http://localhost:3000/admin/login](http://localhost:3000/admin/login) and sign in.
3. Open tab **7 · vFarm Live E2E**.
4. Choose a farm in **Farm context** (e.g. production `21dde23e-f7f6-46bc-9b54-e97fabaaafd7`).
5. Click **Test** on each card (Dashboard, Farms, Devices, Telemetry, Alerts, Layout, Organizations, Vision), or **Run All Checks**.
6. Each card shows **PASS/FAIL** and a JSON snippet — save screenshots or copy JSON as evidence.

The overview tab (**1 · Overview**) also loads the vFarm telemetry panel via the same `/api/v1/admin/vfarm/farms` and `/vfarm/dashboard` routes.

## CLI verification (same routes as the UI)

Direct vFarm API (no CST):

```bash
VFARM_FARM_KEY="your_key" ./scripts/verify_vfarm_live.sh
```

Admin proxy layer (requires running CST + admin session):

```bash
chmod +x scripts/verify_admin_vfarm_e2e.sh
CST_BASE_URL=http://localhost:3000 \
CST_ADMIN_EMAIL=your@email \
CST_ADMIN_PASSWORD=your_password \
./scripts/verify_admin_vfarm_e2e.sh
```

Optional farm override:

```bash
VFARM_LIVE_FARM_ID=21dde23e-f7f6-46bc-9b54-e97fabaaafd7 ./scripts/verify_admin_vfarm_e2e.sh
```

## CI (mocked upstream)

```bash
npm test -- tests/integration/admin_vfarm_e2e.test.ts
```
