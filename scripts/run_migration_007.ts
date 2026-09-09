/**
 * Applies db/migrations/007_add_provider_sid_and_updated_at_to_messages_out.sql
 * to the bha-cst database only.
 *
 * Scope: this touches nothing but the local `messages_out` table (a bha-cst
 * table). No external system is contacted.
 *
 * The migration is idempotent (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE),
 * so re-running is safe. Everything runs inside a single transaction, so a
 * failure halfway leaves the schema untouched.
 *
 *   npx tsx scripts/run_migration_007.ts
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import url from 'url';
import dotenv from 'dotenv';

dotenv.config();

const MIGRATION_FILE = '007_add_provider_sid_and_updated_at_to_messages_out.sql';

function resolveSsl(connectionString: string): pg.ClientConfig['ssl'] {
  const host = new url.URL(connectionString).hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal) return undefined;

  // Managed providers (Render included) terminate TLS with a chain that Node's
  // default trust store may not carry. Verify properly when a CA bundle is
  // supplied; otherwise keep the connection encrypted but unverified.
  const caPath = process.env.PGSSLROOTCERT;
  if (caPath) {
    return { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  console.warn('! PGSSLROOTCERT not set - TLS enabled without certificate verification.');
  return { rejectUnauthorized: false };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Add it to .env before running this migration.');
    process.exit(1);
  }

  const filePath = path.join(process.cwd(), 'db', 'migrations', MIGRATION_FILE);
  if (!fs.existsSync(filePath)) {
    console.error(`Migration file not found at ${filePath}`);
    process.exit(1);
  }
  const sql = fs.readFileSync(filePath, 'utf8');

  // Never log the connection string itself - it carries the DB password.
  const target = new url.URL(connectionString);
  console.log(`Connecting to ${target.hostname}${target.pathname} as ${target.username}...`);

  const client = new pg.Client({ connectionString, ssl: resolveSsl(connectionString) });
  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`✓ Applied ${MIGRATION_FILE}`);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(`✗ Failed to apply ${MIGRATION_FILE}: ${err.message}`);
    process.exit(1);
  }

  // Confirm the two columns and the index/trigger actually exist now.
  const { rows: cols } = await client.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'messages_out'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [['provider_sid', 'updated_at']]
  );
  const { rows: idx } = await client.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'messages_out' AND indexname = 'idx_messages_out_provider_sid'`
  );
  const { rows: trg } = await client.query(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'messages_out'::regclass AND tgname = 'trg_messages_out_updated_at'`
  );

  console.log('messages_out verification:');
  for (const c of cols) {
    console.log(`  column ${c.column_name} (${c.data_type}, nullable=${c.is_nullable})`);
  }
  console.log(`  index   idx_messages_out_provider_sid: ${idx.length ? 'present' : 'MISSING'}`);
  console.log(`  trigger trg_messages_out_updated_at: ${trg.length ? 'present' : 'MISSING'}`);

  await client.end();

  if (cols.length !== 2 || idx.length !== 1 || trg.length !== 1) {
    console.error('✗ Verification failed - schema is not in the expected state.');
    process.exit(1);
  }
  console.log('🎉 Migration 007 applied and verified.');
}

main().catch(async (err) => {
  console.error('Fatal migration error:', err.message ?? err);
  process.exit(1);
});
