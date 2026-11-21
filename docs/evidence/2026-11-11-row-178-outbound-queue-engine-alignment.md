# Row 178 Alignment Evidence — CST Outbound Queue Reliability

**Record Identity:**
- Row: 178
- Submission ID: `U0AC6RFNP3P_1789572312938`
- Title: "CST outbound queue reliability"
- Last updated: 29 September 2026
- Jason's feedback: None (no Jason note on this submission)
- Repository: `bhanetworkgh/bha_cst`
- Branch at investigation: `feature/pbt5-elevenlabs-voice-observability` (HEAD `f08e357`)

---

## Jason's Exact Feedback

None. (No Jason note on this submission.)

**Interpretation note:** Per instructions, this submission must not imply Jason previously reviewed or commented on it. No inference is made about Jason's position.

---

## Original Alignment Issues

| Issue | Detail |
|-------|--------|
| Layer 1 Partially Aligned | Submission not fully aligned |
| Criterion A weak | The log does not explain how the work advances the Engine or a named Twin |

---

## Mission Fit — BHA Engine and Twin Relationship

### BHA Engine Capability Advanced

**Reliability / outbound message delivery.** The CST outbound queue (`engine/src/transport/twilio/outbound.ts`) implements the BHA Engine's reliable message delivery capability: atomic queue claiming with concurrency safety, lease reaper for stale-job recovery, exponential backoff retries, monotonic delivery-state transitions, ambiguous-outcome handling (no duplicate sends), and fail-closed tenant/project attribution. This is an engine reliability capability — ensuring outbound messages are delivered exactly-once-or-not-at-all, with durable state tracking and operator-visible failure modes.

### Named Twin or CST Surface Involved

**Customer Service Twin (CST)** — outbound SMS delivery is a core customer-facing workflow. The queue handles customer replies, onboarding messages, opt-out confirmations, and HELP responses. Message delivery failures directly affect customer experience.

**Twilio** — external provider; CST maps Twilio statuses to CST delivery vocabulary and publishes `cst.delivery` events.

**vFarm** — not directly involved in outbound queue (tenant/project attribution comes from CST registry, not vFarm).

### How the Work Strengthens Engine/Twin Capability

The outbound queue prevents:
- **Lost jobs:** Lease reaper (`reclaimStaleOutboundMessages`) returns `sending` rows to `queued` if a worker dies mid-send
- **Duplicate processing:** Atomic `claimOutboundMessage` ensures only one worker processes a message
- **Worker stalls:** `isProcessingQueue` guard prevents reentrant processing; exponential backoff on transient errors
- **Cold-start/database delays:** Queue re-checks project capability immediately before sending (not just at enqueue time)
- **Incorrect delivery-state transitions:** `mapProviderDeliveryStatus()` never defaults unrecognized statuses to `delivered`; monotonic guard prevents state regression
- **Incorrect tenant/project attribution:** Delivery callbacks attribute from the persisted outbound row (tenant_id/project_id), never from the callback `To` field

### Classification

Reliability improvement (BHA Engine lane), serving Customer Service Twin SMS workflows. Not a customer-facing feature per se; it is the delivery reliability infrastructure underpinning outbound SMS.

---

## Commercial Impact

**Operational failure prevented:** Without reliable outbound queue processing, customer SMS replies could be lost, duplicated, or misattributed. Lost messages mean customers don't receive answers; duplicate messages cause customer confusion and carrier complaints; misattributed delivery corrupts per-project dashboard reporting.

**Customer/operator workflow enabled:** Customers receive reliable SMS replies (onboarding, opt-out confirmations, HELP responses, general responses). Operators can trust dashboard delivery status because attribution comes from the persisted outbound row, not guessed from callback data.

**Measurable outcome:** Outbound queue tests pass; delivery status callbacks advance state monotonically; `outcome_unknown` state preserves ambiguous sends without auto-retry (preventing duplicates). Production evidence from October 30, 2026 shows SMS delivery rows with Twilio SIDs and `delivered`/`undelivered` statuses (`docs/reports/CST_Jason_Payment_Gate_Closure_Report.md:109,111`).

**Business risk if not completed:** Customer-visible SMS failures, duplicate messages, incorrect dashboard reporting, increased support burden, potential A2P 10DLC compliance issues from undelivered/duplicate traffic.

---

## Breakthroughs

