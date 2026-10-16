# CST Live E2E Evidence

## Local Automated Evidence (Verified)

| Area | Result | Evidence |
|---|---|---|
| Unit/Integration Tests | 584/590 PASSED (6 skipped) | vitest run - all core functionality passing |
| Security (5R0J) | 18/18 PASSED | tests/security/vfarm_proxy_unauth.test.ts - unauthenticated proxy blocked, zero upstream calls on anon requests |
| Admin vFarm Users/Grants (Tab 10) | 4/4 PASSED | tests/admin/vfarm_users_and_grants.test.ts - live members, farm grants, 503 on unavailable |
| Production Hardening E2E | 11/11 PASSED | tests/integration/e2e_production_hardening.test.ts - dedup, consent, callbacks, voice fail-closed, monotonic guards |
| TypeScript | PASSED | tsc --noEmit - no type errors |
| Tenant Isolation | VERIFIED | Multi-tenant tests pass; unknown numbers refused with tripwire logging |
| SMS Consent Spine | VERIFIED | Opt-out enforcement; platform messages can bypass consent appropriately (consent_exempt) |
| Delivery Callbacks (30005) | VERIFIED | Error code recorded; duplicate callbacks handled idempotently with monotonic guard |
| Voice Synthesis | VERIFIED | Fail-closed on empty input; generates valid audio buffer |

## Mocked vs Local Evidence

| Integration | Type | Status | Notes |
|---|---|---|---|
| Twilio webhooks (signature) | LOCAL/MOCKED | VERIFIED | Signature validation logic tested with mocked signatures |
| Twilio SMS send/delivery | MOCKED | VERIFIED | Mock transport; behavior matches real flows (segments, errors, callbacks) |
| vFarm API (live client) | MOCKED in most tests | VERIFIED | Admin Tab 10 tests mock live client; fail-closed on errors; no hardcoded dev host |
| BHARAG/RAG | MOCKED where needed | VERIFIED | Connectors tested with mocked responses |
| Dashboard publishing | MOCKED | VERIFIED | Fire-and-forget with retries verified; disabled if config missing |

## External/Live Evidence (BLOCKED)

| Item | Required | Status | Owner/Dependency |
|---|---|---|---|
| Live vFarm API connectivity | Read-only smoke test against real vFarm | BLOCKED | vFarm API credentials + network access; need VFARM_BASE_URL, tokens |
| Real SMS send to test number | End-to-end outbound SMS | BLOCKED | Requires approval (don't send unsolicited); needs test number, charges consideration |
| Real voice call | End-to-end voice | BLOCKED | Requires approval; may incur charges |
| DNS/TLS (OYP9) | CNAMEs for cst domains to Render | BLOCKED | Domain admin/platform ops; Render starter plan upgrade needed to avoid 503 hibernation |
| Staging migrations 017/018 (HOFE) | Apply to staging DB + verify | BLOCKED | Ops/DB admin; staging env access |
| KMG9 external acceptance (DW-19QD, DW-53P7) | External verification | BLOCKED | vFarm owners (Ahad/Jason per docs), BHARAG cluster-key scope (Jegan) |
| PostgreSQL expiry Nov 14 2026 | Confirm + action plan | BLOCKED | Platform team/owner |

## Smoke Test Checklist (Prepared)

For when external blockers cleared:

**DNS/TLS (OYP9):**
1. `dig +short cst.<domain>` and `dig +short cst-admin.<domain>` resolve to Render
2. `curl -I https://bha-cst-7u9e.onrender.com/health` returns 200
3. TLS valid; no redirect loops

**vFarm Live (read-only):**
1. `scripts/verify_vfarm_live.sh` (if credentials configured) - list orgs/users/farms without mutations
2. Tab 10 Admin → Users & Grants loads real data; handles empty/error states

**SMS/Voice Smoke (with approval):**
1. Inbound from known number → signature valid, tenant resolved, dedup works
2. Outbound → delivery callback received; consent enforced
3. Voice call → webhook flow completes; audio synthesized correctly
4. Error 30005 handling verified end-to-end

## Evidence Conclusion
All local automated evidence is GREEN. Live/staging external evidence is BLOCKED pending credentials, approval, infrastructure (DNS/TLS, plan upgrade), and external team verification. Unit/integration tests do NOT substitute for live SMS/voice acceptance per requirements.
