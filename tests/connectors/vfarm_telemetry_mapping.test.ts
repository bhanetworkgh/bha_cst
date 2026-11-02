/**
 * vFarm telemetry mapping — regression tests.
 *
 * The defect: `mapLatestReadingToTelemetry` read `reading.temperature_c` and
 * `reading.humidity_rh` (top-level, null in 15 of 16 real readings). The actual
 * data lives in `reading.values.temperature.value` and `reading.values.humidity.value`.
 *
 * Labels were also wrong: `ph_level` was set to `humidity` (displayed as
 * "Humidity"), `water_temp_c` was labeled "Water Temp" (should be "Temperature"),
 * and `ec_level` was never set (should come from `values.co.value`).
 *
 * These tests use the REAL upstream response shape (verified against the live
 * vFarm API on 2026-10-22). No live API calls.
 */
import { describe, it, expect, vi } from 'vitest';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

const FARM = 'farm_austin_main';
const UNIT = 'rack2_dht';

function makeIdentity(overrides: Record<string, unknown> = {}): SpeakerIdentity {
  return {
    person_id: 'u1',
    customer_ref: 'u1',
    tenant_id: 'tenant-vfarm-01',
    project_id: 'proj-vfarm-main',
    phone_e164: '+15551234567',
    is_known: true,
    role: 'manager',
    permissions: [],
    farm_ids: [FARM],
    ...overrides,
  } as SpeakerIdentity;
}

