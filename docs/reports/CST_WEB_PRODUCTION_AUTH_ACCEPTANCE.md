# CST Web Production Authentication & Session Acceptance Report

**Component:** Customer Service Twin Web Interface (`/web`)  
**Primary Architecture Loop:** `LOOP-1789824812431-IWKX`  
**Affected Files:**  
- `engine/src/interfaces/web/index.ts`  
- `tests/web/web_interface.test.ts`  
- `tests/browser/web_auth_and_voice.spec.ts`  
- `tests/browser/chat_pending_feedback.spec.ts`  
**Date:** 2026-11-03  

---

## 1. Authentication & Security Architecture

The CST Web interface allows authorized farm managers and operators to log in, view their assigned farms, query live telemetry, and communicate with the AI assistant via text and voice.

### Core Security Guarantees:
1. **vFarm Upstream Authentication:**
   - Credentials (`email` and `password`) submitted to `POST /api/v1/web/login` are validated directly against vFarm's authoritative identity service (`POST /api/v1/auth/login`).
   - If credentials are invalid or the user is not found, CST fails closed and returns HTTP 401 with an explicit message: `"Invalid email or password, or user not registered in vFarm."`
   - CST never stores or caches raw customer passwords.
2. **Durable Session Management:**
   - Upon successful vFarm authentication, CST issues a cryptographically signed session token.
   - The token is transmitted via an `HttpOnly`, `SameSite=Lax`, `Secure` (in production) cookie (`cst_session`).
   - Sessions are bound to the user's `person_id`, `tenant_id`, `project_id`, and authorized `farm_ids`.
3. **Explicit Logout & Session Revocation:**
   - `POST /api/v1/web/logout` invalidates the active session token in CST's session store and clears the browser cookie.
   - Any subsequent call using an invalidated token fails immediately with HTTP 401 `INVALID_SESSION`.
4. **Farm Boundary Enforcement:**
   - Users can only query status and telemetry for farms present in their authenticated `farm_ids` list. Requests for unauthorized farms return HTTP 403 Forbidden.

---

## 2. Voice Integration (ElevenLabs)

The web interface integrates ElevenLabs voice synthesis for spoken customer responses:
1. **Endpoint:** `POST /api/v1/web/voice/synthesize`
2. **Authorization:** Requires an active `cst_session`.
3. **Synthesis Engine:** Uses the configured ElevenLabs API key and clone voice ID (`ELEVENLABS_VOICE_ID`) to generate high-fidelity PCM/MP3 audio.
4. **Browser Playback:** The client decodes and streams audio through the Web Audio API with visual playback state indicators (playing, paused, completed).

---

## 3. Browser UI Test Verification (Playwright)

Acceptance tests were executed across two viewport configurations using Playwright:
- **Desktop Chromium:** 1280x720 viewport.
- **Mobile Chrome:** Pixel 5 emulation (393x851 viewport, touch-enabled).

### Test Matrix & Outcomes:
| Test Description | Viewport | Result |
|---|---|---|
| Displays login form with email, password, and project selection | Desktop & Mobile | PASS |
| Displays explicit error message when credentials fail or user not in vFarm | Desktop & Mobile | PASS |
| Successful vFarm match logs in, connects related farms, permits chat | Desktop & Mobile | PASS |
| ElevenLabs voice synthesis request and audio playback interaction | Desktop & Mobile | PASS |
| Pending message renders immediately, assistant reply replaces pending | Desktop & Mobile | PASS |
| Composer disabled during processing prevents duplicate submissions | Desktop & Mobile | PASS |
| Server error renders explicit error banner and restores composer | Desktop & Mobile | PASS |
| Network interruption is explicit and manual retry preserves ordering | Desktop & Mobile | PASS |
| Request timeout renders retry button and restores message | Desktop & Mobile | PASS |
| ARIA live regions announce pending and incoming messages for a11y | Desktop & Mobile | PASS |

**Total:** 22 passed across both browsers in 5.3 seconds.

---

## 4. Evidence Artifacts

Visual evidence screenshots are captured on disk in `docs/evidence/browser/`:
- `ui-chat-farm-status-and-voice-chromium.png`
- `ui-chat-farm-status-and-voice-mobile-chrome.png`
- `ui-elevenlabs-voice-playback-chromium.png`
- `ui-elevenlabs-voice-playback-mobile-chrome.png`
- `text-pending-processing-chromium.png`
- `text-response-delivered-chromium.png`
- `text-response-error-chromium.png`
- `text-response-timeout-chromium.png`
- `text-network-interruption-chromium.png`
- `text-retry-delivered-chromium.png`

All web UI features are fully verified locally and ready for deployment.

