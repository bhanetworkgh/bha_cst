# 5R0J Security Acceptance Evidence

## Routes verified (unauthenticated)
- GET /api/devices, /api/v1/devices -> 401
- GET /api/dashboard, /api/v1/dashboard -> 401
- GET /api/farms, /api/v1/farms -> 401
- POST /api/tokens, /api/v1/tokens -> 401

## Local tests
- tests/security/vfarm_proxy_unauth.test.ts: 26/26 pass

## Farm-key exposure
- Requires audit log access (external). No evidence of exposure from local tests; assess via Render logs/audit records.

## Status
- Live HTTP checks PASS (all 4 route groups reject unauthenticated).
- Local tests PASS.
- Key rotation/exposure assessment: requires owner/audit access.

No unsafe ops. No commits.
