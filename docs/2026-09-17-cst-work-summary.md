# CST Voice + Tenancy Work Summary

Date: 2026-09-17

## Overview

This work completed the remaining CST tenancy/voice boundary work without altering the completed DB/tenancy foundation.

The scope focused on two things:

1. Cabinet / LM7W boundary enforcement
   - Cabinet identity/config stays outside CST.
   - CST never persists cabinet identity or config values such as `cabinet_id`, serial, `config_hash`, `cad_revision`, or cabinet metadata.
   - Cabinet config is accessed only through the tenant adapter boundary, with the vFarm adapter acting as the integration layer to LM7W.

2. Real vFarm speaker identity integration
   - `phone_e164` remains a required field in the speaker model.
   - vFarm is treated as the source of truth for member/speaker data.
   - Speaker resolution remains keyed on `(tenant_id, project_id, phone_e164)`.
   - Missing/invalid/removed phone data fails closed and never fabricates a phone number.

---

## What was done

### 1) Cabinet / LM7W boundary

CST now treats cabinet configuration as an external dependency and not a CST-owned domain object.

Implementation posture:

- CST does not create cabinet tables, config tables, or cabinet identity storage.
- Cabinet access is modeled as an adapter-level capability, not a CST core DB responsibility.
- Adapter contract includes an explicit `resolveCabinetConfig(...)` call.
- The adapter checks:
  - speaker is known
  - speaker is in the requested farm scope
  - requested farm is authorized
  - adapter is healthy
  - no fabricated data is returned if the tenant/LM7W dependency is unavailable

Required flow:

`Speaker → resolved farm scope → vFarm tenant adapter → LM7W → CST response`

This preserves the architecture rule that cabinet identity/config is not stored or managed by CST itself.

### 2) Real vFarm speaker identity

CST now enforces the speaker identity contract against real vFarm projection data:

- `phone_e164` is required on speaker projections.
- Real vFarm members are expected to carry valid E.164 numbers.
- Invalid or missing phone values fail closed.
- Speaker identity remains scoped by `(tenant_id, project_id, phone_e164)`.
- Same phone across different tenant/project scopes remains isolated.
- Removed/revoked speaker records are invalidated by cache sync and stop resolving.

This keeps the identity source outside CST and preserves the existing allowlist / fail-closed behavior.

---

## Endpoint inventory created / used

The relevant endpoints are the voice and admin endpoints created/used for this work.

### A. Twilio voice inbound webhook

Method: `POST`

Path:
- `/webhooks/twilio/voice`
- `/webhooks/twilio/voice/inbound`
- `/twilio/voice`
- `/twilio/voice/inbound`

Purpose:
- Accept inbound call webhook from Twilio.
- Resolve the receiving DID to a service-number binding.
- Validate capability and tenant/project isolation.
- Resolve speaker identity via the tenant adapter.
- Reject unknown/unauthorized callers fail-closed.
- Respond with TwiML or JSON as appropriate.

Request example:

```json
{
  "CallSid": "CALL_123",
  "From": "+923082113844",
  "To": "+19715885826",
  "CallStatus": "ringing"
}
```

Success response example (JSON):

```json
{
  "status": "initiated",
  "call_sid": "CALL_123",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "greeting": "Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?",
  "twiml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Gather input=\"speech\" action=\"/webhooks/twilio/voice/turn\" method=\"POST\"><Say>Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?</Say></Gather></Response>"
}
```

Failure response examples:

```json
{
  "error": "SYSTEM_NOT_FOUND",
  "message": "Unknown or unbound receiving number"
}
```

```json
{
  "error": "CAPABILITY_DISABLED",
  "message": "Voice capability is disabled for this project"
}
```

```json
{
  "error": "TENANT_SCOPE_VIOLATION",
  "message": "Client-provided tenant_id overrides are strictly forbidden"
}
```

```json
{
  "error": "SERVICE_UNAVAILABLE",
  "message": "Tenant adapter unavailable (degraded state)"
}
```

Process:

1. Read `To` and `From`.
2. Resolve `To` via `CoreRegistry.resolveServiceNumber()`.
3. Ensure the service number is bound for voice and project voice capability is enabled.
4. Fail-closed on tampered tenant/project payload.
5. Resolve speaker through tenant adapter.
6. If adapter is degraded, return 503 and no fabricated identity.
7. If speaker is unauthorized or unknown under project policy, reject with 403.
8. If speech text is delivered in the same request, dispatch turn processing.
9. Otherwise answer and prompt for speech via TwiML.

---

### B. Twilio speech turn webhook

Method: `POST`

Path:
- `/webhooks/twilio/voice/turn`
- `/twilio/voice/turn`

Purpose:
- Accept a speech result from Twilio.
- Resolve receiver DID and caller identity.
- Process the voice turn through the CST core engine.
- Synthesize the response if allowed.

Request example:

