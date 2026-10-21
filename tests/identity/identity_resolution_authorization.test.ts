/**
 * Identity resolution — upstream authorization correctness.
 *
 * The production incident this covers: an authorized vFarm user's inbound
 * voice/SMS call was answered with a safe generic response instead of farm
 * data, because the live membership check could not match the caller's local
 * customer reference against the vFarm organization member list.
 *
 * The contract exercised here:
 *
 *   - the vFarm organization member list is the AUTHORITY on membership and
 *     role, and the vFarm farm-grant list is the AUTHORITY on farm scope;
 *   - a local customer row, on its own, authorizes NOTHING;
 *   - an upstream refusal, timeout, 5xx, malformed body or missing field
 *     fails CLOSED and is reported as a resolution failure — never as
 *     "revoked" and never as success;
 *   - a transient upstream failure must not be persisted as a confirmed
 *     revocation;
 *   - the failure must be DIAGNOSABLE from the log, and the log must not
 *     carry credentials, phone numbers, provider ids or personal data.
 *
 * Every upstream interaction is a deterministic mock. No live vFarm, no real
 * identifiers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { VfarmApiError } from '../../engine/src/adapters/vfarm/http_client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { Logger } from '../../engine/src/config/logger.js';

const BASE = 'https://vfarm.test';
const TOKEN = 'test_admin_jwt';
const ORG = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';
const USER_ID = 'debf555c-b37d-4e92-bb15-597e169f1b38';
const CALLER = '+15551234567';
const FARM_A = 'ed95e120-1111-4aaa-8bbb-21dde23e0001';
const FARM_B = 'ed95e120-2222-4aaa-8bbb-21dde23e0002';

const member = (over: Record<string, unknown> = {}) => ({
  user_id: USER_ID,
  email: 'farmer@vfarm.test',
  name: 'Farmer',
  role: 'admin',
  granted_by: null,
  granted_at: '2026-07-10T16:16:47.012386Z',
  ...over,
});

const ok = (body: unknown): any => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * A fetch mock that answers the two endpoints the live check uses:
 *   GET /api/v1/organizations/{org}/users   → the membership authority
 *   GET /api/v1/users/{user_id}/farm-grants → the farm-scope authority
 */
function upstreamMock(opts: {
  members?: unknown;
  grants?: unknown;
  membersStatus?: number;
  grantsStatus?: number;
  throwOnMembers?: Error;
} = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes('/farm-grants')) {
      if (opts.grantsStatus && opts.grantsStatus >= 400) {
        return { ok: false, status: opts.grantsStatus, json: async () => ({}), text: async () => '' };
      }
      return ok(opts.grants ?? [{ farm_id: FARM_A }, { farm_id: FARM_B }]);
    }
    if (url.includes('/users')) {
      if (opts.throwOnMembers) throw opts.throwOnMembers;
      if (opts.membersStatus && opts.membersStatus >= 400) {
        return { ok: false, status: opts.membersStatus, json: async () => ({}), text: async () => '' };
      }
      return ok(opts.members ?? [member()]);
    }
    return ok([]);
  }) as any;
}

function makeAdapter(fetchFn: any): VfarmTenantAdapter {
  const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
    baseUrl: BASE,
    apiKey: 'test_farm_key_value',
    apiToken: TOKEN,
    tenantId: 'tenant-vfarm-01',
    timeoutMs: 2000,
    fetchFn,
  } as any);
  adapter.registerSpeaker('proj-vfarm-main', {
    person_id: USER_ID,
    phone_e164: CALLER,
    role: 'manager',
    farm_ids: ['stale_local_farm'],
  } as any);
  return adapter;
}

