import { describe, it, expect, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

function jsonResponse(status: number, body: unknown): any {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const PROJECT_ID = 'proj-vfarm-main';
const TENANT_ID = 'tenant-vfarm-01';
const ORG_ID = 'org-vfarm-austin'; // matches the adapter's default fixture project

function baseFetchRouter(routes: Record<string, () => any>) {
  return vi.fn(async (url: string) => {
    for (const [path, handler] of Object.entries(routes)) {
      if (url.includes(path)) return handler();
    }
    throw new Error(`Unmocked URL in test: ${url}`);
  });
}

describe('VfarmTenantAdapter — local mode (no baseUrl configured)', () => {
  it('runs in local mode by default and resolves a pre-registered demo speaker without any network call', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID);
    expect(adapter.isLiveMode()).toBe(false);
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15551234567' });
    expect(identity.is_known).toBe(true);
    expect(identity.role).toBe('manager');
  });

  it('fails closed for an unknown phone number', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID);
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15550001111' });
    expect(identity.is_known).toBe(false);
    expect(identity.permissions).toEqual([]);
  });

  it('fails closed for a missing/empty phone number', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID);
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '' });
    expect(identity.is_known).toBe(false);
  });

  it('fails closed for an invalid (non-E.164) phone number', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID);
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '5551234567' });
    expect(identity.is_known).toBe(false);
  });

  it('fails closed after a speaker is explicitly removed (revoked locally)', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID);
    adapter.removeSpeaker(PROJECT_ID, '+15551234567');
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15551234567' });
    expect(identity.is_known).toBe(false);
  });

  it('keeps tenant/project isolation — a speaker registered under one project is unknown under another', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID);
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: 'proj-vfarm-dallas', phoneE164: '+15551234567' });
    expect(identity.is_known).toBe(false);
  });

  it('fails closed (throws, caught by caller) when simulateDegraded is set', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID);
    adapter.setDegraded(true);
    await expect(
      adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15551234567' })
    ).rejects.toThrow();
  });
});

