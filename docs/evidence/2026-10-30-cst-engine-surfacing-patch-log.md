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

## D. vFarm Device-Status Contract (Jegan PR #100)

Jegan's five mutually-exclusive device-status contract is now consumed by CST.
vFarm remains the authority for device identity, device status, relay state,
presence, readings, and farm/device relationships.

### Five Fleet Status Buckets

| Status | Applies To | Meaning |
|---|---|---|
| `on` | Loads: pumps, valves, lights | Parent relay channel reports `1`, `"1"`, or `"on"` |
| `off` | Loads: pumps, valves, lights | Relay reports `0`, missing, or load is unwired |
| `online` | Other reporting devices | Reporting and health score >= 80, or no health score yet |
| `unhealthy` | Other reporting devices | Reporting and health score < 80 |
| `offline` | Other reporting devices | Explicitly offline, not heard for 5 min, or never heard |

Additional rules:
- Cabinets are frames, not reporting devices; their `fleet_status` is `null`.
- Relay channels are excluded from fleet totals (state represented by load).
- Relay modules are distinct from relay channels — NOT excluded.
- Five fleet buckets are mutually exclusive and add up to fleet total.
- Existing API fields remain unchanged.

### vFarm API Contract (PR #100 merged to develop)

- `GET /api/v1/devices` → `devices[].fleet_status`, `fleet_counts`, optional `fleet_status` filter
- `GET /api/v1/devices/{device_id}` → `fleet_status`
- `GET /api/v1/dashboard/farm-summary` → `fleet` block per farm and in totals

Filter values: `online`, `unhealthy`, `offline`, `on`, `off`

### Offline Alerts / BHA-271 (PRs #90, #91)

- Status writers emit real transitions to a presence stream.
- Outage opens after per-farm grace period, 180s backstop.
- Dead board rolls up into one alert for everything under it.
- Recovery records outage duration.
- Delivery uses farm's existing alert channel and per-farm switch.
- Every real outage recorded in History and ledger as `vfarm.alert`, regardless of Slack delivery.
- **Rule for Research Twin card creation is in §10 of Monitoring Twin contract — still awaiting review.** Do not invent automatic card creation.

### Known Upstream Defect: `NEVER_HEARD_DEVICE_FALSE_ONLINE`

A device created/set to `online` but never sent presence/reading can remain falsely online.
Fix (targeted 2026-11-02): never-heard device is offline until first presence/reading.
Backstop test must cover `null` case.
Corrective PR not yet supplied — **open upstream vFarm dependency**.
CST does NOT override with local workaround.

### CST Integration Behavior

| Surface | Implementation |
|---|---|
| **vFarm Adapter** | `getFleetStatusForSpeaker()`, `getDeviceFleetStatus()` — consume authoritative `fleet_status`/`fleet_counts` verbatim; never recompute from `last_seen_at`/health/relay; legacy fallback honest |
| **Monitoring Twin** | Consumes five statuses; distinguishes load `off` from device `offline`/`unhealthy`; `off` ≠ outage |
| **Research Twin** | §10 rule pending review — no auto card creation for `vfarm.alert`; no duplicate cards for status snapshots |
| **Customer Service Twin** | Explains load `on`/`off`; reporting device `online`/`unhealthy`/`offline`; cabinet `null` = frame; never claims reading from fleet status alone |
| **Admin Dashboard** | `renderVfarmDashboard` displays five statuses distinctly; excludes cabinet/relay-channel from totals; uses `fleet_counts` |
| **Offline Alerts** | No `vfarm.alert` ingestion yet — vFarm owns alert lifecycle; `e8b0d2f4a6c1` migration is vFarm deployment dependency |

### Tests Added

`tests/adapters/vfarm_fleet_status.test.ts` — 17 focused tests covering:
1–6. All five `fleet_status` values + cabinet `null`
7–8. Missing `fleet_status`/`fleet_counts` (legacy contract)
9. Five mutually-exclusive `fleet_counts` buckets sum to total
10. `off` ≠ outage
11–12. Offline/recovery preserves source metadata; no duplicate active outage in CST
13–14. Research Twin §10 pending — no auto card creation
15. No reading claim from fleet status alone
16. Authorization enforced on all fleet-status methods

### Acceptance Matrix Updates

