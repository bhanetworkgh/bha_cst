# Voice Live E2E - Wired for Outbound Call

## Changes
- scripts/e2e/voice_live_e2e.ts: added live outbound call creation via TwilioClientWrapper.calls.create() when --live is passed. Captures callSid, saves JSON to var/transcripts, exits after initiating one call.

## Behavior
- Non-live: preflight only.
- Live (--live): validates config, requires confirmation intent (printed), creates exactly one outbound call to dest from TWILIO_NUMBER with callbackUrl (CST_VOICE_TWIML_URL or CST_SERVICE_URL/webhooks/twilio/voice). Writes runId, callSid, status, numbers, callbackUrl, timestamp to transcript JSON.

## Safety
- Single call per invocation; no retries; masks values; no secrets printed; uses existing Twilio client and env.
- Non-live default. Will not auto-dial without --live.

## Next
Await explicit authorization to run with --live (real call). After answer, conversation handled by CST voice stack; transcripts/messages persisted by webhooks.
