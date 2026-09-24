import { describe, it, expect, vi } from 'vitest';
import { VfarmHttpClient, VfarmApiError } from '../../engine/src/adapters/vfarm/http_client.js';

function jsonResponse(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('VfarmHttpClient', () => {
  const baseUrl = 'https://bhavfarm1.duckdns.org';
  const apiKey = 'test-farm-key';

  it('sends the X-Farm-Key header and hits the correct org-members path', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return jsonResponse(200, [
        { user_id: 'usr_1', email: 'a@b.com', name: 'Alice', role: 'owner', granted_by: null, granted_at: '2026-01-01T00:00:00Z' },
      ]);
    });

    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    const members = await client.listOrganizationMembers('org-vfarm-austin');

    expect(capturedUrl).toBe(`${baseUrl}/api/v1/organizations/org-vfarm-austin/users`);
    expect(capturedHeaders['X-Farm-Key']).toBe(apiKey);
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe('usr_1');
  });

  it('sends a bearer token when apiToken is configured', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return jsonResponse(200, []);
    });
    const client = new VfarmHttpClient({ baseUrl, apiKey, apiToken: 'tok_123', fetchFn: mockFetch as any });
    await client.listOrganizationMembers('org-1');
    expect(capturedHeaders['Authorization']).toBe('Bearer tok_123');
  });

  it('maps 401/403 to an "auth" category error without leaking the response body', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(401, { secret: 'do-not-leak' }));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });

    await expect(client.listOrganizationMembers('org-1')).rejects.toMatchObject({
      name: 'VfarmApiError',
      category: 'auth',
    });
  });

  it('maps 404 to a "not_found" category error', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(404, {}));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    await expect(client.getInventoryItem('SN-404')).rejects.toMatchObject({ category: 'not_found' });
  });

  it('maps 429 to a "rate_limited" category error', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(429, {}));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    await expect(client.listOrganizationMembers('org-1')).rejects.toMatchObject({ category: 'rate_limited' });
  });

  it('maps other 5xx responses to an "upstream" category error', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(503, {}));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    await expect(client.listOrganizationMembers('org-1')).rejects.toMatchObject({ category: 'upstream', status: 503 });
  });

  it('maps a thrown network error to a "network" category error', async () => {
    const mockFetch = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    await expect(client.listOrganizationMembers('org-1')).rejects.toMatchObject({ category: 'network' });
  });

  it('maps an aborted request (timeout) to a "timeout" category error', async () => {
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err: any = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new VfarmHttpClient({ baseUrl, apiKey, timeoutMs: 10, fetchFn: mockFetch as any });
    await expect(client.listOrganizationMembers('org-1')).rejects.toMatchObject({ category: 'timeout' });
  });

  it('rejects an org-members response that fails schema validation (e.g. missing user_id)', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(200, [{ email: 'no-user-id@x.com' }]));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    await expect(client.listOrganizationMembers('org-1')).rejects.toMatchObject({ category: 'invalid_response' });
  });

  it('never surfaces a phone/phone_e164 field even if a malicious/misconfigured upstream includes one', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(200, [
      { user_id: 'usr_1', email: 'a@b.com', name: 'Alice', role: 'owner', granted_by: null, granted_at: '2026-01-01T00:00:00Z', phone: '+15551234567' },
    ]));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    const members = await client.listOrganizationMembers('org-1');
    expect((members[0] as any).phone).toBeUndefined();
  });

  it('rejects getConfig for a malformed (non-hex/wrong-length) config hash before making a request', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(200, {}));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    await expect(client.getConfig('not-a-real-hash')).rejects.toMatchObject({ category: 'invalid_response' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('parses a valid inventory item including a null farm_id', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(200, {
      serial_number: 'SN-1', catalog_id: 'cat-1', device_name: 'Cabinet', family_id: 'fam-1',
      family_label: 'LM7W', catalog_is_active: true, status: 'active', farm_id: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    const item = await client.getInventoryItem('SN-1');
    expect(item.farm_id).toBeNull();
  });

  it('parses a valid unit-config response', async () => {
    const hash = 'a'.repeat(64);
    const mockFetch = vi.fn(async () => jsonResponse(200, {
      serial_number: 'SN-1',
      current: { config_hash: hash, name: 'Bay Config', spec_version: 'v1', cad_revision: null, effective_at: '2026-01-01T00:00:00Z' },
      history: [],
    }));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    const result = await client.getUnitConfig('SN-1');
    expect(result.current.config_hash).toBe(hash);
  });

  it('parses a valid config-detail response', async () => {
    const hash = 'b'.repeat(64);
    const mockFetch = vi.fn(async () => jsonResponse(200, {
      config_hash: hash, name: 'Bay Config', spec_version: 'v1', cad_revision: null,
      created_at: '2026-01-01T00:00:00Z',
      parts: [{ part_code: 'P1', part_kind: 'panel', length_mm: 100, width_mm: 50, height_mm: 10, attributes: {}, quantity: 2 }],
    }));
    const client = new VfarmHttpClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    const result = await client.getConfig(hash);
    expect(result.parts).toHaveLength(1);
  });
});
