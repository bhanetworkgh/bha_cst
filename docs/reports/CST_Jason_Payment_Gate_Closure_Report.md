# CST — Complete Payment-Gate Gap Closure, Latest Production Verification & Jason A–F Acceptance Report

**Report Date:** 2026-11-02 (Reconciled Post-PR #23 Deployment Verification)
**Decision Watch Reference:** `DW-1793626498819-PDQ2`
**Incident / Loop Reference:** `LOOP-1793620799001-3NBE`
**Repository:** `bhanetworkgh/bha_cst`
**Render Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`, Workspace `tea-dafco81t0dsc73djsv4g`, Oregon, Starter `0.5c-512mb`, Node.js `24.21.0`)
**Production Database:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`, Database `bha_cst_1sh0`, PostgreSQL 16)
**Production URL:** `https://bha-cst-7u9e.onrender.com`
**Latest Verified Production Deployment:** `dep-dbkh3p6417fc73bffihg` (PR #23 Merge Commit `441d2b3f4a49c983f45131c229888a60116b9437`, merging `8f2940307e9c946ad7a3b8353ecf5f53368b9933`, `live` at `2026-11-02T22:43:32.077742Z`)
**Durable Test Result Artifacts:**
- PR #22 Baseline: [`prod-test-results.json`](../../prod-test-results.json) (`2026-11-02T21:55:03Z`, SHA `fa701a3f7e2a4c642307d018f9a4a123cc6007d3`)
- PR #23 Latest Run: [`docs/evidence/prod-test-results-pr23-latest.json`](../evidence/prod-test-results-pr23-latest.json) (`2026-11-02T22:47:58Z`, SHA `441d2b3f4a49c983f45131c229888a60116b9437`)
**Local Working Branch & HEAD:** `fix/monitoring-pay-gate-closure` @ `8f2940307e9c946ad7a3b8353ecf5f53368b9933`
**Final Readiness Verdict:** **`PARTIALLY READY — EXTERNAL EVIDENCE REQUIRED`**

---

## 1. Executive Summary

This report provides the authoritative engineering, database migration, live production verification, and payment-gate readiness assessment for CST (`bha-cst`) against Jason's original A–F acceptance criteria and Decision Watch `DW-1793626498819-PDQ2` following the live deployment of PR #23 (`441d2b3f4a49c983f45131c229888a60116b9437`).

### Key Accomplishments in This Release Cycle
1. **Verified PR #23 Live in Production (`dep-dbkh3p6417fc73bffihg` / `441d2b3f4a49c983f45131c229888a60116b9437`) & All 24 Migrations Applied:**
   - Render's configured `startCommand` (`node scripts/migrate.js && npm start`) automatically executed `scripts/migrate.js` on container boot (`2026-11-02T22:43:24Z`) and applied [`db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql`](../../db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql) cleanly (`1 applied, 23 already recorded, 0 checksum warnings`).
   - Read-only inspection of Render PostgreSQL (`dpg-db8he2qvcj2c73ado3s0-a/bha_cst_1sh0`) confirms **all 24 migrations (`001`–`023`) are applied**, including `022_add_escalations_table.sql` (`a9611f32573f3d86993a45bda10d9952`, applied `2026-10-28 17:02:14.122471+00`) and `023_reconcile_duplicate_003_and_schema_drift.sql` (`b03c1e0c63eb12a771d7afaaf9d1452d`, applied `2026-11-02 22:43:25.032521+00`).
   - In production, `customers_pkey` is now `PRIMARY KEY (id)`, `escalations` is live with all 14 columns and 5 indexes, and `systems.onboarding_reply` / `projects.onboarding_reply` now contain the conversational greeting (`"Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?"`).
2. **Fresh, Calibrated Live Telemetry Stream Restored for All 4 Canonical Sensors (`2026-11-02T22:46Z–22:53Z`):**
   - Live production verification confirmed that all 4 canonical sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) are now **actively streaming fresh (<60s old), calibrated live telemetry** via the interim endpoint (`/api/v1/readings?sensor_id=X&limit=1` / CST `/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=X`):
     - **`rack1_soil` (#46):** `200 OK` (`573ms`) — `soil_moisture: 90.0 %` (`status: "ok"`, `reading_ts: 2026-11-02T22:48:50Z`, **<2s old**)
     - **`rack1_ph` (#49):** `200 OK` (`494ms`) — `ph: 5.06 ph` (`status: "ok"`, `reading_ts: 2026-11-02T22:48:56Z`, **<2s old & calibrated within physical 0–14 pH scale!**)
     - **`rack2_dht` (#52):** `200 OK` (`529ms`) — `temperature: 28.8 °C`, `humidity: 63 % RH` (`status: "ok"`, `reading_ts: 2026-11-02T22:52:29Z`, **<60s old**)
     - **`rack1_mq7` (#55):** `200 OK` (`526ms`) — `co: 0.76 ppm` (`status: "ok"`, `reading_ts: 2026-11-02T22:48:59Z`, **<15s old**)
3. **Verified Research Twin Credentials Live on Render (`missing: []`):**
   - Render startup logs (`2026-11-02T22:43:26.799Z`) and `GET /api/health` (`2026-11-02T22:48:18.788Z`) confirm `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` are configured (`endpoint_configured: true, service_api_key_configured: true, callback_signing_secret_configured: true, missing: [], state: "blocked"`).
4. **Why Payment-Gate Verdict Remains `PARTIALLY READY — EXTERNAL EVIDENCE REQUIRED`:**
   - **Do not conflate implementation with acceptance.** Although the codebase and database migrations are fully reconciled and deployed, mandatory acceptance behaviors remain open across external systems and authorized human testing:
     - Authoritative vFarm endpoints (`/readings/latest`, `/readings/stats`, `/system/stats`, `/alerts/threshold/counts`) remain blocked on upstream database indexing and route bug fixes (Owner: Jeganathan).
     - Research Twin external wire contract and signed callback remain unverified (Owner: Destiny Arupi).
     - Fresh human-verified Browser Chat, Voice Call (`+19715885823`), operator escalation, and post-PR #23 SMS delivery attribution remain pending authorization (Owner: Jason / Authorized Tester).

---

## 2. Git, PR & Render Deployment Lineage

| Lineage Stage | Commit SHA | PR / Branch | Render Deployment ID | Timestamp (UTC) | Description |
|---|---|---|---|---|---|
| **PR #20 Merge Commit (Baseline)** | `656000a7b768986feca9d85c7ac9d96c921306c7` | PR #20 -> `main` | `dep-dbkep6bm8hqs739a2k80` | `2026-11-02 20:04:31` | Deployed PR #20 (`74 PASS, 2 FAIL, 16 DEGRADED, 19 NOT_TESTED`) |
| **PR #21 Merge Commit** | `7ecb1741135779eb9e3d84f118f18e3e47c32c8c` | PR #21 -> `main` | `dep-dbkfvavavr4c73b48tug` | `2026-11-02 21:26:17` | Merged A–F acceptance alignment & escalations |
| **PR #22 Merge Commit** | `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` | PR #22 -> `main` | `dep-dbkgavp5efls73ag1olg` | `2026-11-02 21:51:02` | Interim `/readings?limit=1` fallback (`84 PASS, 4 FAIL, 4 DEGRADED`) |
| **Manual Redeploy (`RT_*` Env Vars)** | `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` | `main` | `dep-dbkgql6gekts73conheg` | `2026-11-02 22:24:03` | Activated `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, `RT_CALLBACK_SIGNING_SECRET` |
| **PR #23 Feature Commit (Local HEAD)** | `8f2940307e9c946ad7a3b8353ecf5f53368b9933` | `fix/monitoring-pay-gate-closure` | — | `2026-11-02 22:36:14` | `refactor: reconcile database migration duplicates, schema drift, and add acceptance test reports` |
| **PR #23 Merge Commit (Current Live Prod)** | **`441d2b3f4a49c983f45131c229888a60116b9437`** | **PR #23 -> `main`** | **`dep-dbkh3p6417fc73bffihg`** | **`2026-11-02 22:43:32`** | **Currently running in production (`023` migration applied; `84 PASS, 4 FAIL, 4 DEGRADED`; all 4 sensors streaming fresh live data)** |

---

## 3. Production Endpoint Test Reconciliation (Run 4 vs Baseline)

All 111 endpoints were tested against `dep-dbkh3p6417fc73bffihg` on `2026-11-02T22:45:49Z`–`22:47:58Z`. The exact test output is preserved as a durable artifact in [`docs/evidence/prod-test-results-pr23-latest.json`](../evidence/prod-test-results-pr23-latest.json) (while [`prod-test-results.json`](../../prod-test-results.json) remains unmodified in the repository root).

### 3.1 Reconciliation Across Deployments

| Metric | Run 1 (PR #20 Baseline)<br>`2026-11-02T21:02:53Z` | Run 2 (PR #20 Warm Probe)<br>`2026-11-02T21:28:11Z` | Run 3 (PR #22 Baseline Artifact)<br>`2026-11-02T21:55:03Z` | Run 4 (PR #23 Latest Durable Artifact)<br>`2026-11-02T22:47:58Z` |
|---|---|---|---|---|
| **Deployment ID** | `dep-dbkep6bm8hqs739a2k80` | `dep-dbkep6bm8hqs739a2k80` | `dep-dbkgavp5efls73ag1olg` | **`dep-dbkh3p6417fc73bffihg`** |
| **Deployed SHA** | `656000a7b768986feca9d85c7ac9d96c921306c7` | `656000a7b768986feca9d85c7ac9d96c921306c7` | `fa701a3f7e2a4c642307d018f9a4a123cc6007d3` | **`441d2b3f4a49c983f45131c229888a60116b9437`** |
| **Evaluated** | `111` | `111` | `111` | **`111`** |
| **`PASS`** | `74` | `76` | `84` | **`84`** |
| **`FAIL`** | `2` | `2` | `4` | **`4`** |
| **`DEGRADED`** | `16` | `14` | `4` | **`4`** |
| **`AUTH_BLOCKED`** | `0` | `0` | `0` | **`0`** |
| **`NOT_TESTED`** | `19` | `19` | `19` | **`19`** |
| **Telemetry Quality** | Timed out (`502`) | Timed out (`502`) | `200 OK`, Stale (`2026-10-30`), `rack1_ph=25.19` | **`200 OK`, FRESH (<60s old), `rack1_ph=5.06 pH`!** |

### 3.2 Investigation of the 4 `FAIL` Cases (Reading Stats Timeouts)

All four `FAIL` cases are reading statistics endpoints where upstream vFarm executes an unindexed 24-hour aggregation scan across the `readings` table (`id > 6,715,153` rows):
- **Test #47:** `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_soil&window=24h` (`status: 000`, latency `12,053ms`)
- **Test #50:** `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_ph&window=24h` (`status: 000`, latency `12,055ms`)
- **Test #53:** `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack2_dht&window=24h` (`status: 000`, latency `12,055ms`)
- **Test #56:** `GET /api/v1/admin/vfarm/readings/stats?sensor_id=rack1_mq7&window=24h` (`status: 000`, latency `12,055ms`)

**Root Cause:** In PR #22, CST increased `VFARM_READINGS_STATS_TIMEOUT_MS` to `30,000ms`. Because the test runner [scripts/test-prod-all-endpoints.sh](../../scripts/test-prod-all-endpoints.sh) sets `curl -m 12`, the client aborts at 12 seconds with status code `000` while CST is still awaiting vFarm's slow 30-second query. Upstream database indexing on `readings(sensor_id, reading_ts DESC)` is required.

### 3.3 Investigation of the 4 `DEGRADED` Cases

- **Test #3 (`GET /api/health`, latency `592ms`, `actual_status: 200`):** Classified as `DEGRADED` due to two distinct layers:
  1. *Cold-Boot Health Probe Authentication Failure:* On a freshly booted container before Phase 4/5 admin routes run, `getHealth()` relies on the static environment variable `VFARM_JWT` (which expired on `2026-10-23T20:05:24Z`). vFarm rejects the probe with HTTP 401, resulting in `api_reachability.status: "unavailable", reason: "probe_failed:auth"` and overall `status: "unknown"`.
  2. *Warm Probe Upstream Health Semantics:* Once admin routes execute `ensureAdminToken()` to acquire and cache dynamic JWT credentials, subsequent calls (e.g. at `22:48:18Z`) achieve `api_reachability.status: "healthy"` (`889ms`), but return `farm_health.status: "degraded"` because upstream vFarm (`/api/v1/farms/{farm_id}/health`) returns `raw_status: "neutral"` with null `health_score` and `calculated_at` timestamps.
- **Test #42 (`GET /api/v1/admin/vfarm/system-stats`, latency `12,058ms`, `actual_status: 000`):** Upstream vFarm `GET /api/v1/system/stats` performs full-table sequential counts across millions of rows, timing out past the 12-second client abort threshold.
- **Test #43 (`GET /api/v1/admin/vfarm/alerts/counts`, latency `1,303ms`, `actual_status: 422`):** In the upstream vFarm FastAPI router, `/api/v1/alerts/threshold/{rule_id}` is declared above `/api/v1/alerts/threshold/counts`. The string `"counts"` is parsed as a UUID `{rule_id}` and rejected with HTTP `422 Unprocessable Entity`.
- **Test #44 (`GET /api/v1/admin/vfarm/vision/latest`, latency `785ms`, `actual_status: 422`):** Upstream vFarm returns HTTP 422 because camera/vision hardware is not configured for the active farm.

### 3.4 Historical Twilio Call & Message Evidence (Predating PR #23 Deployment)

> [!IMPORTANT]
> **Historical Evidence Classification Notice:** The records below are **historical production database records from October 30, 2026**, predating the November 2, 2026 deployment of PR #23 (`dep-dbkh3p6417fc73bffihg`, commit `441d2b3f4a49c983f45131c229888a60116b9437`). They provide durable empirical proof that database persistence, Twilio SMS callback delivery handling, ElevenLabs TTS synthesis, and internal voice lane dispatch functioned in production. **They do not constitute fresh post-PR #23 live acceptance.** Fresh post-PR #23 live SMS turns and live voice call verification remain strictly pending authorized human test execution.

#### Technical Distinction of Delivery & Telephony Statuses
To prevent conflating separate operational stages, the following statuses are independently tracked:
1. **SMS Provider Status (`delivered`):** Confirmed delivery receipt received from Twilio via status callback webhook (`/webhooks/twilio/delivery-status`) for outbound SMS.
2. **ElevenLabs Status (`synthesized`):** Confirmed successful TTS audio buffer synthesis via the ElevenLabs API (`model_id: eleven_turbo_v2_5`, `voice_id: Hmy97GCI840wuICQesiM`).
3. **Voice Lane Status (`sent`):** Confirmed internal CST voice lane dispatch of the synthesized turn payload to Twilio's live audio websocket stream.
4. **Completed Twilio Call Outcome:** The final call session outcome (e.g. user answered, terminal call duration, Twilio `completed` call webhook) is **NOT** recorded in `voice_deliveries`, which stores turn-level synthesis and dispatch rows. Full end-to-end call completion requires post-PR #23 live human testing.

#### Outbound SMS Delivery Evidence (`messages_out` — Historical 2026-10-30)
| Outbound Message ID | Provider Message SID (`provider_sid`) | Inbound Turn / Correlation SID (`turn_id`) | Route | Provider Status | Delivery Timestamp (UTC) |
|---|---|---|---|---|---|
| `out_b556d753-4a7f-43f0-9c4d-cb9bdcedd38b` | **`SMdd413c99025787c3a92c9a7c5e91de77`** | **`SMf9470b51719bb4512a93dfab83fa8464`** | `+19715885823` -> `+9230***3844` | **`delivered`** | `2026-10-30T16:31:43.560Z` |
| `out_e89066aa-7f7c-4ff4-8208-c7a1b72c07d9` | **`SMd9ecf40685cc36db7d184ec776dc0afb`** | **`SM06d5675d03f412a49264f45f21814473`** | `+19715885823` -> `+9230***3844` | **`delivered`** | `2026-10-30T14:39:16.253Z` |
| `out_a89d960b-2ea7-405b-904d-d7874768d538` | **`SMe2e8cc3bd3885e64941a89e4c81bc48e`** | **`SM64a005aa459178fdd3e615f5311d7374`** | `+19715885823` -> `+9230***3844` | `undelivered` (pre-consent) | `2026-10-21T19:39:39.364Z` |

#### Inbound Voice Call & ElevenLabs TTS Delivery Evidence (`voice_deliveries` — Historical 2026-10-30)
| Voice Delivery ID | Twilio Call SID (`correlation_id`) | TTS Voice ID | Model ID | Audio Bytes / Payload | Turn Lifecycle Status | Delivered Timestamp (UTC) |
|---|---|---|---|---|---|---|
| `vd_7b9757d7-c80c-41b5-915c-6e13fbeba542` | **`CA00c75d6e31e3e604e542f4ef05efbeb8`** | `Hmy97GCI840wuICQesiM` | `eleven_turbo_v2_5` | 91 chars / 64,826 B | **`synthesized`** (ElevenLabs) | `2026-10-30T19:17:25.972Z` |
| `vd_c56280ca-8128-4614-8278-99cf55897f49` | **`CA00c75d6e31e3e604e542f4ef05efbeb8`** | `Hmy97GCI840wuICQesiM` | `eleven_turbo_v2_5` | 309 chars / 301,809 B | **`synthesized`** (ElevenLabs) | `2026-10-30T19:17:49.122Z` |
| `vd_9b6fd0a5-abbf-412a-9596-85cc80286e82` | **`CA00c75d6e31e3e604e542f4ef05efbeb8`** | `Hmy97GCI840wuICQesiM` | `eleven_turbo_v2_5` | 232 chars / 229,920 B | **`synthesized`** (ElevenLabs) | `2026-10-30T19:18:14.864Z` |
| `vd_e9d60116-8d5e-426a-9677-d94fd8858d2a` | **`CA00c75d6e31e3e604e542f4ef05efbeb8`** | *(lane dispatch)* | *(lane dispatch)* | *(turn dispatch)* | **`sent`** (Lane Dispatch) | `2026-10-30T19:18:14.882Z` |
| `vd_a5cb8283-a878-44b8-9865-928cc09041b1` | **`CAe444cd581967be81a5bbdb8eb0c55168`** | `Hmy97GCI840wuICQesiM` | `eleven_turbo_v2_5` | 91 chars / 72,350 B | **`synthesized`** (ElevenLabs) | `2026-10-30T19:15:57.407Z` |
| `vd_84fff412-830f-4a32-a09f-9b199b07e187` | **`CAe444cd581967be81a5bbdb8eb0c55168`** | `Hmy97GCI840wuICQesiM` | `eleven_turbo_v2_5` | 309 chars / 320,617 B | **`synthesized`** (ElevenLabs) | `2026-10-30T19:16:21.558Z` |
| `vd_989250db-6114-41c4-9375-ae580189d96d` | **`CAe444cd581967be81a5bbdb8eb0c55168`** | `Hmy97GCI840wuICQesiM` | `eleven_turbo_v2_5` | 221 chars / 209,858 B | **`synthesized`** (ElevenLabs) | `2026-10-30T19:16:51.702Z` |
| `vd_2dddef38-173b-483c-b7a9-988b90c72d1a` | **`CAe444cd581967be81a5bbdb8eb0c55168`** | *(lane dispatch)* | *(lane dispatch)* | *(turn dispatch)* | **`sent`** (Lane Dispatch) | `2026-10-30T19:16:51.172Z` |

*(Note: Terminal Twilio call session completion events are not logged in `voice_deliveries`, which records turn-level synthesis and lane dispatch.)*

---

## 4. Jason A–F Acceptance Traceability Matrix (Distinguishing Implementation from Acceptance)

| Area | Corrected Acceptance Classification | Code Implementation | Local Proof | Production Proof | Remaining Blocker / Required Action | Owner |
|---|---|---|---|---|---|---|
| **A — vFarm data path & sensors** | **`PARTIALLY SATISFIED — AUTHORITATIVE ENDPOINTS BLOCKED`** | [adapters/vfarm/client.ts](../../engine/src/adapters/vfarm/client.ts) (interim `/readings?limit=1` fallback) | `tests/adapters/vfarm_interim_readings.test.ts` (`PASS`) | Tests #45–#46, #48–#49, #51–#52, #54–#55, #61, #65 all **HTTP 200 OK with fresh (<60s) live telemetry** (`rack1_soil = 90%`, `rack1_ph = 5.06 pH`, `rack2_dht = 28.8 °C / 63%`, `rack1_mq7 = 0.76 ppm`) | Add composite index on `readings(sensor_id, reading_ts DESC)` so authoritative `/readings/latest` (<500ms) and `/readings/stats` (#47, #50, #53, #56) do not time out; fix `/system/stats` (#42) and `/alerts/threshold/counts` (#43); deactivate empty `Test 001` farm | **Jeganathan (vFarm)** |
| **B — Presence, freshness & health semantics** | **`PARTIALLY SATISFIED — COLD START AUTH & UPSTREAM HEALTH SEMANTICS OPEN`** | [adapters/vfarm/index.ts](../../engine/src/adapters/vfarm/index.ts), [app.ts](../../engine/src/app.ts#L180-L212) (truthful staleness & anomaly logic) | `tests/regression/sensor_status_semantics.test.ts`, `tests/health/health_contract.test.ts` (`PASS`) | Cold-boot `GET /api/health` returns `probe_failed:auth` (592ms) due to expired static `VFARM_JWT` on Render; warm check (889ms) confirms `api_reachability: healthy` once admin routes run, truthfully reporting `farm_health: degraded` (`raw_status: "neutral"`, null timestamps); `rack1_ph` calibrated at `5.06 pH` | Rotate static `VFARM_JWT` on Render or update `getHealth()` to acquire dynamic tokens; upstream `/api/v1/farms/{id}/health` to populate `health_score` and `calculated_at` timestamps | **CST Ops / Engineering & Jeganathan (vFarm)** |
| **C — Conversational customer experience** | **`IMPLEMENTED — HUMAN ACCEPTANCE PENDING`** | [core/engine.ts](../../engine/src/core/engine.ts), [transport/voice/voice_lane.ts](../../engine/src/transport/voice/voice_lane.ts), [023 migration](../../db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql) | `tests/core/help_menu_copy.test.ts`, `tests/voice/voice_lifecycle.test.ts` (`PASS`) | Migration `023` applied in prod DB; `systems.onboarding_reply` verified; `GET /health/voice` (`200 OK`, `can_route_voice: true`) | Authorized human tester to execute Browser Chat walkthrough and live inbound Voice Call to `+19715885823` per [CST_Human_Acceptance_Test_Plan.md](CST_Human_Acceptance_Test_Plan.md) | **Jason / Authorized Tester** |
| **D — Research Twin end-to-end** | **`CREDENTIALS CONFIGURED — CONTRACT & CALLBACK BLOCKED`** | [research_twin/config.ts](../../engine/src/research_twin/config.ts), [research_twin/lifecycle.ts](../../engine/src/research_twin/lifecycle.ts) | `tests/research_twin/config.test.ts`, `tests/research_twin/lifecycle.test.ts` (`PASS`) | Render startup log (`22:43:26Z`) & `GET /api/health` confirm `RT_*` env vars configured (`missing: []`, `state: "blocked"`) | Destiny Arupi to confirm wire contract (HTTP POST schema) and HMAC signature format (`RT_CALLBACK_SIGNING_SECRET`), followed by 1 live signed callback test | **Destiny Arupi (Research Twin)** |
| **E — Operator workflow, escalations & admin console** | **`SCHEMA VERIFIED — HUMAN ACCEPTANCE PENDING`** | [022 migration](../../db/migrations/022_add_escalations_table.sql), [023 migration](../../db/migrations/023_reconcile_duplicate_003_and_schema_drift.sql), [escalation/service.ts](../../engine/src/escalation/service.ts) | `tests/db/schema_assertions.test.ts`, `tests/admin/admin_api.test.ts` (`PASS`) | Production DB `dpg-db8he2qvcj2c73ado3s0-a` verified with `escalations` table (`022`) and `customers_pkey PRIMARY KEY (id)` (`023`); Admin endpoints #8, #13, #15–#41 all `200 OK` | Authorized human tester to trigger 1 live escalation turn during chat/voice testing to verify end-to-end insertion into `escalations` and Slack notification | **Jason / Authorized Tester** |
| **F — Delivery attribution, dashboard publication & governance** | **`HISTORICAL EVIDENCE VERIFIED — FRESH ATTRIBUTION PENDING`** | [007 migration](../../db/migrations/007_add_provider_sid_and_updated_at_to_messages_out.sql), [020 migration](../../db/migrations/020_dashboard_publish_outcomes.sql), [transport/twilio/outbound.ts](../../engine/src/transport/twilio/outbound.ts) | `tests/transport/delivery_persistence.test.ts`, `tests/publishers/turn_event_contract.test.ts` (`PASS`) | Production DB verified: Historical records from 2026-10-30 show 2 delivered SMS (Twilio SIDs: `SMdd413c99025787c3a92c9a7c5e91de77`, `SMd9ecf40685cc36db7d184ec776dc0afb`), ElevenLabs TTS synthesized audio + voice lane sent records across CallSIDs `CA00c75d6e31e3e604e542f4ef05efbeb8` and `CAe444cd581967be81a5bbdb8eb0c55168`. 43 published `cst.turn` rows, 12 published `cst.delivery` rows; #20, #21, #41 `200 OK`. | Provide explicit authorized test phone destination and consent to execute 1 fresh post-PR #23 live SMS turn and voice call to capture live provider callback attribution and completed call outcome | **Jason / Authorized Tester** |

---

## 5. Health Probe Cold-Start Authentication & Upstream Farm Health Semantics

### 5.1 Cold-Start Static `VFARM_JWT` Expiry & CST Health Probe Design
- **Cold Container Behavior:** When CST deploys or cold-boots on Render, the initial execution of `GET /api/health` probes vFarm using the static environment variable `VFARM_JWT`.
- **Expired Token:** This static token expired on `2026-10-23T20:05:24Z`. As a result, the cold probe receives HTTP 401 from vFarm and truthfully sets `api_reachability: { status: "unavailable", reason: "probe_failed:auth" }`, classifying `status: "unknown"` (Test #3 `DEGRADED`).
- **Dynamic Warming:** When Phase 4/5 admin routes run, they invoke `ensureAdminToken()`, authenticating against vFarm using `VFARM_ADMIN_USER` and `VFARM_ADMIN_PASSWORD` and caching `this.adminJwt`. Subsequent calls to `GET /api/health` (such as the warm probe at `22:48:18Z`) succeed with `api_reachability: { status: "healthy" }` (`889ms`).
- **Remediation Action:** CST Ops should update the static `VFARM_JWT` environment variable on Render, or CST engineering should update `getHealth()` so that it dynamically acquires an admin token when missing or expired instead of purely relying on the static environment variable.

### 5.2 Upstream Farm Health Semantics Resolution
- **Upstream Farm Health Status (`/api/v1/farms/{farm_id}/health`):**
  - Upstream vFarm returns `status: "neutral"`, `health_score: null`, and `calculated_at: null`.
  - CST truthfully maps this unrecognized status to `farm_health.status: "degraded"` with `staleness_evaluation: "unavailable_no_timestamp"`.
- **Upstream Action Required (Jeganathan):**
  - Confirm whether `"neutral"` is an intended nominal status enum or indicates an uncomputed health background job.
  - Populate `health_score` and `calculated_at` timestamps so CST can evaluate real-time farm health scores.

---

## 6. Research Twin Integration Status & Gate

The Research Twin integration is verified as follows:

1. **Production Configuration Presence Confirmed:**
   - Render environment variables `RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, and `RT_CALLBACK_SIGNING_SECRET` are verified populated.
   - Render startup logs (`dep-dbkh3p6417fc73bffihg` at `22:43:26.799Z`) confirm:
     ```json
     {"timestamp":"2026-11-02T22:43:26.799Z","level":"INFO","message":"Research Twin integration configuration checked","state":"blocked","operational":false,"contract":"unverified","missing":[]}
     ```
   - Live endpoint `GET /api/health` at `22:48:18.788Z` returns:
     ```json
     "research_twin": {
       "state": "blocked",
       "operational": false,
       "contract": "unverified",
       "endpoint_configured": true,
       "service_api_key_configured": true,
       "callback_signing_secret_configured": true,
       "missing": [],
       "reason": "approved Research Twin API and callback contract is not verified"
     }
     ```
2. **Fail-Closed Contract Boundary Remains Active:**
   - CST refuses to send speculative payload formats to `RT_ENDPOINT_URL`.
   - The integration will remain classified as `BLOCKED` until:
     - Destiny Arupi confirms the outbound HTTP POST schema and expected response structure.
     - Destiny Arupi confirms the inbound HMAC signature header and lifecycle update webhook payload.
     - One signed callback round-trip is completed and verified in the CST database.

---

## 7. Database Migration Architecture & Production Governance Policy

### 7.1 Verified Production Architecture
- **Configured Render Start Command:** `node scripts/migrate.js && npm start`.
- **Startup Execution:** Every deployment or container restart executes [scripts/migrate.js](../../scripts/migrate.js) before starting the HTTP server.
- **Ledger Verification:** All 24 migration files (`001` through `023`, including both `003` files) are recorded in `schema_migrations` with exact matching SHA-256[0..32] checksums.
- **Reconciliation Complete:** `022_add_escalations_table.sql` and `023_reconcile_duplicate_003_and_schema_drift.sql` are verified applied on Render PostgreSQL `dpg-db8he2qvcj2c73ado3s0-a`.

### 7.2 Mandatory Governance Policy for Future Migrations
Future migrations must not be assumed risk-free simply because `scripts/migrate.js` runs automatically on startup. The following safeguards are mandatory:
1. **Pre-Migration Production Backup:** Always execute a full logical backup (`pg_dump -Fc "$DATABASE_URL" > pre_migration_backup.dump`) prior to merging migrations altering existing tables or constraints.
2. **Peer Review & Staging Dry-Run:** Test every SQL file against a PostgreSQL 16 replica with production-like volume to detect lock contention, full table rewrites, or index build stalls.
3. **Strict Non-Destructive Principles:** Never drop columns or tables in the same release cycle that writes to them. Use forward-only, idempotent statements (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX CONCURRENTLY`).
4. **Advisory Lock & Transaction Safety:** Ensure all migrations run inside a transaction with advisory locking (`pg_advisory_lock`) to prevent concurrent migration execution during overlapping Render rolling restarts.
5. **Post-Migration Verification:** Immediately verify `schema_migrations`, query table metadata via `information_schema`, and run regression tests before routing production customer traffic.

---

## 8. Dependency Security Audit (`npm audit`)

Full dependency security audits were executed following clean package installation:

| Scope | Command | Total Packages Audited | Vulnerabilities Found | Exit Code |
|---|---|---|---|---|
| **Production Runtime** | `npm audit --omit=dev` | `158` | **3 Moderate** | `1` |
| **Full Development Workspace** | `npm audit` | `265` | **3 Moderate** | `1` |

### Detailed Vulnerability Breakdown
1. **Advisory `GHSA-3g3m-2fjr-6pw4` (Severity: Moderate):**
   - **Vulnerability:** AbortSignal cancellation bypass in `glob` allows post-timeout filesystem traversal.
   - **Vulnerable Versions:** `glob@3.0.0 - 14.0.1` (installed: `11.1.0`).
   - **Dependency Chain:** `swagger-jsdoc@6.3.0` (direct production dependency) -> `glob@11.1.0` (transitive).
2. **Advisory `GHSA-g3hv-75wg-m249` (Severity: Moderate):**
   - **Vulnerability:** Potential denial of service in `minimatch` via globparts amplification.
   - **Vulnerable Versions:** `minimatch <11.0.1` (installed: `10.0.1`).
   - **Dependency Chain:** `swagger-jsdoc@6.3.0` -> `glob@11.1.0` -> `minimatch@10.0.1` (transitive).
3. **Disposition & Mitigation:**
   - The direct dependency `swagger-jsdoc` is invoked exclusively during server boot to parse static local file paths for OpenAPI documentation (`/api-docs`). It is not exposed to untrusted network input or runtime user-supplied globs.
   - Running `npm audit fix --force` would downgrade to `swagger-jsdoc@6.2.8`, introducing potential breaking API changes. The issue is tracked for planned dependency upgrade during the next regular maintenance window.

---

## 9. 12-Item Jason Payment-Gate Closure Checklist

| # | Payment-Gate Closure Item | Status | Evidence / Remaining Requirement |
|---|---|---|---|
| **1** | Production repository, branch, and live deployment verified | **`VERIFIED`** | `bhanetworkgh/bha_cst` @ `441d2b3f4a49c983f45131c229888a60116b9437` live on Render (`dep-dbkh3p6417fc73bffihg`) |
| **2** | All 4 canonical sensors stream fresh live telemetry via interim endpoint | **`VERIFIED`** | Tests #46, #49, #52, #55 all `200 OK` (<600ms) with fresh (<60s) live data on `dep-dbkh3p6417fc73bffihg` |
| **3** | Authoritative vFarm `/readings/latest` & `/readings/stats` indexed and functional | **`BLOCKED` (Jeganathan)** | Upstream `readings` table needs composite index on `(sensor_id, reading_ts DESC)` |
| **4** | Upstream `/system/stats` timeout & `/alerts/threshold/counts` 422 resolved | **`BLOCKED` (Jeganathan)** | FastAPI route ordering bug and full-table count optimization needed in vFarm |
| **5** | Truthful device presence, staleness, and pH calibration verified | **`VERIFIED`** | `rack1_ph` calibrated at `5.06 pH`; CST truthfully flags stale telemetry and health status |
| **6** | Cold-start health probe auth and upstream farm health semantics resolved | **`OPEN` (CST Ops & Jeganathan)** | Cold boot returns `probe_failed:auth` due to expired static `VFARM_JWT` on Render; upstream `/api/v1/farms/{id}/health` returns `raw_status: "neutral"` with null timestamps |
| **7** | Production database migrations `022` and `023` verified applied | **`VERIFIED`** | Verified in `schema_migrations` on `dpg-db8he2qvcj2c73ado3s0-a/bha_cst_1sh0` (24 of 24 applied) |
| **8** | Conversational greeting & help copy verified in code and database | **`VERIFIED`** | Verified in `systems.onboarding_reply`, `projects.onboarding_reply`, and automated test suites |
| **9** | Authorized human Browser Chat acceptance test completed | **`AWAITING JASON`** | Test procedure documented in [CST_Human_Acceptance_Test_Plan.md](CST_Human_Acceptance_Test_Plan.md) (Suite 1) |
| **10** | Authorized human live Voice Call (`+19715885823`) completed | **`AWAITING JASON`** | Test procedure documented in [CST_Human_Acceptance_Test_Plan.md](CST_Human_Acceptance_Test_Plan.md) (Suite 2) |
| **11** | Research Twin credentials configured & wire contract verified | **`PARTIALLY SATISFIED` (Destiny Arupi)** | Credentials live on Render (`missing: []`); awaiting wire contract & signed callback round-trip |
| **12** | Fresh post-PR #23 live SMS turn & delivery callback attribution proof captured | **`AWAITING JASON`** | Historical 2026-10-30 records present in DB; fresh post-PR #23 live SMS turn and voice call require authorized test destination phone and consent confirmation per Suite 3 |

---

## 10. External Action Register

| ID | Owner | Target System | Action Required | Impacted Requirements | Reference Document |
|---|---|---|---|---|---|
| **ACT-OPS-1** | **CST Ops / Engineering** | CST Engine / Render Config | Resolve cold-start health probe authentication failure (`probe_failed:auth`) by rotating static `VFARM_JWT` on Render or updating `getHealth()` to acquire dynamic tokens via `ensureAdminToken()` | Req B | [CST_Production_Test_Results_Analysis.md](CST_Production_Test_Results_Analysis.md) |
| **ACT-VF-1** | **Jeganathan** | vFarm Database | Add composite index `idx_readings_sensor_reading_ts_desc` on `readings(sensor_id, reading_ts DESC)` so `/api/v1/readings/latest` (<500ms) and `/api/v1/readings/stats` (#47, #50, #53, #56) do not time out | Req A | [CST_vFarm_Upstream_Action_Request.md](CST_vFarm_Upstream_Action_Request.md) |
| **ACT-VF-2** | **Jeganathan** | vFarm API Router | In FastAPI alerts router, move `@router.get("/threshold/counts")` above `@router.get("/threshold/{rule_id}")` to fix HTTP 422 (#43), and optimize `/system/stats` (#42) | Req A, Req E | [CST_vFarm_Upstream_Action_Request.md](CST_vFarm_Upstream_Action_Request.md) |
| **ACT-VF-3** | **Jeganathan** | vFarm Farm Admin | Deactivate empty `Test 001` farm (`ed95e120-74c4-4126-a2e9-0e4ffa9275e6`, 0 devices) or confirm `VFARM_FARM_ID=21dde23e-f7f6-46bc-9b54-e97fabaaafd7` (`v-farm`, 23 devices); populate `calculated_at` / `health_score` on `/api/v1/farms/{id}/health` | Req A, Req B | [CST_vFarm_Upstream_Action_Request.md](CST_vFarm_Upstream_Action_Request.md) |
| **ACT-RT-1** | **Destiny Arupi** | Research Twin | Confirm wire schema for `RT_ENDPOINT_URL` and HMAC signature format for `RT_CALLBACK_SIGNING_SECRET`; execute 1 signed callback test | Req D | [CST_Research_Twin_Integration_Handoff.md](CST_Research_Twin_Integration_Handoff.md) |
| **ACT-QA-1** | **Jason / Tester** | Production Services | Provide explicit authorized test phone destination, recipient consent, and approved script to execute fresh Browser Chat, live Voice Call, escalation, and SMS delivery attribution proofs | Req C, Req E, Req F | [CST_Human_Acceptance_Test_Plan.md](CST_Human_Acceptance_Test_Plan.md) |

---

## 11. Final Readiness Verdict

**`PARTIALLY READY — EXTERNAL EVIDENCE REQUIRED`**

CST's internal engineering, multi-tenant database migrations (`001`–`023`), and interim sensor telemetry streaming are operating successfully in production deployment `dep-dbkh3p6417fc73bffihg`. Final payment-gate closure remains blocked exclusively on upstream vFarm indexing/route fixes, Research Twin wire-contract confirmation, and authorized human test execution.
