# XKWD / Codex row 471 — evidence-backed resubmission

**Prepared:** 2026-11-13  
**Repository:** `bhanetworkgh/bha_cst`  
**Codex submission:** `U0AC6RFNP3P_1794268150968` (row 471)  
**Jason's review:** 2026-11-10 — “Please bring this to full alignment”  
**Review state:** Partially Aligned; not accepted  
**Loop identity:** The prior operator record identifies `LOOP-1790985133889-XKWD`. The repository regression test currently names `LOOP-1790985133890-XKWD`. This one-second identifier discrepancy must be checked against the authoritative loop dashboard before any closure action.  
**Session type for the original defect investigation:** Debug  
**Proof type for this resubmission:** `code_and_ci_verification` (production database proof remains blocked)

## 1. What the defect was

The failure involved two linked constraints in the conversation/transcript persistence path:

1. `conversations_system_id_fkey`: `conversations.system_id` must reference a real `systems.system_id`. The engine caller could pass a project ID in the system-ID argument position, causing a conversation insert to violate this FK.
2. `messages_conversation_id_fkey`: `messages.conversation_id` must reference a persisted `conversations.conversation_id`. When the conversation insert failed, the old path swallowed the error and returned an in-memory conversation ID; a later transcript insert then referenced a conversation row that did not exist.

The constraints are correct and were not removed or weakened. The corrective approach is to resolve the authoritative system ID from the tenant's `systems` row and to propagate conversation/transcript persistence failures instead of claiming that in-memory state is durable.

## 2. Code and migration evidence

