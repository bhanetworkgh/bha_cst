/**
 * Health route tests — deterministic coverage of the actual Express `/api/health`
 * endpoint with mocked vFarm adapter responses.
 *
 * These tests exercise the real route handler in `engine/src/app.ts` (not a
 * duplicated inline mapper). The mapper itself (`mapFarmHealthStatus`) is
 * imported from `app.ts` so the unit contract and the route share one
 * implementation.
 *
 * Asserted contract:
 *   - The top-level `status` is derived from `farm_health` ONLY. API
 *     reachability (`api_reachability`) is a separate diagnostic field and is
 *     never folded into `status`, so a reachable API with unavailable farm
 *     health can never report `healthy`.
 *   - Farm ID is resolved via the adapter (`getActiveFarmId`, backed by the
 *     canonical `VFARM_FARM_ID` and active discovery); never invented.
 *   - `raw_status` and `health_score` are preserved from the upstream response.
 *   - `/health` (liveness) is untouched and always `{ status: 'ok' }`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp, mapFarmHealthStatus } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

const app = createApp();

const TENANT = {
  tenant_id: 'tenant-vfarm-01',
  name: 'vFarm',
  status: 'active',
  adapter_type: 'vfarm',
  created_at: new Date().toISOString(),
};

function registerMockAdapter(overrides: {
  getHealth?: any;
  hasLiveClient?: boolean;
  getFarmHealthDirect?: any;
  getActiveFarmId?: string | null;
} = {}) {
  const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
    baseUrl: 'https://mock.vfarm.test',
    apiKey: 'cst-farm-key',
    apiToken: 'cst-static-admin-jwt',
  });
  (adapter as any).getHealth =
    overrides.getHealth ??
    vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 });
  (adapter as any).hasLiveClient =
    overrides.hasLiveClient !== undefined
      ? () => overrides.hasLiveClient
      : () => true;
  (adapter as any).getFarmHealthDirect =
    overrides.getFarmHealthDirect ??
    vi.fn().mockResolvedValue({ status: 'healthy', health_score: 90 });
  (adapter as any).getActiveFarmId =
    overrides.getActiveFarmId !== undefined
      ? () => overrides.getActiveFarmId
      : () => 'farm-1';
  CoreRegistry.registerTenant({ ...TENANT }, adapter);
  return adapter as unknown as VfarmTenantAdapter;
}

const envBackup = { ...process.env };
let savedPool: unknown;

beforeEach(() => {
  CoreRegistry.clear();
  DbClient.setPool(null);
  process.env = {
    ...envBackup,
    NODE_ENV: 'test',
    VFARM_API_JWT: 'cst-static-admin-jwt',
  };
  delete process.env.VFARM_FARM_ID;
  delete process.env.VFARM_DEFAULT_FARM_ID;
});

afterEach(() => {
  process.env = { ...envBackup };
  DbClient.setPool(savedPool as any);
  vi.restoreAllMocks();
});

describe('GET /api/health — authoritative farm health mapping', () => {
  it('maps explicit vFarm "healthy" to CST "healthy"', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: 'healthy', health_score: 92 }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.farm_health.status).toBe('healthy');
    expect(res.body.farm_health.raw_status).toBe('healthy');
    expect(res.body.farm_health.health_score).toBe(92);
    // API reachability is a separate diagnostic field, not the source of status.
    expect(res.body.api_reachability.status).toBe('healthy');
    expect(res.text).toContain('"status":"healthy"');
  });

  it('maps explicit vFarm "unhealthy" to CST "unhealthy"', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: 'unhealthy', health_score: 12 }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unhealthy');
    expect(res.body.farm_health.status).toBe('unhealthy');
    expect(res.body.farm_health.raw_status).toBe('unhealthy');
    expect(res.body.api_reachability.status).toBe('healthy');
    expect(res.text).toContain('"status":"unhealthy"');
  });

  it('maps missing health response (null from upstream) to "unknown"', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue(null),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.farm_health.status).toBe('unknown');
    expect(res.body.farm_health.raw_status).toBeNull();
    expect(res.body.api_reachability.status).toBe('healthy');
  });

  it('maps missing farm ID to "unknown" and makes no upstream farm-health call', async () => {
    const getFarmHealthDirect = vi.fn().mockResolvedValue({ status: 'healthy' });
    registerMockAdapter({
      getActiveFarmId: null,
      getFarmHealthDirect,
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.farm_health).toBeNull();
    expect(getFarmHealthDirect).not.toHaveBeenCalled();
  });

  it('maps an unrecognized/stale vFarm status to "degraded"', async () => {
    for (const raw of ['stale', 'maintenance', 'degraded', '', 'unknown_state']) {
      registerMockAdapter({
        getFarmHealthDirect: vi.fn().mockResolvedValue({ status: raw }),
        getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
      });
      const res = await request(app).get('/api/health');
      expect(res.body.status, `raw=${JSON.stringify(raw)}`).toBe('degraded');
      expect(res.body.farm_health.raw_status).toBe(raw);
    }
    expect(mapFarmHealthStatus('stale')).toBe('degraded');
    expect(mapFarmHealthStatus('maintenance')).toBe('degraded');
  });

  it('maps null upstream status to "unknown"', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: null }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.farm_health.status).toBe('unknown');
  });

  it('maps upstream timeout/error to "degraded"', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockRejectedValue(new Error('upstream down')),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('degraded');
    expect(res.body.farm_health.status).toBe('degraded');
    expect(res.body.farm_health.raw_status).toBeNull();
  });

  it('never derives health from API reachability: reachable API + unavailable farm health => unknown', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue(null),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.status).not.toBe('healthy');
    expect(res.body.api_reachability.status).toBe('healthy');
  });

  it('unavailable adapter (no live client) => unknown, api_reachability reflects probe', async () => {
    registerMockAdapter({
      hasLiveClient: false,
      getHealth: vi.fn().mockResolvedValue({ status: 'unavailable', latency_ms: 0 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.farm_health).toBeNull();
    expect(res.body.api_reachability.status).toBe('unavailable');
  });

  it('no registered adapter => unknown with null api_reachability', async () => {
    CoreRegistry.clear();
    DbClient.setPool(null);

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.farm_health).toBeNull();
    expect(res.body.api_reachability).toBeNull();
  });

  it('preserves source timestamp and raw upstream status where supplied', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: 'healthy', health_score: 88 }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 33 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.farm_health.raw_status).toBe('healthy');
    expect(res.body.farm_health.health_score).toBe(88);
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('staleness cannot be evaluated from the farm-health contract (no timestamp) — explicit limitation', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: 'healthy', health_score: 88 }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 33 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.farm_health.staleness_evaluation).toBe('unavailable_no_timestamp');
  });

  it('/health remains liveness-only and always returns ok', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: 'unhealthy' }),
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('bha-cst-engine');
  });

  it('malformed upstream response (invalid status shape) maps to degraded, never healthy', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: null as any, health_score: 'not-a-number' }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.status).not.toBe('healthy');
    expect(res.body.farm_health.raw_status).toBeNull();
  });

  it('upstream returns an object with no status field → unknown', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ health_score: 88 }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    expect(res.body.status).toBe('unknown');
    expect(res.body.farm_health.status).toBe('unknown');
    expect(res.body.farm_health.raw_status).toBeNull();
  });

  it('preserves authoritative health while marking freshness unavailable when no timestamp exists', async () => {
    registerMockAdapter({
      getFarmHealthDirect: vi.fn().mockResolvedValue({ status: 'healthy', health_score: 99 }),
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy', latency_ms: 40 }),
    });

    const res = await request(app).get('/api/health');

    // vFarm says healthy, but without a source timestamp CST cannot evaluate
    // freshness — staleness is explicitly unavailable, not inferred healthy.
    expect(res.body.farm_health.staleness_evaluation).toBe('unavailable_no_timestamp');
    expect(res.body.farm_health.status).toBe('healthy');
  });
});
