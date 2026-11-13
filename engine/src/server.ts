import { createApp } from './app.js';
import { getEnv } from './config/env.js';
import { Logger } from './config/logger.js';
import { processOutboundQueue } from './transport/twilio/outbound.js';
import { DbClient } from './db/client.js';

import { CoreRegistry } from './core/registry.js';
import { SystemsRegistry } from './systems/registry.js';
import { CstDashboardPublisher, getDashboardPublisher, replayUnpublishedDashboardEvents } from './publishers/dashboard.js';
import { checkProgrammaticApiKeyBootConfig } from './middleware/programmatic_api_key.js';
import { RetryableBootstrap } from './bootstrap/bounded.js';
import { buildQueueHeartbeatPayload } from './observability/queue_heartbeat.js';
import { getResearchTwinConfigStatus } from './research_twin/config.js';

// Validate all required env vars at startup — throws a clear error listing
// every missing field before binding any port.
const env = getEnv();
const app = createApp();

const researchTwinStatus = getResearchTwinConfigStatus();
Logger.info('Research Twin integration configuration checked', {
  state: researchTwinStatus.state,
  operational: researchTwinStatus.operational,
  contract: researchTwinStatus.contract,
  missing: researchTwinStatus.missing,
});

/**
 * Maximum time the boot may spend waiting for the database-backed registry.
 *
 * WHY THIS BOUND EXISTS
 *   The registry bootstrap and the `systems` row write both run through the
 *   Postgres pool. Without a bound, a slow, restarting or unreachable
 *   database stalls the boot indefinitely and the process NEVER binds a
 *   port. While the port is unbound the service cannot answer a Twilio
 *   callback (Twilio abandons it and reports error 11203), cannot serve
 *   `/health`, and — because the outbound worker is started after the
 *   listener — never runs the queue at all. On a free-tier instance that is
 *   destroyed and cold-started repeatedly, that starves the outbound queue
 *   for as long as the database is unhappy.
 *
 *   So the boot is bounded: the listener comes up, the worker starts, and
 *   the registry bootstrap is retried in the background until it succeeds.
 *
 *   The `systems` row is the FK parent of `conversations.system_id` and
 *   `voice_deliveries.system_id`. Waiting for it before binding the port
 *   closes the window where a webhook could arrive before its parent row
 *   exists; the bound only opens that window when the database is genuinely
 *   unavailable, and in that case the conversation write already fails
 *   closed with `ConversationPersistenceError` rather than writing an
 *   orphan row.
 */
const BOOT_DB_TIMEOUT_MS = 15_000;

/**
 * Bootstrap the durable project/binding registry and the `systems` rows.
 *
 * Idempotent: it only reads the database and upserts the same rows, so
 * retrying it is safe. A failed or timed-out attempt clears the in-flight
 * marker so the next tick can try again.
 */
const registryBootstrap = new RetryableBootstrap(
  'durable registry',
  [
    (label) => CoreRegistry.initFromDb(),
    (label) => SystemsRegistry.whenPersisted(),
  ],
  BOOT_DB_TIMEOUT_MS,
);

await registryBootstrap.run();

// Startup configuration validation (non-secret). Errors are logged loudly and
// surfaced on GET /health/registry (503); inbound routing already fails closed
// for any number that lacks a binding or system registration.
{
  const registryReport = SystemsRegistry.validateConfiguration();
  if (registryReport.ok) {
    Logger.info('System registry validation passed', { systems: registryReport.systems.length });
  } else {
    Logger.error('System registry validation FAILED', {
      issues: registryReport.issues.map((i) => ({ severity: i.severity, code: i.code, system_id: i.system_id })),
    });
  }
}

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
  CstDashboardPublisher.checkBootConfig();
  // The programmatic voice API fails CLOSED at request time when its secret is
  // absent; this only reports the misconfiguration at boot so it cannot go
  // unnoticed. The engine deliberately keeps serving the signed Twilio
  // webhooks, the health endpoints and the outbound worker.
  checkProgrammaticApiKeyBootConfig();
});


// ── Outbound Queue Background Worker Loop ──────────────────────────────────
// Polls the database for pending outbound messages every 5 seconds so retries
// and background-queued messages deliver automatically.
//
// The worker is the ONLY consumer of the outbound queue. On a free-tier
// instance the process is destroyed when idle and cold-started on the next
// request, so the queue is durable in Postgres while its consumer is not.
// That makes it essential that the worker is verifiably alive: the log
// records its start and a periodic queue-depth heartbeat, so "the deployment
// succeeded" is never mistaken for "the queue is being drained".
const WORKER_INTERVAL_MS = 5000;
const WORKER_HEARTBEAT_MS = 5 * 60 * 1000;

