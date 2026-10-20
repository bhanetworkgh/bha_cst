/**
 * Authentication gate for the programmatic voice API.
 *
 *   POST /api/v1/voice/turn
 *   POST /api/v1/voice/synthesize
 *   POST /api/v1/voice/status
 *
 * These routes are mounted on the public service with no middleware of their own
 * (`engine/src/app.ts`: `app.use(voiceInterfaceRouter)`), unlike the Twilio
 * inbound routes, which carry `verifyTwilioSignature`. That made them callable
 * by anyone who could reach the host.
 *
 * The exposure was not theoretical:
 *
 *   - `/api/v1/voice/turn` accepts a client-asserted `from_e164`. The speaker's
 *     identity — role, permissions and farm_ids — is resolved from that number
 *     by the tenant adapter, and the engine then answers with that speaker's
 *     farm scope. A caller could therefore assert any known vFarm member's
 *     number and receive that member's farm-scoped answer, unauthenticated.
 *   - `/api/v1/voice/synthesize` accepted arbitrary `text` and synthesized it
 *     with the project's ElevenLabs voice clone: unpaid quota consumption and
 *     misuse of the clone.
 *   - `/api/v1/voice/status` accepted call-status events for any call SID.
 *
 * The Twilio webhooks are the intended public entry point, and they are signed.
 * These three are the intended *programmatic* entry point, and they now need the
 * shared secret that authenticates a service-to-service caller.
 *
 * Design notes:
 *
 *   - **Fail closed.** If `CST_API_KEY` is not configured the routes are
 *     refused with 503. A deployment that forgets the secret must not silently
 *     re-open the hole. This mirrors the admin in-memory auth path, which
 *     returns 503 `CONFIG_MISSING` when `CST_ADMIN_EMAIL` /
 *     `CST_ADMIN_PASSWORD_HASH` are absent.
 *   - **No test bypass.** The secret is required unconditionally, exactly like
 *     the vFarm proxy gate, so the regression suite cannot go vacuous. Tests
 *     supply the secret the same way any other caller would.
 *   - **Constant-time comparison** so the secret cannot be recovered by timing.
 *   - The secret is read from `process.env` on every request rather than from
 *     the cached `Env` object, so a secret change does not require a restart
 *     and tests can set it without resetting the env cache.
 */
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Logger } from '../config/logger.js';

export const PROGRAMMATIC_API_KEY_HEADER = 'x-cst-api-key';
export const PROGRAMMATIC_API_KEY_ENV = 'CST_API_KEY';

/** Read the configured secret, treating an empty/whitespace value as unset. */
function configuredSecret(): string | null {
  const raw = process.env[PROGRAMMATIC_API_KEY_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Length-safe, constant-time string comparison. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so the fast path does not leak length by timing.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

let hasLoggedMissingConfig = false;

/**
 * Boot-time configuration check.
 *
 * The service is NOT aborted when `CST_API_KEY` is missing, and that is
 * deliberate:
 *
 *   - The three programmatic voice routes fail closed at request time with
 *     503 CONFIG_MISSING. That is the security boundary — the vulnerable
 *     surface is closed, not merely flagged.
 *   - Aborting the process would take the *whole* engine down with it: the
 *     Twilio-signed voice and SMS webhooks, the delivery-status callback, the
 *     health endpoints and the outbound worker would all stop. A misconfigured
 *     secret would then become a total outage instead of a closed door on five
 *     routes. Failing closed on the affected routes is strictly safer than
 *     failing the service.
 *
 * The configuration gap is therefore reported loudly, once, at boot, so it
 * cannot go unnoticed — and the operator checklist requires `CST_API_KEY` to
 * be set *before* the build containing this guard is deployed.
 *
 * @returns true when the programmatic API is usable.
 */
export function checkProgrammaticApiKeyBootConfig(): boolean {
  if (configuredSecret()) {
    return true;
  }
  if (!hasLoggedMissingConfig) {
    hasLoggedMissingConfig = true;
    Logger.warn(
      `[programmatic_api] Missing configuration: ${PROGRAMMATIC_API_KEY_ENV}. ` +
        'The programmatic voice API (POST /api/v1/voice/turn, POST /api/v1/voice/synthesize, ' +
        'POST /api/v1/voice/status, POST /voice/turn, POST /audio/speak) is CLOSED and will ' +
        'refuse every request with 503 CONFIG_MISSING. The rest of the engine is unaffected. ' +
        'Set this variable before deploying a build that contains this guard.'
    );
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'programmatic_api',
      role: 'system',
      entry_point: 'api',
      tool_or_route: 'programmatic_api_key',
      outcome: 'refused',
      reason: `${PROGRAMMATIC_API_KEY_ENV} is not configured — programmatic voice API is closed (fail closed)`,
    });
  }
  return false;
}

/** Reset the once-only config log (for tests). */
export function resetProgrammaticApiKeyConfigLogging(): void {
  hasLoggedMissingConfig = false;
}

export function requireProgrammaticApiKey(req: Request, res: Response, next: NextFunction): void {
  const route = req.originalUrl || req.path;

  const expected = configuredSecret();
  if (!expected) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'programmatic_api',
      role: 'unauthenticated',
      entry_point: 'api',
      tool_or_route: route,
      outcome: 'refused',
      reason: `Programmatic API refused: ${PROGRAMMATIC_API_KEY_ENV} is not configured (fail closed)`,
    });
    res.status(503).json({
      error: 'CONFIG_MISSING',
      message: `Programmatic API is not configured. Set ${PROGRAMMATIC_API_KEY_ENV} before enabling this route.`,
    });
    return;
  }

  const provided = req.headers[PROGRAMMATIC_API_KEY_HEADER] as string | undefined;
  if (!provided || provided.trim().length === 0) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'programmatic_api',
      role: 'unauthenticated',
      entry_point: 'api',
      tool_or_route: route,
      outcome: 'refused',
      reason: `Missing ${PROGRAMMATIC_API_KEY_HEADER} header (rejected before DB access)`,
    });
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: `Programmatic API authentication required. Send the ${PROGRAMMATIC_API_KEY_HEADER} header.`,
    });
    return;
  }

  if (!secretsMatch(provided.trim(), expected)) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'programmatic_api',
      role: 'unauthenticated',
      entry_point: 'api',
      tool_or_route: route,
      outcome: 'refused',
      reason: `Invalid ${PROGRAMMATIC_API_KEY_HEADER} (rejected before DB access)`,
    });
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Invalid programmatic API credential',
    });
    return;
  }

  next();
}
