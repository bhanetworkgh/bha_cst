# Monitoring Twin — Field Contract

> Branch: `fix/monitoring-pay-gate-closure`
> Date: 2026-11-02

## Monitoring Twin — Observable Fields

The Monitoring Twin **observes** the following fields. It never fabricates
values. When a field is missing, stale, or fails to retrieve, that state is
logged and escalated — never silently swallowed or defaulted.

### Farm-Level Observables

| Field | Source | Notes |
|---|---|---|
| `fleet_status` | vFarm `GET /api/v1/devices?farm_id={id}` → `fleet_status` | Authoritative. CST does NOT recompute. |
| `fleet_counts` | vFarm `fleet_counts` (5-bucket: on/off/online/unhealthy/offline) | When upstream contract deployed; else flagged `unavailable`. |
| `farm_health.status` | vFarm `GET /api/v1/farms/{farm_id}/health` → `status` | Only `healthy` → CST `healthy`. `unhealthy` → `unhealthy`. All else → `degraded`/`unknown`. |
| `health_score` | vFarm `GET /api/v1/farms/{farm_id}/health` → `health_score` | **Diagnostic evidence only.** Never used to derive health status. |
| `last_seen_at` | vFarm device response | Per-device, where supplied. |
| `last_reading_at` | vFarm `reading_ts` or `received_at` | Per-sensor, from latest reading response. |

### Per-Sensor Observables

| Field | Source | Notes |
|---|---|---|
| Missing/null readings | `values.{key}.value` is null/undefined | Status maps to `telemetry_unavailable`, NOT `normal`. |
| Stale readings | `reading_ts` older than 24h | Flagged `stale: true` in telemetry. |

### HTTP Error Rate Observables

| Metric | Trigger |
|---|---|
| HTTP 404 rate | Per-sensor 404 (no readings available). Logged per-sensor with correlation ID. |
| HTTP 422 rate | Invalid request to vFarm. Logged as `invalid_request` with correlation ID. |
| Requests > 5,000ms | `VFARM_DEFAULT_TIMEOUT_MS = 5000`. Timeout logged as `timeout` category. |
| Repeated device failures | Per-sensor failures tracked via self-healing tracker. After 3 failures in 10 min → capability `degraded`. |

### Authentication Observables

| Metric | Source |
|---|---|
| JWT expiry / re-authentication | `ensureAdminToken()` — refreshes before expiry. Failure logged. |
| 401/403 per-sensor | Logged as `unauthorized` category with correlation ID. |

### Twilio / Voice Observables

| Metric | Source |
|---|---|
| Twilio callback-to-outbound-row attribution | `voice_deliveries` table — correlates inbound webhook → outbound delivery. |

### Security Ledger

| Metric | Source |
|---|---|
| Security-ledger persistence | `SecurityLedgerEvent` entries persisted per-request with actor, role, outcome. |

### Correlation ID Propagation

Every inbound request generates a correlation ID at the ingress lane and it is
carried end-to-end through CST:

- SMS ingress (`engine/src/transport/twilio/normalize.ts`):
  `corr_${messageId}_${Date.now()}`.
- Voice ingress (`engine/src/interfaces/voice/index.ts`):
  `input.correlation_id || input.call_sid || voice_${randomUUID()}`.
- The router, vFarm connector, escalation service, delivery publisher, and
  security ledger all accept and forward `correlation_id`.
- Persistence (`DbClient`): `messages_in`, `messages_out`, `voice_deliveries`,
  `security_ledger`, and conversation/transcript rows all store `correlation_id`
  so a single turn can be joined across ingress, engine, delivery, and audit.
- Engine dashboard events carry `correlation_id` as the join key to `cst.turn`.

A correlation ID is never derived from customer message content or phone
numbers.

### Tenant / System / Project Attribution

- Tenant: `tenant_id` (e.g. `tenant-vfarm-01`), the vFarm tenancy boundary.
- System: `bha-cst-engine` (the `SERVICE_NAME` / `service` field).
- Project: `project_id`, scoped within a tenant via `CoreRegistry`.

Every persisted event row carries `tenant_id` and `project_id`. vFarm calls are
scoped to a single tenant (`VfarmTenantAdapter.tenantId`) and the active farm is
resolved per-tenant (`getActiveFarmId`). Tenant isolation is enforced by
`assertSpeakerFarmAccess` against the speaker's authoritative grant list; CST
never synthesizes grants or farm scope.

### Deduplication and Idempotency

- Self-healing tracker (`engine/src/recovery/self_healing_tracker.ts`): each
  (tenant, project, failure category) scope emits at most one deduplicated
  operational incident (`incident_emitted` flag), then marks the capability
  degraded and bounds rechecks (`SELF_HEALING_MAX_RECHECKS = 5` at 60s
  intervals). Restart resets counts so transient outages do not persist.