describe('VfarmTenantAdapter — live mode (baseUrl configured)', () => {
  it('resolves a locally-known speaker who is confirmed present in the live org-members list', async () => {
    const mockFetch = baseFetchRouter({
      [`/organizations/${ORG_ID}/users`]: () => jsonResponse(200, [
        { user_id: 'usr_vfarm_001', email: 'j@x.com', name: 'John Doe', role: 'manager', granted_by: null, granted_at: '2026-01-01T00:00:00Z' },
      ]),
      '/farm-grants': () => jsonResponse(200, [{ farm_id: 'farm_austin_main' }]),
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    expect(adapter.isLiveMode()).toBe(true);
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15551234567' });
    expect(identity.is_known).toBe(true);
    expect(identity.farm_ids).toContain('farm_austin_main');
  });

  it('fails closed when the locally-known speaker no longer appears in the live org-members list (revoked upstream)', async () => {
    const mockFetch = baseFetchRouter({
      [`/organizations/${ORG_ID}/users`]: () => jsonResponse(200, []), // empty — user removed from vFarm org
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    const identity = await adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15551234567' });
    expect(identity.is_known).toBe(false);
  });

  it('fails closed on an upstream authentication failure (401) rather than trusting the stale local record', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(401, {}));
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    await expect(
      adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15551234567' })
    ).rejects.toMatchObject({ category: 'auth' });
  });

  it('fails closed on an upstream timeout rather than trusting the stale local record', async () => {
    const mockFetch = vi.fn(async (_url: any, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', timeoutMs: 10, fetchFn: mockFetch as any });
    await expect(
      adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: '+15551234567' })
    ).rejects.toMatchObject({ category: 'timeout' });
  });

  it('never trusts a client-supplied identity claim — resolution is keyed only on phone_e164', async () => {
    const mockFetch = baseFetchRouter({
      [`/organizations/${ORG_ID}/users`]: () => jsonResponse(200, [
        { user_id: 'usr_vfarm_001', email: 'j@x.com', name: 'John Doe', role: 'manager', granted_by: null, granted_at: '2026-01-01T00:00:00Z' },
      ]),
      '/farm-grants': () => jsonResponse(200, [{ farm_id: 'farm_austin_main' }]),
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    const identity = await adapter.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15551234567',
      claimed_role: 'owner',
      claimed_person_id: 'usr_attacker',
    } as any);
    expect(identity.person_id).toBe('usr_vfarm_001');
    expect(identity.role).toBe('manager');
  });
});

describe('VfarmTenantAdapter — resolveCabinetConfig (live mode)', () => {
  const speaker: SpeakerIdentity = {
    person_id: 'usr_vfarm_001',
    customer_ref: 'cust_usr_vfarm_001',
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    phone_e164: '+15551234567',
    is_known: true,
    role: 'manager',
    permissions: [],
    farm_ids: ['farm_austin_main'],
  };
  const HASH = 'c'.repeat(64);

  it('authorizes and returns config using the AUTHORITATIVE farm_id from inventory, ignoring a mismatched client-supplied farmId', async () => {
    const mockFetch = baseFetchRouter({
      '/inventory/SN-100/config': () => jsonResponse(200, {
        serial_number: 'SN-100',
        current: { config_hash: HASH, name: 'Bay Config', spec_version: 'v1', cad_revision: 'r1', effective_at: '2026-01-01T00:00:00Z' },
        history: [],
      }),
      '/inventory/SN-100': () => jsonResponse(200, {
        serial_number: 'SN-100', catalog_id: 'cat-1', device_name: 'Cabinet', family_id: 'fam-1',
        family_label: 'LM7W', catalog_is_active: true, status: 'active', farm_id: 'farm_austin_main',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }),
      [`/configs/${HASH}`]: () => jsonResponse(200, {
        config_hash: HASH, name: 'Bay Config', spec_version: 'v1', cad_revision: 'r1',
        created_at: '2026-01-01T00:00:00Z', parts: [],
      }),
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });

    // Caller supplies a WRONG farmId — must be ignored in favor of the authoritative inventory farm_id.
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID, projectId: PROJECT_ID, farmId: 'farm_dallas_north', serial: 'SN-100', speaker,
    });
    expect(config).not.toBeNull();
    expect(config?.farm_id).toBe('farm_austin_main');
    expect(config?.config_hash).toBe(HASH);
  });

  it('fails closed when the authoritative farm_id is not in the speaker\'s authorized scope', async () => {
    const mockFetch = baseFetchRouter({
      '/inventory/SN-200': () => jsonResponse(200, {
        serial_number: 'SN-200', catalog_id: 'cat-1', device_name: 'Cabinet', family_id: 'fam-1',
        family_label: 'LM7W', catalog_is_active: true, status: 'active', farm_id: 'farm_dallas_north',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }),
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID, projectId: PROJECT_ID, farmId: 'farm_dallas_north', serial: 'SN-200', speaker,
    });
    expect(config).toBeNull();
  });

  it('fails closed when inventory has a null/missing farm_id', async () => {
    const mockFetch = baseFetchRouter({
      '/inventory/SN-300': () => jsonResponse(200, {
        serial_number: 'SN-300', catalog_id: 'cat-1', device_name: 'Cabinet', family_id: 'fam-1',
        family_label: 'LM7W', catalog_is_active: true, status: 'active', farm_id: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      }),
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID, projectId: PROJECT_ID, farmId: 'farm_austin_main', serial: 'SN-300', speaker,
    });
    expect(config).toBeNull();
  });

  it('returns null (not an error) when the inventory item does not exist (404)', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(404, {}));
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID, projectId: PROJECT_ID, farmId: 'farm_austin_main', serial: 'SN-MISSING', speaker,
    });
    expect(config).toBeNull();
  });

  it('returns null for an unknown/unauthorized speaker without making any network call', async () => {
    const mockFetch = vi.fn();
    const adapter = new VfarmTenantAdapter(TENANT_ID, { baseUrl: 'https://vfarm.test', apiKey: 'k', fetchFn: mockFetch as any });
    const unknownSpeaker: SpeakerIdentity = { ...speaker, is_known: false };
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID, projectId: PROJECT_ID, farmId: 'farm_austin_main', serial: 'SN-100', speaker: unknownSpeaker,
    });
    expect(config).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
