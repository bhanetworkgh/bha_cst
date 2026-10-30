# CST Decision Record — Entry 399 (2026-10-30)

**Status:** PARTIAL — Code-level evidence complete; production telemetry and signed E2E pending
**Date:** 2026-10-30
**Branch:** `fix/cst-production-reliability-2026-10-30`
**Commit:** `bf0d57dea7dec33a422cd7a2aa327937a4738811`
**Prepared by:** CST Engineering

---

## 1. Database Facts

### PostgreSQL Instance

| Property | Value | Source |
|----------|-------|--------|
| Resource ID | `dpg-db8he2qvcj2c73ado3s0-a` |  Consolidated evidence I.2 |
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

### Web Service

| Property | Value | Source |
|----------|-------|--------|
| Service ID | `srv-db8hepqvcj2c73adpus0` | Render dashboard |
| Service plan | Starter (`0.5c-512mb`) | Render dashboard |
| Instances | 1 | Render dashboard |
| Region | Oregon | Render dashboard |
| Deployed SHA | `78075b19757f` | Render deployment log |

> **Do not confuse the database plan (Free) with the web service plan (Starter 0.5c-512mb).** These are separate Render resources with separate plans and billing.

---

## 2. Network Access

### Current Allow-List

| Entry | Scope |
|-------|-------|
| `103.120.71.129/32` | Single IP address |
| `0.0.0.0/0` | **Any IP address — permits connections from the entire internet** |

### Risk Assessment

The `0.0.0.0/0` entry means the PostgreSQL instance accepts TCP connections from any source IP. Authentication (username/password via `DATABASE_URL`) is the only barrier. This is the default Render configuration for free-plan databases.

**Risk:** If `DATABASE_URL` credentials are compromised (e.g., via log leak, env exposure, or a dependency vulnerability), the database is directly reachable from the internet without network-layer protection.

**Pending decision:** The allow-list requires an explicit owner decision. CST engineering does not change the allow-list. The recommended action is to restrict to `103.120.71.129/32` and the Render internal network range only, after confirming no other legitimate access paths exist.

**This document records the finding. It does not authorize or recommend any change.**

---

## 3. vFarm Readings Contract

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
| Function | `listLatestReadings(farmId, limit?, timeoutMs?)` |
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
- Correlation IDs from the voice turn are **not propagated** to per-sensor log lines.
- This is by design: partial results are preferred over complete failure for a multi-sensor farm.

**Regression tests:** 8 tests in `tests/adapters/vfarm_per_sensor_classification.test.ts` cover all classification paths. All pass.

---

## 4. Database Continuity