- Delivery publisher (`engine/src/publishers/delivery.ts`): monotonic status
  rank per `provider_sid` — a status whose rank is `<=` the already-recorded
  rank is silently dropped, so redelivered webhooks cannot regress a terminal
  delivery state. `DbClient.updateDeliveryStatusByProviderSid` enforces the
  same ordering at persistence.

### Retry, Failure and Reconciliation Behavior

- Token retry: `ensureAdminToken()` reuses a non-expired cached JWT, attempts
  one `POST /api/v1/auth/login` re-auth when expired or missing, and falls back
  to the static `VFARM_API_JWT`/`VFARM_JWT`; it never throws and lets the
  upstream 401 remain authoritative.
- Farm discovery retry: `listFarms()` on a 401/403 attempts one-shot re-login
  and retries; without credentials it propagates the upstream 401.
- Per-sensor readings failures are classified (404 `no_reading`, 401/403
  `unauthorized`, 422 `invalid_request`, 5xx `upstream_error`, timeout
  `timeout`, network `upstream_error`) and logged per-sensor with the
  correlation ID; one sensor's failure never blocks another sensor.
- Self-healing tracker: 3 failures in 10 minutes per (tenant, project,
  category) degrades the capability; bounded rechecks (max 5, 60s) attempt
  recovery only after successful authorized resolution and telemetry retrieval.

## Real Device IDs

| Device ID | Type | Notes |
|---|---|---|
| `VFARM-CAB-001` | Cabinet (frame) | Not a reporting device. `fleet_status: null`. |
| `relay_module_03` | Relay/Load | Dependent on sensors. `fleet_status: on/off`. |
| `vfarm-pi2-cam` | Camera | Reporting device. |
| `rack1_mq7` | Sensor (CO/MQ-7) | Reports `co` reading. |
| `rack1_soil` | Sensor (Soil) | Reports `soil_moisture` reading. |
| `rack1_ph` | Sensor (pH) | Reports `ph` reading. |
| `rack2_dht` | Sensor (DHT) | Reports `temperature` and `humidity`. |
| `pi_gateway_01` | Gateway | Board-level gateway. |
| `uno_board_01` | Board | Arduino Uno controller. |
| `esp32_node_01` | Board | ESP32 node (rack 1). |
| `esp32_node_02` | Board | ESP32 node (rack 2). |

---

## Research Twin — Escalation Contract

The Research Twin **opens or surfaces an investigation** for the following
triggers. It NEVER fabricates values, console-logs-as-cards, or silently
ignores failures.

### Investigation Triggers

| Trigger | Detection Point | Escalation |
|---|---|---|
| Unknown identity or grant | `assertSpeakerFarmAccess()` throws `VfarmAuthorizationError` | Log `authorization_denied`, record in self-healing tracker. |
| Missing/null readings | `mapLatestReadingToTelemetry()` returns `telemetry_unavailable` | Log with correlation ID. Surface in Monitoring Twin. |
| HTTP 404 | Per-sensor 404 in `listLatestReadings()` | Log as `no_reading` category. |
| HTTP 422 | Per-sensor 422 in `listLatestReadings()` | Log as `invalid_request` category (ERROR level). |
| Timeouts (> 5,000ms) | `VfarmNetworkError` with "timed out" | Log as `timeout` category. Record in self-healing tracker. |
| Unhealthy/degraded/unknown vFarm health | `GET /api/v1/farms/{farm_id}/health` returns non-`healthy` | Exposed via `/api/health` with `farm_health.status`. |
| Offline upstream devices | `fleet_status === 'offline'` on reporting devices | Surfaced in fleet status response. |
| Unresolved Twilio callbacks | Inbound webhook without matching outbound delivery row | Voice delivery audit. |
| Orphaned security-ledger events | Ledger event without matching conversation context | Security audit. |

### BLOCKED — BHA Engine Integration

> [!IMPORTANT]
> The Research Twin / BHA Engine integration is **NOT available** in this
> repository. The CST engine logs investigation triggers to structured logs
> and surfaces them via the `/api/health` endpoint, but there is no
> programmatic integration to the BHA Research Engine card system.
>
> **Missing integration contract:**
> - Research Twin card creation API (endpoint, auth, payload schema)
> - Investigation lifecycle management (open → assign → resolve)
> - Bidirectional status sync (CST → Research Twin → CST)
> - Priority/severity mapping from CST trigger categories
>
> This is documented as BLOCKED. A `console.log` is NOT a Research Twin card.

