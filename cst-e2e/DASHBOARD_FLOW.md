# CST Engine Dashboard Telemetry Flow

This document details the telemetry publishing pipeline connecting CST to the Engine Dashboard.

---

## Overview

The Engine Dashboard ingests operational telemetry to monitor AI twin performance, conversational accuracy, latency, and delivery success. The two primary events emitted are:
1. `cst.turn`: Emitted when an inbound query is processed by the Core Engine.
2. `cst.delivery`: Emitted when the outbound reply is handed off or delivered by Twilio.

---

## 1. Event Contracts

### `cst.turn` (`engine/src/contracts/events.ts` & `engine/src/publishers/dashboard.ts`)
- **Type**: `cst.turn`
- **Fields**:
  - `event_id`: Unique UUID for the event.
  - `timestamp`: ISO timestamp.
  - `tenant_id`: Resolved tenant ID (e.g. `tenant-vfarm-01`).
  - `project_id`: Resolved project ID (e.g. `proj-vfarm-main`).
  - `channel`: `sms` | `voice` | `web`.
  - `turn_id`: Inbound message identifier (`MessageSid` or call SID).
  - `customer_ref`: Resolved vFarm `person_id`.
  - `phone_e164`: Masked or normalized E.164 phone.
  - `role`: Resolved user role (`owner`, `manager`, `tech`, `unknown`).
  - `farm_ids`: Array of authorized farm UUIDs.
  - `intent`: Detected intent (`status`, `knowledge`, `alert`, `general`).
  - `status`: One of `ANSWERED`, `REFUSED`, `FALLBACK`, `HANDOFF`, `ERROR`.
  - `latency_ms`: Total engine processing duration in milliseconds.
  - `prompt_tokens` & `completion_tokens`: Token usage metrics.

### `cst.delivery` (`engine/src/contracts/events.ts` & `engine/src/publishers/delivery.ts`)
- **Type**: `cst.delivery`
- **Fields**:
  - `event_id`: Unique UUID.
  - `timestamp`: ISO timestamp.
  - `tenant_id`: Resolved tenant ID.
  - `project_id`: Resolved project ID.
  - `turn_id`: **CRITICAL JOIN KEY** (exact match to `cst.turn.turn_id`).
  - `channel`: `sms` | `voice`.
  - `provider`: `twilio`.
  - `provider_message_id`: Twilio message SID.
  - `status`: `delivered` | `queued` | `failed`.
  - `delivery_latency_ms`: Time from turn completion to Twilio dispatch.

---

## 2. The `turn_id` Correlation Join

The Dashboard UI and analytics layer rely on joining `cst.turn` with `cst.delivery` using `turn_id`:

```
Twilio Inbound Message (MessageSid: SMxxxxxxxxxxxx)
          │
          ├─────────────────────────────────────────────┐
          ▼                                             ▼
     `cst.turn`                                   `cst.delivery`
 turn_id: "SMxxxxxxxxxxxx"                     turn_id: "SMxxxxxxxxxxxx"
 status: "ANSWERED"                            status: "delivered"
 latency_ms: 320                               delivery_latency_ms: 180
          │                                             │
          └──────────────────────┬──────────────────────┘
                                 ▼
                     [Dashboard Joined View]
               Conversation Turn -> Delivery Confirmed
```

If an outbound delivery event lacks `turn_id`, the Dashboard cannot join the events and marks the turn as orphaned or pending delivery.

---

## 3. Dashboard Endpoint and Ingestion

- **Ingestion Route**: `POST /api/events` (configured via `ENGINE_DASHBOARD_URL`).
- **Authorization**: `X-Dashboard-Key` or `Authorization: Bearer <key>` (configured via `ENGINE_DASHBOARD_KEY`).
- **Payload Shape**: Array or single JSON object adhering to `CstTurnEventSchema` or `CstDeliveryEventSchema`.

---

## 4. Retry and Resiliency Behavior

- **Outbound Queue Retries**: If Twilio dispatch fails temporarily, messages remain in `outbound_messages` with status `retry` and backoff exponentially (up to 3 retries).
- **Dashboard Dispatch Retries**: Failed event transmissions are logged with full contextual error payloads. CST maintains local Postgres copies (`cst_turns`, `outbound_messages`) to ensure audit durability even if the remote dashboard is unreachable.

---

## 5. Dry-Run Behavior

- When `ENGINE_DASHBOARD_URL` is unset or `DRY_RUN=true`:
  - `DashboardPublisher` and `DeliveryPublisher` log the serialized JSON event to the local system log.
  - No remote HTTP requests are attempted.
  - Core message processing and customer delivery proceed uninterrupted without throwing errors.
