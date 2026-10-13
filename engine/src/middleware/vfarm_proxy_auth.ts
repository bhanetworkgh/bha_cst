/**
 * Authentication gate for the public vFarm proxy routes
 * (/api/devices, /api/dashboard, /api/farms, /api/tokens and their /api/v1
 * aliases).
 *
 * These routes used to run with no authentication at all, which turned CST into
 * an unauthenticated privileged proxy in front of vFarm:
 *
 *   - GET  /api/devices   fabricated an `owner` speaker with `permissions: ['*']`
 *                         and EVERY discovered farm id, then read devices using
 *                         CST's own X-Farm-Key.
 *   - GET  /api/dashboard  served cross-farm summary data through CST's admin JWT.
 *   - GET  /api/farms      enumerated every farm CST's admin JWT could see.
 *   - POST /api/tokens     minted a farm key for an arbitrary farm_id using CST's
 *                         admin JWT and returned the raw key to the caller.
 *
 * This middleware replaces "no credentials" with one of exactly two explicit
 * grants:
 *
 *   1. `admin_session` — the caller holds a valid CST admin session token
 *      (`x-admin-token`). CST's own vFarm credentials may then be used, because
 *      the caller *is* an authenticated CST administrator acting on their own
 *      behalf. This is the same authority the Admin Panel's `/api/v1/admin/*`
 *      routes already have.
 *
 *   2. `caller_jwt` — the caller supplied their own vFarm JWT
 *      (`Authorization: Bearer ...`). Only that JWT may be used. CST's admin
 *      credentials, admin JWT and farm key are never substituted for it, and an
 *      expired/invalid caller JWT is refused rather than silently re-authenticated
 *      with CST's credentials.
 *
 * Anything else is refused. There is no test bypass here on purpose: this gate
 * is what the regression tests assert, so a NODE_ENV-based skip would make them
 * vacuous.
 */
import { Request, Response, NextFunction } from 'express';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';

export type VfarmProxyAuthMode = 'admin_session' | 'caller_jwt';

export interface VfarmProxyAuthContext {
  mode: VfarmProxyAuthMode;
  /** Present only in `caller_jwt` mode. Never a CST-owned credential. */
  jwt?: string;
  /** Email of the CST admin, for audit attribution. */
  adminEmail?: string;
}

declare global {
  namespace Express {
    interface Request {
      vfarmAuth?: VfarmProxyAuthContext;
    }
  }
}

/** In-memory mirror of the admin-session store used when no DB pool exists. */
const memSessions = new Map<string, { email: string; expiresAt: Date }>();

/**
 * Validate a CST admin session token against the DB (or the in-memory mirror
 * used when DbClient has no pool). Mirrors `requireAdminAuth` semantics without
 * its NODE_ENV=test bypass.
 */
async function resolveAdminSession(token: string): Promise<string | null> {
  const pool = DbClient.getPool();
  if (pool) {
    const result = await pool.query(
      `SELECT s.email FROM admin_sessions s
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token],
    );
    return result.rows.length > 0 ? result.rows[0].email : null;
  }
  const session = memSessions.get(token);
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    memSessions.delete(token);
    return null;
  }
  return session.email;
}

/**
 * Register a session in the in-memory mirror. Only used by the regression tests
 * (production sessions live in `admin_sessions`, written by
 * `POST /api/v1/auth/login`).
 */
export function __registerInMemoryAdminSession(
  token: string,
  email: string,
  expiresAt: Date,
): void {
  memSessions.set(token, { email, expiresAt });
}

function readBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (match) {
    const raw = match[1].trim();
    return raw.length > 0 ? raw : null;
  }
  // Bare-token form is accepted only when it is not the literal "Bearer"
  // prefix itself, which would otherwise be treated as a valid credential.
  if (trimmed.toLowerCase() === 'bearer') return null;
  return trimmed;
}

function auditRefused(req: Request, reason: string, actor: string): void {
  Logger.audit({
    timestamp: new Date().toISOString(),
    tenant_id: null,
    actor,
    role: 'none',
    entry_point: 'api',
    tool_or_route: req.originalUrl || req.path,
    outcome: 'refused',
    reason,
  });
}

/**
 * Gate for routes that are served with CST's own vFarm credentials
 * (farm-key / admin-JWT scoped reads). A caller JWT is NOT accepted here: the
 * upstream device/health reads authenticate with X-Farm-Key, so honouring a
 * caller JWT would silently mean acting with CST's key while implying the
 * caller's own authority. Refusing is the fail-closed choice.
 */
export async function requireVfarmAdminSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionToken = (req.header('x-admin-token') || '').trim();
  if (sessionToken) {
    let email: string | null = null;
    try {
      email = await resolveAdminSession(sessionToken);
    } catch (err: any) {
      Logger.error(`vFarm proxy auth: admin session lookup failed: ${err.message}`);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
      return;
    }
    if (email) {
      req.vfarmAuth = { mode: 'admin_session', adminEmail: email };
      next();
      return;
    }
    auditRefused(req, 'Expired or invalid CST admin session', 'anonymous');
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'CST admin session expired or invalid. Please log in again.' });
    return;
  }

  if (readBearer(req)) {
    auditRefused(
      req,
      'vFarm JWT supplied to a farm-key scoped route; CST credentials not substituted (fail closed)',
      'bearer',
    );
    res.status(403).json({
      error: 'FORBIDDEN',
      message:
        'This endpoint is served with CST vFarm farm credentials and requires a CST admin session. ' +
        'Use the Admin Panel, or call /api/farms and /api/tokens with your own vFarm JWT.',
    });
    return;
  }

  auditRefused(req, 'Unauthenticated vFarm proxy request (no CST admin session, no vFarm JWT)', 'anonymous');
  res.status(401).json({
    error: 'UNAUTHORIZED',
    message: 'Authentication required: CST admin session (x-admin-token) or vFarm JWT (Authorization: Bearer).',
  });
}

/**
 * Gate for routes that CAN be served with the caller's own vFarm JWT
 * (farm discovery and farm-key issuance — both are JWT-authenticated upstream).
 *
 * A CST admin session is also accepted, in which case `jwt` is left undefined so
 * the route resolves CST's own admin credential exactly as `/api/v1/admin/*`
 * does. When a caller JWT is present it is passed through verbatim and is never
 * replaced by a CST credential.
 */
export async function requireVfarmAdminSessionOrJwt(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const bearer = readBearer(req);
  const sessionToken = (req.header('x-admin-token') || '').trim();

  if (!bearer && !sessionToken) {
    auditRefused(req, 'Unauthenticated vFarm proxy request (no CST admin session, no vFarm JWT)', 'anonymous');
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required: CST admin session (x-admin-token) or vFarm JWT (Authorization: Bearer).',
    });
    return;
  }

  // A caller-supplied JWT is sufficient on its own and is always the
  // least-privilege choice, so it wins outright — even alongside a session token
  // that may be stale. A bogus JWT gains nothing here: it is forwarded verbatim
  // and vFarm rejects it.
  if (bearer) {
    req.vfarmAuth = { mode: 'caller_jwt', jwt: bearer };
    next();
    return;
  }

  let email: string | null = null;
  try {
    email = await resolveAdminSession(sessionToken as string);
  } catch (err: any) {
    Logger.error(`vFarm proxy auth: admin session lookup failed: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    return;
  }

  if (!email) {
    auditRefused(req, 'Expired or invalid CST admin session', 'anonymous');
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'CST admin session expired or invalid. Please log in again.' });
    return;
  }

  req.vfarmAuth = { mode: 'admin_session', adminEmail: email };
  next();
}
