/**
 * vFarm Integration Tests — Speaker Resolution & Cabinet/LM7W Authorization
 *
 * All HTTP calls are mocked via injectable fetchFn.
 * No real vFarm credentials are required.
 *
 * Speaker identity:
 *   Tests 1–6: valid member, unknown phone, revoked member, tenant/project isolation,
 *              farm-scope isolation, phone_e164 limitation
 *
 * Cabinet / LM7W:
 *   Tests 7–16: valid config, authorized farm, unauthorized farm, inventory failure,
 *               unit-config failure, invalid config_hash, config-detail failure,
 *               404 → null, 401/403 → null, 5xx/network → null
 */
import { describe, it, expect } from 'vitest';
import { VfarmTenantAdapter, buildVfarmAdapterConfigFromEnv } from '../../engine/src/adapters/vfarm/index.js';
import { VfarmLiveClient, VfarmHttpError, VfarmNetworkError } from '../../engine/src/adapters/vfarm/live_client.js';
import type { FetchFn } from '../../engine/src/adapters/vfarm/live_client.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

// ── Shared test fixtures ─────────────────────────────────────────────────────

const TENANT_ID = 'tenant-vfarm-test';
const PROJECT_ID = 'proj-vfarm-test';
const FARM_ID = 'farm_austin_main';
const SERIAL = 'LM7W-SN-001234';
const CONFIG_HASH = 'a'.repeat(64); // valid 64-char hex string

const MOCK_ORG_MEMBERS = [
  {
    user_id: 'usr-abc-001',
    email: 'owner@vfarm.example',
    name: 'Jane Owner',
    role: 'owner',
    granted_by: null,
    granted_at: '2025-01-01T00:00:00Z',
  },
];

const MOCK_INVENTORY_RESPONSE = {
  serial_number: SERIAL,
  catalog_id: 'cat-lm7w',
  device_name: 'LM7W Cabinet',
  family_id: 'fam-lm7w',
  family_label: 'LM7W',
  catalog_is_active: true,
  status: 'active',
  farm_id: FARM_ID,          // authoritative farm_id
  farm_name: 'Austin Main',
  org_id: 'org-vfarm-austin',
  org_name: 'vFarm Austin',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-06-01T00:00:00Z',
};

const MOCK_UNIT_CONFIG_RESPONSE = {
  serial_number: SERIAL,
  current: {
    config_hash: CONFIG_HASH,
    name: 'Standard LM7W Config',
    spec_version: '1.0',
    cad_revision: 'rev-A',
    effective_at: '2025-06-01T00:00:00Z',
  },
  history: [],
};

const MOCK_CONFIG_RESPONSE = {
  config_hash: CONFIG_HASH,
  name: 'Standard LM7W Config',
  spec_version: '1.0',
  cad_revision: 'rev-A',
  created_at: '2025-01-01T00:00:00Z',
  parts: [
    {
      part_code: 'PCB-001',
      part_kind: 'board',
      length_mm: 200,
      width_mm: 150,
      height_mm: 10,
      attributes: { material: 'FR4' },
      quantity: 1,
    },
  ],
};

// ── Mock fetch factory ────────────────────────────────────────────────────────

/**
 * Build a mock fetchFn that returns specific responses based on URL path.
 * Any URL not matched returns 404.
 */
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
    // Default: 404
    return {
      ok: false,
      status: 404,
      json: async () => ({ detail: 'Not found' }),
    } as Response;
  };
}

/** Default farm-grants response for usr-abc-001 → FARM_ID (farm_austin_main) */
const DEFAULT_FARM_GRANTS_BODY = {
  grants: [{ farm_id: FARM_ID, role: 'owner', granted_by: null, granted_at: '2025-01-01T00:00:00Z' }],
  total: 1,
};

/** Create an adapter pre-configured with a mock fetch and a registered speaker.
 *
 * The factory automatically provides a farm-grants route for usr-abc-001 so that
 * resolveSpeaker (which now calls /api/v1/users/{user_id}/farm-grants in live mode)
 * returns the expected farm_ids without 404-ing.  Caller-supplied routes take
 * precedence over the default, allowing cabinet tests to override as needed.
 */