Logger.info('Outbound background worker starting', {
  interval_ms: WORKER_INTERVAL_MS,
  node_env: env.NODE_ENV,
});

const workerTimer = setInterval(async () => {
  try {
    await processOutboundQueue();
  } catch (err: any) {
    Logger.error(`Outbound background worker error: ${err.message}`);
  }
}, WORKER_INTERVAL_MS);

// A separate, non-overlapping heartbeat timer. It reports the queue depth so
// an operator can distinguish "the worker is running and the queue is empty"
// from "the worker is not running at all" — the two look identical from
// outside the process.
const heartbeatTimer = setInterval(async () => {
  try {
    const depth = await DbClient.getOutboundQueueDepth();
    Logger.info('Outbound worker heartbeat', buildQueueHeartbeatPayload(depth));
  } catch (err: any) {
    Logger.warn(`Outbound worker heartbeat failed: ${err.message}`);
  }
}, WORKER_HEARTBEAT_MS);
heartbeatTimer.unref?.();

// ── Durable registry retry ─────────────────────────────────────────────────
// If the boot could not reach the database, keep retrying in the background so
// the service converges to a fully hydrated registry without ever needing a
// restart (and without ever leaving the port unbound).
const registryRetryTimer = setInterval(() => {
  void registryBootstrap.run().then((ok) => {
    if (ok) {
      // The wording matters: `run()` returns the SAME settled promise when
      // the first boot attempt already succeeded, so this line also fires on
      // the first tick of a perfectly healthy boot. Logging "completed on
      // retry" there would tell an operator the registry failed to bootstrap
      // when it did not. The attempt count is what distinguishes the two.
      const attempts = registryBootstrap.attemptCount();
      Logger.info('Durable registry bootstrap confirmed', {
        attempts,
        on_retry: attempts > 1,
      });
      clearInterval(registryRetryTimer);
    }
  });
}, 30_000);
registryRetryTimer.unref?.();

// ── Dashboard dead-letter replay ───────────────────────────────────────────
//
// `CstDashboardPublisher` is fire-and-forget, so a publish that failed is
// recorded durably in `dashboard_publish_outcomes` and carries the masked
// payload needed to re-send it.
//
// The replay function existed but was NEVER INVOKED, so those events were
// recorded and then never recovered: a failed publish was permanently lost
// even though the evidence and the payload were sitting in the table. The
// replay is idempotent — a successfully replayed event is marked `replayed_at`
// (durably), so it is never published twice.
const DASHBOARD_REPLAY_INTERVAL_MS = 5 * 60 * 1000;

async function replayDashboardDeadLetters(): Promise<void> {
  try {
    const results = await replayUnpublishedDashboardEvents(getDashboardPublisher());
    if (results.length === 0) return;
    const replayed = results.filter((r) => r.success).length;
    const stillFailing = results.length - replayed;
    Logger.info('Dashboard dead-letter replay pass complete', {
      examined: results.length,
      replayed,
      still_failing: stillFailing,
    });
    if (stillFailing > 0) {
      Logger.warn(
        `Dashboard dead-letter replay: ${stillFailing} event(s) still not ingested after a replay attempt`,
        { examined: results.length, replayed, still_failing: stillFailing },
      );
    }
  } catch (err: any) {
    Logger.warn(`Dashboard dead-letter replay pass failed: ${err.message}`);
  }
}

const dashboardReplayTimer = setInterval(() => {
  void replayDashboardDeadLetters();
}, DASHBOARD_REPLAY_INTERVAL_MS);
dashboardReplayTimer.unref?.();

// One pass shortly after boot, so events that failed while the instance was
// down are recovered without waiting a full interval.
setTimeout(() => void replayDashboardDeadLetters(), 10_000).unref?.();

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
// Render and AWS send SIGTERM before killing the process.
// We close the HTTP server, drain inflight requests, then release the DB pool.
function shutdown(signal: string): void {
  Logger.info(`Received ${signal} — starting graceful shutdown`);
  clearInterval(workerTimer);
  clearInterval(heartbeatTimer);
  clearInterval(registryRetryTimer);
  clearInterval(dashboardReplayTimer);
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
