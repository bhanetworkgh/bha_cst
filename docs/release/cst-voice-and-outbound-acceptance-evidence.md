# CST Voice and Outbound Acceptance Evidence & Technical Summary
**Watch:** `DW-1792712806772-JLRL`  
**Date:** 2026-11-02  
**Owner:** CST Engineering  
**Scope:** Voice turn reliability, deadline enforcement, Twilio callback attribution, and health semantics

---

## 1. Executive Summary

This document consolidates code-level evidence, automated test results, and production-observed failure modes for Twilio voice turns and outbound SMS callback handling in BHA CST.

---

## 2. Voice Turn Architecture & Deadlines

### 2.1 Deadline Enforcement
- **Voice Turn Deadline:** Governed by `transport/voice/turn_deadline.ts` (`runVoiceTurnWithDeadline`).
- **Hard Deadline:** 12,000ms with a 14,000ms hard ceiling.
- **Upstream vFarm Timeout:** Strictly bounded at 5,000ms (`VFARM_DEFAULT_TIMEOUT_MS = 5000`).
- **On Deadline Expiration:**
  1. Abort controller fires signal canceling in-flight HTTP requests.
  2. The turn is marked `failed` / `TURN_TIMEOUT`.
  3. No partial or corrupted transcript is persisted to the `messages` table.
  4. An audit event with `tripwire: true` is emitted to the security ledger.
  5. Fallback TwiML response is returned to Twilio to safely conclude the call without silence.

### 2.2 Voice Failure Paths & Health Semantics
- **Worker & Lease Mechanics:** Outbound voice dispatch uses leased worker queues (`worker_leases` table). Leases auto-expire to prevent stuck worker tasks.
- **Route `/health/voice`:** Probes ElevenLabs connectivity, database responsiveness, and active audio synthesis pipelines.
- **Verification Tests:**
  - `tests/voice/voice_turn_deadline.test.ts` (9/9 PASS): Enforces deadline timeout, abandonment without persistence, and TwiML generation.
  - `tests/voice/voice_failure_path.test.ts` (7/7 PASS): Tests synthesis failure, vFarm error handling, and security ledger logging.
  - `tests/voice/health_signal.test.ts` (4/4 PASS): Verifies voice health signaling.

---

## 3. SMS Delivery Callback Attribution

### 3.1 Lifecycle & Fail-Closed Attribution
The complete delivery callback lifecycle:
```
Outbound Queue → Twilio API Send → Provider SID Persisted (updateOutboundProviderSid) → Twilio Webhook Callback → Lookup by provider_sid → Status Update → cst.delivery Event Published
```

### 3.2 Attribution Invariants
1. **Authoritative Row Matching:** Callbacks query `outbound_messages` by `provider_sid = MessageSid`.
2. **Refusal on Missing Row:** If `outbound_row_found = false`, CST logs a WARN, writes a security ledger `refused` audit event, and **refuses** to publish a `cst.delivery` event.
3. **No Inference:** CST never infers `tenant_id` or `project_id` from the callback body or recipient phone number.
4. **Idempotency & Status Monotonicity:** Callbacks for already-delivered messages are processed idempotently; statuses do not regress from terminal states (`delivered`, `failed`).

### 3.3 Verification Tests
- `tests/transport/delivery_callback_security.test.ts` (12/12 PASS): Validates row attribution, refusal of unknown SIDs, non-inference of tenant context, and dashboard retry safety.
- `tests/transport/delivery_status_webhook.test.ts` (23/23 PASS): Enforces signature checks before DB access and monotonic status progression.

---

## 4. Production Evidence Status

| Component | Code / Test Status | Production Evidence Status | Next Action |
|-----------|--------------------|----------------------------|-------------|
| Voice Deadline | PASS (20 tests) | 2026-10-28 log: 7,006ms and 12,015ms timeouts | Deploy code fix to Render; monitor live turn latencies |
| SMS Attribution | PASS (35 tests) | 54 callback warnings across 18 historical SIDs | Verify post-fix outbound sends in production |
| Inbound Signature | PASS (tests pass) | Fail-closed before DB access verified in code | Maintain signature enforcement |
| Live E2E Tests | Excluded per user instructions | Not executed | Operator execution with real credentials |

