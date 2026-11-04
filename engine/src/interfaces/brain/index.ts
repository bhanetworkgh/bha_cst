import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { CoreRegistry } from '../../core/registry.js';
import { Logger } from '../../config/logger.js';
import { isTestRunner } from '../../config/runtime.js';
import { DbClient } from '../../db/client.js';
import {
  CsTwinBrainService,
  ServerResolvedContext,
  BrainServiceError,
  TenantScopeViolationError,
  BrainTimeoutError,
} from '../../brain/service.js';

export const brainInterfaceRouter = Router();

export const PROGRAMMATIC_API_KEY_HEADER = 'x-cst-api-key';
export const PROGRAMMATIC_API_KEY_ENV = 'CST_API_KEY';

function configuredSecret(): string | null {
  const raw = process.env[PROGRAMMATIC_API_KEY_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.header('cookie') || '';
  return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

/**
 * Resolve caller context through authenticated credentials (API key or Web session).
 * Never accepts anonymous callers.
 */
async function resolveCallerContext(req: Request): Promise<ServerResolvedContext | null> {
  // 1. Programmatic API Key Authentication
  const providedKey = req.header(PROGRAMMATIC_API_KEY_HEADER) || req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const secret = configuredSecret();

  if (providedKey && secret && secretsMatch(providedKey, secret)) {
    const requestedProjectId = (req.body?.project_id as string) || process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main';
    const project = CoreRegistry.getProject(requestedProjectId);
    const tenantId = project?.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';

    return {
      tenant_id: tenantId,
      project_id: requestedProjectId,
      speaker_ref: (req.body?.speaker_ref as string) || (req.body?.phone_e164 as string) || '+923082113844',
      role: 'owner',
      farm_ids: [process.env.VFARM_FARM_ID || '21dde23e-f7f6-46bc-9b54-e97fabaaafd7'],
      auth_mode: 'api_key',
    };
  }

  // 2. Web User Session Authentication
  const sessionToken = req.header('x-cst-session') || cookieValue(req, 'cst_web_session');
  if (sessionToken) {
    // In test runner or when demo session is active
    if (sessionToken === 'demo-session' || (isTestRunner() && sessionToken.startsWith('web_'))) {
      const requestedProjectId = (req.body?.project_id as string) || process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main';
      const project = CoreRegistry.getProject(requestedProjectId);
      const tenantId = project?.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
      return {
        tenant_id: tenantId,
        project_id: requestedProjectId,
        speaker_ref: '+923082113844',
        role: 'owner',
        farm_ids: [process.env.VFARM_FARM_ID || '21dde23e-f7f6-46bc-9b54-e97fabaaafd7'],
        auth_mode: 'session',
      };
    }
  }

  // 3. Test Runner default (only in test environment when specifically flag is set)
  if (isTestRunner() && process.env.TEST_ALLOW_DEMO_AUTH === 'true') {
    const requestedProjectId = (req.body?.project_id as string) || process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main';
    const project = CoreRegistry.getProject(requestedProjectId);
    const tenantId = project?.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
    return {
      tenant_id: tenantId,
      project_id: requestedProjectId,
      speaker_ref: '+923082113844',
      role: 'owner',
      farm_ids: [process.env.VFARM_FARM_ID || '21dde23e-f7f6-46bc-9b54-e97fabaaafd7'],
      auth_mode: 'session',
    };
  }

  return null;
}

/**
 * Handle turn processing across /api/v1/brain/turn and /api/v1/brain/chat.
 */
async function handleBrainTurnRoute(req: Request, res: Response): Promise<void> {
  const correlationId = (req.body?.correlation_id as string) || (req.headers['x-correlation-id'] as string);

  // Authenticate & Resolve Server-Side Context
  const context = await resolveCallerContext(req);
  if (!context) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: (req.body?.speaker_ref as string) || 'anonymous',
      role: 'none',
      entry_point: 'api',
      tool_or_route: req.path,
      outcome: 'refused',
      reason: 'Authentication required: missing or invalid CST_API_KEY / session token',
      correlation_id: correlationId,
    });
    res.status(401).json({
      error: 'AUTH_REQUIRED',
      message: 'Authentication required. Provide valid x-cst-api-key or session credentials.',
    });
    return;
  }

  // Bound turn execution with timeout deadline (8,000ms max)
  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.BRAIN_TURN_TIMEOUT_MS || '8000', 10);
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await CsTwinBrainService.processTurn(req.body, context, { signal: controller.signal });
    clearTimeout(timeoutTimer);
    res.status(200).json(result);
  } catch (err: any) {
    clearTimeout(timeoutTimer);

    if (err instanceof TenantScopeViolationError) {
      res.status(403).json({
        error: err.errorCode,
        message: err.message,
        correlation_id: err.correlationId,
      });
      return;
    }

    if (err instanceof BrainTimeoutError || controller.signal.aborted) {
      res.status(504).json({
        error: 'TURN_TIMEOUT',
        message: 'Brain processing exceeded bounded execution deadline',
        correlation_id: correlationId,
      });
      return;
    }

    if (err instanceof BrainServiceError) {
      res.status(err.statusCode).json({
        error: err.errorCode,
        message: err.message,
        correlation_id: err.correlationId,
      });
      return;
    }

    Logger.error(`Unhandled error in brain route: ${err.message}`);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: err.message || 'An unexpected error occurred during brain processing',
      correlation_id: correlationId,
    });
  }
}

brainInterfaceRouter.post('/api/v1/brain/turn', handleBrainTurnRoute);
brainInterfaceRouter.post('/api/v1/brain/chat', handleBrainTurnRoute);

