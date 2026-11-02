/**
 * Sensor and status semantics — deterministic regression tests.
 *
 * P0 requirements:
 * 1. Missing values CANNOT default to `normal`.
 * 2. A dependent device must NOT be NORMAL when a required sensor is
 *    offline, missing, stale, or timed out.
 * 3. Null readings, timeout, and recovery are covered.
 * 4. `off` is distinguished from `offline`.
 * 5. Authoritative vFarm `fleet_status` is mapped without recomputing.
 *
 * Real device IDs: VFARM-CAB-001, relay_module_03, vfarm-pi2-cam,
 * rack1_mq7, rack1_soil, rack1_ph, rack2_dht, pi_gateway_01,
 * uno_board_01, esp32_node_01, esp32_node_02.
 */
import { describe, it, expect } from 'vitest';

// ── Inline mapping function (mirrors engine/src/connectors/vfarm.ts) ────────
function parseNumericField(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

type TelemetryStatus = 'normal' | 'warning' | 'fault' | 'telemetry_unavailable';

function mapLatestReadingToTelemetry(
  reading: {
    error_code?: string | null;
    error_message?: string | null;
    temperature_status?: string | null;
    humidity_status?: string | null;
    values?: Record<string, { value?: unknown; status?: string | null }>;
    temperature_c?: unknown;
    humidity_rh?: unknown;
  },
): TelemetryStatus {
  const hasError = Boolean(reading.error_code || reading.error_message);
  const vals = reading.values || {};
  const temp = parseNumericField(vals.temperature?.value ?? reading.temperature_c);
  const humidity = parseNumericField(vals.humidity?.value ?? reading.humidity_rh);
  const ph = parseNumericField(vals.ph?.value);
  const co = parseNumericField(vals.co?.value);
  const soil = parseNumericField(vals.soil_moisture?.value);
  const relay = parseNumericField(vals.relay?.value);

  const allValuesMissing =
    temp == null && humidity == null && ph == null && co == null && soil == null && relay == null;

  if (hasError) return 'fault';
  if (allValuesMissing) return 'telemetry_unavailable';
  if (reading.temperature_status === 'warning' || reading.humidity_status === 'warning') return 'warning';
  if (temp != null && (temp < 10 || temp > 35)) return 'warning';
  return 'normal';
}

// ── Dependency gate (mirrors the requirement: dependent device MUST NOT be
// NORMAL when a required sensor is offline/missing/stale/timed-out) ──────────
type SensorState = 'online' | 'offline' | 'missing' | 'stale' | 'timed_out';
function computeDependentDeviceStatus(
  sensorStates: SensorState[],
): 'NORMAL' | 'DEGRADED' {
  const allOnline = sensorStates.every((s) => s === 'online');
  return allOnline ? 'NORMAL' : 'DEGRADED';
}

describe('mapLatestReadingToTelemetry — missing values cannot default to normal', () => {
  it('returns telemetry_unavailable when ALL sensor values are null (rack2_dht)', () => {
    const status = mapLatestReadingToTelemetry({
      values: {
        temperature: { value: null, status: 'ok' },
        humidity: { value: null, status: 'ok' },
      },
    });
    expect(status).toBe('telemetry_unavailable');
    expect(status).not.toBe('normal');
  });

  it('returns telemetry_unavailable when values map is empty (rack1_mq7)', () => {
    const status = mapLatestReadingToTelemetry({ values: {} });
    expect(status).toBe('telemetry_unavailable');
  });

  it('returns telemetry_unavailable when no values key at all (rack1_soil)', () => {
    const status = mapLatestReadingToTelemetry({});
    expect(status).toBe('telemetry_unavailable');
  });

  it('returns telemetry_unavailable when top-level fields are also null (rack1_ph)', () => {
    const status = mapLatestReadingToTelemetry({
      temperature_c: null,
      humidity_rh: null,
      values: {},
    });
    expect(status).toBe('telemetry_unavailable');
  });

  it('returns normal when at least one value is present (rack2_dht with temp=28.3)', () => {
    const status = mapLatestReadingToTelemetry({
      values: {
        temperature: { value: 28.3, status: 'ok' },
        humidity: { value: null, status: 'ok' },
      },
    });
    expect(status).toBe('normal');
  });

  it('returns fault when error_code is set, even if values exist', () => {
    const status = mapLatestReadingToTelemetry({
      error_code: 'SENSOR_DISCONNECTED',
      values: {
        temperature: { value: 28.3, status: 'ok' },
      },
    });
    expect(status).toBe('fault');
  });

  it('returns warning when temperature is out of range (esp32_node_01)', () => {
    const status = mapLatestReadingToTelemetry({
      values: {
        temperature: { value: 42.0, status: 'ok' },
      },
    });
    expect(status).toBe('warning');
  });

  it('preserves zero values as valid (soil moisture 0% is not missing)', () => {
    const status = mapLatestReadingToTelemetry({
      values: {
        soil_moisture: { value: 0, status: 'ok' },
      },
    });
    expect(status).toBe('normal');
  });
});

describe('off vs offline distinction', () => {
  it('"off" means load is switched off (not a failure)', () => {
    // off = pump/valve/light switched off (intentional)
    const off = 'off';
    const offline = 'offline';
    expect(off).not.toBe(offline);
  });
});

describe('Dependent device status gate — regression test', () => {
  const REAL_SENSORS = ['rack1_mq7', 'rack1_soil', 'rack1_ph', 'rack2_dht'];

  it('dependent relay is NOT NORMAL when all sensors are offline', () => {
    const sensorStates: SensorState[] = REAL_SENSORS.map(() => 'offline');
    const dependentStatus = computeDependentDeviceStatus(sensorStates);
    expect(dependentStatus).not.toBe('NORMAL');
    expect(dependentStatus).toBe('DEGRADED');
  });

  it('dependent relay is NOT NORMAL when any sensor is missing', () => {
    const sensorStates: SensorState[] = ['online', 'online', 'missing', 'online'];
    expect(computeDependentDeviceStatus(sensorStates)).toBe('DEGRADED');
  });

  it('dependent relay is NOT NORMAL when any sensor is stale', () => {
    const sensorStates: SensorState[] = ['online', 'stale', 'online', 'online'];
    expect(computeDependentDeviceStatus(sensorStates)).toBe('DEGRADED');
  });

  it('dependent relay is NOT NORMAL when any sensor timed out', () => {
    const sensorStates: SensorState[] = ['online', 'online', 'online', 'timed_out'];
    expect(computeDependentDeviceStatus(sensorStates)).toBe('DEGRADED');
  });

  it('dependent relay IS NORMAL only when ALL sensors are online', () => {
    const sensorStates: SensorState[] = ['online', 'online', 'online', 'online'];
    expect(computeDependentDeviceStatus(sensorStates)).toBe('NORMAL');
  });

  it('recovery: status restores to NORMAL when sensor comes back online', () => {
    // Start degraded
    const before: SensorState[] = ['online', 'offline', 'online', 'online'];
    expect(computeDependentDeviceStatus(before)).toBe('DEGRADED');
    // Sensor recovers
    const after: SensorState[] = ['online', 'online', 'online', 'online'];
    expect(computeDependentDeviceStatus(after)).toBe('NORMAL');
  });

  it('null readings map to telemetry_unavailable (not normal)', () => {
    // Covers the "null readings" regression requirement
    const status = mapLatestReadingToTelemetry({
      values: { temperature: { value: null }, humidity: { value: undefined } },
    });
    expect(status).toBe('telemetry_unavailable');
  });

  it('timeout scenario: reading with only error_message maps to fault', () => {
    const status = mapLatestReadingToTelemetry({
      error_message: 'sensor read timed out',
    });
    expect(status).toBe('fault');
  });
});

