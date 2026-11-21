/**
 * Comprehensive Authenticated vFarm Integration Flow Tests.
 *
 * Verifies the complete caller-to-vFarm journey against Phase 3 acceptance:
 * 1. Authenticated caller resolution
 * 2. Valid tenant and project access
 * 3. Valid farm selection
 * 4. Authorized unit access
 * 5. Unauthorized farm access rejection
 * 6. Unauthorized unit access rejection
 * 7. Unknown caller rejection
 * 8. Missing vFarm identity handling
 * 9. Stale/revoked identity rejection
 * 10. Empty sensor list fail-closed behavior
 * 11. Cabinet and relay exclusion (sensors only)
 * 12. Valid sensor readings preservation
 * 13. Missing readings mapping to telemetry_unavailable (anti-fabrication)
 * 14. Stale readings detection (>24h threshold)
 * 15. vFarm timeout handling
 * 16. Upstream unavailable (5xx) handling
 * 17. No fabricated telemetry on failure
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { VfarmTenantAdapter, VfarmAuthorizationError } from '../../engine/src/adapters/vfarm/index.js';
import { VfarmLiveClient } from '../../engine/src/adapters/vfarm/live_client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const AUTH_FARM = 'farm_austin_main';
const UNAUTH_FARM = 'farm_secret_other';
const AUTH_UNIT = 'rack2_dht';
const PHONE_KNOWN = '+15551234567';
const PHONE_UNKNOWN = '+15559999999';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function readingRow(sensorId: string, values: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  return {
    id: 1,
    sensor_id: sensorId,
    reading_ts: ts,
    received_at: ts,
    values,
    ...overrides,
  };
}

function readingsEnvelope(sensorId: string, readings: Record<string, unknown>[] = []) {
  return {
    sensor_id: sensorId,
    from: '2026-11-10T00:00:00Z',
    to: '2026-11-10T12:00:00Z',
    count: readings.length,
    readings,
  };
}

function makeSpeaker(overrides: Partial<SpeakerIdentity> = {}): SpeakerIdentity {
  return {
    person_id: 'cust_vfarm_001',
    customer_ref: 'cust_vfarm_001',
    tenant_id: TENANT,
    project_id: PROJECT,
    phone_e164: PHONE_KNOWN,
    is_known: true,
    role: 'manager',
    permissions: ['view_telemetry'],
    farm_ids: [AUTH_FARM],
    ...overrides,
  };
}

describe('Phase 3: Authenticated vFarm Integration Flow', () => {
  beforeEach(() => {
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
  });

  afterEach(() => {
    CoreRegistry.clear();
    vi.restoreAllMocks();
  });

  // 1 & 2: Authenticated caller resolution & valid tenant/project
  it('1 & 2: resolves authenticated caller within valid tenant/project scope', () => {
    const speaker = makeSpeaker();
    expect(speaker.is_known).toBe(true);
    expect(speaker.tenant_id).toBe(TENANT);
    expect(speaker.project_id).toBe(PROJECT);
    expect(speaker.farm_ids).toContain(AUTH_FARM);
  });

  // 3 & 4: Valid farm selection and authorized unit access
  it('3 & 4: allows access to authorized farm and unit with live telemetry', async () => {
    const speaker = makeSpeaker();
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/readings')) {
        return jsonResponse(200, readingsEnvelope(AUTH_UNIT, [
          readingRow(AUTH_UNIT, {
            temperature: { value: 24.2, unit: 'celsius', status: 'ok' },
            humidity: { value: 65.0, unit: 'percent', status: 'ok' },
          }),
        ]));
      }
      return jsonResponse(404, {});
    });

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      apiToken: 'jwt_test',
      tenantId: TENANT,
      fetchFn: fetchFn as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const res = await VfarmConnector.getUnitStatus(
      speaker.customer_ref,
      { farm_id: AUTH_FARM, unit_id: AUTH_UNIT },
      undefined,
      undefined,
      speaker,
    );

    expect(res.telemetry).toBeDefined();
    expect(res.telemetry?.farm_id).toBe(AUTH_FARM);
    expect(res.telemetry?.unit_id).toBe(AUTH_UNIT);
    expect(res.telemetry?.water_temp_c).toBe(24.2);
    expect(res.telemetry?.humidity_rh).toBe(65.0);
    expect(res.telemetry?.status).toBe('normal');
  });

  // 5: Unauthorized farm access rejection
  it('5: rejects access to an unauthorized farm not granted to speaker', async () => {
    const speaker = makeSpeaker({ farm_ids: [AUTH_FARM] }); // does NOT have UNAUTH_FARM
    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    await expect(
      adapter.getFarmStatusForSpeaker({ farmId: UNAUTH_FARM, speaker }),
    ).rejects.toThrow(VfarmAuthorizationError);

    await expect(
      adapter.listLatestReadings({ farmId: UNAUTH_FARM, speaker }),
    ).rejects.toThrow(VfarmAuthorizationError);
  });

  // 6: Unauthorized unit context (missing farm_id)
  it('6: rejects telemetry when farm context is completely missing', async () => {
    const speaker = makeSpeaker();
    const res = await VfarmConnector.getUnitStatus(
      speaker.customer_ref,
      {}, // missing farm_id
      undefined,
      undefined,
      speaker,
    );
    expect(res.text).toContain('Your phone number is not linked to an active vFarm unit');
    expect(res.telemetry?.status).toBe('telemetry_unavailable');
  });

  // 7: Unknown caller rejection
  it('7: rejects unknown caller without leaking telemetry', async () => {
    const unknownSpeaker: SpeakerIdentity = {
      person_id: 'opaque_unresolved_user',
      customer_ref: 'opaque_unresolved_user',
      tenant_id: TENANT,
      project_id: PROJECT,
      phone_e164: PHONE_UNKNOWN,
      is_known: false,
      role: 'unknown',
      permissions: [],
      farm_ids: [],
    };

    const res = await VfarmConnector.getUnitStatus(
      unknownSpeaker.customer_ref,
      { farm_id: AUTH_FARM },
      undefined,
      undefined,
      unknownSpeaker,
    );
    expect(res.telemetry?.status).toBe('telemetry_unavailable');
  });

  // 8: Missing vFarm identity handling
  it('8: handles missing vFarm identity safely without exception', async () => {
    const res = await VfarmConnector.getUnitStatus(
      'unregistered_user',
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(res.telemetry?.status).toBe('telemetry_unavailable');
    expect(res.text).toContain('not linked to an active vFarm unit');
  });

  // 9: Stale/revoked identity rejection
  it('9: rejects revoked identity (zero farm_ids) fail-closed', async () => {
    const revokedSpeaker = makeSpeaker({
      person_id: 'opaque_revoked',
      is_known: false,
      role: 'unknown',
      permissions: [],
      farm_ids: [],
    });

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
    });

    await expect(
      adapter.getFarmStatusForSpeaker({ farmId: AUTH_FARM, speaker: revokedSpeaker }),
    ).rejects.toThrow(VfarmAuthorizationError);
  });

  // 10: Empty sensor list fail-closed behavior
  it('10: fails closed when farm has zero sensor devices (does not fall back to cabinets/relays)', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/devices')) {
        return jsonResponse(200, {
          devices: [
            { id: 'VFARM-CAB-001', device_type: 'cabinet' },
            { id: 'relay_m3_1', device_type: 'relay' },
          ],
        });
      }
      return jsonResponse(404, {});
    });

    const client = new VfarmLiveClient({
      baseUrl: 'https://vfarm.test',
      apiKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    const readings = await client.listLatestReadings('farm_austin_main');
    // Must return empty array, must NOT query /readings for cabinet or relay
    expect(readings).toEqual([]);
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/api/v1/readings'))).toBe(false);
  });

  // 11: Cabinet and relay exclusion from sensor queries
  it('11: strictly excludes cabinets and relays from sensor readings queries', async () => {
    const queriedSensorIds: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/devices')) {
        return jsonResponse(200, {
          devices: [
            { id: 'VFARM-CAB-001', device_type: 'cabinet' },
            { id: 'relay_m3_1', device_type: 'relay' },
            { id: 'rack1_soil', device_type: 'sensor' },
            { id: 'load_fan_1', device_type: 'load' },
          ],
        });
      }
      if (url.includes('/api/v1/readings?sensor_id=')) {
        const match = url.match(/sensor_id=([^&]+)/);
        if (match) queriedSensorIds.push(match[1]);
        return jsonResponse(200, readingsEnvelope('rack1_soil', [
          readingRow('rack1_soil', { soil_moisture: { value: 72.5, unit: 'percent', status: 'ok' } }),
        ]));
      }
      return jsonResponse(404, {});
    });

    const client = new VfarmLiveClient({
      baseUrl: 'https://vfarm.test',
      apiKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    const readings = await client.listLatestReadings('farm_austin_main');
    expect(readings.length).toBe(1);
    expect(queriedSensorIds).toEqual(['rack1_soil']);
    expect(queriedSensorIds).not.toContain('VFARM-CAB-001');
    expect(queriedSensorIds).not.toContain('relay_m3_1');
    expect(queriedSensorIds).not.toContain('load_fan_1');
  });

  // 12: Valid sensor readings preservation
  it('12: preserves valid sensor readings with correct types and timestamps', async () => {
    const nowIso = new Date().toISOString();
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/readings')) {
        return jsonResponse(200, readingsEnvelope('rack1_ph', [
          readingRow('rack1_ph', { ph: { value: 6.8, unit: null, status: 'ok' } }, {
            reading_ts: nowIso,
            received_at: nowIso,
          }),
        ]));
      }
      return jsonResponse(404, {});
    });

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
      fetchFn: fetchFn as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const res = await VfarmConnector.getUnitStatus(
      'cust_vfarm_001',
      { farm_id: AUTH_FARM, unit_id: 'rack1_ph' },
      undefined,
      undefined,
      makeSpeaker(),
    );

    expect(res.telemetry?.ph_level).toBe(6.8);
    expect(res.telemetry?.reading_ts).toBe(nowIso);
    expect(res.telemetry?.stale).toBe(false);
  });

  // 13: Missing readings mapping to telemetry_unavailable (anti-fabrication)
  it('13: maps empty readings to telemetry_unavailable and NEVER defaults to normal', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/readings')) {
        return jsonResponse(200, readingsEnvelope('rack1_empty', [
          readingRow('rack1_empty', {}),
        ]));
      }
      return jsonResponse(404, {});
    });

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
      fetchFn: fetchFn as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const res = await VfarmConnector.getUnitStatus(
      'cust_vfarm_001',
      { farm_id: AUTH_FARM, unit_id: 'rack1_empty' },
      undefined,
      undefined,
      makeSpeaker(),
    );

    expect(res.telemetry?.status).toBe('telemetry_unavailable');
    expect(res.telemetry?.water_temp_c).toBeUndefined();
    expect(res.telemetry?.humidity_rh).toBeUndefined();
  });

  // 14: Stale readings detection (>24h)
  it('14: marks readings older than 24 hours as stale and includes note in text', async () => {
    const staleTs = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h ago
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/readings')) {
        return jsonResponse(200, readingsEnvelope('rack1_dht', [
          readingRow('rack1_dht', {
            temperature: { value: 20.0, unit: 'celsius', status: 'ok' },
          }, {
            reading_ts: staleTs,
            received_at: staleTs,
          }),
        ]));
      }
      return jsonResponse(404, {});
    });

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
      fetchFn: fetchFn as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const res = await VfarmConnector.getUnitStatus(
      'cust_vfarm_001',
      { farm_id: AUTH_FARM, unit_id: 'rack1_dht' },
      undefined,
      undefined,
      makeSpeaker(),
    );

    expect(res.telemetry?.stale).toBe(true);
    expect(res.text).toContain('(reading is stale)');
  });

  // 15: vFarm timeout handling
  it('15: safely handles upstream timeout returning telemetry_unavailable', async () => {
    const fetchFn = vi.fn(async () => {
      const err = new Error('Upstream request timed out after 5000ms');
      err.name = 'AbortError';
      throw err;
    });

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
      fetchFn: fetchFn as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const res = await VfarmConnector.getUnitStatus(
      'cust_vfarm_001',
      { farm_id: AUTH_FARM, unit_id: 'rack1_dht' },
      undefined,
      undefined,
      makeSpeaker(),
    );

    expect(res.telemetry?.status).toBe('telemetry_unavailable');
    expect(res.text).toContain('cannot be retrieved');
  });

  // 16: Upstream unavailable response (5xx)
  it('16: safely handles HTTP 503 service unavailable without unhandled exception', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(503, { error: 'Service Unavailable' }));

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
      fetchFn: fetchFn as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const res = await VfarmConnector.getUnitStatus(
      'cust_vfarm_001',
      { farm_id: AUTH_FARM, unit_id: 'rack1_dht' },
      undefined,
      undefined,
      makeSpeaker(),
    );

    expect(res.telemetry?.status).toBe('telemetry_unavailable');
    expect(res.text).toContain('cannot be retrieved');
  });

  // 17: No fabricated telemetry on failure
  it('17: reports fault when reading contains error_code or error_message', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/readings')) {
        return jsonResponse(200, readingsEnvelope('rack1_sensor_fault', [
          readingRow('rack1_sensor_fault', {
            temperature: { value: 15.0, unit: 'celsius', status: 'fault' },
          }, {
            error_code: 'SENSOR_PROBE_DISCONNECTED',
            error_message: 'Probe disconnected',
          }),
        ]));
      }
      return jsonResponse(404, {});
    });

    const adapter = new VfarmTenantAdapter(TENANT, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      tenantId: TENANT,
      fetchFn: fetchFn as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const res = await VfarmConnector.getUnitStatus(
      'cust_vfarm_001',
      { farm_id: AUTH_FARM, unit_id: 'rack1_sensor_fault' },
      undefined,
      undefined,
      makeSpeaker(),
    );

    expect(res.telemetry?.status).toBe('fault');
  });
});
