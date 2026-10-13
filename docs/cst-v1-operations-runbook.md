# CST v1 — Operations Runbook

**Document:** `docs/cst-v1-operations-runbook.md`  
**Date:** 2026-10-13  
**System:** Customer Service Twin (CST) Engine  
**Deployment Platform:** Render.com Web Service (`bha-cst`) + Managed PostgreSQL 16 (`bha-cst-postgres`)  

---

## 1. Deployment Prerequisites

Before deploying a new version to staging or production, verify all items in this checklist:

- [ ] **Git Working Tree:** Clean, tagged release or commit SHA on `main`.
- [ ] **Automated Tests:** All unit and integration tests green (`npm test` -> 551 passed, 6 skipped, 0 failed).
- [ ] **Typecheck & Build:** `npm run typecheck` and `npm run build` complete without errors.
- [ ] **Database Backup:** Render managed database snapshot verified prior to running migrations.
- [ ] **Secrets Verification:** All environment variables marked `sync: false` in `render.yaml` are populated in the Render Dashboard. Never commit secrets to Git.
- [ ] **Render Service Plan:** Upgrade web service and database from `free` to `starter` (or higher). Free-tier services hibernate after 15m of inactivity and emit `503 hibernate-wake-error`, dropping webhooks and carrier callbacks.
- [ ] **Operator Confirmation:** Explicit approval obtained for schema migrations.

---

## 2. Health Checks & Synthetic Monitoring

CST provides standard HTTP endpoints for automated health checks and platform monitoring:

### 2.1 Primary Health Endpoint (`GET /health`)
- **URL:** `https://<service-domain>/health`
- **Expected Status:** `200 OK`
- **Response Payload:**
  ```json
  {
    "status": "ok",
    "service": "bha-cst-engine"
  }
  ```
- **Monitoring Rule:** Render health check polls this path every 15 seconds. If 3 consecutive checks fail, Render marks instance unhealthy and stops routing traffic.

### 2.2 Deep System & Adapter Health (`GET /api/health`)
- **URL:** `https://<service-domain>/api/health`
- **Expected Status:** `200 OK`
- **Payload:** Includes vFarm upstream reachability and tenant adapter status.
- **Alert Trigger:** Alert on `vfarm.status != "healthy"` for > 3 minutes.

---

## 3. Security Incident Response & Key Rotation

### 3.1 Unauthenticated Proxy / Token Exposure Response
*Applicable to findings under `LOOP-1790790007707-5R0J`.*

1. **Immediate Quarantine:**
   - Verify that the deployed CST instance includes `engine/src/middleware/vfarm_proxy_auth.ts`.
   - Test external probing of `/api/tokens` and `/api/devices`:
     ```bash
     curl -i -X POST https://<service-domain>/api/tokens -d '{"farm_id":"test"}'
     ```
     *Must immediately return `401 Unauthorized` with zero upstream requests.*

2. **vFarm Farm-Key Audit & Revocation Procedure:** *(OPERATOR INPUT REQUIRED)*
   - **Step 1:** Log into the authoritative vFarm administrative database or access logs.
   - **Step 2:** Query all farm keys created during the historical exposure window (**2026-09-25 through 2026-10-07**):
     ```sql
     SELECT id, farm_id, name, created_at, created_by 
     FROM farm_api_keys 
     WHERE created_at BETWEEN '2026-09-25 00:00:00+00' AND '2026-10-07 23:59:59+00';
     ```
   - **Step 3:** Cross-reference every key with known CST administrative actions.
   - **Step 4:** Revoke any unrecognized keys:
     ```bash
     DELETE /api/v1/tokens/:token_id
     ```
   - **Step 5:** Rotate CST's operational credentials:
     - Generate new `VFARM_API_FARM_KEY` and `VFARM_API_JWT`.
     - Update environment variables in the Render Dashboard -> `bha-cst` -> Environment.
     - Trigger manual redeploy.

---

## 4. Consent & Carrier Compliance Incidents

### 4.1 Inadvertent Send to Opted-Out Recipient
1. **Detection:**
   - Security tripwire logs emit `WARN` with `tool_or_route: "canSendSms"` and `outcome: "refused"`.
   - If carrier reports complaint or A2P campaign violation:
2. **Immediate Mitigation:**
   - Query consent status for phone:
     ```bash
     GET /api/v1/admin/consents?phone=+<E164>
     ```
   - Force manual opt-out in database:
     ```sql
     UPDATE sms_consents 
     SET consent_status = 'opted_out', opted_out_at = NOW(), updated_at = NOW() 
     WHERE phone_e164 = '+<E164>';
     ```
   - Verify that pending queue rows for that recipient are immediately marked `refused`:
     ```sql
     UPDATE messages_out 
     SET status = 'refused', error_message = 'Emergency manual opt-out suppression' 
     WHERE to_e164 = '+<E164>' AND status IN ('pending', 'queued');
     ```

