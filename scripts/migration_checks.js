/**
 * Schema-effect checks for the migration runner (`scripts/migrate.js`).
 *
 * Each check verifies that a migration's *schema effects* are present in a
 * database, so the runner can safely ADOPT (mark applied without executing) a
 * migration on a legacy database that was touched by the old non-ledger runner
 * — but only when the effects genuinely exist.
 *
 * This closes the adoption defect where an empty ledger on a database carrying
 * only migration-010 markers (conversations.project_id + the 010 unique
 * constraint) would cause 016/017/018 to be silently recorded as "applied"
 * even when their tables/constraints/triggers were absent.
 *
 * The checks are intentionally narrow: each inspects exactly the schema object(s)
 * that the migration creates, nothing more. A `false` return means "effects not
 * found — the migration must run".
 */
import pg from 'pg';

/** True when a relation (table/view) named `name` exists in `public`. */
export async function tableExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return r.rows.length > 0;
}

/** True when a constraint/trigger/whatever named `name` exists for `rel`. */
export async function objectExists(client, rel, kind) {
  const r = await client.query(
    `SELECT 1 FROM pg_catalog.pg_${kind}
     WHERE ${kind === 'constraint' ? 'conname' : 'tgname'} = $1
       AND ${kind === 'constraint' ? 'conrelid' : 'tgrelid'}::regclass::text = $2`,
    [rel, kind === 'constraint' ? rel : rel],
  );
  return r.rows.length > 0;
}

/** True when a CHECK constraint/column marker exists. */
export async function columnExists(client, table, column) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rows.length > 0;
}

/** True when a trigger named `name` exists in `public`. */
export async function triggerExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`,
    [name],
  );
  return r.rows.length > 0;
}

/** True when a constraint named `name` exists in `public`. */
export async function constraintExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return r.rows.length > 0;
}

/** True when an index named `name` exists in `public`. */
export async function indexExists(client, name) {
  const r = await client.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
    [name],
  );
  return r.rows.length > 0;
}

/**
 * Per-migration effect checks.
 *
 * A key is the exact migration filename. The function returns true when the
 * migration's effects are already present (safe to adopt), false when they are
 * absent (must be applied).
 *
 * Only migrations whose absence would represent a data-loss or safety hazard —
 * primarily the consent spine (016/017/018) — have explicit checks here. Older
 * migrations are covered by the `looksAlreadyMigrated` precondition in
 * migrate.js (the 010 marker proves the legacy runner executed the full
 * 001–015 sequence).
 */
export const migrationEffectChecks = {
  '016_sms_consent_spine.sql': async (client) =>
    (await tableExists(client, 'sms_consents')) &&
    (await tableExists(client, 'sms_consent_audit')) &&
    (await columnExists(client, 'sms_consents', 'wording_version')),

  '017_sms_consent_audit_fk.sql': async (client) =>
    (await constraintExists(client, 'fk_sms_consent_audit_consent')) &&
    (await indexExists(client, 'unq_sms_consents_id_tenant')) &&
    (await triggerExists(client, 'trg_sms_consent_audit_append_only')),

  '018_sms_consent_prompts.sql': async (client) =>
    (await tableExists(client, 'sms_consent_prompts')) &&
    (await indexExists(client, 'unq_sms_consent_prompts_active')) &&
    (await columnExists(client, 'sms_consent_prompts', 'expires_at')),

  '019_backfill_project_voice_pointer.sql': async (client) => {
    const r = await client.query(
      `SELECT 1 FROM projects WHERE project_id = 'proj-vfarm-main' AND elevenlabs_voice_id IS NOT NULL AND elevenlabs_voice_id != ''`
    );
    return r.rows.length > 0;
  },

  '020_dashboard_publish_outcomes.sql': async (client) =>
    await tableExists(client, 'dashboard_publish_outcomes'),

  '021_repair_service_number_bindings.sql': async (client) => {
    const r = await client.query(
      `SELECT 1 FROM service_number_bindings WHERE phone_e164 = '+19715885823' AND capability = 'sms_voice'`
    );
    return r.rows.length > 0;
  },

  '022_add_escalations_table.sql': async (client) =>
    await tableExists(client, 'escalations'),
};

/** Human-readable summary of which migrations in `files` lack an explicit check. */
export function uncheckedMigrations(files) {
  return files.filter((f) => !(f in migrationEffectChecks));
}
