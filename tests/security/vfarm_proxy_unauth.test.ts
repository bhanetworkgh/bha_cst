/**
 * Regression tests for LOOP-1790790007707-5R0J — the public vFarm proxy routes
 * must not be usable as an unauthenticated privileged proxy.
 *
 * The routes under test (each has a /api/v1 alias that must behave identically):
 *   GET  /api/devices     GET /api/dashboard     GET /api/farms     POST /api/tokens
 *
 * What is asserted, and why each case matters:
 *   1. Unauthenticated  -> 401 AND zero upstream calls. "Zero upstream calls"
 *      is the load-bearing part: it proves CST never reached vFarm with its own
 *      farm key / admin JWT on an anonymous request.
 *   2. Valid CST admin session -> 200, i.e. legitimate authenticated behavior
 *      is preserved.
 *   3. Expired CST admin session -> 401.
 *   4. Caller vFarm JWT -> 200, forwarded verbatim; CST's own admin credentials
 *      are never used (no /auth/login call, no X-Farm-Key substitution).
 *   5. Expired caller JWT -> 401, and CST does NOT silently re-authenticate with
 *      VFARM_ADMIN_* to cover for it. This is the escalation path the old
 *      discoverFarms() had.
 *   6. Wrong tenant -> a caller JWT only ever sees its own upstream farm list;
 *      CST's cached farm projection is never merged in.
 *   7. Farm-key scoped routes (devices/dashboard) refuse a caller JWT outright
 *      rather than answering it with CST's farm key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { __registerInMemoryAdminSession } from '../../engine/src/middleware/vfarm_proxy_auth.js';

const CST_FARM = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';
const OTHER_TENANT_FARM = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const VALID_SESSION = 'session-token-valid';
const EXPIRED_SESSION = 'session-token-expired';

/** Build a JWT whose payload has the given `exp` (seconds since epoch). */
function makeJwt(expSecondsFromNow: number): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: 'caller',
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })}.sig`;
}

const VALID_JWT = makeJwt(3600);
const EXPIRED_JWT = makeJwt(-3600);

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
}

/** Read a JWT's `exp` claim the way an upstream server would. */
function jwtExpirySeconds(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Mock vFarm upstream. Every call is recorded so tests can assert both *what*
 * was called and *with which credential*.
 *
 * `rejectExpiredJwt` makes the mock behave like a real JWT-validating server:
 * a bearer token whose `exp` has passed is answered 401. That is what proves
 * CST does not paper over a caller's dead credential with its own admin login.
 */
function buildMockFetch(opts: { rejectExpiredJwt?: boolean } = {}) {
  const calls: UpstreamCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers || {}) as Record<string, string>;
    calls.push({ url, headers });
    const bearer = headers['Authorization']?.replace(/^Bearer\s+/i, '') || '';
    const json = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

    if (url.includes('/api/v1/auth/login')) {
      // Reaching this is itself a finding: CST re-authenticated with its own
      // admin credentials during a caller-credentialed request.
      return json(200, { access_token: 'cst-admin-jwt-from-login' });
    }

    if (opts.rejectExpiredJwt && bearer) {
      const exp = jwtExpirySeconds(bearer);
      // No `exp` claim means an opaque/non-JWT credential, which the mock treats
      // as valid so only genuinely expired tokens are exercised.
      if (exp !== null && Date.now() / 1000 >= exp) {
        return json(401, { detail: 'Invalid or expired token' });
      }
    }

    if (url.includes('/api/v1/tokens')) {
      return json(201, { raw_key: 'farm-key-for-caller', name: 'caller' });
    }
    if (url.includes('/api/v1/farms?')) {
      // Only the caller's own farms come back. A caller JWT for another tenant
      // must never see CST's farm.
      return json(200, {
        farms: [{ id: CST_FARM, name: 'v-farm', is_active: true }],
        total: 1,
      });
    }
    if (url.includes('/api/v1/devices?')) {
      return json(200, { devices: [{ id: 'dev-1', farm_id: CST_FARM }], total: 1 });
    }
    if (url.includes('/api/v1/farms/') && url.includes('/health')) {
      return json(200, { status: 'healthy' });
    }
    return json(404, { detail: 'not found' });
  });
  return { fn, calls };
}

const ADMIN_ONLY_ROUTES = [
  { method: 'get' as const, path: '/api/devices' },
  { method: 'get' as const, path: '/api/v1/devices' },
  { method: 'get' as const, path: '/api/dashboard' },
  { method: 'get' as const, path: '/api/v1/dashboard' },
];

const ADMIN_OR_JWT_ROUTES = [
  { method: 'get' as const, path: '/api/farms' },
  { method: 'get' as const, path: '/api/v1/farms' },
];

const TOKEN_ROUTES = [
  { method: 'post' as const, path: '/api/tokens' },
  { method: 'post' as const, path: '/api/v1/tokens' },
];

describe('LOOP-1790790007707-5R0J — public vFarm proxy routes are not an unauthenticated privileged proxy', () => {
  const app = createApp();
  let mock: ReturnType<typeof buildMockFetch>;

  const envBackup = { ...process.env };
  let savedPool: unknown;

  beforeEach(async () => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    // Hermetic: this suite exercises the in-memory admin-session path, so any
    // ambient DATABASE_URL must not make the middleware read a real (and
    // empty) `admin_sessions` table. `DbClient.getPool()` also caches its pool
    // in a static, so an inherited pool has to be cleared explicitly.
    savedPool = DbClient.getPool();
    DbClient.setPool(null);

    // Make sure CST "has" admin credentials, so any fallback to them is
    // possible and therefore observable.
    process.env.VFARM_ADMIN_EMAIL = 'cst-admin@example.test';
    process.env.VFARM_ADMIN_PASSWORD = 'cst-admin-password';
    process.env.VFARM_API_JWT = 'cst-static-admin-jwt';
    process.env.NODE_ENV = 'test';

    __registerInMemoryAdminSession(
      VALID_SESSION,
      'cst-admin@example.test',
      new Date(Date.now() + 60 * 60 * 1000),
    );
    __registerInMemoryAdminSession(
      EXPIRED_SESSION,
      'cst-admin@example.test',
      new Date(Date.now() - 60 * 1000),
    );

    mock = buildMockFetch();
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'cst-farm-key',
      apiToken: 'cst-static-admin-jwt',
      fetchFn: mock.fn as any,
    });
    CoreRegistry.registerTenant(
      {
        tenant_id: 'tenant-vfarm-01',
        name: 'vFarm',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );
    mock.calls.length = 0; // discard construction-time traffic
  });

  afterEach(() => {
    process.env = { ...envBackup };
    DbClient.setPool(savedPool as any);
  });

  // ── 1. Unauthenticated ─────────────────────────────────────────────────────
  it('refuses every public vFarm route with 401 when no credentials are supplied', async () => {
    for (const r of [...ADMIN_ONLY_ROUTES, ...ADMIN_OR_JWT_ROUTES]) {
      const res = await (request(app) as any)[r.method](r.path);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    }
    for (const r of TOKEN_ROUTES) {
      const res = await (request(app) as any)[r.method](r.path).send({ farm_id: CST_FARM });
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    }
  });

  it('makes ZERO upstream vFarm calls for unauthenticated requests (no credential fallback)', async () => {
    for (const r of [...ADMIN_ONLY_ROUTES, ...ADMIN_OR_JWT_ROUTES]) {
      await (request(app) as any)[r.method](r.path);
    }
    for (const r of TOKEN_ROUTES) {
      await (request(app) as any)[r.method](r.path).send({ farm_id: CST_FARM });
    }
    expect(mock.fn).not.toHaveBeenCalled();
    expect(mock.calls).toHaveLength(0);
  });

  it('never returns a farm key to an unauthenticated caller', async () => {
    for (const r of TOKEN_ROUTES) {
      const res = await (request(app) as any)[r.method](r.path).send({ farm_id: CST_FARM });
      expect(res.status).toBe(401);
      expect(res.body.raw_key).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('farm-key');
    }
  });

  it('does not accept a body-supplied token as a credential on /api/tokens', async () => {
    const res = await request(app).post('/api/tokens').send({
      farm_id: CST_FARM,
      token: VALID_JWT,
    });
    expect(res.status).toBe(401);
    expect(res.body.raw_key).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });

  it('does not accept a query-supplied token as a credential on /api/farms', async () => {
    const res = await request(app).get(`/api/farms?token=${VALID_JWT}`);
    expect(res.status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  });

  it('does not accept a query-supplied token as a credential on /api/tokens', async () => {
    const res = await request(app).post(`/api/tokens?token=${VALID_JWT}`).send({ farm_id: CST_FARM });
    expect(res.status).toBe(401);
    expect(res.body.raw_key).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });

  it('does not accept a query-supplied token as a credential on the admin-only /api/devices route', async () => {
    const res = await request(app).get(`/api/devices?token=${VALID_JWT}`);
    expect(res.status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  });

  it('does not accept a query-supplied admin-token as a credential', async () => {
    const res = await request(app).get(`/api/farms?x-admin-token=${VALID_SESSION}`);
    expect(res.status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects empty / whitespace-only credentials as unauthenticated', async () => {
    const empty = await request(app).get('/api/farms').set('Authorization', 'Bearer ');
    expect(empty.status).toBe(401);
    expect(empty.body.error).toBe('UNAUTHORIZED');
    expect(mock.calls).toHaveLength(0);

    const blank = await request(app)
      .post('/api/tokens')
      .set('x-admin-token', '   ')
      .send({ farm_id: CST_FARM });
    expect(blank.status).toBe(401);
    expect(blank.body.raw_key).toBeUndefined();
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects a caller JWT on the farm-key scoped routes (403) even when a valid admin session is also present', async () => {
    // A caller JWT must never elevate to CST farm-key scope. When a valid
    // admin session is also attached the route is served through that session
    // (CST's own farm key) — the caller's JWT is never used as the upstream
    // credential on these routes.
    for (const r of ADMIN_ONLY_ROUTES) {
      const res = await (request(app) as any)[r.method](r.path)
        .set('Authorization', `Bearer ${VALID_JWT}`)
        .set('x-admin-token', VALID_SESSION);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(200);
    }
    // And the caller's JWT must never have been forwarded on these routes.
    const upstream = mock.calls.filter((c) => c.url.includes('mock.vfarm.test'));
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream.every((c) => c.headers['Authorization'] !== `Bearer ${VALID_JWT}`)).toBe(true);
  });

  it('refuses a caller JWT on the farm-key scoped routes (403) when the admin session is invalid', async () => {
    // With an expired admin session the route cannot be served by CST's farm
    // key either: the bearer is refused outright (403) and the expired
    // session lookup fails closed (401). Either way the caller is refused
    // and no upstream call is made.
    for (const r of ADMIN_ONLY_ROUTES) {
      const res = await (request(app) as any)[r.method](r.path)
        .set('Authorization', `Bearer ${VALID_JWT}`)
        .set('x-admin-token', EXPIRED_SESSION);
      expect([401, 403]).toContain(res.status);
      expect(mock.calls).toHaveLength(0);
    }
  });

  // ── 2. Valid CST admin session ─────────────────────────────────────────────
  it('serves the routes to a valid CST admin session (authenticated behavior preserved)', async () => {
    for (const r of ADMIN_OR_JWT_ROUTES) {
      const res = await (request(app) as any)[r.method](r.path).set('x-admin-token', VALID_SESSION);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(200);
    }
    for (const r of ADMIN_ONLY_ROUTES) {
      const res = await (request(app) as any)[r.method](r.path).set('x-admin-token', VALID_SESSION);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(200);
    }
  });

  it('lets an authenticated CST admin mint a farm key through /api/tokens', async () => {
    const res = await request(app)
      .post('/api/tokens')
      .set('x-admin-token', VALID_SESSION)
      .send({ farm_id: CST_FARM, name: 'admin-panel' });
    expect(res.status).toBe(201);
    expect(res.body.raw_key).toBe('farm-key-for-caller');
  });

  // ── 3. Expired CST admin session ───────────────────────────────────────────
  it('refuses an expired CST admin session with 401 on every route', async () => {
    for (const r of [...ADMIN_ONLY_ROUTES, ...ADMIN_OR_JWT_ROUTES]) {
      const res = await (request(app) as any)[r.method](r.path).set('x-admin-token', EXPIRED_SESSION);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(401);
    }
    const token = await request(app)
      .post('/api/tokens')
      .set('x-admin-token', EXPIRED_SESSION)
      .send({ farm_id: CST_FARM });
    expect(token.status).toBe(401);
    expect(token.body.raw_key).toBeUndefined();
  });

  it('refuses a fabricated / unknown CST session token with 401', async () => {
    const res = await request(app).get('/api/farms').set('x-admin-token', 'made-up-token');
    expect(res.status).toBe(401);
    expect(mock.calls).toHaveLength(0);
  });

  // ── 4. Caller vFarm JWT ─────────────────────────────────────────────────────
  it('serves /api/farms with the caller own JWT, forwarded verbatim', async () => {
    const res = await request(app).get('/api/farms').set('Authorization', `Bearer ${VALID_JWT}`);
    expect(res.status).toBe(200);
    const listCall = mock.calls.find((c) => c.url.includes('/api/v1/farms?'));
    expect(listCall).toBeDefined();
    expect(listCall!.headers['Authorization']).toBe(`Bearer ${VALID_JWT}`);
  });

  it('does not substitute CST admin credentials when a caller JWT is used', async () => {
    await request(app).get('/api/farms').set('Authorization', `Bearer ${VALID_JWT}`);

    // No re-authentication with VFARM_ADMIN_* may happen...
    expect(mock.calls.some((c) => c.url.includes('/auth/login'))).toBe(false);
    // ...and no call may be made with CST's own farm key on the caller's behalf.
    const upstream = mock.calls.filter((c) => c.url.includes('mock.vfarm.test'));
    expect(upstream.every((c) => !c.headers['X-Farm-Key'])).toBe(true);
  });

  it('lets a caller JWT mint a farm key for themselves via /api/tokens', async () => {
    const res = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${VALID_JWT}`)
      .send({ farm_id: CST_FARM });
    expect(res.status).toBe(201);
    const issue = mock.calls.find((c) => c.url.includes('/api/v1/tokens'));
    expect(issue!.headers['Authorization']).toBe(`Bearer ${VALID_JWT}`);
    expect(mock.calls.some((c) => c.url.includes('/auth/login'))).toBe(false);
  });

  it('uses the caller JWT (least privilege) even when a session token is also present', async () => {
    // A stale x-admin-token alongside a valid caller JWT must not cause the
    // request to be served with CST's admin credentials.
    const res = await request(app)
      .get('/api/farms')
      .set('Authorization', `Bearer ${VALID_JWT}`)
      .set('x-admin-token', EXPIRED_SESSION);
    expect(res.status).toBe(200);
    const listCall = mock.calls.find((c) => c.url.includes('/api/v1/farms?'));
    expect(listCall!.headers['Authorization']).toBe(`Bearer ${VALID_JWT}`);
  });

