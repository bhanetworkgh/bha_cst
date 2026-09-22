/**
 * vFarm Live Speaker Resolution — Integration Tests
 *
 * Tests the live-mode enrichment chain for resolveSpeaker:
 *   CST local binding (phone → person_id)
 *     → GET /api/v1/users/{user_id}/farm-grants  → authoritative farm_ids
 *
 * All HTTP calls are mocked via injectable fetchFn.
 * No real vFarm API credentials are required.
 *
 * Test coverage:
 *   L1  — happy path: known speaker with live farm grants
 *   L2  — unknown phone (no local binding) → fail closed, no network call
 *   L3  — empty farm-grants list → is_known=true but farm_ids=[], scope=[]
 *   L4  — farm-grants API returns 5xx → fail closed, farm_ids=[] (no stale fallback)
 *   L5  — farm-grants network error → fail closed, farm_ids=[]
 *   L6  — out-of-scope access: speaker farm_ids do not include requested farm
 *   L7  — degraded state → throws (propagated to CoreRegistry for fail-closed handling)
 *   L8  — pullSpeakers in live mode: calls org-members, returns local binding set
 *   L9  — pullSpeakers in live mode: org-members API fails → returns local speakers (graceful)
 *   L10 — resolveSpeaker: multiple farm grants correctly merged into farm_ids
 */
import { describe, it, expect, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import type { FetchFn } from '../../engine/src/adapters/vfarm/live_client.js';

// ── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID  = 'tenant-vfarm-live-test';
const PROJECT_ID = 'proj-vfarm-live-test';
const ORG_ID     = 'org-vfarm-live-test';
const FARM_A     = 'farm_austin_main';
const FARM_B     = 'farm_dallas_north';
const PERSON_ID  = 'usr-live-001';
const PHONE      = '+15551110001';

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_GRANTS_SINGLE = {
  grants: [
    {
      farm_id: FARM_A,
      role: 'owner',
      granted_by: null,
      granted_at: '2025-01-01T00:00:00Z',
    },
  ],
  total: 1,
};

const MOCK_GRANTS_MULTI = {
  grants: [
    { farm_id: FARM_A, role: 'owner',   granted_by: null, granted_at: '2025-01-01T00:00:00Z' },
    { farm_id: FARM_B, role: 'manager', granted_by: null, granted_at: '2025-02-01T00:00:00Z' },
  ],
  total: 2,
};

const MOCK_GRANTS_EMPTY = { grants: [], total: 0 };

const MOCK_ORG_MEMBERS = [
  {
    user_id: PERSON_ID,
    email: 'jane@vfarm.example',
    name: 'Jane Owner',
    role: 'owner',
    granted_by: null,
    granted_at: '2025-01-01T00:00:00Z',
  },
];

// ── Mock fetch factory ────────────────────────────────────────────────────────

function makeMockFetch(routes: Record<string, { status: number; body: unknown }>): FetchFn {
  return async (url: string) => {
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const body = JSON.stringify(resp.body);
        return {
          ok: resp.status >= 200 && resp.status < 300,
          status: resp.status,
          json: async () => JSON.parse(body),
        } as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ detail: 'Not found' }),
    } as Response;
  };
}

// ── Adapter factory ───────────────────────────────────────────────────────────

/**
 * Build an adapter with a live client (injected fetchFn) and a registered speaker.
 * The project is also added to projectsMap so _getProjectOrgId works.
 */
function makeLiveAdapter(fetchFn: FetchFn): VfarmTenantAdapter {
  const adapter = new VfarmTenantAdapter(TENANT_ID, {
    baseUrl: 'https://mock.vfarm.test',
    apiKey:  'mock-api-key',
    fetchFn,
  });

  // Add project so org_id is resolvable
  adapter.addProject({
    project_id:     PROJECT_ID,
    tenant_id:      TENANT_ID,
    name:           'Live Test Project',
    status:         'active',
    tenant_org_id:  ORG_ID,
    capabilities:   { sms: true },
    speaker_policy: 'allowlist',
  });

  // Register local phone→person_id binding (CST's authoritative source)
  adapter.registerSpeaker(PROJECT_ID, {
    person_id:  PERSON_ID,
    phone_e164: PHONE,
    role:       'owner',
    farm_ids:   [FARM_A],   // local snapshot; live path overrides with API
    name:       'Jane Owner',
  });

  return adapter;
}

