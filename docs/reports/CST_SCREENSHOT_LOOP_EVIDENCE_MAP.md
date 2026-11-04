# CST Screenshot-to-Architecture-Loop Evidence Map

**Primary Architecture Loop:** `LOOP-1789824812431-IWKX` (Customer Service Experience & Feedback Loop)  
**Secondary Loop:** `LOOP-1789721731998-XXHH` (Voice Clones & Multimodal Latency)  
**Evidence Directory:** `docs/evidence/browser/`  
**Test Harness:** Playwright (`tests/browser/chat_pending_feedback.spec.ts` & `tests/browser/web_auth_and_voice.spec.ts`)  
**Date:** 2026-11-03  

---

## 1. Mapping Overview

To satisfy Jason's rigorous acceptance bar for `LOOP-1789824812431-IWKX`, CST requires empirical visual proof of state transitions across the customer messaging interface, including pending states, error handling, retry resilience, and audio synthesis.

Every generated screenshot in `docs/evidence/browser/` is mapped directly to its architectural requirement below.

---

## 2. Screenshot Traceability Matrix

| Screenshot File | Target Architecture Loop | State Transition / Behavior Captured | Viewport |
|---|---|---|---|
| `text-pending-processing-chromium.png` | `LOOP-1789824812431-IWKX` | Customer message immediately echoes in chat; pending indicator displays; composer input is disabled to prevent duplicate submissions. | Desktop (1280x720) |
| `text-pending-processing-mobile-chrome.png` | `LOOP-1789824812431-IWKX` | Same as above on mobile form factor with touch keyboard spacing maintained. | Mobile (393x851) |
| `text-response-delivered-chromium.png` | `LOOP-1789824812431-IWKX` | Assistant response delivered; pending indicator dismissed; composer re-enabled and focused for subsequent turn. | Desktop (1280x720) |
| `text-response-delivered-mobile-chrome.png`| `LOOP-1789824812431-IWKX` | Assistant response successfully rendered on mobile screen. | Mobile (393x851) |
| `text-response-error-chromium.png` | `LOOP-1789824812431-IWKX` | Server error response handled gracefully; explicit error banner rendered; input draft preserved. | Desktop (1280x720) |
| `text-response-error-mobile-chrome.png` | `LOOP-1789824812431-IWKX` | Server error banner displayed cleanly without breaking mobile chat viewport. | Mobile (393x851) |
| `text-response-timeout-chromium.png` | `LOOP-1789824812431-IWKX` | Network/backend timeout handled; displays retry control; allows user to resubmit draft. | Desktop (1280x720) |
| `text-response-timeout-mobile-chrome.png` | `LOOP-1789824812431-IWKX` | Timeout notification and retry button accessible on mobile touch UI. | Mobile (393x851) |
| `text-network-interruption-chromium.png` | `LOOP-1789824812431-IWKX` | Explicit offline indicator upon network drop; disables submit button until reconnect. | Desktop (1280x720) |
| `text-network-interruption-mobile-chrome.png`| `LOOP-1789824812431-IWKX` | Mobile view of network interruption notification. | Mobile (393x851) |
| `text-retry-delivered-chromium.png` | `LOOP-1789824812431-IWKX` | Successful delivery after retry; strict chronological ordering maintained in conversation thread. | Desktop (1280x720) |
| `text-retry-delivered-mobile-chrome.png` | `LOOP-1789824812431-IWKX` | Chronological conversation thread integrity verified on mobile. | Mobile (393x851) |
| `ui-chat-farm-status-and-voice-chromium.png`| `LOOP-1789824812431-IWKX` | Logged-in user view showing linked farm selector, live farm status summary, and chat interaction. | Desktop (1280x720) |
| `ui-chat-farm-status-and-voice-mobile-chrome.png`| `LOOP-1789824812431-IWKX` | Linked farm selector and telemetry summary on mobile viewport. | Mobile (393x851) |
| `ui-elevenlabs-voice-playback-chromium.png`| `LOOP-1789721731998-XXHH` | ElevenLabs voice response player; visual audio waveform/playback progress bar active. | Desktop (1280x720) |
| `ui-elevenlabs-voice-playback-mobile-chrome.png`| `LOOP-1789721731998-XXHH` | ElevenLabs voice playback controls responsive and functional on mobile. | Mobile (393x851) |

---

## 3. Verification Protocol

The screenshots above are automatically updated whenever the browser acceptance suite executes:
```bash
npm run test:browser
```
All images exist as valid, uncorrupted PNG files in `docs/evidence/browser/`, providing reproducible visual evidence for Jason's acceptance audit.

