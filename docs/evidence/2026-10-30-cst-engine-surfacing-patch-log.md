# CST — Engine Surfacing Patch Log

**Date:** 2026-10-30
**Branch:** `fix/cst-production-reliability-2026-10-30`
**Commit:** `bf0d57dea7dec33a422cd7a2aa327937a4738811`
**Purpose:** Document the Monitoring Twin signals, Research Twin escalation rules, and Front Door commercial promises for the production reliability fixes implemented in this branch.

---

## A. Monitoring Twin — vFarm Contract and Signals

### vFarm Readings Contract

| Property | Value |
|----------|-------|
| Route | `GET /api/v1/readings/latest?sensor_id=<device_id>` |
| Query parameter | `sensor_id` (string, required) — **NOT** `farm_id` |
| Caller | `engine/src/adapters/vfarm/live_client.ts` |
| Function | `listLatestReadings(farmId, limit?, timeoutMs?)` |
| Timeout | `5000 ms` (via `VFARM_DEFAULT_TIMEOUT_MS`) |
| Concurrency | Bounded at 5 concurrent per-device requests |

### Observed Sensor/Device Identifiers

`VFARM-CAB-001`, `relay_module_03`, `vfarm-pi2-cam`, `rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`, `pi_gateway_01`, `uno_board_01`, `esp32_node_01`, `esp32_node_02`

### Per-Signal Monitoring Table

