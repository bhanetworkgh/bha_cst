import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import url from 'url';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/bha_cst';

async function runMigrations() {
  // Never log the connection string itself - it carries the DB password.
  const target = new url.URL(connectionString);
  console.log(`Connecting to ${target.hostname}${target.pathname} as ${target.username}...`);
  const pool = new pg.Pool({ connectionString });

  const migrationsDir = path.join(process.cwd(), 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.error(`Migrations directory not found at ${migrationsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} SQL migration file(s):`, files);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    console.log(`Applying migration: ${file}...`);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await pool.query(sql);
      console.log(`✓ Successfully applied: ${file}`);
    } catch (err) {
      console.error(`✗ Error applying ${file}:`, err.message);
      process.exit(1);
    }
  }

  console.log('🎉 All database migrations applied successfully!');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
