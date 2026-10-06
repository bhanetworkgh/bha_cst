# Authoritative CST Voice Pipeline Flow

This document details the complete end-to-end Twilio Voice call processing pipeline.

---

## Identity Mechanism Verification (SOURCE AUDIT)

> **CRITICAL VERIFICATION**:
> **Voice DOES NOT use the legacy `IdentityResolver`**.
>
> Source verification (`engine/src/interfaces/voice/index.ts` lines 133, 272, 756):
> Inbound Voice calls resolve speaker identity via:
> ```typescript
> const speaker = await CoreRegistry.resolveSpeaker({
>   tenantId: binding.tenant_id,
>   projectId: binding.project_id,
>   phoneE164: cleanFrom,
> });
> ```
> `CoreRegistry.resolveSpeaker` delegates directly to the registered `VfarmTenantAdapter.resolveSpeaker(...)`, executing the exact same upstream vFarm organization membership check and live `getUserFarmGrants` grant lookup as the SMS pipeline. Legacy `IdentityResolver` is never touched by the active Voice pipeline.

---

## Architecture Flow

```
1. Customer Inbound Voice Call
       │
       ▼
2. Twilio Voice Webhook (`POST /webhooks/twilio/voice` or `POST /twilio/voice`)
       │
       ├─► Middleware 1: Twilio Signature Verification (`verifyTwilioSignature`)
       │
       ├─► Middleware 2: Service Number Binding Resolution
       │     Calls `CoreRegistry.resolveServiceNumber(req.body.To)`.
       │     Verifies `binding.capability === 'voice'`.
       │     Verifies `project.voice_enabled === true`.
       │
       ├─► Speaker Identity Resolution:
       │     `speaker = await CoreRegistry.resolveSpeaker({ tenantId, projectId, phoneE164: req.body.From })`
       │     Resolves `person_id`, role, and live `farm_ids` from vFarm.
       │     If unknown caller: resolved with `is_known = false`, `role = 'unknown'`.
       │
       └─► Initial Greeting & TwiML Response:
             Generates initial greeting using ElevenLabs voice or system TTS.
             Returns TwiML `<Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST">`.
       │
       ▼
3. Customer Speech Turn (`POST /webhooks/twilio/voice/turn`)
       │
       ├─► Receives speech transcript from Twilio (`req.body.SpeechResult`).
       │
       ├─► Re-evaluates speaker context and project voice configuration.
       │
       ├─► Core Engine Turn Processing (`CoreEngine.processEnvelope`):
       │     - Checks speaker role permissions (`hasPermission`).
       │     - Enforces farm-scope authorization (`authorizedFarmIds = speaker.farm_ids`).
       │     - Inquires BHARAG or vFarm Telemetry based on user question.
       │     - Publishes canonical `cst.turn` event to the Engine Dashboard.
       │
       ├─► Voice Synthesis:
       │     Generates audio response using ElevenLabs voice clone (`elevenlabs_voice_id` on project)
       │     or falls back to high-quality Polly/Twilio TTS.
       │
       └─► Responds with TwiML `<Say>` and continues speech `<Gather>`.
       │
       ▼
4. Call Completion (`POST /webhooks/twilio/voice/status`)
       │
       ├─► Logs call duration, termination status, and delivery receipt.
       └─► Emits delivery metrics to Dashboard and Postgres audit tables.
```

---

## Key Files and Functions

| Phase | File | Function / Route |
|---|---|---|
| Inbound Call | `engine/src/interfaces/voice/index.ts` | `POST /webhooks/twilio/voice` |
| Voice Router | `engine/src/transport/voice/voice_router.ts` | `voiceRouter` |
| Speaker Identity | `engine/src/core/registry.ts` | `CoreRegistry.resolveSpeaker` |
| Live vFarm Grants | `engine/src/adapters/vfarm/index.ts` | `VfarmTenantAdapter.resolveSpeaker` |
| Speech Turn | `engine/src/interfaces/voice/index.ts` | `POST /webhooks/twilio/voice/turn` |
| Engine Processing | `engine/src/core/engine.ts` | `CoreEngine.processEnvelope` |
| Voice Synthesis | `engine/src/interfaces/voice/index.ts` | ElevenLabs integration |
| Call Status | `engine/src/interfaces/voice/index.ts` | `POST /webhooks/twilio/voice/status` |
