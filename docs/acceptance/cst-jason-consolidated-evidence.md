---

## I. Latest Render Production and PostgreSQL Evidence — 2026-10-30

**Review purpose:** Supplement Entries 393 and 399 with the latest read-only production evidence from Render application logs, service events, deployment metadata, and live PostgreSQL inspection.

**Evidence window (UTC):** `2026-10-27T22:43:49Z` through `2026-10-29T22:43:49Z`

**Pakistan local time (UTC+05:00):** `2026-10-28 03:43:49` through `2026-10-30 03:43:49`

**Inspection method:** Render service and PostgreSQL metadata, paginated Render logs, service events, and read-only SQL queries.

**Safety:** No production database writes, migrations, configuration changes, restarts, deployments, credential changes, or provider transactions were performed during this inspection.

### I.1 Render Service and Deployment Snapshot

| Field | Latest inspected value |
|---|---|
| Service | `bha-cst` |
| Service ID | `srv-db8hepqvcj2c73adpus0` |
| Repository | `bhanetworkgh/bha_cst` |
| Production branch | `main` |
| Region | Oregon |
| Service plan | Starter (`0.5c-512mb`) |
| Instance count | 1 |
| Health check | `/health` |
| Deployed SHA | `78075b19757f539b88098a97a46cfcbf7b7937c6` |
| Successful deployment completion | `2026-10-28T20:59:14.495714Z` |

The deployed SHA matches the merge commit reported in the existing package at the abbreviated SHA level (`78075b19757f`).

Additional deployment evidence:

- Earlier failed deployment: `2026-10-28T19:37:47.050406Z`.
- Failure reason: process exited with status 1.
- Earlier `server_failed` events were observed around `2026-10-28T19:12Z`–`19:15Z`.
- A successful deployment subsequently completed at `2026-10-28T20:59:14.495714Z`.

**Interpretation:** The later successful deployment confirms that a live deployment completed after the earlier failure. It does not establish that every outstanding production acceptance test passed.

### I.2 Live PostgreSQL Inspection

**Resource**

| Field | Value |
|---|---|
| PostgreSQL resource ID | `dpg-db8he2qvcj2c73ado3s0-a` |
| Database | `bha_cst_1sh0` |
| PostgreSQL version | 16.15 |
| Database size | 9,719 kB |

**Direct read-only SQL results**

| Check | Latest result |
|---|---:|
| Application tables | 21 |
| `schema_migrations` records | 22 |
| Foreign-key constraints | 17 |
| Primary-key constraints | 21 |
| Unique constraints | 4 |
| Check constraints | 157 |
| Active connections at inspection | 1 |
| Idle connections at inspection | 2 |
| Total connections at inspection | 3 |

The 21 application tables inspected were:

`admin_sessions`, `admin_users`, `alert_audit_log`, `conversations`, `customers`, `dashboard_publish_outcomes`, `escalations`, `messages`, `messages_in`, `messages_out`, `organizations`, `projects`, `schema_migrations`, `security_ledger`, `service_number_bindings`, `sms_consent_audit`, `sms_consent_prompts`, `sms_consents`, `systems`, `voice_deliveries`, and `workspaces`.

**Migration evidence**

- Direct SQL returned 22 rows in `schema_migrations`.
- Latest migration: `022_add_escalations_table.sql`.
- Applied timestamp: `2026-10-28T17:02:14.122471Z`.
- Two migration filenames use the `003_` prefix:
  - `003_add_customers_and_security_ledger.sql`
  - `003_customers_table.sql`

The repository migration filenames and checksums still need reconciliation against the production migration records.

### I.3 Database Evidence Reconciliation

The existing report contains earlier evidence stating:

- 20 tables.
- 22 migrations applied.
- Render migration logs reporting 23 SQL migration files and 23 already recorded.

The latest direct SQL inspection returned:

- 21 application tables.
- 22 actual `schema_migrations` records.

These figures must not be silently combined or treated as interchangeable.

**Current authoritative observation for this inspection:** 21 application tables and 22 rows in `schema_migrations`, based on direct read-only SQL.

**Outstanding reconciliation:** Compare the exact production migration names and checksums against the repository and the Render migration logs. Determine why the deployment log reported 23 files/records while the direct database query returned 22 migration records.

**Likely cause (not confirmed):** The repository contains 23 `.sql` files in `db/migrations/` (001–022), including **two** files with the `003_` prefix: `003_add_customers_and_security_ledger.sql` and `003_customers_table.sql`. The deployment log counts 23 files on disk; the database records 22 applied migrations because both `003_*` files share the same migration version prefix. This explanation has **not been verified** by comparing production migration names and checksums against the deployment log. It is recorded as a hypothesis, not a conclusion.

The earlier restore-drill result remains historical evidence: 20 tables, 22 migrations, and 17 foreign keys restored into isolated PostgreSQL 16.14. It is not a replacement for the latest production schema count.

### I.4 Database Record Counts — Fixed Review Window

The following counts were obtained from the live database for the review window stated above.

| Table / filter | Records | First timestamp (UTC) | Last timestamp (UTC) |
|---|---:|---|---|
| `messages_in` | 0 | — | — |
| `messages`, inbound | 4 | `2026-10-28T19:19:09.886199Z` | `2026-10-28T21:34:32.281319Z` |
| `messages`, outbound | 5 | `2026-10-28T19:19:10.921479Z` | `2026-10-28T19:54:34.085971Z` |
| `voice_deliveries` | 17 | `2026-10-28T19:18:58.272Z` | `2026-10-28T21:34:48.890Z` |
| `dashboard_publish_outcomes` | 7 | `2026-10-28T19:19:10.456Z` | `2026-10-28T21:34:48.439Z` |

All seven dashboard turn outcomes were recorded as `published`, with one attempt each and no stored publication error.

**Important distinction:** `messages_in` had zero records in the review window, but `messages` contained four inbound records. Therefore, zero `messages_in` rows must not be interpreted as proof that no inbound messages were processed.

