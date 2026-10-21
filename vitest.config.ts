import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Each test file runs in a FORKED child process, not a worker thread.
  //
  // Vitest 1.x defaults to the `threads` pool, where every test file shares
  // ONE process environment. Several suites set process-wide variables
  // (CST_API_KEY, VFARM_LIVE_TEST, VFARM_TENANT_ORG_ID) to exercise
  // configuration branches, so one file could observe another's environment:
  // 51 failures across 8 files when the file order changed, plus the
  // intermittent single-file failures this suite has shown for some time.
  // Forked processes give each file its own environment and remove that class
  // of failure. (Vitest 1.x has no `fileParallelism` option — it arrived in v2.)
  pool: 'forks',
  test: {
    exclude: ['**/node_modules/**', '**/.kilo/**', '**/dist/**'],
    include: ['tests/**/*.test.ts'],
    // The default 5s per-test timeout is too tight for this suite: a single
    // CoreEngine.processEnvelope call does real connector work (~2.2s measured),
    // so under parallel file execution tests intermittently exceeded 5s and the
    // run went red for no functional reason. Genuine hangs are still caught —
    // tests that must not hang assert their own explicit ceiling (see the
    // cst.turn fire-and-forget tests, which require completion well under the
    // publisher's own 60s timeout).
    testTimeout: 20000,
  },
});
