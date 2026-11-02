# CS Twin v1 — First Working Slice Specification
**Loop:** `LOOP-1789824812431-IWKX`  
**Watch:** `DW-1793621652529-3PQN`  
**Date:** 2026-11-02  
**Owner:** Ahad / CST Engineering  
**Scope:** Smallest tenant-aware text-in / text-out API slice reusing existing Voice 1 workflow

---

## 1. Overview & Architecture

CS Twin v1 provides a unified conversational core across both voice and text modalities:
- **Tenancy & Isolation:** Every turn resolves tenant, project, and speaker identity strictly from the incoming channel context (Twilio service number binding or Web session cookie). Request-body overrides of tenant/speaker/project are strictly forbidden and ignored.
- **Unified Pipeline:** Text requests go through `CoreEngine.processEnvelope()`, which uses the exact same `IntentRouter`, `VfarmConnector`, and `BharagRagConnector` as the voice channel (`VoiceInterface.processVoiceTurn()`).
- **No Second TTS Stack:** Audio synthesis utilizes the single existing ElevenLabs integration (`AudioSynthesisConnector`), configured via `VFARM_ELEVENLABS_VOICE_ID` and `VFARM_ELEVENLABS_MODEL_ID`. Web audio and Twilio voice consume the same generated audio assets without parallel architectures.

---

## 2. API Endpoints

### 2.1 Web Text Session Initialization
- **Route:** `POST /api/web/session`
- **Authentication:** Web user login / bearer token
- **Response:**
  ```json
  {
    "session_id": "sess_uuid",
    "tenant_id": "tenant-vfarm-01",
    "project_id": "proj-vfarm-main",
    "customer": {
      "customer_ref": "cust_uuid",
      "role": "owner",
      "farm_ids": ["farm_austin_main"]
    }
  }
  ```

### 2.2 Text Conversation Turn (Text-In / Text-Out)
- **Route:** `POST /api/web/chat`
- **Request Body:**
  ```json
  {
    "session_id": "sess_uuid",
    "message": "What is the status of my farm?"
  }
  ```
- **Processing:**
  1. Validates `session_id` against active sessions.
  2. Resolves authoritative `tenant_id`, `project_id`, `speaker_ref`, and allowed `farm_ids`.
  3. Constructs `MessageEnvelope` (`channel: 'web'`).
  4. Invokes `CoreEngine.processEnvelope(envelope)`.
  5. Records security ledger audit row.
  6. Publishes `cst.turn` event asynchronously.
- **Response Body:**
  ```json
  {
    "turn_id": "web_uuid",
    "reply_text": "Farm status: All 4 units operational...",
    "status": "ok"
  }
  ```

---

## 3. Verification & Automated Tests

- **Session & Isolation Verification:** Covered in `tests/web/web_interface.test.ts` (5/5 PASS):
  - Session creation with server-resolved context.
  - Rejection of invalid session IDs.
  - Complete `MessageEnvelope` processing and response verification.
  - Rejection/omission of body overrides (`tenant_id`, `speaker`, `farm_id`).
  - Strict enforcement of speaker farm-boundary access (out-of-scope farm returns refused).
- **Core Engine Integration:** Tested in `tests/integration/dashboard_e2e.test.ts` and `tests/router/router.test.ts`.

---

## 4. Current Status & External Blockers

| Component | Status | Blocker / Dependency |
|-----------|--------|----------------------|
| Text-in / Text-out API | **WORKING (Local)** | None (code complete, tests pass) |
| Web Audio playback | **WIRED** | Depends on `ELEVENLABS_API_KEY` for live synthesis (mocked in tests) |
| Twilio Voice 1 | **WIRED** | Pending authorized live execution with `--live` flag |
| Production Webhook | **DEPLOYED (main)** | Pending redeployment of latest branch |