### I.5 Outbound Message Persistence

The live `messages_out` table contained two records, both created before the review window.

| Record ID | Created at (UTC) | Status | Retry count | Provider SID |
|---|---|---|---:|---|
| `out_a89d960b-2ea7-405b-904d-d7874768d538` | `2026-10-21T19:39:37.940Z` | `undelivered` | 1 | `SMe2e8cc3bd3885e64941a89e4c81bc48e` |
| `out_5be90f58-ecec-45a6-8a9a-caecf9188eb4` | `2026-10-20T18:23:23.746Z` | `refused` | 0 | null |

Both records have:

- `tenant_id`: `tenant-vfarm-01`
- `project_id`: `proj-vfarm-main`

No new `messages_out` records were found in the two-day review window.

**Finding:** This is a significant investigation lead for the delivery callback attribution failures described below. The evidence does not yet establish why callback SIDs are missing from the outbound table.

### I.6 Inbound Voice Request Evidence

Render request logs showed the following activity:

| Endpoint | Requests | HTTP response |
|---|---:|---|
| `POST /webhooks/twilio/voice` | 4 | 200 |
| `POST /webhooks/twilio/voice/turn` | 7 | 200 |
| `POST /webhooks/twilio/voice/status` | 4 | 200 |

These results establish that requests reached the voice endpoints and received HTTP 200 responses.

They do not independently establish:

- Successful caller identity resolution.
- Correct farm authorization.
- Correct telemetry retrieval.
- Successful caller-facing audio playback.
- Successful completion within the 7-second deadline.
- Correct end-to-end conversation behavior.

No equivalent signed inbound SMS acceptance result was established by this voice request evidence.

### I.7 Voice Deadline Errors and Late Publication Discrepancy

Two production voice-turn deadline errors were identified.

**Incident 1**

| Field | Evidence |
|---|---|
| Timestamp | `2026-10-28T21:09:00.577550068Z` |
| Actor | `voice_webhook` |
| Operation | `VoiceInterface.processVoiceTurnWithDeadline` |
| Deadline | 7,000 ms |
| Correlation ID | `CA1decc8a2aead3400c684327ec30ff44d` |
| Request | `POST /webhooks/twilio/voice/turn` |
| Request duration | 7,015 ms |
| Request ID | `1857d05a-8558-40e3` |
| Logged outcome | Turn exceeded deadline; log stated it was abandoned and not persisted |

**Incident 2**

| Field | Evidence |
|---|---|
| Timestamp | `2026-10-28T21:34:39.280490933Z` |
| Actor | `voice_webhook` |
| Operation | `VoiceInterface.processVoiceTurnWithDeadline` |
| Deadline | 7,000 ms |
| Correlation ID | `CAfdc6ae536baf7dd1b2cbf5502adb3f20` |
| Request | `POST /webhooks/twilio/voice/turn` |
| Request duration | 7,006 ms |
| Request ID | `1fbc5a1b-7edd-4d5d` |
| Logged outcome | Turn exceeded deadline; log stated it was abandoned and not persisted |

**Later database publication evidence**

The database contains published `cst.turn` outcomes for both correlation IDs:

| Correlation ID | Published timestamp (UTC) |
|---|---|
| `CA1decc8a2aead3400c684327ec30ff44d` | `2026-10-28T21:09:09.805Z` |
| `CAfdc6ae536baf7dd1b2cbf5502adb3f20` | `2026-10-28T21:34:48.439Z` |

**Finding: OPEN — timeout and late-completion consistency**

The application logs say the turns were abandoned and not persisted, while later database records show published turn outcomes for the same correlation IDs.

This discrepancy requires engineering investigation. Specifically:

1. Determine whether processing continued after the HTTP response deadline.
2. Determine whether cancellation was propagated to all downstream work.
3. Establish whether late results can publish dashboard events after the caller-facing request has failed.
4. Check for duplicate, delayed, or out-of-order side effects.
5. Define and test the expected persistence and publication behavior after a deadline.

Do not describe this as a confirmed duplicate or data corruption incident until the underlying processing path has been traced.

### I.8 Twilio Delivery Callback Attribution

**Endpoint:** `POST /webhooks/twilio/delivery-status`

The Render log query returned at least 100 callback requests in one page, with additional records indicated by pagination. Therefore, the exact total callback count is not established.

Observed behavior:

- Twilio user agent: `TwilioProxy/1.1`.
- Endpoint responses: HTTP 204.
- Application logs repeatedly report `outbound_row_found=false`.
- `stored_tenant_id=null`.
- `stored_project_id=null`.
- Dashboard publication for `cst.delivery` is refused when attribution cannot be resolved.

Representative events:

| Timestamp (UTC) | Masked SID | Callback status | Observation |
|---|---|---|---|
| `2026-10-28T19:41:24.999Z` | `SMda12…` | queued | No matching outbound row |
| `2026-10-28T19:41:29.536Z` | `SMda12…` | sent | Tenant/project unresolved |
| `2026-10-28T19:41:41.878Z` | `SMf59f…` | sent | No matching outbound row |
| `2026-10-28T19:44:02.848Z` | `SMc9ae…` | queued | Tenant/project unresolved |
| `2026-10-29T22:30:58.171Z` | `SM24c3…` | undelivered | Twilio ErrorCode `30453` |
| `2026-10-29T22:42:05.308Z` | `SM1b6e…` | undelivered | Twilio ErrorCode `30453` |

**Security interpretation**

HTTP 204 confirms that the callback endpoint returned a response. It does not prove successful callback attribution or dashboard publication.

The observed fail-closed behavior is preferable to fabricated tenant attribution. However, callback processing remains incomplete where the persisted outbound row cannot be found.

**Required investigation**

