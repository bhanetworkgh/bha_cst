import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { IdentityResolver } from '../../engine/src/identity/resolver.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { normalizeFarmGrants } from '../../engine/src/adapters/vfarm/schemas.js';
import type { SystemConfig } from '../../engine/src/transport/twilio/types.js';

const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_A = 'proj-vfarm-main';
const PROJECT_B = 'proj-vfarm-dallas';
const REAL_ORG_ID = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';

const system: SystemConfig = {
  system_id: 'system-vfarm-01',
  organization_id: TENANT_ID,
  tenant_id: TENANT_ID,
  workspace_id: 'ws-vfarm-main',
  name: 'vFarm System #1',
  status: 'active',
  phone_numbers: ['+19715885823'],
  onboarding_reply: 'Welcome!',
};

/** Live-mode adapter whose org contains `customer_ref`s we choose. */
function makeLiveAdapter(members: string[]) {
  const mockFetch = vi.fn(async (url: string) => {
    if (url.includes('/organizations/')) {
      return {
        ok: true,
        status: 200,
        json: async () => members.map((user_id) => ({
          user_id,
          email: `${user_id}@vfarm.test`,
          name: user_id,
          role: 'manager',
          granted_by: null,
          granted_at: '2026-01-01T00:00:00Z',
        })),
        text: async () => '',
      };
    }
    if (url.includes('/farm-grants')) {
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    }
    throw new Error(`Unmocked: ${url}`);
  });

  return new VfarmTenantAdapter(TENANT_ID, {
    baseUrl: 'https://vfarm.test',
    apiKey: 'vk',
    fetchFn: mockFetch as any,
  });
}

describe('G9 — IdentityResolver uses the active tenant-adapter path', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    DbClient.seedCustomer({
      tenant_id: TENANT_ID,
      project_id: PROJECT_A,
      phone_e164: '+15551110000',
      customer_ref: 'usr_in_db_only',
      role: 'tech',
      farm_ids: ['farm_stale'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves through CoreRegistry (vFarm adapter), not the customers table', async () => {
    CoreRegistry.registerTenant(
      { tenant_id: TENANT_ID, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      makeLiveAdapter(['usr_from_vfarm'])
    );
    // Conflicting sources: the DB row and the adapter disagree on who this phone
    // is. Resolution must come from the adapter (the active vFarm path).
    DbClient.seedCustomer({
      tenant_id: TENANT_ID,
      project_id: PROJECT_A,
      phone_e164: '+15552220000',
      customer_ref: 'usr_from_db_table',
      role: 'tech',
      farm_ids: ['farm_db'],
    });
    CoreRegistry.getAdapter(TENANT_ID)!.registerSpeaker!(PROJECT_A, {
      person_id: 'usr_from_vfarm',
      phone_e164: '+15552220000',
      role: 'manager',
      farm_ids: ['farm_live'],
    });

    const identity = await IdentityResolver.resolveSenderIdentity('+15552220000', system, {
      projectId: PROJECT_A,
    });

    expect(identity.is_known_customer).toBe(true);
    // The adapter derives customer_ref from person_id, and its value wins over
    // the conflicting DB row ('usr_from_db_table').
    expect(identity.customer_ref).toBe('cust_usr_from_vfarm');
    expect(identity.customer_ref).not.toBe('usr_from_db_table');
    expect(identity.role).toBe('manager');
    expect(identity.project_id).toBe(PROJECT_A);
    expect((identity.unit_context as any)?.farm_ids).toEqual(['farm_live']);
  });

  it('reports the full farm_ids array, not just the legacy single farm_id', async () => {
    CoreRegistry.registerTenant(
      { tenant_id: TENANT_ID, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      makeLiveAdapter(['usr_multi'])
    );
    const adapter = CoreRegistry.getAdapter(TENANT_ID);
    adapter!.registerSpeaker!(PROJECT_A, {
      person_id: 'usr_multi',
      phone_e164: '+15553330000',
      role: 'owner',
      farm_ids: ['farm_1', 'farm_2', 'farm_3'],
    });

    const identity = await IdentityResolver.resolveSenderIdentity('+15553330000', system, {
      projectId: PROJECT_A,
    });

    expect(identity.is_known_customer).toBe(true);
    expect((identity.unit_context as any)?.farm_ids).toEqual(['farm_1', 'farm_2', 'farm_3']);
    // Previously only the single legacy farm_id column was exposed.
    expect((identity.unit_context as any)?.farm_id).toBe('farm_1');
  });

  it('fails closed when the adapter does not know the caller, even if a DB row exists', async () => {
    // DB has the row (legacy fallback would have accepted it) but the tenant
    // adapter is authoritative and does not know this person.
    CoreRegistry.registerTenant(
      { tenant_id: TENANT_ID, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      makeLiveAdapter(['usr_other'])
    );

    const identity = await IdentityResolver.resolveSenderIdentity('+15551110000', system, {
      projectId: PROJECT_A,
    });

    expect(identity.is_known_customer).toBe(false);
    expect(identity.role).toBe('unknown');
    expect(identity.permissions).toEqual([]);
    expect(identity.customer_ref).toMatch(/^opaque_unresolved_/);
  });

  it('keeps the unscoped DB fallback working when no project is supplied (and warns)', async () => {
    const identity = await IdentityResolver.resolveSenderIdentity('+15551110000', system);

    expect(identity.is_known_customer).toBe(true);
    expect(identity.customer_ref).toBe('usr_in_db_only');
    expect(identity.role).toBe('tech');
  });

  it('never auto-registers an unknown sender on either path', async () => {
    CoreRegistry.registerTenant(
      { tenant_id: TENANT_ID, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      makeLiveAdapter(['usr_known'])
    );

    await IdentityResolver.resolveSenderIdentity('+15559990000', system, { projectId: PROJECT_A });
    await IdentityResolver.resolveSenderIdentity('+15559990001', system);

    expect(await DbClient.lookupCustomerByPhoneAsync('+15559990000', TENANT_ID, PROJECT_A)).toBeNull();
    expect(await DbClient.lookupCustomerByPhoneAsync('+15559990001', TENANT_ID)).toBeNull();
  });
});

describe('G19 — project → real vFarm organization mapping', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });

  it('registers projects with a real UUID org id, not the old placeholders', () => {
    const main = CoreRegistry.getProject(PROJECT_A);
    const dallas = CoreRegistry.getProject(PROJECT_B);

    expect(main?.tenant_org_id).toBe(REAL_ORG_ID);
    expect(dallas?.tenant_org_id).toBe(REAL_ORG_ID);
    // Regression: these used to be 'org-vfarm-austin' / 'org-vfarm-dallas'.
    expect(main?.tenant_org_id).not.toBe('org-vfarm-austin');
    expect(dallas?.tenant_org_id).not.toBe('org-vfarm-dallas');
  });

  it('accepts an environment override', () => {
    const previous = process.env.VFARM_TENANT_ORG_ID;
    process.env.VFARM_TENANT_ORG_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    try {
      CoreRegistry.resetToDefault();
      expect(CoreRegistry.getProject(PROJECT_A)?.tenant_org_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    } finally {
      if (previous === undefined) delete process.env.VFARM_TENANT_ORG_ID;
      else process.env.VFARM_TENANT_ORG_ID = previous;
      CoreRegistry.resetToDefault();
    }
  });

  it('runs the live org cross-check instead of skipping it', async () => {
    // pullSpeakers only performs the live membership check when tenant_org_id is
    // a usable value. Assert the code path is reached with the real UUID.
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes('/organizations/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ user_id: 'usr_1', email: 'a@b.c', name: 'A', role: 'manager', granted_by: null, granted_at: 'x' }],
          text: async () => '',
        };
      }
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk',
      fetchFn: mockFetch as any,
    });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT_ID, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );

    await adapter.pullSpeakers(TENANT_ID, PROJECT_A);

    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes(`/organizations/${REAL_ORG_ID}/users`))).toBe(true);
  });
});

