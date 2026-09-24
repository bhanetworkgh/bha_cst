import express, { Express, Request, Response, NextFunction } from 'express';
import { inboundRouter } from './transport/twilio/inbound.js';
import { smsInterfaceRouter } from './interfaces/sms/index.js';
import { outboundRouter } from './transport/twilio/outbound.js';
import { voiceRouter } from './transport/voice/voice_router.js';
import { voiceInterfaceRouter } from './interfaces/voice/index.js';
import { webInterfaceRouter } from './interfaces/web/index.js';
import { adminRouter } from './admin/routes.js';
import { authRouter, requireAdminAuth } from './admin/auth.js';
import { DbClient } from './db/client.js';
import { Logger } from './config/logger.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './docs/swagger.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CoreRegistry } from './core/registry.js';

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
    // Bypass rate limiting in test environment
    if (process.env.NODE_ENV === 'test') {
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

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.use('/webhooks', smsInterfaceRouter);
  app.use('/webhooks', outboundRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/admin', requireAdminAuth, adminRouter);
  app.use(voiceRouter);
  app.use(voiceInterfaceRouter);
  app.use(webInterfaceRouter);
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

  // ── vFarm Public & Dashboard Endpoints ─────────────────────────────────────
  app.get(['/api/v1/dashboard', '/api/dashboard'], async (req: Request, res: Response) => {
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
  });

  app.get(['/api/devices', '/api/v1/devices'], async (req: Request, res: Response) => {
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
      const speaker = {
        person_id: 'api_caller',
        customer_ref: 'api_caller',
        tenant_id: process.env.VFARM_TENANT_ID || 'tenant-vfarm-01',
        project_id: process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main',
        phone_e164: process.env.VFARM_ADMIN_PHONE || '+15551234567',
        is_known: true,
        role: 'owner' as const,
        permissions: ['*'],
        farm_ids: [farmId, ...adapter.getDiscoveredFarmIds()],
      };
      const result = await adapter.listFarmDevices({ farmId, speaker });
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
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    const adapter = CoreRegistry.getVfarmAdapter();
    const vfarmHealth = adapter ? await adapter.getHealth(process.env.VFARM_TENANT_ID || 'tenant-vfarm-01') : null;
    res.status(200).json({
      status: 'ok',
      service: process.env.SERVICE_NAME || 'bha-cst-engine',
      timestamp: new Date().toISOString(),
      vfarm: vfarmHealth,
    });
  });

  app.get(['/api/v1/farms', '/api/farms'], async (req: Request, res: Response) => {
    try {
      const adapter = CoreRegistry.getVfarmAdapter();
      if (!adapter) {
        res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
        return;
      }
      const jwt = req.header('authorization')?.replace(/^Bearer\s+/i, '') || (req.query.token as string);
      const farms = await adapter.discoverFarms(jwt);
      res.status(200).json({
        farms,
        total: farms.length,
        active_farm_id: adapter.getActiveFarmId(),
      });
    } catch (err: any) {
      Logger.error(`Farms API error: ${err.message}`);
      res.status(err.status || 500).json({ error: 'DISCOVERY_ERROR', message: err.message });
    }
  });

  app.post(['/api/v1/tokens', '/api/tokens'], async (req: Request, res: Response) => {
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
      const jwt = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.body?.token;
      const rawKey = await adapter.issueFarmToken(farm_id, jwt, name);
      res.status(201).json({ status: 'issued', farm_id, raw_key: rawKey });
    } catch (err: any) {
      Logger.error(`Token issuance API error: ${err.message}`);
      res.status(err.status || 500).json({ error: 'TOKEN_ERROR', message: err.message });
    }
  });

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
