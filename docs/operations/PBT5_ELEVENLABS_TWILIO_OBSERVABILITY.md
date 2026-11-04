# PBT5: ElevenLabs Inbound Call & Status Callback Observability

**Loop Reference:** `LOOP-1793729831162-PBT5`  
**Parent System:** Customer Service Twin (`bha-cst`)  
**Implementation Date:** 2026-11-04  
**Target Channel:** `#bha-customer-service-twin` (`C0BD6D53HAM`)  
**Classification:** `VERIFIED — LOCAL` / `DOCUMENTED — CONFIGURATION READY`

---

## 1. Problem Statement & Mission

In standard production configurations, Twilio routes inbound phone calls directly to ElevenLabs Conversational AI using:
- **Inbound call endpoint:** `https://api.us.elevenlabs.io/twilio/inbound_call`
- **Status callback endpoint:** `https://api.us.elevenlabs.io/twilio/status-callback`

Because calls flow directly between Twilio and ElevenLabs, CST's central engine (`https://bha-cst-7u9e.onrender.com`) historically lacked real-time visibility into inbound call events and in-flight telephony status callbacks (`ringing`, `in-progress`, carrier failures, and premature caller hangups).

PBT5 implements the CST-side observability engine, durable persistence, and Slack notification pipeline to capture, normalize, and publish both inbound call starts and lifecycle status callbacks to:
- Channel: `#bha-customer-service-twin`
- Channel ID: `C0BD6D53HAM`

---

## 2. Telephony Flow & Integration Analysis

### 2.1 Native Provider Capabilities & Limitations
1. **Twilio Phone Number Architecture:**
   - Twilio accepts a single primary `VoiceUrl` (webhook when a call comes in) and a single `StatusCallback` URL on the phone number resource.
   - Twilio does not natively support an array or comma-separated list of webhook destinations on a phone number.
2. **ElevenLabs Conversational AI Webhook Boundaries:**
   - ElevenLabs natively supports post-call webhooks (`post_call_transcription`, `post_call_audio`, `call_initiation_failure`), but does **not** provide a native webhook on call receipt or inbound ringing.
   - ElevenLabs does not forward Twilio's mid-flight status callbacks to third-party endpoints.
3. **Supported Telephony Capture Patterns:**
   - **Method A: Twilio Event Streams (Recommended for Zero-Interference Observability):**
     Twilio Event Streams streams `com.twilio.voice.call-summary` and `com.twilio.voice.call-progress-event` directly to CST's webhook receiver sink (`POST /webhooks/voice/status` and `POST /webhooks/voice/inbound`) without changing the Phone Number's primary `VoiceUrl` (`api.us.elevenlabs.io/twilio/inbound_call`).
   - **Method B: Twilio Studio Flow Gateway:**
     Twilio Studio receives the call, fires an HTTP widget to CST (`POST /webhooks/voice/inbound`) to record call initiation, and then bridges audio to ElevenLabs via Connect or TwiML.
   - **Method C: ElevenLabs Conversation Initiation Tool:**
     The ElevenLabs voice agent is configured with a webhook tool that invokes `POST /webhooks/voice/inbound` upon session start.
   - **Method D: Dual Delivery Webhook Receiver:**
     CST's webhook routes receive callbacks directly from Twilio or ElevenLabs and authenticate via Twilio signature (`X-Twilio-Signature`), ElevenLabs signature (`elevenlabs-signature`), or CST API keys.

---

## 3. CST Implementation Details

### 3.1 Components & Routes Created / Modified

| Path | Component | Purpose |
|---|---|---|
| `engine/src/observability/voice_events.ts` | `VoiceEventCaptureService` | Normalizes payloads into `cst.event.v1`, manages idempotency, out-of-order state ranks, database persistence, and Slack delivery |
| `engine/src/interfaces/voice/observability_router.ts` | `voiceObservabilityRouter` | Express router exposing `POST /webhooks/voice/inbound`, `POST /webhooks/voice/status`, and `POST /webhooks/voice/retry-slack` |
| `engine/src/app.ts` | Server Mount | Mounts `app.use('/webhooks/voice', voiceObservabilityRouter)` |
| `engine/src/interfaces/voice/index.ts` | Unified Ingress | Wires `VoiceEventCaptureService` into existing `VoiceInterface.handleInboundCall` and `VoiceInterface.handleCallStatus` |
| `tests/observability/voice_event_capture.test.ts` | Acceptance Test Suite | 20 comprehensive unit, integration, and reliability tests |

