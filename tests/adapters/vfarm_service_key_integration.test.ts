import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VfarmLiveClient, VfarmAuthError, VfarmNetworkError } from '../../engine/src/adapters/vfarm/live_client.js';
import { VfarmHttpClient, VfarmApiError } from '../../engine/src/adapters/vfarm/http_client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { assertSpeakerFarmAccess, VfarmAuthorizationError } from '../../engine/src/adapters/vfarm/authorization.js';
import { Logger } from '../../engine/src/config/logger.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

function jsonResponse(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('vFarm Service Key Integration (12 Scenarios)', () => {
  const baseUrl = 'https://vfarm.bhanetwork.org';
  const testServiceKey = 'vfk_test_secret_key_xyz_987654321';
  const testFarmId = 'farm_austin_001';

  let logSpy: {
    info: any;
    warn: any;
    error: any;
    infra: any;
  };

  beforeEach(() => {
    logSpy = {
      info: vi.spyOn(Logger, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(Logger, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(Logger, 'error').mockImplementation(() => {}),
      infra: vi.spyOn(Logger, 'infra').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Scenario 1: Valid service key sends X-Service-Key and X-Farm-Key
  it('1. valid service key sends X-Service-Key and X-Farm-Key on requests', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return jsonResponse(200, {
        farm_id: testFarmId,
        status: 'healthy',
        score: 95,
        updated_at: '2026-11-20T00:00:00Z',
      });
    });

    const client = new VfarmLiveClient({
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    await client.getFarmHealth(testFarmId);

    expect(capturedHeaders['X-Service-Key']).toBe(testServiceKey);
    expect(capturedHeaders['X-Farm-Key']).toBe(testServiceKey);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Scenario 2: Missing service key / farm key fails safely with configuration error
  it('2. missing service key / farm key fails safely with configuration error', async () => {
    const mockFetch = vi.fn();
    const client = new VfarmLiveClient({
      baseUrl,
      fetchFn: mockFetch as any,
    });

    await expect(client.getFarmHealth(testFarmId)).rejects.toThrow(
      /Configuration error: VFARM_SERVICE_KEY/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Scenario 3: Invalid service key / upstream 401 handled safely
  it('3. invalid service key / upstream 401 handled safely without leaking credentials', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse(401, { error: 'unauthorized', detail: 'Invalid service key' }),
    );

    const client = new VfarmLiveClient({
      baseUrl,
      serviceKey: 'vfk_invalid_dummy_key',
      fetchFn: mockFetch as any,
    });

    await expect(client.getFarmHealth(testFarmId)).rejects.toThrow(VfarmAuthError);
  });

  // Scenario 4: Valid customer resolution returns authoritative vFarm user ID
  it('4. valid customer resolution returns authoritative vFarm user ID', async () => {
    const mockFetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/users/resolve')) {
        return jsonResponse(200, {
          user_id: 'usr_authoritative_vfarm_99',
          role: 'manager',
          farm_ids: [testFarmId],
          org_id: 'org_austin_main',
        });
      }
      return jsonResponse(404, {});
    });

    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    const identity = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj_main',
      phoneE164: '+15551234567',
    });

    expect(identity.is_known).toBe(true);
    expect(identity.person_id).toBe('usr_authoritative_vfarm_99');
    expect(identity.role).toBe('manager');
    expect(identity.farm_ids).toContain(testFarmId);
  });

  // Scenario 5: Acting-user request sends X-On-Behalf-Of: <user_id>
  it('5. acting-user request sends X-On-Behalf-Of header with person_id', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return jsonResponse(200, {
        farm_id: testFarmId,
        status: 'healthy',
        score: 95,
        updated_at: '2026-11-20T00:00:00Z',
      });
    });

    const client = new VfarmLiveClient({
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    await client.getFarmHealth(testFarmId, 'usr_acting_customer_42');

    expect(capturedHeaders['X-Service-Key']).toBe(testServiceKey);
    expect(capturedHeaders['X-On-Behalf-Of']).toBe('usr_acting_customer_42');
  });

  // Scenario 6: Missing acting-user ID on protected farm request is rejected before upstream access
  it('6. missing acting-user ID on protected farm request is rejected before upstream access', async () => {
    const mockFetch = vi.fn();
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    const invalidSpeaker: SpeakerIdentity = {
      person_id: '',
      customer_ref: 'cust_unknown',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj_main',
      phone_e164: '+15550000000',
      is_known: true,
      role: 'manager',
      permissions: [],
      farm_ids: [testFarmId],
    };

    await expect(
      adapter.getFarmStatusForSpeaker({ farmId: testFarmId, speaker: invalidSpeaker }),
    ).rejects.toThrow(VfarmAuthorizationError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Scenario 7: Unauthorized farm access is denied without fallback
  it('7. unauthorized farm access is denied without fallback (assertSpeakerFarmAccess fails closed)', async () => {
    const mockFetch = vi.fn();
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    const authorizedSpeaker: SpeakerIdentity = {
      person_id: 'usr_valid_customer_01',
      customer_ref: 'cust_valid_01',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj_main',
      phone_e164: '+15551234567',
      is_known: true,
      role: 'manager',
      permissions: [],
      farm_ids: [testFarmId], // Authorized ONLY for testFarmId
    };

    const unauthorizedFarmId = 'farm_dallas_unauthorized_999';

    await expect(
      adapter.getFarmStatusForSpeaker({ farmId: unauthorizedFarmId, speaker: authorizedSpeaker }),
    ).rejects.toThrow(VfarmAuthorizationError);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Scenario 8: Unknown customer returns no synthetic identity
  it('8. unknown customer returns no synthetic identity when upstream returns 404', async () => {
    const mockFetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/users/resolve')) {
        return jsonResponse(404, { error: 'error', detail: 'User not found' });
      }
      return jsonResponse(404, {});
    });

    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    const unknownIdentity = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj_main',
      phoneE164: '+15559998877',
    });

    expect(unknownIdentity.is_known).toBe(false);
    expect(unknownIdentity.role).toBe('unknown');
    expect(unknownIdentity.farm_ids).toHaveLength(0);
    expect(unknownIdentity.customer_ref).toContain('opaque_unresolved');
  });

  // Scenario 9: vFarm timeout produces safe unavailable response
  it('9. vFarm timeout produces safe unavailable response', async () => {
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    });

    const client = new VfarmLiveClient({
      baseUrl,
      serviceKey: testServiceKey,
      timeoutMs: 50,
      fetchFn: mockFetch as any,
    });

    await expect(client.getFarmHealth(testFarmId)).rejects.toThrow(VfarmNetworkError);
  });

  // Scenario 10: Sensor reading request uses authenticated vFarm client with on-behalf-of
  it('10. sensor reading request uses authenticated vFarm client with on-behalf-of', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (url: any, init: any) => {
      const urlStr = String(url);
      capturedHeaders = init.headers;
      if (urlStr.includes('/api/v1/readings')) {
        return jsonResponse(200, {
          sensor_id: 'sensor_ph_01',
          from: '2026-11-20T00:00:00Z',
          to: '2026-11-20T12:00:00Z',
          count: 1,
          readings: [
            {
              sensor_id: 'sensor_ph_01',
              reading_ts: '2026-11-20T12:00:00Z',
              received_at: '2026-11-20T12:00:01Z',
              values: {
                ph: {
                  value: 7.2,
                  unit: 'pH',
                },
              },
            },
          ],
        });
      }
      return jsonResponse(404, {});
    });

    const client = new VfarmLiveClient({
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    const reading = await client.getLatestReading('sensor_ph_01', 'usr_acting_customer_10');

    expect(reading).toBeDefined();
    expect(reading?.values?.ph?.value).toBe(7.2);
    expect(capturedHeaders['X-Service-Key']).toBe(testServiceKey);
    expect(capturedHeaders['X-Farm-Key']).toBe(testServiceKey);
    expect(capturedHeaders['X-On-Behalf-Of']).toBe('usr_acting_customer_10');
  });

  // Scenario 11: Service key is never leaked in logs
  it('11. service key is never leaked in logs or error messages', async () => {
    const mockFetch = vi.fn(async () => {
      return jsonResponse(500, { error: 'internal_server_error' });
    });

    const client = new VfarmLiveClient({
      baseUrl,
      serviceKey: testServiceKey,
      fetchFn: mockFetch as any,
    });

    try {
      await client.getFarmHealth(testFarmId);
    } catch {
      // Expected failure
    }

    // Inspect all Logger calls
    const allLoggedArgs = [
      ...logSpy.info.mock.calls,
      ...logSpy.warn.mock.calls,
      ...logSpy.error.mock.calls,
      ...logSpy.infra.mock.calls,
    ].flat();

    const loggedText = JSON.stringify(allLoggedArgs);
    expect(loggedText).not.toContain(testServiceKey);
  });

  // Scenario 12: Legacy authentication remains functional when service key is absent
  it('12. legacy authentication remains functional when service key is absent', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (url: any, init: any) => {
      const urlStr = String(url);
      capturedHeaders = init.headers;
      if (urlStr.includes('/api/v1/organizations/org_legacy_test/users')) {
        return jsonResponse(200, [
          {
            user_id: 'usr_legacy_01',
            email: 'legacy@example.com',
            name: 'Legacy User',
            role: 'owner',
            granted_by: null,
            granted_at: '2026-01-01T00:00:00Z',
          },
        ]);
      }
      if (urlStr.includes('/api/v1/users/usr_legacy_01/farm-grants')) {
        return jsonResponse(200, [{ farm_id: testFarmId, granted_at: '2026-01-01T00:00:00Z' }]);
      }
      return jsonResponse(404, {});
    });

    const legacyApiKey = 'legacy_farm_api_key_123';
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl,
      apiKey: legacyApiKey, // NO serviceKey
      apiToken: 'jwt_admin_token_xyz',
      fetchFn: mockFetch as any,
    });

    // Register speaker in local directory as legacy path requires
    adapter.registerSpeaker('proj_legacy', {
      person_id: 'usr_legacy_01',
      display_name: 'Legacy User',
      phone_e164: '+15551112233',
      role: 'owner',
      farm_ids: [testFarmId],
    });
    adapter.addProject({
      project_id: 'proj_legacy',
      tenant_id: 'tenant-vfarm-01',
      name: 'Legacy Project',
      tenant_org_id: 'org_legacy_test',
    });

    const identity = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj_legacy',
      phoneE164: '+15551112233',
    });

    expect(identity.is_known).toBe(true);
    expect(identity.person_id).toBe('usr_legacy_01');
    expect(identity.role).toBe('owner');
    expect(capturedHeaders['X-Farm-Key']).toBe(legacyApiKey);
    expect(capturedHeaders['X-Service-Key']).toBeUndefined();
  });
});
