import { Router, Request, Response, NextFunction } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';
import { isTestRunner } from '../config/runtime.js';

export const authRouter = Router();

// ── Utility helpers ──────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('hex'); // 64-char hex token
}

const SESSION_TTL_HOURS = 8;

// ── In-memory session fallback (when DB pool is unavailable) ─────────────────
const memSessions = new Map<string, { email: string; expiresAt: Date }>();

// ── POST /api/v1/auth/login ──────────────────────────────────────────────────
authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Email and password required' });
      return;
    }

    const hash = sha256(password);
    const pool = DbClient.getPool();

    let adminEmail: string | null = null;
    let adminName = 'Admin';

    if (pool) {
      // DB-backed authentication
      const result = await pool.query(
        `SELECT id, email, name, is_active FROM admin_users
         WHERE email = $1 AND password_hash = $2`,
        [email.toLowerCase().trim(), hash]
      );

      if (result.rows.length === 0) {
        Logger.warn(`Admin login failed for ${email} (invalid credentials)`);
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid email or password' });
        return;
      }

      const user = result.rows[0];
      if (!user.is_active) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Account is disabled' });
        return;
      }

      adminEmail = user.email;
      adminName = user.name;

      // Persist session token in DB
      const token = generateToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO admin_sessions (token, admin_id, email, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [token, user.id, adminEmail, expiresAt.toISOString()]
      );

      // Update last login timestamp
      await pool.query(
        `UPDATE admin_users SET last_login = NOW() WHERE id = $1`,
        [user.id]
      );

      Logger.info(`Admin login: ${adminEmail} authenticated successfully`);
      res.status(200).json({
        status: 'ok',
        token,
        email: adminEmail,
        name: adminName,
        expires_at: expiresAt.toISOString(),
      });
    } else {
      // In-memory fallback (no DB): credentials from env vars only.
      // NEVER hardcode credentials here — set CST_ADMIN_EMAIL / CST_ADMIN_PASSWORD_HASH in .env.
      const validEmail = process.env.CST_ADMIN_EMAIL;
      const validHash = process.env.CST_ADMIN_PASSWORD_HASH;
      if (!validEmail || !validHash) {
        Logger.warn('Admin login failed — CST_ADMIN_EMAIL / CST_ADMIN_PASSWORD_HASH not set (in-memory mode)');
        res.status(503).json({ error: 'CONFIG_MISSING', message: 'Set CST_ADMIN_EMAIL and CST_ADMIN_PASSWORD_HASH in .env for in-memory admin auth.' });
        return;
      }
      if (email.toLowerCase().trim() !== validEmail.toLowerCase().trim() || hash !== validHash) {
        Logger.warn(`Admin login failed for ${email} (in-memory mode)`);
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid email or password' });
        return;
      }
      adminEmail = validEmail;
      adminName = process.env.CST_ADMIN_NAME || 'CST Super Admin';
      const token = generateToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
      memSessions.set(token, { email: adminEmail, expiresAt });
      Logger.info(`Admin login (in-memory): ${adminEmail} authenticated successfully`);
      res.status(200).json({
        status: 'ok',
        token,
        email: adminEmail,
        name: adminName,
        expires_at: expiresAt.toISOString(),
      });
    }
  } catch (err: any) {
    Logger.error(`Admin login error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── POST /api/v1/auth/logout ─────────────────────────────────────────────────
authRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    const token = req.headers['x-admin-token'] as string || req.body?.token;
    if (!token) {
      res.status(200).json({ status: 'ok' });
      return;
    }

    const pool = DbClient.getPool();
    if (pool) {
      await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    } else {
      memSessions.delete(token);
    }

    res.status(200).json({ status: 'logged_out' });
  } catch (err: any) {
    Logger.error(`Admin logout error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── GET /api/v1/auth/me — verify token & return user info ───────────────────
authRouter.get('/me', async (req: Request, res: Response) => {
  try {
    const token = req.headers['x-admin-token'] as string;
    if (!token) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'No session token provided' });
      return;
    }

    const pool = DbClient.getPool();
    if (pool) {
      const result = await pool.query(
        `SELECT s.token, s.email, s.expires_at, u.name, u.role
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.admin_id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (result.rows.length === 0) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Session expired or invalid' });
        return;
      }
      const row = result.rows[0];
      res.status(200).json({ status: 'ok', email: row.email, name: row.name, role: row.role });
    } else {
      const session = memSessions.get(token);
      if (!session || session.expiresAt < new Date()) {
        memSessions.delete(token);
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Session expired or invalid' });
        return;
      }
      res.status(200).json({ status: 'ok', email: session.email, name: process.env.CST_ADMIN_NAME || 'CST Super Admin', role: 'superadmin' });
    }
  } catch (err: any) {
    Logger.error(`Admin me error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── Admin Auth Middleware — protect /api/v1/admin/* routes ───────────────────
export async function requireAdminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Skip auth when running inside a test runner. This used to key off
  // `NODE_ENV === 'test'`, which is an env var: sourcing the repo's `.env` (it
  // sets NODE_ENV=development) silently disabled the bypass and broke the admin
  // suites, while a production process could in principle arm it. The vitest
  // signal cannot be set by accident in a deployed environment.
  if (isTestRunner()) {
    return next();
  }

  const token = req.headers['x-admin-token'] as string;
  if (!token) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin authentication required. Please log in at /admin.' });
    return;
  }

  try {
    const pool = DbClient.getPool();
    if (pool) {
      const result = await pool.query(
        `SELECT s.email FROM admin_sessions s
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (result.rows.length === 0) {
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Session expired. Please log in again.' });
        return;
      }
      next();
    } else {
      const session = memSessions.get(token);
      if (!session || session.expiresAt < new Date()) {
        memSessions.delete(token);
        res.status(401).json({ error: 'UNAUTHORIZED', message: 'Session expired. Please log in again.' });
        return;
      }
      next();
    }
  } catch (err: any) {
    Logger.error(`Auth middleware error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
}
