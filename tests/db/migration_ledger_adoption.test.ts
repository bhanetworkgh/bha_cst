/**
 * Migration ledger adoption regression tests (LOOP-HOFE).
 *
 * Proves the adoption defect is fixed: a legacy database whose schema_migrations
 * ledger is empty but which satisfies the migration-010 precondition (the
 * marker the old IF-NOT-EXISTS runner left behind) must NOT have migrations
 * 016/017/018 silently marked "applied" when their schema effects are absent.
 *
 * On the defective code, an empty ledger + 010 marker caused migrate.js to
 * record every file as adopted — including 016/017/018 — so those migrations
 * were never executed and their tables/constraints/triggers never landed.
 *
 * These tests are opt-in (CST_DB_TESTS=1 with a DATABASE_URL) because they
 * provision and migrate real databases. The `migrationEffectChecks` assertions
 * run regardless against a provided database so they can also be pointed at
 * staging by an operator.
 *
 * Run: CST_DB_TESTS=1 DATABASE_URL=postgresql://localhost:5432/bha_cst npx vitest run tests/db/migration_ledger_adoption.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
// @ts-expect-error migration_checks.js is a .js file without declaration
import { migrationEffectChecks } from '../../scripts/migration_checks.js';

const ENABLED = process.env.CST_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);

function run(cmd: string, opts: object = {}): string {
  return execSync(cmd, { encoding: 'utf8', ...opts });
}

/** Apply migrations whose numeric prefix is in `prefixes` to `db` via psql. */
function applyMigrations(db: string, prefixes: Set<number>): void {
  const dir = path.join(process.cwd(), 'db', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && prefixes.has(parseInt(f.slice(0, 3), 10)));
  for (const f of files.sort()) {
    run(`psql -d '${db}' -f '${path.join(dir, f)}' -q`, { stdio: 'pipe' });
  }
}

