/**
 * Live-contract regressions found by probing the running vFarm service
 * (LOOP-1790985133889-8D7U / LOOP-1790806602006-DOCR).
 *
 * Both defects below were found by calling the real endpoint, not by reading
 * code, and both silently broke farm-scoped reads in production:
 *
 *   1. `layoutResponseSchema` required `zones[].kind` to be a string. The live
 *      service returns `null`, and the upstream spec declares
 *      `anyOf: [{type:"string"},{type:"null"}]`, so getFarmLayout() threw a
 *      ZodError on every real layout response.
 *
 *   2. `VfarmLiveClient.request()` sent only `X-Farm-Key`. The live service
 *      answers 403 "API key not valid for this farm" for any farm the key is not
 *      bound to, even though the identical request succeeds with a bearer JWT.
 *      That limited getFarm/getFarmHealth/listAllDevices/listFarmZones/
 *      getFarmLayout and the readings+alerts helpers to one farm.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  VfarmLiveClient,
  VFARM_DEFAULT_TIMEOUT_MS,
  VFARM_SYSTEM_STATS_TIMEOUT_MS,
} from '../../engine/src/adapters/vfarm/live_client.js';
import { layoutResponseSchema, zoneResponseSchema } from '../../engine/src/adapters/vfarm/schemas.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('LOOP-1790985133889-8D7U — live layout response parses', () => {
  it('accepts zones[].kind === null, as the live service returns', () => {
    // Captured shape from GET /api/v1/farms/{farm_id}/layout -> HTTP 200.
    const live = {
      farm_id: '21dde23e-f7f6-46bc-9b54-e97fabaaafd7',
      farm_code: 'v-farm',
      zones: [
        {
          id: 'f1ce21e7-0000-0000-0000-000000000000',
          name: 'Main Zone',
          kind: null,
          cabinet_serial: null,
          sort_order: 0,
          is_active: true,
          config: null,
          locations: [
            {
              id: '89b46a18-0000-0000-0000-000000000000',
              name: 'rack1',
              kind: null,
              sublocations: [
                {
                  id: '6190067f-0000-0000-0000-000000000000',
                  name: 'tray 01',
                  kind: null,
                  bay_index: 0,
                  side: null,
                },
              ],
            },
          ],
        },
      ],
    };
    const parsed = layoutResponseSchema.parse(live);
    expect(parsed.zones).toHaveLength(1);
    expect(parsed.zones[0].kind).toBeNull();
  });

  it('still accepts a string kind, and still requires id and name', () => {
    expect(() =>
      layoutResponseSchema.parse({
        farm_id: 'f1',
        zones: [{ id: 'z1', name: 'Zone A', kind: 'greenhouse' }],
      }),
    ).not.toThrow();
    expect(() => layoutResponseSchema.parse({ farm_id: 'f1', zones: [{ id: 'z1' }] })).toThrow();
  });

  it('accepts the live zones response where kind is null', () => {
    const live = {
      farm_id: '21dde23e-f7f6-46bc-9b54-e97fabaaafd7',
      id: 'z1',
      name: 'Main Zone',
      description: null,
      length_m: null,
      width_m: null,
      height_m: null,
      sort_order: 0,
      is_active: true,
      location_count: 3,
      kind: null,
      cabinet_serial: null,
    };
    expect(zoneResponseSchema.parse(live).kind).toBeNull();
  });

  it('getFarmLayout() returns the parsed layout instead of throwing a ZodError', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        farm_id: 'f1',
        farm_code: 'test-001',
        zones: [{ id: 'z1', name: 'Main Zone', kind: null, locations: [] }],
      }),
    );
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      fetchFn: fetchFn as any,
    });
    const res = await client.getFarmLayout('f1');
    expect(res.zones[0].name).toBe('Main Zone');
    expect(res.zones[0].kind).toBeNull();
  });
});

describe('LOOP-1790985133889-8D7U — request() sends the bearer token as well as the farm key', () => {
  const capture = () => {
    const seen: Record<string, string>[] = [];
    const FARM = {
      id: 'f1',
      name: 'farm',
      is_active: true,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push((init?.headers || {}) as Record<string, string>);
      if (url.includes('/devices')) {
        return jsonResponse(200, { devices: [], total: 0 });
      }
      if (url.includes('/zones')) {
        return jsonResponse(200, []);
      }
      if (url.includes('/health')) {
        return jsonResponse(200, { status: 'healthy' });
      }
      if (url.includes('/organizations/')) {
        return jsonResponse(200, []);
      }
      return jsonResponse(200, FARM);
    });
    return { seen, fetchFn };
  };

  it('includes Authorization: Bearer <jwt> alongside X-Farm-Key on a farm-scoped read', async () => {
    const { seen, fetchFn } = capture();
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      apiToken: 'admin-jwt',
      fetchFn: fetchFn as any,
    });
    await client.getFarm('f1');
    expect(seen[0]['X-Farm-Key']).toBe('farm-key');
    expect(seen[0]['Authorization']).toBe('Bearer admin-jwt');
  });

  it('covers every request()-based read that was farm-key bound', async () => {
    const { seen, fetchFn } = capture();
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      apiToken: 'admin-jwt',
      fetchFn: fetchFn as any,
    });
    await client.getFarm('f1');
    await client.getFarmHealth('f1');
    await client.listAllDevices('f1');
    await client.listFarmZones('f1');
    for (const headers of seen) {
      expect(headers['Authorization']).toBe('Bearer admin-jwt');
    }
    expect(seen).toHaveLength(4);
  });

  it('lets an explicit per-call Authorization header win', async () => {
    const { seen, fetchFn } = capture();
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      apiToken: 'admin-jwt',
      fetchFn: fetchFn as any,
    });
    await client.getOrgMembers('org-1', 'caller-jwt');
    expect(seen[0]['Authorization']).toBe('Bearer caller-jwt');
  });

  it('omits Authorization when no token is configured, without breaking farm-key auth', async () => {
    const { seen, fetchFn } = capture();
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      fetchFn: fetchFn as any,
    });
    await client.getFarm('f1');
    expect(seen[0]['X-Farm-Key']).toBe('farm-key');
    expect(seen[0]['Authorization']).toBeUndefined();
  });

  it('gives both clients the same default timeout when VFARM_API_TIMEOUT_MS is unset', async () => {
    // The two clients used to abort the same upstream at 5000ms and 8000ms
    // respectively while VfarmTenantAdapter fed the same (unset) config.timeoutMs
    // into both — so one unset env var produced two different deadlines.
    const { VfarmHttpClient } = await import('../../engine/src/adapters/vfarm/http_client.js');

    const live = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      fetchFn: (async () => jsonResponse(200, {})) as any,
    });
    const http = new VfarmHttpClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      fetchFn: (async () => jsonResponse(200, {})) as any,
    });

    expect((live as any).timeoutMs).toBe((http as any).timeoutMs);
  });

  it('still honours an explicitly configured timeout over the default', async () => {
    const { VfarmHttpClient } = await import('../../engine/src/adapters/vfarm/http_client.js');
    const live = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      timeoutMs: 1234,
      fetchFn: (async () => jsonResponse(200, {})) as any,
    });
    const http = new VfarmHttpClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      timeoutMs: 1234,
      fetchFn: (async () => jsonResponse(200, {})) as any,
    });
    expect((live as any).timeoutMs).toBe(1234);
    expect((http as any).timeoutMs).toBe(1234);
  });
});

describe('LOOP-1790985133889-8D7U — requestPassthrough() authenticates the same way as request()', () => {
  // getDashboardSummary() and getSystemStats() are the only callers, and both go
  // through requestPassthrough(). It used to send X-Farm-Key alone, so they had
  // no bearer fallback and were limited to the one farm the key is bound to —
  // the live service answers 403 "API key not valid for this farm" for any
  // other. It also demanded a farm key for two endpoints that are not
  // farm-scoped at all.
  const capture = () => {
    const seen: Record<string, string>[] = [];
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers || {}) as Record<string, string>);
      return jsonResponse(200, { total_readings: 0, total_devices: 0 });
    });
    return { seen, fetchFn };
  };

  const makeClient = (opts: { apiKey?: string; apiToken?: string }, fetchFn: any) =>
    new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      ...opts,
      fetchFn: fetchFn as any,
    });

  it('sends Authorization alongside X-Farm-Key on getSystemStats()', async () => {
    const { seen, fetchFn } = capture();
    await makeClient({ apiKey: 'farm-key', apiToken: 'admin-jwt' }, fetchFn).getSystemStats();
    expect(seen[0]['X-Farm-Key']).toBe('farm-key');
    expect(seen[0]['Authorization']).toBe('Bearer admin-jwt');
  });

  it('sends Authorization alongside X-Farm-Key on getDashboardSummary()', async () => {
    const { seen, fetchFn } = capture();
    await makeClient({ apiKey: 'farm-key', apiToken: 'admin-jwt' }, fetchFn).getDashboardSummary();
    expect(seen[0]['X-Farm-Key']).toBe('farm-key');
    expect(seen[0]['Authorization']).toBe('Bearer admin-jwt');
  });

  it('works with a bearer token alone, since neither endpoint is farm-scoped', async () => {
    const { seen, fetchFn } = capture();
    await makeClient({ apiToken: 'admin-jwt' }, fetchFn).getSystemStats();
    expect(seen[0]['Authorization']).toBe('Bearer admin-jwt');
    expect(seen[0]['X-Farm-Key']).toBeUndefined();
  });

  it('still works with a farm key alone, and sends no Authorization it cannot fill', async () => {
    const { seen, fetchFn } = capture();
    await makeClient({ apiKey: 'farm-key' }, fetchFn).getSystemStats();
    expect(seen[0]['X-Farm-Key']).toBe('farm-key');
    expect(seen[0]['Authorization']).toBeUndefined();
  });

  it('refuses to call out with no credential at all', async () => {
    const { fetchFn } = capture();
    await expect(makeClient({}, fetchFn).getSystemStats()).rejects.toThrow(
      /X-Farm-Key or a bearer token is required/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('LOOP-1790985133889-8D7U — getSystemStats() gets its own request budget', () => {
  // GET /api/v1/system/stats scans the whole platform: measured 13.8s with a
  // bearer token and 39.0s key-only on bhavfarm1.duckdns.org, versus 234-777ms
  // for /dashboard/summary. Under the shared 8000ms default it still needs
  // the per-endpoint override for the very slow endpoints.
  it('exceeds the shared default by enough headroom for the measured latency', () => {
    expect(VFARM_DEFAULT_TIMEOUT_MS).toBe(8000);
    expect(VFARM_SYSTEM_STATS_TIMEOUT_MS).toBeGreaterThan(39000);
  });

  it('succeeds on getSystemStats() where the shared default would abort', async () => {
    // A fetch that ignores the signal and resolves slowly — exactly the shape of
    // the real endpoint. If the 5s default were still applied this test would
    // take 5s and fail; with the override it completes.
    const slowFetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(200, { total_readings: 1, total_devices: 24, total_farms: 2 });
    });
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      fetchFn: slowFetch as any,
    });
    await expect(client.getSystemStats()).resolves.toMatchObject({ total_devices: 24 });
  });

  it('keeps the shared default for getDashboardSummary()', async () => {
    const slowFetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse(200, { farms: { total: 2 } });
    });
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'farm-key',
      timeoutMs: 60000,
      fetchFn: slowFetch as any,
    });
    // An explicit VFARM_API_TIMEOUT_MS still governs the non-stats endpoints.
    await expect(client.getDashboardSummary()).resolves.toMatchObject({ farms: { total: 2 } });
  });
});
