/**
 * Identity Resolution & Role Assignment Tests.
 *
 * Role assignment is AUTHORITATIVE only on the active chain:
 *
 *   Twilio To   -> service_number_binding -> tenant / project
 *   Twilio From -> vFarm tenant adapter   -> person / role / farm_ids
 *
 * The unscoped `customers` table is a legacy correlation surface. It cannot be
 * scoped to a project and its `farm_id` / `farm_ids` columns are not
 * vFarm-authoritative, so it must never mint a role, permissions, or farm
 * scope. These tests pin both halves: roles DO come from vFarm, and roles can
 * NOT come from the legacy table.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { IdentityResolver } from '../../engine/src/identity/resolver.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';
import type { SystemConfig } from '../../engine/src/transport/twilio/types.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';

/**
 * Adapter whose vFarm org directory reports `role` for each member, mirroring
 * `GET /api/v1/organizations/{id}/users`.
 */
function makeLiveAdapter(members: { user_id: string; role: string }[], farms: Record<string, string[]> = {}) {
  const mockFetch = vi.fn(async (url: string): Promise<any> => {
    if (url.includes('/organizations/')) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          members.map((m) => ({
            user_id: m.user_id,
            email: `${m.user_id}@vfarm.test`,
            name: m.user_id,
            role: m.role,
            granted_by: null,
            granted_at: '2026-01-01T00:00:00Z',
          })),
        text: async () => '',
      };
    }
    if (url.includes('/farm-grants')) {
      const userId = decodeURIComponent(url.split('/users/')[1]?.split('/')[0] || '');
      return {
        ok: true,
        status: 200,
        json: async () => (farms[userId] ?? []).map((farm_id) => ({ farm_id })),
        text: async () => '',
      };
    }
    throw new Error(`Unmocked: ${url}`);
  });
  return new VfarmTenantAdapter(TENANT, {
    baseUrl: 'https://vfarm.test',
    apiKey: 'vk',
    fetchFn: mockFetch as any,
  });
}

