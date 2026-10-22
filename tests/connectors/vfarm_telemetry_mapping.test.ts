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
import { describe, it, expect } from 'vitest';
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
});