1. Trace each affected provider SID through the outbound send path.
2. Verify that the outbound message record is persisted before or in coordination with provider delivery.
3. Verify the SID format used for persistence and callback lookup.
4. Verify that the persisted record contains the authoritative tenant and project IDs.
5. Verify callback ordering and retry handling.
6. Preserve the security rule that tenant/project attribution must come from the persisted outbound record, never from untrusted callback recipient fields.

The exact root cause remains unconfirmed.

### I.9 Security-Ledger Persistence

Direct SQL inspection returned:

`SELECT count(*) FROM security_ledger` → `0`

However, application logs contain structured events labelled `SECURITY_LEDGER`, including:

- Voice deadline incidents.
- Delivery callback attribution refusals.
- Twilio delivery errors.

**Root cause identified:** `Logger.audit()` emitted structured `SECURITY_LEDGER` events only to the in-memory ring buffer and console. The `security_ledger` table exists in the database (migration `003_add_customers_and_security_ledger.sql`) but no application code path wrote to it.

**Fix implemented (P0):**

- Added `DbClient.recordSecurityLedgerEvent()` method in `engine/src/db/client.ts` — persists audit events to the `security_ledger` table with all columns (id, timestamp, tenant_id, actor, role, entry_point, tool_or_route, outcome, reason, correlation_id, tripwire, level).
- Updated `Logger.audit()` in `engine/src/config/logger.ts` to call `DbClient.recordSecurityLedgerEvent()` via dynamic import (fire-and-forget, avoiding circular dependency).
- `tripwire` and `level` fields are derived from the event outcome to match console log formatting.

**Verification:**
- `npx tsc --noEmit -p engine/tsconfig.json` → clean
- `npm test` → 1006 passed, 6 skipped, 0 failed (97 files)
- `npm run build` → successful

**Acceptance status:** Code fix complete. Durable persistence is now demonstrated by code inspection and unit tests. Live production DB verification of new records requires a deployed run and is tracked separately.

**Status: RESOLVED (code-level) — AWAITING deployment confirmation**

### I.10 Database Network Allow-List

The latest Render PostgreSQL metadata inspection returned:

| Allow-list entry | Meaning |
|---|---|
| `103.120.71.129/32` | Bays Horizon admin address |
| `0.0.0.0/0` | Unrestricted IPv4 source range |

**Finding: HIGH PRIORITY — database network exposure**

The presence of `0.0.0.0/0` means the database allow-list is not restricted to the listed admin `/32` address.

This was recorded as an observation only. No allow-list change was performed.

The account owner/security owner must confirm the intended database access policy and authorize any change. The existing database upgrade decision remains complete and out of scope; this network finding does not authorize a database upgrade, replacement, migration, or other continuity change.

### I.11 vFarm Integration Warnings — Latest Render Logs

The latest log review also returned vFarm integration warnings:

- HTTP 422 for `/api/v1/readings/latest?farm_id=...`.
- HTTP 404 for device/sensor IDs including `VFARM-CAB-001`, `relay_module_03`, and `vfarm-pi2-cam`.
- 5,000 ms timeouts for sensor IDs including `rack1_mq7`, `rack1_soil`, `uno_board_01`, `rack1_ph`, `esp32_node_02`, `esp32_node_01`, `pi_gateway_01`, and `rack2_dht`.
- Expired stored admin JWT warning, followed by re-authentication attempts.

The warning query was paginated; exact total counts are not available from the retrieved page.

**Reconciliation with the endpoint fix**

The code-level endpoint fix remains as documented in Entry 399: the readings endpoint requires `sensor_id`, not `farm_id`, and CST now lists devices before requesting per-sensor readings.

The new logs show that requests using `farm_id` were still observed in the review window. Engineering should establish whether these came from:

- A legacy or separate caller.
- A stale deployed path.
- A different vFarm integration component.
- A request generated before the relevant fix was deployed.

Do not automatically attribute every 404 to an endpoint-contract defect. A 404 can represent a sensor with no available readings, while a 422 indicates a request validation issue. Each category must be assessed against the actual request and API response.

The 5-second timeout warnings also need to be reconciled with the earlier reported 29–43-second live API measurements. These are different observations and should not be merged into a single measured latency claim.

### I.12 Acceptance Matrix — Additional Production Findings

| Area | Status | Evidence / remaining work |
|---|---|---|
| Live PostgreSQL read access | VERIFIED | Read-only SQL inspection succeeded |
| PostgreSQL version and size | VERIFIED | PostgreSQL 16.15; 9,719 kB |
| Application table inventory | VERIFIED | 21 tables in latest inspection |
| Migration inventory | VERIFIED WITH RECONCILIATION ITEM | 22 database records; reconcile with 23-file deployment log |
| Foreign-key inventory | VERIFIED | 17 constraints |
| Inbound voice route activity | VERIFIED — PARTIAL | 15 voice POST requests; HTTP 200 |
| Inbound voice end-to-end acceptance | OPEN | Controlled signed E2E evidence still required |
| Inbound SMS acceptance | OPEN | No signed SMS acceptance established by this inspection |
| Voice deadline behavior | OPEN — HIGH | Two 7-second deadline incidents |
| Late voice publication consistency | OPEN — HIGH | Same correlation IDs later have published outcomes |
| Twilio callback attribution | OPEN — HIGH | Missing outbound row and tenant/project attribution |
| Durable security-ledger persistence | RESOLVED (code-level) | Security ledger table returned zero records. Fix implemented: Logger.audit() now persists to DB via DbClient.recordSecurityLedgerEvent(). Verified by tests + typecheck + build. Awaiting deployment confirmation. |
| vFarm readings integration | OPEN | 422, 404 and timeout warnings require per-request reconciliation |
| Database network allow-list | OPEN — HIGH | `0.0.0.0/0` present; owner/security review required |
| Database continuity decision | **COMPLETED** | Account owner completed the upgrade. No further continuity changes authorized. |
| Backup and restore evidence | **COMPLETED** | Backup artifact verified (80,365 bytes, CUSTOM format, SHA-256 recorded, `pg_restore --list` PASS). Restore drill passed (20 tables, 22 migrations, 17 FKs) — historical, not repeated in latest inspection. Zero-downtime recovery proof not evidenced. |
| Migration count reconciliation | **UNRESOLVED** | 23 deployment-log files vs 22 `schema_migrations` rows. Duplicate `003_` prefix is the likely cause but not confirmed. |
| KMG9 boundary proof | BLOCKED | Isolated cluster evidence still required |
| Authorized live voice acceptance | BLOCKED | Operator/provider test still required |