| Breakthrough | Before State | Change Made | After State | Evidence |
|-------------|-------------|-------------|-------------|----------|
| Monotonic delivery-state guard | Old code defaulted ALL unrecognized Twilio statuses to `delivered`, producing false delivery reports and suppressing genuine later callbacks | `mapProviderDeliveryStatus()` returns `null` for unrecognized statuses; stored state never advances on unknown status; no `cst.delivery` event published for unknown status | Delivery state advances only on known, monotonic transitions; real outcomes never suppressed | `engine/src/transport/twilio/outbound.ts:41-63, 706-873` |
| Ambiguous-outcome handling | Re-dispatch on timeout/risked duplicate delivery to customer | `isAmbiguousSendOutcome()` detection; message preserved in `outcome_unknown` state; NOT auto-retried; operator reconciliation required | No duplicate sends on ambiguous outcomes; message visible for operator reconciliation | `engine/src/transport/twilio/outbound.ts:586-604, 621-636` |
| Lease reaper for stale jobs | `sending` rows stayed `sending` forever if worker died mid-send (deploy/crash/instance destruction) | `reclaimStaleOutboundMessages()` returns `sending` rows to `queued` at queue startup | Stale jobs recovered; no permanently stuck messages | `engine/src/transport/twilio/outbound.ts:286-296` |
| Tenant/project attribution from persisted row | Delivery callback used `To` field (recipient) as primary attribution source, filing deliveries against wrong project or no project | Attribution comes from persisted outbound row (tenant_id, project_id); un-attributable callbacks refused, not guessed | Dashboard per-project reporting not corrupted; un-attributable deliveries acknowledged but not published | `engine/src/transport/twilio/outbound.ts:690-836` |

---

## Blockers

| Blocker | Type | Owner | Next Action | Completion Criterion |
|---------|------|-------|-------------|---------------------|
| Real SMS acceptance not executed | External dependency / access restriction | Authorized human tester | Live SMS lifecycle with matched callback on authorized handset | SMS E2E evidence captured; callback resolves outbound row; Dashboard shows delivery |
| Live Twilio delivery evidence limited | Production evidence historical | — | Historical SMS delivery rows from Oct 30, 2026 exist; fresh post-PR #23 live SMS turn pending | Fresh live SMS verification (requires authorized handset) |
| Jason review pending | External approval dependency | Jason | Jason to review this alignment evidence for row 178 | Jason records decision on row 178 |

---

## Layer 0 Field Proposals

| Field | Proposed Value |
|-------|---------------|
| `next_step` | Jason to review the explicit BHA Engine reliability mapping and outbound queue evidence documented here, then provide formal acceptance or specify further action on row 178. Real SMS acceptance on an authorized handset is the remaining external dependency. Responsible owner: Jason (review) and Authorized human tester (SMS acceptance). Completion: Jason records decision on Codex row 178; SMS E2E evidence captured. |
| `commercial` | Reliable outbound SMS delivery prevents lost/duplicate/misattributed customer messages. Lost replies increase support burden; duplicates cause carrier complaints; misattribution corrupts dashboard reporting. Current implementation prevents all three failure modes. Historical production evidence shows SMS delivery rows with Twilio SIDs and delivery statuses. No monetary value claimed. |
| `proof_type` | `mixed_deterministic_and_production_evidence` — deterministic unit tests (outbound queue, delivery callback, tenancy, attribution tests) + historical production evidence (SMS delivery rows with Twilio SIDs from Oct 30, 2026). Fresh live SMS acceptance pending authorized handset. |

---

## Implementation Paths and Line References

- Queue processing: `engine/src/transport/twilio/outbound.ts:281-684` (`processOutboundQueue`)
- Atomic claiming: `engine/src/transport/twilio/outbound.ts:300-308` (`claimOutboundMessage`)
- Lease reaper: `engine/src/transport/twilio/outbound.ts:288-296` (`reclaimStaleOutboundMessages`)
- Status mapping: `engine/src/transport/twilio/outbound.ts:41-63` (`mapProviderDeliveryStatus`)
- Tenancy validation: `engine/src/transport/twilio/outbound.ts:82-141` (`validateOutboundTenancyScope`)
- Consent exempt guard: `engine/src/transport/twilio/outbound.ts:208-273` (`validateConsentExempt`)
- Delivery callback: `engine/src/transport/twilio/outbound.ts:707-873` (POST `/twilio/delivery-status`)
- Attribution authority note: `engine/src/transport/twilio/outbound.ts:690-706`

---

## Commit SHAs

- Investigation branch HEAD: `f08e3570d19aafa55f0066e8bdb5040ea02e3438`
- No specific commit isolated for row 178 work (outbound queue is part of ongoing CST development)

---

## Exact Tests and Outputs

- `tests/transport/outbound.test.ts` — delivery status callback tests, monotonic state guard, attribution tests
- `tests/transport/delivery_persistence.test.ts` — delivery persistence invariants
- `tests/transport/delivery_status_webhook.test.ts` — webhook handling
- `tests/transport/outbound_attribution_edge_cases.test.ts` — attribution edge cases
- `tests/transport/outbound_tenancy.test.ts` — tenancy isolation
- `tests/transport/outbound_phase5_additional.test.ts` — additional outbound tests
- `tests/transport/delivery_callback_security.test.ts` — callback security

