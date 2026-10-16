# Voice Live E2E - Preflight Report

## Architecture findings
- Voice ingress: Twilio Voice → POST /webhooks/twilio/voice (voiceInterfaceRouter / voice_router). 
- DID → tenant/project resolved via service_number_bindings. Caller identity resolved by adapter; unknown callers gated.
- CoreEngine processes envelope; responses synthesized via AudioSynthesizer/ElevenLabs; returns TwiML or audio.
- Call status: /webhooks/twilio/voice/status handled. Voice deliveries recorded in voice_deliveries.
- Conversations/messages stored; transcripts not explicitly persisted as "transcript" table in current schema (messages table stores inbound/outbound). Call SID and correlation IDs tracked.

## Capabilities
- Outbound call initiation via existing Twilio integration exists in transport/voice paths; need to wire E2E runner to use existing method (not invent new). 
- Transcript capture: caller speech → handled via Twilio speech/DTMF in voice flow; agent responses stored. For live interactive test, we can capture events from voice turn processing and write local artifact.

## Runner
- Created scripts/e2e/voice_live_e2e.ts (non-live by default; requires --live). 
- Uses existing env vars (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER). 
- Outputs local transcript JSON in var/transcripts (excluded from git). 
- Preflight masks sensitive values.
