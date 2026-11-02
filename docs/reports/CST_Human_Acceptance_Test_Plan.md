# CST — Human Acceptance Test Plan (Browser Chat, Voice Call & Approved SMS)

**Date:** 2026-11-02
**Target Environment:** `https://bha-cst-7u9e.onrender.com` (`bha-cst`, Deployment `dep-dbkh3p6417fc73bffihg`, PR #23 Merge Commit `441d2b3f4a49c983f45131c229888a60116b9437`, live at `2026-11-02T22:43:32.077742Z`)
**Decision Watch Reference:** `DW-1793626498819-PDQ2` (Requirements C, E, and F)

---

## 1. Purpose & Live Authorization Gate (Phases 6 & 7 Status: `BLOCKED`)

Per strict execution rules (Section 1.C — Live SMS and voice authorization), before initiating a real outbound SMS or a real voice call, all six prerequisites must be explicitly confirmed:
1. Exact test destination (`phone_e164`).
2. Confirmation that the destination is controlled by the user or an authorized test recipient.
3. Confirmation of recipient consent (`sms_consents` `opted_in`).
4. Approved message content or call script.
5. Production credentials present on Render (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` — **all verified present on Render**).
6. Confirmation that the test cannot trigger unintended customer workflows.

Because no explicit test phone destination, recipient consent confirmation, or approved SMS message/call script was provided in the prompt, **live outbound SMS (Phase 6) and live voice call (Phase 7) were NOT initiated and are classified as `BLOCKED` awaiting explicit destination/consent/script authorization.**

Note that **migrations `022_add_escalations_table.sql` and `023_reconcile_duplicate_003_and_schema_drift.sql` are now verified applied in production (`dpg-db8he2qvcj2c73ado3s0-a`)**, and **all 4 canonical vFarm sensors (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`) are now streaming fresh live telemetry** (`rack1_soil = 90.0%`, `rack1_ph = 5.06 pH`, `rack2_dht = 28.8 °C / 63% RH`, `rack1_mq7 = 0.76 ppm`), so human acceptance testing can proceed immediately upon destination authorization.

---

## 2. Test Suite 1 — Authorized Browser Chat Verification (Zero Telecom Cost)

### 2.1 Objective
Verify conversational help copy, greeting, multi-turn context retention, live sensor status inquiry (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`), durable escalation creation into the production `escalations` table (`022`), and Engine Dashboard `cst.turn` publication (`020`).

### 2.2 Procedure
1. Open the Admin Console at `https://bha-cst-7u9e.onrender.com/admin` or the Web Chat UI at `https://bha-cst-7u9e.onrender.com/web`.
2. **Turn 1 (Greeting):** Send `"Hi"`.
   - **Expected Result:** Conversational greeting (`"Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?"` — verified in production `systems.onboarding_reply` and `projects.onboarding_reply`) — no bulleted menu dump or raw sensor IDs.
3. **Turn 2 (Help):** Send `"help"`.
   - **Expected Result:** Conversational help response (`"I can check your farm's temperature, humidity, soil moisture, pH, or air quality, review recent alerts, or connect you with a specialist. Just tell me what you'd like to check."`).
4. **Turn 3 (Live Sensor Status):** Send `"How are the sensors on my cabinet doing?"`.
   - **Expected Result:** Response summarizes the fresh live readings: `rack1_soil` (`~90.0%`), `rack1_ph` (`~5.06 pH`), `rack2_dht` (`~28.8 °C`, `~63% RH`), and `rack1_mq7` (`~0.76 ppm`).
5. **Turn 4 (Escalation):** Send `"I need to speak with a human technician about my cabinet."`.
   - **Expected Result:** Persists an escalation row in the production `escalations` table (verified applied in `022_add_escalations_table.sql`), posts a Slack notification (`SLACK_ESCALATION_WEBHOOK_URL`), and publishes a `cst.turn` event to `dashboard_publish_outcomes`.

### 2.3 Evidence to Record
- `conversation_id` (`conv_...`) and `correlation_id`
- `escalations` row in production PostgreSQL (`status: 'notified' | 'pending'`, `slack_notified: true`)
- `dashboard_publish_outcomes` row (`event_type: 'cst.turn'`, `status: 'published'`)

---

## 3. Test Suite 2 — Controlled Inbound/Outbound Voice Call Acceptance (`+19715885823`)

### 3.1 Objective
Verify end-to-end Twilio Voice -> CST Voice Orchestrator -> ElevenLabs TTS (`voice_id: Hmy97GCI840wuICQesiM`, `model_id: eleven_turbo_v2_5`) -> conversational speech quality, barge-in handling, latency (`< 4,500ms` lane deadline), and `voice_deliveries` + `dashboard_publish_outcomes` persistence.

*(Note: Historical production database inspection verified 5 completed voice turns on `2026-10-30 19:17:25Z`–`19:18:14Z` for CallSid `CA00c75d6e31e3e604e542f4ef05efbeb8` with `voice_id = Hmy97GCI840wuICQesiM` and `model_id = eleven_turbo_v2_5`. A fresh post-PR #23 call will confirm the newly deployed conversational greeting and live sensor readings.)*

### 3.2 Procedure
1. From an explicitly authorized and registered customer handset mapped to `tenant-vfarm-01` / `proj-vfarm-main`, dial **`+19715885823`**.
2. **Verify Greeting:** Confirm the initial voice greeting (`"Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?"`) plays clearly using the ElevenLabs voice (`Hmy97GCI840wuICQesiM`) without robotic menu numbering.
3. **Ask a Status Question:** Speak: *"What is the current temperature, pH, and soil moisture?"*
   - **Expected Result:** Natural spoken response reporting fresh temperature (`~28.8 °C`), pH (`~5.06`), and soil moisture (`~90%`).
4. **Ask for Help:** Speak: *"What can you help me with?"*
   - **Expected Result:** Conversational spoken summary of capabilities.
5. **Hang Up & Inspect Telemetry:**
   - Query `voice_deliveries` and `dashboard_publish_outcomes` for the new `CallSid` (`CA...`).

---

## 4. Test Suite 3 — Single Approved Real SMS & Delivery Attribution Proof

### 4.1 Objective
Verify that a single authorized SMS turn transitions cleanly through:
`queued` -> `sending` -> `sent` -> Twilio StatusCallback (`/webhooks/twilio/delivery-status`) -> `delivered`, and publishes both `cst.turn` and `cst.delivery` outcomes to `dashboard_publish_outcomes`.

*(Note: Historical production database inspection verified 2 `delivered` rows in `messages_out` with populated `provider_sid` and `turn_id` on `2026-10-30 16:31:33Z`, plus 12 `published` `cst.delivery` rows in `dashboard_publish_outcomes`. A fresh post-PR #23 SMS turn will provide current-deployment sign-off.)*

### 4.2 Procedure (Upon Explicit Destination & Consent Confirmation)
1. Confirm recipient phone is `opted_in` in `sms_consents` for `tenant-vfarm-01`.
2. Send 1 inbound SMS `"status"` to `+19715885823` from the authorized handset.
3. Wait 10–15 seconds for `OutboundWorker` dispatch and Twilio `/webhooks/twilio/delivery-status` callback (`sent` -> `delivered`).
4. Record the `messages_out` row (`id`, `provider_sid`, `turn_id`, `status = 'delivered'`) and `dashboard_publish_outcomes` rows (`cst.turn` and `cst.delivery`).
