# KMG9 Live Test Instructions (for Jason)

**Target:** https://bha-cst-7u9e.onrender.com  
**Deployed context:** Working tree at 4ad161e (main). Public /health is 200 OK.

## Pre-check
1. Confirm deployed SHA (Render → Service → Deploys or commit shown). Note SHA/correlation with 4ad161e.
2. Use approved test identity/number (bound to a known unit/farm in staging/prod as appropriate). Do not use real customer numbers.

## Test 1: Unbound caller — farm-specific question (must be refused, no BHARAG fallback)
- Send via approved channel (SMS/webhook with valid Twilio signature if SMS): `How is my farm?` (or equivalent like "What's my water temperature?" / "Status of my farm")
- Expected: Refusal that caller not linked to active vFarm unit. No cluster/knowledge lookup for farm telemetry context.
- Evidence: Request ID/correlation ID, timestamp, full response body, route/intent logs (if accessible). Capture that no BHARAG call occurred.

## Test 2: Bound caller — farm-specific with access issue or vFarm unavailable (fail-closed)
- From bound identity: ask farm-specific live-state question when vFarm telemetry unavailable/unauthorized.
- Expected: Fail-closed response (e.g. telemetry unavailable / access denied) with no BHARAG fallback. Return telemetry_unavailable semantics.
- Evidence: correlation ID, response (403/telemetry_unavailable), logs showing vFarm error path (no BHARAG call).

## Test 3: Control — general knowledge (must go to BHARAG if non-farm-specific)
- From same identity: `How do I clean the filter?` (general procedure)
- Expected: Routed to knowledge (BHARAG) as non-farm-specific. Should not be forced to vFarm status path.
- Evidence: correlation ID, response, logs showing knowledge path.

## Success criteria
- Farm-specific cases never produce BHARAG-derived telemetry; they are refused or return telemetry_unavailable with explicit fail-closed behavior.
- No cross-tenant info leaked.
- Control case behaves as general knowledge.
