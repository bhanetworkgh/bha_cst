# CST Production Evidence Index

**Execution Date:** 2026-11-03  
**Target Host:** `https://bha-cst-7u9e.onrender.com`  
**Render Service ID:** `srv-db8hepqvcj2c73adpus0`  
**Render Database ID:** `dpg-db8he2qvcj2c73ado3s0-a` (`bha-cst-postgres`)  
**Deployed Commit SHA:** `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23)  
**Main Branch SHA:** `eb7876773f33103d983f76ada05fe1565f900d07` (PR #24)  
**Local Branch:** `fix/monitoring-pay-gate-closure` (HEAD: `52a4a48`)  

---

## 1. Timestamped Infrastructure Evidence

| Timestamp (UTC) | Resource / Source | Exact Identifier | Verified Output / Value | Context / Artifact |
|---|---|---|---|---|
| `2026-11-02T22:43:32Z` | Render Deployment API | `dep-dbkh3p6417fc73bffihg` | Status: `live` | Deployed commit `441d2b3f` from branch `main` (PR #23) |
| `2026-11-02T22:43:26Z` | Render Startup Log | Deploy `dep-dbkh3p6417fc73bffihg` | `Research Twin integration checked: state: "blocked", contract: "unverified", missing: []` | Verifies `RT_*` env vars are configured without leaking values |
| `2026-11-03T15:06:44Z` | Live HTTP Probe | `GET /health` | HTTP 200 OK (535ms) `{"status":"ok","service":"bha-cst-engine"}` | Public liveness probe healthy |
| `2026-11-03T15:06:56Z` | Live HTTP Probe | `GET /health/voice` | HTTP 200 OK `{"can_route_voice":true,"clone_configured":true,"voice_id":"Hmy9...esiM"}` | Destiny voice signal verified healthy |
| `2026-11-03T15:07:13Z` | Live HTTP Probe | `GET /api/health` | HTTP 200 OK `{"api_reachability":{"status":"unavailable","mode":"live","reason":"probe_failed:auth"}}` | Diagnostic probe surfaces vFarm token expiry truthfully |
| `2026-11-03T15:07:26Z` | Live HTTP Probe | `GET /web` | HTTP 200 OK (text/html) | Renders full CS Twin v1 production workspace shell |
| `2026-11-03T15:07:34Z` | Live HTTP Probe | `GET /api/v1/web/projects` | HTTP 200 OK `[{"project_id":"proj-vfarm-main","name":"vFarm Austin HQ"}]` | Verifies project scope discovery |
| `2026-11-03T15:07:46Z` | Live HTTP Probe | `GET /api/v1/web/session` | HTTP 401 Unauthorized `{"error":"INVALID_SESSION"}` | Unauthenticated request rejected |
| `2026-11-03T15:08:07Z` | Live HTTP Probe | `POST /api/v1/web/session` | HTTP 401 Unauthorized `{"error":"AUTH_REQUIRED"}` | Missing credentials rejected |
| `2026-11-03T15:08:17Z` | Live HTTP Probe | `POST /api/v1/web/session` | HTTP 401 Unauthorized `{"error":"UNAUTHORIZED","message":"User not found in vFarm or invalid credentials."}` | Invalid credentials fail closed |
| `2026-11-03T15:08:31Z` | Live HTTP Probe | `GET /debug/state` | HTTP 404 NOT FOUND `{"error":"NOT_FOUND"}` | Confirms debug routes disabled in production |
| `2026-11-03T15:08:47Z` | Acceptance Runner | `acceptance:preflight` | `[PASS] Preflight Verdict: PASS (Twilio active, sender owned, DB healthy)` | [`artifacts/acceptance/2026-11-03T15-08-47-065Z/acceptance-report.md`](../../artifacts/acceptance/2026-11-03T15-08-47-065Z/acceptance-report.md) |
| `2026-11-03T20:14:45Z` | Playwright Chrome Suite | 28 browser tests | 28 passed, 0 failed (9.3s) across Desktop & Mobile Chrome | Live & simulated journeys verified |

---

## 2. Browser Screenshots & UI Test Artifacts (`docs/evidence/browser/`)

| Artifact Path | Viewport | Requirement Mapped | Verification Target |
|---|---|---|---|
| [`prod-live-login-view-chromium.png`](../evidence/browser/prod-live-login-view-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Production live login form, input labels, and project dropdown |
| [`prod-live-login-view-mobile-chrome.png`](../evidence/browser/prod-live-login-view-mobile-chrome.png) | Mobile (393x851) | `LOOP-1789824812431-IWKX` | Production live responsive layout on Pixel 5 touch viewport |
| [`prod-live-empty-creds-error-chromium.png`](../evidence/browser/prod-live-empty-creds-error-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Production live error on empty credentials submission |
| [`prod-live-empty-creds-error-mobile-chrome.png`](../evidence/browser/prod-live-empty-creds-error-mobile-chrome.png)| Mobile (393x851) | `LOOP-1789824812431-IWKX` | Production live mobile empty credentials error banner |
| [`prod-live-auth-error-chromium.png`](../evidence/browser/prod-live-auth-error-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Production live refusal message on invalid vFarm credentials |
| [`prod-live-auth-error-mobile-chrome.png`](../evidence/browser/prod-live-auth-error-mobile-chrome.png) | Mobile (393x851) | `LOOP-1789824812431-IWKX` | Production live mobile invalid vFarm credentials error banner |
| [`prod-live-a11y-landmarks-chromium.png`](../evidence/browser/prod-live-a11y-landmarks-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Semantic HTML, ARIA `role="alert"`, and accessibility attributes |
| [`prod-live-a11y-landmarks-mobile-chrome.png`](../evidence/browser/prod-live-a11y-landmarks-mobile-chrome.png)| Mobile (393x851) | `LOOP-1789824812431-IWKX` | Mobile viewport touch target spacing and accessibility landmarks |
| [`text-pending-processing-chromium.png`](../evidence/browser/text-pending-processing-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Customer message immediately echoes; typing indicator renders; composer disabled |
| [`text-response-delivered-chromium.png`](../evidence/browser/text-response-delivered-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Assistant response delivered; pending indicator dismissed; composer re-enabled |
| [`text-response-error-chromium.png`](../evidence/browser/text-response-error-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Explicit server error banner rendered; input draft preserved |
| [`text-response-timeout-chromium.png`](../evidence/browser/text-response-timeout-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Request timeout indicator with retry action |
| [`text-network-interruption-chromium.png`](../evidence/browser/text-network-interruption-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Offline banner on network disconnection; disables submission until reconnect |
| [`text-retry-delivered-chromium.png`](../evidence/browser/text-retry-delivered-chromium.png) | Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Delivery after retry; strict chronological ordering maintained |
| [`ui-chat-farm-status-and-voice-chromium.png`](../evidence/browser/ui-chat-farm-status-and-voice-chromium.png)| Desktop (1280x720) | `LOOP-1789824812431-IWKX` | Logged-in user view showing linked farm selector, status cards, and chat drawer |
| [`ui-elevenlabs-voice-playback-chromium.png`](../evidence/browser/ui-elevenlabs-voice-playback-chromium.png)| Desktop (1280x720) | `LOOP-1789721731998-XXHH`| ElevenLabs speech player with visual waveform and audio controls |

---

## 3. Telephony & Provider Correlation Records

| Entity / Identifier | Value (Safely Redacted) | Verification Context | Source |
|---|---|---|---|
| **Twilio Account SID** | `ACd2...0353` | Production Twilio Master Account ("Bays Horizon Network") | Twilio API |
| **Sender Service Number**| `+19715885823` | Bound service number (Voice: true, SMS: true) | Twilio API / `service_number_bindings` |
| **Authorized Destination**| `+9230***3844` | Single authorized test number locked in test runner | `scripts/acceptance_runner.ts` |
| **Twilio Call SID** | `CA916aadd4aac4ebf7980c634be39838a0` | Verified voice turn completed in 1,142ms | Live Render Log / PostgreSQL |
| **Twilio Call SID** | `CA1decc8a2aead3400c684327ec30ff44d` | Historical voice call with ElevenLabs audio playback | Live Render Log (`2026-10-28T21:04:12Z`) |
| **Correlation ID** | `CA916aadd4aac4ebf7980c634be39838a0` | Correlated delivery status callback (`outcome: "ok"`) | Live Render Security Ledger Log |
| **Tenant ID** | `tenant-vfarm-01` | Authoritative tenant resolved from incoming DID | PostgreSQL `tenants` |
| **Project ID** | `proj-vfarm-main` | Authoritative project resolved from service binding | PostgreSQL `projects` |
| **ElevenLabs Voice ID** | `Hmy9...esiM` | Cloned voice pointer for spoken turn synthesis | `/health/voice` response |

---

## 4. Database Query & Migration Ledger Records

### 4.1 Production Migration Table Verification
Query: `SELECT name, applied_at FROM schema_migrations ORDER BY name;`  
Database: `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`)  
Total Rows: **24 rows**

```text
 1. 001_initial_schema.sql
 2. 002_service_numbers.sql
 3. 003_add_customers_and_security_ledger.sql
 4. 003_customers_table.sql
 5. 004_outbound_messages.sql
 6. 005_delivery_callbacks.sql
 7. 006_voice_sessions.sql
 8. 007_web_sessions.sql
 9. 008_farm_identities.sql
10. 009_sensor_telemetry_cache.sql
11. 010_alert_events.sql
12. 011_voice_clones.sql
13. 012_rate_limits.sql
14. 013_incident_references.sql
15. 014_consent_records.sql
16. 015_audit_tripwires.sql
17. 016_turn_feedback.sql
18. 017_speaker_profiles.sql
19. 018_knowledge_chunks.sql
20. 019_service_quotas.sql
21. 020_worker_heartbeats.sql
22. 021_dead_letter_queue.sql
23. 022_add_escalations_table.sql
24. 023_research_twin_outbound.sql
```

### 4.2 Network Access Rule
- `bha-cst-postgres` Access List: `103.120.71.129/32` (verified restricted).
- `0.0.0.0/0` public open access: Completely removed.

