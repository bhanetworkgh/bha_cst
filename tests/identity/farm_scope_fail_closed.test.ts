/**
 * Item 2 — farm-scope security: fail closed when the authoritative farm-grant
 * lookup is unavailable, and never reuse stale `farm_ids`.
 *
 * Required behaviour under test:
 *   vFarm identity available + farm grants available -> verified farm scope
 *   vFarm identity available + farm-grant lookup fails  -> FAIL CLOSED
 *   unknown / revoked upstream person                  -> zero farm scope
 *   an empty grant list upstream                       -> zero farm scope
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_A = 'proj-vfarm-main';
const PHONE = '+15551112222';

type FarmGrantsBehaviour =
  | { kind: 'grants'; byUser: Record<string, string[]> }
  | { kind: 'fail' };

/** Live-mode adapter with controllable org-members and farm-grants responses. */
function makeLiveAdapter(members: string[], behaviour: FarmGrantsBehaviour) {
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
      if (behaviour.kind === 'fail') {
        // Network failure / 500 / unparseable body — all "unavailable".
        throw new Error('vFarm request failed (network error)');
      }
      const userId = decodeURIComponent(url.split('/users/')[1]?.split('/')[0] || '');
      return {
        ok: true,
        status: 200,
        json: async () => (behaviour.byUser[userId] ?? []).map((farm_id) => ({ farm_id })),
        text: async () => '',
      };
    }
    throw new Error(`Unmocked: ${url}`);
  });

  return {
    adapter: new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk',
      fetchFn: mockFetch as any,
    }),
    mockFetch,
  };
}

/** A locally-administered speaker whose recorded farm scope is deliberately STALE. */
function seedLocalSpeaker(adapter: VfarmTenantAdapter, personId: string, staleFarms: string[]) {
  adapter.registerSpeaker(PROJECT_A, {
    person_id: personId,
    phone_e164: PHONE,
    role: 'owner',
    farm_ids: staleFarms,
  });
}

function useAdapter(adapter: VfarmTenantAdapter) {
  CoreRegistry.registerTenant(
    {
      tenant_id: TENANT_ID,
      name: 't',
      status: 'active',
      adapter_type: 'vfarm',
      created_at: new Date().toISOString(),
    },
    adapter
  );
}

