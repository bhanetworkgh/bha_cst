# CST Database Continuity Plan

## Migration System
- **Runner**: scripts/migrate.js with ledger-based tracking
- **Ledger Table**: schema_migrations (filename, checksum, applied_at) with advisory lock (812345671)
- **Safety Features**:
  - One transaction per migration; ledger write inside transaction (rollback on failure prevents partial marking)
  - Checksum validation detects content drift; warns without breaking boot
  - --rebaseline flag for deliberate acceptance of drift
  - Detects legacy databases via marker columns (has_project_id + unq_conversations_tenant_project_customer)
  - Handles duplicate migration prefixes safely (warns, doesn't reject)
  - Reports orphaned ledger entries without auto-deleting

## Current Migrations (verified)
1. 001_initial_schema.sql
2. 002_add_missing_system_config_cols.sql
3. 003_add_customers_and_security_ledger.sql (duplicate prefix with 003_customers_table.sql)
4. 003_customers_table.sql (duplicate prefix - handled)
5. 004_add_role_to_customers.sql
6. 005_add_organizations_and_workspaces.sql
7. 006_seed_initial_customers.sql
8. 007_add_provider_sid_and_updated_at_to_messages_out.sql
9. 008_018m_alert_audit_log.sql
10. 009_add_voice_pointer_to_systems.sql
11. 010_add_projects_bindings_and_project_id.sql
12. 011_admin_users.sql
13. 012_customers_project_scope_and_vfarm_org_mapping.sql
14. 013_messages_out_turn_id.sql
15. 014_messages_out_next_retry_at.sql
16. 015_clear_fabricated_unit_and_farm_ids.sql
17. 016_sms_consent_spine.sql
18. 017_sms_consent_audit_fk.sql
19. 018_sms_consent_prompts.sql

## Critical Constraints
- **service_number_bindings**: Enforces unique phone mapping (phone_e164 as key)
- **sms_consent_audit**: Append-only (per HOFE/consent requirements)
- **Tenant/project FKs**: Consistent scoping enforced
- **Project IDs**: Consistently represented across relevant tables

## Production Risks & Mitigations
| Risk | Status | Mitigation |
|---|---|---|
| Free tier DB hibernation (90-day expiry noted in render.yaml) | BLOCKED for prod | Upgrade to starter+ tier; avoid cold starts causing latency |
| November 14, 2026 expiry date (previously identified) | NEEDS VERIFICATION | Confirm current DB instance expiry; get owner + action plan |
| Migration drift on existing prod DB | MITIGATED | Runner detects checksums, warns, doesn't auto-reapply changed migrations; requires NEW migration for real changes |
| Duplicate migrations (003_*) | MITIGATED | Handled by filename ordering + ledger; safe on existing DBs |

## Operational Requirements
- **Backup/Restore**: Documented need - verify Render Postgres backup configuration (point-in-time/automated backups)
- **Staging verification**: Required for migrations 017/018 (HOFE) before prod
- **Owner assignment**: Need explicit owner for DB continuity (expiry/upgrade)
- **No destructive ops**: Drop/reset/rollback never automatic; require explicit approval

## Recommendation
- Do not run destructive migrations. All changes must be additive via new migrations.
- For prod, upgrade plan from free tier.
- Verify DB expiry date (Nov 14 2026) with platform team.
