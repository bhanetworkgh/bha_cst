# Voice Acceptance — Inspection Report

> Branch: `fix/monitoring-pay-gate-closure`
> Date: 2026-11-02

## Files Inspected

| File | Lines | Findings |
|---|---|---|
| `engine/src/interfaces/voice/index.ts` | 1770 | Main voice interface router, webhook handler, TwiML generation |
| `engine/src/transport/voice/voice_router.ts` | 174 | Voice routes: `/audio/speak`, `/voice/turn` |
| `engine/src/transport/voice/voice_lane.ts` | — | Voice lane service, synthesis orchestration |
| `engine/src/transport/twilio/signature.ts` | — | Signature verification middleware |
| `render.yaml` | — | Render deployment config, env vars |

## Verification Results

### ✅ Twilio Webhook Paths
- **Inbound webhook:** `/webhooks/twilio/voice/turn` (registered via `voiceInterfaceRouter`)
- **Gather action URL:** Same path, with counter query params (`g=`, `empty=`)
- **Audio playback:** `/api/v1/voice/audio/{audioId}`
- Both `voiceRouter` and `voiceInterfaceRouter` are mounted at app.ts L91-92

### ✅ Public URL Construction
- Priority: `PUBLIC_WEBHOOK_URL` → `CST_SERVICE_URL` → `x-forwarded-host` header → `req.get('host')`
- Render sets `x-forwarded-host` and `x-forwarded-proto`, so URL is derived correctly behind proxy
- Audio base URL: `VOICE_AUDIO_BASE_URL` → derived from request headers

### ✅ Signature Verification
- `verifyTwilioSignature` middleware at `engine/src/transport/twilio/signature.ts`
- Uses `twilio.validateRequest(authToken, twilioSignature, url, params)` with `TWILIO_AUTH_TOKEN`
- Applied to the inbound voice webhook route

### ✅ Receiving-Number Binding
- Twilio voice webhooks are bound via Twilio console configuration to the Render URL
- The webhook handler extracts `From` (caller) and `To` (receiving number) from the POST body
- Speaker identity resolution uses `From` E.164 against the identity registry

### ✅ Voice Configuration
- ElevenLabs synthesis via `AudioSynthesizer` / `createElevenLabsAudioSynthesizer()`
- Voice lane service handles synthesis + caching
- Turn deadline: configurable timeout for webhook response
- Guest handling: MAX_GUEST_ONBOARDING_TURNS = 1, MAX_EMPTY_REPROMPTS = 2

### ✅ Audio Playback
- TwiML `<Play>` verb with URL to `/api/v1/voice/audio/{audioId}`
- Falls back to `<Say>` verb when no audio ID or no base URL available
- Audio served from in-memory or persisted audio store

## ⚠️ BLOCKED — Live Call Test

> [!WARNING]
> **Voice cannot be marked PASS without a live call test.**
>
> A live call requires:
> 1. Twilio account owner authorization for test calls
> 2. Active Twilio phone number bound to the Render deployment webhook
> 3. Valid ElevenLabs API key for synthesis
> 4. Deployed SHA on Render matching this branch
>
> **Precise blocker:** An authorized test call must complete:
> inbound webhook → speech turn → CST response → audio playback →
> persisted transcript + delivery record.
>
> **Request:** The account owner (Jason) must authorize and place a live
> test call to the Twilio number, then verify the transcript and delivery
> record in the admin console.

## Render Environment Variables (Voice-Related)

| Variable | Status | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | ✅ Configured in render.yaml | Secret reference |
| `TWILIO_AUTH_TOKEN` | ✅ Configured in render.yaml | Secret reference |
| `TWILIO_MESSAGING_SERVICE_SID` | ✅ Configured in render.yaml | SMS, not voice |
| `ELEVENLABS_API_KEY` | ⚠️ Not in render.yaml | May be in Render dashboard secrets |
| `PUBLIC_WEBHOOK_URL` | ⚠️ Not in render.yaml | Derived from headers if not set |
| `VOICE_AUDIO_BASE_URL` | ⚠️ Not in render.yaml | Derived from headers if not set |

