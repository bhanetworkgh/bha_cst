import { defineConfig } from 'vitest/config';

export default defineConfig({
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
