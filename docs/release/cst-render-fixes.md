# Render Production Investigation - Safe Fixes

## Issues observed (from public probes)
1. /favicon.ico: 404 with long timeouts in some probes; Express will pass through to 404 handlers. Missing static favicon can cause slow 404s in some clients; should be handled cleanly.
2. Root / returns 302 to /api-docs then 200 (Swagger UI) - intentional behavior (serves API docs). Documented as expected.
3. /health 200 OK; /api/v1/health 404 - consistent with code.
4. Intermittent 503s reported historically on /admin/login and / - likely transient (cold starts, startup). No obvious code defect causing persistent hangs observed in local review.

## Safe fixes (no production config changes)
- Add explicit favicon.ico handler returning 204 (no content) to avoid expensive 404 processing and be consistent. Also serve static web assets if present.
- Keep root redirect to /api-docs as-is (documented).
- Health checks unchanged (/health is correct).

## Tests
- Verify local behavior: root handling, favicon 204, health 200.
