# Required Configuration for Real CST E2E Acceptance Testing

This document tracks the presence and status of environment configuration required to execute real end-to-end tests across SMS, Voice, vFarm, and Dashboard integration channels.

> **Note**: No secrets or credentials are recorded here. Only existence status (`SET`, `MISSING`, `UNKNOWN`) is shown.

---

## 1. Twilio Telephony Configuration

| Configuration Item | Env Variable / Identifier | Status | Notes |
|---|---|---|---|
| Twilio Account SID | `TWILIO_ACCOUNT_SID` | **SET** | Required for SMS dispatch & signature verification |
| Twilio Auth Token | `TWILIO_AUTH_TOKEN` | **SET** | Required for SMS dispatch & webhook signature verification |
| Twilio Messaging Service | `TWILIO_MESSAGING_SERVICE_SID` | **SET** | Twilio pool service identifier |
| Inbound SMS Service Number | Service Number Binding (`+19715885823`) | **SET** | Bound to `tenant-vfarm-01` / `proj-vfarm-main` (`sms`) |
| Inbound Voice Service Number | Service Number Binding (`+19715885825`) | **SET** | Bound to `tenant-vfarm-01` / `proj-vfarm-main` (`voice`) |
| Alternate Inbound SMS Number | Service Number Binding (`+19715885829`) | **SET** | Bound to `tenant-vfarm-01` / `proj-vfarm-main` (`sms`) |
| Dallas Inbound SMS Number | Service Number Binding (`+19715885824`) | **SET** | Bound to `tenant-vfarm-01` / `proj-vfarm-dallas` (`sms`) |

---

## 2. CST Runtime Environment

| Configuration Item | Env Variable / Identifier | Status | Notes |
|---|---|---|---|
| Server Port | `PORT` (3000) | **SET** | Local server listening on `http://localhost:3000` |
| Database Connection | `DATABASE_URL` | **SET** | Local PostgreSQL `postgresql://localhost:5432/bha_cst` |
| Node Environment | `NODE_ENV` | **SET** | Set to `development` |
| Admin UI Authentication | `admin_users` table | **SET** | DB-backed admin user `admin@cst.com` |

---

## 3. vFarm Upstream Integration

| Configuration Item | Env Variable / Identifier | Status | Notes |
|---|---|---|---|
| vFarm Base URL | `VFARM_BASE_URL` | **SET** | `https://bhavfarm1.duckdns.org` |
| vFarm Farm API Key | `VFARM_FARM_KEY` | **SET** | Header `X-Farm-Key` for telemetry/devices |
| vFarm Admin Email | `VFARM_ADMIN_EMAIL` | **SET** | Used to obtain JWT for user/member endpoints |
| vFarm Admin Password | `VFARM_ADMIN_PASSWORD` | **SET** | Used to obtain JWT for user/member endpoints |
| vFarm Tenant Organization | `VFARM_TENANT_ORG_ID` | **SET** | `122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d` |
| Target Live Farm 1 | Discovered via vFarm API | **SET** | `21dde23e-f7f6-46bc-9b54-e97fabaaafd7` ("v-farm", 24 devices) |
| Target Live Farm 2 | Discovered via vFarm API | **SET** | `ed95e120-74c4-4126-a2e9-0e4ffa9275e6` ("Test 001") |

---

## 4. Engine & Connectors

| Configuration Item | Env Variable / Identifier | Status | Notes |
|---|---|---|---|
| BHARAG Knowledge API | `BHARAG_API_URL` | **SET** | `https://bharag2.duckdns.org/api/v1/cluster/ask` |
| ElevenLabs Voice ID | `ELEVENLABS_VOICE_ID` | **SET** | Voice synthesis model identifier |

---

## 5. Dashboard Telemetry

| Configuration Item | Env Variable / Identifier | Status | Notes |
|---|---|---|---|
| Engine Dashboard URL | `ENGINE_DASHBOARD_URL` | **SET** | Ingestion endpoint for `cst.turn` & `cst.delivery` |
| Engine Dashboard Key | `ENGINE_DASHBOARD_KEY` | **SET** | Authorization header for dashboard events |

---

## 6. Real Test User Credentials

| Item | Identifier / Value | Status | Notes |
|---|---|---|---|
| Real vFarm User ID | `debf555c-b37d-4e92-bb15-597e169f1b38` | **SET** | Real upstream user (`admin@vfarm.co`, role `admin`) |
| Real Test Phone (Assigned) | `+923082113844` | **SET** | In CST `customers` registry; mapped to live vFarm user |
| Unknown Test Phone (Unmapped)| `+15559990001` | **SET** | Unregistered test phone for unknown caller validation |
