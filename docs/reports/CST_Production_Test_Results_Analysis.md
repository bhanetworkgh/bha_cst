# CST Production Test Results Analysis (`prod-test-results.json` & Post-PR #23 Live Run)

**Report Date:** 2026-11-02
**Target Service:** `https://bha-cst-7u9e.onrender.com` (`bha-cst`, Render Service ID `srv-db8hepqvcj2c73adpus0`)
**Latest Verified Production Deployment:** `dep-dbkh3p6417fc73bffihg` (PR #23 Merge Commit `441d2b3f4a49c983f45131c229888a60116b9437`, merging `8f2940307e9c946ad7a3b8353ecf5f53368b9933`, live at `2026-11-02T22:43:32.077742Z`)
**Committed Baseline Artifact:** [`prod-test-results.json`](../../prod-test-results.json) (Generated at `2026-11-02T21:55:03Z` on PR #22 `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` by [`scripts/test-prod-all-endpoints.sh`](../../scripts/test-prod-all-endpoints.sh))
**Latest Durable Production Artifact:** [`docs/evidence/prod-test-results-pr23-latest.json`](../evidence/prod-test-results-pr23-latest.json) (Generated at `2026-11-02T22:47:58Z` against `dep-dbkh3p6417fc73bffihg` / `441d2b3f4a49c983f45131c229888a60116b9437` — **`84 PASS, 4 FAIL, 4 DEGRADED, 0 AUTH_BLOCKED, 19 NOT_TESTED`**)

---

## 1. Executive Summary & Multi-Deployment Run Reconciliation

Four production test runs have been executed and reconciled across PR #20 (`656000a7`), PR #22 (`fa701a3`), and PR #23 (`441d2b3f`):

| Metric | Run 1 (PR #20 Baseline)<br>`2026-11-02T21:02:53Z` | Run 2 (PR #20 Warm Probe)<br>`2026-11-02T21:28:11Z` | Run 3 (PR #22, `prod-test-results.json`)<br>`2026-11-02T21:55:03Z` | Run 4 (PR #23 Latest Live Run)<br>`2026-11-02T22:47:58Z` | Net Change (Run 1 -> Run 4) |
|---|---|---|---|---|---|
| **Deployed Commit SHA** | `656000a7b768986feca9d85c7ac9d96c921306c7` | `656000a7b768986feca9d85c7ac9d96c921306c7` | `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` | **`441d2b3f4a49c983f45131c229888a60116b9437`** | PR #21 + PR #22 + PR #23 deployed |
| **Deployment ID** | `dep-dbkep6bm8hqs739a2k80` | `dep-dbkep6bm8hqs739a2k80` | `dep-dbkgavp5efls73ag1olg` | **`dep-dbkh3p6417fc73bffihg`** | Latest Render deployment + `023` DB migration applied |
| **Total Endpoints Evaluated** | `111` | `111` | `111` | **`111`** | `0` |
| **`PASS`** | `74` | `76` | `84` | **`84`** | **`+10 PASS`** |
| **`FAIL`** | `2` | `2` | `4` | **`4`** | **`+2 FAIL`** |
| **`DEGRADED`** | `16` | `14` | `4` | **`4`** | **`-12 DEGRADED`** |
| **`AUTH_BLOCKED`** | `0` | `0` | `0` | **`0`** | `0` |
| **`NOT_TESTED`** | `19` | `19` | `19` | **`19`** | `0` |
| **Canonical Sensor Data State** | Timed out (`502`) | Timed out (`502`) | `200 OK`, Stale (`2026-10-30`), `rack1_ph=25.19` | **`200 OK`, FRESH (<60s old), `rack1_ph=5.06 pH`!** | **Live telemetry restored & calibrated** |

---

## 2. Major New Discovery in Run 4 (`2026-11-02T22:46Z–22:53Z`): Canonical Sensors Are Now Streaming Fresh, Calibrated Live Telemetry

Between Run 3 (`21:55:03Z`) and Run 4 (`22:46Z–22:53Z` on `dep-dbkh3p6417fc73bffihg`), upstream vFarm sensor ingestion resumed and `rack1_ph` calibration was corrected:

| Sensor ID | Run 3 (`21:55:03Z`, PR #22) | Run 4 (`22:46Z–22:53Z`, PR #23 `dep-dbkh3p6417fc73bffihg`) | Improvement |
|---|---|---|---|
| **`rack1_soil`** (#46) | `200 OK` (`522ms`), `0 %`, `2026-10-30T19:33:27Z` (**Stale >74h**) | **`200 OK` (`573ms`), `90.0 %` (`status: "ok"`), `reading_ts: 2026-11-02T22:48:50Z`** | **Fresh (<2s old) & valid** |
| **`rack1_ph`** (#49) | `200 OK` (`503ms`), `25.19 pH`, `2026-10-30T19:33:27Z` (**Stale & uncalibrated >14 pH**) | **`200 OK` (`494ms`), `5.06 pH` (`status: "ok"`), `reading_ts: 2026-11-02T22:48:56Z`** | **Fresh (<2s old) & calibrated within 0–14 pH scale!** |
| **`rack2_dht`** (#52) | `200 OK` (`498ms`), `26.8 °C / 67.3%`, `2026-10-30T19:33:27Z` (**Stale >74h**) | **`200 OK` (`529ms`), `28.8 °C / 63% RH` (`status: "ok"`), `reading_ts: 2026-11-02T22:52:29Z`** | **Fresh (<60s old) & valid** |
| **`rack1_mq7`** (#55) | `200 OK` (`505ms`), `201 ppm`, `2026-10-30T19:33:27Z` (**Stale >74h**) | **`200 OK` (`526ms`), `0.76 ppm` (`status: "ok"`), `reading_ts: 2026-11-02T22:48:59Z`** | **Fresh (<15s old) & valid** |

---

## 3. Exact Reconciliation of Changed Classifications Across Runs

### 3.1 Run 1 (`74 PASS / 2 FAIL / 16 DEGRADED`) -> Run 2 (`76 PASS / 2 FAIL / 14 DEGRADED`)
1. **Test #48 (`GET /api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5`):** Changed from `DEGRADED` (`HTTP 502`, `5,451ms`) to `PASS` (`HTTP 200`).
2. **Test #51 (`GET /api/v1/admin/vfarm/readings?sensor_id=rack2_dht&limit=5`):** Changed from `DEGRADED` (`HTTP 502`, `5,442ms`) to `PASS` (`HTTP 200`).

### 3.2 Run 1 (`74 PASS / 2 FAIL / 16 DEGRADED`) -> Run 3 & Run 4 (`84 PASS / 4 FAIL / 4 DEGRADED`)
Exactly **16 endpoints changed classification** between Run 1 (`21:02:53Z` on PR #20 `656000a7`) and Runs 3/4 (`84 PASS / 4 FAIL / 4 DEGRADED` on PR #22 `fa701a3` and PR #23 `441d2b3f`):

| Test # | Endpoint Path | Run 1 (PR #20) | Run 3 (PR #22) | Run 4 (PR #23 Latest) | Exact Technical Cause of Change |
|---|---|---|---|---|---|
| **#3** | `GET /api/health` | `PASS` (`200`, `321ms`, `status:"degraded"`) | **`DEGRADED`** (`200`, `1,305ms`, `status:"unknown"`) | **`DEGRADED`** (`200`, `592ms`, `status:"unknown"`) | Both Run 3 and Run 4 started immediately after a fresh container deploy (`dep-dbkgavp5efls73ag1olg` and `dep-dbkh3p6417fc73bffihg`). On a cold container before Phase 4/5 admin routes call `ensureAdminToken()`, `getHealth()` probes with the static env `VFARM_JWT` (`exp: 1792785924`, expired `2026-10-23`), receiving HTTP 401 (`probe_failed:auth`). Immediately after Run 4 warmed `this.adminJwt`, `GET /api/health` returned `api_reachability.status: "healthy"` (`889ms`). |
| **#46** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_soil` | `DEGRADED` (`502`, `5,436ms`) | **`PASS`** (`200`, `522ms`) | **`PASS`** (`200`, `573ms`) | Switched `getLatestReading()` from `/api/v1/readings/latest` to interim `/api/v1/readings?sensor_id=rack1_soil&limit=1`. |
| **#47** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` | `DEGRADED` (`502`, `5,429ms`) | **`FAIL`** (`000000`, `12,059ms`) | **`FAIL`** (`000000`, `12,053ms`) | `VFARM_READINGS_STATS_TIMEOUT_MS` (`30,000ms`) exceeds `test-prod-all-endpoints.sh`'s `curl --max-time 12` timeout (`status=000000`). |
| **#48** | `GET /api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5` | `DEGRADED` (`502`, `5,451ms`) | **`PASS`** (`200`, `759ms`) | **`PASS`** (`200`, `557ms`) | `VFARM_READINGS_LIST_TIMEOUT_MS` raised to `15,000ms`; vFarm responded in `557ms`. |
| **#49** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_ph` | `DEGRADED` (`502`, `5,427ms`) | **`PASS`** (`200`, `503ms`) | **`PASS`** (`200`, `494ms`) | Switched `getLatestReading()` to interim `/api/v1/readings?sensor_id=rack1_ph&limit=1` (`5.06 pH`). |
| **#50** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_ph&window=24h` | `DEGRADED` (`502`, `5,431ms`) | **`FAIL`** (`000000`, `12,059ms`) | **`FAIL`** (`000000`, `12,055ms`) | `30,000ms` stats timeout exceeded `curl --max-time 12` (`status=000000`). |
| **#51** | `GET /api/v1/admin/vfarm/readings?sensor_id=rack2_dht&limit=5` | `DEGRADED` (`502`, `5,442ms`) | **`PASS`** (`200`, `1,139ms`) | **`PASS`** (`200`, `514ms`) | Upstream `/api/v1/readings` responded in `514ms`. |
| **#52** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack2_dht` | `DEGRADED` (`502`, `5,431ms`) | **`PASS`** (`200`, `498ms`) | **`PASS`** (`200`, `529ms`) | Switched `getLatestReading()` to interim `/api/v1/readings?sensor_id=rack2_dht&limit=1` (`28.8 °C / 63% RH`). |
| **#53** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack2_dht&window=24h` | `DEGRADED` (`502`, `5,433ms`) | **`FAIL`** (`000000`, `12,043ms`) | **`FAIL`** (`000000`, `12,055ms`) | `30,000ms` stats timeout exceeded `curl --max-time 12` (`status=000000`). |
| **#54** | `GET /api/v1/admin/vfarm/readings?sensor_id=rack1_mq7&limit=5` | `DEGRADED` (`502`, `5,451ms`) | **`PASS`** (`200`, `828ms`) | **`PASS`** (`200`, `530ms`) | Upstream `/api/v1/readings` responded in `530ms`. |
| **#55** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_mq7` | `DEGRADED` (`502`, `5,429ms`) | **`PASS`** (`200`, `505ms`) | **`PASS`** (`200`, `526ms`) | Switched `getLatestReading()` to interim `/api/v1/readings?sensor_id=rack1_mq7&limit=1` (`0.76 ppm`). |
| **#56** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_mq7&window=24h` | `DEGRADED` (`502`, `5,431ms`) | **`FAIL`** (`000000`, `12,058ms`) | **`FAIL`** (`000000`, `12,055ms`) | `30,000ms` stats timeout exceeded `curl --max-time 12` (`status=000000`). |
| **#61** | `GET /api/v1/devices` | `DEGRADED` (`500`, `6,023ms`) | **`PASS`** (`200`, `1,200ms`) | **`PASS`** (`200`, `904ms`) | Interim latest-reading fallback eliminated the `5,000ms` timeout inside `pullStatuses()`. |
| **#63** | `GET /api/devices` | `DEGRADED` (`500`, `5,442ms`) | **`PASS`** (`200`, `1,657ms`) | **`PASS`** (`200`, `957ms`) | Same fix as #61 (alias route for `pullStatuses()`). |
| **#65** | `GET /api/v1/farms` | `FAIL` (`500`, `5,442ms`) | **`PASS`** (`200`, `585ms`) | **`PASS`** (`200`, `1,069ms`) | Interim latest-reading fallback eliminated the `5,000ms` timeout inside `discoverFarms()`. |
| **#67** | `GET /api/farms` | `FAIL` (`500`, `5,436ms`) | **`PASS`** (`200`, `2,979ms`) | **`PASS`** (`200`, `829ms`) | Same fix as #65 (alias route for `discoverFarms()`). |

---

## 4. Detailed Breakdown of All Non-PASS Endpoints (4 `FAIL`, 4 `DEGRADED`)

### 4.1 The 4 `FAIL` Endpoints (`status=000000` Client Abort at 12s)

| Test # | Endpoint | Status | Run 4 Latency | Root Cause Layer | Explanation |
|---|---|---|---|---|---|
| **#47** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` | `000000` | `12,053 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Upstream vFarm `GET /api/v1/readings/stats` performs an unindexed 24h aggregation scan across `6.71M+` rows taking `>12s`. Because CST's upstream timeout (`VFARM_READINGS_STATS_TIMEOUT_MS`) is `30,000ms` while `scripts/test-prod-all-endpoints.sh` uses `curl -m 12`, curl aborts at 12s with `000000` before CST's 30s timeout returns `502`. |
| **#50** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_ph&window=24h` | `000000` | `12,055 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Same as #47 for `rack1_ph`. |
| **#53** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack2_dht&window=24h` | `000000` | `12,055 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Same as #47 for `rack2_dht`. |
| **#56** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_mq7&window=24h` | `000000` | `12,055 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Same as #47 for `rack1_mq7`. |

### 4.2 The 4 `DEGRADED` Endpoints

| Test # | Endpoint | Status | Run 4 Latency | Root Cause Layer | Explanation |
|---|---|---|---|---|---|
| **#3** | `GET /api/health` | `200` | `592 ms` | **Cold-Boot Static `VFARM_JWT` Expiry + `getHealth()` Pure Read Design** | Returns HTTP 200 with `api_reachability.status: "unavailable", reason: "probe_failed:auth"` on a cold container because static `VFARM_JWT` expired `2026-10-23T20:05:24Z` and `getHealth()` does not trigger `ensureAdminToken()` login until Phase 4/5 admin routes run. Once warmed (`22:48:18Z`), `GET /api/health` returns `api_reachability.status: "healthy"` (`889ms`) and `farm_health.status: "degraded"` (`raw_status: "neutral"`). |
| **#42** | `GET /api/v1/admin/vfarm/system-stats` | `000000` | `12,058 ms` | **Upstream vFarm API Timeout** | Upstream `GET /api/v1/system/stats` times out (`>12s`) performing full-table counts across `6.71M+` readings rows. |
| **#43** | `GET /api/v1/admin/vfarm/alerts/counts` | `422` | `1,303 ms` | **Upstream vFarm FastAPI Router Bug** | Upstream `GET /api/v1/alerts/threshold/counts` returns HTTP `422 Unprocessable Entity` because FastAPI matches `"counts"` against `/alerts/threshold/{rule_id}` (UUID). |
| **#44** | `GET /api/v1/admin/vfarm/vision/latest` | `422` | `785 ms` | **Upstream vFarm Configuration** | Upstream vFarm returns HTTP `422` because no vision cameras are configured for the active farm. |

---

## 5. Complete 111-Endpoint Production Verification Matrix (Run 4 on PR #23 `dep-dbkh3p6417fc73bffihg`)

| # | Method | Path | Auth Mode | Expected | Actual | Latency (ms) | Classification | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `GET` | `/health` | `public` | `200` | `200` | `485` | `PASS` | Liveness probe OK |
| 2 | `GET` | `/health/voice` | `public` | `200/503` | `200` | `462` | `PASS` | Voice lane healthy (`voice_id: Hmy9...esiM`) |
| 3 | `GET` | `/api/health` | `public` | `200` | `200` | `592` | `DEGRADED` | Cold-boot `probe_failed:auth`; warm check (`22:48:18Z`) confirms `api_reachability: healthy` (`889ms`) and `research_twin: blocked` (`missing: []`) |
| 4 | `GET` | `/` | `public` | `200/302` | `302` | `409` | `PASS` | Root redirects to `/api-docs` |
| 5 | `GET` | `/api-docs/` | `public` | `200` | `200` | `412` | `PASS` | Swagger UI documentation served |
| 6 | `GET` | `/web` | `public` | `200` | `200` | `414` | `PASS` | Web chat interface served |
| 7 | `GET` | `/admin/login` | `public` | `200` | `200` | `419` | `PASS` | Admin login page served |
| 8 | `GET` | `/admin` | `public` | `200/302` | `200` | `444` | `PASS` | Admin dashboard UI served |
| 9 | `GET` | `/api-docs.json` | `public` | `200` | `200` | `449` | `PASS` | OpenAPI 3.0.3 spec served |
| 10 | `GET` | `/debug/state` | `public` | `404` | `404` | `418` | `PASS` | Correctly disabled in production (404) |
| 11 | `GET` | `/favicon.ico` | `public` | `204` | `204` | `407` | `PASS` | Favicon handler OK |
| 12 | `POST` | `/api/v1/auth/login (bad creds)` | `public` | `401` | `401` | `434` | `PASS` | Invalid credentials rejected (401) |
| 13 | `POST` | `/api/v1/auth/login (valid)` | `public` | `200` | `200` | `438` | `PASS` | Authenticated successfully |
| 14 | `GET` | `/api/v1/auth/me (unauth)` | `none` | `401` | `401` | `414` | `PASS` | Unauthenticated access properly blocked (401) |
| 15 | `GET` | `/api/v1/auth/me` | `x-admin-token` | `200` | `200` | `437` | `PASS` | Session validated successfully |
| 16 | `GET` | `/api/v1/admin/tenants` | `x-admin-token` | `200/404` | `200` | `428` | `PASS` | Admin core endpoint responded OK |
| 17 | `GET` | `/api/v1/admin/projects` | `x-admin-token` | `200/404` | `200` | `424` | `PASS` | Admin core endpoint responded OK |
| 18 | `GET` | `/api/v1/admin/numbers/bindings` | `x-admin-token` | `200/404` | `200` | `425` | `PASS` | Admin core endpoint responded OK |
| 19 | `GET` | `/api/v1/admin/numbers/candidate` | `x-admin-token` | `200/404` | `200` | `423` | `PASS` | Admin core endpoint responded OK |
| 20 | `GET` | `/api/v1/admin/health/verification` | `x-admin-token` | `200/404` | `200` | `661` | `PASS` | Admin core endpoint responded OK |
| 21 | `GET` | `/api/v1/admin/dashboard-publisher/status` | `x-admin-token` | `200/404` | `200` | `454` | `PASS` | Admin core endpoint responded OK |
| 22 | `GET` | `/api/v1/admin/speakers` | `x-admin-token` | `200/404` | `200` | `425` | `PASS` | Admin core endpoint responded OK |
| 23 | `GET` | `/api/v1/admin/audit/logs` | `x-admin-token` | `200/404` | `200` | `429` | `PASS` | Admin core endpoint responded OK |
| 24 | `GET` | `/api/v1/admin/dashboard` | `x-admin-token` | `200/404` | `200` | `1240` | `PASS` | Admin core endpoint responded OK |
| 25 | `GET` | `/api/v1/admin/sms-consent/wording` | `x-admin-token` | `200/404` | `200` | `427` | `PASS` | Admin core endpoint responded OK |
| 26 | `GET` | `/api/v1/admin/sms-consent` | `x-admin-token` | `200/404` | `200` | `434` | `PASS` | Admin core endpoint responded OK |
| 27 | `GET` | `/api/v1/admin/sms-consent/%2B19715885823?tenant_id=tenant-vfarm-01` | `x-admin-token` | `200/404` | `200` | `430` | `PASS` | Admin core endpoint responded OK |
| 28 | `GET` | `/api/v1/admin/sms-consent/%2B19715885823/history?tenant_id=tenant-vfarm-01` | `x-admin-token` | `200/404` | `200` | `425` | `PASS` | Admin core endpoint responded OK |
| 29 | `GET` | `/api/v1/admin/vfarm/farms` | `x-admin-token` | `200` | `200` | `527` | `PASS` | Returns `Test 001` (`0` devices) and `v-farm` (`23` devices) |
| 30 | `GET` | `/api/v1/admin/vfarm/dashboard` | `x-admin-token` | `200` | `200` | `1027` | `PASS` | vFarm proxy responded OK |
| 31 | `GET` | `/api/v1/admin/vfarm/health` | `x-admin-token` | `200` | `200` | `677` | `PASS` | vFarm proxy responded OK |
| 32 | `GET` | `/api/v1/admin/vfarm/summary` | `x-admin-token` | `200` | `200` | `839` | `PASS` | vFarm proxy responded OK |
| 33 | `GET` | `/api/v1/admin/vfarm/organizations` | `x-admin-token` | `200` | `200` | `835` | `PASS` | vFarm proxy responded OK |
| 34 | `GET` | `/api/v1/admin/vfarm/layout` | `x-admin-token` | `200` | `200` | `536` | `PASS` | vFarm proxy responded OK |
| 35 | `GET` | `/api/v1/admin/vfarm/zones` | `x-admin-token` | `200` | `200` | `530` | `PASS` | vFarm proxy responded OK |
| 36 | `GET` | `/api/v1/admin/vfarm/devices` | `x-admin-token` | `200` | `200` | `1050` | `PASS` | vFarm proxy responded OK (`0` devices on default `Test 001` farm; `23` on `v-farm`) |
| 37 | `GET` | `/api/v1/admin/vfarm/alerts/open` | `x-admin-token` | `200` | `200` | `527` | `PASS` | vFarm proxy responded OK |
| 38 | `GET` | `/api/v1/admin/vfarm/alerts/history` | `x-admin-token` | `200` | `200` | `805` | `PASS` | vFarm proxy responded OK |
| 39 | `GET` | `/api/v1/admin/vfarm/customers?org_id=122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d` | `x-admin-token` | `200` | `200` | `1101` | `PASS` | vFarm proxy responded OK |
| 40 | `GET` | `/api/v1/admin/vfarm/users?org_id=122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d` | `x-admin-token` | `200` | `200` | `781` | `PASS` | vFarm proxy responded OK |
| 41 | `GET` | `/api/v1/admin/turn-stream` | `x-admin-token` | `200` | `200` | `425` | `PASS` | Turn stream SSE/snapshot responded OK |
| 42 | `GET` | `/api/v1/admin/vfarm/system-stats` | `x-admin-token` | `200` | `000000` | `12058` | `DEGRADED` | Upstream vFarm timeout on `/api/v1/system/stats` |
| 43 | `GET` | `/api/v1/admin/vfarm/alerts/counts` | `x-admin-token` | `200` | `422` | `1303` | `DEGRADED` | Upstream vFarm returns 422 on `/api/v1/alerts/threshold/counts` |
| 44 | `GET` | `/api/v1/admin/vfarm/vision/latest` | `x-admin-token` | `200` | `422` | `785` | `DEGRADED` | Upstream vFarm returns 422 (no cameras configured for active farm) |
| 45 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack1_soil&limit=5` | `x-admin-token` | `200` | `200` | `518` | `PASS` | Historical readings retrieved OK |
| 46 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_soil` | `x-admin-token` | `200` | `200` | `573` | `PASS` | **Fresh live reading (`90.0 %`, `2026-11-02T22:46:32Z`)** |
| 47 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` | `x-admin-token` | `200` | `000000` | `12053` | `FAIL` | Reading stats failed with `000000` (`curl -m 12` abort during 30s upstream scan) |
| 48 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5` | `x-admin-token` | `200` | `200` | `557` | `PASS` | Historical readings retrieved OK |
| 49 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_ph` | `x-admin-token` | `200` | `200` | `494` | `PASS` | **Fresh & calibrated live reading (`5.06 pH`, `2026-11-02T22:46:47Z`)** |
| 50 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_ph&window=24h` | `x-admin-token` | `200` | `000000` | `12055` | `FAIL` | Reading stats failed with `000000` (`curl -m 12` abort) |
| 51 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack2_dht&limit=5` | `x-admin-token` | `200` | `200` | `514` | `PASS` | Historical readings retrieved OK |
| 52 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack2_dht` | `x-admin-token` | `200` | `200` | `529` | `PASS` | **Fresh live reading (`28.8 °C / 63% RH`, `2026-11-02T22:47:02Z`)** |
| 53 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack2_dht&window=24h` | `x-admin-token` | `200` | `000000` | `12055` | `FAIL` | Reading stats failed with `000000` (`curl -m 12` abort) |
| 54 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack1_mq7&limit=5` | `x-admin-token` | `200` | `200` | `530` | `PASS` | Historical readings retrieved OK |
| 55 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_mq7` | `x-admin-token` | `200` | `200` | `526` | `PASS` | **Fresh live reading (`0.76 ppm`, `2026-11-02T22:47:14Z`)** |
| 56 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_mq7&window=24h` | `x-admin-token` | `200` | `000000` | `12055` | `FAIL` | Reading stats failed with `000000` (`curl -m 12` abort) |
| 57 | `GET` | `/api/v1/dashboard` | `x-admin-token` | `200` | `200` | `1344` | `PASS` | Authenticated proxy OK |
| 58 | `GET` | `/api/v1/dashboard (unauth)` | `none` | `401` | `401` | `412` | `PASS` | Unauthenticated access properly blocked (401) |
| 59 | `GET` | `/api/dashboard` | `x-admin-token` | `200` | `200` | `1027` | `PASS` | Authenticated proxy OK |
| 60 | `GET` | `/api/dashboard (unauth)` | `none` | `401` | `401` | `410` | `PASS` | Unauthenticated access properly blocked (401) |
| 61 | `GET` | `/api/v1/devices` | `x-admin-token` | `200` | `200` | `904` | `PASS` | Authenticated proxy OK |
| 62 | `GET` | `/api/v1/devices (unauth)` | `none` | `401` | `401` | `414` | `PASS` | Unauthenticated access properly blocked (401) |
| 63 | `GET` | `/api/devices` | `x-admin-token` | `200` | `200` | `957` | `PASS` | Authenticated proxy OK |
| 64 | `GET` | `/api/devices (unauth)` | `none` | `401` | `401` | `415` | `PASS` | Unauthenticated access properly blocked (401) |
| 65 | `GET` | `/api/v1/farms` | `x-admin-token` | `200` | `200` | `1069` | `PASS` | Authenticated proxy OK |
| 66 | `GET` | `/api/v1/farms (unauth)` | `none` | `401` | `401` | `410` | `PASS` | Unauthenticated access properly blocked (401) |
| 67 | `GET` | `/api/farms` | `x-admin-token` | `200` | `200` | `829` | `PASS` | Authenticated proxy OK |
| 68 | `GET` | `/api/farms (unauth)` | `none` | `401` | `401` | `425` | `PASS` | Unauthenticated access properly blocked (401) |
| 69 | `POST` | `/api/v1/web/session` | `none` | `501` | `501` | `414` | `PASS` | Enforces `PRODUCTION_AUTH_REQUIRED` (501) |
| 70 | `GET` | `/api/v1/web/projects` | `public` | `200` | `200` | `416` | `PASS` | Web projects listed |
| 71 | `GET` | `/api/v1/web/session (no cookie)` | `none` | `401` | `401` | `410` | `PASS` | Unauthenticated web session blocked |
| 72 | `POST` | `/audio/speak (no key)` | `none` | `401` | `401` | `419` | `PASS` | Fail-closed without API key (401) |
| 73 | `POST` | `/audio/speak (bad key)` | `x-cst-api-key` | `403` | `403` | `411` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 74 | `POST` | `/voice/turn (no key)` | `none` | `401` | `401` | `414` | `PASS` | Fail-closed without API key (401) |
| 75 | `POST` | `/voice/turn (bad key)` | `x-cst-api-key` | `403` | `403` | `411` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 76 | `POST` | `/api/v1/voice/turn (no key)` | `none` | `401` | `401` | `415` | `PASS` | Fail-closed without API key (401) |
| 77 | `POST` | `/api/v1/voice/turn (bad key)` | `x-cst-api-key` | `403` | `403` | `417` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 78 | `POST` | `/api/v1/voice/synthesize (no key)` | `none` | `401` | `401` | `413` | `PASS` | Fail-closed without API key (401) |
| 79 | `POST` | `/api/v1/voice/synthesize (bad key)` | `x-cst-api-key` | `403` | `403` | `413` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 80 | `GET` | `/api/v1/voice/audio/:id` | `public` | `404` | `404` | `412` | `PASS` | Correctly returns `AUDIO_NOT_FOUND` |
| 81 | `POST` | `/webhooks/twilio/sms (unauthenticated)` | `none` | `401/403` | `401` | `417` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 82 | `POST` | `/webhooks/twilio/delivery-status (unauthenticated)` | `none` | `401/403` | `401` | `415` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 83 | `POST` | `/webhooks/twilio/voice (unauthenticated)` | `none` | `401/403` | `401` | `411` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 84 | `POST` | `/webhooks/twilio/voice/inbound (unauthenticated)` | `none` | `401/403` | `401` | `412` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 85 | `POST` | `/twilio/voice (unauthenticated)` | `none` | `401/403` | `401` | `414` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 86 | `POST` | `/twilio/voice/inbound (unauthenticated)` | `none` | `401/403` | `401` | `417` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 87 | `POST` | `/webhooks/twilio/voice/turn (unauthenticated)` | `none` | `401/403` | `401` | `418` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 88 | `POST` | `/twilio/voice/turn (unauthenticated)` | `none` | `401/403` | `401` | `414` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 89 | `POST` | `/webhooks/twilio/voice/status (unauthenticated)` | `none` | `401/403` | `401` | `415` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 90 | `POST` | `/twilio/voice/status (unauthenticated)` | `none` | `401/403` | `401` | `415` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 91 | `POST` | `/api/v1/voice/status (unauthenticated)` | `none` | `401/403` | `401` | `412` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 92–110 | `POST/PATCH/DELETE` | Mutating Admin / Web / Voice Synthesis Routes (19 endpoints) | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in read-only audit (zero-mutation rule) |
| 111 | `POST` | `/api/v1/auth/logout` | `x-admin-token` | `200` | `200` | `428` | `PASS` | Admin session token revoked cleanly |