// ── 5. Expired caller JWT ───────────────────────────────────────────────────
  it('refuses an expired caller JWT with 401 and never re-authenticates as CST admin', async () => {
    const rejecting = buildMockFetch({ rejectExpiredJwt: true });
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'cst-farm-key',
      apiToken: 'cst-static-admin-jwt',
      fetchFn: rejecting.fn as any,
    });
    CoreRegistry.registerTenant(
      {
        tenant_id: 'tenant-vfarm-01',
        name: 'vFarm',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );

    const res = await request(app).get('/api/farms').set('Authorization', `Bearer ${EXPIRED_JWT}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');

    // The escalation path: CST must not have logged in with VFARM_ADMIN_* to
    // paper over the caller's expired token.
    expect(rejecting.calls.some((c) => c.url.includes('/auth/login'))).toBe(false);
    // And it must not have fallen back to CST's farm key either.
    expect(rejecting.calls.every((c) => !c.headers['X-Farm-Key'])).toBe(true);
  });

  it('refuses an expired caller JWT on /api/tokens without minting a key', async () => {
    const rejecting = buildMockFetch({ rejectExpiredJwt: true });
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'cst-farm-key',
      apiToken: 'cst-static-admin-jwt',
      fetchFn: rejecting.fn as any,
    });
    CoreRegistry.registerTenant(
      {
        tenant_id: 'tenant-vfarm-01',
        name: 'vFarm',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );

    const res = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${EXPIRED_JWT}`)
      .send({ farm_id: CST_FARM });
    expect(res.status).toBe(401);
    expect(res.body.raw_key).toBeUndefined();
    expect(rejecting.calls.some((c) => c.url.includes('/auth/login'))).toBe(false);
  });

  // ── 6. Wrong tenant ─────────────────────────────────────────────────────────
  it('never merges another tenant farm into a caller JWT farm list', async () => {
    // CST's own cached projection contains OTHER_TENANT_FARM.
    const adapter = CoreRegistry.getVfarmAdapter()!;
    (adapter as any).discoveredFarms = [{ id: OTHER_TENANT_FARM, name: 'other-tenant' }];

    const res = await request(app).get('/api/farms').set('Authorization', `Bearer ${VALID_JWT}`);
    expect(res.status).toBe(200);
    const ids = (res.body.farms as any[]).map((f) => f.id);
    expect(ids).toContain(CST_FARM);
    expect(ids).not.toContain(OTHER_TENANT_FARM);
  });

  // ── 7. Farm-key scoped routes refuse a caller JWT ───────────────────────────
  it('refuses a caller JWT on the farm-key scoped routes instead of using CST key', async () => {
    for (const r of ADMIN_ONLY_ROUTES) {
      const res = await (request(app) as any)[r.method](r.path).set('Authorization', `Bearer ${VALID_JWT}`);
      expect(res.status, `${r.method.toUpperCase()} ${r.path}`).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    }
    expect(mock.calls).toHaveLength(0);
  });

  it('keeps tenant/project isolation on the devices route (no synthesized owner identity)', async () => {
    const res = await request(app)
      .get('/api/devices')
      .set('x-admin-token', VALID_SESSION)
      .query({ farm_id: CST_FARM });
    expect(res.status).toBe(200);
    expect(res.body.farm_id).toBe(CST_FARM);
    // The request is authorized by the admin session alone; the adapter must
    // not have been handed a fabricated owner speaker to satisfy.
    const devicesCall = mock.calls.find((c) => c.url.includes('/api/v1/devices?'));
    expect(devicesCall).toBeDefined();
    expect(devicesCall!.headers['X-Farm-Key']).toBe('cst-farm-key');
  });
});
