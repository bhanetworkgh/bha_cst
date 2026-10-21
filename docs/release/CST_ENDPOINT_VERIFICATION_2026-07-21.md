# CST deployed endpoint verification — full matrix

**Target:** `https://bha-cst-7u9e.onrender.com` · live release `b50588c` (deploy `dep-dbcd4am1egvs73a98ud0`, finished 2026-07-21T14:55:22Z)
**Run:** 2026-07-21T15:07Z–15:16Z · 10 s per-request timeout · ~0.12 s between requests
**Method:** read-only. No valid credential, no fabricated signature, no production mutation, no SMS/call, no outbound queue trigger.

`Evidence` records only the HTTP error/status code and the JSON key names — never a body, token, phone number or customer identifier.

| Method + path | Category | Risk | Auth | Test performed | HTTP | ms | Contract result | Evidence |
|---|---|---|---|---|---|---|---|---|
| `GET /health` | Health | Read-only | Public | no credentials | 200 | 524 | **PASS** | status=ok |
| `GET /api/health` | Health | Read-only (upstream vFarm probe) | Public | no credentials | 200 | 480 | **PASS** | status=ok |
| `GET /api-docs.json` | Docs | Read-only | Public | no credentials | 200 | 918 | **PASS** | non-json body |
| `GET /api-docs` | Docs | Read-only | Public | no credentials | 200 | 1082 | **PASS** | non-json body |
| `GET /` | Docs | Read-only | Public | no credentials | 200 | 1618 | **PASS** | non-json body |
| `GET /favicon.ico` | Static | Read-only | Public | no credentials | 204 | 493 | **PASS** | json: |
| `GET /web` | Static | Read-only | Public | no credentials | 200 | 516 | **PASS** | non-json body |
| `GET /admin/login` | Static | Read-only | Public | no credentials | 200 | 694 | **PASS** | non-json body |
| `GET /admin` | Static | Read-only | Public | no credentials | 200 | 987 | **PASS** | non-json body |
| `GET /debug/state` | Debug | Read-only | Public | no credentials | 404 | 593 | **PASS** | error=NOT_FOUND |
| `GET /health/voice` | Voice | Read-only | Public | no credentials | 200 | 525 | **PASS** | json:service,voice_lane |
| `GET /api/devices` | vFarm | Read-only | Admin session | no credentials | 401 | 628 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/devices` | vFarm | Read-only | Admin session | no credentials | 401 | 663 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/devices` | vFarm | Read-only | Admin session | malformed bearer | 403 | 512 | **PASS (EXPECTED DENIAL)** | error=FORBIDDEN |
| `GET /api/dashboard` | vFarm | Read-only | Admin session | no credentials | 401 | 402 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/dashboard` | vFarm | Read-only | Admin session | no credentials | 401 | 556 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/farms` | vFarm | Read-only | Admin session or JWT | no credentials | 401 | 443 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/farms` | vFarm | Read-only | Admin session or JWT | no credentials | 401 | 655 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/farms` | vFarm | Read-only | Admin session or JWT | malformed bearer | 401 | 700 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/tokens` | vFarm | STATE-CHANGING (key issuance) | Admin session or JWT | no credentials | 401 | 505 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/tokens` | vFarm | STATE-CHANGING (key issuance) | Admin session or JWT | no credentials | 401 | 538 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/voice/synthesize` | Voice | STATE-CHANGING (TTS cost) | CST_API_KEY | no credentials | 401 | 662 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/voice/turn` | Voice | STATE-CHANGING (TTS cost) | CST_API_KEY | no credentials | 401 | 556 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /voice/turn` | Voice | STATE-CHANGING (TTS cost) | CST_API_KEY | no credentials | 401 | 498 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /audio/speak` | Voice | STATE-CHANGING (TTS cost) | CST_API_KEY | no credentials | 401 | 525 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/web/session` | Web | Read-only | Session cookie | no credentials | 401 | 604 | **PASS (EXPECTED DENIAL)** | error=INVALID_SESSION |
| `GET /api/v1/web/projects` | Web | Read-only | Session cookie | no credentials | 200 | 504 | **FAIL** | non-json |
| `GET /api/v1/web/history` | Web | Read-only | Session cookie | no credentials | 401 | 720 | **PASS (EXPECTED DENIAL)** | error=INVALID_SESSION |
| `POST /api/v1/web/session` | Web | STATE-CHANGING (session) | Public (dev only) | no credentials | 501 | 622 | **PASS (EXPECTED DENIAL)** | error=PRODUCTION_AUTH_REQUIRED |
| `POST /api/v1/web/message` | Web | STATE-CHANGING (sends) | Session cookie | no credentials | 401 | 610 | **PASS (EXPECTED DENIAL)** | error=INVALID_SESSION |
| `POST /api/v1/web/logout` | Web | Read-only | Session cookie | no credentials | 204 | 608 | **FAIL** | json: |
| `POST /api/v1/auth/login` | Auth | Read-only on failure | Public | wrong credentials | 401 | 437 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/auth/me` | Auth | Read-only | Admin session | no credentials | 401 | 586 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/auth/logout` | Auth | Read-only | Admin session | no credentials | 200 | 447 | **FAIL** | status=ok |
| `POST /webhooks/twilio/sms` | Webhook | STATE-CHANGING (enqueues reply) | Twilio signature | no signature | 401 | 478 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /webhooks/twilio/delivery-status` | Webhook | Read-only-ish (status update) | Twilio signature | no signature | 401 | 471 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/tenants` | Admin | Read-only | Admin session | no credentials | 401 | 444 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/projects` | Admin | Read-only | Admin session | no credentials | 401 | 465 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/speakers` | Admin | Read-only | Admin session | no credentials | 401 | 598 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/dashboard` | Admin | Read-only | Admin session | no credentials | 401 | 526 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/audit/logs` | Admin | Read-only | Admin session | no credentials | 401 | 530 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/health/verification` | Admin | Read-only | Admin session | no credentials | 401 | 489 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/turn-stream` | Admin | Read-only (SSE) | Admin session | no credentials | 401 | 465 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/numbers/bindings` | Admin | Read-only | Admin session | no credentials | 401 | 387 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/numbers/candidate` | Admin | Read-only | Admin session | no credentials | 401 | 630 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/sms-consent` | Admin | Read-only | Admin session | no credentials | 401 | 513 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/sms-consent/wording` | Admin | Read-only | Admin session | no credentials | 401 | 406 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/sms-consent/15550000000` | Admin | Read-only | Admin session | no credentials | 401 | 582 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/sms-consent/15550000000/history` | Admin | Read-only | Admin session | no credentials | 401 | 500 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/health` | Admin | Read-only (upstream probe) | Admin session | no credentials | 401 | 454 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/farms` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 533 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/organizations` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 473 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/users` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 635 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/users/00000000-0000-0000-0000-000000000000/farm-grants` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 523 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/zones` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 524 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/layout` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 552 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/devices` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 471 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/devices/00000000-0000-0000-0000-000000000000` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 416 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/devices/00000000-0000-0000-0000-000000000000/rollup` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 577 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/readings` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 514 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/readings/latest` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 426 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/readings/sensor-latest` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 507 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/readings/stats` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 501 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/vision/latest` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 412 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/dashboard` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 497 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/summary` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 424 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/system-stats` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 423 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/alerts/open` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 503 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/alerts/counts` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 497 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/alerts/history` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 560 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `GET /api/v1/admin/vfarm/customers` | Admin | Read-only (upstream) | Admin session | no credentials | 401 | 527 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/tenants` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `PATCH /api/v1/admin/tenants/tenant-x` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `POST /api/v1/admin/projects/sync` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `PATCH /api/v1/admin/projects/proj-x` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `POST /api/v1/admin/speakers` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `PATCH /api/v1/admin/speakers/15550000000` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `DELETE /api/v1/admin/speakers/15550000000` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `POST /api/v1/admin/speakers/sync` | Admin | STATE-CHANGING | Admin session | NOT SENT | - | - | **NOT TESTED — MUTATION RISK** | not sent |
| `POST /api/v1/admin/speakers/invalidate` | Admin | Read-only (cache) | Admin session | no credentials | 401 | 433 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/numbers/bind` | Admin | STATE-CHANGING | Admin session | no credentials | 401 | 564 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/numbers/sync` | Admin | STATE-CHANGING | Admin session | no credentials | 401 | 565 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `DELETE /api/v1/admin/numbers/unbind` | Admin | STATE-CHANGING | Admin session | no credentials | 401 | 565 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/sms-consent` | Admin | STATE-CHANGING | Admin session | no credentials | 401 | 727 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/vfarm/login` | Admin | STATE-CHANGING (session) | Admin session | no credentials | 401 | 414 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/vfarm/select` | Admin | STATE-CHANGING | Admin session | no credentials | 401 | 497 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/vfarm/tokens` | Admin | STATE-CHANGING (key issuance) | Admin session | no credentials | 401 | 482 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `POST /api/v1/admin/vfarm/users/00000000-0000-0000-0000-000000000000/farm-grants` | Admin | STATE-CHANGING (grant) | Admin session | no credentials | 401 | 463 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |
| `DELETE /api/v1/admin/vfarm/users/00000000-0000-0000-0000-000000000000/farm-grants` | Admin | STATE-CHANGING (revoke) | Admin session | no credentials | 401 | 490 | **PASS (EXPECTED DENIAL)** | error=UNAUTHORIZED |

## Totals

- Matrix rows: **89**; distinct method+path: **87**
- Distinct routes tested: **79**
- Distinct routes NOT sent (mutation risk): **8**
- HTTP status distribution: 200 ×11 · 204 ×2 · 401 ×65 · 403 ×1 · 404 ×1 · 501 ×1 · **5xx ×0**
- Latency: min 387 ms · median 516 ms · max 1618 ms

`/webhooks/twilio/sms` is ONE route registered with three stacked middleware layers
(signature verification → tenancy resolution → handler); it is counted once.