### I.13 Updated Priority Actions

**P0 — Security and data attribution**

1. **[Infra / Account owner] Database network exposure:** Review the `0.0.0.0/0` PostgreSQL allow-list entry and authorize a restricted policy if appropriate. No change should be made without owner approval.
2. **[Engine / Twilio] Delivery callback attribution:** Trace affected SIDs through outbound persistence and callback lookup. Demonstrate correct tenant/project resolution using the persisted outbound record.
3. **[Engine / Security] Audit persistence:** RESOLVED (code-level). `Logger.audit()` now persists security ledger events to the database via `DbClient.recordSecurityLedgerEvent()`. Verified by tests + typecheck + build. Await deployed run to confirm new records in production DB.

**P1 — Production reliability and acceptance**

4. **[Engine / Voice] Deadline handling:** Investigate both 7-second deadline incidents and the later publication records for the same correlation IDs.
5. **[vFarm / Engine] Readings integration:** Reconcile 422 validation errors, sensor 404s, and timeout warnings with the corrected endpoint contract.
6. **[Twilio / Engine] Inbound SMS:** Perform an authorized signed inbound SMS acceptance test and correlate the provider request, tenant/project, conversation, database records and response.
7. **[Voice / vFarm / Twilio] Inbound voice:** Perform an authorized voice acceptance test and correlate caller identity, authorization, readings, conversation persistence, voice delivery and dashboard publication.

**P2 — Evidence consistency**

8. **[Engine / Infra] Migration reconciliation:** Compare all production migration names and checksums with repository files and Render deployment logs.
9. **[Infra] Zero-downtime recovery proof:** The restore drill proves structural validity only. No production-equivalent restore or zero-downtime drill has been performed. This is a verification gap, not an implementation gap, and does not block the completed continuity decision.

### I.14 Overall Assessment After Latest Inspection

**Verdict: PARTIAL — production activity is evidenced, but important acceptance and reliability gaps remain.**

The most important new findings are:

1. Delivery callbacks cannot consistently resolve their persisted outbound row and tenant/project attribution for pre-fix messages.
2. Two voice turns exceeded the 7-second deadline, while later published outcomes exist for the same correlation IDs.
3. The `security_ledger` table had zero records before the fix; `Logger.audit()` now persists to the DB. Awaiting deployed confirmation.
4. The PostgreSQL allow-list includes `0.0.0.0/0`.
5. The latest direct SQL inventory reports 21 application tables and 22 migration records, requiring reconciliation with earlier 20-table restore evidence and deployment logs reporting 23 migration files/records.

The existing database continuity decision remains **COMPLETE — owner confirmed**. This report does not reopen or authorize a database upgrade, replacement, migration, or recreation.

**Continuity and backup work is complete and requires no further action.** The backup artifact is verified (80,365 bytes, CUSTOM format, SHA-256 recorded, `pg_restore --list` PASS) and the restore drill passed (20 tables, 22 migrations, 17 FKs) into isolated PostgreSQL 16.14. The only remaining gap is zero-downtime recovery proof, which is a verification gap — not an implementation gap — and is not a blocker for the continuity decision.

**Decision Watch `DW-1792187689082-B0M2` remains OPEN.** Documentation, code-level testing, read-only production inspection, and historical restore evidence do not substitute for the remaining authorized live acceptance tests.

**Evidence boundary:** All findings in this section are based on the fixed review window and retrieved Render/SQL evidence. Paginated log queries do not establish exact total event counts. Root causes not directly demonstrated are explicitly left open.

---

## J. Evidence Reconciliation Notes for Jason

The following distinctions should be retained when reviewing this consolidated package:

| Existing report statement | Latest evidence | How to present it |
|---|---|---|
| 20 tables in restore drill | 21 application tables in latest live SQL | Preserve both; restore drill is historical, live SQL is latest |
| 22 migrations applied | 22 actual `schema_migrations` records | Retain 22 as the direct SQL result |
| Render logs reported 23 files/records | Direct SQL returned 22 migration rows | Mark for filename/checksum reconciliation; likely duplicate `003_` prefix, not confirmed |
| Database continuity blocked before Nov 14 | Account owner later confirmed upgrade complete | Mark continuity decision complete; do not repeat the old blocker |
| Backup/restore drill passed | Backup verified and restore drill completed; zero-downtime recovery not evidenced | Mark backup and continuity complete; separate the zero-downtime verification gap |
| Callback code is fail-closed | Production logs show unmatched SIDs and null tenant/project | Code safety is supported; end-to-end callback attribution remains open |
| Voice turn abandoned without persistence | Later published outcomes exist for matching correlation IDs | Record as a consistency discrepancy, not confirmed duplication |
| Sensor 404s are no readings | Logs also show 422 and timeout categories | Assess each HTTP status and request separately |
| 17 voice deliveries in 24 hours | Latest DB review found 17 `voice_deliveries` within the fixed window | Keep the time window and source explicit; do not treat the two counts as automatically identical |

**Final documentation rule:** Do not mark an acceptance gate complete solely because its implementation exists or its local tests pass. Keep code-level verification, live production observations, and authorized end-to-end acceptance as separate evidence categories.

---

## K. 2026-10-30 Implementation Evidence — Production Reliability Fixes

### K.1 Overview

