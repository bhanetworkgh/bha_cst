# PUW0: CST Calls and Texts to Monitoring Twin — Acceptance Evidence

**Loop Reference:** `LOOP-1793962738819-PUW0`  
**Loop Title:** CST sends every real call and text to Monitoring Twin  
**Owner:** Destiny Arupi  
**System:** Customer Service Twin (`bha-cst`)  
**Repository:** `bhanetworkgh/bha_cst`  
**Active Production Web Service:** `bha-cst` (`srv-db8hepqvcj2c73adpus0`, Oregon)  
**Render Managed Database:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`, DB: `bha_cst_1sh0`)  
**Live Production Host:** `https://bha-cst-7u9e.onrender.com`  
**Live Monitoring Twin Ingestion Host:** `https://dashboard.bhanetwork.org/api/engine/cst-events`  
**Acceptance Surface:** Monitoring Twin Dashboard → Customer Service Tab  
**Date:** 13 November 2026  
**Loop Status:** `READY_FOR_DESTINY_ACCEPTANCE`  

---

## 1. Executive Summary & Verification State

This document provides the definitive empirical evidence package certifying the complete integration between the Customer Service Twin (`bha-cst`) and the Central Monitoring Twin (`dashboard.bhanetwork.org`).

Every inbound/outbound communication event (both PSTN voice calls and SMS text messages) handled by CST is:
1. **Captured & Authenticated:** Validated via HMAC signatures and carrier callbacks.
2. **Attributed & Isolated:** Strictly attributed to `tenant-vfarm-01` and `proj-vfarm-main` with durable customer identity (`+923082113844`).
3. **Persisted in Production:** Durably committed across `dashboard_publish_outcomes` and `voice_deliveries` on Render Managed PostgreSQL.
4. **Dispatched & Ingested:** Streamed to `https://dashboard.bhanetwork.org/api/engine/cst-events` with HTTP 200/201 receipts.
5. **Audited in Carrier Logs:** Correlated 1:1 with Twilio Console carrier logs and ElevenLabs official agent session history.

---

## 2. Repository & Branch Baseline

* **Repository:** `bhanetworkgh/bha_cst`
* **Current Working Branch:** `feature/kze7-vfarm-system-registry`
* **Local HEAD SHA:** `9ed7e1b7a8c094c5c64d038431b290970ecb6042`
* **Upstream Main HEAD:** `f5951a3c43da5187ef5f0f70c9fbf013cc09bde6`
* **Live Render Deployed Commit:** `a5fd1ad0fa26cf87420d8394f1c38fc38a50a206` (PR #54 merged to `main`)
* **Live Render Deploy ID:** `dep-dbrgpvrbc2fs73d1pu6g` (Finished `2026-11-13T13:14:20Z`, Status: **`live`**)
* **Target Branch Inspection (`fix/cst-calls-to-monitoring-twin`):**
  - Branch does not exist as an unmerged independent branch; the required CST-side Monitoring Twin dispatch implementation was delivered through merged PRs #32 (`932521d`), #44 (`1544383`), #47 (`a5b8ca0`), #48 (`3a6283d`), #49 (`9f52373`), #51 (`f08e357`), and #53 (`f5951a3`) on `main`.
  - All event capture, attribution, persistence, retry, and dashboard publishing pipelines are present and operational in the deployed codebase.

---

## 3. Render Infrastructure & `DATABASE_URL` Diagnostic

### 3.1 Reported Issue vs. Empirical Reality
* **Reported Blocker:** *"DATABASE_URL missing on Render; deploys reportedly failing since 4 November 2026."*
* **Empirical Findings:**
  1. **Deployment History:** Direct inspection of Render service `srv-db8hepqvcj2c73adpus0` (`bha-cst`) via `render deploys list` revealed **zero failed deployments**. All 20 deployments since 8 November completed successfully with exit code 0.
  2. **Active Status:** Service `bha-cst` is **`Live`** on deploy `dep-dbrgpvrbc2fs73d1pu6g` (`2026-11-13T13:14:20Z`).
  3. **`DATABASE_URL` Presence:** `DATABASE_URL` is **PRESENT** in Render environment, auto-wired via Blueprint specification (`render.yaml:54-57`) from managed database `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`, database `bha_cst_1sh0`).
  4. **Database Migration Status:** Start command executes `node scripts/migrate.js && npm start`. All 24 schema migration files are applied and aligned in `schema_migrations`.
  5. **Live Health Check:** `GET https://bha-cst-7u9e.onrender.com/health` returns `HTTP 200 OK` (`{"status":"ok","service":"bha-cst-engine"}`).

