# CST ElevenLabs & Twilio Outbound Voice Trace and Failure Path Analysis

**Component:** Voice Orchestration Engine  
**Telephony Provider:** Twilio Voice API  
**Speech Synthesis Provider:** ElevenLabs API  
**Primary Architecture Loop:** `LOOP-1789721731998-XXHH`  
**Target Authorized Destination:** `+923082113844`  
**Date:** 2026-11-03  

---

## 1. Voice Routing Architecture

CST integrates Twilio telephony with ElevenLabs neural voice synthesis to deliver human-like, low-latency audio responses to farm managers.

### Happy Path Sequence:
1. **Telephony Trigger:**  
   - Inbound call arrives on bound Twilio service number, or an authorized outbound call is initiated via `POST /api/v1/voice/outbound`.
2. **Security & Tenancy Validation:**  
   - Twilio request signature (`X-Twilio-Signature`) is validated against `TWILIO_AUTH_TOKEN`.
   - The destination number is matched against `service_number_bindings` to establish `tenant_id` and `project_id`.
3. **Turn Processing:**  
   - Caller speech is transcribed and processed through `CoreEngine.processEnvelope()`.
   - CST determines the conversational response text (e.g., farm status, telemetry briefing).
4. **Voice Synthesis (ElevenLabs):**  
   - CST calls ElevenLabs TTS API using `ELEVENLABS_API_KEY` and the assigned clone voice ID (`ELEVENLABS_VOICE_ID`).
   - Audio is generated in MP3 or PCM format and cached in CST's media store.
5. **TwiML Stream / Playback:**  
   - CST returns a TwiML response containing `<Play>` directed at CST's authenticated audio stream URL.
   - Caller hears the synthesized response. Turn metadata and audio latency metrics are durably written to `turns` and `security_ledger`.

---

## 2. Failure Path Tracing & Safeguards

| Failure Mode | Detection Point | CST Defensive Action | Fallback Response |
|---|---|---|---|
| **Twilio Webhook Timeout (>5s)** | Telephony ingress | Fast-path fallback before gateway cancellation | Plays pre-rendered generic acknowledgement TwiML |
| **ElevenLabs API Timeout (>3s)** | Voice synthesis client | Aborts synthesis request via `AbortController` | Falls back to native Amazon Polly / Twilio Say voice (`Polly.Matthew`) |
| **ElevenLabs Quota Exceeded (401/429)** | Voice synthesis client | Logs alert tripwire; switches engine voice mode | Uses Twilio `<Say>` fallback; notifies operator via error log |
| **Missing Voice Clone ID** | Voice configuration | Detected during preflight | Uses project default voice clone |
| **Caller Hangup Mid-Turn** | Status callback webhook | Detects `completed` or `canceled` status | Aborts downstream synthesis; records turn duration and call teardown |

---

## 3. Production Health Diagnostics (`/health/voice`)

The deployed CST service provides real-time voice pipeline diagnostics at `GET /health/voice`:
```json
{
  "status": "healthy",
  "voice_engine": "elevenlabs",
  "voice_clone_id_configured": true,
  "twilio_binding_configured": true,
  "recent_deliveries_24h": 17,
  "last_successful_delivery": "2026-11-02T16:42:11Z",
  "circuit_breaker": "closed",
  "average_synthesis_ms": 642
}
```

---

## 4. Live Outbound Voice Test Prerequisites

To safely execute an authorized live outbound test call to `+923082113844`:
1. Ensure the destination is configured in the test harness.
2. Verify production `/health/voice` reports `"status": "healthy"`.
3. Run the acceptance runner with explicit confirmation:
   ```bash
   npm run acceptance:voice -- --confirm-live-call
   ```
4. Verify call state transitions (`queued` -> `in-progress` -> `completed`) and inspect the generated turn record in the database.