### 4.2 Handling Carrier STOP / HELP Spikes
- STOP keywords are automatically handled without human intervention.
- The outbound queue automatically allows transactional STOP confirmation and HELP replies while suppressing marketing and normal conversation turns.

---

## 5. Provider Outages & Failure Handling

### 5.1 Twilio Failures & Error Codes

| Provider Error Code | Classification | Automated System Action | Operator Action Required |
|:---|:---|:---|:---|
| **21215** (Geo-Permissions) | Permanent | Fail fast; status set to `failed`; **No retry** | Enable country in Twilio Console -> Voice -> Geo-Permissions *(OPERATOR)* |
| **30005** (Unknown Destination) | Permanent | Fail fast; status set to `failed`; **No retry** | Flag phone number as invalid in customer database |
| **30007** (Carrier Violation / Filtered) | Permanent | Fail fast; status set to `failed`; **No retry** | Audit message body for prohibited content / verify A2P campaign *(OPERATOR)* |
| **30008** (Unknown Carrier Error) | Permanent | Fail fast; status set to `failed`; **No retry** | Inspect carrier network status |
| **500xx / Connection Timeout** | Transient | Exponential backoff retry (up to 3 attempts, capped at 30s) | Monitor Twilio status page if retries exhaust |

### 5.2 ElevenLabs Speech Synthesis Outage
- **Symptoms:** Voice calls experience delayed audio or timeout in `processVoiceTurn`.
- **Automated Fallback:** CST voice router falls back to pre-recorded fallback audio or default TwiML `<Say>` voice if TTS API fails.
- **Operator Action:** If ElevenLabs outage exceeds 15 minutes, toggle `voice_enabled: false` in system configuration to direct voice calls to phone forwarding.

### 5.3 vFarm Upstream API Outage
- **Symptoms:** Inbound user queries for farm telemetry return `"Unable to retrieve live farm stats"`.
- **System Behavior:** Bounded by `VFARM_DEFAULT_TIMEOUT_MS=5000`. Does not crash or block express event loop.
- **Operator Action:** Check vFarm status at `https://vfarm.bhanetwork.org`.

---

## 6. Database Migration & Rollback Runbook

### 6.1 Applying Staging Migrations (017 & 018) *(OPERATOR INPUT REQUIRED)*
1. Connect to Render Shell or local proxy with `DATABASE_URL` pointing to the staging database.
2. Run migration script:
   ```bash
   node scripts/migrate.js
   ```
3. Inspect schema state:
   ```sql
   -- Verify 017 composite FK and trigger
   SELECT conname, contype FROM pg_constraint WHERE conname = 'fk_sms_consent_audit_consent';
   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_sms_consent_audit_append_only';

   -- Verify 018 table and indexes
   SELECT table_name FROM information_schema.tables WHERE table_name = 'sms_consent_prompts';
   SELECT indexname FROM pg_indexes WHERE tablename = 'sms_consent_prompts';
   ```

### 6.2 Rollback Procedure for Migrations 017 & 018
If migration causes locking or errors:
```sql
BEGIN;
-- Rollback 018
DROP TABLE IF EXISTS sms_consent_prompts CASCADE;

-- Rollback 017
DROP TRIGGER IF EXISTS trg_sms_consent_audit_append_only ON sms_consent_audit;
DROP FUNCTION IF EXISTS enforce_sms_consent_audit_append_only();
ALTER TABLE sms_consent_audit DROP CONSTRAINT IF EXISTS fk_sms_consent_audit_consent;
DROP INDEX IF EXISTS unq_sms_consents_id_tenant;
COMMIT;
```

---

## 7. Escalation Matrix

| Severity | Issue Description | Initial Responder | Escalation Contact | SLA |
|:---:|:---|:---|:---|:---:|
| **P1** | Platform crash, unauthenticated proxy breach, cross-tenant data leak | On-Call Engineer | Jason (Security / Architecture Lead) | < 15 mins |
| **P2** | Twilio delivery blocked (carrier filtering), A2P compliance violation | Transport Engineer | Operations / Carrier Admin | < 1 hour |
| **P3** | vFarm telemetry degradation, ElevenLabs synthesis slowdown | Integration Engineer | Destiny (vFarm Lead) | < 4 hours |
| **P4** | Minor admin panel UI defect, non-urgent feature question | Support / QA | Product Engineering | Next Business Day |