function makeAdapterWithLiveClient(
  fetchFn: FetchFn,
  opts: { orgId?: string } = {},
): VfarmTenantAdapter {
  const adapter = new VfarmTenantAdapter(TENANT_ID, {
    baseUrl: 'https://mock.vfarm.test',
    apiKey: 'mock-api-key',
    fetchFn,
  });
  // Register a speaker with a known phone binding
  adapter.registerSpeaker(PROJECT_ID, {
    person_id: 'usr-abc-001',
    phone_e164: '+15551110001',
    role: 'owner',
    farm_ids: [FARM_ID],
    name: 'Jane Owner',
  });
  return adapter;
}

/**
 * Build a mock fetchFn that always handles farm-grants for usr-abc-001,
 * plus any extra routes supplied by the caller. This ensures speaker tests
 * work correctly when the adapter has a live client.
 */
function makeMockFetchWithGrants(
  extraRoutes: Record<string, { status: number; body: unknown }> = {},
): FetchFn {
  const routes: Record<string, { status: number; body: unknown }> = {
    '/users/usr-abc-001/farm-grants': { status: 200, body: DEFAULT_FARM_GRANTS_BODY },
    ...extraRoutes,
  };
  return makeMockFetch(routes);
}


/** Build a known SpeakerIdentity for cabinet tests */
function makeKnownSpeaker(farmIds: string[] = [FARM_ID]): SpeakerIdentity {
  return {
    person_id: 'usr-abc-001',
    customer_ref: 'cust_usr-abc-001',
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    phone_e164: '+15551110001',
    is_known: true,
    role: 'owner',
    permissions: ['farm:read', 'cabinet:query'],
    farm_ids: farmIds,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § Speaker / Identity Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('vFarm Integration — Speaker Identity', () => {

  // Test 1: Valid upstream organization member with local phone binding
  it('Test 1: resolves a known speaker that has a local phone binding', async () => {
    // Use makeMockFetchWithGrants so the live farm-grants call returns FARM_ID
    const adapter = makeAdapterWithLiveClient(makeMockFetchWithGrants());

    const identity = await adapter.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15551110001',
    });

    expect(identity.is_known).toBe(true);
    expect(identity.person_id).toBe('usr-abc-001');
    expect(identity.role).toBe('owner');
    expect(identity.farm_ids).toContain(FARM_ID);
    expect(identity.phone_e164).toBe('+15551110001');
    expect(identity.tenant_id).toBe(TENANT_ID);
    expect(identity.project_id).toBe(PROJECT_ID);
  });

  // Test 2: Unknown/missing local phone binding fails closed
  it('Test 2: phone with no local binding returns is_known=false (fail closed)', async () => {
    const adapter = makeAdapterWithLiveClient(makeMockFetch({}));

    // +15559990099 is not in any local speakersMap
    const identity = await adapter.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15559990099',
    });

    expect(identity.is_known).toBe(false);
    expect(identity.farm_ids).toHaveLength(0);
    expect(identity.permissions).toHaveLength(0);
    expect(identity.role).toBe('unknown');
    // Must not expose any inventd phone-to-user mapping
    expect(identity.person_id).not.toContain('usr-abc');
  });

  // Test 3: Upstream member removed/revoked → speaker resolution fails closed
  it('Test 3: removed speaker (post-revoke) returns is_known=false', async () => {
    // Grants route present so the "before" check resolves correctly
    const adapter = makeAdapterWithLiveClient(makeMockFetchWithGrants());

    // Verify the speaker is known before removal
    const before = await adapter.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15551110001',
    });
    expect(before.is_known).toBe(true);

    // Simulate revocation in vFarm → remove from local binding
    adapter.removeSpeaker(PROJECT_ID, '+15551110001');

    const after = await adapter.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15551110001',
    });

    expect(after.is_known).toBe(false);
    expect(after.farm_ids).toHaveLength(0);
    expect(after.role).toBe('unknown');
  });

  // Test 4: Tenant/project isolation — same phone on different project = not known
  it('Test 4: tenant/project isolation — speaker not visible across projects', async () => {
    const adapter = makeAdapterWithLiveClient(makeMockFetch({}));

    // The speaker is registered only in PROJECT_ID
    // Querying a different projectId must fail closed
    const identity = await adapter.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: 'proj-other-tenant',
      phoneE164: '+15551110001',
    });

    expect(identity.is_known).toBe(false);
    expect(identity.farm_ids).toHaveLength(0);
  });

  // Test 5: Farm-scope isolation — speaker known but only for different farm
  it('Test 5: farm-scope isolation — speaker farm_ids does not include requested farm', async () => {
    // Grants route returns only FARM_ID (farm_austin_main); validates isolation
    const adapter = makeAdapterWithLiveClient(makeMockFetchWithGrants());

    // Registered with FARM_ID = 'farm_austin_main'
    const identity = await adapter.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15551110001',
    });

    expect(identity.is_known).toBe(true);
    expect(identity.farm_ids).not.toContain('farm_dallas_north');
    // The speaker cannot access dallas farm — it's not in their farm_ids
    expect(identity.farm_ids).toContain('farm_austin_main');
  });

  // Test 6: No invented phone_e164 mapping — vFarm API does not return phone fields
  it('Test 6: vFarm org member response has no phone field — mapping must come from local CST binding only', async () => {
    // The vFarm API returns: user_id, email, name, role, granted_by, granted_at
    // It does NOT return phone / phone_number / phone_e164 / mobile
    // This test verifies our schema does not invent a phone-to-email/name heuristic

    const orgMember = MOCK_ORG_MEMBERS[0];

    // Confirm the upstream object has no phone field
    expect((orgMember as any).phone).toBeUndefined();
    expect((orgMember as any).phone_e164).toBeUndefined();
    expect((orgMember as any).phone_number).toBeUndefined();
    expect((orgMember as any).mobile).toBeUndefined();

    // An adapter without a local binding for this user_id should fail closed
    const adapterWithoutBinding = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'mock-api-key',
      fetchFn: makeMockFetch({
        '/organizations/': { status: 200, body: MOCK_ORG_MEMBERS },
      }),
    });

    // Phone +15559999999 has no local binding registered
    const identity = await adapterWithoutBinding.resolveSpeaker({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      phoneE164: '+15559999999',
    });

    expect(identity.is_known).toBe(false);
    expect(identity.farm_ids).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § Cabinet / LM7W Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('vFarm Integration — Cabinet / LM7W Authorization', () => {

  // Test 7: Valid cabinet configuration — full happy-path chain
  it('Test 7: resolves a valid cabinet config via the full authorization chain', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}/config`]: { status: 200, body: MOCK_UNIT_CONFIG_RESPONSE },
        [`/inventory/${SERIAL}`]: { status: 200, body: MOCK_INVENTORY_RESPONSE },
        [`/configs/${CONFIG_HASH}`]: { status: 200, body: MOCK_CONFIG_RESPONSE },
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).not.toBeNull();
    expect(config!.serial).toBe(SERIAL);
    expect(config!.farm_id).toBe(FARM_ID);          // authoritative from inventory
    expect(config!.config_hash).toBe(CONFIG_HASH);
    expect(config!.status).toBe('ok');
    expect(config!.source).toBe('lm7w');
    expect(config!.summary).toContain('Standard LM7W Config');
    expect(config!.summary).toContain('1 parts');
  });

  // Test 8: Cabinet belongs to authorized farm
  it('Test 8: cabinet is authorized when inventory.farm_id ∈ speaker.farm_ids', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}/config`]: { status: 200, body: MOCK_UNIT_CONFIG_RESPONSE },
        [`/inventory/${SERIAL}`]: { status: 200, body: MOCK_INVENTORY_RESPONSE },
        [`/configs/${CONFIG_HASH}`]: { status: 200, body: MOCK_CONFIG_RESPONSE },
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID, 'farm_other']);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).not.toBeNull();
    expect(config!.farm_id).toBe(FARM_ID);
  });

  // Test 9: Cabinet belongs to farm outside speaker's authorized farm_ids → deny
  it('Test 9: denies cabinet access when inventory.farm_id ∉ speaker.farm_ids', async () => {
    const inventoryWithDifferentFarm = {
      ...MOCK_INVENTORY_RESPONSE,
      farm_id: 'farm_dallas_north',  // different farm than speaker has
    };

    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 200, body: inventoryWithDifferentFarm },
      }),
    );

    // Speaker only has access to FARM_ID ('farm_austin_main')
    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    // Must deny because inventory.farm_id = 'farm_dallas_north' ∉ speaker.farm_ids
    expect(config).toBeNull();
  });

  // Test 10: Inventory lookup failure → fail closed
  it('Test 10: inventory lookup failure returns null (fail closed)', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        // inventory endpoint throws network error → unmapped → 404
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  // Test 11: Unit-config lookup failure → fail closed
  it('Test 11: unit-config lookup failure returns null (fail closed)', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 200, body: MOCK_INVENTORY_RESPONSE },
        // unit config endpoint not mapped → 404
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  // Test 12: Invalid/malformed config_hash → fail closed
  it('Test 12: malformed config_hash in unit-config response causes fail-closed null', async () => {
    const badUnitConfig = {
      ...MOCK_UNIT_CONFIG_RESPONSE,
      current: {
        ...MOCK_UNIT_CONFIG_RESPONSE.current,
        config_hash: 'not-a-valid-hash',  // fails ^[0-9a-f]{64}$ pattern
      },
    };

    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 200, body: MOCK_INVENTORY_RESPONSE },
        [`/inventory/${SERIAL}/config`]: { status: 200, body: badUnitConfig },
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    // Zod parse of bad unit config throws → adapter catches and returns null
    expect(config).toBeNull();
  });

  // Test 13: Config-detail lookup failure → fail closed
  it('Test 13: config-detail lookup failure returns null (fail closed)', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 200, body: MOCK_INVENTORY_RESPONSE },
        [`/inventory/${SERIAL}/config`]: { status: 200, body: MOCK_UNIT_CONFIG_RESPONSE },
        // config detail not mapped → 404
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  // Test 14: vFarm 404 → safe null behavior
  it('Test 14: vFarm 404 on inventory returns null without throwing', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 404, body: { detail: 'Not found' } },
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  // Test 15: vFarm 401/403 → safe null behavior
  it('Test 15: vFarm 401 auth error returns null without leaking info', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 401, body: { detail: 'Unauthorized' } },
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  it('Test 15b: vFarm 403 forbidden returns null without leaking info', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 403, body: { detail: 'Forbidden' } },
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  // Test 16: vFarm 5xx / network / timeout → fail closed
  it('Test 16: vFarm 5xx server error returns null (fail closed, no crash)', async () => {
    const adapter = makeAdapterWithLiveClient(
      makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 500, body: { detail: 'Internal Server Error' } },
      }),
    );

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  it('Test 16b: network error (exception thrown by fetch) returns null (fail closed)', async () => {
    const networkErrorFetch: FetchFn = async () => {
      throw new Error('ECONNREFUSED: Connection refused');
    };

    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'mock-api-key',
      fetchFn: networkErrorFetch,
    });

    adapter.registerSpeaker(PROJECT_ID, {
      person_id: 'usr-abc-001',
      phone_e164: '+15551110001',
      role: 'owner',
      farm_ids: [FARM_ID],
      name: 'Jane Owner',
    });

    const speaker = makeKnownSpeaker([FARM_ID]);
    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker,
    });

    expect(config).toBeNull();
  });

  // Unknown speaker → always denied (no live call needed)
  it('Unknown speaker identity is denied cabinet access without any network call', async () => {
    let fetchCalled = false;
    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'mock-api-key',
      fetchFn: async () => {
        fetchCalled = true;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      },
    });

    const unknownSpeaker: SpeakerIdentity = {
      person_id: 'opaque_unresolved_000',
      customer_ref: 'opaque_unresolved_000',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      phone_e164: '+15550000000',
      is_known: false,
      role: 'unknown',
      permissions: [],
      farm_ids: [],
    };

    const config = await adapter.resolveCabinetConfig({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      farmId: FARM_ID,
      serial: SERIAL,
      speaker: unknownSpeaker,
    });

    expect(config).toBeNull();
    expect(fetchCalled).toBe(false);  // No network call was made
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § VfarmLiveClient Unit Tests (schemas and HTTP mechanics)
// ═══════════════════════════════════════════════════════════════════════════════

