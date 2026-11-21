# XKWD Row 471 Alignment Evidence — Loop Audit 5541 Resubmission

**Loop Reference:** `LOOP-1790985133890-XKWD` (Reconciled from operator typo `LOOP-1790985133889-XKWD`)  
**Audit Reference:** Audit 5541  
**Codex Submission ID:** `U0AC6RFNP3P_1794268150968`  
**Codex Record:** 471  
**Repository:** `bhanetworkgh/bha_cst`  
**Current Branch:** `feature/kze7-vfarm-system-registry` (HEAD `9ed7e1b7a8c094c5c64d038431b290970ecb6042`)  
**Status:** `BLOCKED_BY_PRODUCTION_DATABASE_ACCESS` (All code, schema, and tests complete; live Render production query blocked by operator password credential requirement)  

---

## 1. Defect Description & Root Cause

### Defect
When conversation records were persisted, callers (such as `CoreEngine.processEnvelope`) passed a `project_id` (e.g. `'proj-vfarm-main'`) into the `system_id` parameter of `DbClient.getOrCreateConversation()`.  
Because `systems` only contained `system_id = 'system-vfarm-01'`, the INSERT failed with a foreign-key violation:
`conversations_system_id_fkey: insert or update on table "conversations" violates foreign key constraint "conversations_system_id_fkey"`.

### Swallowed Failure Mechanism (Silent Corruption)
In the original implementation, `DbClient.getOrCreateConversation()` caught the PostgreSQL error, logged it, but **swallowed** the exception and returned the generated in-memory `conv.conversation_id`.  
Downstream, `DbClient.addMessageToTranscript()` attempted to insert the transcript message referencing this `conversation_id`. Because the conversation was never committed to PostgreSQL, the message insert failed with:
`messages_conversation_id_fkey: insert or update on table "messages" violates foreign key constraint "messages_conversation_id_fkey"`.

---

## 2. Foreign-Key Implementation & Schema Definitions

