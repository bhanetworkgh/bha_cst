# CST Source Code Manifest

This document describes every source file included in `source/` for understanding and executing the real CST E2E acceptance tests.

---

## 1. CST Core (`source/cst/`)

### `source/cst/CoreRegistry.ts`
- **Purpose**: Central routing table for service number bindings, tenant adapter registrations, active projects, and speaker identity resolution/caching.
- **Why Required for E2E**: Authoritative lookup for receiving numbers (`resolveServiceNumber`) and dynamic speaker lookup (`resolveSpeaker`).
- **Important Functions/Classes**:
  - `CoreRegistry.bindServiceNumber(...)`
  - `CoreRegistry.resolveServiceNumber(phoneE164: string)`
  - `CoreRegistry.resolveProjectServiceNumber(tenantId, projectId, capability)`
  - `CoreRegistry.resolveSpeaker({ tenantId, projectId, phoneE164 })`
  - `CoreRegistry.invalidateSpeakerCache(...)`
- **Dependencies**: `VfarmTenantAdapter`, `DbClient`, `Logger`.

### `source/cst/CoreEngine.ts`
- **Purpose**: Core request processing engine; evaluates speaker authorization, farm scope, intent routing, and dispatches canonical `cst.turn` telemetry.
- **Why Required for E2E**: Implements the farm-scope gating logic (`authorizedFarmIds`), dispatches to connectors, and emits `cst.turn` events.
- **Important Functions/Classes**:
  - `CoreEngine.processEnvelope(envelope, speaker)`
  - `CoreEngine.emitTurn(...)`
- **Dependencies**: `IntentRouter`, `DashboardPublisher`, `DbClient`.

### `source/cst/MessageEnvelope.ts`
- **Purpose**: Uniform interface payload wrapper for inbound and outbound communication across SMS, Voice, and Web.
- **Why Required for E2E**: Canonical message shape passed into `CoreEngine.processEnvelope`.
- **Important Functions/Classes**:
  - `interface MessageEnvelope`
- **Dependencies**: None.

### `source/cst/types.ts`
- **Purpose**: Common type definitions for projects, tenants, capabilities, and service number bindings.
- **Why Required for E2E**: Defines `ServiceNumberBinding`, `Project`, and `Tenant` data structures.
- **Important Functions/Classes**:
  - `interface ServiceNumberBinding`
  - `interface Project`
  - `interface Tenant`
- **Dependencies**: None.

---

## 2. Identity (`source/identity/`)

### `source/identity/IdentityResolver.ts`
- **Purpose**: Legacy / fallback identity resolver.
- **Why Required for E2E**: Included as verification reference to prove that Voice and SMS pipelines do NOT use legacy identity, but instead route through `CoreRegistry.resolveSpeaker` -> `VfarmTenantAdapter`.
- **Important Functions/Classes**:
  - `IdentityResolver.resolve(...)`
  - `getPermissionsForRole(role)`
- **Dependencies**: `DbClient`.

### `source/identity/permissions.ts`
- **Purpose**: Role-based access control (RBAC) permission definitions for roles (`owner`, `manager`, `tech`, `unknown`).
- **Why Required for E2E**: Maps vFarm roles (`admin`, `manager`, `technician`) to CST capabilities (`read:telemetry`, `read:knowledge`, `read:media`, etc.).
- **Important Functions/Classes**:
  - `ROLE_PERMISSIONS`
  - `hasPermission(role, permission)`
- **Dependencies**: None.

---

## 3. vFarm Adapter (`source/vFarm/`)

### `source/vFarm/VfarmTenantAdapter.ts`
- **Purpose**: Tenant adapter implementing live integration with the vFarm platform; handles speaker identity resolution, authoritative organization member verification, and live user farm grants.
- **Why Required for E2E**: The authoritative bridge between CST and vFarm; resolves `phone_e164` to `person_id` and queries live farm grants.
- **Important Functions/Classes**:
  - `VfarmTenantAdapter.resolveSpeaker(...)`
  - `VfarmTenantAdapter.pullSpeakers(...)`
  - `VfarmTenantAdapter.listFarmDevices(...)`
- **Dependencies**: `VfarmLiveClient`, `VfarmHttpClient`, `DbClient`.

### `source/vFarm/VfarmLiveClient.ts`
- **Purpose**: Live HTTP client interacting directly with vFarm REST endpoints (e.g. `https://bhavfarm1.duckdns.org`).
- **Why Required for E2E**: Executes raw upstream calls: `listOrganizationMembers`, `getUserFarmGrants`, `getInventory`, `getTelemetry`.
- **Important Functions/Classes**:
  - `VfarmLiveClient.listOrganizationMembers(orgId, token)`
  - `VfarmLiveClient.getUserFarmGrants(userId, token)`
  - `VfarmLiveClient.getDashboardData(farmId)`
- **Dependencies**: `zod`, Node `fetch`.

### `source/vFarm/VfarmHttpClient.ts`
- **Purpose**: Normalized HTTP client interface for standard vFarm operations.
- **Why Required for E2E**: Handles low-level auth headers (`X-Farm-Key` or `Bearer <JWT>`) and response schemas.
- **Important Functions/Classes**:
  - `VfarmHttpClient.get(...)`
  - `VfarmHttpClient.getUserFarmGrants(userId)`
- **Dependencies**: `Logger`, `VfarmApiError`.

