import pg from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import url from 'url';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/bha_cst';

// Arbitrary but fixed key so two instances booting at the same time (Render can
// overlap a deploy and a restart) cannot both apply the same migration.
const ADVISORY_LOCK_KEY = 812345671;

/**
 * Discover migration files in a deterministic order.
 *
 * Ordering is by numeric prefix, then by full filename. Previously this was a
 * plain lexicographic `.sort()`, which happened to work only because the
 * filenames are zero-padded to three digits. A duplicate prefix is reported but
 * NOT rejected: `db/migrations` legitimately contains two `003_` files, and
 * refusing to boot over that would be a regression. The ledger is what makes the
 * duplicate harmless — the recorded order is stable from the first run onward.
 */
export function discoverMigrations(migrationsDir) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => {
      const pa = parseInt(a.slice(0, 3), 10);
      const pb = parseInt(b.slice(0, 3), 10);
      if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });

  const byPrefix = new Map();
  for (const f of files) {
    const p = f.slice(0, 3);
    byPrefix.set(p, [...(byPrefix.get(p) || []), f]);
  }
  const duplicates = [...byPrefix.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([k, v]) => `${k} (${v.join(', ')})`);

  return { files, duplicates };
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 32);
}

/**
 * Decide whether an empty ledger means "fresh database, apply everything" or
 * "existing database whose history predates the ledger".
 *
 * These are indistinguishable from the file list alone, and getting it wrong is
 * destructive, so the marker has to come from the database. Migration 010 added
 * `conversations.project_id` and replaced the 003 unique constraint with
 * `unq_conversations_tenant_project_customer`. Their presence proves the
 * database is already past 010, i.e. every file on disk has run at least once.
 *
 * This matters concretely: on an already-migrated database, re-applying
 * `003_add_customers_and_security_ledger.sql` fails, because it re-adds
 * `unq_conversations_tenant_customer` — a constraint migration 010 deliberately
 * dropped, and which current data violates. `render.yaml` runs
 * `node scripts/migrate.js && npm start`, so that failure is a boot failure.
 */
async function looksAlreadyMigrated(client) {
  // `to_regclass` (not `'conversations'::regclass`) because a fresh database has
  // no `conversations` table yet and a bare regclass cast raises instead of
  // returning NULL.
  const { rows } = await client.query(`
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'conversations'
          AND column_name = 'project_id'
      ) AS has_project_id,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.conversations')
          AND conname = 'unq_conversations_tenant_project_customer'
      ) AS has_010_constraint
  `);
  return Boolean(rows[0]?.has_project_id && rows[0]?.has_010_constraint);
}

