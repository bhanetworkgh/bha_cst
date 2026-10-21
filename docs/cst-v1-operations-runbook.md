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

#### 2.2.1 vFarm upstream health status vocabulary

`vfarm.status` comes from an **active, bounded, read-only probe** of the vFarm upstream. The
reported `latency_ms` is the measured round-trip time of that request, not a constant, and the
status is never inferred from the presence of credentials.

| `status` | Meaning | Operational response |
|----------|---------|----------------------|
| `healthy` | A tenant-scoped, read-only upstream request succeeded. Upstream health IS asserted. | None. |
| `configured` | The upstream is configured and reachable, but upstream health is **not asserted** — either the probe could not be scoped to this tenant (no vFarm organization id configured), or the probe was skipped. | Check `details.reason`. Not an outage. |
| `degraded` | The upstream answered but did not serve the request: a 5xx, a rate limit, a timeout, a connection failure, or a response that failed validation. | Investigate upstream. |
| `unavailable` | CST cannot use the upstream at all: no client configured, or the credential was rejected (401/403). | Check credentials and `VFARM_BASE_URL` / `VFARM_API_BASE_URL`. |

The same vocabulary is used by `GET /api/v1/admin/health/verification` under `adapter_health`.

**Important:** the per-request authorization path (the voice lane) deliberately does **not** use this
probe. It asks the adapter for its *operational readiness*, which is evaluated locally and performs
no network I/O, so an upstream hiccup cannot refuse live customer calls. The authoritative
organisation-membership and farm-grant checks still run inside identity resolution and fail closed
on their own.

---

## 2.3 Outbound Queue Operations

### 2.3.1 Message states

| `messages_out.status` | Meaning | Re-dispatched automatically? |
|---|---|---|
| `pending` | Queued, never dispatched. | Yes, when eligible. |
| `queued` | A previous attempt failed and the message is waiting for its retry window (`next_retry_at`). | Yes, when the retry time has passed. |
| `sending` | Claimed by a worker and in flight. | No. A claim holds a 5-minute lease. |
| `sent` | The provider returned a MessageSid: the message exists. | No. |
| `delivered` / `undelivered` / `failed` | Terminal provider outcomes. | No. |
| `refused` | CST refused to send (consent or tenancy gate). | No. |
| `outcome_unknown` | The message was dispatched but no confirmation was received, so it is **unknown whether the provider created it**. | **No — deliberately.** |

**Why `outcome_unknown` is never retried automatically.** A timeout or a broken connection does not
prove the provider failed to create the message: it may have been created and merely not
acknowledged in time. Re-dispatching it risks delivering a **second copy** of the message to the
customer. The message is therefore parked, preserved and visible, and is reconciled by an operator.

### 2.3.2 Reconciling an `outcome_unknown` message

1. Read the backlog (read-only SQL):
   ```sql
   SELECT id, tenant_id, to_e164, created_at, error_message
   FROM messages_out
   WHERE status = 'outcome_unknown'
   ORDER BY created_at ASC;
   ```
2. For each row, check the provider's message log for the destination and the window between
   `created_at` and the failure.
   - **The provider created a message** → the customer most likely has it. Record the MessageSid on
     the row and set the status to `sent`; the provider's own status callback will then advance it
     to `delivered`/`failed` through the normal path.
   - **The provider created nothing** → the message was never sent. Set the status back to `queued`
     (and clear `next_retry_at`) so the worker dispatches it.
3. Never do both. Doing nothing leaves the message unreconciled; doing both would deliver a
   duplicate.

### 2.3.3 Worker liveness

The outbound worker runs inside the CST process, so it is only alive while the process is. Verify:

- `Outbound background worker starting` appears in the logs once per boot.
- `Outbound worker heartbeat` appears every 5 minutes with the queue depth by status. A heartbeat
  with `pending: 0` proves the worker is running AND the queue is empty; the absence of a
  heartbeat proves the worker is not running. The two are indistinguishable from outside the
  process without it.

```sql
SELECT status, COUNT(*) FROM messages_out GROUP BY status;
```

A non-zero `sending` count whose `updated_at` is older than 5 minutes is a stranded claim: it is
recovered automatically on the next worker pass (accepted messages become `sent`, the rest become
`outcome_unknown`) and is **never** re-dispatched.

### 2.3.4 Dashboard dead-letter replay

Dashboard publication is fire-and-forget. Every attempt is recorded in `dashboard_publish_outcomes`,
and a failed publish is re-sent automatically by the replay pass (every 5 minutes, and once shortly
after boot). A replayed event is marked durably so it is never published twice.

```sql
SELECT status, COUNT(*) FROM dashboard_publish_outcomes
WHERE status <> 'published' AND replayed_at IS NULL GROUP BY status;
```

### 2.3.5 What the logs may and may not contain

Log and audit output is retained and read by operators, auditors and reviewers, so it must not carry
raw customer identifiers. The policy is implemented in `engine/src/util/privacy.ts`:

| Value | In logs / audit | Where the raw value lives |
|---|---|---|
| Recipient / caller number | **Masked** — last four digits only (`+1555****4567`) | `messages_out.to_e164`, `sms_consents` |
| Provider MessageSid | **Masked** — a correlatable six-character prefix (`SM9f2c*******************`) | `messages_out.provider_sid` |
| Message body | **Masked** by the alert-audit writer | `alert_audit_log` (masked) |
| Service number CST owns (the number that received the call or SMS) | Unmasked — it is not a customer identifier and must stay legible for triage | `service_number_bindings` |
| Tenant / project id | Unmasked | `systems`, `projects` |

A masked MessageSid still correlates: an operator can group every log line for one message and
search the provider console by the prefix. The exact identifier is always available from
`messages_out.provider_sid`.

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
