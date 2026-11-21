# Codex Resubmission Draft — Row 471 (XKWD)

**Submission ID:** `U0AC6RFNP3P_1794268150968`  
**Row:** 471  
**Session:** XKWD  
**Linked Loop:** `LOOP-1790985133890-XKWD` (Transcript Persistence Foreign-Key Fix)  
**Repository:** `bhanetworkgh/bha_cst`  
**Branch:** `feature/pbt5-elevenlabs-voice-observability`  
**HEAD:** `f08e3570d19aafa55f0066e8bdb5040ea02e3438`  
**Deployed Production SHA:** `441d2b3f4a49c983f45131c229888a60116b9437` (PR #23)  
**Draft Date:** 11 November 2026  
**Status:** DRAFT — for Jason review only; NOT submitted to Codex

---

## Work Summary

Fixed transcript persistence foreign-key failure (LOOP-1790985133890-XKWD). The conversation persistence path previously passed `project_id` into `conversations.system_id`, violating `conversations_system_id_fkey` because `systems` only contains `system_id = 'system-vfarm-01'`. The error was swallowed, returning a fake in-memory ID, causing subsequent message inserts to fail. Fix: `resolveSystemIdForTenant()` queries `systems` by `tenant_id` for the authoritative `system_id`; failures throw `ConversationPersistenceError` instead of being swallowed.

## BHA Engine / Twin Mission Fit

**BHA Engine capability:** Durable conversation and transcript persistence with foreign-key integrity — the engine must not swallow database constraint violations or create orphaned transcript rows.

**Twin surface:** Customer Service Twin (CST) — conversations and transcripts are the core data model for voice and text customer workflows.

**Strengthening:** Prevents silent transcript loss; conversation inserts fail loudly; no orphan messages; FK hierarchy (`systems` → `conversations` → `messages`) enforced at application layer.

## Commercial Impact

Without the fix, customer conversations appear to succeed but are not durably stored — support has no record, operators cannot audit, and compliance is at risk. With the fix, 66 production transcript rows are verified linked to valid conversations. No monetary value claimed.

## Breakthroughs

1. **Root cause discovered:** `project_id` passed as `system_id` violated FK; error swallowed, returning fake in-memory ID (`engine/src/db/client.ts:1120-1160`).
2. **Fix implemented:** `resolveSystemIdForTenant()` resolves real `system_id` from `systems` by `tenant_id`; `ConversationPersistenceError` thrown on failure.
3. **Deterministic regression coverage:** 8/8 tests pass in `tests/db/conversation_fk_integrity.test.ts`.
4. **Production verification:** 66 transcript rows linked to valid conversations in live Render PostgreSQL.

## Blockers and Dependencies

None remaining for CST-side work. Real PostgreSQL test portion gated behind `CST_DB_TESTS=1`/`DATABASE_URL` (not executed locally, no write access). Production read verification complete.

## Exact Implementation Evidence

- `engine/src/db/client.ts:1120-1160` — `resolveSystemIdForTenant()` and fail-closed conversation creation
- `db/migrations/001_initial_schema.sql` — systems → conversations → messages FK hierarchy
- `tests/db/conversation_fk_integrity.test.ts` — 8 tests asserting the FK contract

## Test and Production Proof

- 8/8 FK integrity tests pass
- Live production DB: 66 message rows, all FK-valid; 4 FK constraints confirmed
- proof_type: `mixed_deterministic_and_production_evidence`

## Layer 0 Values

- `next_step`: Jason formal review and sign-off on Codex row 471
- `commercial`: Durable conversation persistence prevents silent loss of customer transcripts
- `proof_type`: `mixed_deterministic_and_production_evidence`

## Acceptance Request

Please review and accept this resubmission for Codex row 471. Mission fit is now stated in the main submission body (not only in an addendum). Code diff, test evidence, and production DB verification are all documented.
