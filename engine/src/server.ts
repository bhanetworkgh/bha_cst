import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { Logger } from './config/logger.js';
import { processOutboundQueue } from './transport/twilio/outbound.js';
import { DbClient } from './db/client.js';

import { CoreRegistry } from './core/registry.js';

// Validate all required env vars at startup — throws a clear error listing
// every missing field before binding any port.
const env = getEnv();
const app = createApp();

// Bootstrap durable project & binding registry from Postgres
await CoreRegistry.initFromDb().catch((err) => {
  Logger.warn(`Failed to initialize CoreRegistry from DB: ${err.message}`);
});

const server = app.listen(env.PORT, () => {
  Logger.info(`CS Twin Engine listening on port ${env.PORT}`, {
    node_env: env.NODE_ENV,
    service: 'bha-cst',
  });
  const vfarmAdapter = CoreRegistry.getVfarmAdapter();
  const targetFarm = vfarmAdapter?.getActiveFarmId() || process.env.VFARM_FARM_ID || 'dynamic-discovery';
  if (vfarmAdapter?.hasLiveClient() || process.env.VFARM_FARM_KEY) {
    console.log(`[vFarm] Initialized with Live Key. Target Farm: ${targetFarm}`);
    Logger.info(`[vFarm] Initialized with Live Key. Target Farm: ${targetFarm}`);
  } else {
    console.log(`[vFarm] Initialized with Dynamic Auth. Target Farm: ${targetFarm}`);
    Logger.info(`[vFarm] Initialized with Dynamic Auth. Target Farm: ${targetFarm}`);
  }
});


// ── Outbound Queue Background Worker Loop ──────────────────────────────────
// Polls the database for pending outbound messages every 5 seconds so retries
// and background-queued messages deliver automatically.
const WORKER_INTERVAL_MS = 5000;
const workerTimer = setInterval(async () => {
  try {
    await processOutboundQueue();
  } catch (err: any) {
    Logger.error(`Outbound background worker error: ${err.message}`);
  }
}, WORKER_INTERVAL_MS);

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
// Render and AWS send SIGTERM before killing the process.
// We close the HTTP server, drain inflight requests, then release the DB pool.
function shutdown(signal: string): void {
  Logger.info(`Received ${signal} — starting graceful shutdown`);
  clearInterval(workerTimer);
  server.close(async (err) => {
    if (err) {
      Logger.error(`Error during server shutdown: ${err.message}`);
    }
    Logger.info('HTTP server closed. Closing database pool...');
    await DbClient.disconnect().catch((e: Error) =>
      Logger.warn(`DbClient.disconnect error: ${e.message}`)
    );
    Logger.info('Shutdown complete. Exiting.');
    process.exit(err ? 1 : 0);
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