describe('vFarm telemetry mapping — real upstream shape', () => {
  it('reads temperature and humidity from values, not the null top-level fields', async () => {
    const reading = {
      sensor_id: 'rack2_dht',
      reading_ts: '2026-10-22T18:23:55Z',
      temperature_c: null,
      humidity_rh: null,
      values: {
        temperature: { unit: 'celsius', value: 28.3, status: 'ok' },
        humidity: { unit: 'percent_rh', value: 74, status: 'ok' },
      },
    };

    // We test the mapping function indirectly through the connector's
    // formatTelemetryText output. Since the connector calls the adapter's
    // getLatestDeviceReading, we verify the mapping logic directly.
    const { mapLatestReadingToTelemetry } = await import('../../engine/src/connectors/vfarm.js').then(() => {
      // The function is not exported, so we test via the connector's output.
      // Instead, test the connector with a mocked adapter.
      return { mapLatestReadingToTelemetry: null };
    });

    // Test through the connector with a mocked adapter.
    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { VfarmTenantAdapter } = await import('../../engine/src/adapters/vfarm/index.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    adapter.liveClient = {
      getLatestReading: async () => reading,
      ensureAdminToken: async () => 'tok',
    };
    adapter.hasLiveClient = () => true;

    const res = await VfarmConnector.getUnitStatus(
      'u1',
      { farm_id: FARM, unit_id: UNIT, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      makeIdentity(),
    );

    expect(res.text).toContain('Temperature: 28.3°C');
    expect(res.text).toContain('Humidity: 74%');
    expect(res.text).not.toContain('null');
  });

  it('reads pH, CO, and soil moisture from values with correct labels', async () => {
    const reading = {
      sensor_id: 'rack1_ph',
      reading_ts: '2026-10-22T18:22:49Z',
      temperature_c: null,
      humidity_rh: null,
      values: {
        ph: { unit: 'ph', value: 6.23, status: 'ok' },
        co: { unit: 'ppm', value: 0.69, status: 'ok' },
        soil_moisture: { unit: 'percent', value: 0, status: 'ok' },
      },
    };

    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    adapter.liveClient = {
      getLatestReading: async () => reading,
      ensureAdminToken: async () => 'tok',
    };
    adapter.hasLiveClient = () => true;

    const res = await VfarmConnector.getUnitStatus(
      'u1',
      { farm_id: FARM, unit_id: UNIT, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      makeIdentity(),
    );

    expect(res.text).toContain('pH: 6.23');
    expect(res.text).toContain('CO: 0.69');
    expect(res.text).toContain('Soil Moisture: 0%');
  });

  it('preserves zero values (does not convert 0 to null or missing)', async () => {
    const reading = {
      sensor_id: 'rack1_soil',
      reading_ts: '2026-10-22T18:21:55Z',
      temperature_c: null,
      humidity_rh: null,
      values: {
        soil_moisture: { unit: 'percent', value: 0, status: 'ok' },
      },
    };

    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    adapter.liveClient = {
      getLatestReading: async () => reading,
      ensureAdminToken: async () => 'tok',
    };
    adapter.hasLiveClient = () => true;

    const res = await VfarmConnector.getUnitStatus(
      'u1',
      { farm_id: FARM, unit_id: UNIT, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      makeIdentity(),
    );

    expect(res.text).toContain('Soil Moisture: 0%');
  });

  it('handles no readings (404) honestly', async () => {
    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    adapter.liveClient = {
      getLatestReading: async () => { throw { status: 404, message: 'No readings found for sensor' }; },
      ensureAdminToken: async () => 'tok',
    };
    adapter.hasLiveClient = () => true;

    const res = await VfarmConnector.getUnitStatus(
      'u1',
      { farm_id: FARM, unit_id: UNIT, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      makeIdentity(),
    );

    expect(res.text).toContain('No sensor readings are available');
    expect(res.text).not.toContain('null');
  });

  it('flags stale readings (older than 24 hours)', async () => {
    const reading = {
      sensor_id: 'rack2_dht',
      reading_ts: '2026-09-08T11:00:46Z',  // over a month old
      temperature_c: null,
      humidity_rh: null,
      values: {
        temperature: { unit: 'celsius', value: 28.3, status: 'ok' },
        humidity: { unit: 'percent_rh', value: 74, status: 'ok' },
      },
    };

    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    adapter.liveClient = {
      getLatestReading: async () => reading,
      ensureAdminToken: async () => 'tok',
    };
    adapter.hasLiveClient = () => true;

    const res = await VfarmConnector.getUnitStatus(
      'u1',
      { farm_id: FARM, unit_id: UNIT, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      makeIdentity(),
    );

    expect(res.text).toContain('Temperature: 28.3°C');
    expect(res.text).toContain('(reading is stale)');
  });

  it('handles upstream failure honestly (no fabricated values, no BHARAG fallback)', async () => {
    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    adapter.liveClient = {
      getLatestReading: async () => { throw new Error('upstream 503'); },
      ensureAdminToken: async () => 'tok',
    };
    adapter.hasLiveClient = () => true;

    const res = await VfarmConnector.getUnitStatus(
      'u1',
      { farm_id: FARM, unit_id: UNIT, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      makeIdentity(),
    );

    expect(res.text).not.toMatch(/\d+(\.\d+)?\s*°C/);
    expect(res.text).not.toContain('BHARAG');
    expect(res.telemetry?.status).toBe('telemetry_unavailable');
  });

  it('does not present CO as EC', async () => {
    const reading = {
      sensor_id: 'rack1_mq7',
      reading_ts: '2026-10-22T18:21:37Z',
      temperature_c: null,
      humidity_rh: null,
      values: {
        co: { unit: 'ppm', value: 0.69, status: 'ok' },
      },
    };

    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    adapter.liveClient = {
      getLatestReading: async () => reading,
      ensureAdminToken: async () => 'tok',
    };
    adapter.hasLiveClient = () => true;

    const res = await VfarmConnector.getUnitStatus(
      'u1',
      { farm_id: FARM, unit_id: UNIT, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      makeIdentity(),
    );

    expect(res.text).toContain('CO: 0.69');
    expect(res.text).not.toContain('EC:');
  });

  // ═══════════════════════════════════════════════════════════════════
  // listLatestReadings — per-farm unit readings endpoint exists but is NOT
  // called by VfarmConnector.getUnitStatus() when no specific unitId is known.
  // This gap means "Can you share the units?" returns farm-level aggregate
  // data instead of per-unit readings even when routed to vFarm.
  // ═══════════════════════════════════════════════════════════════════
  describe('listLatestReadings endpoint', () => {
    it('VfarmLiveClient.listLatestReadings lists devices then fetches per-device readings', async () => {
      const { VfarmLiveClient } = await import('../../engine/src/adapters/vfarm/live_client.js');
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/devices?farm_id=')) {
          return {
            ok: true,
            json: async () => ({
              devices: [
                { id: 'unit_bay_04', device_type: 'sensor' },
                { id: 'unit_bay_05', device_type: 'sensor' },
              ],
              total: 2,
              online_count: 2,
              offline_count: 0,
            }),
          } as Response;
        }
        if (url.includes('sensor_id=unit_bay_04')) {
          return {
            ok: true,
            json: async () => ({
              id: 1,
              sensor_id: 'unit_bay_04',
              reading_ts: '2026-10-27T10:00:00Z',
              received_at: '2026-10-27T10:00:01Z',
              temperature_c: null,
              humidity_rh: null,
              values: { temperature: { value: 28.3, unit: 'celsius', status: 'ok' } },
            }),
          } as Response;
        }
        if (url.includes('sensor_id=unit_bay_05')) {
          return {
            ok: true,
            json: async () => ({
              id: 2,
              sensor_id: 'unit_bay_05',
              reading_ts: '2026-10-27T10:00:00Z',
              received_at: '2026-10-27T10:00:01Z',
              temperature_c: null,
              humidity_rh: null,
              values: { temperature: { value: 26.1, unit: 'celsius', status: 'ok' } },
            }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      const client = new VfarmLiveClient({
        baseUrl: 'https://vfarm.bhanetwork.org',
        apiKey: 'test-key',
        fetchFn: fetchSpy as any,
      });

      const result = await client.listLatestReadings('farm_austin_main', 100);

      // First call: list devices for the farm
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://vfarm.bhanetwork.org/api/v1/devices?farm_id=farm_austin_main&limit=100',
        expect.anything()
      );
      // Then: fetch readings per device via latest endpoint
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://vfarm.bhanetwork.org/api/v1/readings/latest?sensor_id=unit_bay_04',
        expect.anything()
      );
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://vfarm.bhanetwork.org/api/v1/readings/latest?sensor_id=unit_bay_05',
        expect.anything()
      );
      expect(result).toHaveLength(2);
      expect(result[0].sensor_id).toBe('unit_bay_04');
      expect(result[1].sensor_id).toBe('unit_bay_05');
    });

    it('getUnitStatus with farmId but no unitId returns farm-level aggregate, NOT per-unit readings', async () => {
      const { CoreRegistry } = await import('../../engine/src/core/registry.js');
      const { DbClient } = await import('../../engine/src/db/client.js');
      const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
      DbClient.clearAll();
      CoreRegistry.resetToDefault();

      const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
      adapter.liveClient = {
        getFarmHealth: async () => ({ status: 'normal', health_score: 85 }),
        listAllDevices: async () => ({ total: 27, online_count: 19, offline_count: 6, unhealthy_count: 10 }),
        getLatestReading: async () => null,
        listLatestReadings: vi.fn(), // should NOT be called
        listOpenAlerts: async () => ({ alerts: [], total: 0 }),
      };
      adapter.hasLiveClient = () => true;

      const res = await VfarmConnector.getUnitStatus(
        'u1',
        { farm_id: 'farm_austin_main', unit_id: undefined, role: 'manager', granted_farms: ['farm_austin_main'] } as any,
        undefined,
        'status',
        makeIdentity(),
      );

      // Farm-level aggregate returned
      expect(res.text).toContain('Your farm has 27 devices');
      expect(res.text).toContain('27 devices');
      expect(res.text).toContain('19 are online');
      expect(res.text).toContain('6 are offline');
      expect(res.text).toContain('10 are unhealthy');
      // NOT per-unit readings
      expect(res.text).not.toContain('Temperature:');
      expect(res.text).not.toContain('unit_bay_04');
    });

    it('getUnitStatus now calls listLatestReadings(farmId) when no unitId is bound (per-unit readings path)', async () => {
      const { CoreRegistry } = await import('../../engine/src/core/registry.js');
      const { DbClient } = await import('../../engine/src/db/client.js');
      const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
      DbClient.clearAll();
      CoreRegistry.resetToDefault();

      const listLatestReadingsSpy = vi.fn().mockResolvedValue([]);
      const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
      adapter.liveClient = {
        getFarmHealth: async () => ({ status: 'normal' }),
        listAllDevices: async () => ({ total: 1, online_count: 1, offline_count: 0, unhealthy_count: 0 }),
        getLatestReading: async () => null,
        listLatestReadings: listLatestReadingsSpy,
        listOpenAlerts: async () => ({ alerts: [], total: 0 }),
      };
      adapter.hasLiveClient = () => true;

      await VfarmConnector.getUnitStatus(
        'u1',
        { farm_id: 'farm_austin_main', unit_id: undefined, role: 'manager', granted_farms: ['farm_austin_main'] } as any,
        undefined,
        'status',
        makeIdentity(),
      );

      // listLatestReadings IS now called — per-unit values are fetched
      expect(listLatestReadingsSpy).toHaveBeenCalledWith('farm_austin_main', 100, undefined, undefined, expect.any(String));
    });

    // ══════════════════════════════════════════════════════════════════
    // Per-unit readings via listLatestReadings (new path)
    // ══════════════════════════════════════════════════════════════════
    describe('Per-unit readings via listLatestReadings', () => {
      it('invokes listLatestReadings(farmId) when no unitId is bound and returns per-unit readings', async () => {
        const { CoreRegistry } = await import('../../engine/src/core/registry.js');
        const { DbClient } = await import('../../engine/src/db/client.js');
        const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
        DbClient.clearAll();
        CoreRegistry.resetToDefault();

        const listLatestReadingsSpy = vi.fn().mockResolvedValue([
          {
            sensor_id: 'unit_bay_04',
            reading_ts: '2026-10-27T10:00:00Z',
            received_at: '2026-10-27T10:00:00Z',
            values: {
              temperature: { value: 28.3, unit: 'celsius', status: 'ok' },
              humidity: { value: 65.0, unit: 'percent', status: 'ok' },
            },
          },
          {
            sensor_id: 'unit_bay_05',
            reading_ts: '2026-10-27T10:05:00Z',
            received_at: '2026-10-27T10:05:00Z',
            values: {
              temperature: { value: 26.1, unit: 'celsius', status: 'ok' },
              ph: { value: 6.8, unit: 'ph', status: 'ok' },
            },
          },
        ]);
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
        adapter.liveClient = {
          getFarmHealth: async () => ({ status: 'normal', health_score: 85 }),
          listAllDevices: async () => ({ total: 27, online_count: 19, offline_count: 6, unhealthy_count: 10 }),
          getLatestReading: async () => null,
          listLatestReadings: listLatestReadingsSpy,
          listOpenAlerts: async () => ({ alerts: [], total: 0 }),
        };
        adapter.hasLiveClient = () => true;

        const res = await VfarmConnector.getUnitStatus(
          'cust_001',
          { farm_id: 'farm_austin_main', unit_id: undefined, role: 'manager', granted_farms: ['farm_austin_main'] } as any,
          undefined,
          'status',
          makeIdentity(),
        );

        // listLatestReadings WAS called for the farm
        expect(listLatestReadingsSpy).toHaveBeenCalledWith('farm_austin_main', 100, undefined, undefined, expect.any(String));
        // Per-unit readings are included in the response
        expect(res.text).toContain('Per-unit readings:');
        expect(res.text).toContain('Unit unit_bay_04');
        expect(res.text).toContain('Unit unit_bay_05');
        expect(res.text).toContain('Temperature: 28.3°C');
        expect(res.text).toContain('Humidity: 65%');
        expect(res.text).toContain('pH: 6.8');
        // NOT just aggregate counts
        expect(res.text).not.toBe('I can share farm status, device counts and zones, but not per-unit readings for your number.');
      });

      it('returns honest no-readings response when listLatestReadings returns empty array', async () => {
        const { CoreRegistry } = await import('../../engine/src/core/registry.js');
        const { DbClient } = await import('../../engine/src/db/client.js');
        const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
        DbClient.clearAll();
        CoreRegistry.resetToDefault();

        const listLatestReadingsSpy = vi.fn().mockResolvedValue([]);
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
        adapter.liveClient = {
          getFarmHealth: async () => ({ status: 'normal' }),
          listAllDevices: async () => ({ total: 5, online_count: 5, offline_count: 0, unhealthy_count: 0 }),
          getLatestReading: async () => null,
          listLatestReadings: listLatestReadingsSpy,
          listOpenAlerts: async () => ({ alerts: [], total: 0 }),
        };
        adapter.hasLiveClient = () => true;

        const res = await VfarmConnector.getUnitStatus(
          'cust_002',
          { farm_id: 'farm_empty', unit_id: undefined, role: 'manager', granted_farms: ['farm_empty'] } as any,
          undefined,
          'status',
          makeIdentity({ farm_ids: ['farm_empty'] }),
        );

        expect(listLatestReadingsSpy).toHaveBeenCalledWith('farm_empty', 100, undefined, undefined, expect.any(String));
        expect(res.text).toContain('No per-unit readings are available at this time.');
      });

      it('marks stale readings as stale when timestamp is older than 24h', async () => {
        const { CoreRegistry } = await import('../../engine/src/core/registry.js');
        const { DbClient } = await import('../../engine/src/db/client.js');
        const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
        DbClient.clearAll();
        CoreRegistry.resetToDefault();

        const staleTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
        const listLatestReadingsSpy = vi.fn().mockResolvedValue([
          {
            sensor_id: 'unit_stale',
            reading_ts: staleTs,
            values: {
              temperature: { value: 20.0, unit: 'celsius', status: 'ok' },
            },
          },
        ]);
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
        adapter.liveClient = {
          getFarmHealth: async () => ({ status: 'normal' }),
          listAllDevices: async () => ({ total: 1, online_count: 1, offline_count: 0, unhealthy_count: 0 }),
          getLatestReading: async () => null,
          listLatestReadings: listLatestReadingsSpy,
          listOpenAlerts: async () => ({ alerts: [], total: 0 }),
        };
        adapter.hasLiveClient = () => true;

        const res = await VfarmConnector.getUnitStatus(
          'cust_003',
          { farm_id: 'farm_stale', unit_id: undefined, role: 'manager', granted_farms: ['farm_stale'] } as any,
          undefined,
          'status',
          makeIdentity({ farm_ids: ['farm_stale'] }),
        );

        expect(res.text).toContain('(reading is stale)');
        expect(res.text).toContain('Unit unit_stale');
      });

      it('handles missing/null values without treating them as zero', async () => {
        const { CoreRegistry } = await import('../../engine/src/core/registry.js');
        const { DbClient } = await import('../../engine/src/db/client.js');
        const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
        DbClient.clearAll();
        CoreRegistry.resetToDefault();

        const listLatestReadingsSpy = vi.fn().mockResolvedValue([
          {
            sensor_id: 'unit_partial',
            reading_ts: new Date().toISOString(),
            values: {
              temperature: { value: null, unit: 'celsius', status: 'ok' },
              humidity: { value: undefined, unit: 'percent', status: 'ok' },
            },
          },
        ]);
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
        adapter.liveClient = {
          getFarmHealth: async () => ({ status: 'normal' }),
          listAllDevices: async () => ({ total: 1, online_count: 1, offline_count: 0, unhealthy_count: 0 }),
          getLatestReading: async () => null,
          listLatestReadings: listLatestReadingsSpy,
          listOpenAlerts: async () => ({ alerts: [], total: 0 }),
        };
        adapter.hasLiveClient = () => true;

        const res = await VfarmConnector.getUnitStatus(
          'cust_004',
          { farm_id: 'farm_partial', unit_id: undefined, role: 'manager', granted_farms: ['farm_partial'] } as any,
          undefined,
          'status',
          makeIdentity({ farm_ids: ['farm_partial'] }),
        );

        // Missing/null values are not reported as readings
        expect(res.text).not.toContain('Temperature: null');
        expect(res.text).not.toContain('Humidity: undefined');
        // Unit still listed with its status
        expect(res.text).toContain('Unit unit_partial');
      });

      it('retains existing unit-specific path when unitId is bound (does not call listLatestReadings)', async () => {
        const { CoreRegistry } = await import('../../engine/src/core/registry.js');
        const { DbClient } = await import('../../engine/src/db/client.js');
        const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
        DbClient.clearAll();
        CoreRegistry.resetToDefault();

        const getLatestReadingSpy = vi.fn().mockResolvedValue({
          sensor_id: 'unit_bound_01',
          reading_ts: new Date().toISOString(),
          values: {
            temperature: { value: 24.5, unit: 'celsius', status: 'ok' },
          },
        });
        const listLatestReadingsSpy = vi.fn();
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
        adapter.liveClient = {
          getFarmHealth: async () => ({ status: 'normal' }),
          listAllDevices: async () => ({ total: 1, online_count: 1, offline_count: 0, unhealthy_count: 0 }),
          getLatestReading: getLatestReadingSpy,
          listLatestReadings: listLatestReadingsSpy,
          listOpenAlerts: async () => ({ alerts: [], total: 0 }),
        };
        adapter.hasLiveClient = () => true;

        const res = await VfarmConnector.getUnitStatus(
          'cust_005',
          { farm_id: 'farm_bound', unit_id: 'unit_bound_01', role: 'manager', granted_farms: ['farm_bound'] } as any,
          undefined,
          'status',
          makeIdentity({ farm_ids: ['farm_bound'] }),
        );

        // Unit-specific path is used (getLatestReading called, not listLatestReadings)
        expect(getLatestReadingSpy).toHaveBeenCalledWith('unit_bound_01');
        expect(listLatestReadingsSpy).not.toHaveBeenCalled();
        expect(res.text).toContain('vFarm Unit unit_bound_01');
        expect(res.text).toContain('Temperature: 24.5°C');
      });

      it('never falls back to BHARAG for telemetry when vFarm fails', async () => {
        const { CoreRegistry } = await import('../../engine/src/core/registry.js');
        const { DbClient } = await import('../../engine/src/db/client.js');
        const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
        DbClient.clearAll();
        CoreRegistry.resetToDefault();

        const listLatestReadingsSpy = vi.fn().mockRejectedValue(new Error('upstream timeout'));
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
        adapter.liveClient = {
          getFarmHealth: async () => ({ status: 'normal' }),
          listAllDevices: async () => ({ total: 5, online_count: 5, offline_count: 0, unhealthy_count: 0 }),
          getLatestReading: async () => null,
          listLatestReadings: listLatestReadingsSpy,
          listOpenAlerts: async () => ({ alerts: [], total: 0 }),
        };
        adapter.hasLiveClient = () => true;

        const res = await VfarmConnector.getUnitStatus(
          'cust_006',
          { farm_id: 'farm_fail', unit_id: undefined, role: 'manager', granted_farms: ['farm_fail'] } as any,
          undefined,
          'status',
          makeIdentity({ farm_ids: ['farm_fail'] }),
        );

        // Farm-level aggregate is still reported
        expect(res.text).toContain('Your farm has');
        // Per-unit readings failure is noted honestly
        expect(res.text).toContain('No per-unit readings are available at this time.');
        // No BHARAG reference anywhere
        expect(res.text).not.toContain('BHARAG');
        expect(res.text).not.toContain('knowledge');
      });

      it('handles malformed readings entries gracefully (skips invalid entries)', async () => {
        const { CoreRegistry } = await import('../../engine/src/core/registry.js');
        const { DbClient } = await import('../../engine/src/db/client.js');
        const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
        DbClient.clearAll();
        CoreRegistry.resetToDefault();

        const listLatestReadingsSpy = vi.fn().mockResolvedValue([
          null, // invalid entry
          { sensor_id: 'unit_valid', reading_ts: new Date().toISOString(), values: { temperature: { value: 22.0, unit: 'celsius', status: 'ok' } } },
          { no_sensor_id_here: 'bad' }, // invalid entry
        ]);
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
        adapter.liveClient = {
          getFarmHealth: async () => ({ status: 'normal' }),
          listAllDevices: async () => ({ total: 3, online_count: 3, offline_count: 0, unhealthy_count: 0 }),
          getLatestReading: async () => null,
          listLatestReadings: listLatestReadingsSpy,
          listOpenAlerts: async () => ({ alerts: [], total: 0 }),
        };
        adapter.hasLiveClient = () => true;

        const res = await VfarmConnector.getUnitStatus(
          'cust_007',
          { farm_id: 'farm_mixed', unit_id: undefined, role: 'manager', granted_farms: ['farm_mixed'] } as any,
          undefined,
          'status',
          makeIdentity({ farm_ids: ['farm_mixed'] }),
        );

        // Valid entry is included
        expect(res.text).toContain('Unit unit_valid');
        expect(res.text).toContain('Temperature: 22°C');
        // Invalid entries are skipped, not crashed
        expect(res.text).toContain('Your farm has');
      });
    });
  });
});