| # | Signal | Source Code Path / Endpoint | Expected Behavior | Failure Classification | Available Evidence | Missing Evidence | Status |
|---|--------|----------------------------|-------------------|------------------------|-------------------|------------------|--------|
| 1 | Missing/null readings per `sensor_id` | `live_client.ts:listLatestReadings` → `GET /api/v1/readings/latest?sensor_id=` (L808-817) | Each device ID is passed as `sensor_id`. A 404 means the sensor exists but has no readings — a legitimate data gap. The reading is skipped; no fabricated value is returned. | `no_reading` (legitimate 404) | Render logs (2026-10-28): 404 for `VFARM-CAB-001`, `relay_m3_1`. Per-sensor classification test: `vfarm_per_sensor_classification.test.ts` | Correlation ID not logged in 404 path. No post-deploy verification. | **Partially implemented** — logged as INFO with category `no_reading` (L822-825). Not deployed. |
| 2 | HTTP 404 rate per sensor/farm | `live_client.ts` catch block (L821-825) | 404 is treated as "sensor exists, no readings". Classified and logged at INFO level. Sensor skipped in aggregated result. | `no_reading` | Supplied Render log lines: `2026-10-28T21:34:32.840Z WARN vFarm HTTP 404 from /api/v1/readings/latest?sensor_id=VFARM-CAB-001` and `sensor_id=relay_m3_1`. These lines do NOT contain correlation IDs. | Correlation ID not propagated to log line. Raw logs rotated. | **Partially implemented** — classification code exists; logging present but no correlation ID. |
| 3 | HTTP 422 rate per sensor/farm | `live_client.ts` catch block (L831-835) | 422 means the request was structurally invalid (e.g., missing `sensor_id`). Classified as `invalid_request`. Logged at ERROR level. Never converted to a valid reading. | `invalid_request` | Historical log summary (requests using `farm_id` param). Fixed by switching to `sensor_id`. | Raw 422 logs rotated. No correlation ID in error log line. | **Partially implemented** — logged as ERROR with category `invalid_request`. |
| 4 | Upstream timeout at 5000 ms | `live_client.ts` catch block (L841-845) → timeout detected via `VfarmNetworkError` + `/timed out/` | Timeout is classified and logged at WARN level. Sensor reading is skipped. No stale or partial data returned as current. | `timeout` | Supplied Render log lines: `2026-10-28T21:34:38.253Z WARN vFarm request timed out after 5000ms: ...sensor_id=rack1_mq7`, `2026-10-28T21:34:43.254Z WARN vFarm request timed out after 5000ms: ...sensor_id=rack1_soil`. These lines do NOT contain correlation IDs. | Correlation ID not in timeout log line. | **Partially implemented** — classification code exists. |
| 5 | vFarm JWT expiry / 401-403 | `live_client.ts` catch block (L826-830) | 401/403 is classified as `unauthorized`. Logged at WARN level. Indicates token refresh is needed. | `unauthorized` | Log warnings observed during review. | Correlation ID and sensor context not consistently logged. | **Partially implemented** — logged as WARN with category `unauthorized`. |
| 6 | Per-sensor failure classification (all categories) | `live_client.ts:listLatestReadings` (L818-855) | Each per-sensor failure is classified into one of: `no_reading`, `unauthorized`, `invalid_request`, `upstream_error`, `timeout`. Logged at appropriate severity. Failed sensors do not appear in the results array. | See categories above | 8 regression tests in `vfarm_per_sensor_classification.test.ts` covering all categories | Post-deploy production log verification | **Implemented (code-level)** — tests pass. Not deployed. |
| 7 | Twilio delivery callbacks with unresolved outbound rows | `/webhooks/twilio/delivery-status` → `DbClient.updateDeliveryStatusByProviderSid` (db/client.ts L805-1007) | Callback arrives with a `MessageSid`. The handler looks up the persisted outbound row by `provider_sid`. If no row is found, attribution fails. The handler logs a WARN and records a security ledger `refused` event. No fabricated tenant/project attribution. | `attribution_unresolved` | Verbatim Render log excerpts in `docs/evidence/2026-10-29-render-live-evidence-entry-399.md`. Security ledger JSON with `reason: cst.delivery_attribution_unresolved`. | Root cause for historical SIDs not traced (pre-fix messages). Correlation IDs are masked SIDs; no turn_id. | **Implemented** — fail-closed, no fabricated attribution. |
| 8 | Twilio callbacks with tenant/project null | Same as above | When the outbound row lookup returns no match (or the matched row has no `tenant_id`/`project_id`), the callback handler refuses to publish a `cst.delivery` event. | `attribution_unresolved` | Security ledger shows `tenant_id: null` for several SIDs. | Root cause for null attribution not traced in production. | **Implemented** — fail-closed, no fabricated attribution. |
| 9 | Voice turns exceeding 7000 ms deadline | `transport/voice/turn_deadline.ts:runVoiceTurnWithDeadline` (L61-108) | Voice turn races against a deadline. On timeout: (a) `AbortSignal` fires, (b) in-flight work stops, (c) no transcript/delivery/SMS is persisted, (d) audit entry with `tripwire: true` is logged. | `TURN_TIMEOUT` | Call SIDs `CA1decc8a2aead3400c684327ec30ff44d` (2026-10-28T21:09:00Z), `CAfdc6ae536baf7dd1b2cbf5502adb3f20` (2026-10-28T21:34:39Z). 7 regression tests in `voice_lifecycle.test.ts`. | Late publication for same correlation IDs not root-caused. | **Implemented** — audit logged with `tripwire: true`, `deadline_ms`. |
| 10 | Late `cst.turn` publication after timeout | Dashboard publish outcomes table vs logs | A turn that timed out should never produce a successful dashboard publication. If a late completion publishes after timeout, it is a consistency discrepancy. | `consistency_discrepancy` | DB shows published outcomes for same correlation IDs at 21:09:09Z and 21:34:48Z (several seconds after timeout). | Root cause not traced. No automated detection or alert. | **Specified only** — no automated alert exists. |
| 11 | Security ledger events with no durable DB record | `Logger.audit()` (logger.ts L96-112) → fire-and-forget `DbClient.recordSecurityLedgerEvent()` (db/client.ts L1022-1057) | `Logger.audit()` persists to DB via dynamic import. Persistence is fire-and-forget: the async IIFE is untracked; the catch block is empty. If the DB insert fails, the event exists only in the in-memory ring buffer and console log. | `persistence_gap` | Pre-fix production: `SELECT count(*) FROM security_ledger` = 0. Post-fix: code-level tests pass (13 tests). | Post-deploy SQL verification. Shutdown behavior under pending writes. | **Implemented (code-level)** — fire-and-forget. DB failure is logged but not observable to caller. |

