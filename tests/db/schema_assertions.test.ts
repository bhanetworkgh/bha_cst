/**
 * Non-destructive schema assertion tests.
 *
 * These assert the REQUIRED DATABASE STATE from the repository's own migration
 * files. They are read-only: no migration is applied, no database is touched,
 * and no production row is read or written. Their purpose is to catch the
 * failure mode that matters for the identity fix — a migration file, a
 * constraint, or a COLUMN NAME drifting away from the code that depends on it.
 *
 * The sharpest of these is the last group: the durable customer mapping code
 * reads specific column names out of the `customers` table. If one of those
 * columns is renamed without the code following, the rehydration silently
 * stops working and every registered caller silently becomes a guest again —
 * with no test failing anywhere else.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

function migrationFiles(): { name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
}

const ALL = migrationFiles();
const ALL_SQL = ALL.map((m) => m.sql).join('\n');
const byName = (name: string) => ALL.find((m) => m.name === name)?.sql ?? '';

describe('Schema assertions — required database state (read-only, from migrations)', () => {
  // ── The customer mapping the identity rehydration depends on ──────────────

  it('the customers table carries every column the rehydration reads', () => {
    // `CustomerRecord` in engine/src/db/client.ts, and the fields the
    // rehydration in engine/src/core/registry.ts reads.
    const required = [
      'phone_e164',
      'customer_ref',
      'tenant_id',
      'project_id',
      'organization_id',
      'workspace_id',
      'role',
      'unit_id',
      'farm_id',
      'farm_ids',
      'speaker_cache_expires_at',
    ];

    // The table is created in 003 and extended by 010/012.
    const created = byName('003_customers_table.sql') + byName('003_add_customers_and_security_ledger.sql');
    for (const col of required) {
      expect(
        created.includes(col) || ALL_SQL.includes(`ADD COLUMN IF NOT EXISTS ${col}`),
        `customers.${col} must exist for the durable customer mapping`,
      ).toBe(true);
    }
  });

  it('enforces project-scoped uniqueness for a customer phone', () => {
    // One person may be a customer in more than one project of the same
    // tenant, with independent roles and farm scopes — so uniqueness is
    // (tenant_id, project_id, phone_e164), NOT (tenant_id, phone_e164).
    const sql = byName('012_customers_project_scope_and_vfarm_org_mapping.sql');
    expect(sql).toMatch(/unq_customers_tenant_project_phone/i);
    expect(sql).toMatch(/UNIQUE\s*\(tenant_id,\s*project_id,\s*phone_e164\)/i);
    // The stale per-tenant uniqueness must be gone, or one project would
    // forbid a person from being a customer in another.
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS customers_tenant_id_phone_e164_key/i);
  });

  it('references the systems table for tenant isolation on customers', () => {
    const sql = byName('003_customers_table.sql') + byName('003_add_customers_and_security_ledger.sql');
    expect(sql).toMatch(/REFERENCES\s+systems\s*\(\s*tenant_id\s*\)/i);
  });

  // ── The SMS consent spine ────────────────────────────────────────────────

  it('defines the three consent tables', () => {
    expect(byName('016_sms_consent_spine.sql')).toMatch(/CREATE TABLE IF NOT EXISTS sms_consents/i);
    expect(byName('016_sms_consent_spine.sql')).toMatch(/CREATE TABLE IF NOT EXISTS sms_consent_audit/i);
    expect(byName('018_sms_consent_prompts.sql')).toMatch(/CREATE TABLE IF NOT EXISTS sms_consent_prompts/i);
  });

  it('keeps the consent audit append-only and tenant-consistent', () => {
    const fk = byName('017_sms_consent_audit_fk.sql');
    expect(fk).toMatch(/fk_sms_consent_audit_consent/i);
    expect(fk).toMatch(/enforce_sms_consent_audit_append_only/i);
    expect(fk).toMatch(/trg_sms_consent_audit_append_only/i);
    expect(fk).toMatch(/unq_sms_consents_id_tenant/i);
  });

  it('enforces one active consent prompt per consent record', () => {
    const sql = byName('018_sms_consent_prompts.sql');
    expect(sql).toMatch(/unq_sms_consent_prompts_active/i);
    expect(sql).toMatch(/idx_sms_consent_prompts_active_lookup/i);
  });

  // ── The SMS alert-audit foreign key (the voice-audit defect's contract) ──

  it('keeps the alert-audit foreign key to a real outbound message', () => {
    const sql = byName('008_018m_alert_audit_log.sql');
    expect(sql).toMatch(
      /outbound_message_id\s+VARCHAR\(64\)\s+NOT NULL REFERENCES messages_out\(id\)/i,
    );
    // Every reference on that column must target the SAME table, and the
    // column must stay NOT NULL — a voice turn must never be able to
    // reference a non-message id.
    const references = sql.match(/outbound_message_id[^;]*?REFERENCES\s+\w+/gi) ?? [];
    expect(references.length).toBeGreaterThan(0);
    for (const ref of references) {
      expect(ref).toMatch(/REFERENCES\s+messages_out/i);
    }
  });

  // ── The voice delivery trail ─────────────────────────────────────────────

  it('defines the voice delivery record the voice audit trail writes', () => {
    const sql = byName('009_add_voice_pointer_to_systems.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS voice_deliveries/i);
    for (const col of ['status', 'voice_id', 'character_count', 'audio_bytes', 'error_code', 'correlation_id']) {
      expect(sql, `voice_deliveries.${col} must exist`).toMatch(new RegExp(`\\b${col}\\b`, 'i'));
    }
  });

  // ── Migration set and ordering ───────────────────────────────────────────

  it('keeps the migration set contiguous and ordered from 001', () => {
    const numbers = ALL.map((m) => parseInt(m.name.slice(0, 3), 10)).filter((n) => !Number.isNaN(n));
    expect(numbers[0]).toBe(1);
    // Every number from 1 to the max is present (the duplicate 003 prefix is
    // deliberate and recorded in migration 012's header).
    const unique = [...new Set(numbers)].sort((a, b) => a - b);
    for (let i = 1; i <= unique[unique.length - 1]; i++) {
      expect(unique, `migration ${String(i).padStart(3, '0')} must exist`).toContain(i);
    }
  });

  it('applies the voice-pointer and binding repairs before anything depends on them', () => {
    const voice = ALL.findIndex((m) => m.name.startsWith('019_'));
    const binding = ALL.findIndex((m) => m.name.startsWith('021_'));
    const outcomes = ALL.findIndex((m) => m.name.startsWith('020_'));
    expect(voice).toBeGreaterThanOrEqual(0);
    expect(binding).toBeGreaterThan(voice);
    expect(outcomes).toBeGreaterThanOrEqual(0);
  });

  // ── Migration 022: escalations table, columns, constraints, and indexes ──

  it('defines the escalations table with required columns, check constraint, and indexes (022)', () => {
    const sql = byName('022_add_escalations_table.sql');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS escalations/i);
    const requiredCols = [
      'id',
      'caller_phone',
      'tenant_id',
      'project_id',
      'conversation_id',
      'correlation_id',
      'caller_email',
      'reason',
      'transcript',
      'slack_notified',
      'slack_notified_at',
      'slack_error',
      'created_at',
      'status',
    ];
    for (const col of requiredCols) {
      expect(sql, `escalations.${col} must exist in 022`).toMatch(new RegExp(`\\b${col}\\b`, 'i'));
    }
    expect(sql).toMatch(/CONSTRAINT\s+ck_escalation_status\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'pending'\s*,\s*'notified'\s*,\s*'failed'\s*\)\s*\)/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_escalations_correlation ON escalations\(correlation_id\)/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_escalations_tenant ON escalations\(tenant_id,\s*created_at DESC\)/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations\(status\)/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_escalations_caller_phone ON escalations\(caller_phone\)/i);
  });

  // ── Migration 023: forward-only duplicate-003 and schema drift reconciliation ──

  it('reconciles duplicate 003 customers schema and preserves historical 006/010 checksums via 023', () => {
    const sql023 = byName('023_reconcile_duplicate_003_and_schema_drift.sql');
    expect(sql023).toMatch(/ADD COLUMN IF NOT EXISTS id VARCHAR\(64\)/i);
    expect(sql023).toMatch(/ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ/i);
    expect(sql023).toMatch(/ALTER COLUMN unit_id TYPE VARCHAR\(128\)/i);
    expect(sql023).toMatch(/ALTER COLUMN farm_id TYPE VARCHAR\(128\)/i);
    expect(sql023).toMatch(/ADD CONSTRAINT customers_pkey PRIMARY KEY \(id\)/i);
    expect(sql023).toMatch(/CREATE TABLE IF NOT EXISTS security_ledger/i);
    expect(sql023).toMatch(/idx_security_ledger_tenant/i);

    // Ensure 006 and 010 do not contain unescaped apostrophes in SQL literals
    const sql006 = byName('006_seed_initial_customers.sql');
    const sql010 = byName('010_add_projects_bindings_and_project_id.sql');
    expect(sql006).not.toContain("Support. I'm here");
    expect(sql010).not.toContain("Support. I'm here");
  });
});
