# CST Engine Integration Map — 2026-11-02

**Repository:** bhanetworkgh/bha_cst  
**Owner:** CST (conversations, orchestration, CST administration)  
**vFarm:** authoritative identity, farm, device, live-state data  
**BHARAG:** knowledge and incident context

---

## 1. Architecture Ownership

| Component | Owner | Responsibility |
|-----------|-------|----------------|
| CST | Ahad/CST team | Conversations, orchestration, channel handling, CST admin, voice/SMS delivery |
| vFarm | Jegan/vFarm team | Identity, membership, authorization grants, farm/unit associations, device data, live-state, health |
| BHARAG | BHARAG team | Knowledge base, incident context, Research Twin |
| Media Server | Media team | Audio synthesis (ElevenLabs), voice delivery |

CST consumes vFarm as the single source of truth. CST fails closed when identity or authorization cannot be verified.

---

## 2. CST ↔ vFarm Integration

### 2.1 Identity Path
- CST receives inbound call/message with phone number
- CST looks up speaker by phone number
- `assertSpeakerFarmAccess(speaker, farmId)` verifies `speaker.farm_ids` includes `farmId`
- If authorized, CST calls vFarm API with API key/token
- vFarm returns device list, readings, fleet status

### 2.2 Device/Readings Path
- `listAllDevices(farmId)` → device inventory
- Filter to `device_type === 'sensor'` only
- `listLatestReadings(farmId)` → per-sensor readings via `/api/v1/readings/latest?sensor_id={id}`
- Concurrency: 5 (batched Promise.allSettled)
- Per-sensor timeout: 10,000ms (production) / 5,000ms (Jason's contract)
- Classification: 404→no_reading, 401/403→unauthorized, 422→invalid_request, 5xx→upstream_error, timeout→timeout

### 2.3 Fleet Status Path
- `getFleetStatusForSpeaker(farmId)` → device list with `fleet_status` field
- `getDeviceFleetStatus(farmId, deviceId)` → single device fleet status
- Five statuses: healthy, unhealthy, degraded, unknown, null (cabinet/frame)
- CST admin panel renders all five distinctly

### 2.4 Health Ownership
- vFarm is single source of truth for device/sensor/relay/overall health
- CST preserves vFarm's `health` attribute (healthy/unhealthy)
- CST uses existing unavailable/error handling when attribute missing/invalid
- CST never calculates independent health
- CST never converts missing data to healthy

---

## 3. CST ↔ BHARAG Integration

### 3.1 Knowledge Queries
- CST sends queries to BHARAG with tenant/project context
- BHARAG returns knowledge responses
- CST does not fabricate knowledge responses

### 3.2 Incident Context
- BHARAG provides incident context for degraded modes
- CST triggers investigation based on BHARAG signals
- Research Twin (§10 rule) pending Jegan review

### 3.3 BHARAG Key Scope
- Current: workspaceKey/workspace in ask body
- Target: `auth_context.allowed_workspaces` stopgap
- Future: `cst-help-read` key via Jegan's re-run

---

## 4. CST ↔ Media Server (ElevenLabs)

### 4.1 Voice Synthesis
- CST sends text + voice_id to ElevenLabs
- ElevenLabs returns audio (MP3)
- CST caches audio (instance-local, multi-instance gap)
- Voice ID: Hmy97GCI840wuICQesiM (Jason's cloned voice)

### 4.2 Audio Delivery
- CST serves cached audio via `VOICE_AUDIO_BASE_URL` (must be public HTTPS)
- Twilio fetches audio from CST URL
- Cache is instance-local (Render multi-instance gap)

---

## 5. CST ↔ Twilio

### 5.1 Voice
- Inbound: Twilio → CST webhook `/webhooks/twilio/voice`
- Turn: Twilio → CST `/webhooks/twilio/voice/turn` (speech recognition → CST processing → synthesis → TwiML response)
- Status: Twilio → CST `/webhooks/twilio/voice/status`
- Deadline: 12s default, 14s max clamp

### 5.2 SMS
- Outbound: CST queue → Twilio Send API → provider SID persisted → callback → attribution
- Inbound: Twilio → CST `/webhooks/twilio/sms` (not evidenced in recent logs)
- Callback: Twilio → CST `/webhooks/twilio/delivery-status`

### 5.3 Delivery Callback Attribution
- Callback looks up persisted outbound row by `provider_sid`
- Attribution comes from persisted row (tenant_id, project_id), never from callback recipient
- Fail-closed: if no matching row, refuse dashboard publication

---

## 6. CST ↔ Database (PostgreSQL)

### 6.1 Tables
21 application tables: admin_sessions, admin_users, alert_audit_log, conversations, customers, dashboard_publish_outcomes, escalations, messages, messages_in, messages_out, organizations, projects, schema_migrations, security_ledger, service_number_bindings, sms_consent_audit, sms_consent_prompts, sms_consents, systems, voice_deliveries, workspaces

### 6.2 Key Write Paths
- Security ledger: `Logger.audit()` → `DbClient.recordSecurityLedgerEvent()` (fire-and-forget)
- Outbound messages: `processOutboundQueue()` → `updateOutboundProviderSid()` → `updateOutboundStatus()`
- Voice turns: `processVoiceTurnWithDeadline()` → conversation/turn persistence
- Dashboard publication: `dashboard_publish_outcomes` table

### 6.3 Migration State
- 23 files in repo, 22 rows in production
- Duplicate 003_ prefix hypothesis (unconfirmed)
- 2 drifted files (006, 010)

---

## 7. CST ↔ Intake/Genie/Incident/Log Flows

### 7.1 Intake
- CST receives inbound calls/SMS from Twilio
- Identity resolution via vFarm speaker lookup
- Farm authorization via `assertSpeakerFarmAccess()`
- Conversation context maintained in CST database

### 7.2 Genie
- CST can query Genie for knowledge (BHARAG-backed)
- Genie responses grounded in BHARAG knowledge base
- CST must not fabricate responses

### 7.3 Incident Flow
- CST logs SECURITY_LEDGER events for voice deadline incidents, callback attribution failures, Twilio delivery errors
- BHARAG provides incident context
- Research Twin (§10 rule) pending Jegan review

### 7.4 Log Flow
- Structured logging via `Logger.audit()` → console + in-memory ring buffer + DB (fire-and-forget)
- Render captures all stdout/stderr
- Security ledger events persisted to PostgreSQL

---

## 8. Monitoring Twin (Proposed)

**Status:** NOT IMPLEMENTED — documentation only.

CST should expose monitoring using existing vFarm authoritative data:
- Service health: /health endpoint (API, DB, vFarm identity, BHARAG knowledge, outbound worker, provider delivery)
- Device health: vFarm fleet_status (healthy/unhealthy/degraded/unknown/null)
- Voice health: turn success rate, deadline compliance, synthesis success
- SMS health: outbound queue depth, delivery rate, callback attribution rate
- Security: security_ledger event count, failed auth attempts

No new health calculation. Consume vFarm's authoritative data.

---

## 9. Research Twin (Proposed)

**Status:** NOT IMPLEMENTED — documentation only. Pending Jegan's §10 rule review.

Investigation triggers:
- vFarm sensor timeout (10s observed)
- Callback attribution failure (35 unmatched SIDs)
- Voice deadline exceedance (historical: 2 incidents)
- Migration count discrepancy

Degraded-mode behavior:
- On vFarm timeout: return partial results, log upstream_timeout
- On callback attribution failure: fail-closed, refuse dashboard publication
- On voice deadline: return TURN_TIMEOUT, no transcript/delivery/SMS persisted

---

## 10. Front Door (Buyer Promises)

**Status:** NOT DOCUMENTED — needs definition.

What CST can claim:
- Voice calls complete with synthesis (verified in production)
- Security ledger events persisted (verified in production)
- vFarm sensor filtering (implemented and tested)
- Fail-closed callback attribution (verified in production logs)

What CST must NOT claim:
- Reliable sensor readings (10s timeout vs 5s contract)
- Full production readiness (multiple blockers remain)
- Complete acceptance (operator-reported, not signed)
- SMS working on current SHA (only pre-SHA-17 evidence for new sends)

---

## 11. Integration Points Summary

| Integration | Direction | Status | Evidence |
|-------------|-----------|--------|----------|
| Twilio → CST (voice) | Inbound | Verified | Render logs, 15 voice POSTs HTTP 200 |
| Twilio → CST (SMS) | Inbound | Not evidenced | No SMS webhook logs in recent window |
| CST → Twilio (SMS send) | Outbound | Partial | Worker heartbeat, 0 pending/queued |
| CST → vFarm (devices) | Outbound | Verified | Production logs show device list + sensor filter |
| CST → vFarm (readings) | Outbound | Partial | 4 sensors queried, all timed out at 10s |
| CST → vFarm (fleet status) | Outbound | Implemented | Code exists, not production-verified |
| CST → ElevenLabs (synthesis) | Outbound | Verified | Production: 311K + 294K bytes synthesized |
| CST → BHARAG (knowledge) | Outbound | Not evidenced | No BHARAG query logs in recent window |
| CST → PostgreSQL (read/write) | Internal | Verified | Private network, TLSv1.3 |
| CST → Dashboard (publish) | Outbound | Partial | 7 published outcomes in historical window |

