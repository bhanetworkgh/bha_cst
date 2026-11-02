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
    (await tableExists(client, 'dashboard_publish_outcomes')) &&
    (await columnExists(client, 'dashboard_publish_outcomes', 'event_type')) &&
    (await columnExists(client, 'dashboard_publish_outcomes', 'status')) &&
    (await indexExists(client, 'idx_dashboard_publish_outcomes_status')) &&
    (await indexExists(client, 'idx_dashboard_publish_outcomes_created')) &&
    (await indexExists(client, 'unq_dashboard_publish_outcomes_event')),

  '021_repair_service_number_bindings.sql': async (client) => {
    const r = await client.query(
      `SELECT 1 FROM service_number_bindings WHERE phone_e164 = '+19715885823' AND capability = 'sms_voice'`
    );
    return r.rows.length > 0;
  },

  '022_add_escalations_table.sql': async (client) =>
    (await tableExists(client, 'escalations')) &&
    (await columnExists(client, 'escalations', 'id')) &&
    (await columnExists(client, 'escalations', 'caller_phone')) &&
    (await columnExists(client, 'escalations', 'tenant_id')) &&
    (await columnExists(client, 'escalations', 'project_id')) &&
    (await columnExists(client, 'escalations', 'conversation_id')) &&
    (await columnExists(client, 'escalations', 'correlation_id')) &&
    (await columnExists(client, 'escalations', 'caller_email')) &&
    (await columnExists(client, 'escalations', 'reason')) &&
    (await columnExists(client, 'escalations', 'transcript')) &&
    (await columnExists(client, 'escalations', 'slack_notified')) &&
    (await columnExists(client, 'escalations', 'slack_notified_at')) &&
    (await columnExists(client, 'escalations', 'slack_error')) &&
    (await columnExists(client, 'escalations', 'created_at')) &&
    (await columnExists(client, 'escalations', 'status')) &&
    (await constraintExists(client, 'ck_escalation_status')) &&
    (await indexExists(client, 'idx_escalations_correlation')) &&
    (await indexExists(client, 'idx_escalations_tenant')) &&
    (await indexExists(client, 'idx_escalations_status')) &&
    (await indexExists(client, 'idx_escalations_caller_phone')),

  '023_reconcile_duplicate_003_and_schema_drift.sql': async (client) => {
    if (!(await tableExists(client, 'customers'))) return false;
    if (!(await tableExists(client, 'security_ledger'))) return false;
    if (!(await columnExists(client, 'customers', 'id'))) return false;
    if (!(await columnExists(client, 'customers', 'updated_at'))) return false;
    if (!(await constraintExists(client, 'unq_customers_tenant_project_phone'))) return false;
    if (!(await indexExists(client, 'idx_customers_phone'))) return false;
    if (!(await indexExists(client, 'idx_customers_tenant_phone'))) return false;
    if (!(await indexExists(client, 'idx_security_ledger_tenant'))) return false;

    const pkRes = await client.query(`
      SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS pk_cols
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       WHERE c.conrelid = to_regclass('public.customers')
         AND c.contype = 'p'
    `);
    if (pkRes.rows[0]?.pk_cols !== 'id') return false;

    const lenRes = await client.query(`
      SELECT column_name, character_maximum_length
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'customers'
         AND column_name IN ('unit_id', 'farm_id')
    `);
    if (lenRes.rows.length !== 2) return false;
    return lenRes.rows.every((row) => Number(row.character_maximum_length) === 128);
  },
};

/** Human-readable summary of which migrations in `files` lack an explicit check. */
export function uncheckedMigrations(files) {
  return files.filter((f) => !(f in migrationEffectChecks));
}