async function runMigrations() {
  // Never log the connection string itself - it carries the DB password.
  const target = new url.URL(connectionString);
  console.log(`Connecting to ${target.hostname}${target.pathname} as ${target.username}...`);
  const pool = new pg.Pool({ connectionString, max: 1 });

  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found at ${migrationsDir}`);
    process.exit(1);
  }

  const { files, duplicates } = discoverMigrations(migrationsDir);
  console.log(`Found ${files.length} SQL migration file(s).`);
  if (duplicates.length) {
    // Loud, but non-fatal. These files are already applied on deployed
    // databases, so renaming them would invalidate the ledger. Ordering is
    // deterministic regardless, and the ledger records the actual sequence.
    console.warn(
      `⚠ Duplicate migration prefix(es): ${duplicates.join('; ')}. ` +
        `They are applied in filename order and recorded individually. Do not rename them.`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    // ── Ledger ────────────────────────────────────────────────────────────────
    // Previously migrations had no bookkeeping at all: every file was re-applied
    // on every boot, relying entirely on each file's own IF NOT EXISTS guards.
    // That made "was this applied?" unanswerable and made any future renumbering
    // dangerous. Applied files are now recorded by filename + checksum.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const { rows: applied } = await client.query(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

    // ── Ledger adoption ───────────────────────────────────────────────────────
    // An empty ledger on an already-migrated database must not replay history.
    const forceBaseline = process.argv.includes('--baseline');
    const forceApply = process.argv.includes('--force');

    if (appliedMap.size === 0 && !forceApply) {
      const already = forceBaseline || (await looksAlreadyMigrated(client));
      if (already) {
        console.log(
          'Ledger is empty but this database is already migrated (conversations ' +
            'carries project_id and the 010 unique constraint). Recording all ' +
            'discovered files as applied WITHOUT replaying them, so only genuinely ' +
            'new migrations run from now on.',
        );
        for (const file of files) {
          const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          await client.query(
            'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
            [file, checksum(sql)],
          );
        }
        console.log(`✓ Recorded ${files.length} existing migration(s) in schema_migrations.`);
        console.log(
          '  To replay every file from scratch instead, run: node scripts/migrate.js --force',
        );
        console.log('🎉 Migrations complete: 0 applied, ledger initialised.');
        return;
      }
      console.log('Ledger is empty and the database looks fresh — applying all migrations.');
    } else if (forceApply) {
      console.log('--force given: re-applying every migration regardless of the ledger.');
    }

    let ran = 0;
    let skipped = 0;
    let drifted = 0;
    const driftedFiles = [];

    // Deliberate reconciliation of an edited, already-applied migration.
    // The drift warning above is the safety net; this is the escape hatch, and
    // it is opt-in per file so drift can never be accepted by accident.
    const rebaselineArg = process.argv.indexOf('--rebaseline');
    const rebaseline = rebaselineArg !== -1 ? process.argv[rebaselineArg + 1] : undefined;
    if (rebaseline && !files.includes(rebaseline)) {
      throw new Error(`--rebaseline target is not a migration on disk: ${rebaseline}`);
    }

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      const sum = checksum(sql);

      if (appliedMap.has(file)) {
        if (appliedMap.get(file) !== sum) {
          if (rebaseline === file) {
            console.warn(
              `⚠ Re-baselining ${file}: its recorded checksum did not match its contents. ` +
                `The file is NOT re-applied — this only updates the ledger so the drift ` +
                `warning stops. Confirm the edit was a no-op for an already-migrated ` +
                `database, and put any real data change in a NEW migration.`,
            );
            await client.query(
              'UPDATE schema_migrations SET checksum = $2, applied_at = CURRENT_TIMESTAMP WHERE filename = $1',
              [file, sum],
            );
            appliedMap.set(file, sum);
            console.log(`· re-baselined: ${file}`);
            continue;
          }
          // Warn, do not fail: an already-applied file being edited must not
          // break a running deployment.
          console.warn(
            `⚠ ${file} was already applied but its contents have changed. ` +
              `Not re-applying. Add a NEW migration instead of editing this one.` +
              (rebaseline
                ? ` (use --rebaseline ${file} to accept this edit deliberately)`
                : ''),
          );
          drifted++;
          driftedFiles.push(file);
        } else {
          console.log(`· already applied, skipping: ${file}`);
        }
        skipped++;
        continue;
      }

      console.log(`Applying migration: ${file}...`);
      // One transaction per migration, and the ledger row is written inside it,
      // so a failure can never leave a migration marked as applied.
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [file, sum],
        );
        await client.query('COMMIT');
        console.log(`✓ Successfully applied: ${file}`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`✗ Error applying ${file}:`, err.message);
        console.error('  No ledger entry was written, so it will be retried on the next boot.');
        process.exit(1);
      }
    }

    // A ledger row for a file that no longer exists means someone deleted a
    // migration. Informational: the DB state is already applied, so removing the
    // bookkeeping row is a deliberate manual action, not something to automate.
    const known = new Set(files);
    const orphans = [...appliedMap.keys()].filter((f) => !known.has(f));
    if (orphans.length) {
      console.warn(
        `⚠ Ledger contains ${orphans.length} file(s) no longer on disk: ${orphans.join(', ')}. ` +
          `Their schema is already applied; delete the ledger rows by hand if that is intended.`,
      );
    }

    console.log(
      `🎉 Migrations complete: ${ran} applied, ${skipped} already recorded` +
        (drifted ? `, ${drifted} drifted (warned above)` : '') + '.',
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
