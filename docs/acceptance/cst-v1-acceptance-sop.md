# CST v1 Acceptance SOP

**Purpose:** Reusable procedure for recording CST acceptance evidence.  
**Scope:** Local tests, staging results, and production verification.  
**Status:** Draft — requires owner approval before use in production.

---

## 1. Pre-Acceptance Checklist

Before any acceptance test, confirm:

- [ ] Deployed commit SHA matches the expected revision
- [ ] Environment is identified (staging / production)
- [ ] Test scope is defined (voice, SMS, identity, telemetry, escalation)
- [ ] Authorized test caller identity is confirmed (not a seeded dev identity)
- [ ] vFarm farm grants are verified for the test caller
- [ ] Test phone number is approved for live calls/SMS (if applicable)
- [ ] Slack channel is approved for test notifications (if applicable)
- [ ] Database backup is current and verified

## 2. Recording Acceptance Evidence

### Environment Record
- **Date/time (UTC):** ____________
- **Environment:** staging / production
- **Deployed SHA:** ____________
- **Service URL:** ____________
- **Operator:** ____________
- **Approval reference:** ____________

### Correlation Chain
For each acceptance test, record the same correlation ID across:
1. Inbound request (Twilio call SID or SMS SID)
2. Caller resolution (CST identity resolver → vFarm membership)
3. Farm authorization (assertSpeakerFarmAccess)
4. Upstream readings request (vFarm API call)
5. Returned reading (sanitized)
6. Response delivery (TwiML <Play> URL or SMS body)
7. Conversation persistence (conversations table)
8. Security/audit record (security_ledger)

### Evidence Types (keep separate)
- **Local tests:** Unit/integration tests run in CI or developer machine
- **Staging results:** Tests run against staging environment with test credentials
- **Production evidence:** Read-only inspection of production logs, DB, or health endpoints
- **Live E2E:** Authorized test call/SMS with real provider transaction

### Recording Rules
- Record failed calls honestly — never turn a 404, 422, timeout, or missing record into a pass
- Capture exact log lines with UTC timestamps
- Redact all secrets, phone numbers, customer data, and JWTs
- Use correlation IDs to link evidence across systems
- Do not use mock data as production evidence

## 3. Acceptance Gates

### Gate 1: Endpoint Contract
- [ ] vFarm readings endpoint confirmed: `GET /api/v1/readings/latest?sensor_id={id}`
- [ ] Device discovery endpoint confirmed: `GET /api/v1/devices?farm_id={id}`
- [ ] Response schema matches `LatestReadingResponseSchema`
- [ ] 404 semantics documented (no readings for sensor)
- [ ] Timeout behavior documented (rack sensors: 29-43s)

### Gate 2: Database/Endpoint Decision
- [ ] Decision record created and linked from Entry 399
- [ ] Database continuity decision made (upgrade vs backup/restore)
- [ ] IP allow-list reviewed
- [ ] Migration 022 applied in production (confirmed)

### Gate 3: Identity/Authorization Proof
- [ ] Caller identity resolved via vFarm (not fabricated)
- [ ] Farm grant verified via `assertSpeakerFarmAccess`
- [ ] Record-level proof collected (safe SQL, redacted)
- [ ] Entry 393 updated with corrected mission-fit language

### Gate 4: Live E2E Proof
- [ ] Authorized test call placed
- [ ] Greeting spoken (ElevenLabs voice via <Play>)
- [ ] Voice intent recognized correctly
- [ ] Farm authorization verified before readings
- [ ] Per-unit readings retrieved and spoken
- [ ] Response completed within 7s deadline
- [ ] Conversation turn persisted
- [ ] Security/audit log entry exists
- [ ] Unauthorized caller test: fail-closed confirmed
- [ ] Render log excerpts captured with timestamps

## 4. Rollback/Continuity Considerations

- **Database:** Free plan expires Nov 14 2026. Backup verified (80,365 bytes). Restore drill passed (20 tables, 22 migrations, 17 FKs).
- **Deployment:** Auto-deploy from `main` branch. Rollback = redeploy previous commit.
- **Voice:** If ElevenLabs synthesis fails, `<Say>` fallback provides Twilio TTS. If audio cache misses, `<Say>` fallback.
- **Escalation:** If Slack fails, escalation record persists with status `pending`/`failed`. Caller told "request recorded" not "notified."

## 5. Evidence Retention

- All evidence files go in `docs/evidence/`
- Use naming convention: `YYYY-MM-DD-{description}.md`
- Never include credentials, full phone numbers, or sensitive customer data
- Mask all phone numbers, SIDs, and tokens in reports
- Keep local tests, staging results, and production evidence in separate sections
