# HOFE (Migrations 017/018) Readiness Note
- Migration files present: db/migrations/017_sms_consent_audit_fk.sql, 018_sms_consent_prompts.sql.
- Runner: scripts/migrate.js (ledger-based with checksums, advisory lock, drift detection).
- Code-level: consent_audit FK, prompts constraints, append-only behavior enforced (per existing tests/docs).
- Staging evidence missing: schema_migrations rows (applied_at/checksum), migrate.js logs from staging, SMS consent E2E on staging. Do not apply migrations.
- Owner: Claude on Render / Ops/DB admin. See cst-closure-checklist.md for exact evidence required.
