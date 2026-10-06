/**
 * Runtime environment probes.
 *
 * `process.env.NODE_ENV` is not a safe way to detect a test run: it is a plain
 * env var that anyone can set, and the repo's own `.env` sets it to
 * `development`. Sourcing `.env` before running vitest therefore made the suite
 * believe it was in development, which switched on the real Postgres pool and
 * disabled the NODE_ENV=test bypasses — 76 tests across 14 files failed purely
 * because of shell state.
 *
 * Vitest/Vite set `VITEST` for worker processes, so that is the signal used here
 * instead. It cannot be set by accident in production, which is also the
 * security-relevant direction: the test bypasses below can no longer be armed by
 * setting an environment variable.
 *
 * Real-database tests stay explicitly opt-in via `CST_DB_TESTS=1` and inject
 * their own pool with `DbClient.setPool(...)`.
 */

/** True when this process is executing inside a vitest/vite test worker. */
export function isTestRunner(): boolean {
  const v = process.env.VITEST;
  return v === 'true' || v === '1';
}

/**
 * True when a real Postgres pool may be created automatically.
 *
 * Always false inside a test runner: unit tests must never open a database
 * connection on their own, whether or not `DATABASE_URL` happens to be set in
 * the shell. Tests that need Postgres opt in with `CST_DB_TESTS=1` and inject a
 * pool explicitly, so this is a guard against accidents, not the opt-in itself.
 */
export function shouldAutoCreatePool(): boolean {
  if (isTestRunner()) return false;
  return Boolean(process.env.DATABASE_URL);
}

/** True when the developer has opted in to the real-Postgres test suite. */
export function dbTestsEnabled(): boolean {
  return process.env.CST_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
}