describe('identity resolution — a valid, correctly scoped vFarm identity', () => {
  it('resolves the upstream role and the authoritative farm scope', async () => {
    const adapter = makeAdapter(upstreamMock());

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(true);
    // vFarm role `admin` maps to the CST `owner` role.
    expect(speaker.role).toBe('owner');
    // The UPSTREAM grant list wins outright — the stale local farm id is
    // replaced, not merged.
    expect(speaker.farm_ids).toEqual([FARM_A, FARM_B]);
    expect(speaker.farm_ids).not.toContain('stale_local_farm');
  });

  it('matches the upstream member by id even when the case or padding differs', async () => {
    // The id comparison used to be exact and untrimmed while the email and
    // name comparisons were normalised, so a reference differing only by case
    // silently failed to match.
    const adapter = makeAdapter(upstreamMock({ members: [member({ user_id: USER_ID.toUpperCase() })] }));

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(true);
  });

  it('a valid identity with no device or location data is a KNOWN identity with an empty scope', async () => {
    // The user-to-location/device association is a separate upstream
    // dependency. Its absence must not be reported as an identity failure:
    // the membership and the grants are what authorize, and here there is
    // simply nothing granted.
    const adapter = makeAdapter(upstreamMock({ grants: [] }));

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(true);
    expect(speaker.role).toBe('owner');
    // Known identity, empty scope — not `opaque_revoked`.
    expect(speaker.farm_ids).toEqual([]);
    expect(speaker.customer_ref).not.toContain('opaque_');
  });
});

describe('identity resolution — a local record alone authorizes nothing', () => {
  it('denies when the local reference identifies no upstream member', async () => {
    // The local row is complete (owner role, farm scope) but its reference is
    // not a vFarm member. The upstream is the authority, so this is denied.
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: BASE,
      apiKey: 'test_farm_key_value',
      apiToken: TOKEN,
      tenantId: 'tenant-vfarm-01',
      timeoutMs: 2000,
      fetchFn: upstreamMock(),
    } as any);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: '+15551234567',
      phone_e164: CALLER,
      role: 'owner',
      farm_ids: ['farm_from_the_local_row'],
    } as any);

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.role).toBe('unknown');
    expect(speaker.farm_ids).toEqual([]);
    expect(speaker.customer_ref).toContain('opaque_revoked');
  });

  it('denies when the upstream organization has no members at all', async () => {
    const adapter = makeAdapter(upstreamMock({ members: [] }));

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.farm_ids).toEqual([]);
  });

  it('denies a caller that is not registered for the project', async () => {
    const adapter = makeAdapter(upstreamMock());

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-dallas',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.farm_ids).toEqual([]);
  });
});

describe('identity resolution — upstream failures fail closed', () => {
  it('a 401 from the membership endpoint denies without leaking details', async () => {
    const adapter = makeAdapter(upstreamMock({ membersStatus: 401 }));

    await expect(
      adapter.resolveSpeaker({
        tenantId: 'tenant-vfarm-01',
        projectId: 'proj-vfarm-main',
        phoneE164: CALLER,
      }),
    ).rejects.toBeInstanceOf(VfarmApiError);
  });

  it('a 403 from the membership endpoint denies', async () => {
    const adapter = makeAdapter(upstreamMock({ membersStatus: 403 }));

    await expect(
      adapter.resolveSpeaker({
        tenantId: 'tenant-vfarm-01',
        projectId: 'proj-vfarm-main',
        phoneE164: CALLER,
      }),
    ).rejects.toBeInstanceOf(VfarmApiError);
  });

  it('a 5xx from the membership endpoint denies', async () => {
    const adapter = makeAdapter(upstreamMock({ membersStatus: 503 }));

    await expect(
      adapter.resolveSpeaker({
        tenantId: 'tenant-vfarm-01',
        projectId: 'proj-vfarm-main',
        phoneE164: CALLER,
      }),
    ).rejects.toBeInstanceOf(VfarmApiError);
  });

  it('a malformed body denies (schema validation failure)', async () => {
    // Missing the required `user_id` / `granted_at` fields.
    const adapter = makeAdapter(upstreamMock({ members: [{ email: 'x@vfarm.test' }] }));

    await expect(
      adapter.resolveSpeaker({
        tenantId: 'tenant-vfarm-01',
        projectId: 'proj-vfarm-main',
        phoneE164: CALLER,
      }),
    ).rejects.toBeInstanceOf(VfarmApiError);
  });

  it('a network failure denies', async () => {
    const adapter = makeAdapter(upstreamMock({ throwOnMembers: new Error('socket hang up') }));

    await expect(
      adapter.resolveSpeaker({
        tenantId: 'tenant-vfarm-01',
        projectId: 'proj-vfarm-main',
        phoneE164: CALLER,
      }),
    ).rejects.toBeInstanceOf(VfarmApiError);
  });

  it('a transient upstream failure is reported as DEGRADED, never as a confirmed revocation', async () => {
    // A timeout is not a revocation. The registry must not turn it into
    // `opaque_revoked`, because that would persist a transient outage as a
    // confirmed denial in the cache.
    CoreRegistry.resetToDefault();
    const adapter = makeAdapter(upstreamMock({ membersStatus: 503 }));
    const registry = CoreRegistry as any;
    registry.registerTenant({ tenant_id: 'tenant-vfarm-01', name: 'vFarm', adapter_type: 'vfarm' } as any, adapter);

    const speaker = await registry.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.resolution_state).toBe('degraded');
    expect(speaker.customer_ref).toContain('opaque_degraded');
    expect(speaker.customer_ref).not.toContain('opaque_revoked');
    expect(speaker.farm_ids).toEqual([]);
  });

  it('a failed grant lookup drops the farm scope rather than reusing the stale local scope', async () => {
    const adapter = makeAdapter(upstreamMock({ grantsStatus: 500 }));

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    // Identity is still established (membership is readable) but the scope
    // is not: the grant list is the authority on farm scope and it could not
    // be read, so no farm scope is claimed.
    expect(speaker.is_known).toBe(true);
    expect(speaker.farm_ids).toEqual([]);
    expect(speaker.farm_ids).not.toContain('stale_local_farm');
  });
});

