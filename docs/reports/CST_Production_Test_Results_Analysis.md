# CST Production Test Results Analysis (`prod-test-results.json`)

**Report Date:** 2026-11-02
**Target Service:** `https://bha-cst-7u9e.onrender.com` (`bha-cst`, Render Service ID `srv-db8hepqvcj2c73adpus0`)
**Deployed Production Commit Tested:** `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` (PR #22, Deployment ID `dep-dbkgavp5efls73ag1olg`, live at `2026-11-02T21:51:02Z`)
**Source Artifact:** [`prod-test-results.json`](file:///Users/HaMi/Documents/Jason/customer%20twin/prod-test-results.json) (Generated at `2026-11-02T21:55:03Z` by [`scripts/test-prod-all-endpoints.sh`](file:///Users/HaMi/Documents/Jason/customer%20twin/scripts/test-prod-all-endpoints.sh))
**Latest Live Research Twin Verification (`GET /api/health`):** `2026-11-02T22:25:18.754Z` (`endpoint_configured: true, service_api_key_configured: true, callback_signing_secret_configured: true, missing: [], state: "blocked"`)

---

## 1. Executive Summary & Historical Run Reconciliation

Three production test runs were recorded across the PR #20 (`656000a7b768986feca9d85c7ac9d96c921306c7`) and PR #22 (`fa701a3f7e2a4c642307d018f9a4a123cc6007d3`) deployments, followed by the live Research Twin configuration probe at `2026-11-02T22:25:18.754Z`:

| Metric | Run 1 (PR #20 Baseline)<br>`2026-11-02T21:02:53Z` | Run 2 (PR #20 Warm Probe)<br>`2026-11-02T21:28:11Z` | Run 3 (Current `prod-test-results.json`, PR #22)<br>`2026-11-02T21:55:03Z` | Net Change (Run 1 -> Run 3) |
|---|---|---|---|---|
| **Deployed Commit SHA** | `656000a7b768986feca9d85c7ac9d96c921306c7` | `656000a7b768986feca9d85c7ac9d96c921306c7` | `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` | PR #21 + PR #22 deployed |
| **Deployment ID** | `dep-dbkep6bm8hqs739a2k80` | `dep-dbkep6bm8hqs739a2k80` | `dep-dbkgavp5efls73ag1olg` | New Render deployment |
| **Total Endpoints Evaluated** | `111` | `111` | `111` | `0` |
| **`PASS`** | `74` | `76` | **`84`** | **`+10 PASS`** |
| **`FAIL`** | `2` | `2` | **`4`** | **`+2 FAIL`** |
| **`DEGRADED`** | `16` | `14` | **`4`** | **`-12 DEGRADED`** |
| **`AUTH_BLOCKED`** | `0` | `0` | **`0`** | `0` |
| **`NOT_TESTED`** | `19` | `19` | **`19`** | `0` |
| **Script Final Verdict** | `PRODUCTION API FAILING` | `PRODUCTION API FAILING` | `PRODUCTION API FAILING` | Unchanged (due to >0 `FAIL`) |

---

## 2. Exact Reconciliation of Changed Classifications Across Runs

### 2.1 Run 1 (`74 PASS / 2 FAIL / 16 DEGRADED`) -> Run 2 (`76 PASS / 2 FAIL / 14 DEGRADED`)
On the PR #20 deployment (`656000a7`), two upstream historical sensor reading endpoints completed under the 5,000ms timeout threshold when the vFarm database cache was warm:
1. **Test #48 (`GET /api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5`):** Changed from `DEGRADED` (`HTTP 502`, `5,451ms`) to `PASS` (`HTTP 200`).
2. **Test #51 (`GET /api/v1/admin/vfarm/readings?sensor_id=rack2_dht&limit=5`):** Changed from `DEGRADED` (`HTTP 502`, `5,442ms`) to `PASS` (`HTTP 200`).

### 2.2 Run 1 (`74 PASS / 2 FAIL / 16 DEGRADED`) -> Run 3 (`84 PASS / 4 FAIL / 4 DEGRADED` in `prod-test-results.json`)
Exactly **16 endpoints changed classification** between Run 1 (`21:02:53Z` on PR #20 `656000a7`) and Run 3 (`21:55:03Z` on PR #22 `fa701a3`):

| Test # | Endpoint Path in `prod-test-results.json` | Run 1 (`21:02:53Z`, PR #20) | Run 3 (`21:55:03Z`, PR #22) | Exact Technical Cause of Change |
|---|---|---|---|---|
| **#3** | `GET /api/health` | `PASS` (`200`, `321ms`, `status:"degraded"`) | **`DEGRADED`** (`200`, `1,305ms`, `status:"unknown"`) | Run 3 started at `21:52:52Z`, just 1m50s after `dep-dbkgavp5efls73ag1olg` booted (`21:51:02Z`). On a cold container before any admin endpoint calls `ensureAdminToken()`, `getHealth()` uses the static env `VFARM_JWT` (`exp: 1792785924`, expired `2026-10-23`), which receives HTTP 401 (`probe_failed:auth`) from vFarm. |
| **#46** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_soil` | `DEGRADED` (`502`, `5,436ms`) | **`PASS`** (`200`, `522ms`) | PR #22 (`dd71308` / `fa701a3`) switched `getLatestReading()` from `/api/v1/readings/latest` to the interim `/api/v1/readings?sensor_id=rack1_soil&limit=1` endpoint. |
| **#47** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` | `DEGRADED` (`502`, `5,429ms`) | **`FAIL`** (`000000`, `12,059ms`) | PR #22 raised `VFARM_READINGS_STATS_TIMEOUT_MS` from `5,000ms` to `30,000ms`, exceeding `test-prod-all-endpoints.sh`'s `curl --max-time 12` timeout (`status=000000`). |
| **#48** | `GET /api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5` | `DEGRADED` (`502`, `5,451ms`) | **`PASS`** (`200`, `759ms`) | PR #22 raised `VFARM_READINGS_LIST_TIMEOUT_MS` to `15,000ms` and vFarm responded in `759ms`. |
| **#49** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_ph` | `DEGRADED` (`502`, `5,427ms`) | **`PASS`** (`200`, `503ms`) | PR #22 switched `getLatestReading()` to interim `/api/v1/readings?sensor_id=rack1_ph&limit=1`. |
| **#50** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_ph&window=24h` | `DEGRADED` (`502`, `5,431ms`) | **`FAIL`** (`000000`, `12,059ms`) | PR #22 `30,000ms` stats timeout exceeded `curl --max-time 12` (`status=000000`). |
| **#51** | `GET /api/v1/admin/vfarm/readings?sensor_id=rack2_dht&limit=5` | `DEGRADED` (`502`, `5,442ms`) | **`PASS`** (`200`, `1,139ms`) | Upstream `/api/v1/readings` responded in `1,139ms`. |
| **#52** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack2_dht` | `DEGRADED` (`502`, `5,431ms`) | **`PASS`** (`200`, `498ms`) | PR #22 switched `getLatestReading()` to interim `/api/v1/readings?sensor_id=rack2_dht&limit=1`. |
| **#53** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack2_dht&window=24h` | `DEGRADED` (`502`, `5,433ms`) | **`FAIL`** (`000000`, `12,043ms`) | PR #22 `30,000ms` stats timeout exceeded `curl --max-time 12` (`status=000000`). |
| **#54** | `GET /api/v1/admin/vfarm/readings?sensor_id=rack1_mq7&limit=5` | `DEGRADED` (`502`, `5,451ms`) | **`PASS`** (`200`, `828ms`) | Upstream `/api/v1/readings` responded in `828ms`. |
| **#55** | `GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_mq7` | `DEGRADED` (`502`, `5,429ms`) | **`PASS`** (`200`, `505ms`) | PR #22 switched `getLatestReading()` to interim `/api/v1/readings?sensor_id=rack1_mq7&limit=1`. |
| **#56** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_mq7&window=24h` | `DEGRADED` (`502`, `5,431ms`) | **`FAIL`** (`000000`, `12,058ms`) | PR #22 `30,000ms` stats timeout exceeded `curl --max-time 12` (`status=000000`). |
| **#61** | `GET /api/v1/devices` | `DEGRADED` (`500`, `6,023ms`) | **`PASS`** (`200`, `1,200ms`) | PR #22 interim latest reading fallback eliminated the `5,000ms` per-sensor timeout inside `pullStatuses()`, allowing `/api/v1/devices` to succeed in `1,200ms`. |
| **#63** | `GET /api/devices` | `DEGRADED` (`500`, `5,442ms`) | **`PASS`** (`200`, `1,657ms`) | Same fix as #61 (alias route for `pullStatuses()`). |
| **#65** | `GET /api/v1/farms` | `FAIL` (`500`, `5,442ms`) | **`PASS`** (`200`, `585ms`) | PR #22 interim latest reading fallback eliminated the `5,000ms` timeout inside `discoverFarms()`. |
| **#67** | `GET /api/farms` | `FAIL` (`500`, `5,436ms`) | **`PASS`** (`200`, `2,979ms`) | Same fix as #65 (alias route for `discoverFarms()`). |

### 2.3 Post-Run Live Update (`2026-11-02T22:25:18.754Z`): Research Twin Credentials Added on Render
After `prod-test-results.json` was generated at `21:55:03Z`, `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` were added to Render (`bha-cst`). Live probe of `GET /api/health` at `22:25:18.754Z` confirmed:
- `research_twin.endpoint_configured: true`
- `research_twin.service_api_key_configured: true`
- `research_twin.callback_signing_secret_configured: true`
- `research_twin.missing: []`
- `research_twin.state: "blocked"` (upgraded from `"unavailable"`; awaiting Destiny Arupi wire-contract verification before flipping `operational: true`).

---

## 3. Detailed Breakdown of All Non-PASS Endpoints in `prod-test-results.json`

### 3.1 The 4 `FAIL` Endpoints (`status=000000` Client Abort at 12s)

| Test # | Endpoint | Status | Latency | Root Cause Layer | Explanation |
|---|---|---|---|---|---|
| **#47** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` | `000000` | `12,059 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Upstream vFarm `GET /api/v1/readings/stats` performs an unindexed 24h aggregation scan taking `>12s`. Because PR #22 increased CST's upstream timeout (`VFARM_READINGS_STATS_TIMEOUT_MS`) to `30,000ms` while `scripts/test-prod-all-endpoints.sh` uses `curl --max-time 12`, curl aborts at 12s with `000000` before CST's 30s timeout returns `502`. |
| **#50** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_ph&window=24h` | `000000` | `12,059 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Same as #47 for `rack1_ph`. |
| **#53** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack2_dht&window=24h` | `000000` | `12,043 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Same as #47 for `rack2_dht`. |
| **#56** | `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_mq7&window=24h` | `000000` | `12,058 ms` | **Upstream vFarm DB + Test Script Timeout Interaction** | Same as #47 for `rack1_mq7`. |

### 3.2 The 4 `DEGRADED` Endpoints in `prod-test-results.json`

| Test # | Endpoint | Status | Latency | Root Cause Layer | Explanation |
|---|---|---|---|---|---|
| **#3** | `GET /api/health` | `200` | `1,305 ms` | **Cold-Boot Static `VFARM_JWT` Expiry + `getHealth()` Pure Read Design** | Returns HTTP 200 with `api_reachability.status: "unavailable", reason: "probe_failed:auth"` on a cold container because static `VFARM_JWT` expired `2026-10-23T20:05:24Z` and `getHealth()` does not trigger `ensureAdminToken()` login until Phase 4/5 admin routes run. |
| **#42** | `GET /api/v1/admin/vfarm/system-stats` | `000000` | `12,061 ms` | **Upstream vFarm API Timeout** | Upstream `GET /api/v1/system/stats` times out (`>12s` / `503`) performing full-table counts. |
| **#43** | `GET /api/v1/admin/vfarm/alerts/counts` | `422` | `751 ms` | **Upstream vFarm FastAPI Router Bug** | Upstream `GET /api/v1/alerts/threshold/counts` returns HTTP `422 Unprocessable Entity` because FastAPI matches `"counts"` against `/alerts/threshold/{rule_id}` (UUID). |
| **#44** | `GET /api/v1/admin/vfarm/vision/latest` | `422` | `494 ms` | **Upstream vFarm Configuration** | Upstream vFarm returns HTTP `422` because no vision cameras are configured for the active farm. |

---

## 4. Complete 111-Endpoint Production Verification Matrix (`prod-test-results.json`)

| # | Method | Path | Auth Mode | Expected | Actual | Latency (ms) | Classification | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `GET` | `/health` | `public` | `200` | `200` | `626` | `PASS` | Liveness probe OK |
| 2 | `GET` | `/health/voice` | `public` | `200/503` | `200` | `450` | `PASS` | Voice lane status evaluated |
| 3 | `GET` | `/api/health` | `public` | `200` | `200` | `1305` | `DEGRADED` | Cold-boot `probe_failed:auth`; post-`22:25:18Z` live check confirms `research_twin` `RT_*` vars all configured (`missing: []`, `state: "blocked"`) |
| 4 | `GET` | `/` | `public` | `200/302` | `302` | `435` | `PASS` | Root redirects to `/api-docs` |
| 5 | `GET` | `/api-docs/` | `public` | `200` | `200` | `415` | `PASS` | Swagger UI documentation served |
| 6 | `GET` | `/web` | `public` | `200` | `200` | `445` | `PASS` | Web chat interface served |
| 7 | `GET` | `/admin/login` | `public` | `200` | `200` | `448` | `PASS` | Admin login page served |
| 8 | `GET` | `/admin` | `public` | `200/302` | `200` | `518` | `PASS` | Admin dashboard UI served |
| 9 | `GET` | `/api-docs.json` | `public` | `200` | `200` | `611` | `PASS` | OpenAPI 3.0.3 spec served |
| 10 | `GET` | `/debug/state` | `public` | `404` | `404` | `445` | `PASS` | Correctly disabled in production (404) |
| 11 | `GET` | `/favicon.ico` | `public` | `204` | `204` | `428` | `PASS` | Favicon handler OK |
| 12 | `POST` | `/api/v1/auth/login (bad creds)` | `public` | `401` | `401` | `462` | `PASS` | Invalid credentials rejected (401) |
| 13 | `POST` | `/api/v1/auth/login (valid)` | `public` | `200` | `200` | `442` | `PASS` | Authenticated successfully |
| 14 | `GET` | `/api/v1/auth/me (unauth)` | `none` | `401` | `401` | `421` | `PASS` | Unauthenticated access properly blocked (401) |
| 15 | `GET` | `/api/v1/auth/me` | `x-admin-token` | `200` | `200` | `453` | `PASS` | Session validated successfully |
| 16 | `GET` | `/api/v1/admin/tenants` | `x-admin-token` | `200/404` | `200` | `401` | `PASS` | Admin core endpoint responded OK |
| 17 | `GET` | `/api/v1/admin/projects` | `x-admin-token` | `200/404` | `200` | `448` | `PASS` | Admin core endpoint responded OK |
| 18 | `GET` | `/api/v1/admin/numbers/bindings` | `x-admin-token` | `200/404` | `200` | `469` | `PASS` | Admin core endpoint responded OK |
| 19 | `GET` | `/api/v1/admin/numbers/candidate` | `x-admin-token` | `200/404` | `200` | `460` | `PASS` | Admin core endpoint responded OK |
| 20 | `GET` | `/api/v1/admin/health/verification` | `x-admin-token` | `200/404` | `200` | `673` | `PASS` | Admin core endpoint responded OK |
| 21 | `GET` | `/api/v1/admin/dashboard-publisher/status` | `x-admin-token` | `200/404` | `200` | `486` | `PASS` | Admin core endpoint responded OK |
| 22 | `GET` | `/api/v1/admin/speakers` | `x-admin-token` | `200/404` | `200` | `455` | `PASS` | Admin core endpoint responded OK |
| 23 | `GET` | `/api/v1/admin/audit/logs` | `x-admin-token` | `200/404` | `200` | `469` | `PASS` | Admin core endpoint responded OK |
| 24 | `GET` | `/api/v1/admin/dashboard` | `x-admin-token` | `200/404` | `200` | `1197` | `PASS` | Admin core endpoint responded OK |
| 25 | `GET` | `/api/v1/admin/sms-consent/wording` | `x-admin-token` | `200/404` | `200` | `448` | `PASS` | Admin core endpoint responded OK |
| 26 | `GET` | `/api/v1/admin/sms-consent` | `x-admin-token` | `200/404` | `200` | `480` | `PASS` | Admin core endpoint responded OK |
| 27 | `GET` | `/api/v1/admin/sms-consent/%2B19715885823?tenant_id=tenant-vfarm-01` | `x-admin-token` | `200/404` | `200` | `443` | `PASS` | Admin core endpoint responded OK |
| 28 | `GET` | `/api/v1/admin/sms-consent/%2B19715885823/history?tenant_id=tenant-vfarm-01` | `x-admin-token` | `200/404` | `200` | `438` | `PASS` | Admin core endpoint responded OK |
| 29 | `GET` | `/api/v1/admin/vfarm/farms` | `x-admin-token` | `200` | `200` | `511` | `PASS` | vFarm proxy responded OK |
| 30 | `GET` | `/api/v1/admin/vfarm/dashboard` | `x-admin-token` | `200` | `200` | `822` | `PASS` | vFarm proxy responded OK |
| 31 | `GET` | `/api/v1/admin/vfarm/health` | `x-admin-token` | `200` | `200` | `495` | `PASS` | vFarm proxy responded OK |
| 32 | `GET` | `/api/v1/admin/vfarm/summary` | `x-admin-token` | `200` | `200` | `550` | `PASS` | vFarm proxy responded OK |
| 33 | `GET` | `/api/v1/admin/vfarm/organizations` | `x-admin-token` | `200` | `200` | `496` | `PASS` | vFarm proxy responded OK |
| 34 | `GET` | `/api/v1/admin/vfarm/layout` | `x-admin-token` | `200` | `200` | `581` | `PASS` | vFarm proxy responded OK |
| 35 | `GET` | `/api/v1/admin/vfarm/zones` | `x-admin-token` | `200` | `200` | `537` | `PASS` | vFarm proxy responded OK |
| 36 | `GET` | `/api/v1/admin/vfarm/devices` | `x-admin-token` | `200` | `200` | `520` | `PASS` | vFarm proxy responded OK |
| 37 | `GET` | `/api/v1/admin/vfarm/alerts/open` | `x-admin-token` | `200` | `200` | `530` | `PASS` | vFarm proxy responded OK |
| 38 | `GET` | `/api/v1/admin/vfarm/alerts/history` | `x-admin-token` | `200` | `200` | `632` | `PASS` | vFarm proxy responded OK |
| 39 | `GET` | `/api/v1/admin/vfarm/customers?org_id=122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d` | `x-admin-token` | `200` | `200` | `746` | `PASS` | vFarm proxy responded OK |
| 40 | `GET` | `/api/v1/admin/vfarm/users?org_id=122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d` | `x-admin-token` | `200` | `200` | `614` | `PASS` | vFarm proxy responded OK |
| 41 | `GET` | `/api/v1/admin/turn-stream` | `x-admin-token` | `200` | `200` | `444` | `PASS` | vFarm proxy responded OK |
| 42 | `GET` | `/api/v1/admin/vfarm/system-stats` | `x-admin-token` | `200` | `000000` | `12061` | `DEGRADED` | Upstream vFarm timeout/503 on `/api/v1/system/stats` |
| 43 | `GET` | `/api/v1/admin/vfarm/alerts/counts` | `x-admin-token` | `200` | `422` | `751` | `DEGRADED` | Upstream vFarm returns 422 on `/api/v1/alerts/threshold/counts` |
| 44 | `GET` | `/api/v1/admin/vfarm/vision/latest` | `x-admin-token` | `200` | `422` | `494` | `DEGRADED` | Upstream vFarm returns 422 (no cameras configured for active farm) |
| 45 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack1_soil&limit=5` | `x-admin-token` | `200` | `200` | `566` | `PASS` | Historical readings retrieved OK |
| 46 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_soil` | `x-admin-token` | `200` | `200` | `522` | `PASS` | **Restored by PR #22:** Latest reading retrieved (`0 %`) |
| 47 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` | `x-admin-token` | `200` | `000000` | `12059` | `FAIL` | Reading stats failed with `000000` (`curl --max-time 12` abort during 30s upstream scan) |
| 48 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack1_ph&limit=5` | `x-admin-token` | `200` | `200` | `759` | `PASS` | **Restored by PR #22:** Historical readings retrieved OK |
| 49 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_ph` | `x-admin-token` | `200` | `200` | `503` | `PASS` | **Restored by PR #22:** Latest reading retrieved (`25.19 pH`) |
| 50 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_ph&window=24h` | `x-admin-token` | `200` | `000000` | `12059` | `FAIL` | Reading stats failed with `000000` (`curl --max-time 12` abort) |
| 51 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack2_dht&limit=5` | `x-admin-token` | `200` | `200` | `1139` | `PASS` | **Restored by PR #22:** Historical readings retrieved OK |
| 52 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack2_dht` | `x-admin-token` | `200` | `200` | `498` | `PASS` | **Restored by PR #22:** Latest reading retrieved (`26.8 °C`) |
| 53 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack2_dht&window=24h` | `x-admin-token` | `200` | `000000` | `12043` | `FAIL` | Reading stats failed with `000000` (`curl --max-time 12` abort) |
| 54 | `GET` | `/api/v1/admin/vfarm/readings?sensor_id=rack1_mq7&limit=5` | `x-admin-token` | `200` | `200` | `828` | `PASS` | **Restored by PR #22:** Historical readings retrieved OK |
| 55 | `GET` | `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=rack1_mq7` | `x-admin-token` | `200` | `200` | `505` | `PASS` | **Restored by PR #22:** Latest reading retrieved (`201 ppm`) |
| 56 | `GET` | `/api/v1/admin/vfarm/readings/stats?sensor_id=rack1_mq7&window=24h` | `x-admin-token` | `200` | `000000` | `12058` | `FAIL` | Reading stats failed with `000000` (`curl --max-time 12` abort) |
| 57 | `GET` | `/api/v1/dashboard` | `x-admin-token` | `200` | `200` | `1493` | `PASS` | Authenticated proxy OK |
| 58 | `GET` | `/api/v1/dashboard (unauth)` | `none` | `401` | `401` | `414` | `PASS` | Unauthenticated access properly blocked (401) |
| 59 | `GET` | `/api/dashboard` | `x-admin-token` | `200` | `200` | `955` | `PASS` | Authenticated proxy OK |
| 60 | `GET` | `/api/dashboard (unauth)` | `none` | `401` | `401` | `446` | `PASS` | Unauthenticated access properly blocked (401) |
| 61 | `GET` | `/api/v1/devices` | `x-admin-token` | `200` | `200` | `1200` | `PASS` | **Restored by PR #22:** Authenticated proxy OK |
| 62 | `GET` | `/api/v1/devices (unauth)` | `none` | `401` | `401` | `442` | `PASS` | Unauthenticated access properly blocked (401) |
| 63 | `GET` | `/api/devices` | `x-admin-token` | `200` | `200` | `1657` | `PASS` | **Restored by PR #22:** Authenticated proxy OK |
| 64 | `GET` | `/api/devices (unauth)` | `none` | `401` | `401` | `430` | `PASS` | Unauthenticated access properly blocked (401) |
| 65 | `GET` | `/api/v1/farms` | `x-admin-token` | `200` | `200` | `585` | `PASS` | **Restored by PR #22:** Authenticated proxy OK |
| 66 | `GET` | `/api/v1/farms (unauth)` | `none` | `401` | `401` | `407` | `PASS` | Unauthenticated access properly blocked (401) |
| 67 | `GET` | `/api/farms` | `x-admin-token` | `200` | `200` | `2979` | `PASS` | **Restored by PR #22:** Authenticated proxy OK |
| 68 | `GET` | `/api/farms (unauth)` | `none` | `401` | `401` | `425` | `PASS` | Unauthenticated access properly blocked (401) |
| 69 | `POST` | `/api/v1/web/session` | `none` | `501` | `501` | `430` | `PASS` | Enforces `PRODUCTION_AUTH_REQUIRED` (501) |
| 70 | `GET` | `/api/v1/web/projects` | `public` | `200` | `200` | `441` | `PASS` | Web projects listed |
| 71 | `GET` | `/api/v1/web/session (no cookie)` | `none` | `401` | `401` | `398` | `PASS` | Unauthenticated web session blocked |
| 72 | `POST` | `/audio/speak (no key)` | `none` | `401` | `401` | `423` | `PASS` | Fail-closed without API key (401) |
| 73 | `POST` | `/audio/speak (bad key)` | `x-cst-api-key` | `403` | `403` | `464` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 74 | `POST` | `/voice/turn (no key)` | `none` | `401` | `401` | `563` | `PASS` | Fail-closed without API key (401) |
| 75 | `POST` | `/voice/turn (bad key)` | `x-cst-api-key` | `403` | `403` | `632` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 76 | `POST` | `/api/v1/voice/turn (no key)` | `none` | `401` | `401` | `470` | `PASS` | Fail-closed without API key (401) |
| 77 | `POST` | `/api/v1/voice/turn (bad key)` | `x-cst-api-key` | `403` | `403` | `578` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 78 | `POST` | `/api/v1/voice/synthesize (no key)` | `none` | `401` | `401` | `613` | `PASS` | Fail-closed without API key (401) |
| 79 | `POST` | `/api/v1/voice/synthesize (bad key)` | `x-cst-api-key` | `403` | `403` | `426` | `PASS` | Invalid key rejected with 403 FORBIDDEN |
| 80 | `GET` | `/api/v1/voice/audio/:id` | `public` | `404` | `404` | `426` | `PASS` | Correctly returns `AUDIO_NOT_FOUND` |
| 81 | `POST` | `/webhooks/twilio/sms (unauthenticated)` | `none` | `401/403` | `401` | `432` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 82 | `POST` | `/webhooks/twilio/delivery-status (unauthenticated)` | `none` | `401/403` | `401` | `433` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 83 | `POST` | `/webhooks/twilio/voice (unauthenticated)` | `none` | `401/403` | `401` | `420` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 84 | `POST` | `/webhooks/twilio/voice/inbound (unauthenticated)` | `none` | `401/403` | `401` | `419` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 85 | `POST` | `/twilio/voice (unauthenticated)` | `none` | `401/403` | `401` | `647` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 86 | `POST` | `/twilio/voice/inbound (unauthenticated)` | `none` | `401/403` | `401` | `665` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 87 | `POST` | `/webhooks/twilio/voice/turn (unauthenticated)` | `none` | `401/403` | `401` | `622` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 88 | `POST` | `/twilio/voice/turn (unauthenticated)` | `none` | `401/403` | `401` | `489` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 89 | `POST` | `/webhooks/twilio/voice/status (unauthenticated)` | `none` | `401/403` | `401` | `679` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 90 | `POST` | `/twilio/voice/status (unauthenticated)` | `none` | `401/403` | `401` | `541` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 91 | `POST` | `/api/v1/voice/status (unauthenticated)` | `none` | `401/403` | `401` | `720` | `PASS` | Unsigned Twilio webhook refused with 401 |
| 92 | `POST` | `/api/v1/admin/tenants` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Create new tenant (zero-mutation rule) |
| 93 | `PATCH` | `/api/v1/admin/tenants/:tenantId` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Update tenant configuration |
| 94 | `POST` | `/api/v1/admin/projects/sync` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Sync project configuration |
| 95 | `PATCH` | `/api/v1/admin/projects/:projectId` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Update project details |
| 96 | `POST` | `/api/v1/admin/numbers/sync` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Sync Twilio numbers |
| 97 | `POST` | `/api/v1/admin/numbers/bind` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Bind number to project |
| 98 | `DELETE` | `/api/v1/admin/numbers/unbind` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Unbind number |
| 99 | `POST` | `/api/v1/admin/speakers/sync` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Sync speaker registry |
| 100 | `POST` | `/api/v1/admin/speakers/invalidate` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Invalidate speaker cache |
| 101 | `POST` | `/api/v1/admin/speakers` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Create speaker |
| 102 | `PATCH` | `/api/v1/admin/speakers/:phoneE164` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Update speaker |
| 103 | `DELETE` | `/api/v1/admin/speakers/:phoneE164` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Delete speaker |
| 104 | `POST` | `/api/v1/admin/sms-consent` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Update SMS consent state |
| 105 | `POST` | `/api/v1/admin/vfarm/login` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Interactive farm admin login |
| 106 | `POST` | `/api/v1/admin/vfarm/tokens` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Generate farm token |
| 107 | `POST` | `/api/v1/admin/vfarm/select` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Switch active farm in-memory |
| 108 | `POST` | `/api/v1/web/message` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Send user web chat message |
| 109 | `POST` | `/audio/speak (with valid key)` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Synthesize spoken turn via ElevenLabs |
| 110 | `POST` | `/voice/turn (with valid key)` | `restricted` | `N/A` | `000` | `0` | `NOT_TESTED` | Skipped in prod audit: Execute voice turn orchestrator |
| 111 | `POST` | `/api/v1/auth/logout` | `x-admin-token` | `200` | `200` | `550` | `PASS` | Admin session token revoked cleanly |