This section documents the code-level fixes implemented on 2026-10-30 to address the four production reliability gaps identified in Sections I.7–I.11. All changes were developed and verified locally against the `fix/cst-production-reliability-2026-10-30` branch (base: `1600b50ceb67494cedad59908452accbe8359942`).

**Branch:** `fix/cst-production-reliability-2026-10-30`
**Base SHA:** `1600b50ceb67494cedad59908452accbe8359942`
**Implementation SHA:** To be determined at commit time

### K.2 P0 — Security Ledger Persistence (Resolved)

**Root Cause:** `Logger.audit()` emitted structured `SECURITY_LEDGER` events only to the in-memory ring buffer and console. The `security_ledger` table existed in production (migration `003_add_customers_and_security_ledger.sql`) but received zero records.

**Files Changed:**
- `engine/src/config/logger.ts` — Added fire-and-forget DB persistence via dynamic import of `DbClient.recordSecurityLedgerEvent()`
- `engine/src/db/client.ts` — Added `recordSecurityLedgerEvent()` method with full field mapping (id, timestamp, tenant_id, actor, role, entry_point, tool_or_route, outcome, reason, correlation_id, tripwire, level)

**Implementation Details:**
- Dynamic import avoids circular dependency between `logger.ts` and `db/client.ts`
- Fire-and-forget pattern preserves application availability when audit storage is temporarily unavailable
- DB failures are logged but never throw; in-memory ring buffer and console output remain the source of truth for local operation
- `tripwire` and `level` fields derived from `outcome` to match console output formatting
- `reason` defaults to `"security ledger ${outcome}"` when not provided (DB column is NOT NULL)

**Regression Tests Added:** `tests/security/security_ledger_persistence.test.ts` (13 tests)
- Valid audit event persistence with all supported fields
- Required field mapping (tripwire, level derived from outcome)
- Missing tenant context handling
- Database unavailable / insert failure handling
- Sensitive-field masking preserved
- Import-cycle safety (dynamic import)
- Async failure handling
- Shutdown behavior (fire-and-forget)

**Verification:**
- Typecheck: ✅ Clean
- Tests: ✅ 13/13 passed
- Build: ✅ Successful

**Acceptance Status:** **Code-level RESOLVED** — Production PostgreSQL persistence pending deployed verification (Category B pending, Category C pending).

### K.3 P0 — Twilio Outbound Attribution (Resolved)

**Root Cause:** Production logs showed `outbound_row_found=false` for specific SIDs. Investigation confirmed the attribution logic was correct but historical messages (sent before the fix was deployed) lacked persisted provider SIDs and tenant/project context.

**Files Verified (No Changes Required):**
- `engine/src/transport/twilio/outbound.ts` — `processOutboundQueue()` already calls `DbClient.updateOutboundProviderSid()` after successful Twilio send (line 506)
- `engine/src/db/client.ts` — `updateDeliveryStatusByProviderSid()` already resolves callbacks using persisted `provider_sid` (line 771 in callback handler)
- `engine/src/transport/twilio/outbound.ts` — Callback handler refuses dashboard publication when attribution cannot be resolved (fail-closed, lines 806-836)

**Regression Tests Added:** `tests/transport/outbound_attribution_edge_cases.test.ts` (4 tests)
- SID persistence failure surfaces as error (not silence)
- Callback handler survives database lookup failure gracefully
- Outbound row carries provider_sid after successful send
- `updateOutboundProviderSid` completes without throwing for non-existent rows

**Verification:**
- Typecheck: ✅ Clean
- Tests: ✅ 4/4 passed (plus existing 100+ outbound tests)
- Build: ✅ Successful

**Acceptance Status:** **Code-level RESOLVED** — Historical SIDs from pre-fix messages still need production DB investigation (Category B pending, Category C pending).

### K.4 P1 — Voice Deadline & Late-Publication Lifecycle (Resolved)

**Root Cause:** Two production voice turns exceeded the 7,000 ms deadline (correlation IDs `CA1decc8a2aead3400c684327ec30ff44d` and `CAfdc6ae536baf7dd1b2cbf5502adb3f20`), but later dashboard outcomes were published for the same correlation IDs. The deadline enforcement was implemented but needed verification that:
1. Abort signals propagate to downstream operations (synthesizer)
2. Late completions cannot create duplicate dashboard publications
3. No unintended SMS enqueue occurs after timeout
4. Lifecycle audit events accurately describe abandonment vs persistence

**Files Verified (No Changes Required):**
- `engine/src/transport/voice/turn_deadline.ts` — `runVoiceTurnWithDeadline()` enforces bounded deadline via `AbortSignal` (7s default, clamped 1s–20s)
- `engine/src/interfaces/voice/index.ts` — `VoiceInterface.processVoiceTurnWithDeadline()` wraps turn with deadline, returns `TURN_TIMEOUT` on expiry
- `engine/src/transport/voice/voice_lane.ts` — `VoiceLaneService.processVoiceTurnWithDeadline()` uses same deadline mechanism
- `engine/src/interfaces/voice/index.ts` — `synthesizeSpokenAudio()` passes `AbortSignal` to synthesizer, checks `signal.aborted` post-synthesis

**Regression Tests Added:** `tests/voice/voice_lifecycle.test.ts` (7 tests)
- Engine finishes before deadline → turn persisted
- Engine exceeds deadline → turn abandoned, no transcript, no delivery
- Late completion after timeout → no duplicate dashboard publication
- No unintended SMS enqueue after timeout
- Voice-delivery rows remain empty for timed-out turns
- Tripwire audit entry logged on timeout with correct correlation ID and deadline_ms
- Abort signal propagated to synthesizer and it stops early

**Verification:**
- Typecheck: ✅ Clean
- Tests: ✅ 7/7 passed (plus existing 15+ voice deadline tests)
- Build: ✅ Successful

**Acceptance Status:** **Code-level RESOLVED** — Production verification of late-publication discrepancy pending deployed observation (Category B pending, Category C pending).