All transport outbound tests were included in the full suite run: 1373 passed, 6 skipped, 0 failed (verified 2026-11-11).

---

## Production Evidence and Timestamps

- Historical SMS delivery evidence from October 30, 2026 (`docs/reports/CST_Jason_Payment_Gate_Closure_Report.md:109,111`):
  - `out_b556d753-4a7f-43f0-9c4d-cb9bdcedd38b` → `SMdd413c99025787c3a92c9a7c5e91de77` → `SMf9470b51719bb4512a93dfab83fa8464`, `+19715885823` → `+9230***3844`, `delivered`, 2026-10-30T16:31:43.560Z
  - `out_a89d960b-2ea7-405b-904d-d7874768d538` → `SMe2e8cc3bd3885e64941a89e4c81bc48e` → `SM64a005aa459178fdd3e615f5311d7374`, `+19715885823` → `+9230***3844`, `undelivered` (pre-consent), 2026-10-21T19:39:39.364Z
- Fresh post-PR #23 live SMS turn: NOT yet executed (requires authorized handset)

---

## Evidence Limitations

- Codex submission record not accessible locally; original Layer 0 fields and Layer 1 assessment not retrievable
- No Jason feedback on this submission; no inference made about his position
- Real SMS acceptance not executed (requires authorized handset — external dependency)
- Production SMS evidence is historical (Oct 30, 2026); fresh post-PR #23 live SMS verification pending
- Phone numbers masked in evidence per security restrictions

---

## Revised Submission Text (Jason Resubmission Draft)

### Work Summary

CST outbound queue reliability (row 178). The outbound queue (`engine/src/transport/twilio/outbound.ts`) implements BHA Engine reliability for outbound SMS delivery: atomic queue claiming, lease reaper for stale-job recovery, exponential backoff retries, monotonic delivery-state transitions, ambiguous-outcome handling (no duplicate sends), and fail-closed tenant/project attribution. Delivery callbacks attribute from the persisted outbound row, never from the callback recipient number.

### BHA Engine / Twin Mission Fit

**BHA Engine capability:** Reliable outbound message delivery — engine ensures outbound SMS is delivered exactly-once-or-not-at-all, with durable state tracking and operator-visible failure modes.

**Twin surface:** Customer Service Twin (CST) — outbound SMS replies (onboarding, opt-out confirmations, HELP, general responses) are a core customer-facing workflow.

**Strengthening:** Prevents lost jobs, duplicate processing, worker stalls, incorrect state transitions, and misattributed delivery — all direct threats to customer SMS experience.

### Commercial Impact

Reliable outbound SMS prevents lost customer replies (increased support burden), duplicate messages (carrier complaints), and misattributed delivery (corrupted dashboard reporting). Historical production evidence shows SMS delivery rows with Twilio SIDs and delivery statuses from Oct 30, 2026. No monetary value claimed.

### Breakthroughs

1. Monotonic delivery-state guard: unknown Twilio statuses never default to `delivered` (`outbound.ts:41-63`).
2. Ambiguous-outcome handling: no auto-retry on ambiguous sends; `outcome_unknown` state for operator reconciliation (`outbound.ts:586-604`).
3. Lease reaper: stale `sending` rows returned to `queued` on worker death (`outbound.ts:286-296`).
4. Attribution from persisted row: delivery callbacks use stored tenant_id/project_id, never guessed from `To` field (`outbound.ts:690-836`).

### Blockers and Dependencies

- Real SMS acceptance on authorized handset — pending (external dependency, authorized human tester)
- Jason review on row 178 — pending (no prior Jason feedback on this submission)

### Exact Implementation Evidence

`engine/src/transport/twilio/outbound.ts` — full outbound queue implementation (875 lines), with specific line references above.

### Test and Production Proof

- Outbound queue, delivery callback, tenancy, and attribution tests included in full suite: 1373 passed / 6 skipped / 0 failed
- Historical production SMS delivery rows with Twilio SIDs (Oct 30, 2026)
- Fresh live SMS acceptance pending authorized handset
- proof_type: `mixed_deterministic_and_production_evidence`

### Layer 0 Values

- `next_step`: Jason review and decision on row 178; real SMS acceptance on authorized handset
- `commercial`: Reliable outbound SMS prevents lost/duplicate/misattributed customer messages
- `proof_type`: `mixed_deterministic_and_production_evidence`

### Acceptance Request

Please review this alignment evidence for Codex row 178. No prior Jason feedback exists on this submission — this is the first alignment response. The BHA Engine reliability mapping is now explicit, with code, test, and historical production evidence documented. Real SMS acceptance remains pending an authorized handset.

---

## Final Readiness Assessment

**READY FOR JASON REVIEW** — BHA Engine reliability mapping explicit; code, test, and historical production evidence documented. Blocked only on real SMS acceptance (authorized handset required) and Jason's formal decision.
