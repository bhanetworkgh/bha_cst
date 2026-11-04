# CST Live Production Twilio SMS & Outbound Voice Acceptance Runbook

**Target Production Service:** `https://bha-cst-7u9e.onrender.com`  
**Authorized Destination:** `+923082113844` (Strict constraint: do not use any other destination)  
**Safety Mandate:** Live operations must NEVER run by default. Explicit confirmation flags are required for all live actions.  
**Date:** 2026-11-03  

---

## 1. Safety Rules & Operational Constraints

1. **Pre-flight Requirement:** Always execute `preflight` before attempting any live operation.
2. **Authorized Number Only:** Only `+923082113844` is authorized for live outbound test transmissions. All other numbers will be rejected by tenancy and safety guards.
3. **Explicit Confirmation Flags:**
   - SMS requires: `--confirm-live-sms`
   - Voice requires: `--confirm-live-call`
   - Without these flags, commands abort immediately in dry-run/preview mode.
4. **Data Privacy & Redaction:** All logs, outputs, and generated reports MUST mask destination numbers (e.g., `+92308***3844`) and scrub credentials.

---

## 2. Command Reference

All commands are driven via the unified production acceptance runner:

### Step 1: Preflight Health & Environment Check
Validates production endpoints, database connectivity, Twilio credential readiness, and ElevenLabs voice configuration without making any outbound calls or sending SMS.
```bash
npm run acceptance:preflight
```
*Expected Output:*
- Production `/health` -> 200 OK
- Production `/health/voice` -> 200 OK
- Service number binding for destination verified
- Exit code 0

### Step 2: Live Outbound SMS Test (Single Authorized Message)
Sends exactly one authorized test SMS via CST's real production messaging pipeline.
```bash
npm run acceptance:sms -- --confirm-live-sms
```
*Generated Message Format:*
`"CST production acceptance test. This is an authorized test SMS. Reference: <run-id>. No action required."`

*Recorded Artifacts:*
- Run ID
- UTC timestamp
- Masked destination (`+92308***3844`)
- CST message ID & Twilio Message SID
- Initial delivery status

### Step 3: Live Outbound Voice Test (Single Authorized Call)
Places one authorized voice call connecting the recipient to CST's conversational voice engine powered by ElevenLabs voice synthesis.
```bash
npm run acceptance:voice -- --confirm-live-call
```

*Recorded Artifacts:*
- Run ID & UTC timestamp
- Twilio Call SID
- Call status (`queued`, `ringing`, `in-progress`, `completed`)
- ElevenLabs voice playback confirmation
- Conversation turn persistence in database

### Step 4: Verification of Delivery Callbacks & Database Rows
Inspects production database records, Twilio delivery status callbacks, and security ledger audit rows.
```bash
npm run acceptance:verify
```

### Step 5: Consolidated Acceptance Report Generation
Produces the final evidence report with all timestamps, SIDs, and verification statuses.
```bash
npm run acceptance:report
```

---

## 3. Failure Path Runbook

| Symptom | Root Cause | Action |
|---|---|---|
| Preflight fails with 502/503 | Render cold start or service asleep | Wait 30 seconds; re-run `acceptance:preflight` |
| SMS rejected with `refused` | Destination number not authorized | Verify exact number `+923082113844` |
| Twilio callback not received | Webhook endpoint unreachable or blocked | Check Render logs for `/api/v1/twilio/status-callback` |
| Voice call silent or drops | ElevenLabs quota exceeded or timeout | Check `/health/voice` diagnostics and API latency |