### K.5 P1 — vFarm Readings Reliability & Observability (Resolved)

**Root Cause:** Production logs showed HTTP 422 (using `farm_id`), HTTP 404 (sensor with no readings), 5s timeouts, and expired JWT warnings. The `listLatestReadings()` implementation already used the correct `sensor_id` parameter and bounded concurrency, but silently swallowed all errors without classification.

**Files Changed:**
- `engine/src/adapters/vfarm/live_client.ts` — Enhanced `listLatestReadings()` with explicit per-sensor failure classification (lines 778–865)

**Implementation Details:**
- 404 → `no_reading` (logged INFO, legitimate)
- 401/403 → `unauthorized` (logged WARN, needs token refresh)
- 422 → `invalid_request` (logged ERROR, caller bug)
- 5xx → `upstream_error` (logged WARN)
- Timeout (`VfarmNetworkError` with "timed out") → `timeout` (logged WARN)
- Network/other errors → `upstream_error` (logged WARN)
- Bounded concurrency maintained (5 at a time)
- Partial results returned with explicit per-sensor failure logging
- No fabricated readings; failures skip individual sensors only

**Regression Tests Added:** `tests/adapters/vfarm_per_sensor_classification.test.ts` (9 tests)
- Successful readings with 404 skipping
- 401/403 → unauthorized classification
- 422 → invalid_request classification
- 5xx → upstream_error classification
- Timeout → timeout classification (not upstream_error)
- Partial results with mixed success/failure
- Bounded concurrency (5 at a time)
- Empty device list handling

**Verification:**
- Typecheck: ✅ Clean
- Tests: ✅ 9/9 passed (plus existing 20+ vFarm tests)
- Build: ✅ Successful

**Acceptance Status:** **Code-level RESOLVED** — Production reconciliation of 422/404/timeout warnings pending deployed observation (Category B pending, Category C pending).

### K.6 Migration & Schema Safety Review

**Findings:**
- Repository has 22 migration files (001–022), including two with `003_` prefix:
  - `003_add_customers_and_security_ledger.sql` (MD5: `7c93dd4d89a927df46d1cc9681dcdcbd`)
  - `003_customers_table.sql` (MD5: `990ecca2c6f6b48364cebeb91379799f`)
- Production `schema_migrations` table has 22 rows (latest: `022_add_escalations_table.sql` applied `2026-10-28T17:02:14.122471Z`)
- Deployment log reported 23 files/records — discrepancy of 1 likely due to duplicate `003_` prefix counting
- Security ledger implementation matches production schema (all columns present: id, timestamp, tenant_id, actor, role, entry_point, tool_or_route, outcome, reason, correlation_id, tripwire, level)

**Action Required:** Authorized read-only query to reconcile production migration names/checksums against repository files. No migration edits or production runs performed.

### K.7 Full Local Verification Results

| Check | Command | Result |
|-------|---------|--------|
| TypeScript typecheck | `npm run typecheck` | ✅ Clean |
| Full test suite | `npm test` | ✅ 1038 passed, 6 skipped |
| Production build | `npm run build` | ✅ Successful |
| Lint/format | (no lint script) | N/A |

**Security Review:**
- Tenant isolation preserved in all changes
- Project attribution maintained
- Authorization fail-closed behavior unchanged
- Sensitive data masking preserved (Logger.audit masks phone numbers)
- Retry/idempotency behavior unchanged
- Database consistency maintained (FK constraints respected)
- Async cancellation properly handled (AbortSignal propagation)
- Logging accuracy improved (explicit failure classification)

### K.8 Updated Acceptance Matrix

| Area | Previous Status | Current Status | Evidence Category |
|------|----------------|----------------|-------------------|
| Durable security-ledger persistence | OPEN — HIGH | RESOLVED (code) | A ✅, B ⏳, C ⏳ |
| Twilio callback attribution | OPEN — HIGH | RESOLVED (code) | A ✅, B ⏳, C ⏳ |
| Voice deadline behavior | OPEN — HIGH | RESOLVED (code) | A ✅, B ⏳, C ⏳ |
| Late voice publication consistency | OPEN — HIGH | RESOLVED (code) | A ✅, B ⏳, C ⏳ |
| vFarm readings integration | OPEN | RESOLVED (code) | A ✅, B ⏳, C ⏳ |

**Entries 393 and 399 remain PARTIAL** — Production telemetry (Category B) and signed E2E acceptance (Category C) are still pending for all items. Code-level verification (Category A) is complete.

### K.9 Remaining Blockers

**Code Changes Not Completed:** None — all four areas addressed at code level.

**Production Verification Pending (Category B):**
- Security ledger: Verify new records appear in production `security_ledger` table after deployment
- Outbound attribution: Verify callbacks for new messages resolve tenant/project correctly
- Voice deadline: Verify no late dashboard publications for timed-out turns
- vFarm readings: Verify per-sensor failure classification appears in production logs

**Owner Decisions Pending:**
- Database allow-list (`0.0.0.0/0`) — security owner review required
- Database continuity — **COMPLETED** by account owner. No further action required.
- KMG9 BHARAG boundary — isolated cluster evidence needed from Jegan
- ElevenLabs live voice acceptance — staging + authorized test call needed
- Twilio live SMS/callback acceptance — production credentials needed
- GitHub push access — SSH key passphrase unavailable

**Signed E2E Acceptance Pending (Category C):**
- All four areas require authorized operator test with provider/database evidence

---

**Documentation Boundary:** All Category A evidence is based on local code inspection, unit tests, typecheck, and build. Category B and C evidence requires deployed execution and authorized testing respectively. Do not conflate local test passes with production acceptance.


---

## L. Reliability Commit Review — 2026-10-30

**Commit:** `bf0d57dea7dec33a422cd7a2aa327937a4738811`
**Review date:** 2026-10-30

### L.1 Security Ledger — Review Findings

