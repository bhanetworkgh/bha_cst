# Voice Blocker Check
- Originating (From): +141...2671 (TWILIO_NUMBER)
- Destination (To): +923...3844 (CST_E2E_PHONE_NUMBER = +923082113844)
- Callback: CST_SERVICE_URL/webhooks/twilio/voice (or CST_VOICE_TWIML_URL if set)
- Status: BLOCKED - Twilio error 21210 "From is not a valid phone number: +14155552671" / unverified for outbound voice. 
- Action: Use verified Twilio voice number as TWILIO_NUMBER; do not place call until fixed.
