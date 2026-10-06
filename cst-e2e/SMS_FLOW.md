# Authoritative CST SMS Pipeline Flow

This document details the complete end-to-end SMS request and delivery lifecycle.

---

## Architecture Flow

```
1. Customer Inbound SMS
       │
       ▼
2. Twilio Inbound Webhook (`POST /webhooks/twilio/sms`)
       │
       ├─► Middleware 1: `verifyTwilioSignature` (`engine/src/transport/twilio/signature.ts`)
       │     Validates HMAC-SHA1 signature using `TWILIO_AUTH_TOKEN`.
       │
       ├─► Middleware 2: Service Number Binding Resolution (`engine/src/interfaces/sms/index.ts`)
       │     Calls `CoreRegistry.resolveServiceNumber(req.body.To)`.
       │     Validates capability == 'sms' and project active.
       │     Populates `req.tenancy = { tenant_id, system_id: project_id, ... }`.
       │
       ├─► Middleware 3: Anti-Tamper Tenancy Gate
       │     Ensures client body cannot override server-resolved `tenant_id`.
       │
       ├─► Deduplication Check (`DbClient.saveInboundMessage`)
       │     Dedupes by Twilio `MessageSid`. If duplicate, responds HTTP 204 and terminates.
       │
       └─► Immediate Acknowledgement: Returns HTTP 204 to Twilio.
       │
       ▼
3. Async Core Engine Pipeline (`setImmediate`)
       │
       ├─► Uniform Envelope Construction:
       │     `envelope: MessageEnvelope = { tenant_id, project_id, channel: 'sms', ... }`
       │     `envelope.correlation_id = MessageSid` (critical join key)
       │
       ├─► Authoritative Speaker Identity Resolution:
       │     `speaker = await CoreRegistry.resolveSpeaker({ tenantId, projectId, phoneE164 })`
       │     Resolves `person_id`, role, and live `farm_ids` from vFarm.
       │
       ├─► Core Engine Processing (`CoreEngine.processEnvelope` in `engine/src/core/engine.ts`):
       │     1. Evaluates speaker role permissions (`hasPermission`).
       │     2. Validates requested farm against `speaker.farm_ids`.
       │     3. Routes query:
       │        - Telemetry query -> `VfarmTelemetryConnector` (`engine/src/connectors/vfarm.ts`)
       │        - Knowledge / RAG query -> `BharagRagConnector` (`engine/src/connectors/bharag_rag.ts`)
       │     4. Emits `cst.turn` telemetry event to Dashboard (`DashboardPublisher.publishTurn`).
       │
       ▼
4. Outbound Queue & Delivery (`DbClient.saveOutboundMessage` & `processOutboundQueue`)
       │
       ├─► Outbound message record saved with:
       │     `turn_id = envelope.correlation_id = MessageSid`
       │     `from_e164 = binding.phone_e164`
       │     `to_e164 = caller_e164`
       │     `body = reply_text`
       │
       ├─► `processOutboundQueue()` (`engine/src/transport/twilio/outbound.ts`):
       │     Picks pending messages, verifies rate limits.
       │     Dispatches SMS via Twilio REST API:
       │     `twilioClient.messages.create({ from, to, body, ... })`
       │
       └─► Dashboard Delivery Event Dispatch (`DeliveryPublisher.publishDelivery`):
             Publishes `cst.delivery` event with:
             `turn_id = outbound.turn_id` (matches `cst.turn.turn_id`)
             `status = 'delivered'`
             `twilio_message_sid = twilioResp.sid`
```

---

## Key Files and Functions

| Phase | File | Function / Route |
|---|---|---|
| Ingress & Validation | `engine/src/interfaces/sms/index.ts` | `POST /webhooks/twilio/sms` |
| Signature Security | `engine/src/transport/twilio/signature.ts` | `verifyTwilioSignature` |
| Tenancy Lookup | `engine/src/core/registry.ts` | `CoreRegistry.resolveServiceNumber` |
| Identity Resolution | `engine/src/adapters/vfarm/index.ts` | `VfarmTenantAdapter.resolveSpeaker` |
| Intent Routing | `engine/src/router/index.ts` | `IntentRouter.routeAndHandle` |
| Knowledge (RAG) | `engine/src/connectors/bharag_rag.ts` | `BharagRagConnector.queryKnowledge` |
| Farm Telemetry | `engine/src/connectors/vfarm.ts` | `VfarmTelemetryConnector.getFarmStatus` |
| Turn Telemetry | `engine/src/publishers/dashboard.ts` | `DashboardPublisher.publishTurn` |
| Outbound Delivery | `engine/src/transport/twilio/outbound.ts` | `processOutboundQueue` |
| Delivery Telemetry | `engine/src/publishers/delivery.ts` | `DeliveryPublisher.publishDelivery` |