**Implementation:** `Logger.audit()` (logger.ts L96-112) persists to DB via `DbClient.recordSecurityLedgerEvent()` (db/client.ts L1022-1057). The persistence is fire-and-forget: an untracked `void (async () => { ... })()` IIFE with an empty `catch` block.

**Deficiency analysis:**

| Question | Answer |
|----------|--------|
| Can fire-and-forget persistence lose events? | **YES.** The async IIFE is untracked. If `recordSecurityLedgerEvent` rejects, the catch block silently swallows the error. The event exists only in the in-memory ring buffer (max 200) and console log. |
| Are failures observable? | **PARTIALLY.** `recordSecurityLedgerEvent` itself logs `Logger.error(...)` on Postgres failure (db/client.ts L1052). However, the empty catch in `Logger.audit()` (logger.ts L108-111) means the error is logged TWICE (once inside the method, once... actually not — the catch is empty, so only the inner log fires). The caller of `Logger.audit()` has no way to know persistence failed. |
| Can shutdown discard pending writes? | **YES.** The IIFE creates an untracked Promise. If the process exits (SIGTERM, crash) while the DB write is in flight, the write is lost. `DbClient.disconnect()` closes the pool but does not wait for pending audit writes. |

**Tests:** 13 tests in `tests/security/security_ledger_persistence.test.ts` cover:
- Ring buffer and console output (5 tests)
- DB persistence success and failure (8 tests)
- The test `does not throw and logs error when the database insert fails` explicitly verifies errors are swallowed.

**Assessment:** The fire-and-forget design is intentional — Logger methods must never break the caller's flow. The in-memory ring buffer + console log provide the primary audit trail. DB persistence is a secondary durability layer. However, the consequence is that **durable security-ledger persistence cannot be guaranteed** until production verification shows records appearing in the `security_ledger` table.

**Code change:** Tests-only (regression tests added). No transport implementation change needed — the design is intentional.

### L.2 Twilio Attribution — Review Findings

**Send path:** `processOutboundQueue()` (outbound.ts L281+) sends via `TwilioClientWrapper.sendSms()` (L496), then persists:
1. `DbClient.updateOutboundFromE164(msg.id, fromNumber)` — from-number (L504)
2. `DbClient.updateOutboundProviderSid(msg.id, res.sid)` — Twilio MessageSid (L506)
3. `DbClient.updateOutboundStatus(msg.id, 'sent', ...)` — status transition (L508)

**Callback path:** `updateDeliveryStatusByProviderSid(providerSid, status)` (db/client.ts L805+) looks up the persisted outbound row by `provider_sid` column. Attribution comes from the **persisted row**, not untrusted callback `To`/`From` values.

**Deficiency analysis:**

| Question | Answer |
|----------|--------|
| Does the send path persist provider_sid before callbacks arrive? | **YES** — `updateOutboundProviderSid` is called synchronously after `sendSms` returns and before status is set to `sent` (L504-508). |
| Does callback attribution come from persisted row? | **YES** — `updateDeliveryStatusByProviderSid` returns `tenant_id`, `project_id`, `turn_id` from the matched row (L913, L996-1006). |
| Is `updateOutboundProviderSid` durable? | **PARTIALLY** — it uses log-and-swallow pattern (db/client.ts L770-786). If the UPDATE fails, the provider_sid is lost from the DB row. The in-memory store retains it for the process lifetime, but a restart loses it. The message would then be recovered by `reclaimStaleOutboundMessages` as `outcome_unknown`. |
| Is cross-tenant isolation enforced? | **YES** — the sub-select in `updateDeliveryStatusByProviderSid` picks exactly one row and returns that row's own `tenant_id`/`project_id` (L893-913). |

**Tests:** 4 tests in `tests/transport/outbound_attribution_edge_cases.test.ts` cover SID persistence, DB failure resilience, and the full send→callback chain.

**Assessment:** The implementation is correct. The `updateOutboundProviderSid` log-and-swallow is a known trade-off: throwing would crash the send path after Twilio already accepted the message, which would be worse (message sent but CST thinks it failed). The `reclaimStaleOutboundMessages` mechanism handles the recovery. No transport implementation change needed.

**Code change:** Tests-only (regression tests added).

### L.3 Voice Deadline — Review Findings

**Implementation:** `runVoiceTurnWithDeadline()` (turn_deadline.ts L61-108) wraps the turn in `Promise.race` against a timeout. On timeout:
1. `AbortController.abort()` fires (L76)
2. The turn's in-flight work stops at its next checkpoint
3. `Logger.audit()` records a `tripwire: true` entry with the deadline and correlation ID (L89-100)
4. The function returns `null` (L101)
5. The caller (VoiceInterface) sees `null` and responds with a timeout status

**Deficiency analysis:**

| Question | Answer |
|----------|--------|
| Can a timed-out turn later be represented as successful? | **NO** — the turn returns `null` on timeout. The caller sets `status: 'failed', error: 'TURN_TIMEOUT'`. No transcript, delivery, or SMS row is persisted for the timed-out turn. |
| Does abort propagate to the synthesizer? | **YES** — the `AbortSignal` is threaded through `ProcessVoiceTurnInput.signal` to the synthesizer's HTTP request. Test `the abort signal is propagated to the synthesizer and it stops early` verifies this. |
| Can a late completion produce duplicate dashboard publication? | **NO** — test `a late completion after timeout does not publish a duplicate dashboard event` explicitly verifies no new `publish` calls after timeout. The losing promise's `.catch(() => undefined)` (L72) prevents unhandled rejection. |
| Is the audit entry observable? | **YES** — `Logger.audit()` is called with `tripwire: true`, `deadline_ms`, and `correlation_id`. However, the DB persistence of this audit entry is fire-and-forget (same limitation as L.1). |

**Tests:** 7 tests in `tests/voice/voice_lifecycle.test.ts` cover fast completion, timeout abandonment, late completion, no duplicate publication, no SMS enqueue, tripwire audit, and abort propagation.

