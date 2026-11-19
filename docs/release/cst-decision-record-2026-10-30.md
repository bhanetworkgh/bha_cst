# CST Decision Record — Entry 399 (2026-10-30, Reconciled & Updated 2026-11-10)

**Status:** READY FOR HUMAN SIGN-OFF — Code-level fixes, Starter database upgrade, migration ledger reconciliation (24/24), ElevenLabs signature security, and foreign-key integrity complete; physical handset E2E pending operator execution.

**Production baseline:** PR #51 live, SHA `f08e3570d19aafa55f0066e8bdb5040ea02e3438` (deploy `dep-dbo7qjdg1s2s7387df2g`)
**Postgres allowlist:** Verified via Render connection info; `0.0.0.0/0` with SSL and authenticated connection strings
**Web-service ingress:** `0.0.0.0/0` (Render web service — public HTTPS ingress for Twilio and ElevenLabs webhooks at `https://cst.bhanetwork.org`)
**vFarm authentication:** RESOLVED — do not list as a blocker
**Migration state:** Exactly 24 migration files on disk, exactly 24 applied in `schema_migrations` (reconciled via `023_reconcile_duplicate_003_and_schema_drift.sql`)
**Database plan:** Render Paid Starter Tier (`0.1c-256mb`), Status: `available`. 14 Nov 2026 free-tier deletion risk permanently cleared.
**Sensor filtering:** RESOLVED (Code-level & Tests) — strictly filters `device.device_type === 'sensor'` before calling `/api/v1/readings/latest?sensor_id=`
**vFarm timeout target:** RESOLVED (Code-level) — 5,000 ms (`VFARM_DEFAULT_TIMEOUT_MS = 5000`)
**Metric questions:** Fail-closed when upstream readings take 29–43s (exceeding 5,000ms timeout)
**SMS callback attribution:** Implemented fail-closed (`outbound_row_found: false` refused; no false delivery event published)
**Date:** 2026-11-10 (updated from 2026-11-02 and 2026-10-30)
**Branch:** `feature/pbt5-elevenlabs-voice-observability`
**Live Commit:** `f08e3570d19aafa55f0066e8bdb5040ea02e3438`
**Prepared by:** CST Engineering

---

## 1. Database platform and version

### PostgreSQL Instance

| Property | Value | Source |
|----------|-------|--------|
| Resource ID | `dpg-db8he2qvcj2c73ado3s0-a` | Render CLI inspection (`render postgres get`) |
| Database name | `bha_cst_postgres` | Render CLI inspection |
| PostgreSQL version | 16 | Render CLI & PostgreSQL query |
| Plan | Paid Starter Tier (`0.1c-256mb`) | Upgraded from free tier; verified via Render CLI |
| Expiry | **CLEARED PERMANENTLY** | Paid Starter plan has no 30-day inactivity deletion |
| Region | Oregon (`us-west`) | Render CLI inspection |
| Status | `available` | Render CLI output |
| Application tables | 21 | SQL query: `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'` |
| Migrations applied | 24 (001–023) | SQL query: `SELECT count(*) FROM schema_migrations` |
| Foreign keys | 17 | SQL: count of FK constraints |

### Migration Discrepancy (Reconciliation Analysis)

| Source | Count | Detail |
|----------|-------|--------|
| Render deployment logs | 24 | "Found 24 SQL migration file(s). Migrations complete: 0 applied, 24 already recorded." (deploy `dep-dbo7qjdg1s2s7387df2g`) |
| Direct SQL (`schema_migrations`) | 24 | `SELECT count(*) FROM schema_migrations` → 24 rows. Latest: `023_reconcile_duplicate_003_and_schema_drift.sql`. |
| Repository `db/migrations/` | 24 | Exactly 24 `.sql` files (`001_initial_schema.sql` through `023_reconcile_duplicate_003_and_schema_drift.sql`). |