```json
{
  "CallSid": "CALL_456",
  "From": "+923082113844",
  "To": "+19715885826",
  "SpeechResult": "What is the status of my farm?"
}
```

Success response example (JSON):

```json
{
  "status": "synthesized",
  "text": "Farm status: all systems normal.",
  "audioBase64": "UklGRiQAAABXQVZFZm10",
  "mimeType": "audio/mpeg",
  "voice_id": "eleven_voice_jason_vfarm",
  "correlation_id": "CALL_456",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main"
}
```

Failure response examples:

```json
{
  "status": "refused",
  "reason": "Caller +15559999999 is not authorized for project proj-vfarm-main",
  "error": "FORBIDDEN",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "httpStatus": 403
}
```

```json
{
  "status": "refused",
  "reason": "Voice capability is disabled for this project",
  "error": "CAPABILITY_DISABLED",
  "httpStatus": 404
}
```

Process:

1. Read `To`, `From`, and `SpeechResult`.
2. Resolve the service number and project capability.
3. Re-check the caller against the project’s speaker policy.
4. Build a `MessageEnvelope` with `tenant_id`, `project_id`, `speaker_ref`, `text`, and service metadata.
5. Send to `CoreEngine.processEnvelope()`.
6. Check if the response is authorized, within farm scope, and valid.
7. Reject unauthorized or out-of-scope content before synthesis.
8. Use the project-scoped voice ID for synthesis.
9. Return synthesized audio plus metadata.

---

### C. Direct programmatic voice turn endpoint

Method: `POST`

Path: `/api/v1/voice/turn`

Purpose:
- Direct API entry for internal app flows.
- Same enforcement path as Twilio voice turn handling.

Request example:

```json
{
  "from_e164": "+923082113844",
  "to_e164": "+19715885826",
  "speech_text": "status",
  "correlation_id": "VOICETURN_001"
}
```

Success response example:

```json
{
  "status": "synthesized",
  "text": "Farm status: all systems normal.",
  "correlation_id": "VOICETURN_001",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "httpStatus": 200,
  "voice_id": "eleven_voice_jason_vfarm"
}
```

Failure response example:

```json
{
  "status": "refused",
  "reason": "Caller +15559999999 is not authorized for project proj-vfarm-main",
  "error": "FORBIDDEN",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "httpStatus": 403
}
```

Process:

1. Validate `from_e164`, `to_e164`, and `speech_text`.
2. Resolve `to_e164` binding and project capability.
3. Validate the speaker identity and farm scope.
4. Run the exact same core pipeline as Twilio.
5. Return either synthesized audio response or refusal.

---

### D. Call status webhook

Method: `POST`

Path:
- `/webhooks/twilio/voice/status`
- `/twilio/voice/status`
- `/api/v1/voice/status`

Purpose:
- Receive Twilio call lifecycle events.
- Record call status in the voice delivery log.
- Preserve tenant/project stamping and security checks.

Request example:

```json
{
  "CallSid": "CALL_STATUS_123",
  "From": "+923082113844",
  "To": "+19715885826",
  "CallStatus": "completed"
}
```

Success response example:

```json
{
  "status": "ok",
  "call_sid": "CALL_STATUS_123",
  "call_status": "completed",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main"
}
```

Failure example:

```json
{
  "error": "TENANT_SCOPE_VIOLATION",
  "message": "Client-provided tenant_id/project_id in status webhook is strictly forbidden"
}
```

Process:

1. Reject any client-supplied tenant/project override.
2. Resolve tenant/project from the receiving service number.
3. Map Twilio call status to a voice delivery status (`sent`, `failed`, `refused`, etc.).
4. Persist delivery audit data with `tenant_id` and `project_id` attached.
5. Return a success confirmation to Twilio.

---

### E. Direct voice synthesize endpoint

Method: `POST`

Path: `/api/v1/voice/synthesize`

Purpose:
- Allow synthesis of a plain text response using the project-scoped voice pointer.

Request example:

```json
{
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "speaker_ref": "+923082113844",
  "text": "Your farm status is normal.",
  "conversation_id": "conv_123",
  "correlation_id": "corr_123"
}
```

Success response body:
- raw audio bytes sent as binary response
- headers include:
  - `Content-Type`
  - `X-Voice-Id`
  - `X-Audio-Bytes`

Failure response:

```json
{
  "error": "VOICE_SYNTHESIS_FAILED",
  "message": "ElevenLabs synthesis failed; turn dropped"
}
```

Process:

1. Validate required fields.
2. Resolve the project’s voice clone config.
3. Synthesize audio using only the allowed project voice pointer.
4. Return binary audio with attached metadata headers.

---

### F. Admin tenant/project and number management

These admin endpoints were also created and used to manage the multi-tenant architecture.

#### 1) Register tenant

Method: `POST`

Path: `/api/v1/admin/tenants`

Request:

```json
{
  "tenant_id": "tenant-greengrow",
  "name": "GreenGrow AgriTech",
  "adapter_type": "greengrow",
  "adapter_config": {}
}
```