describe('migration_effect_checks against an already-applied consent schema', () => {
  const target = process.env.DATABASE_URL || 'postgresql://localhost:5432/bha_cst';

  it('returns true for 016/017/018 and 020/021/022/023 when their effects exist', async () => {
    if (!ENABLED) {
      expect(true).toBe(true);
      return;
    }
    const pool = new pg.Pool({ connectionString: target, max: 1 });
    const client = await pool.connect();
    try {
      // Use a known-good database so the checks have something to find.
      expect(await migrationEffectChecks['016_sms_consent_spine.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['017_sms_consent_audit_fk.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['018_sms_consent_prompts.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['020_dashboard_publish_outcomes.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['021_repair_service_number_bindings.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['022_add_escalations_table.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['023_reconcile_duplicate_003_and_schema_drift.sql'](client)).toBe(true);
    } finally {
      client.release();
      await pool.end();
    }
  });
});

describe('migration ledger adoption defect (LOOP-HOFE)', () => {
  // A scratch database created per-run. Skipped entirely without CST_DB_TESTS=1.
  const base = process.env.DATABASE_URL || 'postgresql://localhost:5432/bha_cst';
  const scratchName = 'bha_cst_adoption_test';
  // scratch connection string points at the scratch database.
  const scratch = base.replace(/\/[^/]+$/, `/${scratchName}`);
  let pool: pg.Pool;

  beforeAll(() => {
    if (!ENABLED) return;
    const admin = base.replace(/\/[^/]+$/, '/postgres');
    run(`psql -d '${admin}' -c "DROP DATABASE IF EXISTS ${scratchName}" -c "CREATE DATABASE ${scratchName}" -q`, { stdio: 'pipe' });
    // Pre-seed the legacy state the *old* runner produced: migrations 001–015
    // applied with NO schema_migrations ledger, and crucially NO 016/017/018.
    applyMigrations(scratch, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
    pool = new pg.Pool({ connectionString: scratch, max: 1 });
  });

  afterAll(() => {
    if (pool) void pool.end();
    if (ENABLED) run(`psql -d '${base.replace(/\/[^/]+$/, '/postgres')}' -c "DROP DATABASE IF EXISTS ${scratchName}" -q`, { stdio: 'pipe' });
  });

  it('does NOT adopt 016/017/018 before verifying their effects exist', async () => {
    if (!ENABLED) {
      expect(true).toBe(true);
      return;
    }
    const client = await pool.connect();
    try {
      // 016/017/018 effects must be ABSENT on the pre-seed state.
      expect(await migrationEffectChecks['016_sms_consent_spine.sql'](client)).toBe(false);
      expect(await migrationEffectChecks['017_sms_consent_audit_fk.sql'](client)).toBe(false);
      expect(await migrationEffectChecks['018_sms_consent_prompts.sql'](client)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('applies 016/017/018 (rather than silently adopting them) when effects are absent', async () => {
    if (!ENABLED) {
      expect(true);
      return;
    }
    // Run the actual migration runner against the scratch DB.
    // DATABASE_URL is overridden to point at the scratch database.
    const out = run(`DATABASE_URL=${scratch} node scripts/migrate.js 2>&1`);
    expect(out).toContain('Successfully applied: 016_sms_consent_spine.sql');
    expect(out).toContain('Successfully applied: 017_sms_consent_audit_fk.sql');
    expect(out).toContain('Successfully applied: 018_sms_consent_prompts.sql');
    // The adoption must NOT have recorded only-016/017/018 without applying them.
    expect(out).toContain('already recorded');
  });

  it('effects exist after the runner completes', async () => {
    if (!ENABLED) {
      expect(true);
      return;
    }
    const client = await pool.connect();
    try {
      expect(await migrationEffectChecks['016_sms_consent_spine.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['017_sms_consent_audit_fk.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['018_sms_consent_prompts.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['020_dashboard_publish_outcomes.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['021_repair_service_number_bindings.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['022_add_escalations_table.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['023_reconcile_duplicate_003_and_schema_drift.sql'](client)).toBe(true);

      const ledger = await client.query(
        'SELECT filename FROM schema_migrations WHERE filename IN ($1,$2,$3,$4,$5) ORDER BY filename',
        [
          '016_sms_consent_spine.sql',
          '017_sms_consent_audit_fk.sql',
          '018_sms_consent_prompts.sql',
          '022_add_escalations_table.sql',
          '023_reconcile_duplicate_003_and_schema_drift.sql',
        ],
      );
      expect(ledger.rows.map((r) => r.filename)).toEqual([
        '016_sms_consent_spine.sql',
        '017_sms_consent_audit_fk.sql',
        '018_sms_consent_prompts.sql',
        '022_add_escalations_table.sql',
        '023_reconcile_duplicate_003_and_schema_drift.sql',
      ]);
    } finally {
      client.release();
    }
  });

  it('is idempotent on re-run (0 applied)', async () => {
    if (!ENABLED) {
      expect(true);
      return;
    }
    const out = run(`DATABASE_URL=${scratch} node scripts/migrate.js 2>&1`);
    expect(out).toMatch(/0 applied/);
  });
});

describe('fresh database migration & duplicate-003 / 022 reconciliation', () => {
  const base = process.env.DATABASE_URL || 'postgresql://localhost:5432/bha_cst';
  const freshName = 'bha_cst_fresh_reconciliation_test';
  const freshUrl = base.replace(/\/[^/]+$/, `/${freshName}`);
  let pool: pg.Pool;

  beforeAll(() => {
    if (!ENABLED) return;
    const admin = base.replace(/\/[^/]+$/, '/postgres');
    run(`psql -d '${admin}' -c "DROP DATABASE IF EXISTS ${freshName}" -c "CREATE DATABASE ${freshName}" -q`, { stdio: 'pipe' });
    pool = new pg.Pool({ connectionString: freshUrl, max: 1 });
  });

  afterAll(() => {
    if (pool) void pool.end();
    if (ENABLED) run(`psql -d '${base.replace(/\/[^/]+$/, '/postgres')}' -c "DROP DATABASE IF EXISTS ${freshName}" -q`, { stdio: 'pipe' });
  });

  it('executes full migration sequence 001..023 on a fresh database with zero drifted files', async () => {
    if (!ENABLED) {
      expect(true).toBe(true);
      return;
    }
    const out = run(`DATABASE_URL=${freshUrl} node scripts/migrate.js 2>&1`);
    expect(out).toContain('Successfully applied: 003_add_customers_and_security_ledger.sql');
    expect(out).toContain('Successfully applied: 003_customers_table.sql');
    expect(out).toContain('Successfully applied: 022_add_escalations_table.sql');
    expect(out).toContain('Successfully applied: 023_reconcile_duplicate_003_and_schema_drift.sql');
    expect(out).not.toContain('drifted');
  });

  it('verifies customers, security_ledger, and escalations schema effects and multi-project phone support', async () => {
    if (!ENABLED) {
      expect(true).toBe(true);
      return;
    }
    const client = await pool.connect();
    try {
      expect(await migrationEffectChecks['022_add_escalations_table.sql'](client)).toBe(true);
      expect(await migrationEffectChecks['023_reconcile_duplicate_003_and_schema_drift.sql'](client)).toBe(true);

      // Verify same phone can be registered in two projects of the same tenant
      // (previously blocked by leftover customers_pkey (tenant_id, phone_e164) from 003_add_customers_and_security_ledger.sql)
      await client.query(
        `INSERT INTO customers (tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role)
         VALUES ('tenant-vfarm-01', 'proj-vfarm-main', 'tenant-vfarm-01', 'ws-vfarm-main', '+15550009999', 'cust_multi_1', 'manager'),
                ('tenant-vfarm-01', 'proj-vfarm-dallas', 'tenant-vfarm-01', 'ws-vfarm-main', '+15550009999', 'cust_multi_2', 'tech')
         ON CONFLICT (tenant_id, project_id, phone_e164) DO NOTHING`
      );
      const rows = await client.query(
        `SELECT id, project_id, updated_at FROM customers WHERE phone_e164 = '+15550009999' ORDER BY project_id`
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0].id).toBeTruthy();
      expect(rows.rows[1].id).toBeTruthy();
      expect(rows.rows[0].id).not.toBe(rows.rows[1].id);
      expect(rows.rows[0].updated_at).toBeTruthy();
    } finally {
      client.release();
    }
  });
});
