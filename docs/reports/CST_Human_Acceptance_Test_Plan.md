# CST — Human Acceptance Test Plan (Browser Chat, Voice Call & Approved SMS)

**Date:** 2026-11-02  
**Target Environment:** `https://bha-cst-7u9e.onrender.com` (`bha-cst`, Deployment `dep-dbkgavp5efls73ag1olg`, SHA `fa701a3f7e2a4c642307d018f9a4a123cc6007d3`)  
**Decision Watch Reference:** `DW-1793626498819-PDQ2` (Requirements C, E, and F)

---

## 1. Purpose & Operating Guardrails

Per strict operating constraints, automated agents **must not** initiate real outbound SMS messages, place live voice calls, or fabricate human acceptance sign-off.

This test plan provides the exact, step-by-step verification procedures for an **authorized human tester** (Jason or designated operator) to execute and record the remaining human acceptance proofs for:
1. **Test Suite 1:** Authorized Browser Chat (`POST /api/v1/admin/chat` / Admin Console Live Chat UI) — Requirement C & E
2. **Test Suite 2:** Live Voice Call (`+19715885823`) — Requirement C & E
3. **Test Suite 3:** Single Approved SMS Turn & Delivery Callback Attribution — Requirement E & F

---

## 2. Test Suite 1 — Authorized Browser Chat Verification (Zero Telecom Cost)

### 2.1 Objective
Verify conversational help copy, greeting, multi-turn context retention, sensor status inquiry (`rack1_soil`, `rack1_ph`, `rack2_dht`, `rack1_mq7`), escalation creation, and Engine Dashboard `cst.turn` publication.

### 2.2 Procedure
1. Open the Admin Console at `https://bha-cst-7u9e.onrender.com/admin` and sign in using `ADMIN_API_KEY`.
2. Navigate to the **Chat / Simulator** tab (or call `POST /api/v1/admin/chat` with `Authorization: Bearer $ADMIN_API_KEY`).
3. **Turn 1 (Greeting):** Send `"Hi"`.
   - **Expected Result:** Conversational greeting (`"Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?"`) — no bulleted menu dump or raw sensor IDs.
4. **Turn 2 (Help):** Send `"help"`.
   - **Expected Result:** Conversational help response (`"I can check your farm's temperature, humidity, soil moisture, pH, or air quality, review recent alerts, or connect you with a specialist. Just tell me what you'd like to check."`).
5. **Turn 3 (Sensor Status):** Send `"How are the sensors on my cabinet doing?"`.
   - **Expected Result:** Response summarizes `rack1_soil` (`0%`), `rack1_ph` (`25.19 pH` with calibration/range note), `rack2_dht` (`26.8 °C`), and `rack1_mq7` (`201 ppm`), explicitly noting that the readings are stale (`2026-10-30T19:33:27Z`).
6. **Turn 4 (Escalation):** *(Run after `022_add_escalations_table.sql` is applied in production)* Send `"I need to speak with a human technician about the pH sensor."`.
   - **Expected Result:** Creates an `OPEN` escalation row visible in `GET /api/v1/admin/escalations` and publishes a `cst.turn` event to the Engine Dashboard.

### 2.3 Evidence to Record
- Conversation ID (`conv_...`)
- `GET /api/v1/admin/conversations/<conv_id>/messages` JSON output
- `GET /api/v1/admin/dashboard-outcomes` showing `status: "ok"` and HTTP `200`/`202` from `ENGINE_DASHBOARD_URL`

---

## 3. Test Suite 2 — Live Inbound Voice Call Acceptance (`+19715885823`)

### 3.1 Objective
Verify end-to-end Twilio Voice -> CST Voice Orchestrator -> ElevenLabs TTS (`voice_id: 7fF3B36kM9k8P1w5N2x4` / configured voice) -> conversational speech quality, barge-in handling, latency (`< 4,500ms` lane deadline), and `voice_deliveries` persistence.

### 3.2 Procedure
1. From a registered customer phone (e.g., `+19715550101` or authorized operator phone mapped to `tenant-vfarm-01` / `proj-vfarm-main`), dial **`+19715885823`**.
2. **Verify Greeting:** Confirm the initial voice greeting plays clearly using the ElevenLabs voice without robotic menu numbering.
3. **Ask a Status Question:** Speak: *"What is the current temperature and soil moisture?"*
   - **Expected Result:** Natural spoken response reporting temperature (`26.8 degrees Celsius`) and soil moisture (`0 percent`), noting data staleness clearly.
4. **Ask for Help:** Speak: *"What can you help me with?"*
   - **Expected Result:** Conversational spoken summary of capabilities.
5. **Hang Up & Inspect Telemetry:**
   - Query `GET /api/v1/admin/voice-calls?tenant_id=tenant-vfarm-01` and `GET /api/v1/admin/conversations?tenant_id=tenant-vfarm-01`.

### 3.3 Evidence to Record
- Twilio `CallSid` (`CA...`)
- `voice_deliveries` row showing `tts_provider: "elevenlabs"`, latency metrics, and `status: "completed"`
- Human tester sign-off note on audio clarity and naturalness

---

## 4. Test Suite 3 — Single Approved Real SMS & Delivery Attribution Proof

### 4.1 Objective
Verify that a real SMS turn sent from/to an authorized handset transitions cleanly through:
`queued` -> `sending` -> `sent` -> Twilio StatusCallback (`/webhooks/twilio/status`) -> `delivered` (or `undelivered` with `error_code` if carrier-blocked), and publishes the attributed outcome to the Engine Dashboard.

### 4.2 Procedure (Requires Explicit Jason Pre-Approval for 1 SMS)
1. Confirm Twilio StatusCallback URL is configured to `https://bha-cst-7u9e.onrender.com/webhooks/twilio/status`.
2. From an authorized handset registered to `tenant-vfarm-01` / `proj-vfarm-main`, send 1 inbound SMS `"status"` to `+19715885823`.
3. Wait 10–15 seconds for the outbound reply to be dispatched by `OutboundWorker` and for Twilio to post the `MessageStatus` callback (`sent` -> `delivered`).
4. Query the read-only admin endpoints to capture the durable attribution trail:
   ```bash
   curl -sS -H "Authorization: Bearer $ADMIN_API_KEY" \
     "https://bha-cst-7u9e.onrender.com/api/v1/admin/outbound-queue?tenant_id=tenant-vfarm-01"
   curl -sS -H "Authorization: Bearer $ADMIN_API_KEY" \
     "https://bha-cst-7u9e.onrender.com/api/v1/admin/dashboard-outcomes?tenant_id=tenant-vfarm-01&limit=5"
   ```

### 4.3 Evidence to Record
- Inbound Twilio `MessageSid` (`SM...`) and Outbound Twilio `provider_message_sid` (`SM...`)
- `messages_out` / `outbound_delivery_attempts` record showing `provider_status: "delivered"`, `delivered_at` timestamp, and `error_code: null`
- `dashboard_publish_outcomes` record confirming downstream Dashboard receipt