### Foreign-Key Constraints in PostgreSQL
The foreign keys are defined in [`db/migrations/001_initial_schema.sql`](file:///Users/HaMi/Documents/Jason/customer%20twin/db/migrations/001_initial_schema.sql#L15-L43):

* **Constraint 1:** `conversations_system_id_fkey`  
  - Table: `conversations`  
  - Column: `system_id VARCHAR(64) NOT NULL REFERENCES systems(system_id)`  
  - Definition: `FOREIGN KEY (system_id) REFERENCES systems(system_id)`  
  - `ON DELETE` Behavior: **`NO ACTION`** (PostgreSQL standard default, preventing parent deletion while conversations exist).
* **Constraint 2:** `messages_conversation_id_fkey`  
  - Table: `messages`  
  - Column: `conversation_id VARCHAR(64) NOT NULL REFERENCES conversations(conversation_id)`  
  - Definition: `FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)`  
  - `ON DELETE` Behavior: **`NO ACTION`** (PostgreSQL standard default, preventing conversation deletion while messages exist).

These foreign-key constraints were established in migration `001` and were **never dropped or weakened**.

### Application-Layer Fix
File: [`engine/src/db/client.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/engine/src/db/client.ts) (Commit `31f3a5f97113aec34316b03f669c0f37c3b9f40d`)

1. **System ID Resolution (`resolveSystemIdForTenant`, lines 1133–1156):**  
   Resolves the authoritative `system_id` directly from `systems` using `tenant_id` (`systems.tenant_id` is unique), rather than trusting the caller-supplied `systemId`:
   ```typescript
   private static async resolveSystemIdForTenant(
     pool: pg.Pool,
     tenantId: string,
     fallback: string,
   ): Promise<string> {
     try {
       const res = await pool.query(
         `SELECT system_id FROM systems WHERE tenant_id = $1 LIMIT 1`,
         [tenantId],
       );
       if (res.rows.length > 0 && res.rows[0].system_id) {
         return res.rows[0].system_id;
       }
       Logger.warn(`DbClient: no systems row for tenant ${tenantId} — conversation FK parent missing (fail closed)`);
       return fallback;
     } catch (err: any) {
       Logger.warn(`DbClient: systems lookup failed for tenant ${tenantId}: ${err.message}`);
       return fallback;
     }
   }
   ```
2. **Fail-Closed Conversation Persistence (`getOrCreateConversation`, lines 1224–1233):**  
   Replaces error swallowing with an explicit thrown `ConversationPersistenceError`:
   ```typescript
   } catch (err: any) {
     Logger.error(`DbClient.getOrCreateConversation Postgres Error: ${err.message}`);
     throw new ConversationPersistenceError(err.message, orgId, customerRef);
   }
   ```
3. **Fail-Closed Transcript Persistence (`addMessageToTranscript`, lines 1307–1311):**  
   Only caches in memory if the database write succeeds. On error, throws `TranscriptPersistenceError`:
   ```typescript
     this.transcriptsStore.set(msg.message_id, record);
   } catch (err: any) {
     Logger.error(`DbClient.addMessageToTranscript Postgres Error: ${err.message}`);
     throw new TranscriptPersistenceError(err.message, msg.tenant_id, msg.message_id);
   }
   ```

---

## 3. Automated Test Evidence

**Test File:** [`tests/db/conversation_fk_integrity.test.ts`](file:///Users/HaMi/Documents/Jason/customer%20twin/tests/db/conversation_fk_integrity.test.ts)  
**Authorized Test Handset Used in Tests:** `+923082113844`

### Test Breakdown

| Suite | Test Name | Type | Environment | Status |
|---|---|---|---|---|
| Schema Contract | `creates systems, then conversations, then messages (FK parents first)` | Positive | Schema / File | PASS |
| Schema Contract | `keeps conversations.system_id and messages.conversation_id as real foreign keys` | Positive | Schema / File | PASS |
| Schema Contract | `runs migrations in an order where every FK parent precedes its dependant` | Positive | Schema / File | PASS |
| Schema Contract | `KNOWN DEFECT (not this loop): two migrations share the 003 prefix` | Known Boundary | Schema / File | PASS |
| Real PostgreSQL | `persists a real conversation even though the caller passes project_id as systemId` | Positive | PostgreSQL 16 | PASS |
| Real PostgreSQL | `resolves system_id from tenant_id rather than trusting the caller` | Positive | PostgreSQL 16 | PASS |
| Real PostgreSQL | `persists a real message against that conversation and reads it back` | Positive | PostgreSQL 16 | PASS |
| Real PostgreSQL | `leaves no orphan message rows for this tenant after a full round trip` | Positive | PostgreSQL 16 | PASS |
| Real PostgreSQL | `reuses the same conversation row for a repeat message from the same speaker` | Positive | PostgreSQL 16 | PASS |
| Real PostgreSQL | `data remains valid and queryable after a simulated process restart` | Positive | PostgreSQL 16 | PASS |
| Real PostgreSQL | `negative: rejects transcript insert referencing a nonexistent conversation ID with TranscriptPersistenceError` | Negative | PostgreSQL 16 | PASS |
| Real PostgreSQL | `negative: surfaces ConversationPersistenceError when system parent is missing` | Negative | PostgreSQL 16 | PASS |
| Durability (Stub) | `throws instead of returning an unpersisted conversation_id when the INSERT fails` | Negative | In-memory Stub | PASS |
| Durability (Stub) | `does not write an orphan message when the conversation could not be created` | Negative | In-memory Stub | PASS |
| Durability (Stub) | `rejects instead of persisting a voice delivery when the tenant has no systems row` | Negative | In-memory Stub | PASS |
| Durability (Stub) | `negative: rejects transcript write with TranscriptPersistenceError when query rejects and does not cache in memory` | Negative | In-memory Stub | PASS |

### Execution Results
- **Command (Real PostgreSQL):**
  ```bash
  CST_DB_TESTS=1 DATABASE_URL=postgresql://localhost:5432/bha_cst npx vitest run tests/db/conversation_fk_integrity.test.ts
  ```
  **Output:** `16 passed (16) | Duration: 397ms` (10 Positive cases, 6 Negative cases).
- **Command (Stub / Isolated Mode):**
  ```bash
  npx vitest run tests/db/conversation_fk_integrity.test.ts
  ```
  **Output:** `9 passed (9)` (4 Schema contract, 1 Skipped DB notice, 4 Stub durability negative cases).

---

## 4. Production Database Verification

**Target PostgreSQL Resource:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a.oregon-postgres.render.com`)  
**Database:** `bha_cst_1sh0`  
**User:** `bha_cst_user`  

### Connection Attempt Results:
* **Network Connectivity Test:**
  `nc -zv -w 3 dpg-db8he2qvcj2c73ado3s0-a.oregon-postgres.render.com 5432`  
  **Result:** `Connection succeeded` (Render IP allowlist permits the current operator host).
