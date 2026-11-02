/**
 * Regression tests for vFarm per-sensor failure classification.
 *
 * Production logs showed HTTP 422 (using farm_id), HTTP 404 (sensor with no
 * readings), and timeouts for various sensors. The `listLatestReadings`
 * method must classify each per-sensor failure rather than silently swallowing
 * all errors as "skip".
 *
 * These tests verify:
 * - 404 responses are classified as `no_reading` (legitimate)
 * - 401/403 responses are classified as `unauthorized`
 * - 422 responses are classified as `invalid_request`
 * - 5xx responses are classified as `upstream_error`
 * - Timeouts are classified as `timeout`
 * - Successful readings are returned normally
 * - Bounded concurrency is maintained (5 at a time)
 * - Partial results still return when some sensors fail
 *
 * No live API calls. No customer data.
 */
import { describe, it, expect, vi } from 'vitest';
import { VfarmLiveClient, VfarmHttpError, VfarmNetworkError } from '../../engine/src/adapters/vfarm/live_client.js';
import { Logger } from '../../engine/src/config/logger.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function mockFetchForDevicesAndReadings(
  responses: Map<string, Response>,
): any {
  return vi.fn(async (url: string) => {
    if (url.includes('/api/v1/devices?farm_id')) {
      return jsonResponse(200, { devices: [{ id: 'sensor_1', device_type: 'sensor' }, { id: 'sensor_2', device_type: 'sensor' }, { id: 'sensor_3', device_type: 'sensor' }] });
    }
    for (const [sensorId, response] of responses) {
      if (url.includes(`/api/v1/readings/latest?sensor_id=${sensorId}`)) {
        return response;
      }
    }
    return jsonResponse(404, { error: 'No readings found for sensor' });
  });
}

function findLogEntry(spy: ReturnType<typeof vi.spyOn>, category: string, sensorId: string) {
  return spy.mock.calls.find((call) => {
    // Logger methods are called with (message, meta). The meta is the second argument.
    const meta = call[1];
    if (meta && typeof meta === 'object') {
      return meta.category === category && meta.sensor_id === sensorId;
    }
    return false;
  });
}