### Notes on Monitoring Implementation

- **Correlation IDs:** Voice timeout and delivery callback paths include correlation IDs. The vFarm per-sensor failure logs (404, 422, timeout) do **not** propagate the voice turn's correlation ID. This should be added for end-to-end tracing.
- **Evidence integrity:** The supplied Render log lines (`2026-10-28T21:34:32…`) are historical. Raw Render logs for 2026-10-28 incidents have rotated. These are the exact lines provided; no fresh Render log retrieval was performed.
- **Implemented vs deployed:** Items 1-6 (vFarm classification) have code-level implementations added in commit `bf0d57d` but are **not deployed** to production. Items 7-9 (Twilio/voice) reflect existing production code behavior. Item 10 is specification-only. Item 11 is code-level only.

---

## B. Research Twin — Escalation and Integrity Rules

CST **must create or surface a Research Twin investigation** rather than speak an unverified value when any of the following occurs:

### Escalation Trigger Table

| Trigger Condition | Mandatory CST Behavior | Evidence to Retain |
|-------------------|------------------------|-------------------|
| Identity or authorization is unknown/unresolved | Never fabricate caller identity. Fail closed. Return: "I'm not able to verify your authorization for that farm." | `tenant_id`, `project_id`, `phone_e164` (masked), `service_number_binding` lookup result, `resolveSpeaker` result, `assertSpeakerFarmAccess` outcome |
| A reading is null/missing where data is expected | Never fabricate sensor readings. Return: "The reading/status could not be reliably verified." | `sensor_id`, `farm_id`, HTTP status, response body (if safe), correlation ID |
| vFarm readings endpoint returns 404 | Distinguish: (a) sensor exists but no readings → "No current reading available for [sensor]"; (b) sensor not found → escalate as `invalid_request`. Never convert 404 to a successful reading. | `sensor_id`, HTTP 404 response, `category: no_reading` log entry |
| vFarm readings endpoint returns 422 | Never infer a valid reading. Return: "The request to the farm system was invalid." Escalate as `invalid_request`. | `sensor_id`, HTTP 422 response, validation error detail, `category: invalid_request` log entry |
| vFarm request reaches or exceeds 5000 ms timeout | Never return stale or partial data as current. Return: "The farm system took too long to respond. Please try again." | `sensor_id`, `farm_id`, timeout duration, `category: timeout` log entry |
| Twilio delivery callback cannot resolve persisted outbound row or tenant/project | Never fabricate delivery status. Return: "The delivery status could not be reliably verified." | `MessageSid` (masked), `outbound_row_found`, `stored_tenant_id`, `stored_project_id`, correlation ID |
| Missing durable security-ledger DB record despite in-memory or console evidence | Treat as persistence gap. Do not claim audit durability. Surface as Research Twin investigation. | `correlation_id`, `tool_or_route`, `outcome`, in-memory ring buffer entry, DB query result |

### CST Must Not Fabricate

- Sensor readings or telemetry values
- Delivery status (SMS or voice)
- Person-to-unit or person-to-farm mappings
- Farm-to-device relationships
- Tenant/project attribution for unresolved callbacks

### Safe Response Protocol

When verification fails for any of the above, CST responds with:
> "The reading/status could not be reliably verified."

This response is safe because it does not disclose protected data, does not fabricate a value, and does not claim a state that cannot be proven.

### Documented Rules vs Verified Implementation

