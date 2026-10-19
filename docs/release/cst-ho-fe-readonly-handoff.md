# HOFE Read-Only Handoff

## Findings (read-only)
- Render CLI available (v2.30.0), workspace BHA-CST confirmed.
- Service bha-cst healthy (/health 200). DB bha-cst-postgres free, expires 2026-11-14; IP allowlist empty (blocks external access).
- Migrations 017/018 code verified; local tests (consent 38/38, 5R0J 26/26, KMG9 9/9, full 584/590) pass.

## Required SQL (for authorized operator)
```sql
-- Verify migrations
SELECT filename, checksum, applied_at FROM schema_migrations 
WHERE filename IN ('017_sms_consent_audit_fk.sql','018_sms_consent_prompts.sql');

-- Table constraints/indexes
\d sms_consent_audit
\d sms_consent_prompts

-- Check triggers
SELECT tgname FROM pg_trigger WHERE tgrelid='sms_consent_audit'::regclass;
```

## Status
BLOCKED: DB verification requires authorized access via approved path. DW-96O8 needs owner decision on acceptance policy (production-only vs staging). No unsafe changes.
