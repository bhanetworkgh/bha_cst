# CS Twin v1 — Architecture and API Contract

**Owner:** Ahad  
**Loop:** LOOP-1789824812431-IWKX  
**Decision Watch:** DW-1793621652529-3PQN  
**Status:** Architecture + contract (implementation in progress)  
**Date:** 2026-11-02

## 1. Brain API (text-in/text-out)

Single endpoint, channel-agnostic orchestration. Web audio and Twilio both call the same voice workflow, which calls the same brain.

### Request schema

```json
POST /api/v1/cs-twin/message
{
  "tenant_id": "string (required)",
  "project_id": "string (required)",
  "speaker_ref": "string (required, E.164 or speaker id)",
  "channel": "text | voice_web | voice_twilio",
  "message": "string (required, user input text)",
  "conversation_id": "string (optional)",
  "correlation_id": "string (optional, generated if absent)",
  "identity_token": "string (optional, vFarm-backed)"
}
```

### Response schema

```json
{
  "correlation_id": "string",
  "conversation_id": "string",
  "tenant_id": "string",
  "project_id": "string",
  "speaker_ref": "string",
  "reply": "string",
  "status": "ok | refused | failed | timeout",
  "error": "string | null",
  "audio": { "audio_id": "string", "mime_type": "string" }  // voice channels only
}
```

### Tenant/project context
- `tenant_id` and `project_id` are mandatory. Resolved and validated against vFarm authorization before any processing.
- Missing/invalid tenant or project → 400/403, no fabricated reply.

### Speaker identity
- Speaker resolved via vFarm identity. `assertSpeakerFarmAccess(speaker, farmId)` enforced before any vFarm call.
- Missing identity → 401. Unauthorized speaker → 403.

### Channel
- `text`: returns JSON reply only.
- `voice_web` / `voice_twilio`: same orchestration + existing ElevenLabs/Twilio TTS, returns playable audio + reply text.

### Correlation ID
- Client may supply; server generates UUID if absent. Propagated through conversation persistence, vFarm calls, dashboard publication, security ledger.

### Conversation ID
- Supplied or created. Persisted with tenant/project/speaker attribution.

### Error responses
- 400 invalid request schema
- 401 missing identity
- 403 unauthorized speaker / tenant mismatch / invalid project
- 404 unknown conversation
- 502 upstream (vFarm/BHARAG) failure — no fabricated reply
- 504 timeout
- 500 internal

### Timeout behavior
- Text path: 30s hard ceiling.
- Voice path: 10s turn deadline (Twilio webhook constraint), reuse `runVoiceTurnWithDeadline`.

### Auth
- Programmatic API key (`requireProgrammaticApiKey`) for server-to-server; Twilio signature validation for inbound voice; speaker identity for end users.

### Logging/audit
- Correlation ID in every log line. Security ledger event per request. No secret/PII leakage (masked phones).

## 2. Shared orchestration

- One CS Twin brain (CoreEngine) handles text-in/text-out.
- Voice 1 workflow wraps brain + existing AudioSynthesizer (ElevenLabs) + Twilio playback.
- No second TTS stack. Reuse `createElevenLabsAudioSynthesizer` and `runVoiceTurnWithDeadline`.
- Conversation persistence via DbClient; correlation IDs preserved.
- vFarm/BHARAG boundaries unchanged.

## 3. Failure handling
- Upstream errors surface as `status: failed` with `error`; no fabricated responses.
- TTS failure → text reply still returned where possible, audio omitted, recorded in security ledger.
- Voice timeout → 504, no persistence of partial transcript.

## 4. Tests (required)
- Authorized text request
- Unauthorized speaker
- Tenant isolation
- Invalid project
- Missing identity
- Missing vFarm authorization
- Successful voice request
- Voice timeout
- TTS failure
- Provider failure
- Conversation persistence
- Correlation ID continuity
- Duplicate/retried request behavior

## 5. Remaining work
- Implement `/api/v1/cs-twin/message` route + controller.
- Wire voice web + Twilio to shared orchestration.
- Add deterministic tests listed above.
- Deploy + verify.