describe('identity resolution — revocation and cache', () => {
  beforeEach(() => {
    CoreRegistry.resetToDefault();
  });

  it('an upstream revocation denies, even while a local record exists', async () => {
    const adapter = makeAdapter(upstreamMock({ members: [member({ user_id: 'someone-else' })] }));

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.customer_ref).toContain('opaque_revoked');
    expect(speaker.farm_ids).toEqual([]);
  });

  it('a cached identity cannot authorize a caller after the upstream revokes them', async () => {
    const registry = CoreRegistry as any;
    let revoked = false;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/farm-grants')) return ok([{ farm_id: FARM_A }]);
      return ok(revoked ? [member({ user_id: 'someone-else' })] : [member()]);
    }) as any;
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: BASE,
      apiKey: 'test_farm_key_value',
      apiToken: TOKEN,
      tenantId: 'tenant-vfarm-01',
      timeoutMs: 2000,
      fetchFn,
    } as any);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: USER_ID,
      phone_e164: CALLER,
      role: 'owner',
      farm_ids: [],
    } as any);
    registry.registerTenant({ tenant_id: 'tenant-vfarm-01', name: 'vFarm', adapter_type: 'vfarm' } as any, adapter);

    const first = await registry.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });
    expect(first.is_known).toBe(true);

    // The upstream revokes the caller.
    revoked = true;
    registry.invalidateSpeakerCache('tenant-vfarm-01', 'proj-vfarm-main', CALLER);

    const second = await registry.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });
    expect(second.is_known).toBe(false);
    expect(second.farm_ids).toEqual([]);
  });
});

describe('identity resolution — diagnostics', () => {
  let logLines: string[] = [];

  beforeEach(() => {
    logLines = [];
    for (const level of ['info', 'warn', 'error', 'audit', 'infra'] as const) {
      vi.spyOn(Logger as any, level).mockImplementation((...args: any[]) => {
        logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says WHY the membership check failed, without logging any identifier', async () => {
    const adapter = makeAdapter(upstreamMock({ members: [member({ user_id: 'someone-else' })] }));

    await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    const stream = logLines.join('\n');
    expect(stream).toContain('local_reference_matches_no_member');
    // Nothing identifying.
    expect(stream).not.toContain(CALLER);
    expect(stream).not.toContain(USER_ID);
    expect(stream).not.toContain('test_farm_key_value');
    expect(stream).not.toContain(TOKEN);
    expect(stream).not.toContain('farmer@vfarm.test');
    expect(stream).not.toContain(FARM_A);
  });

  it('distinguishes an empty organization from a reference that matches no member', async () => {
    const adapter = makeAdapter(upstreamMock({ members: [] }));
    await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: CALLER,
    });

    const stream = logLines.join('\n');
    expect(stream).toContain('upstream_organization_has_no_members');
  });
});