// ════════════════════════════════════════════════════════════════════════════════
// § Live Speaker Resolution Tests
// ════════════════════════════════════════════════════════════════════════════════

describe('vFarm Live Speaker Resolution', () => {

  // L1: Happy path — known speaker, live farm grants returned
  it('L1: resolves a known speaker with authoritative farm grants from live API', async () => {
    const adapter = makeLiveAdapter(
      makeMockFetch({
        [`/users/${PERSON_ID}/farm-grants`]: { status: 200, body: MOCK_GRANTS_SINGLE },
      }),
    );

    const identity = await adapter.resolveSpeaker({
      tenantId:  TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: PHONE,
    });

    expect(identity.is_known).toBe(true);
    expect(identity.person_id).toBe(PERSON_ID);
    expect(identity.role).toBe('owner');
    expect(identity.farm_ids).toEqual([FARM_A]);
    expect(identity.permissions).toContain('read:telemetry');
    expect(identity.permissions).toContain('write:settings');
    expect(identity.phone_e164).toBe(PHONE);
    expect(identity.tenant_id).toBe(TENANT_ID);
    expect(identity.project_id).toBe(PROJECT_ID);
    // unit_context should reflect the live farm
    expect(identity.unit_context).toBeDefined();
    expect((identity.unit_context as any).farm_id).toBe(FARM_A);
  });

  // L2: Unknown phone — no local binding → fail closed, network NOT called
  it('L2: unknown phone (no local binding) returns is_known=false without any network call', async () => {
    let fetchCalled = false;
    const adapter = makeLiveAdapter(async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => MOCK_GRANTS_SINGLE } as Response;
    });

    const identity = await adapter.resolveSpeaker({
      tenantId:  TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15550009999',  // no local binding for this number
    });

    expect(identity.is_known).toBe(false);
    expect(identity.farm_ids).toHaveLength(0);
    expect(identity.permissions).toHaveLength(0);
    expect(identity.role).toBe('unknown');
    expect(fetchCalled).toBe(false);  // must not touch the network
  });

  // L3: Empty farm-grants list — identity confirmed, zero scope
  it('L3: empty farm-grants list returns is_known=true with zero scope', async () => {
    const adapter = makeLiveAdapter(
      makeMockFetch({
        [`/users/${PERSON_ID}/farm-grants`]: { status: 200, body: MOCK_GRANTS_EMPTY },
      }),
    );

    const identity = await adapter.resolveSpeaker({
      tenantId:  TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: PHONE,
    });

    // Identity confirmed via local binding; scope revoked by live API
    expect(identity.is_known).toBe(true);
    expect(identity.person_id).toBe(PERSON_ID);
    expect(identity.farm_ids).toHaveLength(0);
    // unit_context should be absent when there are no farms
    expect(identity.unit_context).toBeUndefined();
    // Permissions still reflect role (identity layer), but farm_ids gate resource access
    expect(identity.permissions.length).toBeGreaterThan(0);
  });

  // L4: Farm-grants API returns 5xx → fail closed, do NOT fall back to local farm_ids
  it('L4: farm-grants 5xx returns is_known=true with empty farm_ids (no stale fallback)', async () => {
    const adapter = makeLiveAdapter(
      makeMockFetch({
        [`/users/${PERSON_ID}/farm-grants`]: { status: 500, body: { detail: 'Internal Server Error' } },
      }),
    );

    const identity = await adapter.resolveSpeaker({
      tenantId:  TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: PHONE,
    });

    expect(identity.is_known).toBe(true);    // identity confirmed
    expect(identity.farm_ids).toHaveLength(0);  // scope denied on upstream failure
    // Must NOT fall back to locally-stored farm_ids
    expect(identity.farm_ids).not.toContain(FARM_A);
  });

  // L5: Farm-grants network error (fetch throws) → fail closed
  it('L5: farm-grants network error returns is_known=true with empty farm_ids (fail closed)', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.test',
      apiKey:  'mock-api-key',
      fetchFn: async () => { throw new Error('ECONNREFUSED: connection refused'); },
    });
    adapter.addProject({
      project_id:     PROJECT_ID,
      tenant_id:      TENANT_ID,
      name:           'Live Test Project',
      status:         'active',
      tenant_org_id:  ORG_ID,
      capabilities:   { sms: true },
      speaker_policy: 'allowlist',
    });
    adapter.registerSpeaker(PROJECT_ID, {
      person_id:  PERSON_ID,
      phone_e164: PHONE,
      role:       'manager',
      farm_ids:   [FARM_A],
      name:       'Jane Manager',
    });

    const identity = await adapter.resolveSpeaker({
      tenantId:  TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: PHONE,
    });

    expect(identity.is_known).toBe(true);
    expect(identity.farm_ids).toHaveLength(0);
    expect(identity.farm_ids).not.toContain(FARM_A);
  });

  // L6: Out-of-scope farm access — speaker's live grants do not include requested farm
  it('L6: speaker granted FARM_B but not FARM_A — resolved identity carries only FARM_B', async () => {
    const adapter = makeLiveAdapter(
      makeMockFetch({
        [`/users/${PERSON_ID}/farm-grants`]: {
          status: 200,
          body: {
            grants: [{ farm_id: FARM_B, role: 'tech', granted_by: null, granted_at: '2025-01-01T00:00:00Z' }],
            total: 1,
          },
        },
      }),
    );

    const identity = await adapter.resolveSpeaker({
      tenantId:  TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: PHONE,
    });

    expect(identity.is_known).toBe(true);
    expect(identity.farm_ids).toContain(FARM_B);
    expect(identity.farm_ids).not.toContain(FARM_A);
    // Cabinet/telemetry authorization for FARM_A must be denied by caller checking farm_ids
    expect(identity.farm_ids.includes(FARM_A)).toBe(false);
  });

  // L7: Degraded state → propagates error for CoreRegistry to handle fail-closed
  it('L7: degraded adapter throws so CoreRegistry can return safe opaque identity', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.test',
      apiKey:  'mock-api-key',
      fetchFn: makeMockFetch({}),
    });
    adapter.registerSpeaker(PROJECT_ID, {
      person_id:  PERSON_ID,
      phone_e164: PHONE,
      role:       'owner',
      farm_ids:   [FARM_A],
      name:       'Jane Owner',
    });
    adapter.setDegraded(true);

    await expect(
      adapter.resolveSpeaker({ tenantId: TENANT_ID, projectId: PROJECT_ID, phoneE164: PHONE }),
    ).rejects.toThrow('vFarm Adapter API unavailable');
  });

  // L10: Multiple farm grants correctly merged into farm_ids
  it('L10: multiple live farm grants are all reflected in farm_ids', async () => {
    const adapter = makeLiveAdapter(
      makeMockFetch({
        [`/users/${PERSON_ID}/farm-grants`]: { status: 200, body: MOCK_GRANTS_MULTI },
      }),
    );

    const identity = await adapter.resolveSpeaker({
      tenantId:  TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: PHONE,
    });

    expect(identity.is_known).toBe(true);
    expect(identity.farm_ids).toHaveLength(2);
    expect(identity.farm_ids).toContain(FARM_A);
    expect(identity.farm_ids).toContain(FARM_B);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// § pullSpeakers in Live Mode
// ════════════════════════════════════════════════════════════════════════════════

describe('vFarm pullSpeakers — live mode', () => {

  // L8: pullSpeakers calls org-members and returns locally-bound speakers
  it('L8: pullSpeakers in live mode calls org-members API and returns local binding set', async () => {
    let orgMembersCalled = false;
    const adapter = makeLiveAdapter(async (url: string) => {
      if (url.includes(`/organizations/${ORG_ID}/users`)) {
        orgMembersCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => MOCK_ORG_MEMBERS,
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });

    const speakers = await adapter.pullSpeakers(TENANT_ID, PROJECT_ID);

    // org-members endpoint must have been called
    expect(orgMembersCalled).toBe(true);
    // Returns the locally-bound speakers (phone↔person_id bindings from CST)
    expect(speakers).toHaveLength(1);
    expect(speakers[0].person_id).toBe(PERSON_ID);
    expect(speakers[0].phone_e164).toBe(PHONE);
  });

  // L9: pullSpeakers — org-members API fails → returns local speakers gracefully
  it('L9: pullSpeakers survives org-members failure and returns local speakers', async () => {
    const adapter = makeLiveAdapter(
      makeMockFetch({
        [`/organizations/${ORG_ID}/users`]: { status: 503, body: { detail: 'Unavailable' } },
      }),
    );

    // Should not throw; returns locally-bound set
    const speakers = await adapter.pullSpeakers(TENANT_ID, PROJECT_ID);
    expect(speakers).toHaveLength(1);
    expect(speakers[0].person_id).toBe(PERSON_ID);
  });
});