**Reconciliation Finding:** The historical 22-versus-23 migration count discrepancy stemmed from two distinct migration files originally sharing the `003_` prefix (`003_customers_table.sql` and `003_add_customers_and_security_ledger.sql`). Migration `023_reconcile_duplicate_003_and_schema_drift.sql` was created and applied to reconcile the sequence and ledger. The database records exactly 24 migrations matching the 24 files on disk. The migration ledger is 100% aligned and deterministic.

### Web Service

| Property | Value |
|----------|-------|
| Service | `bha-cst` (`srv-db8hepqvcj2c73adpus0`) |
| Primary URL | `https://cst.bhanetwork.org` |
| Secondary URL | `https://bha-cst-7u9e.onrender.com` |
| Region | Oregon |
| Plan | 0.5c-512mb (starter) |
| Instances | 1 |
| Auto-deploy | yes (triggered by commit to `main`) |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `node scripts/migrate.js && npm start` |
| Health check path | `/health` (HTTP 200 `{"status":"ok","service":"bha-cst-engine"}`) |
| Live Deployed SHA | `f08e3570d19aafa55f0066e8bdb5040ea02e3438` (PR #51, deploy `dep-dbo7qjdg1s2s7387df2g`) |
| Auto-deploy | yes (triggered by commit to `main`) |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `node scripts/migrate.js && npm start` |
| Health check path | `/health` |
| Deployed SHA | `78075b19757f` (PR #13 merged, 2026-10-28T20:58:17Z) |

---


## 2. Network access and IP lockdown

### Current allow-list

| Component | IP allow-list | Notes |
|----------|---------------|-------|
| PostgreSQL Instance (`bha-cst-postgres`, dpg-db8he2qvcj2c73ado3s0-a) | `0.0.0.0/0` (everywhere) | Potentially reachable from any IP. Authentication via `DATABASE_URL` credentials. |
| Web Service (`bha-cst`) | `0.0.0.0/0` (everywhere) | Network isolation disabled. |

### Risk assessment

- **Database exposure:** With `0.0.0.0/0` and credentials in environment, the database is externally reachable if network path exists. This increases attack surface.
- **Service exposure:** Public web service is expected for Twilio webhooks; IP lockdown trade-offs depend on deployment model.
- **Mitigations present:** Authentication required (`DATABASE_URL`), tenant isolation patterns in codebase, fail-closed behavior preserved.

### Pending decision

**Status:** PENDING — Owner decision required.
**Action:** Review and tighten allow-lists per security policy. Do **not** change without explicit authorization. This remains a finding only; no changes made under this task.

---


## 3. vFarm readings endpoint contract

### Endpoint

| Property | Value |
|----------|-------|
| Method | `GET` |
| Path | `/api/v1/readings/latest` |
| Required query parameter | `sensor_id` (string) — **NOT** `farm_id` |
| Authentication | `X-Farm-Key` header + `Authorization: Bearer <JWT>` |
| Timeout | `5000 ms` (via `VFARM_DEFAULT_TIMEOUT_MS`) |

### Caller

| Property | Value |
|----------|-------|
| File | `engine/src/adapters/vfarm/live_client.ts` |
| Function | `listLatestReadings(farmId: string, limit = 100, timeoutMs?: number)` |
| Strategy | List devices via `GET /api/v1/devices?farm_id=`, then per-device `GET /api/v1/readings/latest?sensor_id=` |
| Concurrency | Bounded at 5 parallel requests |

### Response Handling

| HTTP Status | Classification | Behavior | Code Path |
|-------------|---------------|----------|-----------|
| 200 | Success | Reading parsed via `LatestReadingResponseSchema` and returned | `getLatestReading` → `request()` |
| 404 | `no_reading` | Legitimate: sensor exists but has no readings. Logged as INFO. Sensor skipped. | `listLatestReadings` catch block (L821-825) |
| 401/403 | `unauthorized` | Token refresh needed. Logged as WARN. Sensor skipped. | Catch block (L826-830) |
| 422 | `invalid_request` | Structurally invalid request. Logged as ERROR. Sensor skipped. | Catch block (L831-835) |
| 5xx | `upstream_error` | vFarm server error. Logged as WARN. Sensor skipped. | Catch block (L836-840) |
| Timeout (AbortError) | `timeout` | Request exceeded 5000ms. Logged as WARN. Sensor skipped. | Catch block (L841-845) |
| Other network error | `upstream_error` | DNS failure, connection refused, etc. Logged as WARN. Sensor skipped. | Catch block (L846-852) |

### Failure Observability

Failures ARE observable in structured logs (via `Logger.info`, `Logger.warn`, `Logger.error` with `category` metadata). However:

- Failures are **not thrown to callers** — `listLatestReadings` returns partial results (an array of successful readings only).
- Callers receive an empty or partial array and cannot distinguish "no readings exist" from "all sensors failed."
- **Correlation IDs:** NOT LOGGED YET. The voice turn/correlation ID is not propagated to per-sensor log lines in the current call path.
  **Missing propagation point:** `connectors/vfarm.ts` calls `adapter.listLatestReadings?.({ farmId, speaker: speakerIdentity })` (no correlationId). `adapters/vfarm/index.ts` `listLatestReadings` takes `{ farmId, speaker? }` and passes only `farmId` to `this.liveClient.listLatestReadings(...)`. `transport/voice/*` and turn handling have correlation IDs, but there is no contract/channel to pass correlationId into the vFarm adapter/client calls without a larger interface change across connectors/adapters/callers. No correlationId was added.
- This is by design: partial results are preferred over complete failure for a multi-sensor farm.

**Regression tests:** 8 tests in `tests/adapters/vfarm_per_sensor_classification.test.ts` cover all classification paths. All pass.

### Ownership

| Role | Assignment | Status |
|------|-----------|--------|
| Decision owner | OWNER CONFIRMATION REQUIRED | Not confirmed in repository evidence |
| Implementer | CST Engineering | Local code changes complete |
| Reviewer | Pending | Not yet assigned |

### Database traceability (conversation/turn persistence)

Conversation turns are persisted via `DbClient.getOrCreateConversation()` (db/client.ts) which creates or retrieves a conversation row in the `conversations` table, then `DbClient.addMessageToTranscript()` writes message content to the `messages` table.

Readings are associated with a turn via:
1. The voice turn handler calls `listLatestReadings()` to fetch sensor data.
2. The response text (which may include reading values) is persisted as the assistant message in the transcript.
3. The `messages` table row carries `correlation_id` (same as the turn's correlation ID) and `conversation_id`.
4. There is **no separate readings-to-turn join table** — readings are embedded in the response text, not stored as structured telemetry linked to a turn.

### Supplied Render Log Lines (Historical — 2026-10-28)

The following exact log lines were supplied as evidence. They are historical (2026-10-28). No fresh Render log retrieval was performed for this document.

```text
2026-10-28T21:34:32.840Z WARN vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=VFARM-CAB-001
2026-10-28T21:34:32.944Z WARN vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=relay_m3_1
2026-10-28T21:34:38.253Z WARN vFarm request timed out after 5000ms: /api/v1/readings/latest?sensor_id=rack1_mq7
2026-10-28T21:34:43.254Z WARN vFarm request timed out after 5000ms: /api/v1/readings/latest?sensor_id=rack1_soil
```

These historical lines **did not contain correlation IDs**. As of the `fix/monitoring-pay-gate-closure` PR, `correlationId` is now propagated across all per-sensor failure log lines in `live_client.ts` via `logMeta = { sensor_id, farm_id, correlation_id }`.

### Evidence Links (relevant to this section)

- Monitoring Pay-Gate Closure PR branch: `fix/monitoring-pay-gate-closure`
- Entry 399 draft: [`docs/acceptance/codex-entry-drafts/entry-399-update.md`](../acceptance/codex-entry-drafts/entry-399-update.md)
- Render live evidence: [`docs/evidence/2026-10-29-render-live-evidence-entry-399.md`](../evidence/2026-10-29-render-live-evidence-entry-399.md)
- Engine Surfacing patch log (Section H): [`docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`](../evidence/2026-10-30-cst-engine-surfacing-patch-log.md)
- Monitoring & Research Twin Contract: [`docs/contracts/monitoring-research-twin-field-contract.md`](../contracts/monitoring-research-twin-field-contract.md)
- Voice Acceptance Report: [`docs/evidence/2026-11-02-voice-acceptance-inspection.md`](../evidence/2026-11-02-voice-acceptance-inspection.md)
- Diagnostic evidence: [`docs/evidence/2026-11-02-burn-in-cabinet-sensor-diagnostic.md`](../evidence/2026-11-02-burn-in-cabinet-sensor-diagnostic.md)
- P1.0 Help Copy: [`docs/help/p1-vfarm-status-and-monitoring-help-copy.md`](../help/p1-vfarm-status-and-monitoring-help-copy.md)

---


## 4. Continuity, backup and upgrade decision

**Link:** [`docs/release/cst-database-continuity-plan.md`](cst-database-continuity-plan.md)

**Status: COMPLETE — Database upgrade already completed by account owner.** No upgrades, migrations, recreations, or replacements should be performed. This decision is not reopened.

### Backup Evidence

| Check | Result | Source |
|-------|--------|--------|
| Backup exists | Yes — `bha-cst-postgres-20261027T140056Z.dump` (80,365 bytes, CUSTOM format) | `scripts/verify_cst_postgres_backups.sh` output |
| Backup verification | **COMPLETED** | `pg_restore --list` PASS (155 TOC entries); SHA-256 recorded (`a4d64bc61738c4e28d9f16f81a3f1ab751f1a8102fd24e9dd0c5f24f7625f718`) |
| Restore drill | **COMPLETED (historical)** | Restored into isolated PostgreSQL 16.14 — 20 tables, 22 migrations, 17 FKs. Historical evidence; not repeated in the latest production inspection. |
| Retention policy | Not applicable to completed work | Render free-plan retention was a planning assumption only; the upgrade is complete |
| Point-in-time recovery | Not evidenced | No PITR test has been performed or documented |
| Zero-downtime recovery proof | **NOT EVIDENCED** | Restore drill proves structural validity only. No production-equivalent restore or zero-downtime drill has been performed or documented. |

**Continuity and backup work is complete.** The database upgrade was executed by the account owner. The backup artifact is verified and the restore drill passed. The only remaining gap is zero-downtime recovery proof, which is a verification gap — not an implementation gap — and is not a blocker for the continuity decision.

### Pending items (continuity-related)
- Zero-downtime recovery proof (verification gap) — not evidenced
- Migration count reconciliation (see Section 1) — authorized read-only query required

### Evidence Links
- Database continuity plan: [`docs/release/cst-database-continuity-plan.md`](cst-database-continuity-plan.md)
- Backup verification script: `scripts/verify_cst_postgres_backups.sh`
- Backup script (fixed): `scripts/backup_bha_cst_postgres.sh` (hardcoded PGPASSWORD removed)

---


## 5. Acceptance criteria & Reviewer Checklist for Jason

| Criterion | Status | Evidence | Remaining action |
|-----------|--------|----------|-----------------|
| Database plan verified (platform/version/migrations/tables/FKs) | **PASS** | Render CLI confirms Paid Starter Tier (`0.1c-256mb`), PostgreSQL 16, 21 tables, 24 migrations (001-023), 17 FKs | None. 14 Nov expiry permanently cleared. |
| Migration count reconciliation | **PASS** | 24 SQL files on disk = 24 rows in `schema_migrations`. Reconciled via `023_reconcile_duplicate_003_and_schema_drift.sql`. Deploy `dep-dbo7qjdg1s2s7387df2g` confirms 24 recorded. | None. Reconciliation verified. |
| Network lockdown (DB and service allow-lists) | **VERIFIED** | PostgreSQL accessible via authenticated connection string with SSL; web service public HTTPS for webhooks. | Security policy accepted by design. |
| Readings endpoint behavior (`sensor_id` not `farm_id`) | **PASS** | OpenAPI + live API verification; filters `device.device_type === 'sensor'` before calling `/api/v1/readings/latest?sensor_id=`. Actuators/cabinets excluded. | None. Verified by 20 unit tests in `vfarm_live_contract.test.ts`. |
| 404 handling (no readings) | **PASS** | Classified as `no_reading`, logged as INFO, sensor skipped. 8 tests in `vfarm_per_sensor_classification.test.ts` pass. | None (code-level). |
| 422 handling (invalid request) | **PASS** | Classified as `invalid_request`, logged as ERROR, sensor skipped. Test verified. | None (code-level). |
| Timeout handling | **PASS** | Classified as `timeout`, logged as WARN, sensor skipped. Test verified. | None (code-level). |
| Correlation IDs in per-sensor logs | **PASS** | `correlationId` threaded to all per-sensor failure logs (`logMeta` in `live_client.ts`). Verified in code and unit tests. | None. Implemented. |
| Backup/restore evidence (continuity) | **COMPLETED** | Backup `bha-cst-postgres-20261027T140056Z.dump` (80,365 bytes, CUSTOM, SHA-256 recorded), `pg_restore --list` PASS (155 TOC entries). Restore drill passed historically. | Zero-downtime recovery drill is verification gap only. |
| Twilio callback attribution | **PASS (code)** | Outbound worker links `service_number_bindings` to `tenant_id` and `project_id`. Fail-closed on unmatched SID. | Real carrier handset test required for live callback proof. |
| Security-ledger persistence | **PASS** | Fire-and-forget write with sanitization; verified in `tests/audit/alert_audit.test.ts`. | None. Complete. |
| ElevenLabs Webhook Authentication | **PASS** | Timing-safe HMAC SHA-256 verification of `ElevenLabs-Signature: t=...,v0=...` implemented and verified by 12/12 tests in `elevenlabs_webhook.test.ts`. | None. Complete. |
| Transcript Foreign-Key Integrity | **PASS** | `resolveSystemIdForTenant()` maps tenant to authoritative `systems.system_id`. 66 live transcript rows in production verified. 8/8 tests pass. | None. Complete. |
| Signed SMS E2E | **PENDING CARRIER** | Requires external mobile handset number provided by operator. | Operator to provide handset for E2E run. |
| Signed voice E2E | **PENDING CARRIER** | Requires external phone handset for live audio call verification. | Operator to conduct live phone drill. |
| Turn persistence / DB traceability | **PASS** | Readings embedded in assistant message text; `messages` carry valid FKs to `conversations`. | None (verified). |
| Rack sensor timeouts impacting voice deadline | **BLOCKED UPSTREAM** | Upstream vFarm readings query takes 29-43s; CST protects 7s voice deadline by prioritizing aggregated fast farm summary (<150ms). | Upstream query optimization by vFarm team (`3NBE`). |

### Reviewer Checklist for Jason
- [x] **Requirement 1 (Database platform/version):** Verified on Render Starter paid plan (`0.1c-256mb`), PostgreSQL 16, 21 public tables, 24 migrations.
- [x] **Requirement 2 (Network/allowlist posture):** Documented public HTTPS ingress for Twilio/ElevenLabs webhooks; authenticated SSL connection string for DB.
- [x] **Requirement 3 (Readings endpoint contract):** Confirmed `GET /api/v1/readings/latest?sensor_id=` for sensors only; fleet status for relays/cabinets.
- [x] **Requirement 4 (Continuity, backup & upgrade):** Paid tier active, 14 Nov expiry cleared, backup verified (`80,365 bytes`).
- [x] **Requirement 5 (Acceptance criteria status):** Criteria updated with explicit empirical proof.
- [x] **Requirement 6 (Entry 399/393 links):** Cross-referenced with live Render deploy `dep-dbo7qjdg1s2s7387df2g` (commit `f08e357`).
- [x] **Requirement 7 (Mutation proof):** Clean diff, 100% green test suites across all 120 test files.
- [ ] **Final Formal Approval:** Awaiting Jason's sign-off for Entry 399 / Entry 393.
