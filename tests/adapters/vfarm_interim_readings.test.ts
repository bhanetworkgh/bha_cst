import { describe, expect, it, vi } from 'vitest';
import {
  resolveSensorPlacement,
  VfarmLiveClient,
} from '../../engine/src/adapters/vfarm/live_client.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function readingsEnvelope(sensorId: string, readings: Record<string, unknown>[] = []) {
  return {
    sensor_id: sensorId,
    from: '2026-10-26T10:00:00Z',
    to: '2026-10-27T10:00:00Z',
    count: readings.length,
    readings,
  };
}

function readingItem(sensorId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    sensor_id: sensorId,
    reading_ts: '2026-10-27T10:00:00Z',
    received_at: '2026-10-27T10:00:01Z',
    values: { temperature: { value: 21.5, unit: 'celsius', status: 'ok' } },
    ...overrides,
  };
}

describe('confirmed vFarm interim reading contract (GET /api/v1/readings?sensor_id=X&limit=1)', () => {
  it('calls /readings?sensor_id=X&limit=1 (NOT /readings/latest)', async () => {
    const fetchFn = vi.fn(async (_url: string) => jsonResponse(200, readingsEnvelope('rack1_soil', [readingItem('rack1_soil')])));
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'test-key',
      apiToken: 'jwt-token-xyz',
      fetchFn: fetchFn as any,
    });

    const reading = await client.getLatestReading('rack1_soil');

    // 1. Path must be /api/v1/readings?sensor_id=rack1_soil&limit=1 (interim endpoint)
    expect(fetchFn).toHaveBeenCalledWith(
      'https://mock.vfarm.test/api/v1/readings?sensor_id=rack1_soil&limit=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Farm-Key': 'test-key',
          'Authorization': 'Bearer jwt-token-xyz',
        }),
      }),
    );
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/readings/latest'))).toBe(false);

    // 2. Parsed from readings array, first item used
    expect(reading).not.toBeNull();
    expect(reading!.sensor_id).toBe('rack1_soil');
    expect(reading!.reading_ts).toBe('2026-10-27T10:00:00Z');
    expect(reading!.received_at).toBe('2026-10-27T10:00:01Z');
    expect(reading!.values).toEqual({ temperature: { value: 21.5, unit: 'celsius', status: 'ok' } });
  });

  it('verifies all four authoritative sensors independently via interim endpoint', async () => {
    const sensorPayloads: Record<string, Record<string, unknown>> = {
      rack1_soil: { reading_ts: '2026-11-02T19:45:00Z', values: { soil_moisture: { unit: 'percent', value: 85.5, status: 'ok' } } },
      rack1_ph: { reading_ts: '2026-11-02T19:45:00Z', values: { ph: { unit: null, value: 6.8, status: 'ok' } } },
      rack2_dht: { reading_ts: '2026-11-02T19:45:00Z', values: { temperature: { unit: 'celsius', value: 23.4, status: 'ok' }, humidity: { unit: 'percent', value: 62.1, status: 'ok' } } },
      rack1_mq7: { reading_ts: '2026-11-02T19:45:00Z', values: { co: { unit: 'ppm', value: 11.2, status: 'ok' } } },
    };

    for (const [sensorId, payload] of Object.entries(sensorPayloads)) {
      const fetchFn = vi.fn(async (url: string) => {
        expect(url).toContain(`/api/v1/readings?sensor_id=${sensorId}&limit=1`);
        expect(url).not.toContain('/readings/latest');
        return jsonResponse(200, readingsEnvelope(sensorId, [readingItem(sensorId, payload)]));
      });

      const client = new VfarmLiveClient({
        baseUrl: 'https://mock.vfarm.test',
        apiKey: 'test-key',
        fetchFn: fetchFn as any,
      });

      const reading = await client.getLatestReading(sensorId);
      expect(reading?.sensor_id).toBe(sensorId);
      expect(reading!.reading_ts).toBe(payload.reading_ts);
      expect(reading!.values).toEqual(payload.values);
    }
  });

  it('returns null when sensor has no readings (empty array)', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'test-key',
      fetchFn: vi.fn(async () => jsonResponse(200, readingsEnvelope('rack1_soil', []))) as any,
    });

    const reading = await client.getLatestReading('rack1_soil');
    expect(reading).toBeNull();
  });

  it('propagates 401 HTTP error on authentication failure', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'invalid-key',
      fetchFn: vi.fn(async () => jsonResponse(401, { error: 'Unauthorized' })) as any,
    });

    await expect(client.getLatestReading('rack1_soil')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('propagates timeout error when request exceeds timeout budget', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'test-key',
      timeoutMs: 50,
      fetchFn: vi.fn(async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      }) as any,
    });

    await expect(client.getLatestReading('rack1_soil')).rejects.toThrow(/timed out/i);
  });

  it('handles null top-level fields and nested values without fabricating defaults', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'test-key',
      fetchFn: vi.fn(async () => jsonResponse(200, readingsEnvelope('rack1_soil', [{
        id: 7,
        sensor_id: 'rack1_soil',
        reading_ts: '2026-11-02T19:41:41Z',
        received_at: '2026-11-02T19:41:42.468451Z',
        values: { soil_moisture: { unit: 'percent', value: null, status: 'unknown' } },
      }]))) as any,
    });

    const reading = await client.getLatestReading('rack1_soil');
    expect(reading!.received_at).toBe('2026-11-02T19:41:42.468451Z');
    expect(reading!.values?.soil_moisture?.value).toBeNull();
    expect(reading!.values?.soil_moisture?.status).toBe('unknown');
  });

  it('preserves timestamps as returned by the API without inventing current time', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'test-key',
      fetchFn: vi.fn(async () => jsonResponse(200, readingsEnvelope('rack1_ph', [{
        id: 1,
        sensor_id: 'rack1_ph',
        reading_ts: '2026-11-02T19:41:41Z',
        received_at: '2026-11-02T19:41:42.468451Z',
        values: { ph: { unit: null, value: 7.0, status: 'ok' } },
      }]))) as any,
    });

    const reading = await client.getLatestReading('rack1_ph');
    expect(reading!.reading_ts).toBe('2026-11-02T19:41:41Z');
    expect(reading!.received_at).toBe('2026-11-02T19:41:42.468451Z');
  });
});