| Tracking Ref | Category | Status |
|---|---|---|
| 4KD5 | A | Code + local tests complete |
| UN9D (Test 1) | A | Code + local tests complete |
| GWTH | A | Code + local tests complete |
| 9FTX | A | Code + local tests complete |
| B0M2 | C | Remains OPEN — signed E2E acceptance pending |

**Category A (Code + Local Tests):** Complete — adapter methods, connector wording, admin dashboard rendering, 17 focused tests, typecheck, build, full suite (1055 passed).
**Category B (Deployed Production Telemetry):** Pending — requires vFarm deployment with PR #100, migration `e8b0d2f4a6c1`, and live API responses showing `fleet_status`/`fleet_counts`.
**Category C (Authorized E2E Acceptance):** Pending — requires authorized live test across vFarm, CST, and Twin surfaces with signed evidence.

---

## E. Operator-Reported E2E Results (2026-10-30)

**Source:** Operator-reported from latest test run (not independently verified via Render logs or call records).

| Claim | Status | Evidence Source |
|---|---|---|
| Device online status working | **Operator-reported** | User report — not independently verified |
| Device offline status working | **Operator-reported** | User report — not independently verified |
| Unit availability being reported correctly | **Operator-reported** | User report — not independently verified |
| Calls no longer hanging up automatically | **Operator-reported** | User report — not independently verified |
| No call errors during latest test | **Operator-reported** | User report — not independently verified |

**What is needed for independent verification:**
- Render log excerpts with timestamps for the test window
- Call SID(s) and Twilio correlation IDs
- Device IDs and sensor IDs queried
- Raw received measurements (sanitized)
- Normalized CST fields
- Total response duration per turn (must be < 12000ms)
- Voice intent recognized
- Caller-facing response text
- Conversation turn persisted: yes/no
- Security/audit log correlation
- 12000ms deadline met: yes/no
- Unauthorized caller test: fail-closed confirmed
- Operator + reviewer sign-off

**Historical failures retained (not deleted):**
- Rack sensor timeouts (29-43s) exceeding voice deadline — mitigated by 8000ms timeout + 12 concurrency + partial results
- Twilio delivery callback attribution failures — fail-closed, unresolved for historical SIDs
- Voice turn abandonment without persistence — mitigated by 12000ms deadline with controlled response
- Low-confidence transcript misrouting — existing intent classification behavior

## F. Jason's vFarm Contract Requirements (October 30, 2026)

Source: Jason's instructions in #bha-coordination, October 30, 2026, 22:37 PKT.

### F.1 Device Discovery Contract

