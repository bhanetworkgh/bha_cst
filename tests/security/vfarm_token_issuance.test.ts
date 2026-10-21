/**
 * Regression tests for the vFarm proxy route surface that the 5R0J suite does
 * not already cover.
 *
 * The existing `vfarm_proxy_unauth.test.ts` proves that unauthenticated and
 * unauthorized requests are refused on the registered methods. This file adds
 * the cases that were NOT covered:
 *
 *   1. HTTP METHOD coverage — only the registered verbs are served. A `PUT`,
 *      `PATCH` or `DELETE` on the same paths must not be served, and must not
 *      reach upstream.
 *   2. Token ISSUANCE is audited — minting a credential is an event that
 *      must leave a record, and the record must never contain key material.
 *   3. A CALLER JWT must not re-point the PROCESS-WIDE farm key. Issuing a
 *      key for the caller's own farm is legitimate (vFarm enforces the
 *      organisation scope because the JWT is forwarded verbatim), but the
 *      adapter's shared key is what every other tenant's identity resolution
 *      uses — a tenant-scoped caller must not be able to change it.
 *
 * The route table under test (from `engine/src/app.ts`):
 *   GET  /api/devices,  /api/v1/devices    -> requireVfarmAdminSession
 *   GET  /api/dashboard,/api/v1/dashboard -> requireVfarmAdminSession
 *   GET  /api/farms,    /api/v1/farms      -> requireVfarmAdminSessionOrJwt
 *   POST /api/tokens,   /api/v1/tokens     -> requireVfarmAdminSessionOrJwt
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { Logger } from '../../engine/src/config/logger.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { __registerInMemoryAdminSession } from '../../engine/src/middleware/vfarm_proxy_auth.js';

const CST_FARM = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';
const VALID_SESSION = 'session-token-valid';
const ISSUED_RAW_KEY = 'farmkey_raw_value_must_never_be_audited';

function makeJwt(expSecondsFromNow: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}
const VALID_JWT = makeJwt(3600);

describe('vFarm proxy route surface — methods, issuance audit, and shared-key scoping', () => {
  const app = createApp();
  const mock = { calls: [] as any[] };
  let adapter: any;
  // The admin-session resolver prefers a DATABASE-backed pool, and DbClient
  // caches its pool in a static. An inherited pool (left by another test
  // file in the same worker) would make the in-memory session invisible and
  // this suite order-dependent, so the pool is cleared for the duration and
  // restored afterwards — the same hermetic pattern the 5R0J suite uses.
  let savedPool: unknown;

  beforeEach(() => {
    savedPool = DbClient.getPool();
    DbClient.setPool(null);
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    vi.restoreAllMocks();
    mock.calls = [];

    // The third argument is an absolute expiry Date, not a TTL.
    __registerInMemoryAdminSession(
      VALID_SESSION,
      'admin@cst.test',
      new Date(Date.now() + 3600 * 1000),
    );

    // The adapter is built over a mocked fetch, so the REAL issuance path
    // (adapter -> live client -> HTTP) runs without touching the network.
    const fetchFn = vi.fn(async (url: string, init?: any) => {
      const u = String(url);
      mock.calls.push({ op: u.includes('/tokens') ? 'issueFarmToken' : u, method: init?.method });
      if (u.includes('/tokens')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ raw_key: ISSUED_RAW_KEY, id: 'key_1', status: 'active' }),
          text: async () => JSON.stringify({ raw_key: ISSUED_RAW_KEY }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ farms: [{ id: CST_FARM, name: 'v-farm' }], grants: [] }),
        text: async () => '{}',
      } as unknown as Response;
    });

    adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'cst-farm-key',
      apiToken: 'cst-static-admin-jwt',
      fetchFn: fetchFn as any,
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
    DbClient.setPool(savedPool as any);
    vi.restoreAllMocks();
  });

  // ── 1. HTTP method coverage ──────────────────────────────────────────────

  const REGISTERED: Array<{ path: string; method: 'get' | 'post' }> = [
    { path: '/api/devices', method: 'get' },
    { path: '/api/v1/devices', method: 'get' },
    { path: '/api/dashboard', method: 'get' },
    { path: '/api/v1/dashboard', method: 'get' },
    { path: '/api/farms', method: 'get' },
    { path: '/api/v1/farms', method: 'get' },
    { path: '/api/tokens', method: 'post' },
    { path: '/api/v1/tokens', method: 'post' },
  ];

  it('serves only the registered verb on every vFarm proxy path', async () => {
    for (const route of REGISTERED) {
      const otherVerbs = (['get', 'post', 'put', 'patch', 'delete'] as const).filter(
        (v) => v !== route.method
      );
      for (const verb of otherVerbs) {
        const res = await (request(app) as any)[verb](route.path)
          .set('x-admin-token', VALID_SESSION)
          .send({ farm_id: CST_FARM });
        // The path exists, but not for this verb: it must not be served.
        expect(res.status).not.toBe(200);
        expect(res.status).not.toBe(201);
      }
    }
    // No unregistered verb reached upstream.
    expect(mock.calls).toHaveLength(0);
  });

  it('does not mint a farm key for an unregistered verb on /api/tokens', async () => {
    for (const verb of ['put', 'patch', 'delete'] as const) {
      const res = await (request(app) as any)[verb]('/api/tokens')
        .set('x-admin-token', VALID_SESSION)
        .send({ farm_id: CST_FARM });
      expect(res.status).not.toBe(201);
      expect(res.body?.raw_key).toBeUndefined();
    }
    expect(mock.calls.filter((c) => c.op === 'issueFarmToken')).toHaveLength(0);
  });

  // ── 2. Token issuance is audited, without key material ───────────────────

  it('audits a successful farm-key issuance without recording the key', async () => {
    const auditSpy = vi.spyOn(Logger, 'audit').mockImplementation(() => undefined);

    const res = await request(app)
      .post('/api/tokens')
      .set('x-admin-token', VALID_SESSION)
      .send({ farm_id: CST_FARM });

    expect(res.status).toBe(201);
    expect(res.body.raw_key).toBe(ISSUED_RAW_KEY);

    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const issuance = entries.find((e) => e?.tool_or_route === 'POST /api/tokens');
    expect(issuance).toBeDefined();
    expect(issuance.outcome).toBe('ok');
    expect(String(issuance.reason)).toContain(CST_FARM);
    // The key material must never reach the audit trail.
    expect(JSON.stringify(issuance)).not.toContain(ISSUED_RAW_KEY);
  });

  it('audits a refused farm-key issuance', async () => {
    const auditSpy = vi.spyOn(Logger, 'audit').mockImplementation(() => undefined);
    (adapter as any).liveClient = {
      issueFarmToken: vi.fn(async () => {
        const err: any = new Error('upstream refused');
        err.status = 403;
        throw err;
      }),
    };

    const res = await request(app)
      .post('/api/tokens')
      .set('x-admin-token', VALID_SESSION)
      .send({ farm_id: CST_FARM });

    expect(res.status).toBe(401);
    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const refusal = entries.find((e) => e?.tool_or_route === 'POST /api/tokens');
    expect(refusal).toBeDefined();
    expect(refusal.outcome).toBe('refused');
    expect(JSON.stringify(refusal)).not.toContain(ISSUED_RAW_KEY);
  });

  // ── 3. A caller JWT must not re-point the shared farm key ────────────────

  it('does not switch the shared farm key when the caller authenticates with a JWT', async () => {
    const keyBefore = adapter.config?.apiKey;

    const res = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${VALID_JWT}`)
      .send({ farm_id: CST_FARM });

    expect(res.status).toBe(201);
    expect(res.body.raw_key).toBe(ISSUED_RAW_KEY);
    // The caller got their own key, but the process-wide key every other
    // tenant's resolution uses is unchanged.
    expect(adapter.config?.apiKey).toBe(keyBefore);
  });

  it('switches the shared farm key for an operator (CST admin session)', async () => {
    const res = await request(app)
      .post('/api/tokens')
      .set('x-admin-token', VALID_SESSION)
      .send({ farm_id: CST_FARM });

    expect(res.status).toBe(201);
    // Re-pointing CST at a farm is exactly what the operator path is for.
    expect(adapter.config?.apiKey).toBe(ISSUED_RAW_KEY);
  });
});
