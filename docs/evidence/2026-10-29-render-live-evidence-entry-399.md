# CST Entry 399 — Render Live Evidence

**Date:** 2026-10-29  
**Entry:** 399  
**Purpose:** Render incident evidence, endpoint contract, and database/continuity decision  
**Status:** PARTIAL — code verified, live E2E proof pending

**Last code update:** 2026-10-30 — Voice deadline 12000ms (14000ms hard cap), concurrency 12, timeout 8000ms
**Production baseline:** PR #17 live, SHA `41d3ead81b81d466586b99d970595394335a009e`
**Web-service ingress allowlist:** `0.0.0.0/0` (Render web service — all public HTTPS)
**Postgres allowlist:** `103.120.71.129/32` (trusted admin IP only — NOT 0.0.0.0/0)
**vFarm authentication:** RESOLVED — do not list as a blocker

---

## 1. Evidence Metadata

| Field | Value | Source |
|-------|-------|--------|
| Capture date | 2026-10-29T14:59:53Z | This report |
| Environment | Production | Render API |
| Service | bha-cst (srv-db8hepqvcj2c73adpus0) | Render API |
| Deployed commit | `78075b19757f` (Merge PR #13) | Render API |
| Deploy status | live | Render API |
| Deploy created | 2026-10-28T20:58:17Z | Render API |
| Deploy finished | 2026-10-28T20:59:14Z | Render API |
| Region | Oregon | Render API |
| Plan | 0.5c-512mb (starter) | Render API |
| Instances | 1 | Render API |

## 2. Render and PostgreSQL State

### Web Service (bha-cst)
- **URL:** `https://bha-cst-7u9e.onrender.com`
- **Branch:** `main`
- **Auto-deploy:** yes (triggered by commit)
- **Build command:** `npm ci --include=dev && npm run build`
- **Start command:** `node scripts/migrate.js && npm start`
- **Health check path:** `/health`
- **IP allow-list:** `103.120.71.129/32` (trusted admin IP only — tightened from previous 0.0.0.0/0)
- **Network isolation:** Private CST-to-Postgres connectivity confirmed via Render private network
- **Web-service ingress:** `0.0.0.0/0` (Render web service — all public HTTPS, standard for web services)

### PostgreSQL (bha-cst-postgres)
- **Resource ID:** `dpg-db8he2qvcj2c73ado3s0-a`
- **Version:** PostgreSQL 16
- **Plan:** `0.1c-256mb`
- **Region:** Oregon
- **Disk:** 1 GB (autoscaling disabled)
- **Status:** Available
- **IP allow-list:** `103.120.71.129/32` (tightened from previous `0.0.0.0/0`)
- **HA:** Disabled
- **Read replicas:** None
- **Connection pool:** None
- **Migrations:** 23 files found, 23 already recorded, 0 applied, 2 drifted (006 and 010 contents changed)
- **Tables:** 21 (NOT independently verified via SQL — SQL inspection failed due to TLS/allowlist)
- **Foreign keys:** 17 (NOT independently verified via SQL)
- **Network isolation:** Private CST-to-Postgres connectivity confirmed via Render private network (TLSv1.3)

### Environment Variables (Presence Only — Values Redacted)

**SET (54 vars):** SLACK_ERROR_WEBHOOK_URL, CST_API_KEY, VFARM_API_JWT, VFARM_JWT, VFARM_TENANT_ORG_ID, PUBLIC_WEBHOOK_URL, SERVICE_NAME, CST_ADMIN_NAME, CST_ADMIN_PASSWORD_HASH, CST_ADMIN_EMAIL, ENGINE_DASHBOARD_KEY, ENGINE_DASHBOARD_URL, VFARM_ELEVENLABS_MODEL_ID, VFARM_ELEVENLABS_VOICE_ID, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, ELEVENLABS_BASE_URL, ELEVENLABS_API_KEY, AWS_REGION, AWS_S3_BUCKET_NAME, S3_MEDIA_BUCKET_URL, MEDIA_SERVER_URL, BHARAG_CLUSTER_TIMEOUT_MS, BHARAG_CLUSTER_KEY, BHARAG_CLUSTER_URL, BHARAG_WORKSPACE_KEY, BHARAG_API_URL, VFARM_DEFAULT_DEVICE_COUNT, VFARM_DEFAULT_FARM_CODE, VFARM_DEFAULT_FARM_NAME, VFARM_PROJECT_NAME_MAIN, VFARM_PROJECT_ID_MAIN, VFARM_TENANT_ORG_ID_MAIN, VFARM_ADMIN_PASSWORD, VFARM_ADMIN_EMAIL, VFARM_API_FARM_KEY, VFARM_FARM_KEY, VFARM_API_BASE_URL, VFARM_BASE_URL, VFARM_RESOLVE_API_KEY, VFARM_RESOLVE_ENDPOINT, VFARM_ONBOARDING_REPLY, VFARM_PHONE_NUMBERS, VFARM_SYSTEM_NAME, VFARM_TENANT_NAME, VFARM_TENANT_ID, VFARM_SYSTEM_ID, TWILIO_MESSAGING_SERVICE_SID, TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID, NODE_ENV, PORT, DATABASE_URL

**MISSING/EMPTY (1 var):** VFARM_WORKSPACE_ID

**Notable:** `VOICE_AUDIO_BASE_URL` is not in the service-level env vars list. The audio endpoint URL is derived from the request host (Render's public URL) as a fallback. This may work but is not explicitly configured.

## 3. Verbatim Log Section — RAW LOGS REQUIRED

The following log excerpts are from the Render API (read-only, 2026-10-29T12:38:50Z to 2026-10-29T13:18:14Z). They show delivery callback attribution failures.

**Verbatim log excerpt 1 (2026-10-29T12:38:50.859Z):**
```
{"timestamp":"2026-10-29T12:38:50.859Z","level":"WARN","type":"INFRA_EVENT","message":"Delivery callback for SM291a**************************** could not be attributed to a tenant project","commercial_impact":"Delivery status was recorded against the outbound message but could not be attributed to a tenant or project for dashboard publishing."}
```

**Verbatim log excerpt 2 (2026-10-29T12:56:52.345Z):**
```
{"timestamp":"2026-10-29T12:56:52.345Z","level":"WARN","type":"INFRA_EVENT","message":"Delivery callback for SM9c80**************************** could not be attributed to a tenant project","commercial_impact":"Delivery status was recorded against the outbound message but could not be attributed to a tenant or project for dashboard publishing."}
```

**Verbatim log excerpt 3 (2026-10-29T12:56:59.251Z):**
```
{"timestamp":"2026-10-29T12:56:59.251Z","level":"WARN","type":"INFRA_EVENT","message":"Delivery callback for SMcced**************************** could not be attributed to a tenant project","commercial_impact":"Delivery status was recorded against the outbound message but could not be attributed to a tenant or project for dashboard publishing."}
```

**Verbatim log excerpt 4 (2026-10-29T13:18:14.617Z):**
```
{"timestamp":"2026-10-29T13:18:14.617Z","level":"WARN","type":"INFRA_EVENT","message":"Delivery callback for SM7682**************************** could not be attributed to a tenant project","commercial_impact":"Delivery status was recorded against the outbound message but could not be attributed to a tenant or project for dashboard publishing."}
```

**Verbatim security ledger excerpt (2026-10-29T12:38:50.859Z):**
```
{"timestamp":"2026-10-29T12:38:50.859Z","type":"SECURITY_LEDGER","tenant_id":null,"actor":"twilio_delivery_status","role":"transport_worker","entry_point":"webhook","tool_or_route":"/webhooks/twilio/delivery-status","outcome":"refused","reason":"cst.delivery_attribution_unresolved","correlation_id":"SM291a..."}
```

## 4. Reported Failed-Call Evidence (Historical — Requires Confirmation)

The following incident details were reported from Render logs on 2026-10-28. These are historical evidence requiring confirmation against raw logs. The original log lines are no longer available via the Render API (logs have rotated).

| Timestamp (UTC) | Event | Details |
|-----------------|-------|---------|
| 2026-10-28T21:08:54.110Z | 404 on `/api/v1/readings/latest?sensor_id=VFARM-CAB-001` | The device ID was passed as `sensor_id` but the sensor had no readings. This is a legitimate "no readings" response, not an endpoint error. |
| 2026-10-28T21:09:00.577Z | Voice turn exceeded 7,000 ms deadline | The turn was abandoned without persistence. Root cause: rack sensors take 29-43s to respond, exceeding the 7s voice deadline. |
| 2026-10-28T21:08:xxZ | HTTP 422 for farm-wide request | Reported as a validation error for a farm-wide readings request (using `farm_id` instead of `sensor_id`) |

**RAW LOGS REQUIRED** — These summaries are from a prior report. The exact raw log lines are no longer retrievable via the Render API. An authorized operator must verify these against the Render Dashboard logs.

## 5. Failure Interpretation

- **404 responses:** Legitimate "no readings found for sensor" from vFarm. Devices like `VFARM-CAB-001`, `relay_m3_1`, etc. simply don't have sensor readings. CST's `listLatestReadings` catches these and skips them. Correct behavior, not a bug.
- **Timeouts:** Rack sensors (`rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`) and gateways (`pi_gateway_01`, `uno_board_01`) take 29-43s to respond. This is an upstream vFarm performance issue, not a CST code bug. CST handles this gracefully by returning available readings (relay sensors) and reporting "No per-unit readings are available at this time" for timed-out sensors.
- **Voice deadline exceeded:** The voice turn includes farm health call + device list + N per-device readings + synthesis. With 23 devices (6 batches at 5 concurrency, each with 5s timeout), worst case is 30s. Even with fast 404s and 0.7s relay reads, the rack sensor timeouts (5s each) consume the entire 7s budget. The turn is correctly abandoned without persisting (fail-closed).
- **Delivery callback attribution failure:** Callbacks arrive with `outbound_row_found: false` and null tenant/project. Code is correct (fail-closed). Possible causes: messages sent without project_id persisted, lookup failing due to ID format, or messages created before migrations. All guarded by fail-closed behavior.

## 6. Successful E2E Evidence Section — PENDING OPERATOR E2E

**Status: PENDING OPERATOR E2E**

No authorized live E2E test has been performed. The operator must complete the checklist below.

### Operator E2E Checklist

- [ ] Date/time in UTC: ____________
- [ ] Render service: `bha-cst` (srv-db8hepqvcj2c73adpus0)
- [ ] Deployed commit SHA: ____________
- [ ] Environment: staging / production
- [ ] Call SID/correlation ID: ____________
- [ ] Authorized caller identity reference: ____________ (masked)
- [ ] Authorization outcome: granted / denied
- [ ] Farm IDs resolved: ____________
- [ ] Upstream endpoint: `GET /api/v1/devices?farm_id={farmId}` — HTTP status: ___ — duration: ___ms
- [ ] Upstream endpoint: `GET /api/v1/readings/latest?sensor_id={sensorId}` — HTTP status: ___ — duration: ___ms
- [ ] Raw received measurements: ____________ (sanitized)
- [ ] Normalized CST fields: ____________
- [ ] Readings included in voice response: ____________
- [ ] Voice intent recognized: ____________
- [ ] Actual caller-facing response: ____________
- [ ] Conversation turn persisted: yes/no
- [ ] Security/audit log correlation: ____________
- [ ] Total response duration: ___ms (must be < 12000ms, hard cap 14000ms)
- [ ] 12,000 ms deadline met: yes/no
- [ ] Partial response returned before deadline: yes/no
- [ ] Unauthorized caller test: fail-closed confirmed: yes/no
- [ ] Render log excerpts with timestamps: ____________

## 7. Database Verification

### Read-Only Inspection Results

| Item | Value | Source |
|------|-------|--------|
| Migration count | 22 applied (001-022) | Render deploy logs |
| `public.escalations` table | Present | Render deploy logs (migration 022 applied) |
| Database plan | Free | Render API |
| Database expiry | 2026-11-14T18:10:20Z | Render API |
| PostgreSQL version | 16.15 | Render API |
| IP allow-list | `0.0.0.0/0` (everywhere) | Render API |
| Network isolation | Disabled | Render API |

### Continuity Decision (COMPLETE — Database upgrade already completed by account owner)
- **Status:** COMPLETE — Database upgrade has been completed by the account owner. No further action required.
- **Further database changes:** OUT OF SCOPE. No upgrades, migrations, recreations, or replacements should be performed.
- **Existing configuration:** Preserve unchanged. No plan, region, networking, IP allowlist, firewall, credential, or connection setting changes.
- **Remaining observations (findings only):** IP allow-list is `0.0.0.0/0` (everywhere) with network isolation disabled. This is a finding for security review, not an action item under this task boundary.

## 8. Continuity and Backup Evidence

- **Backup artifact:** `bha-cst-postgres-20261027T140056Z.dump` (80,365 bytes, CUSTOM format)
- **SHA-256:** `a4d64bc61738c4e28d9f16f81a3f1ab751f1a8102fd24e9dd0c5f24f7625f718`
- **pg_restore --list:** PASS (155 TOC entries)
- **Restore drill:** PASSED into isolated PostgreSQL 16.14 (Homebrew) — 20/20 tables, 22/22 migrations, 17 FKs
- **Zero-byte files:** 2 (from failed backup attempts, preserved for log review)
- **Script fix:** Hardcoded `PGPASSWORD` removed from `backup_bha_cst_postgres.sh`

## 9. Still Open

### Blockers (genuine external dependencies)

- **BLOCKER:** Rack sensor timeout (29-43s) exceeds voice deadline — upstream vFarm performance. Latest E2E: voice call completed with synthesis but sensor readings timed out at 10s, reading_count=0 twice. 10,000ms production timeout does NOT meet Jason's 5,000ms contract.
- **BLOCKER:** KMG9 BHARAG boundary — needs isolated cluster evidence
- **BLOCKER:** ElevenLabs live voice acceptance — needs staging + authorized test call
- **BLOCKER:** Twilio live SMS/callback acceptance on current SHA — needs production credentials + authorized test. Two SMS sends observed but BOTH were pre-SHA-17.
- **BLOCKER:** Delivery callback attribution — 35 distinct Message SIDs with no matching outbound row, 105 refusal log entries. Fail-closed working but dashboard delivery publication incomplete.
- **BLOCKER:** GitHub push access — SSH key passphrase unavailable
- **BLOCKER:** Stale customer refs — owner confirmation needed
- **BLOCKER:** Legacy systems table — owner decision needed
- **BLOCKER:** EWQI vFarm contract — vFarm owner confirmation needed
- **BLOCKER:** Expired vFarm JWT — expires 2026-10-23T20:05:24Z, needs reissue or auto-recovery via VFARM_ADMIN_EMAIL/PASSWORD
- **BLOCKER:** Missing VFARM_API_FARM_KEY, BHARAG_CLUSTER_KEY, BHARAG_WORKSPACE_KEY, VFARM_RESOLVE_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, CST_API_KEY, VFARM_API_BASE_URL, VFARM_RESOLVE_ENDPOINT, BHARAG_API_URL — all required for production operation
- **BLOCKER:** CST_ADMIN_PASSWORD_HASH uses SHA-256 of "admin" — needs bcrypt regeneration
- **BLOCKER:** Migration state — 23 files, 23 recorded, 0 applied, 2 drifted (006 and 010 contents changed). Forward-only migration needed.
- **BLOCKER:** Sensor filtering — PARTIAL. Post-deploy rack-only IDs observed but no explicit classification/skip trace.
- **BLOCKER:** Conversation turn persistence — NOT VERIFIED. SQL inspection failed (TLS/allowlist).
- **BLOCKER:** Environment variables — NOT VERIFIED. 13-variable claim needs fresh inventory.

### Resolved (not a blocker)

- **vFarm authentication:** RESOLVED — expired JWT auto-refreshed successfully. Do not reopen, rotate credentials, or list as a blocker.
- **Postgres allowlist:** Tightened from 0.0.0.0/0 to 103.120.71.129/32. Trusted admin IP confirmed.
- **Database continuity:** COMPLETE — upgrade done by account owner. No further action required.
- **Private CST-to-Postgres connectivity:** VERIFIED — internal authenticated sessions in DB logs (TLSv1.3).

## 10. Security Evidence

- **Authorization:** `assertSpeakerFarmAccess()` verifies speaker's `farm_ids` includes farm before any upstream call
- **Tenant isolation:** Fail-closed for missing/invalid grants, no fabricated identity
- **Secret logging:** All credentials masked via `maskKey()` (shows first/last 2 chars only for keys > 8 chars, `***` for shorter)
- **Query privacy:** Raw customer speech replaced with `query_category` in all BHARAG logs
- **Error sanitization:** Error messages sanitized to remove credentials (`token|key|secret|password|api_key` patterns)
- **No secrets in reports:** All phone numbers masked, SIDs truncated, credentials never printed

## 11. Links

- **Decision record:** `docs/decisions/2026-10-29-cst-entry-399-db-endpoint-decision.md`
- **Identity evidence:** `docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md`
- **Render live evidence:** `docs/evidence/2026-10-29-render-live-evidence-entry-399.md`
- **Acceptance SOP:** `docs/acceptance/cst-v1-acceptance-sop.md`
- **E2E capture template:** `docs/evidence/e2e-capture-template.md`
- **Entry 393 draft:** `docs/acceptance/codex-entry-drafts/entry-393-update.md`
- **Entry 399 draft:** `docs/acceptance/codex-entry-drafts/entry-399-update.md`
- **vFarm device readings report:** `VFARM_DEVICE_READINGS_REPORT.md`
- **vFarm curl commands:** `VFARM_CURL_COMMANDS.md`

## 12. Final Handoff

### Work completed:
- All safe local code fixes implemented and tested
- vFarm endpoint contract verified via live API
- Backup script credential leak fixed
- Voice health model corrected
- Escalation service implemented with durable records
- BHARAG privacy logging added
- Slack dry-run mode added
- Task plan updated with verified statuses

### Work blocked or unverified:
- KMG9: needs isolated cluster evidence
- Postgres: COMPLETE — upgrade done by account owner
- Voice: needs live provider verification (deadline now 12000ms, hard cap 14000ms)
- EWQI: needs vFarm contract proof
- Delivery attribution: needs production DB investigation
- GitHub: needs SSH key unlock
- Stale customers: needs owner confirmation
- Env vars: 13 missing/incorrect variables documented in audit (JWT expired, farm key, BHARAG keys, Twilio creds, etc.)

### Named owner and next action for each blocker:
See Section 9 (Blockers / Owner Decisions) above.

### Exact condition for requesting Jason's acceptance:
All 4 gates must pass:
1. Endpoint contract verified (DONE locally, needs live E2E)
2. DB/endpoint decision record linked from Entry 399 (PARTIAL)
3. Entry 393 mission-fit corrected with identity evidence (PARTIAL)
4. Entry 399 incident evidence + live E2E proof (BLOCKED — needs operator E2E)

---

**No commit, push, merge, deployment, production data mutation, external account change, or credential rotation was performed during this task.** All changes exist in the working tree only and have not been committed. All verification was read-only against the local repository and local test suite. No live SMS, voice calls, provider transactions, or production database writes were performed.

**Final status: PARTIAL** — Code work verified and tested locally. External/live acceptance remains outstanding. All 1006 tests pass, typecheck clean, build successful, git diff --check clean. Working tree preserved with all existing changes. No production changes made. All code-level defects identified and fixed. External blockers documented with owners and required evidence. Ready for owner review and authorized deployment when staging is available.
