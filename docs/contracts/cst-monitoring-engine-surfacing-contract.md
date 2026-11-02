# CST Monitoring and Engine Surfacing Contract

**Status:** CST-side contract documented locally; external Monitoring Twin receipt is NOT VERIFIED and Research Twin transport is BLOCKED pending owner approval.  
**Authority:** vFarm owns farm identity, device presence, sensor readings and farm health. CST does not calculate a second health model.  
**Scope:** This document describes the implementation in the current working tree, not proof of deployment or production acceptance.

## 1. Data flow

```text
vFarm response
  → VfarmLiveClient / VfarmTenantAdapter
  → CST normalized state and failure classification
  → admin/API, voice/text response and local operational audit
  → external Monitoring Twin receipt (NOT VERIFIED)
  → Research Twin trigger request (BLOCKED until approved contract exists)
```

## 2. Fields CST consumes

| Domain | vFarm source | CST handling |
|---|---|---|
| Farm health | `GET /api/v1/farms/{farm_id}/health.status` | `healthy` and `unhealthy` are preserved; missing/null is `unknown`; unrecognized/stale is `degraded`; request failure is `degraded`. |
| Health score | `health_score` | Diagnostic evidence only; never converted into health. |
| Device identity | `devices[].id`, `device_type`, `parent_device_id` | Sensor reads are limited to `device_type === "sensor"`. |
| Device placement | `cabinet_id`, `zone_id`, `location_id`, `sublocation_id`, parent chain | Resolved only from returned hierarchy; unresolved relationships remain unresolved. |
| Presence/status | `fleet_status` and `fleet_counts` | Rendered verbatim where supplied; CST does not infer status from relay state or local timestamps. |
| Reading | `/api/v1/readings?sensor_id={id}&limit=1` | Full reading row and source timestamps are preserved. Empty/error results are not fabricated. `cst_selection_contract=interim_limit_1_order_unverified` prevents an unverified newest-row claim. |
| Reading freshness | `reading_ts`, `received_at` | Age is computed only from a valid source timestamp. The existing connector labels readings older than 24 hours stale; missing timestamps are not replaced with the current time. |
| Health freshness | No confirmed vFarm field | `/api/health` reports `unavailable_no_timestamp`. The normalizer accepts an explicit timestamp/budget only for a future approved contract; no production freshness window is asserted. |

## 3. Normalized states and surfaces

| State | JSON/API | Voice/text | Monitoring/operations |
|---|---|---|---|
| `healthy` | `farm_health.status=healthy` | May say healthy only when vFarm explicitly says healthy. | Upstream healthy observation. |
| `unhealthy` | `farm_health.status=unhealthy` | Says unhealthy; does not downgrade to normal. | Upstream unhealthy observation. |
| `degraded` | `farm_health.status=degraded` | Says `vFarm farm health: DEGRADED`. | Upstream error, explicitly stale/invalid health, or unrecognized health. |
| `unknown` | `farm_health.status=unknown` | Says `vFarm farm health: UNKNOWN`. | Missing farm health, missing farm scope or missing health attribute. |
| `online/offline/on/off` | Device `fleet_status` | Describes the vFarm state without changing its meaning. | Device presence observation; cabinet null remains a frame. |
| `telemetry_unavailable` | Connector telemetry state | Says the reading/status could not be reliably verified. | Missing/null reading, timeout, 404 or malformed data. |

These are separate axes. `api_reachability` reports the bounded vFarm probe, not farm health. `/health` reports CST process liveness only. A successful sensor request is not device presence, and device presence is not farm health. CST processing success or Dashboard publication likewise cannot upgrade upstream health.

## 4. Routes and functions

- `engine/src/adapters/vfarm/live_client.ts`
  - `getFarmHealth()` reads authoritative farm health.
  - `listLatestReadings()` lists devices, filters sensors, and calls the interim readings endpoint with `limit=1`.
  - `resolveSensorPlacement()` resolves cabinet and placement relationships from vFarm fields only.
- `engine/src/adapters/vfarm/health.ts`
  - `normalizeFarmHealth()` is the shared health/freshness boundary; `mapFarmHealthStatus()` accepts only `healthy` and `unhealthy` as pass-through states.
- `engine/src/adapters/vfarm/index.ts`
  - `getFarmHealthDirect()` preserves missing response versus thrown upstream failure.
  - `getFarmStatusForSpeaker()` normalizes health before text/voice rendering.
  - `getFleetStatusForSpeaker()` and `getDeviceFleetStatus()` preserve vFarm fleet vocabulary.
- `engine/src/app.ts`
  - `GET /api/health` separates CST liveness, API reachability, farm health, and Research Twin configuration state.
- `engine/src/connectors/vfarm.ts`
  - Customer-facing farm/device and reading responses use vFarm data only and report unavailable data honestly.