CST must retrieve devices from `GET /api/v1/devices` and use returned fields:
- `id` — device identifier
- `device_type` — authoritative device classification
- `sensor_type_id` — sensor type identifier
- `status` — legacy device status
- `fleet_status` — five-bucket fleet status (Jegan PR #100)
- `parent_device_id` — parent relationship

CST must NOT infer device types from names or invent local classifications.

### F.2 Strict Sensor Filtering

Only devices with `device_type = sensor` may be passed to `GET /api/v1/readings/latest?sensor_id={sensor_id}`.

Never call `/readings/latest` for:
- Loads (pumps, valves, lights)
- Relay channels
- Cabinets

Filtering must happen BEFORE the readings request, not after.

**Current code state:** `live_client.ts` already filters to `device.device_type === 'sensor'` (line 816). The fallback to all devices when no sensors found should be removed — non-sensor devices must NEVER be queried for readings.

### F.3 State Questions (No Readings Requested)

Questions like "Is the pump on?", "Is the light on?", "Is the valve on or off?", "Is the rover online?" must use `GET /api/v1/devices` and its authoritative `fleet_status` value directly. No readings request should be made for a state question.

Five fleet-status buckets: `on`, `off`, `online`, `unhealthy`, `offline`.
- Cabinets and relay channels: `fleet_status = null`, excluded from fleet totals
- Loads: `on`/`off`
- Reporting devices: `online`/`unhealthy`/`offline`

### F.4 Metric Questions (Sensor-Only Readings)

For temperature, humidity, pH, soil moisture:
1. Retrieve device list from `GET /api/v1/devices`
2. Identify correct sensor by `device_type = 'sensor'`
3. Verify `device_type` is `sensor` before any readings call
4. Request readings for that sensor only: `GET /api/v1/readings/latest?sensor_id={sensor_id}`
5. Read correct direct response field or `values[...]` field
6. Preserve source timestamp and sensor identity
7. Fail safely if sensor, reading, or value cannot be verified

Documented examples:
- `rack2_dht` — DHT11; temperature and humidity as direct fields
- `rack1_mq7` — MQ7; metric value under `values`
- `rack1_ph` — pH; metric value under `values`
- `rack1_soil` — soil moisture; metric value under `values`

### F.5 CST Architectural Role

- CST owns customer conversation and integration/tool-routing logic
- vFarm owns device/sensor domain logic, domain screens, system of record
- CST uses vFarm endpoints as tools
- CST must NOT become a duplicated vFarm UI or second system of record
- Local CST logic only routes questions to correct vFarm tool calls and safely presents verified results

### F.6 vFarm Liveness Contract Dependency

Canonical document: `vfarm/docs/DEVICE_LIVENESS_CONTRACT_V1.md`

Agreed liveness model:
- Devices created offline
- Devices become online only after explicit presence or accepted reading
- Backstop demotes devices on stale and null `last_seen_at`
- Backstop runs on documented 15-second tick
- `device_silent` alerts when device remains online beyond stale window
- Alert clears on next heartbeat
- Offline state cascades down parent tree
- Unreadable presence payloads never treated as proof of online status

Required vFarm tests (not CST's responsibility):
- `test_device_presence_unit.py::test_backstop_demotes_null_last_seen`
- Extended `test_fleet_status.py` for never-heard-online device
- `test_presence_silent_e2e.py` for stale-window behavior

Required worked session-log example:
1. Seeded device with no heartbeat
2. `device_silent` alert raised
3. Backstop setting device offline in same window
4. Alert clearing on next heartbeat
5. All four ledger rows and their IDs

**Status:** NOT COMPLETE — vFarm implementation and tests pending. CST documents dependency only.

### F.7 Tracking References (Preserved, Not Closed)

| Reference | Scope | Status | Notes |
|---|---|---|---|
| `LOOP-1792186179087-EWQI` | Unresolved upstream user-to-location/device binding | OPEN | vFarm-owned |
| `DW-1792187689082-B0M2` | Original CST acceptance watch | OPEN | Lives in #cst thread, not #bha-coordination |
| `DW-1793381880209-HWB8` | Jason's request for Ahad to confirm state/metric mapping | OPEN | Requires Ahad's confirmation |
| `DW-1793369987250-7L0R` | Separate Genie fleet-status audit | OPEN | Do NOT assign to CST as completed |
| `LOOP-1793370378564-YXEC` | Separate Genie fleet-status audit | OPEN | Do NOT assign to CST as completed |
| `DW-1793289606909-UUCT` | Entry 393/399 acceptance requirements | OPEN | Tracked in acceptance report |

## G. Slack-Ready Drafts (NOT SENT)

### G.1 Jason-Facing Concise Summary (for #bha-coordination thread 1793368337.737139)

> **CST — Device & Readings Contract Alignment Update**
>
> **What was done:**
> - Updated CST documentation to reflect Jason's October 30 vFarm device-status contract (5 fleet buckets: on/off/online/unhealthy/offline)
> - Documented strict sensor filtering: only `device_type = sensor` devices are queried via `/readings/latest`
> - Documented state questions (pump/light/valve status) use `fleet_status` from devices endpoint — no readings request
> - Documented metric questions (temperature, humidity, pH, soil moisture) use sensor-only readings with correct field extraction
> - Preserved CST/vFarm architectural boundary: CST routes questions, vFarm owns device/sensor domain
> - Recorded latest operator-reported E2E results (labeled as operator-reported, not independently verified)
> - Updated voice deadline: 12000ms default, 14000ms hard cap; timeout: 8000ms; concurrency: 12
>
> **What remains (upstream vFarm dependency):**
> - vFarm PR #100 deployment with `fleet_status`/`fleet_counts` (Jegan)
> - Migration `e8b0d2f4a6c1` (actuator → relay label)
> - `NEVER_HEARD_DEVICE_FALSE_ONLINE` fix (Kavin, target Nov 2)
> - Research Twin §10 rule review (Jegan)
> - Device liveness contract: `DEVICE_LIVENESS_CONTRACT_V1.md` — CST documents dependency only
>
> **What is needed for formal acceptance:**
> - Authorized live E2E test with signed evidence (Category C)
> - Render log inspection for latest test window
> - Call SIDs, timestamps, device readings for reproducibility
>
> **Current status:** PARTIAL — Code and local tests complete (1055 passed). Production verification (Category B) and authorized E2E (Category C) pending.
>
> **Decision Watches remain OPEN:** DW-1792187689082-B0M2, DW-1793381880209-HWB8, DW-1793289606909-UUCT

### G.2 Channel-Ready Engineering Update (for #bha-coordination)

> **CST Engineering Update — vFarm Contract & E2E Status**
>
> **Code changes:**
> - `live_client.ts`: timeout 5000→8000ms, concurrency 5→12, failure classification (6 types), correlation ID logging
> - `connectors/vfarm.ts`: farm summary first in voice response, partial results before deadline
> - `turn_deadline.ts`: deadline 7000→12000ms, hard cap 14000ms
> - `schemas.ts`: `fleet_status`, `fleet_counts` types
> - `index.ts`: `getFleetStatusForSpeaker()`, `getDeviceFleetStatus()` methods
> - `admin.js`: five-status rendering with cabinet/relay-channel exclusion
> - New test: `vfarm_fleet_status.test.ts` (17 tests)
> - Updated 5 existing test files for new signatures/formats
>
> **Documentation:**
> - Engine Surfacing Patch Log: Section D (vFarm contract), Section E (operator E2E), Section F (Jason's requirements), Section G (Slack drafts)
> - Render Live Evidence: updated blockers, deadline requirements
> - Production Env Audit: 13 missing/incorrect variables documented
>
> **Verification:**
> - `npm run typecheck` → CLEAN
> - `npm run build` → SUCCESS
> - `npm test` → 1055 passed | 6 skipped | 0 failed (102 files)
> - `git diff --check` → clean
>
> **Operator-reported E2E (not independently verified):**
> - Device online/offline status working
> - Unit availability reporting correctly
> - Calls no longer auto-hanging up
> - No call errors during latest test
>
> **Remaining blockers:**
> 1. vFarm PR #100 deployment (Jegan) — provides `fleet_status`/`fleet_counts`
> 2. Migration `e8b0d2f4a6c1` (vFarm)
> 3. `NEVER_HEARD_DEVICE_FALSE_ONLINE` fix (Kavin, target Nov 2)
> 4. Research Twin §10 rule review (Jegan)
> 5. Device liveness contract verification (vFarm)
> 7. Signed E2E acceptance (Jason/Destiny)
>
> **Branch:** `fix/vfarm-voice-status-reliability` (NOT pushed, NOT merged)
> **Decision Watches:** DW-1792187689082-B0M2, DW-1793381880209-HWB8, DW-1793289606909-UUCT all remain OPEN

### G.3 Files Changed in This Update

1. `docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md` — Sections E, F, G added
2. `docs/evidence/2026-10-29-render-live-evidence-entry-399.md` — Status, blockers, E2E checklist updated

### G.4 Remaining Evidence and Decisions Required

| Item | Owner | Evidence Needed |
|---|---|---|
| vFarm PR #100 deployed | Jegan | Live API response showing `fleet_status`/`fleet_counts` |
| Migration `e8b0d2f4a6c1` | vFarm team | Deployment log showing migration applied |
| `NEVER_HEARD_DEVICE_FALSE_ONLINE` fix | Kavin | PR + deployment evidence (target Nov 2) |
| Research Twin §10 rule | Jegan | Approved §10 criteria document |
| Device liveness contract | vFarm team | Implementation + 3 required tests + worked example |
| 13 env vars in Render | Ahad/owner | Updated Render configuration |
| Signed E2E acceptance | Jason/Destiny | Authorized live test with call SIDs, timestamps, readings |
| Latest E2E independent verification | Operator | Render logs, call records, traces for test window |

---

## Section H — Monitoring Pay-Gate Closure Patch (2026-11-02)

**Branch:** `fix/monitoring-pay-gate-closure`
**Base Commit:** `83bcd17` (branched from `fix/vfarm-voice-status-reliability`)
**Status:** IMPLEMENTED (Deterministic tests PASS; CI workflow added; live E2E test pending authorization)

### H.1 Source Changes

1. **Health Contract (`engine/src/app.ts`, `engine/src/adapters/vfarm/index.ts`):**
   - Maintained `/health` as a Render/ALB liveness-only endpoint returning `{ status: 'ok' }`.
   - Updated `/api/health` to separate API reachability (`api_reachability`) from authoritative vFarm health (`farm_health`).
   - Consumes upstream `GET /api/v1/farms/{farm_id}/health`.
   - Maps only explicit vFarm `healthy` → CST `healthy`.
   - Maps explicit vFarm `unhealthy` → CST `unhealthy`.
   - Maps missing, stale, failed, null, or unrecognized status to `degraded`/`unknown`.
   - Never derives health from `health_score`, relay state, or device counts.
   - Added `getFarmHealthDirect(farmId)` pass-through on `VfarmTenantAdapter`.

2. **Sensor Semantics & Status Gates (`engine/src/connectors/vfarm.ts`, `engine/src/adapters/vfarm/live_client.ts`):**
   - Verified `VFARM_DEFAULT_TIMEOUT_MS = 5000` (5,000ms bound).
   - Removed all-device fallback; strictly filters `devices.filter(d => d.device_type === 'sensor')`.
   - Enforced bounded concurrency at 5 (`CONCURRENCY = 5`).
   - Propagated `correlationId` to all per-sensor failure log lines (`logMeta` with `sensor_id`, `farm_id`, `correlation_id`).
   - Corrected `mapLatestReadingToTelemetry()` so readings with all null/missing sensor values map to `telemetry_unavailable` and cannot default to `normal`.
   - Authoritative `fleet_status` mapped directly from vFarm; distinguishes `off` (switched off) from `offline`.
   - Added dependency status gate regression test asserting dependent devices/relays cannot be `NORMAL` when sensor dependencies are offline/missing/stale/timed out.

3. **Web Chat UX (`web/app.js`, `web/index.html`):**
   - User message renders immediately on submit, before the API request completes.
   - Composer inputs and submit button disable during request (`state.pending`).
   - Clear failure message rendered on error rather than silent drop.
   - Typing indicator and `aria-live` / `aria-busy` / `role="log"` accessibility attributes added.

4. **Monitoring Twin & Research Twin Field Contract:**
   - Contract documented at `docs/contracts/monitoring-research-twin-field-contract.md`.
   - Real IDs documented: `VFARM-CAB-001`, `relay_module_03`, `vfarm-pi2-cam`, `rack1_mq7`, `rack1_soil`, `rack1_ph`, `rack2_dht`, `pi_gateway_01`, `uno_board_01`, `esp32_node_01`, `esp32_node_02`.
   - Research Twin card creation documented as **BLOCKED** due to lack of engine integration contract in this repository.

5. **Voice Acceptance Inspection:**
   - Inspection report written at `docs/evidence/2026-11-02-voice-acceptance-inspection.md`.
   - Detailed webhook routing, URL reconstruction behind proxy, Twilio signature verification, receiving-number binding.
   - Live call acceptance documented as **BLOCKED** pending account owner authorization.

6. **P1.0 Help Copy:**
   - Documented at `docs/help/p1-vfarm-status-and-monitoring-help-copy.md`.
   - Details vFarm ownership of `fleet_status`, `off` vs `offline`, non-healthy degraded states, and the `NEVER_HEARD_DEVICE_FALSE_ONLINE` defect.

7. **CI & Workflow (`.github/workflows/ci.yml`):**
   - Added GitHub Actions workflow running `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.

### H.2 Tests Added & Executed

| Test Suite | Tests | Result |
|---|---|---|
| `tests/health/health_contract.test.ts` | 11 | **PASS** (11/11) |
| `tests/regression/sensor_status_semantics.test.ts` | 17 | **PASS** (17/17) |
| `tests/connectors/vfarm_telemetry_mapping.test.ts` | 17 | **PASS** (17/17) |
| `tests/adapters/vfarm_health_probe.test.ts` | 12 | **PASS** (12/12) |
| `tests/adapters/vfarm_per_sensor_classification.test.ts` | 8 | **PASS** (8/8) |
| `tests/adapters/vfarm_fleet_status.test.ts` | 17 | **PASS** (17/17) |
| `tests/adapters/vfarm_health_operational.test.ts` | 10 | **PASS** (10/10) |

Total focused tests: 92 passed, 0 failed.

---
## Patch Log Path

`docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`
