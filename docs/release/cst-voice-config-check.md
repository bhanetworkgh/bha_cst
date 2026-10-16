# Voice Live E2E Config Check

## Checks
- TWILIO_ACCOUNT_SID: SET (from .env)
- TWILIO_AUTH_TOKEN: SET (from .env) 
- TWILIO_NUMBER: PRESENT (set via env for this run) - +141...2671 masked
- CST_E2E_PHONE_NUMBER: PRESENT (+923...3844 masked) — matches requested +923082113844
- CST_SERVICE_URL: https://bha-cst-7u9e.onrender.com
- Tenant/Project: tenant-vfarm-01 / proj-vfarm-main (defaults; can override via env)
- Callback URL: will use CST_VOICE_TWIML_URL if set else CST_SERVICE_URL/webhooks/twilio/voice
- Transcript output dir: var/transcripts (created if missing)

## Status
- All required vars present and masked correctly in output.
- Runner wired for single outbound call with --live.
- No call placed. STOP before dialing (non-live confirmed).

## Next
Authorize with --live to place exactly one real call using valid TWILIO_NUMBER and destination above.
