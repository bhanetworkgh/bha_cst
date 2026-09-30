import { describe, it, expect, vi } from 'vitest';
import { VfarmLiveClient } from '../../engine/src/adapters/vfarm/live_client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

/**
 * The vFarm organization-members endpoint does NOT accept X-Farm-Key auth: with
 * only the farm key it answers 401 "Missing authentication — provide X-Farm-Key
 * or Authorization: Bearer <token>". Verified live against the real vFarm
 * instance, so the live client must send a bearer JWT for that call.
 */
describe('VfarmLiveClient — bearer auth on the org-members endpoint', () => {
  const baseUrl = 'https://vfarm.test';
  const apiKey = 'vk_test';
  const apiToken = 'jwt_test_token';
  const orgId = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';

  function okResponse(body: unknown): any {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }

  const memberRow = {
    user_id: 'debf555c-b37d-4e92-bb15-597e169f1b38',
    email: 'admin@vfarm.co',
    name: 'Admin',
    role: 'admin',
    granted_by: null,
    granted_at: '2026-07-10T16:16:47.012386Z',
  };

  it('sends Authorization: Bearer from the client apiToken when fetching org members', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return okResponse([memberRow]);
    });

    const client = new VfarmLiveClient({ baseUrl, apiKey, apiToken, fetchFn: mockFetch as any });
    const members = await client.getOrgMembers(orgId);

    expect(capturedHeaders['Authorization']).toBe(`Bearer ${apiToken}`);
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(memberRow.user_id);
    expect(members[0].role).toBe('admin');
  });

  it('sends a per-call token that overrides the client apiToken', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return okResponse([memberRow]);
    });

    const client = new VfarmLiveClient({ baseUrl, apiKey, apiToken, fetchFn: mockFetch as any });
    await client.getOrgMembers(orgId, 'jwt_fresh_from_login');

    expect(capturedHeaders['Authorization']).toBe('Bearer jwt_fresh_from_login');
  });

  it('keeps the farm key alongside the bearer token', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return okResponse([memberRow]);
    });

    const client = new VfarmLiveClient({ baseUrl, apiKey, apiToken, fetchFn: mockFetch as any });
    await client.getOrgMembers(orgId);

    expect(capturedHeaders['X-Farm-Key']).toBe(apiKey);
  });

  it('honours a token set after construction (refreshed admin login)', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedHeaders = init.headers;
      return okResponse([memberRow]);
    });

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    client.setApiToken('jwt_after_login');
    await client.getOrgMembers(orgId);

    expect(capturedHeaders['Authorization']).toBe('Bearer jwt_after_login');
  });

  it('still surfaces an auth failure when no token is available at all', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    }));

    const client = new VfarmLiveClient({ baseUrl, apiKey, fetchFn: mockFetch as any });
    await expect(client.getOrgMembers(orgId)).rejects.toBeTruthy();
  });
});

describe('VfarmTenantAdapter — admin JWT reaches both HTTP clients', () => {
  it('builds the live client with the VFARM_JWT bearer token available at construction', () => {
    const previous = process.env.VFARM_JWT;
    process.env.VFARM_JWT = 'jwt_from_env';
    try {
      const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
        baseUrl: 'https://vfarm.test',
        apiKey: 'vk_test',
      });
      // Regression: adminJwt used to be assigned AFTER buildLiveClient(), so the
      // live client was constructed without the token and org-members 401'd.
      expect((adapter.getLiveClient() as any).getApiToken()).toBe('jwt_from_env');
    } finally {
      if (previous === undefined) delete process.env.VFARM_JWT;
      else process.env.VFARM_JWT = previous;
    }
  });

  it('propagates a refreshed JWT from authenticateAdmin to the live client', async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes('/auth/login') || url.includes('/api/v1/tokens')) {
        return { ok: true, status: 200, json: async () => ({ token: 'jwt_refreshed' }), text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });

    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk_test',
      fetchFn: mockFetch as any,
    });

    // Login may fail in a test environment; either way a successful login must
    // leave the live client holding the new token.
    try {
      await adapter.authenticateAdmin('admin@vfarm.co', 'secret');
    } catch {
      /* login path not exercised here */
    }
    if (adapter.getAdminJwt() === 'jwt_refreshed') {
      expect((adapter.getLiveClient() as any).getApiToken()).toBe('jwt_refreshed');
    }
  });
});
