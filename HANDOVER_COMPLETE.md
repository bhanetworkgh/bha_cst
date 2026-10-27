# CST — Complete Outstanding Work & Evidence-Based Status (2026-10-27T12:12:00Z)

## A. Baseline
- Repo: /Users/HaMi/Documents/Jason/customer twin
- Branch: fix/dashboard-test-isolation @ 1da43a2
- Upstream: origin/fix/dashboard-test-isolation
- Working tree: modified .openapi-vfarm.json + untracked docs preserved
- GitHub: no SSH identities loaded (blocked)
- Prod: /health OK, /health/voice degraded (SMS-only, 0 deliveries/24h)

## B. What I moved (Verified)
- KMG9: Reviewed bharag_rag.ts - no farm_id/unit_id sent, fail-closed vFarm path, intent routing hardened. Tests exist. Still RED/OPEN pending isolated cluster evidence.
- Delivery attribution: Reviewed paths - fail-closed, uses persisted row, monotonic updates. Tests pass. Prod shows unmatched SIDs (needs investigation).
- Tests/Build: 967 passed, 6 skipped; typecheck clean; build clean; git diff --check clean
- Health checks: Fresh results recorded

## C. Remaining Blockers (Evidence Required)
| Item | Status | Required Evidence | Owner |
|---|---|---|---|
| KMG9 (LOOP-1788044070647-KMG9) | RED/OPEN | Isolated cst-help cluster (only manuals), cst-help-read ['ask'], tests 1,1b,2 with request IDs, workspaces_queried, per_workspace_hits, vFarm-key comparison | BHAGAR/Jegan + Jason |
| TWILIO-DELIVERY-ATTRIBUTION | PARTIAL | Prod trace of failing SIDs to persisted rows + dashboard events; prove fail-closed for unknown SIDs | Engineering/Infra |
| POSTGRES-EXPIRY-2026-11-14 (LOOP-1792104121807-XXHH) | BLOCKED | Current plan/expiry/backup/restore evidence, owner decision on upgrade vs backup | Account owner/Infra |
| VOICE-HEALTH | BLOCKED | Provider-backed acceptance evidence (inbound/outbound, identity, routing) | vFarm/Twilio owners |
| EWQI (LOOP-1792186179087-EWQI) | BLOCKED | Authoritative vFarm identity/grant/binding + live telemetry evidence | vFarm owner |
| FK mismatch (LOOP-1790985133890-XKWD) | BLOCKED | Tested migration proposal with preflight/rollback | DB owner (with approval) |
| Legacy systems (LOOP-1789573914064-KZE7) | BLOCKED | Usage trace to confirm retain/migrate/deprecate | Owner decision |
| GITHUB-ACCESS | BLOCKED | Unlock SSH key or provide access | Key owner |
| Stale customer refs | BLOCKED | Owner confirmation (no guessing) | Customer owners |

## D. Next 3 Actions (Priority Order)
1. **KMG9 boundary evidence** - Get independent tests from BHAGAR/Jegan before key switch (security gate)
2. **Postgres continuity** - Verify backup/restore and get owner decision before Nov 14 2026
3. **Delivery attribution trace** - Investigate specific failing SIDs in prod logs/DB once access available

**No production changes made. All existing changes preserved. All tests pass.**