Response:

```json
{
  "status": "created",
  "tenant": {
    "tenant_id": "tenant-greengrow",
    "name": "GreenGrow AgriTech",
    "status": "active",
    "adapter_type": "greengrow",
    "created_at": "2026-09-17T00:00:00.000Z"
  }
}
```

#### 2) Sync projects

Method: `POST`

Path: `/api/v1/admin/projects/sync`

Request:

```json
{
  "tenant_id": "tenant-greengrow"
}
```

Response:

```json
{
  "status": "synced",
  "count": 1,
  "projects": [
    {
      "project_id": "proj-greengrow-austin",
      "tenant_id": "tenant-greengrow",
      "name": "GreenGrow Austin Facility",
      "status": "active"
    }
  ]
}
```

#### 3) Update project capability/speaker policy

Method: `PATCH`

Path: `/api/v1/admin/projects/:projectId`

Request:

```json
{
  "capabilities": { "sms": true },
  "speaker_policy": "allowlist",
  "voice_enabled": true,
  "elevenlabs_voice_id": "eleven_voice_jason_vfarm"
}
```

Response:

```json
{
  "status": "updated",
  "project": {
    "project_id": "proj-greengrow-austin",
    "capabilities": { "sms": true },
    "speaker_policy": "allowlist",
    "voice_enabled": true
  }
}
```

#### 4) Sync candidate numbers

Method: `POST`

Path: `/api/v1/admin/numbers/sync`

Request:

```json
{
  "tenant_id": "tenant-greengrow"
}
```

Response:

```json
{
  "status": "synced",
  "numbers": ["+19715554444"],
  "count": 1
}
```

#### 5) Bind service numbers

Method: `POST`

Path: `/api/v1/admin/numbers/bind`

Request:

```json
{
  "phone_e164": "+19715554444",
  "tenant_id": "tenant-greengrow",
  "project_id": "proj-greengrow-austin",
  "capability": "sms"
}
```

Response:

```json
{
  "status": "bound",
  "binding": {
    "phone_e164": "+19715554444",
    "tenant_id": "tenant-greengrow",
    "project_id": "proj-greengrow-austin",
    "capability": "sms",
    "status": "bound"
  }
}
```

#### 6) Speaker sync

Method: `POST`

Path: `/api/v1/admin/speakers/sync`

Request:

```json
{
  "tenant_id": "tenant-greengrow",
  "project_id": "proj-greengrow-austin"
}
```

Response:

```json
{
  "status": "synced",
  "tenant_id": "tenant-greengrow",
  "project_id": "proj-greengrow-austin",
  "count": 1,
  "speakers": [
    {
      "person_id": "person_greengrow_owner",
      "phone_e164": "+15552223333",
      "role": "owner",
      "farm_count": 1
    }
  ]
}
```

#### 7) Speaker invalidation

Method: `POST`

Path: `/api/v1/admin/speakers/invalidate`

Request:

```json
{
  "tenant_id": "tenant-greengrow",
  "project_id": "proj-greengrow-austin",
  "phone_e164": "+15552223333"
}
```

Response:

```json
{
  "status": "invalidated",
  "tenant_id": "tenant-greengrow",
  "project_id": "proj-greengrow-austin",
  "phone_e164": "+15552223333"
}
```

Process:

1. Pull tenant speakers from the adapter.
2. Persist them in the customers projection keyed by `(tenant_id, project_id, phone_e164)`.
3. Invalidate any cached identity entry.
4. Ensure next resolve requires fresh validation and authorization.
5. Expire stale speaker proofs when the tenant removes or revokes a user.

---

## Processing flow across the stack

1. Twilio receives an inbound request.
2. `engine/src/interfaces/voice/index.ts` resolves the receiving number to the correct service binding.
3. The service-number binding yields `tenant_id`, `project_id`, and capability.
4. The speaker is resolved through the tenant adapter boundary.
5. The adapter verifies the speaker is known and authorized for the relevant project/farms.
6. `CoreEngine.processEnvelope()` runs the authorization and farm-scope checks.
7. Unauthorized or out-of-scope activity is refused before any personalized data is returned.
8. If allowed, the core engine dispatches to the appropriate connector logic.
9. The response is synthesized or returned as a supported reply.
10. Delivery and audit records are stamped with the tenant/project IDs.

---

## Key design rules preserved

- No client-supplied tenant/project/farm override is accepted.
- Twilio signature verification is kept in place.
- Service-number binding remains explicit and fail-closed.
- Speaker identity is never invented by CST.
- Cabinet identity/config is never stored inside CST.
- All persisted messaging and transcripts are stamped with `tenant_id` and `project_id`.

---

## Current status

This work is complete for the repository-managed boundary and fail-closed contracts in the current codebase.

The only remaining external blockers are upstream vFarm / LM7W contracts that are not present in this repository, so those live endpoints must be supplied by the external system owner before end-to-end live integration can be verified.