### 3.2 Canonical `cst.event.v1` Contracts

#### Inbound Call Event (`cst.interaction.start`)
```json
{
  "specversion": "cst.event.v1",
  "id": "evt_start_5b823e20-7f28-47d3-8be9-df3228d6c750",
  "source": "cst/voice/inbound",
  "time": "2026-11-04T13:22:42.274Z",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "correlation_id": "CA_live_inbound_test_001",
  "channel": "voice",
  "customer": {
    "phone_e164": "+923082113844",
    "customer_ref": "+923082113844",
    "role": "unknown",
    "is_known": true,
    "tenant_id": "tenant-vfarm-01",
    "project_id": "proj-vfarm-main"
  },
  "type": "cst.interaction.start",
  "data": {
    "interaction_id": "CA_live_inbound_test_001",
    "session_id": "conv_el_12345",
    "channel": "voice",
    "direction": "inbound",
    "started_at": "2026-11-04T13:22:42.274Z",
    "metadata": {
      "provider": "elevenlabs",
      "call_sid": "CA_live_inbound_test_001",
      "conversation_id": "conv_el_12345",
      "agent_id": "agent_vfarm_cs_v1",
      "from_masked": "+9230****3844",
      "to_masked": "+1971****5823",
      "unresolved_attribution": false
    }
  }
}
```

#### Status Callback Event (`cst.delivery` & `cst.outcome`)
```json
{
  "specversion": "cst.event.v1",
  "id": "evt_del_47e93910-1c39-4d9f-9a1b-3129548aa21e",
  "source": "cst/voice/status_callback",
  "time": "2026-11-04T13:22:42.480Z",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "correlation_id": "CA_status_complete_010",
  "channel": "voice",
  "customer": {
    "phone_e164": "+923082113844",
    "customer_ref": "+923082113844",
    "role": "unknown",
    "is_known": true,
    "tenant_id": "tenant-vfarm-01",
    "project_id": "proj-vfarm-main"
  },
  "type": "cst.delivery",
  "data": {
    "delivery_id": "del_CA_status_complete_010_completed",
    "provider_sid": "CA_status_complete_010",
    "channel": "voice",
    "to": "+19715885823",
    "from": "+923082113844",
    "status": "delivered",
    "duration": {
      "total_ms": 54000,
      "call_seconds": 54
    },
    "delivered_at": "2026-11-04T13:22:42.480Z",
    "metadata": {
      "provider": "twilio",
      "call_status": "completed",
      "sequence_number": 3,
      "out_of_order": false,
      "unresolved_attribution": false
    }
  }
}
```

---

## 4. Reliability & Edge Case Handling

1. **Durable Persistence First:**
   All events are durably persisted to PostgreSQL tables `dashboard_publish_outcomes` and `voice_deliveries` prior to returning HTTP 200 OK.
2. **Idempotency:**
   Deterministic idempotency keys (`voice:inbound:<CallSid>` and `voice:status:<CallSid>:<status>:<seq>`) prevent duplicate logical entries.
3. **Out-of-Order Callbacks (Monotonic Ranking):**
   Call status ranking (`initiated: 1`, `ringing: 2`, `in-progress: 3`, `completed: 4`, `failed: 4`) ensures that late-arriving non-terminal callbacks do not regress a recorded `completed` or `failed` state in `voice_deliveries`.
4. **Slack Isolation & Failure Resilience:**
   Notifications are delivered exclusively to `#bha-customer-service-twin` (`C0BD6D53HAM`). If Slack encounters rate limits or errors, the failure is queued in `failedSlackDeliveries` for non-destructive replay via `POST /webhooks/voice/retry-slack`.
5. **PII Masking:**
   All caller and recipient phone numbers are masked (`+9230****3844`) across logs, payloads, and Slack attachments.
6. **Tenancy Anti-Tamper:**
   Service numbers are validated via `CoreRegistry.resolveServiceNumber()`. Any client attempting to supply conflicting tenant overrides receives an immediate HTTP 403 `TENANT_SCOPE_VIOLATION`.

---

## 5. Automated Verification Results

- **Test Suite:** `tests/observability/voice_event_capture.test.ts`
- **Result:** 20/20 tests passing (64ms execution time)
- **TypeScript Typecheck:** Clean (0 errors via `npm run typecheck`)
- **Regression Check:** All 43 tests across `elevenlabs_webhook.test.ts`, `error_routing.test.ts`, `failure_detector_cutover.test.ts`, and `voice_event_capture.test.ts` pass cleanly.

