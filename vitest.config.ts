import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file runs in a FORKED child process, not a worker thread.
    //
    // Vitest 1.x defaults to the `threads` pool, where every test file shares
    // ONE process environment. Several suites set process-wide variables
    // (CST_API_KEY, VFARM_LIVE_TEST, VFARM_TENANT_ORG_ID) to exercise
    // configuration branches, so one file could observe another's environment:
    // 51 failures across 8 files when the file order changed, plus the
    // intermittent single-file failures this suite has shown for some time.
    // Forked processes give each file its own environment and remove that class
    // of failure.
    pool: 'forks',
    exclude: ['**/node_modules/**', '**/.kilo/**', '**/dist/**'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
