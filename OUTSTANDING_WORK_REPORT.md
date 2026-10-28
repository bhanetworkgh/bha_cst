# CST Outstanding Work Report (2026-10-27T11:48:00Z)

## 1. What I moved
- Verified baseline: branch fix/dashboard-test-isolation @ 1da43a2, working tree preserved (modified .openapi-vfarm.json + untracked docs)
- Checked GitHub access: no SSH identities loaded, ls-remote/ssh fail (blocked)
- Checked production: /health OK, /health/voice degraded (SMS-only, 0 deliveries/24h)
- Reviewed KMG9/BHARAG code: farm fallback removed, no farm_id/unit_id sent from bharag_rag, intent routing hardened
- Reviewed delivery attribution code paths: fail-closed, uses persisted row, monotonic updates, tests pass
- Ran tests/typecheck/build: all pass (967 passed, 6 skipped), clean

## 2. Why it matters for the Engine
- KMG9 must remain blocked until isolated cluster boundary proven (security/compliance)
- Delivery attribution failures reduce dashboard visibility; code is defensive
- Voice unverified limits channels; SMS remains primary
- Postgres expiry is time-bound risk

## 3. Loop closure ledger
| Loop ID | Status | Evidence | Remaining |
| :-- | :-- | :-- | :-- |
| LOOP-1788044070647-KMG9 | BLOCKED/RED | Code hardened, tests pass. No isolated cluster/key evidence. | Need cst-help cluster with only manuals, cst-help-read ['ask'], green tests 1,1b,2 with request IDs/workspace hits |
| TWILIO-DELIVERY-ATTRIBUTION | PARTIAL | Code fail-closed, tests pass (delivery_callback_security, outbound_durability). Prod shows unmatched SIDs. | Need prod DB/log inspection for specific failing SIDs |
| POSTGRES-EXPIRY-2026-11-14 | BLOCKED | Reported Nov 14 2026 18:10 UTC free plan | Account owner decision on upgrade vs backup |
| VOICE-HEALTH | BLOCKED | /health/voice degraded, 0 deliveries/24h | Provider evidence needed |
| GITHUB-ACCESS | BLOCKED | No SSH identities loaded | Unlock key or provide access |
| LOOP-1790985133890-XKWD (conversations FK) | BLOCKED | Schema/code traced, needs migration proposal with preflight/rollback | Owner approval for migration |
| LOOP-1789573914064-KZE7 (legacy systems) | BLOCKED | Needs usage trace | Owner decision |
| LOOP-1792186179087-EWQI (vFarm contract) | BLOCKED | Needs vFarm contract/telemetry proof | vFarm owner confirmation |

## 4. Local code vs latest production deployment
- Local: fix/dashboard-test-isolation @ 1da43a2 (traffic markers, tests added)
- Prod deployment SHA unknown (cannot verify without GitHub access)
- Prod health OK, voice degraded

## 5-11. See evidence in existing reports
All details documented in RECONCILE_REPORT.md, LOOP_CLOSURE_EVIDENCE.md, CURRENT_MAIN_AUDIT_SUMMARY.md.

**No code changes made. All tests pass. No production changes.**
