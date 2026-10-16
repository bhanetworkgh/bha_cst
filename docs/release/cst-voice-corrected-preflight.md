# Corrected Preflight (Mapping Verified)
- From (Caller ID): TWILIO_NUMBER +141...2671 → masked correctly; originates call.
- To (Destination): CST_E2E_PHONE_NUMBER +923...3844 → masked correctly (correct: +923082113844).
- Callback: CST_VOICE_TWIML_URL or CST_SERVICE_URL/webhooks/twilio/voice.
- Tenant/Project: tenant-vfarm-01/proj-vfarm-main. DID→tenant/project resolved by binding on ingress; outbound call uses configured context.
- No call placed (non-live). Await explicit --live authorization.