describe('Identity Resolution & Role Assignment Tests', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const vfarmConfig: SystemConfig = SystemsRegistry.getSystemByTenantId(TENANT)!;

  // ── Active chain: role + permissions come from the vFarm tenant adapter ────

  it('resolves a manager (+15551234567) from the vFarm org directory with manager permissions', async () => {
    const adapter = makeLiveAdapter([{ user_id: 'usr_john', role: 'manager' }]);
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_john',
      phone_e164: '+15551234567',
      role: 'manager',
      farm_ids: ['farm_live_1'],
    });

    const identity = await IdentityResolver.resolveSenderIdentity('+15551234567', vfarmConfig, {
      projectId: PROJECT,
    });

    expect(identity.is_known_customer).toBe(true);
    expect(identity.customer_ref).toBe('cust_usr_john');
    expect(identity.organization_id).toBe(TENANT);
    expect(identity.tenant_id).toBe(TENANT);
    expect(identity.project_id).toBe(PROJECT);
    expect(identity.role).toBe('manager');
    expect(identity.permissions).toContain('read:telemetry');
    expect(identity.permissions).toContain('write:control');
  });

  it('resolves an owner (+923082113844) from the vFarm org directory with owner permissions', async () => {
    const adapter = makeLiveAdapter([{ user_id: 'usr_owner', role: 'owner' }]);
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_owner',
      phone_e164: '+923082113844',
      role: 'owner',
      farm_ids: [],
    });

    const identity = await IdentityResolver.resolveSenderIdentity('+923082113844', vfarmConfig, {
      projectId: PROJECT,
    });

    expect(identity.is_known_customer).toBe(true);
    expect(identity.role).toBe('owner');
    expect(identity.permissions).toContain('write:settings');
  });

  it('resolves a tech (+15558887777) from the vFarm org directory with tech permissions only', async () => {
    const adapter = makeLiveAdapter([{ user_id: 'usr_alice', role: 'tech' }]);
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_alice',
      phone_e164: '+15558887777',
      role: 'tech',
      farm_ids: ['farm_live_1'],
    });

    const identity = await IdentityResolver.resolveSenderIdentity('+15558887777', vfarmConfig, {
      projectId: PROJECT,
    });

    expect(identity.is_known_customer).toBe(true);
    expect(identity.role).toBe('tech');
    expect(identity.permissions).toContain('write:escalate');
    expect(identity.permissions).not.toContain('write:settings');
  });

  it('supports multiple numbers in one system with different vFarm roles', async () => {
    const adapter = makeLiveAdapter([
      { user_id: 'usr_multi_owner', role: 'owner' },
      { user_id: 'usr_multi_tech', role: 'tech' },
    ]);
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_multi_owner',
      phone_e164: '+15553331111',
      role: 'owner',
      farm_ids: [],
    });
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_multi_tech',
      phone_e164: '+15553332222',
      role: 'tech',
      farm_ids: [],
    });

    const identityOwner = await IdentityResolver.resolveSenderIdentity('+15553331111', vfarmConfig, {
      projectId: PROJECT,
    });
    const identityTech = await IdentityResolver.resolveSenderIdentity('+15553332222', vfarmConfig, {
      projectId: PROJECT,
    });

    expect(identityOwner.role).toBe('owner');
    expect(identityTech.role).toBe('tech');
    expect(identityOwner.tenant_id).toBe(identityTech.tenant_id);
  });

  it('returns is_known_customer: false for a caller the vFarm directory does not know, without auto-registering', async () => {
    const unknownPhone = '+15559990000';
    const adapter = makeLiveAdapter([{ user_id: 'usr_known', role: 'manager' }]);
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_known',
      phone_e164: '+15551234567',
      role: 'manager',
      farm_ids: [],
    });

    const identity = await IdentityResolver.resolveSenderIdentity(unknownPhone, vfarmConfig, {
      projectId: PROJECT,
    });

    expect(identity.is_known_customer).toBe(false);
    expect(identity.role).toBe('unknown');
    expect(identity.permissions).toEqual([]);
    expect(identity.unit_context).toBeUndefined();

    expect(DbClient.lookupCustomerByPhone(unknownPhone, TENANT)).toBeNull();
  });

  it('treats a partial phone match as an unknown caller', async () => {
    // Known phone is +15551234567; pass partial phone +15551234
    const partialPhone = '+15551234';
    const adapter = makeLiveAdapter([{ user_id: 'usr_john', role: 'manager' }]);
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_john',
      phone_e164: '+15551234567',
      role: 'manager',
      farm_ids: [],
    });

    const identity = await IdentityResolver.resolveSenderIdentity(partialPhone, vfarmConfig, {
      projectId: PROJECT,
    });

    expect(identity.is_known_customer).toBe(false);
    expect(identity.role).toBe('unknown');
    expect(identity.customer_ref).toMatch(/^opaque_unresolved_/);
  });

  // ── Legacy `customers` table: correlation only, never authorization ───────

  it('refuses outright when no project scope is supplied (default deny, no DB lookup)', async () => {
    // +15551234567 IS a seeded legacy customer row. Without a project there is
    // no service_number_binding, so there is no tenancy chain and the caller is
    // denied rather than resolved from the unscoped table.
    const identity = await IdentityResolver.resolveSenderIdentity('+15551234567', vfarmConfig);

    expect(identity.is_known_customer).toBe(false);
    expect(identity.role).toBe('unknown');
    expect(identity.permissions).toEqual([]);
    expect(identity.unit_context).toBeUndefined();
    expect(identity.customer_ref).toMatch(/^opaque_unresolved_/);
  });

  it('even the explicit unscoped-lookup opt-in cannot assign a role, permissions, or farm scope', async () => {
    DbClient.seedCustomer({
      tenant_id: TENANT,
      phone_e164: '+15558887777',
      customer_ref: 'cust_vfarm_002_alice_smith',
      role: 'tech',
      farm_ids: ['farm_legacy'],
    });

    const identity = await IdentityResolver.resolveSenderIdentity('+15558887777', vfarmConfig, {
      allowUnscopedLookup: true,
    });

    // The row can still be named for audit correlation...
    expect(identity.customer_ref).toBe('cust_vfarm_002_alice_smith');
    // ...but it grants nothing.
    expect(identity.is_known_customer).toBe(false);
    expect(identity.role).toBe('unknown');
    expect(identity.permissions).toEqual([]);
    expect(identity.unit_context).toBeUndefined();
    expect(identity.project_id).toBeUndefined();
  });

  it('a legacy owner row cannot escalate to owner permissions', async () => {
    DbClient.seedCustomer({
      tenant_id: TENANT,
      phone_e164: '+923082113844',
      customer_ref: 'cust_vfarm_003_test_user',
      role: 'owner',
    });

    const denied = await IdentityResolver.resolveSenderIdentity('+923082113844', vfarmConfig, {
      allowUnscopedLookup: true,
    });

    expect(denied.role).not.toBe('owner');
    expect(denied.permissions).not.toContain('write:settings');
  });
});