describe('VfarmLiveClient — HTTP mechanics and schema validation', () => {

  it('getInventory parses valid InventoryResponse', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'key',
      fetchFn: makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 200, body: MOCK_INVENTORY_RESPONSE },
      }),
    });

    const inv = await client.getInventory(SERIAL);
    expect(inv.serial_number).toBe(SERIAL);
    expect(inv.farm_id).toBe(FARM_ID);
  });

  it('getUnitConfig validates config_hash pattern — rejects bad hash from upstream', async () => {
    const badResp = {
      ...MOCK_UNIT_CONFIG_RESPONSE,
      current: { ...MOCK_UNIT_CONFIG_RESPONSE.current, config_hash: 'bad-hash' },
    };
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'key',
      fetchFn: makeMockFetch({
        [`/inventory/${SERIAL}/config`]: { status: 200, body: badResp },
      }),
    });

    await expect(client.getUnitConfig(SERIAL)).rejects.toThrow();
  });

  it('getConfig validates config_hash format before making the request', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'key',
      fetchFn: async () => { throw new Error('Should not call fetch'); },
    });

    await expect(client.getConfig('not-valid-hash')).rejects.toThrow('Invalid config_hash format');
  });

  it('getConfig parses valid ConfigResponse with integer dimensions', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'key',
      fetchFn: makeMockFetch({
        [`/configs/${CONFIG_HASH}`]: { status: 200, body: MOCK_CONFIG_RESPONSE },
      }),
    });

    const cfg = await client.getConfig(CONFIG_HASH);
    expect(cfg.config_hash).toBe(CONFIG_HASH);
    expect(cfg.parts).toHaveLength(1);
    expect(cfg.parts[0].length_mm).toBe(200);
    expect(cfg.parts[0].quantity).toBe(1);
    // Must be integers
    expect(Number.isInteger(cfg.parts[0].length_mm)).toBe(true);
    expect(Number.isInteger(cfg.parts[0].quantity)).toBe(true);
  });

  it('throws VfarmHttpError with status on 4xx/5xx', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'key',
      fetchFn: makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 503, body: { detail: 'Service Unavailable' } },
      }),
    });

    await expect(client.getInventory(SERIAL)).rejects.toSatisfy(
      (e: unknown) => e instanceof VfarmHttpError && (e as VfarmHttpError).status === 503,
    );
  });

  it('throws VfarmNetworkError on fetch exception', async () => {
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: 'key',
      fetchFn: async () => { throw new Error('ENOTFOUND'); },
    });

    await expect(client.getInventory(SERIAL)).rejects.toSatisfy(
      (e: unknown) => e instanceof VfarmNetworkError,
    );
  });

  it('does not include credentials in logged messages', async () => {
    // Verify that the apiKey used in X-Farm-Key is not exposed by VfarmHttpError messages
    const SECRET_KEY = 'super-secret-api-key-1234567890';
    const client = new VfarmLiveClient({
      baseUrl: 'https://mock.vfarm.test',
      apiKey: SECRET_KEY,
      fetchFn: makeMockFetch({
        [`/inventory/${SERIAL}`]: { status: 401, body: { detail: 'Unauthorized' } },
      }),
    });

    try {
      await client.getInventory(SERIAL);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(SECRET_KEY);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// § buildVfarmAdapterConfigFromEnv unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildVfarmAdapterConfigFromEnv', () => {
  it('returns undefined when VFARM_BASE_URL is not set', () => {
    const original = process.env.VFARM_BASE_URL;
    delete process.env.VFARM_BASE_URL;
    try {
      expect(buildVfarmAdapterConfigFromEnv()).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.VFARM_BASE_URL = original;
    }
  });

  it('returns config with baseUrl when VFARM_BASE_URL is set', () => {
    const original = process.env.VFARM_BASE_URL;
    process.env.VFARM_BASE_URL = 'https://api.vfarm.bhanetwork.org';
    try {
      const cfg = buildVfarmAdapterConfigFromEnv();
      expect(cfg).toBeDefined();
      expect(cfg!.baseUrl).toBe('https://api.vfarm.bhanetwork.org');
    } finally {
      if (original !== undefined) {
        process.env.VFARM_BASE_URL = original;
      } else {
        delete process.env.VFARM_BASE_URL;
      }
    }
  });
});