| Escalation Rule | Code Implementation | Local Tests | Production Verified |
|-----------------|---------------------|-------------|---------------------|
| Identity/authorization unknown → fail closed | `assertSpeakerFarmAccess()` throws `VfarmAuthorizationError` → 403 | ✅ `kmg9_farm_isolation.test.ts`, `platform_tenancy.test.ts` | Not verified with live caller |
| Reading null/missing → no fabrication | `listLatestReadings` skips null, returns partial; `mapLatestReadingToTelemetry` only maps present values | ✅ `vfarm_telemetry_mapping.test.ts`, `vfarm_per_sensor_classification.test.ts` | Not deployed |
| 404 → `no_reading` classification | Catch block logs INFO with `category: 'no_reading'` | ✅ Local test passes | **Not deployed** |
| 422 → `invalid_request` classification | Catch block logs ERROR with `category: 'invalid_request'` | ✅ Local test passes | **Not deployed** |
| Timeout → `timeout` classification | Catch block detects `VfarmNetworkError` + `/timed out/`, logs WARN with `category: 'timeout'` | ✅ Local test passes | **Not deployed** |
| Callback attribution unresolved → fail closed | `updateDeliveryStatusByProviderSid` returns `tenant_id: null`; publisher refuses `cst.delivery` | ✅ Local tests pass | Production shows `outbound_row_found=false` for historical SIDs |
| Security ledger persistence gap → investigation | `Logger.audit` fire-and-forget to `recordSecurityLedgerEvent`; DB errors logged but not thrown | ✅ Local tests pass | Production DB had 0 records pre-fix |

**No Research Twin cards, hooks, or automated monitoring rules are live in production.** The above are documented escalation rules with code-level implementations. Production verification (Category B) and signed E2E acceptance (Category C) remain pending.

---

## C. Front Door — What CST Can and Cannot Demonstrate

### Can Demonstrate (Code + Local Tests, Category A)

Where supported by code inspection, unit tests, typecheck, and build:

- **Conversation workflow:** Inbound voice → turn processing → response generation → persistence.
- **Authorization boundaries:** Service number binding → vFarm speaker resolution → farm grant check → `assertSpeakerFarmAccess()`.
- **Fail-closed identity handling:** Unresolved identity → safe refusal → no fabrication. No auto-registration. No cross-tenant data leakage.
- **Honest handling of missing or uncertain data:** Per-sensor failure classification (`no_reading`, `unauthorized`, `invalid_request`, `upstream_error`, `timeout`). Partial results returned. Failed sensors excluded from results.
- **Security ledger audit trail:** Code-level implementation complete. Fire-and-forget DB persistence via `DbClient.recordSecurityLedgerEvent()`. In-memory ring buffer (max 200 events) and console log as fallback.
- **Voice deadline enforcement:** 7s bound via `runVoiceTurnWithDeadline`. Abort signal propagated to synthesizer. Timed-out turn abandoned without persistence.

### Cannot Yet Promise (Category B/C Evidence Pending)

| Capability | Blocker | Required Evidence |
|------------|---------|-------------------|
| Reliable real-time readings from every vFarm device | Rack sensors (`rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`) time out at 29-43s; per-sensor classification not deployed | **B:** Deployed logs showing per-sensor classification in production. **C:** Authorized live voice test with verified readings. |
| Complete Twilio delivery attribution | Historical SIDs lack persisted `provider_sid`/`tenant_id`/`project_id`; root cause for null attribution unconfirmed | **B:** Production DB investigation of callback SIDs for post-fix messages. **C:** Authorized live SMS with verified callback chain. |
| Durable production security-ledger persistence | Code fix implemented (fire-and-forget) but not deployed; production DB had 0 records pre-fix. Shutdown can discard pending writes. | **B:** Post-deploy `SELECT count(*) FROM security_ledger > 0`. **C:** Operator verification of ledger completeness. |
| Fully locked-down database network access | `0.0.0.0/0` allow-list on PostgreSQL instance; owner decision pending | **B:** Owner-authorized allow-list change confirmed. **C:** Security review sign-off. |
| Signed production SMS and voice acceptance | No authorized live E2E test with provider SID, timestamps, and operator sign-off | **C:** Authorized signed SMS send + voice call with full trace. |

**Do not describe planned features as deployed. Do not describe code-level fixes as production-verified. Every "Can Demonstrate" item above is Category A (code + local tests) only.**

---

## Patch Log Path

`docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`
