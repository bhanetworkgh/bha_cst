import pg from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import url from 'url';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/bha_cst';

async function runSeeds() {
  const target = new url.URL(connectionString);
  console.log(`Connecting to ${target.hostname}${target.pathname} as ${target.username}...`);
  const pool = new pg.Pool({ connectionString });

  const seedsDir = path.join(process.cwd(), 'db', 'seeds');
  if (!fs.existsSync(seedsDir)) {
    console.error(`Seeds directory not found at ${seedsDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(seedsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} SQL seed file(s):`, files);

  for (const file of files) {
    const filePath = path.join(seedsDir, file);
    console.log(`Applying seed: ${file}...`);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await pool.query(sql);
      console.log(`✓ Successfully applied: ${file}`);
    } catch (err) {
      console.error(`✗ Error applying ${file}:`, err.message);
      process.exit(1);
    }
  }

  console.log('🌱 All seed files applied successfully!');
  await pool.end();
}

runSeeds().catch((err) => {
  console.error('Fatal seed error:', err);
  process.exit(1);
});