* **Database TLS & Auth Connection Test:**
  Connecting with `PGSSLMODE=require` without credentials:
  **Result:** `Connection error: password authentication failed for user "bha_cst_user" (PostgreSQL error code 28P01)`.
* **Verification Status:**  
  `BLOCKED — PRODUCTION DATABASE VERIFICATION NOT EXECUTED`  
  No production credentials (`PGPASSWORD`) are stored in the local workspace or repository. In accordance with security protocols, credentials were not guessed, bypassed, or extracted.

### Exact Read-Only Queries Ready for Operator Execution:

```sql
-- Query A: Join messages to conversations and systems
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

-- Query B: Orphan message check
SELECT count(*) AS orphan_message_count
FROM messages AS m
LEFT JOIN conversations AS c
  ON c.conversation_id = m.conversation_id
WHERE c.conversation_id IS NULL;

-- Query C: Physical Foreign Key definitions
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

*(Executed against local PostgreSQL running the identical production schema: returned 10 valid joined rows, 0 orphans, and confirmed constraint definitions `FOREIGN KEY (system_id) REFERENCES systems(system_id)` and `FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)`).*

---

## 5. Audit 5541 and Loop ID Reconciliation

- **Loop Discrepancy:**
  - Operator record / review prompt: `LOOP-1790985133889-XKWD`
  - Canonical repository records: `LOOP-1790985133890-XKWD`
- **Reconciliation Finding:**
  `LOOP-1790985133889-8D7U` is the person-to-unit mapping loop (Codex row 467 / K9VT).  
  `LOOP-1790985133890-XKWD` is the transcript persistence foreign-key fix loop (Codex row 471 / XKWD).  
  The operator prompt ID `...889-XKWD` was an off-by-one timestamp typo conflating the prefix of loop `8D7U` (`...889`) with the suffix of loop `XKWD`.  
  **Authoritative Loop ID:** `LOOP-1790985133890-XKWD`.
- **Relog Delta Against Audit 5541:**
  1. *Previous State (Audit 5541):* Lacked explicit positive/negative executed test counts; lacked negative test assertions for `TranscriptPersistenceError`; lacked documentation of `ON DELETE` behavior; mission fit was omitted from the primary body.
  2. *Current State:* Added 16 automated tests (10 positive, 6 negative) covering schema, real PostgreSQL, and stub durability with `TranscriptPersistenceError` and `ConversationPersistenceError`. Defined exact SQL verification queries. Explicitly diagnosed the production connection block.

---

## 6. Codex Parked-Log Fields

- **Mission Fit:**  
  "Every CST support transcript is durably anchored to the correct conversation, tenant and system, preventing orphan transcript records and preserving traceability across the customer support lifecycle."
- **Lane / Card:**  
  `Card ID not verified — CST conversation/transcript persistence integrity lane`
- **Commercial Impact:**  
  Durable conversation persistence prevents silent loss of customer transcripts. Without the fix, voice and text conversations appear to succeed but fail silently in database persistence, leaving support operators with no audit trail and damaging downstream Monitoring Twin context.
- **Proof Type:**  
  - Migration: `db/migrations/001_initial_schema.sql` (lines 18–19, 33–34)
  - Implementation: `engine/src/db/client.ts` (lines 1133–1156, 1224–1233, 1307–1311)
  - Test Suite: `tests/db/conversation_fk_integrity.test.ts` (16 executed tests: 10 positive, 6 negative, 0 failed)
  - Production SQL: `docs/evidence/2026-11-13-xkwd-row-471-resubmission-evidence.md` (§4)
- **Session Type:**  
  `Build` (includes implementation changes and 16 automated regression tests).
- **Next Owner:**  
  1. *Infrastructure/Database Owner:* Execute read-only queries A, B, and C against `bha_cst_1sh0` on Render PostgreSQL resource `dpg-db8he2qvcj2c73ado3s0-a`.
  2. *Ahad:* Record the query output artifact in the official Codex parked log.
  3. *Jason / Bays Network:* Formal review and sign-off on Codex row 471.

---

## 7. Official Record Status

- **Codex Parked Log:** Prepared copy-ready draft; log itself was **not updated** (no write credentials in workspace).
- **Slack:** No Slack messages sent.
- **Decision Watch `DW-1794577466654-7V10`:** Kept untouched.
- **Loop Status:** Kept in `IN PROGRESS` / `Partially Aligned` pending production query output.
- **Closure Decision:** `BLOCKED_BY_PRODUCTION_DATABASE_ACCESS`