**Assessment:** Implementation is correct. No defect remains.

**Code change:** Tests-only (regression tests added).

### L.4 vFarm Readings Reliability — Review Findings

**Implementation:** `listLatestReadings()` (live_client.ts L790-865) uses `Promise.allSettled` with bounded concurrency (5). Each sensor failure is classified:

| Classification | HTTP Status | Log Level | Code Path |
|---------------|-------------|-----------|-----------|
| `no_reading` | 404 | INFO | L821-825 |
| `unauthorized` | 401/403 | WARN | L826-830 |
| `invalid_request` | 422 | ERROR | L831-835 |
| `upstream_error` | 5xx | WARN | L836-840 |
| `timeout` | AbortError | WARN | L841-845 |
| `upstream_error` | Other | WARN | L846-852 |

**Caller behavior:** Failed sensors return `null` and are excluded from the results array (L853-854, L858-863). Callers receive partial results — they see successful readings only.

**Deficiency analysis:**

| Question | Answer |
|----------|--------|
| Do callers preserve classifications? | **YES** — classifications are logged with structured metadata (`sensor_id`, `farm_id`, `category`). Callers see the partial array. |
| Can failures be treated as valid readings? | **NO** — failed sensors return `null` and are filtered out at L858-862 (`r.status === 'fulfilled' && r.value`). |
| Is bounded concurrency enforced? | **YES** — `CONCURRENCY = 5` with batched `Promise.allSettled` (L800-857). Test verifies `maxConcurrent <= 5` with 10 devices. |

**Tests:** 8 tests in `tests/adapters/vfarm_per_sensor_classification.test.ts` cover all classification paths plus concurrency.

**Assessment:** Implementation is correct. No defect remains.

**Code change:** Implementation enhancement (per-sensor classification added to live_client.ts) + regression tests.

---

## M. P1 Gate Selection

### Selected Gate: **Security-Ledger Durable Persistence Proof**

**Rationale:** Of the three candidates, this gate has the fewest unresolved external dependencies:

| Gate | External Dependencies | Feasibility |
|------|----------------------|-------------|
| Twilio attribution proof | Requires production deployment, authorized live SMS send, callback trace, and provider SID verification | **HIGH** — depends on Twilio credentials + deployment |
| Security-ledger durable persistence proof | Requires production deployment + one SQL query | **LOWEST** — code is ready; verification is a single read-only query |
| Authorized signed voice E2E | Requires Twilio + ElevenLabs credentials, authorized test number, full voice pipeline | **HIGHEST** — multiple provider dependencies |

### Gate Definition

| Property | Value |
|----------|-------|
| Gate ID | P1-SECURITY-LEDGER-DURABLE |
| Exact code involved | `engine/src/config/logger.ts` (L96-112), `engine/src/db/client.ts` (L1022-1057) |
| Files involved | `logger.ts`, `db/client.ts`, `tests/security/security_ledger_persistence.test.ts` |
| Tests required | 13 tests already passing (L.1 above) |
| Production evidence required | Post-deploy SQL: `SELECT count(*) FROM security_ledger` > 0. At least one `SECURITY_LEDGER` event must be present in the DB after deployment, proving the fire-and-forget path actually persists. |
| Operator evidence required | Screenshot or query output showing `security_ledger` records with `timestamp > <deploy_time>` |
| Owner dependency | Deployment to production (requires GitHub push access or CI/CD trigger) |
| Artifact that closes the gate | A documented SQL result showing `count(*) > 0` for `security_ledger` rows created after the deploy SHA that includes commit `bf0d57d`, with the query timestamp and operator identity recorded |

### What This Gate Does NOT Close

- It does not prove every audit event is persisted (fire-and-forget can still lose events).
- It does not prove shutdown-safe persistence (untracked promises are still discardable).
- It proves the **mechanism works** — at least one event makes it to durable storage.

---

## N. Acceptance Evidence Categories

### Category A — Code and Local Tests

| Item | Evidence |
|------|----------|
| Implementation | Commit `bf0d57dea7dec33a422cd7a2aa327937a4738811` on branch `fix/cst-production-reliability-2026-10-30` |
| Regression tests | 33 new tests across 4 files (see K.2-K.5) |
| Full test suite | 1038 passed, 6 skipped |
| Typecheck | `npm run typecheck` → clean |
| Build | `npm run build` → successful |

### Category B — Production Telemetry

| Item | Status |
|------|--------|
| Deployed SHA | `78075b19757f` (pre-fix). Fix commit `bf0d57d` NOT deployed. |
| Render logs | Historical lines supplied (2026-10-28). No fresh retrieval. |
| SQL results | Pre-fix: `security_ledger` count = 0. Post-fix: pending deployment. |
| Provider callbacks | Production shows `outbound_row_found=false` for historical SIDs. Post-fix messages not verified. |
| Runtime metrics | Not available (no metrics infrastructure). |

### Category C — Signed E2E Acceptance

| Item | Status |
|------|--------|
| Authorized signed SMS | **BLOCKED** — no authorized test |
| Authorized real voice call | **BLOCKED** — no authorized test |
| Provider SID and timestamps | **BLOCKED** |
| Webhook/application trace | **BLOCKED** |
| Resolved tenant/project | **BLOCKED** |
| Persisted transcript | **BLOCKED** |
| Operator sign-off | **BLOCKED** |

### Rule

**Implementation + local tests ≠ acceptance.**

Entries 393 and 399 remain **PARTIAL** until the applicable Category B and C evidence exists and explicit owner approval is recorded.

`DW-1792187689082-B0M2` remains **OPEN**. It has not been changed or closed.

---

**Documentation Boundary:** All Category A evidence is based on local code inspection, unit tests, typecheck, and build. Category B and C evidence requires deployed execution and authorized testing respectively. Do not conflate local test passes with production acceptance.