- Corrective implementation: [commit 31f3a5f](https://github.com/bhanetworkgh/bha_cst/commit/31f3a5f97113aec34316b03f669c0f37c3b9f40d), which introduced `ConversationPersistenceError`, the fail-on-persistence-error behavior, and the initial regression test.
- Current implementation: [`engine/src/db/client.ts`](https://github.com/bhanetworkgh/bha_cst/blob/main/engine/src/db/client.ts). `resolveSystemIdForTenant()` looks up `systems.system_id` by the unique tenant ID; `getOrCreateConversation()` uses that value and throws `ConversationPersistenceError` if the conversation insert fails. `addMessageToTranscript()` throws `TranscriptPersistenceError` if the transcript insert fails.
- Schema: [`db/migrations/001_initial_schema.sql`](https://github.com/bhanetworkgh/bha_cst/blob/main/db/migrations/001_initial_schema.sql). It defines `conversations.system_id REFERENCES systems(system_id)` and `messages.conversation_id REFERENCES conversations(conversation_id)`.
- No new migration is required for this correction: the existing FK relationships remain the intended schema. The fix is in the write path, not in relaxing the schema.
- The corrective commit has no associated pull request returned by the GitHub commit-to-PR lookup. Do not invent a PR number.

## 3. Automated test evidence

Existing suite: [`tests/db/conversation_fk_integrity.test.ts`](https://github.com/bhanetworkgh/bha_cst/blob/main/tests/db/conversation_fk_integrity.test.ts).

Existing coverage includes:
- Schema assertions that both FK relationships remain present.
- A valid real-Postgres conversation and transcript round trip, when `CST_DB_TESTS=1` and `DATABASE_URL` are supplied.
- A tenant-to-system join check.
- A failed conversation insert that must raise `ConversationPersistenceError`.
- A guard proving no transcript insert is attempted after conversation creation fails.
- Restart durability and orphan-row checks in the opt-in real-Postgres section.

**New test delta in this resubmission:** commit `1dc7fdf75e9cf4b81577b4cfa050af2c205a77d2` adds:
- A deterministic stub-pool test that simulates PostgreSQL SQLSTATE `23503` for `messages_conversation_id_fkey`, expects `TranscriptPersistenceError`, and asserts no transcript is cached.
- An opt-in real-Postgres negative test that submits a transcript with a nonexistent conversation ID, expects `TranscriptPersistenceError`, and asserts no message row was persisted.

The new tests have been committed to this evidence branch. **Their CI result is not yet recorded in this document.** The real-Postgres tests remain opt-in and cannot be described as passed until run with an authorized database.

## 4. CI evidence and its limit

The default-branch CI run [43427665226](https://github.com/bhanetworkgh/bha_cst/actions/runs/43427665226) completed successfully on 2026-11-13 against main SHA `a5fd1ad0fa26cf87420d8394f1c38fc38a50a206`. Typecheck, build, and Vitest completed successfully.

Important limitation: `.github/workflows/ci.yml` copies `.env.example` but does not set `CST_DB_TESTS=1` or provide a production `DATABASE_URL`. Therefore the opt-in real-Postgres section is skipped in ordinary CI. The green CI result proves the non-database regression suite, not a real production transcript join.

## 5. Production database verification — BLOCKED, not passed

A read-only query was attempted against Render Postgres resource `dpg-db8he2qvcj2c73ado3s0-a` (`bha_cst_1sh0`) on 2026-11-13. The hosted Render connector could not establish an allowed database connection; it returned an SSL/TLS requirement and reported that the hosted connector's source IP was not on the database allowlist. **No SQL result was returned. No production row was inspected or changed.**

Run the following read-only query from an authorized network/connection. It returns identifiers and timestamps only; it does not expose transcript body or phone numbers:

```sql
SELECT
  m.message_id,
  m.conversation_id,
  m.tenant_id AS message_tenant_id,
  c.tenant_id AS conversation_tenant_id,
  m.project_id,
  c.system_id,
  s.system_id AS matched_system_id,
  m.created_at
FROM messages AS m
JOIN conversations AS c
  ON c.conversation_id = m.conversation_id
JOIN systems AS s
  ON s.system_id = c.system_id
 AND s.tenant_id = c.tenant_id
WHERE m.tenant_id = c.tenant_id
ORDER BY m.created_at DESC
LIMIT 10;
```

Also run this orphan check:

```sql
SELECT count(*) AS orphan_message_count
FROM messages AS m
LEFT JOIN conversations AS c
  ON c.conversation_id = m.conversation_id
WHERE c.conversation_id IS NULL;
```

And verify the physical constraint definitions:

```sql
SELECT
  conrelid::regclass AS table_name,
  conname,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conname IN (
  'conversations_system_id_fkey',
  'messages_conversation_id_fkey'
)
ORDER BY conname;
```

**Production acceptance condition:** attach sanitized, non-empty output from the first query showing a real transcript joined to its conversation and system; attach the orphan count and constraint definitions. If no qualifying row exists, record that result and investigate why; do not substitute a test fixture or a migration ledger.

## 6. Mission fit and operational/commercial impact

**Mission fit:** This advances CST's core responsibility to retain a durable, tenant-attributed customer conversation history. A transcript must resolve to its owning conversation and system so the Monitoring Twin can consume reliable communication context alongside live vFarm state. It prevents a project ID being mistaken for a system ID and prevents an in-memory-only conversation from being presented as persisted.

**Lane/card advanced:** CST conversation/transcript persistence → Monitoring Twin communication-context handoff. This is a prerequisite for reliable conversation readback and auditability, not proof that the full Monitoring Twin forwarding workflow is accepted.

**Commercial/operational impact:** Reduces lost customer-service history, broken follow-up context, and manual reconciliation when an inbound conversation cannot be durably recorded. No revenue, conversion, or time-saved metric was measured; none is claimed.

## 7. Relog delta — what is new in this session

The original implementation is relogged against the prior audit; it is not claimed as new work. New work in this resubmission session is:
1. Reconciled the code and schema evidence against the review.
2. Added an explicit negative test for a transcript referencing a nonexistent conversation.
3. Added this evidence record with exact constraint names, commit links, CI limitation, mission fit, commercial impact, and production verification SQL.
4. Attempted read-only production verification and recorded the access blocker. No production data was changed.

## 8. Resubmission status and next step

**Status: PARTIALLY ALIGNED — CODE EVIDENCE IMPROVED; PRODUCTION PROOF PENDING.**

Do not mark audit 5541 or the XKWD loop resolved yet. The remaining gate is a successful authorized production query and an authoritative reconciliation of the `3889` vs `3890` loop identifier. If production access remains unavailable, open/retain the monitoring card for transcript-to-conversation/system readback and keep the loop open with the production query as its acceptance condition.

The official Codex record and parked-log row 471 have not been edited by this GitHub change. The official Monitoring Twin card and loop dashboard have not been created or changed from this session.
