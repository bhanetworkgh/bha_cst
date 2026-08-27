import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { Logger } from './config/logger.js';

// Validate all required env vars at startup — throws a clear error listing
// every missing field before binding any port.
const env = getEnv();
const app = createApp();

const server = app.listen(env.PORT, () => {
  Logger.info(`CS Twin Engine listening on port ${env.PORT}`, {
    node_env: env.NODE_ENV,
    service: 'bha-cst',
  });
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
// Render and AWS send SIGTERM before killing the process.
// We close the HTTP server to stop accepting new requests, then exit cleanly.
function shutdown(signal: string): void {
  Logger.info(`Received ${signal} — starting graceful shutdown`);
  server.close((err) => {
    if (err) {
      Logger.error(`Error during server shutdown: ${err.message}`);
      process.exit(1);
    }
    Logger.info('HTTP server closed. Exiting.');
    process.exit(0);
  });

  // Force exit after 10 seconds if shutdown hangs
  setTimeout(() => {
    Logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Unhandled Rejection / Exception Guards ────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  Logger.error(`Unhandled promise rejection: ${String(reason)}`);
  // Do not exit — log and continue. Render will restart if liveness fails.
});

process.on('uncaughtException', (err) => {
  Logger.error(`Uncaught exception: ${err.message} — exiting`);
  process.exit(1);
});
