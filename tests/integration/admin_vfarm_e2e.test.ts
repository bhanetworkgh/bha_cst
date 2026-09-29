/**
 * Admin vFarm proxy E2E — mocked live client (CI-safe).
 * Proves /api/v1/admin/vfarm/* routes return 200 with expected shapes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

const LIVE_FARM = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';
const TEST_FARM = 'ed95e120-74c4-4126-a2e9-0e4ffa9275e6';
const DEVICE_ID = 'sensor-abc-001';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function buildMockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const headerRecord: Record<string, string> = {};
    if (headers) {
      if (typeof headers.get === 'function') {
        // undici Headers — skip strict check in tests
      } else {
        Object.assign(headerRecord, headers);
      }
    }
    const farmKey = headerRecord['X-Farm-Key'] ?? headerRecord['x-farm-key'];
    if (farmKey && headerRecord['X-API-Key']) {
      throw new Error('Must not send X-API-Key to vFarm');
    }

    if (url.includes('/api/v1/farms?')) {
      return jsonResponse(200, {
        farms: [
          { id: LIVE_FARM, name: 'v-farm', is_active: true, device_count: 22, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
          { id: TEST_FARM, name: 'test-001', is_active: true, device_count: 0, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
        ],
        total: 2,
      });
    }
    if (url.includes(`/api/v1/farms/${LIVE_FARM}/health`)) {
      return jsonResponse(200, { status: 'healthy', online_count: 20 });
    }
    if (url.includes(`/api/v1/farms/${LIVE_FARM}`) && !url.includes('/health') && !url.includes('/layout')) {
      return jsonResponse(200, { id: LIVE_FARM, name: 'v-farm', is_active: true, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' });
    }
    if (url.includes('/api/v1/devices?')) {
      return jsonResponse(200, {
        devices: [{ id: DEVICE_ID, device_type: 'sensor', status: 'active', farm_id: LIVE_FARM }],
        total: 1,
        online_count: 1,
        offline_count: 0,
        registered_count: 1,
        maintenance_count: 0,
        error_count: 0,
        unhealthy_count: 0,
      });
    }
    if (url.includes('/readings/latest?sensor_id=')) {
      return jsonResponse(200, { id: 1, sensor_id: DEVICE_ID, reading_ts: '2026-01-01T00:00:00Z', received_at: '2026-01-01T00:00:00Z' });
    }
    if (url.includes('/readings?sensor_id=')) {
      return jsonResponse(200, { sensor_id: DEVICE_ID, from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', count: 1, readings: [] });
    }
    if (url.includes('/readings/stats')) {
      return jsonResponse(200, {
        sensor_id: DEVICE_ID,
        window: '24h',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
        total_readings: 10,
        error_readings: 0,
        temperature: { min: '20', max: '25', avg: '22' },
        humidity: { min: '50', max: '70', avg: '60' },
      });
    }
    if (url.includes('/layout')) {
      return jsonResponse(200, { farm_id: LIVE_FARM, zones: [] });
    }
    if (url.includes('/alerts/threshold/counts')) {
      return jsonResponse(200, { counts: [] });
    }
    if (url.includes('/alerts/threshold/open')) {
      return jsonResponse(200, { alerts: [], total: 0 });
    }
    if (url.includes('/alerts/history')) {
      return jsonResponse(200, { alerts: [], total: 0 });
    }
    if (url.includes('/vision/images/latest')) {
      return jsonResponse(200, { image_url: null });
    }
    if (url.includes('/organizations')) {
      return jsonResponse(200, { organizations: [], total: 0 });
    }
    if (url.includes('/api/v1/health')) {
      return jsonResponse(200, { status: 'ok', db: 'ok', version: '1.0.0' });
    }
    return jsonResponse(404, { detail: 'not found' });
  });
}

describe('Admin vFarm Live E2E proxy (mocked upstream)', () => {
  const app = createApp();

  beforeEach(async () => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    const mockFetch = buildMockFetch();
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'mock-farm-key',
      fetchFn: mockFetch as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: 'tenant-vfarm-01', name: 'vFarm', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter,
    );
    await adapter.discoverFarms();
    await adapter.switchActiveFarm(LIVE_FARM);
  });

  it('GET /vfarm/farms discovers farms', async () => {
    const res = await request(app).get('/api/v1/admin/vfarm/farms');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /vfarm/dashboard returns composite payload', async () => {
    const res = await request(app).get(`/api/v1/admin/vfarm/dashboard?farm_id=${LIVE_FARM}`);
    expect(res.status).toBe(200);
    expect(res.body.farm_id).toBe(LIVE_FARM);
  });

  it('GET /vfarm/devices lists devices for farm', async () => {
    const res = await request(app).get(`/api/v1/admin/vfarm/devices?farm_id=${LIVE_FARM}`);
    expect(res.status).toBe(200);
    expect(res.body.devices?.[0]?.id).toBe(DEVICE_ID);
  });

  it('GET telemetry proxies (sensor latest, history, stats)', async () => {
    const latest = await request(app).get(`/api/v1/admin/vfarm/readings/sensor-latest?sensor_id=${DEVICE_ID}`);
    expect(latest.status).toBe(200);
    expect(latest.body.sensor_id).toBe(DEVICE_ID);

    const hist = await request(app).get(`/api/v1/admin/vfarm/readings?sensor_id=${DEVICE_ID}&limit=5`);
    expect(hist.status).toBe(200);

    const stats = await request(app).get(`/api/v1/admin/vfarm/readings/stats?sensor_id=${DEVICE_ID}&window=24h`);
    expect(stats.status).toBe(200);
  });

  it('GET /vfarm/layout returns farm layout', async () => {
    const res = await request(app).get(`/api/v1/admin/vfarm/layout?farm_id=${LIVE_FARM}`);
    expect(res.status).toBe(200);
  });

  it('GET alert and vision proxies succeed', async () => {
    expect((await request(app).get(`/api/v1/admin/vfarm/alerts/counts?farm_id=${LIVE_FARM}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/admin/vfarm/alerts/open?farm_id=${LIVE_FARM}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/admin/vfarm/vision/latest?farm_id=${LIVE_FARM}`)).status).toBe(200);
  });
});
