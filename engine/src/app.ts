import express, { Express, Request, Response, NextFunction } from 'express';
import { smsInterfaceRouter } from './interfaces/sms/index.js';
import { outboundRouter } from './transport/twilio/outbound.js';
import { voiceRouter } from './transport/voice/voice_router.js';
import { voiceInterfaceRouter } from './interfaces/voice/index.js';
import { webInterfaceRouter } from './interfaces/web/index.js';
import { brainInterfaceRouter } from './interfaces/brain/index.js';
import { adminRouter } from './admin/routes.js';
import { authRouter, requireAdminAuth } from './admin/auth.js';
import {
  requireVfarmAdminSession,
  requireVfarmAdminSessionOrJwt,
} from './middleware/vfarm_proxy_auth.js';
import { DbClient } from './db/client.js';
import { Logger } from './config/logger.js';
import { isTestRunner } from './config/runtime.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './docs/swagger.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CoreRegistry } from './core/registry.js';
import { getResearchTwinConfigStatus } from './research_twin/config.js';
import { researchTwinWebhookRouter } from './research_twin/webhook.js';
import { elevenlabsWebhookRouter } from './interfaces/elevenlabs/index.js';
import { voiceObservabilityRouter } from './interfaces/voice/observability_router.js';
import { FailureDetector } from './observability/failure_detector.js';
import {
  normalizeFarmHealth,
  type NormalizedFarmHealth,
} from './adapters/vfarm/health.js';

export { mapFarmHealthStatus } from './adapters/vfarm/health.js';

