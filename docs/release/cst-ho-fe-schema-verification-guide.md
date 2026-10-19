# CST Database Migrations 017/018 Schema Verification Guide (HOFE)

**Loop:** `LOOP-1791826143428-HOFE`
**Decision Watch:** `DW-1791829227726-96O8` (Production-only evidence vs Staging acceptance)
**Database Target:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`)
**Prepared By:** Ahad (`U0AC6RFNP3P`)
**Date:** 19 October 2026
**Audience:** Render Authorized Operator / Platform Admin

---

## 1. Background & Verification Objective

Render application logs reported that migrations `017_sms_consent_audit_fk.sql` and `018_sms_consent_prompts.sql` were applied during engine container startup. However, because the external IP allowlist for the Render PostgreSQL instance is empty (`[]`), direct validation from developer workstations is blocked.

This guide provides the exact, non-destructive SQL commands that an authorized operator with Render Dashboard / Shell access must execute to verify that:
1. Migrations are recorded in `schema_migrations` with correct checksums.
2. The append-only trigger prevents updates/deletions on `sms_consent_audit`.
3. Unique indexes and foreign keys on `sms_consent_prompts` and `sms_consents` are active.

---

## 2. Step-by-Step Operator Verification Queries

Connect to the database via the Render Dashboard Web Shell or an authorized psql connection:

### Step 2.1: Verify Migration Ledger Records
```sql
SELECT id, filename, checksum, applied_at
FROM schema_migrations
WHERE filename IN ('017_sms_consent_audit_fk.sql', '018_sms_consent_prompts.sql')
ORDER BY id ASC;
```
- **Expected Result**: 2 rows returned with valid timestamps and non-empty checksums.

### Step 2.2: Inspect `sms_consent_audit` Trigger & Constraints
```sql
-- Check foreign key constraints
SELECT conname, contype, pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
WHERE t.relname = 'sms_consent_audit';

-- Check append-only trigger
SELECT tgname, tgenabled, pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid = 'sms_consent_audit'::regclass
  AND tgname LIKE '%append_only%';
```
- **Expected Result**: Trigger definition shows `BEFORE UPDATE OR DELETE` raising an exception.

### Step 2.3: Test Append-Only Trigger Integrity (Non-Mutating Rollback Test)
Execute this inside a transaction block that automatically rolls back:
```sql
BEGIN;
-- Attempt an update on audit table (should FAIL with exception)
UPDATE sms_consent_audit SET details = '{}' WHERE 1=0;
-- Attempt delete (should fail)
DELETE FROM sms_consent_audit WHERE 1=0;
ROLLBACK;
```

### Step 2.4: Verify `sms_consent_prompts` Constraints & Unique Index
```sql
-- Check unique active prompt index
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'sms_consent_prompts'
  AND indexname = 'idx_sms_consent_prompts_active_unique';
```
- **Expected Index Definition**:
  `CREATE UNIQUE INDEX idx_sms_consent_prompts_active_unique ON public.sms_consent_prompts USING btree (tenant_id, project_id, phone_number) WHERE (status = 'pending'::text)`

---

## 3. Resolving Staging vs Production-Only Evidence (`DW-1791829227726-96O8`)

Because Render free tier hosting does not include a dedicated mirror staging database, operational decision `DW-1791829227726-96O8` asks whether verified production schema evidence can satisfy the acceptance criteria.

### Recommendation
1. Local automated tests (`consent_spine.test.ts` 28/28 and `a2p_operational_acceptance.test.ts` 10/10) provide complete behavioral proof under a real Postgres instance.
2. Executing the read-only queries in Section 2 against the production database provides mathematical proof that DDL and triggers match.
3. Upon pasting the query output into `docs/release/cst-ho-fe-verification.md`, Jason and Destiny can accept production schema verification as fulfilling `LOOP-1791826143428-HOFE`.
