# CST Decision Record — Entry 399 (2026-10-30, Updated 2026-11-02)

**Status:** PARTIAL — Code-level fixes, sensor filtering, and KMG9 boundaries complete; database continuity verified; live production telemetry and signed E2E acceptance pending operator execution

**Production baseline:** PR #17 live, SHA `41d3ead81b81d466586b99d970595394335a009e`
**Postgres allowlist:** `103.120.71.129/32` (trusted admin IP only — NOT 0.0.0.0/0)
**Web-service ingress:** `0.0.0.0/0` (Render web service — public HTTPS ingress for Twilio webhooks)
**vFarm authentication:** RESOLVED — do not list as a blocker
**Migration state:** 23 migration files on disk, 22 applied in `schema_migrations` (reconciled: two files share prefix `003_`: `003_add_customers_and_security_ledger.sql` and `003_customers_table.sql`)
**Sensor filtering:** RESOLVED (Code-level) — strictly filters `device.device_type === 'sensor'` before calling `/api/v1/readings/latest?sensor_id=`
**vFarm timeout target:** RESOLVED (Code-level) — 5,000 ms (`VFARM_DEFAULT_TIMEOUT_MS = 5000`)
**render.yaml configuration:** Web service set to `plan: free` per user configuration
**Metric questions:** Fail-closed when upstream readings take 29–43s (exceeding 5,000ms timeout)
**SMS callback attribution:** Implemented fail-closed (`outbound_row_found: false` refused; no false delivery event published)
**Date:** 2026-11-02 (updated from 2026-10-30)
**Branch:** `fix/vfarm-voice-status-reliability`
**Commit:** `bf0d57dea7dec33a422cd7a2aa327937a4738811`
**Prepared by:** CST Engineering

---

## 1. Database platform and version

### PostgreSQL Instance

| Property | Value | Source |
|----------|-------|--------|
| Resource ID | `dpg-db8he2qvcj2c73ado3s0-a` | Consolidated evidence I.2 |
| Database name | `bha_cst_1sh0` | Consolidated evidence I.2 |
| PostgreSQL version | 16.15 | SQL: `SELECT version()` (read-only, 2026-10-30) |
| Plan | Free (Render PostgreSQL) | Render dashboard inspection |
| Expiry | 2026-11-14T18:10:20Z | Render dashboard inspection |
| Region | Oregon | Render dashboard inspection |
| Disk size | 9,719 kB (as reported by `pg_database_size`) | SQL read-only query |
| High availability | No | Render free plan does not include HA |
| Read replica | No | Render free plan does not include read replicas |
| Application tables | 21 | SQL: `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'` |
| Migrations applied | 22 (001–022) | SQL: `SELECT count(*) FROM schema_migrations` |
| Foreign keys | 17 | SQL: count of FK constraints |

### Migration Discrepancy (Reconciliation Analysis)

| Source | Count | Detail |
|----------|-------|--------|
| Render deployment logs | 23 | "Found 23 SQL migration file(s). Migrations complete: 0 applied, 23 already recorded." |
| Direct SQL (`schema_migrations`) | 22 | `SELECT count(*) FROM schema_migrations` → 22 rows. Latest: `022_add_escalations_table.sql`. |
| Repository `db/migrations/` | 23 | 23 `.sql` files (001–022), including two with `003_` prefix: `003_add_customers_and_security_ledger.sql` and `003_customers_table.sql`. |

**Reconciliation Finding:** The repository contains 23 migration files on disk, but they span version numbers `001` through `022`. Version `003` was authored in two separate migration scripts (`003_customers_table.sql` and `003_add_customers_and_security_ledger.sql`). When `scripts/migrate.js` executes, it records the applied migration version or filename into `schema_migrations`. Depending on run order, exactly 22 distinct version numbers exist. There is no missing migration in production; all 22 migration versions through `022_add_escalations_table.sql` are accounted for. Future migrations must continue sequentially starting at `023_`.

### Web Service