export function createApp(): Express {
  const app = express();

  // Enable trust proxy for reverse proxies / AWS ALBs / Render SSL termination
  app.set('trust proxy', true);

  // ── Body Parsing ────────────────────────────────────────────────────────────
  // Twilio sends application/x-www-form-urlencoded webhooks.
  // Limit body size to 100kb to prevent payload floods.
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));

  // ── Security Headers ────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.removeHeader('X-Powered-By');
    next();
  });

  // ── Rate Limiter Middleware for Webhook Endpoints ─────────────────────────
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
  const MAX_REQUESTS_PER_WINDOW = 120; // 120 reqs/min per IP

  app.use('/webhooks', (req: Request, res: Response, next: NextFunction) => {
    // Bypass rate limiting inside a test runner. Keyed off the vitest signal
    // rather than NODE_ENV, which the repo's own .env overwrites with
    // 'development' — see engine/src/config/runtime.ts.
    if (isTestRunner()) {
      return next();
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const clientRecord = requestCounts.get(ip);

    if (!clientRecord || now > clientRecord.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return next();
    }

    clientRecord.count++;
    if (clientRecord.count > MAX_REQUESTS_PER_WINDOW) {
      Logger.warn(`Rate limit exceeded for IP ${ip} on ${req.path}`);
      Logger.infra({
        message: `Rate limit exceeded: ${ip} exceeded ${MAX_REQUESTS_PER_WINDOW} requests/min on ${req.path}`,
        commercial_impact: 'Webhook endpoint throttled for this IP. Legitimate Twilio deliveries may be delayed or dropped if Twilio is retrying from the same IP range. Monitor for false positives.',
        meta: { ip, path: req.path, limit: MAX_REQUESTS_PER_WINDOW },
      });
      res.status(429).json({ error: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded. Try again later.' });
      return;
    }

    next();
  });

  // ── Static/Utility ─────────────────────────────────────────────────────────
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/webhooks', smsInterfaceRouter);
  app.use('/webhooks', outboundRouter);
  app.use('/webhooks/research-twin', researchTwinWebhookRouter);
  app.use('/webhooks/elevenlabs', elevenlabsWebhookRouter);
  app.use('/webhooks/voice', voiceObservabilityRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/admin', requireAdminAuth, adminRouter);
  app.use(voiceRouter);
  app.use(voiceInterfaceRouter);
  app.use(webInterfaceRouter);
  app.use(brainInterfaceRouter);
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

  // ── vFarm Public & Dashboard Endpoints ─────────────────────────────────────
  // These routes proxy vFarm using CST's own farm key / admin JWT, so they are
  // authenticated. See middleware/vfarm_proxy_auth.ts for the exact grant model:
  // a CST admin session (the same authority /api/v1/admin/* already has), or a
  // fail-closed refusal. There is deliberately no anonymous path.
  app.get(
    ['/api/v1/dashboard', '/api/dashboard'],
    requireVfarmAdminSession,
    async (req: Request, res: Response) => {
      try {
        const adapter = CoreRegistry.getVfarmAdapter();
        if (!adapter) {
          res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
          return;
        }
        const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId() || undefined;
        const data = await adapter.getDashboardData(farmId);
        res.status(200).json(data);
      } catch (err: any) {
        Logger.error(`Dashboard API error: ${err.message}`);
        res.status(err.status || 500).json({ error: 'DASHBOARD_ERROR', message: err.message });
      }
    },
  );

  app.get(
    ['/api/devices', '/api/v1/devices'],
    requireVfarmAdminSession,
    async (req: Request, res: Response) => {
      try {
        const adapter = CoreRegistry.getVfarmAdapter();
        if (!adapter) {
          res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
          return;
        }
        let farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
        if (!farmId) {
          await adapter.discoverFarms();
          farmId = adapter.getActiveFarmId();
        }
        if (!farmId) {
          res.status(503).json({ error: 'NO_FARM_AVAILABLE', message: 'No farms discovered. Check vFarm credentials.' });
          return;
        }
        // No fabricated speaker. Authorization is the authenticated CST admin
        // session checked by requireVfarmAdminSession; this route previously
        // invented an `owner` identity with permissions ['*'] and every
        // discovered farm id, which made an anonymous caller look privileged to
        // the adapter's own farm-scope gate. Farm scope is whatever the
        // authenticated admin is entitled to, never a synthesized grant.
        const result = await adapter.listFarmDevices({ farmId });
        res.status(200).json({
          farm_id: farmId,
          total: result.total,
          count: result.devices.length,
          devices: result.devices,
        });
      } catch (err: any) {
        Logger.error(`Devices API error: ${err.message}`);
        res.status(err.status || 500).json({ error: 'DEVICES_ERROR', message: err.message });
      }
    },
  );

  app.get('/api/health', async (_req: Request, res: Response) => {
    const adapter = CoreRegistry.getVfarmAdapter();
    const tenantId = process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
    // ── Separate API reachability from authoritative farm health ──────────
    // 1. `api_reachability` → can CST reach the upstream at all? (probe)
    // 2. `farm_health`      → what does vFarm's authoritative farm health
    //    endpoint say? Only `healthy` from vFarm maps to CST `healthy`.
    //    `unhealthy` maps to `unhealthy`. Everything else is `degraded` or
    //    `unknown`. We NEVER derive health from health_score, relay state,
    //    device count or locally invented thresholds.
    //
    // The top-level `status` is derived from `farm_health` alone. API
    // reachability remains a separate diagnostic field and is NEVER used to
    // derive farm health, so a reachable API with unavailable farm health can
    // never report `healthy`.
    const apiReachability = adapter ? await adapter.getHealth(tenantId) : null;

    let farmHealth: NormalizedFarmHealth | null = null;

    if (adapter && adapter.hasLiveClient()) {
      // Resolve the farm ID from canonical configuration (VFARM_FARM_ID) and
      // active farm discovery. Never invent a farm ID.
      const farmId = adapter.getActiveFarmId();
      if (farmId) {
        try {
          const upstream = await adapter.getFarmHealthDirect(farmId);
          // The checked-in vFarm farm-health contract identifies no
          // authoritative source timestamp. Freshness therefore remains
          // explicitly unavailable rather than being inferred locally.
          farmHealth = normalizeFarmHealth(upstream);
        } catch {
          farmHealth = normalizeFarmHealth(null, { upstreamError: true });
        }
      }
      // Missing farm ID → farmHealth stays null → top-level status unknown.
    }

    res.status(200).json({
      status: farmHealth?.status ?? 'unknown',
      service: process.env.SERVICE_NAME || 'bha-cst-engine',
      timestamp: new Date().toISOString(),
      api_reachability: apiReachability,
      farm_health: farmHealth,
      research_twin: getResearchTwinConfigStatus(),
    });
  });

  app.get(
    ['/api/v1/farms', '/api/farms'],
    requireVfarmAdminSessionOrJwt,
    async (req: Request, res: Response) => {
      try {
        const adapter = CoreRegistry.getVfarmAdapter();
        if (!adapter) {
          res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
          return;
        }
        // Explicit credential only. In caller_jwt mode `jwt` is defined and is
        // forwarded verbatim, so discoverFarms() cannot substitute CST's own
        // admin JWT (see VfarmTenantAdapter.discoverFarms). In admin_session
        // mode it is undefined, which is the legitimate CST-admin path.
        const auth = req.vfarmAuth;
        const jwt = auth?.mode === 'caller_jwt' ? auth.jwt : undefined;
        const farms = await adapter.discoverFarms(jwt);
        res.status(200).json({
          farms,
          total: farms.length,
          active_farm_id: adapter.getActiveFarmId(),
        });
      } catch (err: any) {
        // An upstream 401/403 on a caller-supplied JWT must surface as 401, not
        // 500, and must never trigger a CST-credential retry.
        const status = err?.status ?? err?.statusCode;
        if (status === 401 || status === 403) {
          res.status(401).json({ error: 'UNAUTHORIZED', message: 'vFarm rejected the supplied credentials' });
          return;
        }
        Logger.error(`Farms API error: ${err.message}`);
        res.status(err.status || 500).json({ error: 'DISCOVERY_ERROR', message: err.message });
      }
    },
  );

  app.post(
    ['/api/v1/tokens', '/api/tokens'],
    requireVfarmAdminSessionOrJwt,
    async (req: Request, res: Response) => {
      try {
        const { farm_id, name } = req.body || {};
        if (!farm_id) {
          res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
          return;
        }
        const adapter = CoreRegistry.getVfarmAdapter();
        if (!adapter) {
          res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
          return;
        }
        // Same explicit-credential rule as /api/farms. A `token` field in the
        // body is no longer honoured as a credential: it was an unauthenticated
        // way to influence which identity CST used.
        const auth = req.vfarmAuth;
        const callerJwt = auth?.mode === 'caller_jwt';
        const jwt = callerJwt ? auth.jwt : undefined;

        // A CALLER JWT must not re-point the process-wide farm key: that
        // would change the key every other tenant's identity resolution uses.
        // An operator (CST admin session) re-pointing CST at a different farm
        // keeps that behaviour, which is what the endpoint is for.
        const rawKey = await adapter.issueFarmToken(farm_id, jwt, name, {
          switchActiveKey: !callerJwt,
        });

        // Token issuance is a credential-minting event: it is audited, with the
        // authentication mode and the farm, and NEVER the key material.
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: null,
          actor: callerJwt ? 'vfarm_caller_jwt' : 'cst_admin_session',
          role: 'service_account',
          entry_point: 'api',
          tool_or_route: 'POST /api/tokens',
          outcome: 'ok',
          reason: `Farm-scoped API key issued for farm ${farm_id} (auth mode: ${callerJwt ? 'caller_jwt' : 'cst_admin_session'}; active farm key ${callerJwt ? 'not switched' : 'switched'})`,
          correlation_id: (req.headers['x-correlation-id'] as string) || undefined,
        });

        res.status(201).json({ status: 'issued', farm_id, raw_key: rawKey });
      } catch (err: any) {
        const status = err?.status ?? err?.statusCode;
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: null,
          actor: 'unauthenticated_or_rejected',
          role: 'service_account',
          entry_point: 'api',
          tool_or_route: 'POST /api/tokens',
          outcome: 'refused',
          reason: `Farm-scoped API key issuance refused for farm ${(req.body || {}).farm_id || 'unknown'}: upstream status ${status ?? 'error'}`,
          correlation_id: (req.headers['x-correlation-id'] as string) || undefined,
        });
        if (status === 401 || status === 403) {
          res.status(401).json({ error: 'UNAUTHORIZED', message: 'vFarm rejected the supplied credentials' });
          return;
        }
        Logger.error(`Token issuance API error: ${err.message}`);
        res.status(err.status || 500).json({ error: 'TOKEN_ERROR', message: err.message });
      }
    },
  );

  // ── Swagger / OpenAPI Documentation ─────────────────────────────────────────
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/api-docs');
  });
  app.get('/web', (_req: Request, res: Response) => {
    res.sendFile(path.join(webRoot, 'index.html'));
  });
  app.get('/admin/login', (_req: Request, res: Response) => {
    res.sendFile(path.join(webRoot, 'login.html'));
  });
  app.get('/admin', (_req: Request, res: Response) => {
    res.sendFile(path.join(webRoot, 'admin.html'));
  });
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api-docs.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(swaggerSpec);
  });
  app.use(express.static(webRoot));

  // ── Health Check ────────────────────────────────────────────────────────────
  // Render / AWS ALB hit this endpoint to determine if the instance is live.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'bha-cst-engine' });
  });

  // ── Reliability & Failure Detection Health Check ────────────────────────────
  app.get('/health/reliability', (_req: Request, res: Response) => {
    const report = FailureDetector.getHealthReport();
    const status = report.readiness === 'unready' ? 503 : 200;
    res.status(status).json(report);
  });

  // ── Debug State ─────────────────────────────────────────────────────────────
  // In-memory state snapshot — NEVER exposed in production.
  app.get('/debug/state', (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.status(200).json({
      conversations:    DbClient.getAllConversations(),
      transcripts:      DbClient.getAllTranscripts(),
      messages_in:      DbClient.getAllMessagesIn(),
      messages_out:     DbClient.getAllMessagesOut(),
      voice_deliveries: DbClient.getAllVoiceDeliveries(),
    });
  });

  // ── 404 Catch-All ───────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });

  // ── Global Error Handler ────────────────────────────────────────────────────
  // Must have 4 parameters for Express to treat it as an error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    Logger.error(`Unhandled Express error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  });

  return app;
}