describe('farm-grants response shape tolerance', () => {
  it('accepts a bare array', () => {
    expect(normalizeFarmGrants([{ farm_id: 'f1' }, { farm_id: 'f2' }])).toEqual([
      { farm_id: 'f1' },
      { farm_id: 'f2' },
    ]);
  });

  it('accepts an enveloped { grants, total } object', () => {
    expect(normalizeFarmGrants({ grants: [{ farm_id: 'f1' }], total: 1 })).toEqual([{ farm_id: 'f1' }]);
  });

  it('rejects a shape that is neither, rather than silently yielding empty scope', () => {
    // Regression: a silent empty result would make farm scope look revoked.
    expect(() => normalizeFarmGrants({ unexpected: true })).toThrow();
    expect(() => normalizeFarmGrants('nope')).toThrow();
  });
});

describe('G10/G11 — project-scoped uniqueness and update predicates (in-memory contract)', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });

  it('allows the same phone in two projects of one tenant with independent scope', async () => {
    DbClient.seedCustomer({
      tenant_id: TENANT_ID, project_id: PROJECT_A, phone_e164: '+15557770000',
      customer_ref: 'usr_a', role: 'owner', farm_ids: ['farm_a'],
    });
    DbClient.seedCustomer({
      tenant_id: TENANT_ID, project_id: PROJECT_B, phone_e164: '+15557770000',
      customer_ref: 'usr_b', role: 'tech', farm_ids: ['farm_b'],
    });

    const a = await DbClient.lookupCustomerByPhoneAsync('+15557770000', TENANT_ID, PROJECT_A);
    const b = await DbClient.lookupCustomerByPhoneAsync('+15557770000', TENANT_ID, PROJECT_B);

    expect(a?.customer_ref).toBe('usr_a');
    expect(b?.customer_ref).toBe('usr_b');
    expect(a?.farm_ids).not.toEqual(b?.farm_ids);
  });

  it('a project-scoped update does not touch the same phone in another project', async () => {
    DbClient.seedCustomer({
      tenant_id: TENANT_ID, project_id: PROJECT_A, phone_e164: '+15557770001',
      customer_ref: 'usr_a', role: 'owner', farm_ids: [],
    });
    DbClient.seedCustomer({
      tenant_id: TENANT_ID, project_id: PROJECT_B, phone_e164: '+15557770001',
      customer_ref: 'usr_b', role: 'tech', farm_ids: [],
    });

    const updated = await DbClient.updateCustomer('+15557770001', TENANT_ID, PROJECT_A, { role: 'manager' });
    expect(updated?.role).toBe('manager');

    const untouched = await DbClient.lookupCustomerByPhoneAsync('+15557770001', TENANT_ID, PROJECT_B);
    expect(untouched?.role).toBe('tech');
  });

  it('a tenant-scoped update without a project still works', async () => {
    DbClient.seedCustomer({
      tenant_id: TENANT_ID, project_id: PROJECT_A, phone_e164: '+15557770002',
      customer_ref: 'usr_a', role: 'owner', farm_ids: [],
    });
    const updated = await DbClient.updateCustomer('+15557770002', TENANT_ID, undefined, { role: 'tech' });
    expect(updated?.role).toBe('tech');
  });
});