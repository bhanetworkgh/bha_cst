/**
 * vFarm connector — farm-level answer when the caller has a farm grant but no
 * unit binding.
 *
 * THE DEFECT
 *   `VfarmConnector.getUnitStatus()` refused whenever EITHER the farm id or the
 *   unit id was missing:
 *
 *       if (!farmId || !unitId) return "Your phone number is not linked to an
 *                                       active vFarm unit…";
 *
 *   vFarm exposes no user -> device mapping, so a caller with a valid farm
 *   grant never has a unit id. So a CORRECTLY IDENTIFIED customer — resolved
 *   upstream, role `owner`, two granted farms — was told their number was not
 *   linked to anything, even though the farm was known, authorized and
 *   readable (`GET /api/v1/farms/{farm_id}/health` and the farm's device
 *   inventory are both farm-scoped).
 *
 *   Production impact, 2026-10-22: a caller whose identity had just been
 *   repaired received "not linked to an active vFarm unit" for "what's the
 *   status of my farm?".
 *
 * THE FIX
 *   When the farm is known and authorized but the unit is not, answer at FARM
 *   level. Authorization is unchanged: the farm must be in the speaker's
 *   authoritative grant list, re-checked inside the adapter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

const TENANT = 'tenant-vfarm-01';
const FARM = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';
const PHONE = '+15551234567';

const HEALTH = {
  farm_id: FARM,
  farm_name: 'v-farm',
  status: 'unhealthy',
  device_count: 26,
  online_count: 19,
  offline_count: 6,
  unhealthy_count: 10,
};

const DEVICE_LIST = {
  devices: [{ id: 'relay_m3_1', device_type: 'actuator' }],
  total: 26,
  online_count: 19,
  offline_count: 6,
  registered_count: 20,
  maintenance_count: 0,
  error_count: 0,
  unhealthy_count: 10,
};

function jsonResponse(body: unknown): any {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function installAdapter(overrides: { health?: unknown; devices?: unknown } = {}) {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.includes('/health')) return jsonResponse(overrides.health ?? HEALTH);
    if (url.includes('/devices')) return jsonResponse(overrides.devices ?? DEVICE_LIST);
    return jsonResponse([]);
  }) as any;

  const adapter = new VfarmTenantAdapter(TENANT, {
    baseUrl: 'https://vfarm.test',
    apiKey: 'vk_test',
    apiToken: 'jwt_test',
    tenantId: TENANT,
    timeoutMs: 2000,
    fetchFn,
  } as any);

  CoreRegistry.registerTenant(
    { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
    adapter,
  );
  return adapter;
}

const speaker = (over: Partial<SpeakerIdentity> = {}): SpeakerIdentity =>
  ({
    person_id: 'u1',
    customer_ref: 'u1',
    tenant_id: TENANT,
    project_id: 'proj-vfarm-main',
    phone_e164: PHONE,
    is_known: true,
    role: 'owner',
    permissions: [],
    farm_ids: [FARM],
    ...over,
  } as SpeakerIdentity);

describe('vFarm connector — farm-level status without a unit binding', () => {
  beforeEach(() => {
    CoreRegistry.resetToDefault();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers at farm level instead of refusing when the farm is granted but no unit is bound', async () => {
    installAdapter();

    const res = await VfarmConnector.getUnitStatus(
      'cust_u1',
      { farm_id: FARM, unit_id: undefined, role: 'owner', granted_farms: [FARM] } as any,
      undefined,
      "what's the status of my farm?",
      speaker(),
    );

    // The refusal is GONE.
    expect(res.text).not.toContain('not linked to an active vFarm unit');
    // And the answer carries the real farm state.
    expect(res.text).toContain('Your farm has 26 devices');
    expect(res.text).toContain('19 are online');
    expect(res.text).toContain('6 are offline');
    expect(res.text).toContain('10 are unhealthy');
    expect(res.telemetry?.status).toBe('fault');
    expect(res.telemetry?.farm_id).toBe(FARM);
  });

  it('still refuses when NOTHING about the caller farm is known', async () => {
    installAdapter();

    const res = await VfarmConnector.getUnitStatus(
      'cust_u1',
      { farm_id: undefined, unit_id: undefined } as any,
      undefined,
      'status',
      speaker({ farm_ids: [] }),
    );

    // No farm -> the honest "we cannot link you" message stays.
    expect(res.text).toContain('not linked to an active vFarm unit');
    expect(res.telemetry?.status).toBe('telemetry_unavailable');
  });

  it('does NOT widen access: a speaker not granted the farm is refused', async () => {
    installAdapter();

    const res = await VfarmConnector.getUnitStatus(
      'cust_u1',
      { farm_id: FARM, unit_id: undefined, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      speaker({ farm_ids: [] }),   // no grant for this farm
    );

    expect(res.text).toContain('do not have access to telemetry');
    expect(res.httpStatus).toBe(403);
  });

  it('an unknown (guest) speaker is refused', async () => {
    installAdapter();

    const res = await VfarmConnector.getUnitStatus(
      'cust_u1',
      { farm_id: FARM, unit_id: undefined } as any,
      undefined,
      'status',
      speaker({ is_known: false, role: 'unknown' }),
    );

    expect(res.text).toContain('do not have access to telemetry');
    expect(res.httpStatus).toBe(403);
  });

  it('the unit-level path is unchanged when a unit IS bound', async () => {
    installAdapter();

    const res = await VfarmConnector.getUnitStatus(
      'cust_u1',
      { farm_id: FARM, unit_id: 'relay_m3_1', role: 'owner', granted_farms: [FARM] } as any,
      undefined,
      'status',
      speaker(),
    );

    // The unit path talks to the device-reading endpoint, not the farm
    // health endpoint, and does not emit the farm-level summary.
    expect(res.text).not.toContain('26 devices');
  });
});
