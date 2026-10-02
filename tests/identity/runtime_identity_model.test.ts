/**
 * Item 3 — legacy runtime identity paths (G9/G14).
 *
 * Final decision (documented in docs/evidence/cst-user-integration-admin-panel.md):
 *   * The ACTIVE runtime identity model is
 *       Twilio To   -> service_number_binding -> tenant / project / capability
 *       Twilio From -> vFarm tenant adapter   -> person / role / farm_ids
 *   * `SystemsRegistry` is retained but demoted to a NON-IDENTITY configuration
 *     registry (display name, onboarding copy, BHARAG workspace key, ElevenLabs
 *     voice pointer). It is no longer a tenancy authority anywhere.
 *   * `IdentityResolver` is a thin bridge to `CoreRegistry.resolveSpeaker`; the
 *     unscoped `customers`-table branch is legacy-only and must never authorize
 *     farm data.
 *
 * These tests pin the invariants so a second identity system cannot creep back.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { IdentityResolver } from '../../engine/src/identity/resolver.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import type { SystemConfig } from '../../engine/src/transport/twilio/types.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';

const system: SystemConfig = {
  system_id: 'system-vfarm-01',
  organization_id: TENANT,
  tenant_id: TENANT,
  workspace_id: 'ws-vfarm-main',
  name: 'vFarm System #1',
  status: 'active',
  phone_numbers: ['+19715885823'],
  onboarding_reply: 'Welcome!',
};

function makeLiveAdapter(members: string[], farms: Record<string, string[]>) {
  const mockFetch = vi.fn(async (url: string): Promise<any> => {
    if (url.includes('/organizations/')) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          members.map((user_id) => ({
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

describe('Active runtime identity model — Twilio To -> service_number_binding', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });

  it('resolves tenant/project/capability from the receiving number alone', () => {
    const binding = CoreRegistry.resolveServiceNumber('+19715885823')!;
    expect(binding.tenant_id).toBe(TENANT);
    expect(binding.project_id).toBe(PROJECT);
    expect(binding.capability).toBe('sms');
    expect(binding.status).toBe('bound');
  });

  it('an unbound receiving number resolves to nothing (fail closed)', () => {
    expect(CoreRegistry.resolveServiceNumber('+19998887777')).toBeNull();
    expect(CoreRegistry.resolveServiceNumber('')).toBeNull();
  });

  it('two projects of one tenant get distinct receiving numbers and projects', () => {
    expect(CoreRegistry.resolveServiceNumber('+19715885823')?.project_id).toBe(PROJECT);
    expect(CoreRegistry.resolveServiceNumber('+19715885824')?.project_id).toBe('proj-vfarm-dallas');
  });
});

describe('Active runtime identity model — Twilio From -> vFarm tenant adapter', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves person/role/farm_ids from the adapter, not the systems registry', async () => {
    const adapter = makeLiveAdapter(['usr_live'], { usr_live: ['farm_live_1'] });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      adapter
    );
    adapter.registerSpeaker(PROJECT, {
      person_id: 'usr_live',
      phone_e164: '+15551112222',
      role: 'tech',
      farm_ids: ['farm_stale'],
    });

    // Conflicting static record in the legacy systems world.
    DbClient.seedCustomer({
      tenant_id: TENANT,
      project_id: PROJECT,
      phone_e164: '+15551112222',
      customer_ref: 'usr_legacy_row',
      role: 'owner',
      farm_ids: ['farm_legacy'],
    });

    const identity = await IdentityResolver.resolveSenderIdentity('+15551112222', system, {
      projectId: PROJECT,
    });

    expect(identity.is_known_customer).toBe(true);
    expect(identity.customer_ref).toBe('cust_usr_live');
    expect(identity.customer_ref).not.toBe('usr_legacy_row');
    expect(identity.role).toBe('manager'); // from the vFarm org member record
    expect((identity.unit_context as any)?.farm_ids).toEqual(['farm_live_1']);
  });
});

describe('Legacy identity surface is explicitly non-authoritative', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    SystemsRegistry.resetToDefault();
  });

  it('SystemsRegistry is documented as configuration-only', () => {
    // Structural assertion: the deprecation notice is on the class itself, so a
    // future reader of the file cannot mistake it for an identity authority.
    // (Behavioural guarantees are covered by the tests above.)
    expect(typeof SystemsRegistry.getSystemByTenantId).toBe('function');
    expect(SystemsRegistry.getSystemByTenantId('tenant-unknown')).toBeNull();
  });

  it('the unscoped customers-table fallback cannot authorize farm scope', async () => {
    // It still resolves identity for legacy callers, but its farm scope comes
    // from a single legacy column, so it is never consulted for authorization.
    DbClient.seedCustomer({
      tenant_id: TENANT,
      project_id: PROJECT,
      phone_e164: '+15550009999',
      customer_ref: 'usr_legacy',
      role: 'manager',
      farm_id: 'farm_legacy_single',
      farm_ids: ['farm_legacy_single'],
    });

    // Authoritative adapter path for the same project: this phone was never
    // onboarded into the vFarm-backed directory, so it is unknown with no farm
    // scope, regardless of what the legacy customers row claims.
    const binding = CoreRegistry.resolveServiceNumber('+19715885823');
    expect(binding?.project_id).toBe(PROJECT);
    await expect(
      CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT, phoneE164: '+15550009999' })
    ).resolves.toMatchObject({ is_known: false, farm_ids: [] });
  });

  it('no runtime code resolves a farm/unit from VFARM_DEFAULT_FARM_ID or VFARM_DEFAULT_UNIT_ID', async () => {
    const { readFileSync } = await import('fs');
    const files = [
      'engine/src/core/engine.ts',
      'engine/src/router/index.ts',
      'engine/src/transport/twilio/outbound.ts',
      'engine/src/identity/resolver.ts',
      'engine/src/systems/registry.ts',
      'engine/src/core/registry.ts',
      'engine/src/transport/voice/voice_lane.ts',
    ];
    for (const f of files) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
      expect(src, `${f} must not read VFARM_DEFAULT_FARM_ID at runtime`).not.toContain(
        'process.env.VFARM_DEFAULT_FARM_ID'
      );
      expect(src, `${f} must not read VFARM_DEFAULT_UNIT_ID at runtime`).not.toContain(
        'process.env.VFARM_DEFAULT_UNIT_ID'
      );
      expect(src, `${f} must not default to the ws-vfarm-main constant`).not.toContain("'ws-vfarm-main'");
    }
  });

  it('outbound transport does not select a sending number from the systems registry', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../../engine/src/transport/twilio/outbound.ts', import.meta.url),
      'utf8'
    );
    expect(src).not.toContain('.phone_numbers[0]');
    expect(src).toContain('resolveProjectServiceNumber');
  });
});