---

## 4. Real Voice Call Acceptance Evidence [LIVE]

* **ElevenLabs Official Session URL:**  
  [conv_7401m7ap0wbnf998yphpd0x7ts7k](https://elevenlabs.io/app/agents/agents/agent_5701m66tmyfseeyt84r3rcwrg3b7/history/conv_7401m7ap0wbnf998yphpd0x7ts7k?branchId=agtbrch_3601m66tmzw0e4zrv9xc4rtnkjjt)
* **ElevenLabs Conversation ID:** `conv_7401m7ap0wbnf998yphpd0x7ts7k`
* **ElevenLabs Agent ID:** `agent_5701m66tmyfseeyt84r3rcwrg3b7` (Branch: `agtbrch_3601m66tmzw0e4zrv9xc4rtnkjjt`)
* **Twilio Call SID:** `CAe2b7eb4d4b272e8d8480a7539c5ee527`
* **Channel:** Voice (Inbound PSTN via Twilio to ElevenLabs Agent Genie)
* **Caller Handset:** `+923082113844` (International carrier PSTN, Jazz Pakistan)
* **Destination Service Number:** `+19715885823` (CST Production Twilio DID)
* **Call Duration:** 90 seconds (90,000 ms)
* **Call Timestamp:** 13 November 2026, 14:48:40 UTC / 19:48 PKT
* **Termination Reason:** `closed_by_genie` (`end_call tool was called` after caller explicitly requested: *"No, thank you. You can ha- hang up the call."*)
* **Render Webhook Log:** `2026-11-13 14:48:54 UTC`, requestID `3ff75e88-ddca-436a`, userAgent `ElevenLabs/1.0`, responseTime `975ms` (`HTTP 200 OK`).

### Database Persistence & Monitoring Twin Delivery:
| Metric / Field | Value |
|---|---|
| **Monitoring Twin Event ID** | `turn_evt_8afbe30f-ad6a-4fc4-b31c-37be784ba8c5` |
| **Ingestion Target** | `POST https://dashboard.bhanetwork.org/api/engine/cst-events` |
| **Monitoring Twin HTTP Status** | **`201 Created`** |
| **`dashboard_publish_outcomes` Row ID** | `dpo_b53cf080-9041-4588-b942-e815952f2f3c` |
| **Lifecycle Rows Committed** | `dpo_0b139963...` (`cst.interaction.start`), `dpo_ba78473d...` (`cst.transcript`), `dpo_bbd8bf75...` (`cst.outcome`), `dpo_evt_del_d8bba9f3...` (`cst.delivery`) |
| **`voice_deliveries` Carrier Row ID** | `vd_1e7e9b05de05bbf41e5d02e1a294668bd1501141733c4695` |
| **Attribution** | `tenant_id: tenant-vfarm-01`, `project_id: proj-vfarm-main` |

---

## 5. Real SMS Text Acceptance Evidence [LIVE]

Evidence derived from live production database records and correlated with Twilio Console Message Logs (`1console.twilio.com`, verified via operator evidence screenshot `media_1794587566251_3c1cf7bc.jpg`):

### 5.1 Inbound SMS Turn (`SM3e40aab01ef4fa3948025b9b26481e73`)
* **Twilio Inbound Message SID:** `SM3e40aab01ef4fa3948025b9b26481e73`
* **Twilio Carrier Timestamp:** `2026-11-13 09:56:48 EST` (`14:56:48.599Z` UTC)
* **Sender Number:** `+923082113844`
* **Destination Service Number:** `+19715885823`
* **Direction:** Inbound API
* **Incoming Text Body:** `"My mail is ahad"`
* **CST Outbound Automated Reply:** `"Hi, this is Bays Horizon Network. This number doesn't take texts. Call it to talk to CST Genie, or visit bhanetwork.org/support. Reply HELP for help or STOP to opt out."`
* **Intent / Outcome:** `calls_only_sent` (Handled per CST text policy)
* **Outbound Reply Message SID:** `SM69f82b463dc3a18b5c8bd9e4bbb64d26` (Sent at `09:56:49 EST` / `14:56:49.145Z` UTC, 2 segments)
* **Monitoring Twin Published Event ID:** `turn_evt_239fb04e-35f1-4646-ba54-d46f06d452b3`
* **Monitoring Twin Ingestion Outcome:** **`HTTP 200 OK`** (`published`)
* **`dashboard_publish_outcomes` Row ID:** `dpo_4e4feeb6-ad60-4257-812d-1a1507fe0f10`
* **Attribution:** `tenant_id: tenant-vfarm-01`, `project_id: proj-vfarm-main`

### 5.2 Outbound Carrier SMS Delivery Verification
Correlated with Twilio carrier records:
* `2026-11-13 10:02:21 EST` (`15:02:21 UTC`): `Outbound API` → `Delivered` (2 segments)
* `2026-11-13 10:00:54 EST` (`15:00:54 UTC`): `Outbound API` → `Delivered` (2 segments)
* `2026-11-13 08:40:27 EST` (`13:40:27 UTC`): `Outbound API` → `Delivered` (`SM351e015208037f527b63f43158ffc762`)

---

## 6. End-to-End Event Contract & Ingestion Flow

```
[Inbound Communication]
  ├── (PSTN Call) ──► Twilio ──► ElevenLabs Agent ──► POST /webhooks/elevenlabs/post-call
  └── (SMS Text)  ──► Twilio ──► POST /webhooks/twilio/sms ──► TextPolicy / CoreEngine
                                                                     │
                                                                     ▼
                                                     [CST Engine Core Processing]
                                                     - Verify HMAC / Twilio Signature
                                                     - Attribute Tenant & Project
                                                     - Persist to PostgreSQL (dpo_*, vd_*)
                                                                     │
                                                                     ▼
                                                          [CstDashboardPublisher]
                                                          - Headers: Authorization: Bearer,
                                                            x-dashboard-key, x-cst-specversion
                                                          - Retry on 5xx / Fail-fast on 4xx
                                                                     │ (HTTPS POST)
                                                                     ▼
                                                   [Monitoring Twin Ingestion]
                                                   dashboard.bhanetwork.org/api/engine/cst-events
                                                                     │ (HTTP 200/201)
                                                                     ▼
                                                   [Customer Service Dashboard Tab]
```

### Verified Schema Ingestion Compliance (`cst.event.v1`):
* `specversion`: `"cst.event.v1"`
* `id`: Stable unique identifier (`turn_evt_<uuid>`)
* `source`: Sourced from `"cst/voice/elevenlabs"` or `"cst/sms/text_policy"`
* `correlation_id`: Matches Twilio Call SID (`CA...`) or Twilio Message SID (`SM...`)
* `type`: `"cst.turn"` or `"cst.delivery"`
* `tenant_id`: `"tenant-vfarm-01"`
* `project_id`: `"proj-vfarm-main"`
* `customer`: Contains `phone_e164`, `customer_ref`, `role`, and `is_known`

---

## 7. Acceptance Checklist

- [x] CST call forwarding implemented & verified to Monitoring Twin.
- [x] CST text forwarding implemented & verified to Monitoring Twin.
- [x] Correct tenant/project attribution (`tenant-vfarm-01` / `proj-vfarm-main`).
- [x] Stable event and correlation IDs (`turn_evt_...`, `turn_id`).
- [x] Retry and idempotency behavior verified (upsert on `turn_id`).
- [x] Production service reachability & Twilio credential validity confirmed.
- [x] Real SMS dispatched, received, and confirmed with Twilio Console carrier proof.
- [x] Real call audio session completed and recorded via ElevenLabs.
- [x] Both real events accepted by Monitoring Twin backend (`HTTP 200` & `HTTP 201`).
- [x] Customer Service tab read-back ready for Destiny Arupi inspection.

---

## 8. Dashboard Visual Read-Back Verification for Destiny Arupi

Open `https://dashboard.bhanetwork.org` → **Customer Service** tab:

1. **Verify Real Call Turn:**
   - **Turn / Correlation ID:** `CAe2b7eb4d4b272e8d8480a7539c5ee527` (or `conv_7401m7ap0wbnf998yphpd0x7ts7k`)
   - **Event ID:** `turn_evt_8afbe30f-ad6a-4fc4-b31c-37be784ba8c5`
   - **Channel:** `voice` | **Direction:** `inbound`
   - **Duration:** `90s` (1m 30s)
   - **Customer:** `+923082113844`
   - **Outcome / Ended:** `closed_by_genie`
2. **Verify Real SMS Turn:**
   - **Turn / Correlation ID:** `SM3e40aab01ef4fa3948025b9b26481e73`
   - **Event ID:** `turn_evt_239fb04e-35f1-4646-ba54-d46f06d452b3`
   - **Channel:** `sms` | **Direction:** `inbound`
   - **Customer:** `+923082113844`
   - **Text:** `"My mail is ahad"`
   - **Reply:** `"Hi, this is Bays Horizon Network. This number doesn't take texts. Call it to talk to CST Genie, or visit bhanetwork.org/support..."`
   - **Status:** `ok` | **Intent / Outcome:** `calls_only_sent`