describe('VfarmLiveClient.listLatestReadings — per-sensor failure classification', () => {
  const baseUrl = 'https://mock.vfarm.test';
  const apiKey = 'test-farm-key';

  it('returns successful readings and skips sensors with no readings (404)', async () => {
    const fetchFn = mockFetchForDevicesAndReadings(
      new Map([
        ['sensor_1', jsonResponse(200, { sensor_id: 'sensor_1', temperature_c: 22.5, values: { temperature: { value: 22.5 } } })],
        ['sensor_2', jsonResponse(404, { error: 'No readings found for sensor' })],
        ['sensor_3', jsonResponse(200, { sensor_id: 'sensor_3', values: { ph: { value: 6.2 } } })],
      ]),
    );

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: fetchFn as any });

    const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});

    const results = await client.listLatestReadings('test_farm');

    // Should return only the 2 successful readings
    expect(results).toHaveLength(2);
    expect(results[0].sensor_id).toBe('sensor_1');
    expect(results[1].sensor_id).toBe('sensor_3');

    // Should log 404 as info with no_reading category
    const noReadingLog = findLogEntry(infoSpy, 'no_reading', 'sensor_2');
    expect(noReadingLog).toBeDefined();

    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('classifies 401/403 as unauthorized (not upstream_error)', async () => {
    const fetchFn = mockFetchForDevicesAndReadings(
      new Map([
        ['sensor_1', jsonResponse(401, { error: 'Unauthorized' })],
      ]),
    );

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: fetchFn as any });
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    const results = await client.listLatestReadings('test_farm');

    // Sensor failed, no results returned
    expect(results).toHaveLength(0);

    // Should log as unauthorized category
    const unauthorizedLog = findLogEntry(warnSpy, 'unauthorized', 'sensor_1');
    expect(unauthorizedLog).toBeDefined();

    warnSpy.mockRestore();
  });

  it('classifies 422 as invalid_request (not upstream_error)', async () => {
    const fetchFn = mockFetchForDevicesAndReadings(
      new Map([
        ['sensor_1', jsonResponse(422, { error: 'validation_error', detail: 'Field required' })],
      ]),
    );

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: fetchFn as any });
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});

    const results = await client.listLatestReadings('test_farm');

    // Sensor failed validation, no results returned
    expect(results).toHaveLength(0);

    // 422 should be logged as error level with invalid_request category
    const invalidRequestLog = findLogEntry(errorSpy, 'invalid_request', 'sensor_1');
    expect(invalidRequestLog).toBeDefined();

    errorSpy.mockRestore();
  });

  it('classifies 5xx as upstream_error', async () => {
    const fetchFn = mockFetchForDevicesAndReadings(
      new Map([
        ['sensor_1', jsonResponse(503, { error: 'Service Unavailable' })],
      ]),
    );

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: fetchFn as any });
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    const results = await client.listLatestReadings('test_farm');

    expect(results).toHaveLength(0);

    // 503 should be logged as upstream_error
    const upstreamLog = findLogEntry(warnSpy, 'upstream_error', 'sensor_1');
    expect(upstreamLog).toBeDefined();

    warnSpy.mockRestore();
  });

  it('classifies timeout as timeout category (not upstream_error)', async () => {
    const timeoutFetch = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/devices?farm_id')) {
        return jsonResponse(200, { devices: [{ id: 'sensor_timeout', device_type: 'sensor' }] });
      }
      if (url.includes('/api/v1/readings/latest?sensor_id=sensor_timeout')) {
        // Simulate a network error with timeout in message
        throw new VfarmNetworkError('vFarm request timed out after 5000ms: /api/v1/readings/latest');
      }
      return jsonResponse(404, {});
    });

    const client = new VfarmLiveClient({ baseUrl, apiKey, timeoutMs: 100, fetchFn: timeoutFetch as any });
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    const results = await client.listLatestReadings('test_farm');

    expect(results).toHaveLength(0);

    // Should be logged as timeout category
    const timeoutLog = findLogEntry(warnSpy, 'timeout', 'sensor_timeout');
    expect(timeoutLog).toBeDefined();

    warnSpy.mockRestore();
  });

  it('returns partial results when some sensors succeed and others fail', async () => {
    const fetchFn = mockFetchForDevicesAndReadings(
      new Map([
        ['sensor_1', jsonResponse(200, { sensor_id: 'sensor_1', values: { temperature: { value: 22.5 } } })],
        ['sensor_2', jsonResponse(404, { error: 'No readings found for sensor' })],
        ['sensor_3', jsonResponse(500, { error: 'Internal server error' })],
      ]),
    );

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: fetchFn as any });
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {});

    const results = await client.listLatestReadings('test_farm');

    // Only sensor_1 should return successfully
    expect(results).toHaveLength(1);
    expect(results[0].sensor_id).toBe('sensor_1');

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('uses bounded concurrency (5 at a time) for per-sensor fetches', async () => {
    // Create 10 devices
    const devices: any[] = [];
    for (let i = 0; i < 10; i++) {
      devices.push({ id: `sensor_${i}`, device_type: 'sensor' });
    }

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const trackConcurrency = async (url: string) => {
      if (url.includes('/api/v1/readings/latest')) {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
        return jsonResponse(200, { sensor_id: url.match(/sensor_id=(\w+)/)?.[1] || 'unknown' });
      }
      if (url.includes('/api/v1/devices')) {
        return jsonResponse(200, { devices });
      }
      return jsonResponse(404, {});
    };

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: trackConcurrency as any });

    await client.listLatestReadings('test_farm');

    // Concurrency should not exceed 5 (the CONCURRENCY constant)
    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(maxConcurrent).toBeGreaterThan(0);
  });

  it('returns empty array when farm has no devices', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/devices')) {
        return jsonResponse(200, { devices: [] });
      }
      return jsonResponse(404, {});
    });

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: fetchFn as any });

    const results = await client.listLatestReadings('test_farm');
    expect(results).toHaveLength(0);
    // Should not have called the readings endpoint
    expect(fetchFn.mock.calls.filter((c) => c[0].includes('/readings/latest'))).toHaveLength(0);
  });
});