---

## 4. Twilio & Telephony (`source/twilio/`)

### `source/twilio/sms_interface.ts`
- **Purpose**: Webhook ingress for Twilio SMS (`POST /webhooks/twilio/sms`).
- **Why Required for E2E**: Entry point for all inbound SMS traffic; performs Twilio signature verification, service number tenancy binding, deduplication, async `CoreEngine` invocation, and queueing of outbound SMS.
- **Important Functions/Classes**:
  - `smsInterfaceRouter`
  - Middlewares: `verifyTwilioSignature`, Tenancy Resolution, Tenancy Gate
- **Dependencies**: `CoreRegistry`, `CoreEngine`, `normalizeTwilioInbound`, `DbClient`.

### `source/twilio/voice_interface.ts`
- **Purpose**: Webhook ingress for Twilio Voice (`/twilio/voice`, `/twilio/voice/turn`, `/twilio/voice/status`).
- **Why Required for E2E**: Entry point for Voice calls; proves live vFarm-backed identity resolution via `CoreRegistry.resolveSpeaker` and dynamic TwiML generation.
- **Important Functions/Classes**:
  - `voiceInterfaceRouter`
  - Inbound call handler, Speech turn handler
- **Dependencies**: `CoreRegistry`, `ElevenLabsClient`, `CoreEngine`.

### `source/twilio/outbound.ts`
- **Purpose**: Twilio SMS outbound delivery worker with rate limiting, retry queue, and dashboard event dispatch.
- **Why Required for E2E**: Delivers the bot response via Twilio API and emits the joined `cst.delivery` event to the Engine Dashboard.
- **Important Functions/Classes**:
  - `processOutboundQueue()`
  - `sendTwilioMessage(msg)`
- **Dependencies**: `twilio` SDK, `DeliveryPublisher`, `DbClient`.

### `source/twilio/signature.ts`
- **Purpose**: Twilio request signature validator using HMAC-SHA1.
- **Why Required for E2E**: Ensures webhooks originate authoritatively from Twilio.
- **Important Functions/Classes**:
  - `verifyTwilioSignature(req, res, next)`
- **Dependencies**: `twilio` SDK, `crypto`.

### `source/twilio/voice_router.ts`
- **Purpose**: Fast Express router mounting voice webhooks on root paths (`/voice/inbound`, `/voice/turn`).
- **Why Required for E2E**: Router mounting mechanism for Twilio Voice webhook callbacks.
- **Important Functions/Classes**:
  - `voiceRouter`
- **Dependencies**: Express.

---

## 5. Engine & Connectors (`source/engine/`)

### `source/engine/IntentRouter.ts`
- **Purpose**: Natural language intent classifier and handler dispatcher.
- **Why Required for E2E**: Determines whether inbound query is farm status, general hydroponics knowledge, alerts, or media capture, and routes to BHARAG or vFarm Telemetry.
- **Important Functions/Classes**:
  - `IntentRouter.detectIntent(text)`
  - `IntentRouter.routeAndHandle(message, identity)`
- **Dependencies**: `BharagRagConnector`, `VfarmTelemetryConnector`.

### `source/engine/bharag_rag.ts`
- **Purpose**: Connector to BHARAG RAG cluster (`https://bharag2.duckdns.org/api/v1/cluster/ask`).
- **Why Required for E2E**: Executes live hydroponics knowledge retrieval for customer inquiries.
- **Important Functions/Classes**:
  - `BharagRagConnector.queryKnowledge(query, context)`
- **Dependencies**: HTTP client, `Logger`.

### `source/engine/vfarm_telemetry.ts`
- **Purpose**: Live telemetry query connector for vFarm sensor and device data.
- **Why Required for E2E**: Fetches live sensor readings, rack status, and camera images for authorized farms.
- **Important Functions/Classes**:
  - `VfarmTelemetryConnector.getFarmStatus(farmId)`
- **Dependencies**: `CoreRegistry`, `VfarmTenantAdapter`.

---

## 6. Dashboard & Telemetry (`source/dashboard/`)

### `source/dashboard/dashboard_publisher.ts`
- **Purpose**: Publishes canonical `cst.turn` events to the Engine Dashboard.
- **Why Required for E2E**: Sends turn events (`turn_id`, intent, duration, tokens, status) to `ENGINE_DASHBOARD_URL`.
- **Important Functions/Classes**:
  - `DashboardPublisher.publishTurn(turnEvent)`
- **Dependencies**: Node `fetch`, `Logger`.

### `source/dashboard/delivery_publisher.ts`
- **Purpose**: Publishes canonical `cst.delivery` events to the Engine Dashboard.
- **Why Required for E2E**: Transmits delivery receipts correlating `turn_id` with Twilio `message_id`, channel latency, and status (`delivered`/`failed`).
- **Important Functions/Classes**:
  - `DeliveryPublisher.publishDelivery(deliveryEvent)`
- **Dependencies**: Node `fetch`, `Logger`.

### `source/dashboard/events_contract.ts`
- **Purpose**: Zod validation schemas for `cst.turn` and `cst.delivery` payloads.
- **Why Required for E2E**: Authoritative schema specification ensuring events match the Dashboard ingress contract.
- **Important Functions/Classes**:
  - `CstTurnEventSchema`
  - `CstDeliveryEventSchema`
- **Dependencies**: `zod`.