**Link:** [`docs/release/cst-database-continuity-plan.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/release/cst-database-continuity-plan.md)

**Status: COMPLETE — Database upgrade already completed by account owner.** No upgrades, migrations, recreations, or replacements should be performed. This decision is not reopened.

### Backup Evidence

| Check | Result | Source |
|-------|--------|--------|
| Backup exists | Yes — 80,365 bytes, CUSTOM format | `scripts/verify_cst_postgres_backups.sh` output |
| Restore drill | 20 tables, 22 migrations, 17 FKs restored | Restore drill output |
| Retention policy | Pending — Render free plan has no guaranteed retention | Render documentation |
| Point-in-time recovery | Not available on free plan | Render documentation |
| Zero-downtime recovery proof | **Pending** — backup structurally valid but not tested for zero-downtime | Restore drill does not prove zero-downtime |

---

## 5. Acceptance Checklist

| Item | Status | Evidence |
|------|--------|----------|
| Database plan verified | **PASS** | SQL + Render dashboard confirm Free plan, PostgreSQL 16.15, 21 tables, 22 migrations |
| Network lockdown | **PENDING** | `0.0.0.0/0` present. Owner decision required. |
| Readings endpoint behavior | **PASS** | `sensor_id` parameter implemented. Per-device fetch with bounded concurrency. 8 tests pass. |
| 404 handling | **PASS** | Classified as `no_reading`, logged as INFO, sensor skipped. Test verified. |
| 422 handling | **PASS** | Classified as `invalid_request`, logged as ERROR, sensor skipped. Test verified. |
| Timeout handling | **PASS** | Classified as `timeout`, logged as WARN, sensor skipped. Test verified. |
| Correlation IDs in per-sensor logs | **PENDING** | Per-sensor failure logs do not carry the voice turn's correlation ID. |
| Backup/restore evidence | **PENDING** | Backup file exists and restores structurally. Retention and PITR not available on free plan. |
| Twilio callback attribution | **PENDING** | Code path correct (`updateOutboundProviderSid` → `updateDeliveryStatusByProviderSid`). Production callbacks for historical SIDs show `outbound_row_found=false`. Post-fix messages not yet verified in production. |
| Security-ledger persistence | **PENDING** | Code-level fix implemented (fire-and-forget). Production DB had 0 records pre-fix. Post-deploy verification needed. |
| Signed SMS E2E | **BLOCKED** | No authorized live SMS test with full provider trace. |
| Signed voice E2E | **BLOCKED** | No authorized live voice call with full provider trace. |

> A local test cannot establish production PASS. Items marked PASS above are code-level (Category A) only. Production telemetry (Category B) and signed E2E (Category C) are explicitly listed as PENDING or BLOCKED.

---

## 6. Evidence Links

- Engine Surfacing patch log: [`docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md)
- Consolidated acceptance evidence: [`docs/acceptance/cst-jason-consolidated-evidence.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/acceptance/cst-jason-consolidated-evidence.md)
- Render live evidence: [`docs/evidence/2026-10-29-render-live-evidence-entry-399.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/evidence/2026-10-29-render-live-evidence-entry-399.md)
- Database continuity plan: [`docs/release/cst-database-continuity-plan.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/release/cst-database-continuity-plan.md)
- Entry 399 draft: [`docs/acceptance/codex-entry-drafts/entry-399-update.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/acceptance/codex-entry-drafts/entry-399-update.md)
- Decision record (2026-10-29): [`docs/decisions/2026-10-29-cst-entry-399-db-endpoint-decision.md`](file:///Users/HaMi/Documents/Jason/customer%20twin/docs/decisions/2026-10-29-cst-entry-399-db-endpoint-decision.md)

---

## 7. Supplied Render Log Lines

The following exact log lines were supplied as evidence. They are historical (2026-10-28). No fresh Render log retrieval was performed for this document.

```text
2026-10-28T21:34:32.840Z WARN vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=VFARM-CAB-001
2026-10-28T21:34:32.944Z WARN vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=relay_m3_1
2026-10-28T21:34:38.253Z WARN vFarm request timed out after 5000ms: /api/v1/readings/latest?sensor_id=rack1_mq7
2026-10-28T21:34:43.254Z WARN vFarm request timed out after 5000ms: /api/v1/readings/latest?sensor_id=rack1_soil
```

These lines **do not contain correlation IDs**. This is recorded honestly.

---

## 8. Conversation Turn Persistence

Conversation turns are persisted via `DbClient.getOrCreateConversation()` (db/client.ts L1097+) which creates or retrieves a conversation row in the `conversations` table, then `DbClient.addMessageToTranscript()` writes message content to the `messages` table.

Readings are associated with a turn via:
1. The voice turn handler calls `listLatestReadings()` to fetch sensor data.
2. The response text (which may include reading values) is persisted as the assistant message in the transcript.
3. The `messages` table row carries `correlation_id` (same as the turn's correlation ID) and `conversation_id`.
4. There is **no separate readings-to-turn join table** — readings are embedded in the response text, not stored as structured telemetry linked to a turn.

---

**This decision document is not itself proof that a production decision has been approved. All items remain PENDING until the authorized owner confirms the decision and provides the required evidence. Entries 393 and 399 remain PARTIAL. DW-1792187689082-B0M2 remains OPEN.**
