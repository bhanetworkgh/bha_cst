# Proposed Engine-to-Dashboard Contract Mapping — Awaiting Destiny Review (`cst.event.v1` → `/api/engine/cst-events`)

**Document Path:** `docs/contracts/cst-events.md`  
**Document Classification:** `Proposed Engine-to-Dashboard Contract Mapping — Awaiting Destiny Review`  
**Contract Version:** `cst.event.v1`  
**Target Ingestion Endpoint:** Engine Dashboard (`POST https://dashboard.bhanetwork.org/api/engine/cst-events`)  
**Internal Envelope Schema:** [events.ts](file:///Users/HaMi/Documents/Jason/customer twin/engine/src/contracts/events.ts) (`CstEventV1Schema`, `CstTurnEventV1Schema`, `CstDeliveryEventV1Schema`)  
**Serialization Boundary:** `serializeForDashboard(event)` in [dashboard.ts](file:///Users/HaMi/Documents/Jason/customer twin/engine/src/publishers/dashboard.ts#L497-L530)  
**Approval Status:** `AWAITING DESTINY` (`U0AEW3TBYH1` contract-owner review and written sign-off pending; not yet owner-approved)

---

## 1. Architectural Relationship: Internal Envelope vs. Flattened Dashboard Ingestion Shape

Per Destiny Arupi's 19 November 2026 review, the comparison baseline for Stage S1 is the flattened JSON ingestion payload consumed by the Engine Dashboard (`POST /api/engine/cst-events`), compared against CST's internal `cst.event.v1` envelope and actual stored payloads.

1. **Internal Representation ([engine/src/contracts/events.ts](file:///Users/HaMi/Documents/Jason/customer twin/engine/src/contracts/events.ts)):**
   - Uses a discriminated union envelope (`type: 'cst.turn' | 'cst.delivery' | 'cst.interaction.start' | 'cst.transcript' | 'cst.outcome' | 'cst.escalation'`) with top-level envelope metadata (`specversion`, `id`, `source`, `time`, `tenant_id`, `project_id`, `correlation_id`, `channel`, `customer`, `metadata`) and a nested `data` payload object.
   - Required post-call lifecycle evidence rows (`cst.interaction.start`, `cst.transcript`, `cst.outcome`, `cst.escalation`) are persisted transactionally in PostgreSQL `dashboard_publish_outcomes` with `status = 'internal_only'` before any external dispatch.
2. **Flattened Dashboard Ingestion Shape (`serializeForDashboard` in [engine/src/publishers/dashboard.ts](file:///Users/HaMi/Documents/Jason/customer twin/engine/src/publishers/dashboard.ts#L497-L530)):**
   - For externally published events (`cst.turn` and `cst.delivery`), `CstDashboardPublisher` transforms the internal envelope via `serializeForDashboard(event)` before calling `JSON.stringify(...)` for the HTTP `POST` to `ENGINE_DASHBOARD_URL`:
     - Destructures `{ type, data, customer, ...envelope } = event` and sets top-level `event_type: type` (removing top-level `type`).
     - Spreads all properties of `event.data` onto the top-level JSON object (`Object.assign(result, data)`). Note that if `data` contains keys with the same name as top-level envelope keys (`channel`, `tenant_id`, `project_id`, `customer`, `metadata`), `Object.assign(result, data)` overwrites the envelope key unless step 3 re-assigns `customer`.
     - Computes top-level `latency_ms` (for `cst.turn`) or `delivery_latency_ms` (for `cst.delivery`) from `data.duration.total_ms` when `data.duration` is a structured object with `total_ms !== undefined`.
     - Hoists `customer.customer_ref`, `customer.phone_e164`, `customer.role`, and (when truthy) `customer.farm_ids` and `customer.person_id` to top-level keys while preserving the full `result.customer = customer` object.
3. **Null / Undefined Behavior Between Live Wire Transmission and Replay Storage (`maskEventForStorage`):**
   - **On the HTTP wire (`JSON.stringify(serializeForDashboard(event))` at [dashboard.ts](file:///Users/HaMi/Documents/Jason/customer twin/engine/src/publishers/dashboard.ts#L259)):** Properties set to `undefined` (such as `incident_id: undefined` or `error: undefined`) are omitted by `JSON.stringify`.
   - **In PostgreSQL replay storage (`maskEventForStorage(event)` at [dashboard.ts](file:///Users/HaMi/Documents/Jason/customer twin/engine/src/publishers/dashboard.ts#L459)):** The recursive walker executes `if (value === null || value === undefined) return value ?? null;`. Consequently, any key explicitly present on an object with an `undefined` value in memory is stored as `null` in `dashboard_publish_outcomes.payload` (e.g., `"incident_id": null, "error": null` in stored payload `turn_evt_32fd6323-da9f-4037-b773-5e09059ad6f3`).
   - **Zod Validation Boundary (`CstTurnSchema`):** `CstTurnSchema` uses `.optional()` (not `.nullable()`) on optional fields. Therefore, `safeParseCstEventV1` accepts `undefined` (or omitted keys) and rejects `null` or empty strings (`""`) on required `.min(1)` string fields.

---

## 2. Complete Field-by-Field Mapping Table (`cst.turn` Internal Envelope → Flattened Dashboard Payload)

> **Explicit Clarification on `data.intent`, `data.incident_id`, and `data.duration_ms`:**
> In `CstTurnSchema` ([engine/src/contracts/events.ts](file:///Users/HaMi/Documents/Jason/customer twin/engine/src/contracts/events.ts#L305-L339)), only **4** `data.*` fields are required by Zod (`turn_id`, `direction`, `channel`, `status`), alongside **9** required top-level envelope fields (`specversion`, `id`, `type`, `source`, `time`, `tenant_id`, `project_id`, `correlation_id`, `channel`, `customer` — where `channel` appears in both).
> Specifically, **`data.intent`**, **`data.incident_id`**, and **`data.duration_ms`** are **optional** in `CstTurnSchema` (`events.ts:311, 321, 322`). Any prior claim of a "13/13 required field match" that treated `intent`, `incident_id`, or `duration_ms` as required schema fields was inaccurate and is withdrawn.

| # | Flattened Dashboard Field | Type | Required / Optional Status | Internal `cst.event.v1` Source | Nested-to-Flat Transformation & Null/Empty Behavior | Source File & Line | Validation Rule (`events.ts`) | Present in Stored Payload `turn_evt_32fd6323...`? |
|---|---|---|---|---|---|---|---|---|
| 1 | `specversion` | `string` | **Required** (Envelope) | `event.specversion` | Copied via `...envelope`; also sent in HTTP header `x-cst-specversion`. Rejects empty/null. | `events.ts:436`<br>`dashboard.ts:256, 504` | `z.literal('cst.event.v1')` | Yes (`"cst.event.v1"`) |
| 2 | `id` | `string` | **Required** (Envelope) | `event.id` | Copied via `...envelope`. Prefixed `turn_evt_<uuid>`. Rejects `""` or `null`. | `events.ts:437`<br>`dashboard.ts:504` | `z.string().min(1)` | Yes (`"turn_evt_32fd6323-..."`) |
| 3 | `event_type` | `string` | **Required** (Envelope `type` → `event_type`, Optional in `data.event_type`) | `event.type` / `data.event_type` | `event.type` destructured and renamed to `event_type: type`; `data.event_type` overwrites with `'cst.turn'` if present. Top-level `type` is removed. | `events.ts:335, 449`<br>`dashboard.ts:502-509` | `z.literal('cst.turn')` | Yes (`"cst.turn"`) |
| 4 | `source` | `string` | **Required** (Envelope) | `event.source` | Copied via `...envelope` (`cst/engine`, `cst/voice/elevenlabs`, `cst/whatsapp/elevenlabs`). Rejects `""` or `null`. | `events.ts:438`<br>`dashboard.ts:504` | `z.string().min(1)` | Yes (`"cst/engine"`) |
| 5 | `time` | `string` (ISO-8601) | **Required** (Envelope) | `event.time` | Copied via `...envelope`. Must be valid ISO-8601 datetime with offset/Z. | `events.ts:439`<br>`dashboard.ts:504` | `z.string().datetime({ offset: true })` | Yes (`"2026-11-16T21:27:36.723Z"`) |
| 6 | `occurred_at` | `string` (ISO-8601) | **Optional** (`CstTurnSchema`); populated by turn producers | `data.occurred_at` | Spread from `data.occurred_at` via `Object.assign(result, data)`. Omitted on wire if `undefined`. | `events.ts:334`<br>`service.ts:438`<br>`dashboard.ts:509` | `z.string().datetime({ offset: true }).optional()` | Yes (`"2026-11-16T21:27:36.723Z"`) |
| 7 | `tenant_id` | `string` | **Required** (Envelope); Optional in `data.tenant_id` | `event.tenant_id` / `data.tenant_id` | Copied from `event.tenant_id`; overwritten by `data.tenant_id` if present in `data`. Rejects `""` or `null` at envelope. | `events.ts:323, 440`<br>`dashboard.ts:504, 509` | Envelope: `z.string().min(1)`<br>Data: `z.string().optional()` | Yes (`"tenant-vfarm-01"`) |
| 8 | `project_id` | `string` | **Required** (Envelope); Optional in `data.project_id` | `event.project_id` / `data.project_id` | Copied from `event.project_id`; overwritten by `data.project_id` if present in `data`. Rejects `""` or `null` at envelope. | `events.ts:324, 441`<br>`dashboard.ts:504, 509` | Envelope: `z.string().min(1)`<br>Data: `z.string().optional()` | Yes (`"proj-vfarm-main"`) |
| 9 | `correlation_id` | `string` | **Required** (Envelope) | `event.correlation_id` | Copied via `...envelope`. Rejects `""` or `null`. | `events.ts:442`<br>`dashboard.ts:504` | `z.string().min(1)` | Yes (`"web_3ec1a8a1-..."`) |
| 10 | `turn_id` | `string` | **Required** (`CstTurnSchema`) | `data.turn_id` | Spread from `data.turn_id` to top level. Rejects `""` or `null`. | `events.ts:306`<br>`dashboard.ts:509` | `z.string().min(1)` | Yes (`"web_3ec1a8a1-..."`) |
| 11 | `conversation_id` | `string` | **Optional** (`CstTurnSchema`) | `data.conversation_id` | Spread from `data.conversation_id`. Omitted if `undefined`. | `events.ts:307`<br>`dashboard.ts:509` | `z.string().optional()` | Yes (`"conv_ce5e9bf3-..."`) |
| 12 | `direction` | `'inbound' \| 'outbound'` | **Required** (`CstTurnSchema`) | `data.direction` | Spread from `data.direction`. Rejects values outside enum. | `events.ts:290, 308`<br>`dashboard.ts:509` | `z.enum(['inbound', 'outbound'])` | Yes (`"inbound"`) |
| 13 | `channel` | `'sms' \| 'voice' \| 'web' \| 'whatsapp' \| 'email'` | **Required** (Envelope & `CstTurnSchema`) | `event.channel` / `data.channel` | Copied from `event.channel` and overwritten by `data.channel`. Rejects values outside enum. | `events.ts:14, 309, 443`<br>`dashboard.ts:504, 509` | `z.enum(['sms', 'voice', 'web', 'whatsapp', 'email'])` | Yes (`"web"`) |
| 14 | `status` | `string` (Enum) | **Required** (`CstTurnSchema`) | `data.status` | Translated via `mapInternalStatusToContractStatus()` to one of 5 required dashboard statuses (`ok`, `refused`, `step_up_required`, `onboarding`, `error`) and spread to top level. | `events.ts:57-64, 104-130, 310`<br>`dashboard.ts:509` | `CstTurnStatusSchema` (publishers enforce `RequiredTurnStatusSchema`) | Yes (`"ok"`) |
| 15 | `intent` | `string` | **Optional** (`CstTurnSchema`) | `data.intent` | Spread from `data.intent` when present; omitted on wire when `undefined`. **Not a required schema field.** | `events.ts:223-228, 311`<br>`dashboard.ts:509` | `CstIntentSchema.optional()` (`z.string().optional()`) | Yes (`"status"`) |
| 16 | `incident_id` | `string` | **Optional** (`CstTurnSchema`) | `data.incident_id` | Spread from `data.incident_id` when escalation/incident exists; omitted on wire when `undefined` (converted to `null` in `dashboard_publish_outcomes` by `maskEventForStorage` if key was defined with `undefined`). **Not a required schema field.** | `events.ts:322`<br>`service.ts:433`<br>`dashboard.ts:459, 509` | `z.string().optional()` | Yes (`null` in stored DB row after `maskEventForStorage`; `"esc_..."` on escalated calls) |
| 17 | `duration_ms` | `number` | **Optional** (`CstTurnSchema`) | `data.duration_ms` | Spread from `data.duration_ms` when present; omitted on wire when `undefined`. **Not a required schema field.** | `events.ts:321`<br>`service.ts:432`<br>`dashboard.ts:509` | `z.number().nonnegative().optional()` | Yes (`1499`) |
| 18 | `duration` | `number \| StructuredDuration` | **Optional** (`CstTurnSchema`) | `data.duration` | Spread from `data.duration` (non-negative number or `{ total_ms, llm_ms, tts_ms, stt_ms, vfarm_ms, rag_ms, db_ms, network_ms, audio_seconds, call_seconds, delivery_ms }`). | `events.ts:241-260, 320`<br>`dashboard.ts:509` | `CstDurationSchema.optional()` | Yes (`{"total_ms": 1499}`) |
| 19 | `latency_ms` | `number` | **Optional** (Derived by `serializeForDashboard`) | `data.duration.total_ms` | Derived by `serializeForDashboard`: added **only** when `event.type === 'cst.turn'` and `data.duration?.total_ms !== undefined`. Not present if `data.duration` is a primitive number or omitted. | `dashboard.ts:510-514` | Derived from `StructuredDurationSchema.shape.total_ms` | Yes (`1499` when serialized) |
| 20 | `text` | `string` | **Optional** (`CstTurnSchema`) | `data.text` | Spread from `data.text` (inbound customer utterance). Omitted if `undefined`. | `events.ts:312`<br>`dashboard.ts:509` | `z.string().optional()` | Yes (`"What is the status of my farm?"`) |
| 21 | `message` | `string` | **Optional** (`CstTurnSchema`) | `data.message` | Spread from `data.message` (explicit dashboard alias for `data.text`). Omitted if `undefined`. | `events.ts:333`<br>`dashboard.ts:509` | `z.string().optional()` | Yes (`"What is the status of my farm?"`) |
| 22 | `reply_text` | `string` | **Optional** (`CstTurnSchema`) | `data.reply_text` | Spread from `data.reply_text` (outbound assistant reply). Omitted if `undefined`. | `events.ts:313`<br>`dashboard.ts:509` | `z.string().optional()` | Yes (`"Your farm has 0 devices..."`) |
| 23 | `reply` | `string` | **Optional** (`CstTurnSchema`) | `data.reply` | Spread from `data.reply` (explicit dashboard alias for `data.reply_text`). Omitted if `undefined`. | `events.ts:314`<br>`dashboard.ts:509` | `z.string().optional()` | Yes (`"Your farm has 0 devices..."`) |
| 24 | `reason` | `string` | **Optional** (`CstTurnSchema`) | `data.reason` | Spread from `data.reason` (routing/refusal/completion rationale). Omitted if `undefined`. | `events.ts:327`<br>`dashboard.ts:509` | `z.string().optional()` | Yes (`"Intent \"status\" successfully processed..."`) |
| 25 | `error` | `string` | **Optional** (`CstTurnSchema`) | `data.error` | Spread from `data.error`. Omitted on wire if `undefined` (stored as `null` by `maskEventForStorage` if key existed with `undefined`). | `events.ts:326`<br>`dashboard.ts:459, 509` | `z.string().optional()` | Yes (`null` in stored DB row) |
| 26 | `test` | `boolean` | **Optional** (`CstTurnSchema`) | `data.test` | Spread from `data.test` when synthetic/test traffic is flagged. Omitted if `undefined`. | `events.ts:337`<br>`dashboard.ts:509` | `z.boolean().optional()` | Omitted (`undefined`) |
| 27 | `audio_url` | `string` (URL) | **Optional** (`CstTurnSchema`) | `data.audio_url` | Spread from `data.audio_url` when present. Omitted if `undefined`. | `events.ts:315`<br>`dashboard.ts:509` | `z.string().url().optional()` | Omitted (`undefined`) |
| 28 | `audio_base64` | `string` | **Optional** (`CstTurnSchema`) | `data.audio_base64` | Spread from `data.audio_base64` when present. Omitted if `undefined`. | `events.ts:316`<br>`dashboard.ts:509` | `z.string().optional()` | Omitted (`undefined`) |
| 29 | `mime_type` | `string` | **Optional** (`CstTurnSchema`) | `data.mime_type` | Spread from `data.mime_type` when present. Omitted if `undefined`. | `events.ts:317`<br>`dashboard.ts:509` | `z.string().optional()` | Omitted (`undefined`) |
| 30 | `voice_id` | `string` | **Optional** (`CstTurnSchema`) | `data.voice_id` | Spread from `data.voice_id` when present. Omitted if `undefined`. | `events.ts:318`<br>`dashboard.ts:509` | `z.string().optional()` | Omitted (`undefined`) |
| 31 | `model_id` | `string` | **Optional** (`CstTurnSchema`) | `data.model_id` | Spread from `data.model_id` when present. Omitted if `undefined`. | `events.ts:319`<br>`dashboard.ts:509` | `z.string().optional()` | Omitted (`undefined`) |
| 32 | `customer_ref` | `string` | **Required** (via `event.customer.customer_ref`) | `customer.customer_ref` | Hoisted to top level: `result.customer_ref = customer.customer_ref`. Rejects `""` or `null`. | `events.ts:272`<br>`dashboard.ts:521` | `z.string().min(1)` | Yes (`"cust_debf555c-..."`) |
| 33 | `phone_e164` | `string` | **Required** (via `event.customer.phone_e164`) | `customer.phone_e164` | Hoisted to top level: `result.phone_e164 = customer.phone_e164` (unmasked on live Dashboard wire; masked in `dashboard_publish_outcomes` via `maskEventForStorage`). | `events.ts:273`<br>`dashboard.ts:462, 522` | `z.string().min(1)` | Yes (`"+9230****3844"` in DB) |
| 34 | `role` | `'owner' \| 'manager' \| 'tech' \| 'unknown'` | **Required** (via `event.customer.role`) | `customer.role` | Hoisted to top level: `result.role = customer.role`. | `events.ts:267-274`<br>`dashboard.ts:523` | `z.enum(['owner', 'manager', 'tech', 'unknown'])` | Yes (`"owner"`) |
| 35 | `farm_ids` | `string[]` | **Optional** (via `event.customer.farm_ids`) | `customer.farm_ids` | Hoisted to top level **only when truthy**: `if (customer.farm_ids) result.farm_ids = customer.farm_ids`. | `events.ts:281`<br>`dashboard.ts:524` | `z.array(z.string()).optional()` | Yes (`["21dde23e-...", ...]`) |
| 36 | `person_id` | `string` | **Optional** (via `event.customer.person_id`) | `customer.person_id` | Hoisted to top level **only when truthy**: `if (customer.person_id) result.person_id = customer.person_id`. | `events.ts:278`<br>`dashboard.ts:525` | `z.string().optional()` | Yes (`"debf555c-..."`) |
| 37 | `customer` | `CustomerPayload` | **Required** (Envelope) | `event.customer` | Preserved as nested object `result.customer = customer` (contains required `customer_ref`, `phone_e164`, `role`, `is_known`, `tenant_id`, `project_id`, and optional `person_id`, `name`, `email`, `farm_ids`, `metadata`). Note: `customer.name`, `customer.email`, `customer.is_known`, and `customer.metadata` remain inside `result.customer` and are **not** hoisted to top level. | `events.ts:271-283, 444`<br>`dashboard.ts:526` | `CustomerPayloadSchema` | Yes (nested object) |
| 38 | `metadata` | `Record<string, unknown>` | **Optional** (Envelope & `CstTurnSchema`) | `event.metadata` / `data.metadata` | Copied from `event.metadata`, then overwritten by `data.metadata` if `data` contains a `metadata` key (`Object.assign(result, data)`). On ElevenLabs post-call turns, `data.metadata` carries `{ agent_id, summary, call_successful, source, ended }`. | `events.ts:338, 445`<br>`service.ts:439`<br>`dashboard.ts:504, 509` | `z.record(z.string(), z.unknown()).optional()` | Yes (`{"duration_ms":1499,...}`) |

---

## 3. Stored Payload Comparison (`dashboard_publish_outcomes`)

Below is an actual stored payload retrieved from PostgreSQL `dashboard_publish_outcomes` (`event_id = 'turn_evt_32fd6323-da9f-4037-b773-5e09059ad6f3'`, `status = 'published'`, `correlation_id = 'web_3ec1a8a1-9ff9-4c28-b5df-665b16fa2f8c'`) alongside its exact `serializeForDashboard(payload)` output:

### 3.1 Stored Internal Envelope in `dashboard_publish_outcomes.payload` (Masked at Storage Boundary)
```json
{
  "id": "turn_evt_32fd6323-da9f-4037-b773-5e09059ad6f3",
  "type": "cst.turn",
  "time": "2026-11-16T21:27:36.723Z",
  "source": "cst/engine",
  "channel": "web",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "specversion": "cst.event.v1",
  "correlation_id": "web_3ec1a8a1-9ff9-4c28-b5df-665b16fa2f8c",
  "customer": {
    "name": "cust_debf555c-b37d-4e92-bb15-597e169f1b38",
    "role": "owner",
    "farm_ids": [
      "21dde23e-f7f6-46bc-9b54-e97fabaaafd7",
      "ed95e120-74c4-4126-a2e9-0e4ffa9275e6",
      "farm-austin-hq"
    ],
    "is_known": true,
    "person_id": "debf555c-b37d-4e92-bb15-597e169f1b38",
    "tenant_id": "tenant-vfarm-01",
    "phone_e164": "+9230****3844",
    "project_id": "proj-vfarm-main",
    "customer_ref": "cust_debf555c-b37d-4e92-bb15-597e169f1b38"
  },
  "data": {
    "turn_id": "web_3ec1a8a1-9ff9-4c28-b5df-665b16fa2f8c",
    "conversation_id": "conv_ce5e9bf3-6975-43c3-bd05-dc876974b545",
    "direction": "inbound",
    "channel": "web",
    "status": "ok",
    "intent": "status",
    "text": "What is the status of my farm?",
    "message": "What is the status of my farm?",
    "reply_text": "Your farm has 0 devices. 0 are online, 0 are offline, and 0 are unhealthy. vFarm farm health: DEGRADED. I could retrieve 0 unit readings. No per-unit readings are available at this time.",
    "reply": "Your farm has 0 devices. 0 are online, 0 are offline, and 0 are unhealthy. vFarm farm health: DEGRADED. I could retrieve 0 unit readings. No per-unit readings are available at this time.",
    "duration": {
      "total_ms": 1499
    },
    "duration_ms": 1499,
    "incident_id": null,
    "tenant_id": "tenant-vfarm-01",
    "project_id": "proj-vfarm-main",
    "event_type": "cst.turn",
    "occurred_at": "2026-11-16T21:27:36.723Z",
    "reason": "Intent \"status\" successfully processed for project \"proj-vfarm-main\" (farms=[farm-austin-hq])",
    "error": null
  },
  "metadata": {
    "duration_ms": 1499,
    "incident_id": null,
    "conversation_id": "conv_ce5e9bf3-6975-43c3-bd05-dc876974b545"
  }
}
```

### 3.2 Flattened Dashboard Ingestion Output (`serializeForDashboard(event)`)
```json
{
  "id": "turn_evt_32fd6323-da9f-4037-b773-5e09059ad6f3",
  "event_type": "cst.turn",
  "specversion": "cst.event.v1",
  "source": "cst/engine",
  "time": "2026-11-16T21:27:36.723Z",
  "occurred_at": "2026-11-16T21:27:36.723Z",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "correlation_id": "web_3ec1a8a1-9ff9-4c28-b5df-665b16fa2f8c",
  "turn_id": "web_3ec1a8a1-9ff9-4c28-b5df-665b16fa2f8c",
  "conversation_id": "conv_ce5e9bf3-6975-43c3-bd05-dc876974b545",
  "direction": "inbound",
  "channel": "web",
  "status": "ok",
  "intent": "status",
  "text": "What is the status of my farm?",
  "message": "What is the status of my farm?",
  "reply_text": "Your farm has 0 devices. 0 are online, 0 are offline, and 0 are unhealthy. vFarm farm health: DEGRADED. I could retrieve 0 unit readings. No per-unit readings are available at this time.",
  "reply": "Your farm has 0 devices. 0 are online, 0 are offline, and 0 are unhealthy. vFarm farm health: DEGRADED. I could retrieve 0 unit readings. No per-unit readings are available at this time.",
  "duration": {
    "total_ms": 1499
  },
  "duration_ms": 1499,
  "latency_ms": 1499,
  "incident_id": null,
  "reason": "Intent \"status\" successfully processed for project \"proj-vfarm-main\" (farms=[farm-austin-hq])",
  "error": null,
  "customer_ref": "cust_debf555c-b37d-4e92-bb15-597e169f1b38",
  "phone_e164": "+9230****3844",
  "role": "owner",
  "farm_ids": [
    "21dde23e-f7f6-46bc-9b54-e97fabaaafd7",
    "ed95e120-74c4-4126-a2e9-0e4ffa9275e6",
    "farm-austin-hq"
  ],
  "person_id": "debf555c-b37d-4e92-bb15-597e169f1b38",
  "customer": {
    "name": "cust_debf555c-b37d-4e92-bb15-597e169f1b38",
    "role": "owner",
    "farm_ids": [
      "21dde23e-f7f6-46bc-9b54-e97fabaaafd7",
      "ed95e120-74c4-4126-a2e9-0e4ffa9275e6",
      "farm-austin-hq"
    ],
    "is_known": true,
    "person_id": "debf555c-b37d-4e92-bb15-597e169f1b38",
    "tenant_id": "tenant-vfarm-01",
    "phone_e164": "+9230****3844",
    "project_id": "proj-vfarm-main",
    "customer_ref": "cust_debf555c-b37d-4e92-bb15-597e169f1b38"
  },
  "metadata": {
    "duration_ms": 1499,
    "incident_id": null,
    "conversation_id": "conv_ce5e9bf3-6975-43c3-bd05-dc876974b545"
  }
}
```

---

## 4. Reviewer Sign-Off Block (Destiny Arupi)

- **Document Status:** `Proposed Engine-to-Dashboard Contract Mapping — Awaiting Destiny Review`
- **Reviewer:** Destiny Arupi (`U0AEW3TBYH1`, Monitoring & Research Twin Owner)
- **Sign-Off Status:** **`AWAITING DESTINY`**
- **Questions for Destiny's Explicit Decision:**
  1. Confirm whether the flattened `serializeForDashboard` output above matches the exact field names and types expected by `/api/engine/cst-events`.
  2. Confirm whether `intent`, `incident_id`, and `duration_ms` remaining optional in `CstTurnSchema` (populated when available, omitted on the wire when `undefined`) is accepted.