- `engine/src/admin/routes.ts` and `web/admin.js`
  - Existing CST admin route names remain compatible, but upstream sensor reads use `/api/v1/readings?...&limit=1`, never `/api/v1/readings/latest`. The admin health card displays normalized status and labels the score as diagnostic only.

## 5. Monitoring and Research Twin triggers

Current implemented observations are not all automatic Research Twin triggers:

| Observation | Current CST effect | External Research Twin effect |
|---|---|---|
| Sensor 404 / empty history | `no_reading` log or no reading returned | None; no adapter activated |
| Sensor 401/403 | `unauthorized` log with sensor/farm/correlation metadata | None |
| Sensor 422 | `invalid_request` error log | None |
| Sensor 5xx/network/timeout | `upstream_error` or `timeout` log; other sensors continue | None |
| Repeated connector/resolution failures | `recordFailure()` tracks tenant/project/category; threshold emits a deduplicated local audit incident | None |
| `unhealthy`, `degraded`, `unknown` farm health | Normalized JSON and text/voice state | None |
| `fleet_status=offline` | Upstream device state surfaced | None; not proof of farm health |
| Unmatched delivery callback | Traceable delivery/audit failure | None |

CST currently creates **no Research Twin card**. The candidate `RT_ENDPOINT_URL` is configuration only. `/api/health.research_twin` reports `unavailable` when required configuration is missing and `blocked` when candidate credentials exist but the approved contract is absent.

The future trigger-mapping layer must document which conditions qualify, their originating incident/reference, deduplication key, and owner-approved priority vocabulary. Names such as `degraded_health` or `unknown_health` must not be presented as implemented Research Twin events until that adapter and mapping exist.

Before activation, Destiny Arupi/Jeganathan must provide the exact HTTP method, authentication header, request/response schema, authoritative investigation ID, lifecycle/status/priority vocabulary, idempotency key, timeout/retry rules, callback URL/signature/timestamp/replay contract, and proof that the transport creates a genuine Research Twin investigation.

### Provisional local lifecycle reference

`engine/src/research_twin/lifecycle.ts` provides contract-independent interfaces and an isolated coordinator for local development and deterministic tests. It preserves tenant/project/correlation, source system, originating incident ID and timestamp, opaque event/priority values, idempotency keys, authoritative external investigation IDs returned by a future adapter, and opaque external assignment/lifecycle snapshots. The coordinator demonstrates scoped duplicate suppression, bounded exponential retry for explicitly transient transport failures, no retry for permanent failures, duplicate external-event suppression, and tenant/project-scoped update lookups.

`InMemoryResearchTwinInvestigationStore` is a test reference only. It is not durable, is not registered in the application, and does not satisfy production persistence or callback security. `applyExternalUpdate()` accepts already authenticated internal input; it is not a callback endpoint and performs no signature verification. No concrete n8n transport, trigger/priority mapping, callback route, production migration, or external-card claim has been added. Local tests in `tests/research_twin/lifecycle.test.ts` are not evidence of genuine Research Twin receipt or a complete external lifecycle.

## 6. Tenant/project/correlation enforcement

Every future external Monitoring/Research Twin request must retain `tenant_id`, `project_id`, `correlation_id`, source system, originating incident/trigger reference, event type, and source timestamp where available. This is a required outbound contract, not a claim that every current log contains every field: per-sensor logs currently include sensor/farm and an optional correlation ID, while the self-healing tracker includes tenant/project/category/correlation.

The self-healing tracker's incident state is in-memory and reset on restart; its `incident_emitted` flag is not an authoritative external investigation ID. A future adapter must persist the Research Twin investigation ID and correlation/idempotency keys durably.

Farm authorization remains server-resolved from the speaker's vFarm grants. A caller or LLM cannot supply a wider farm/project scope. Tenant/project values must come from the authenticated CST envelope and may never be fabricated from callback data.

## 7. Buyer-facing promises

CST can promise scoped access, explicit unavailable/degraded states, and no fabricated readings or health. The admin farm view changes with authoritative health/inventory; text/voice can include farm health, fleet counts, open vFarm alerts, and valid sensor values. Missing sensors remain visible as unavailable rather than silently becoming healthy.

CST cannot currently promise a five-minute presence guarantee, reliable readings for all four burn-in sensors, external Monitoring Twin receipt, genuine Research Twin card lifecycle synchronization, camera/media availability, or production acceptance of voice/SMS until the corresponding upstream and authorized human evidence exists.

## 8. Operator-visible limitations

- Live four-sensor discovery is currently BLOCKED by vFarm HTTP 401, so current production values, hierarchy and latency are NOT VERIFIED.
- The permanent `/readings/latest` repair, its ordering contract and sub-500 ms production traces remain vFarm-owner dependencies.
- Farm-health timestamp semantics and the five-minute presence rule remain BLOCKED pending Jeganathan's confirmation.
- Local unit tests, mocked Dashboard publication and this contract are not GitHub CI, production or external-owner evidence.