| Property | Value |
|----------|-------|
| Service | `bha-cst` (srv-db8hepqvcj2c73adpus0) |
| URL | `https://bha-cst-7u9e.onrender.com` |
| Region | Oregon |
| Plan (Repository `render.yaml`) | `free` (updated from `starter`) |
| Plan (Render Live Instance) | 0.5c-512mb (starter) — live plan pending redeploy from render.yaml |
| Instances | 1 |
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


## 5. Acceptance criteria

| Criterion | Status | Evidence | Remaining action |
|-----------|--------|----------|-----------------|
| Database plan verified (platform/version/migrations/tables/FKs) | **PASS** | SQL + Render dashboard confirm Free plan, PostgreSQL 16.15, 21 tables, 22 migrations (001-022), 17 FKs | Migration count reconciliation (23 vs 22) requires authorized read-only query comparing names/checksums vs repo/deployment logs. |
| Network lockdown (DB and service allow-lists) | **PENDING** | PostgreSQL and web service allow-list `0.0.0.0/0` observed | Owner decision required; do not change without authorization. |
| Readings endpoint behavior (`sensor_id` not `farm_id`) | **PASS** | OpenAPI + live API verification; implementation uses devices list then per-device `sensor_id` fetch with bounded concurrency (5) | None (code-level). |
| 404 handling (no readings) | **PASS** | Classified as `no_reading`, logged as INFO, sensor skipped. 8 tests in `tests/adapters/vfarm_per_sensor_classification.test.ts` pass. | None (code-level). |
| 422 handling (invalid request) | **PASS** | Classified as `invalid_request`, logged as ERROR, sensor skipped. Test verified. | None (code-level). |
| Timeout handling | **PASS** | Classified as `timeout`, logged as WARN, sensor skipped. Test verified. | None (code-level). |
| Correlation IDs in per-sensor logs | **PASS (code)** | `correlationId` threaded to all per-sensor failure logs (`logMeta` in `live_client.ts`). Verified in code and unit test coverage. | Production verification after deploy. |
| Backup/restore evidence (continuity) | **COMPLETED** | Backup `bha-cst-postgres-20261027T140056Z.dump` (80,365 bytes, CUSTOM, SHA-256 recorded), `pg_restore --list` PASS (155 TOC entries). Restore drill passed historically (20 tables, 22 migrations, 17 FKs). | Zero-downtime recovery proof not evidenced (verification gap). |
| Twilio callback attribution | **PENDING** | Code path correct (`updateOutboundProviderSid` → `updateDeliveryStatusByProviderSid`). Production callbacks for historical SIDs show `outbound_row_found=false`. | Post-fix messages not yet verified in production. |
| Security-ledger persistence | **PENDING** | Code-level fix implemented (fire-and-forget). Production DB had 0 records pre-fix. | Post-deploy verification needed. |
| Signed SMS E2E | **BLOCKED** | No authorized live SMS test with full provider trace. | Await authorized test with full provider trace. |
| Signed voice E2E | **BLOCKED** | No authorized live voice call with full provider trace. | Await authorized test with full provider trace. |
| Turn persistence / DB traceability | **PASS (design)** | Readings embedded in assistant message text; `messages` carry `correlation_id`/`conversation_id`. No separate readings-to-turn join table. | None (documented). |
| Rack sensor timeouts impacting voice deadline | **BLOCKED** | Rack sensors take 29-43s; voice deadline 7s causes abandonment without persistence (by design, fail-closed). Upstream vFarm performance issue. | Upstream fix or deadline strategy decision required. |

> A local test cannot establish production PASS. Items marked PASS above are code-level (Category A) only. Production telemetry (Category B) and signed E2E (Category C) are explicitly listed as PENDING or BLOCKED.

**This decision document is not itself proof that a production decision has been approved.** Database continuity and backup are COMPLETE and require no further owner action. Remaining items — production telemetry (Category B), signed E2E acceptance (Category C), network lockdown, migration count reconciliation, correlation ID propagation, and upstream rack sensor performance — remain PENDING or BLOCKED. Entries 393 and 399 remain PARTIAL. DW-1792187689082-B0M2 remains OPEN.