describe('authoritative sensor placement resolution', () => {
  const cabinet = {
    id: 'VFARM-CAB-001',
    name: 'Tomato rack',
    device_type: 'cabinet',
    farm_id: 'farm_1',
    zone_id: 'zone_1',
    location_id: 'location_1',
    sublocation_id: 'sub_location_1',
    parent_device_id: null,
  };
  const board = {
    id: 'uno_board_01',
    device_type: 'board',
    farm_id: 'farm_1',
    zone_id: 'zone_1',
    location_id: 'location_1',
    sublocation_id: 'sub_location_1',
    parent_device_id: cabinet.id,
  };

  it.each(['rack1_soil', 'rack1_ph', 'rack2_dht', 'rack1_mq7'])(
    'resolves %s through uno_board_01 when cabinet_id is null',
    (sensorId) => {
      const sensor = {
        id: sensorId,
        device_type: 'sensor',
        cabinet_id: null,
        farm_id: 'farm_1',
        zone_id: null,
        location_id: null,
        sublocation_id: null,
        parent_device_id: board.id,
      };

      const placement = resolveSensorPlacement(sensor as any, [cabinet, board, sensor] as any);

      expect(placement).toEqual({
        sensor_id: sensorId,
        cabinet_id: 'VFARM-CAB-001',
        cabinet_name: 'Tomato rack',
        parent_device_id: 'uno_board_01',
        parent_chain: ['uno_board_01', 'VFARM-CAB-001'],
        zone_id: 'zone_1',
        location_id: 'location_1',
        sublocation_id: 'sub_location_1',
        resolution: 'parent_chain',
      });
    },
  );

  it('honors a direct authoritative cabinet_id', () => {
    const sensor = {
      id: 'sensor_direct',
      device_type: 'sensor',
      cabinet_id: cabinet.id,
      parent_device_id: null,
    };

    const placement = resolveSensorPlacement(sensor as any, [cabinet, sensor] as any);

    expect(placement.cabinet_id).toBe(cabinet.id);
    expect(placement.resolution).toBe('direct_cabinet_id');
  });

  it('uses a unique exact placement match when no parent cabinet exists', () => {
    const sensor = {
      id: 'sensor_placed',
      device_type: 'sensor',
      farm_id: 'farm_1',
      zone_id: cabinet.zone_id,
      location_id: cabinet.location_id,
      sublocation_id: cabinet.sublocation_id,
      parent_device_id: null,
    };

    const placement = resolveSensorPlacement(sensor as any, [cabinet, sensor] as any);

    expect(placement.cabinet_id).toBe(cabinet.id);
    expect(placement.resolution).toBe('placement_match');
  });

  it('leaves ambiguous placement unresolved instead of inventing a cabinet relationship', () => {
    const secondCabinet = { ...cabinet, id: 'VFARM-CAB-002', name: 'Other rack' };
    const sensor = {
      id: 'sensor_ambiguous',
      device_type: 'sensor',
      farm_id: 'farm_1',
      zone_id: cabinet.zone_id,
      location_id: cabinet.location_id,
      sublocation_id: cabinet.sublocation_id,
      parent_device_id: null,
    };

    const placement = resolveSensorPlacement(sensor as any, [cabinet, secondCabinet, sensor] as any);

    expect(placement.cabinet_id).toBeNull();
    expect(placement.resolution).toBe('unresolved');
  });

  it('exposes placement through the live client only for sensor-type devices', async () => {
    const sensor = {
      id: 'rack1_soil',
      device_type: 'sensor',
      parent_device_id: board.id,
      farm_id: 'farm_1',
    };
    const fetchFn = vi.fn(async () => jsonResponse(200, {
      devices: [cabinet, board, sensor],
      total: 3,
    }));
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    const placement = await client.getSensorPlacement('farm_1', 'rack1_soil');

    expect(placement?.cabinet_id).toBe(cabinet.id);
    expect(placement?.parent_chain).toEqual([board.id, cabinet.id]);
  });
});
