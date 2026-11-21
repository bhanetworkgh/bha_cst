# Codex Resubmission Draft — Row 178

**Submission ID:** `U0AC6RFNP3P_1789572312938`  
**Row:** 178  
**Title:** CST outbound queue reliability  
**Last Updated:** 29 September 2026  
**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `feature/pbt5-elevenlabs-voice-observability`  
**HEAD:** `f08e3570d19aafa55f0066e8bdb5040ea02e3438`  
**Draft Date:** 11 November 2026  
**Status:** DRAFT — for Jason review only; NOT submitted to Codex

---

## Note on Prior Feedback

No Jason feedback exists on this submission. This is the first alignment response. Per instructions, no inference is made about any prior Jason review or comment.

## Work Summary

CST outbound queue reliability (row 178). The outbound queue (`engine/src/transport/twilio/outbound.ts`) implements BHA Engine reliability for outbound SMS delivery: atomic queue claiming, lease reaper for stale-job recovery, exponential backoff retries, monotonic delivery-state transitions, ambiguous-outcome handling (no duplicate sends), and fail-closed tenant/project attribution. Delivery callbacks attribute from the persisted outbound row, never from the callback recipient number.

## BHA Engine / Twin Mission Fit

**BHA Engine capability:** Reliable outbound message delivery — engine ensures outbound SMS is delivered exactly-once-or-not-at-all, with durable state tracking and operator-visible failure modes.

**Twin surface:** Customer Service Twin (CST) — outbound SMS replies (onboarding, opt-out confirmations, HELP, general responses) are a core customer-facing workflow.

**Strengthening:** Prevents lost jobs, duplicate processing, worker stalls, incorrect state transitions, and misattributed delivery — all direct threats to customer SMS experience.

## Commercial Impact

Reliable outbound SMS prevents lost customer replies (increased support burden), duplicate messages (carrier complaints), and misattributed delivery (corrupted dashboard reporting). Historical production evidence shows SMS delivery rows with Twilio SIDs and delivery statuses from Oct 30, 2026. No monetary value claimed.

## Breakthroughs

1. **Monotonic delivery-state guard:** Unknown Twilio statuses never default to `delivered`; stored state only advances on known transitions (`outbound.ts:41-63`).
2. **Ambiguous-outcome handling:** No auto-retry on ambiguous sends; `outcome_unknown` state preserved for operator reconciliation (`outbound.ts:586-604`).
3. **Lease reaper:** Stale `sending` rows returned to `queued` on worker death/deploy/crash (`outbound.ts:286-296`).
4. **Attribution from persisted row:** Delivery callbacks use stored tenant_id/project_id, never guessed from `To` field; un-attributable callbacks refused (`outbound.ts:690-836`).

## Blockers and Dependencies

| Blocker | Owner | Next Action |
|---------|-------|-------------|
| Real SMS acceptance on authorized handset | Authorized human tester | Live SMS lifecycle with matched callback |
| Jason review on row 178 | Jason | Review and accept or specify further action |

## Exact Implementation Evidence

- `engine/src/transport/twilio/outbound.ts` — full outbound queue implementation (875 lines)
  - `processOutboundQueue()` at line 281
  - `mapProviderDeliveryStatus()` at line 41
  - `reclaimStaleOutboundMessages()` at line 296
  - `validateOutboundTenancyScope()` at line 82
  - `validateConsentExempt()` at line 208
  - Delivery callback handler at line 707

## Test and Production Proof

- Outbound queue, delivery callback, tenancy, and attribution tests included in full suite: 1373 passed / 6 skipped / 0 failed (verified 2026-11-11)
- Historical production SMS delivery rows with Twilio SIDs (Oct 30, 2026):
  - `out_b556d753-4a7f-43f0-9c4d-cb9bdcedd38b` → `delivered` → `SMf9470b51719bb4512a93dfab83fa8464`, 2026-10-30T16:31:43.560Z
  - `out_a89d960b-2ea7-405b-904d-d7874768d538` → `undelivered` (pre-consent), 2026-10-21T19:39:39.364Z
- Fresh live SMS acceptance: pending authorized handset
- proof_type: `mixed_deterministic_and_production_evidence`

## Layer 0 Values

- `next_step`: Jason review and decision on row 178; real SMS acceptance on authorized handset
- `commercial`: Reliable outbound SMS prevents lost/duplicate/misattributed customer messages
- `proof_type`: `mixed_deterministic_and_production_evidence`

## Acceptance Request

Please review this alignment evidence for Codex row 178. No prior Jason feedback exists on this submission — this is the first alignment response. The BHA Engine reliability mapping is now explicit, with code, test, and historical production evidence documented. Real SMS acceptance remains pending an authorized handset.