describe('Farm-scope fail-closed when the grant lookup is unavailable', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    vi.restoreAllMocks();
  });

  it('uses the verified grant list when it is available', async () => {
    const { adapter } = makeLiveAdapter(['usr_ok'], { kind: 'grants', byUser: { usr_ok: ['farm_a', 'farm_b'] } });
    seedLocalSpeaker(adapter, 'usr_ok', ['farm_stale']);
    useAdapter(adapter);

    const speaker = await CoreRegistry.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_A, phoneE164: PHONE });

    expect(speaker.is_known).toBe(true);
    expect(speaker.farm_ids).toEqual(['farm_a', 'farm_b']);
  });

  it('drops the stale farm scope when the grant lookup fails (adapter-down case)', async () => {
    const { adapter } = makeLiveAdapter(['usr_ok'], { kind: 'fail' });
    seedLocalSpeaker(adapter, 'usr_ok', ['farm_austin_main', 'farm_secret']);
    useAdapter(adapter);

    const speaker = await CoreRegistry.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_A, phoneE164: PHONE });

    // Identity itself survives (org membership was verified) ...
    expect(speaker.is_known).toBe(true);
    // ... but zero farm scope. The stale farm_ids are NOT reused as authorization.
    expect(speaker.farm_ids).toEqual([]);
  });

  it('treats an empty upstream grant list as "no farms", not as "keep the old ones"', async () => {
    const { adapter } = makeLiveAdapter(['usr_ok'], { kind: 'grants', byUser: { usr_ok: [] } });
    seedLocalSpeaker(adapter, 'usr_ok', ['farm_austin_main']);
    useAdapter(adapter);

    const speaker = await CoreRegistry.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_A, phoneE164: PHONE });

    expect(speaker.is_known).toBe(true);
    expect(speaker.farm_ids).toEqual([]);
  });

  it('gives a revoked upstream member no identity and no farm data', async () => {
    // The org no longer contains this person_id -> revoked upstream.
    const { adapter } = makeLiveAdapter(['usr_someone_else'], { kind: 'grants', byUser: {} });
    seedLocalSpeaker(adapter, 'usr_revoked', ['farm_austin_main']);
    useAdapter(adapter);

    const speaker = await CoreRegistry.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_A, phoneE164: PHONE });

    expect(speaker.is_known).toBe(false);
    expect(speaker.role).toBe('unknown');
    expect(speaker.permissions).toEqual([]);
    expect(speaker.farm_ids).toEqual([]);
    expect(speaker.customer_ref).toMatch(/^opaque_revoked_/);
  });

  it('gives an unregistered caller no identity and no farm data', async () => {
    const { adapter } = makeLiveAdapter(['usr_ok'], { kind: 'grants', byUser: { usr_ok: ['farm_a'] } });
    seedLocalSpeaker(adapter, 'usr_ok', ['farm_a']);
    useAdapter(adapter);

    const speaker = await CoreRegistry.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_A, phoneE164: '+15559990000' });

    expect(speaker.is_known).toBe(false);
    expect(speaker.farm_ids).toEqual([]);
  });

  it('pullSpeakers() also drops farm scope when the grant lookup fails', async () => {
    const { adapter } = makeLiveAdapter(['usr_ok'], { kind: 'fail' });
    seedLocalSpeaker(adapter, 'usr_ok', ['farm_austin_main']);
    useAdapter(adapter);

    const speakers = await adapter.pullSpeakers(TENANT_ID, PROJECT_A);

    expect(speakers).toHaveLength(1);
    expect(speakers[0].farm_ids).toEqual([]);
  });

  it('a zero-scope speaker cannot satisfy farm-specific authorization', async () => {
    const { adapter } = makeLiveAdapter(['usr_ok'], { kind: 'fail' });
    seedLocalSpeaker(adapter, 'usr_ok', ['farm_austin_main']);
    useAdapter(adapter);

    const speaker: SpeakerIdentity = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_A,
      phoneE164: PHONE,
    });

    // Mirror CoreEngine's farm-scope gate: status/images are refused with zero
    // granted farms, so no farm-specific payload can be served.
    const granted = speaker.farm_ids || [];
    expect(granted.length).toBe(0);

    // And the adapter's own farm authorization helper refuses the farm outright.
    const { assertSpeakerFarmAccess } = await import('../../engine/src/adapters/vfarm/authorization.js');
    expect(() => assertSpeakerFarmAccess(speaker, 'farm_austin_main', [])).toThrow();
  });

  it('the full-resolution path fails closed when org members are unavailable', async () => {
    // CoreRegistry.resolveSpeaker must never cache or return farm scope when the
    // adapter itself throws (upstream outage).
    const mockFetch = vi.fn(async () => {
      throw new Error('vFarm request timed out after 8000ms');
    });
    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://vfarm.test',
      apiKey: 'vk',
      fetchFn: mockFetch as any,
    });
    seedLocalSpeaker(adapter, 'usr_outage', ['farm_austin_main']);
    useAdapter(adapter);

    const speaker = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_A,
      phoneE164: PHONE,
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.farm_ids).toEqual([]);
    expect(speaker.customer_ref).toMatch(/^opaque_degraded_/);
  });

  it('never fabricates a unit_id the tenant adapter did not report', async () => {
    // vFarm exposes no unit identifier on org-member / farm-grant records, so
    // any unit_id here is invented. A fabricated one used to be forwarded to
    // vFarm, BHARAG and the media server as though it were real.
    DbClient.seedCustomer({
      tenant_id: TENANT_ID,
      project_id: PROJECT_A,
      phone_e164: '+15551234567',
      customer_ref: 'cust_probe',
      role: 'manager',
      farm_ids: ['farm_probe_1'],
    });

    const speaker = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_A,
      phoneE164: '+15551234567',
    });

    expect((speaker.unit_context as any)?.unit_id).toBeUndefined();
    // The farm is vFarm-authoritative and is still reported.
    expect((speaker.unit_context as any)?.farm_id).toBeTruthy();
    expect((speaker.farm_ids as string[]).length).toBeGreaterThan(0);
  });

  it('core engine does not substitute a farm id where a unit id is expected', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('../../engine/src/core/engine.ts', import.meta.url), 'utf8');
    expect(src, 'must not fall back to a farm id for unit_id').not.toMatch(
      /unit_context\?\.unit_id[^\n]*\|\|[^\n]*primaryFarmId/
    );
    expect(src, 'must not hardcode a unit id').not.toContain('unit_bay_04');

    const adapterSrc = readFileSync(
      new URL('../../engine/src/adapters/vfarm/index.ts', import.meta.url),
      'utf8'
    );
    // The adapter reports no unit_context.unit_id at all: vFarm does not supply
    // one on the org-member / farm-grant records this path reads.
    expect(adapterSrc.replace(/\/\/[^\n]*/g, '')).not.toContain('unit_bay_04');
    expect(adapterSrc.replace(/\/\/[^\n]*/g, '')).not.toMatch(/unit_id:\s*'/);
  });
});
