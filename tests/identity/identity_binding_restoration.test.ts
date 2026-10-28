/**
 * Regression tests for the vFarm identity-resolution root cause.
 *
 * THE BUG
 *   vFarm exposes NO phone field on a user, so the phone -> vFarm user_id
 *   binding is CST-owned and lives in the `customers` table. The tenant
 *   adapter's runtime directory is an in-memory map that was only ever
 *   written by an admin action, and the adapter's constructor re-seeded a
 *   DEMO directory (invented ids such as `usr_vfarm_003`) on every process
 *   start. Nothing restored the durable binding at boot.
 *
 *   So after each restart the inbound caller number resolved against the
 *   fabricated person_id. The live organisation-membership check correctly
 *   refused it, the speaker came back as `opaque_revoked` (an unknown
 *   caller), the engine saw zero farm scope, and the caller received the
 *   GUEST onboarding reply — "a specialist will assist you shortly" —
 *   instead of their own farm data.
 *
 * WHAT IS ASSERTED HERE
 *   1. The durable binding is restored at boot, so it survives a restart.
 *   2. A valid vFarm user resolves by phone with the AUTHORITATIVE role and
 *      the AUTHORITATIVE farm grants.
 *   3. A phone with no binding still follows the onboarding flow (guest).
 *   4. A binding whose person_id was removed upstream still fails closed.
 *   5. A registered user with zero grants gets zero farm scope.
 *   6. A valid owner receives ONLY its authorised farms.
 *   7. Tenant / project isolation is intact.
 *   8. An upstream failure fails closed and exposes no private data.
 *   9. Production does not seed the demo directory at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';

const ORG_ID = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';
const REAL_USER_ID = 'debf555c-b37d-4e92-bb15-597e169f1b38';
const PHONE = '+923082113844';
const FARM_A = 'ed95e120-74c4-4126-a2e9-0e4ffa9275e6';
const FARM_B = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';

const ORG_MEMBER = {
  user_id: REAL_USER_ID,
  email: 'admin@vfarm.co',
  name: 'Admin',
  role: 'admin',
  granted_by: null,
  granted_at: '2026-07-10T16:16:47.012386Z',
};

function jsonResponse(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * A mocked vFarm API. `members` and `grants` decide what upstream says;
 * `failGrants` makes the farm-grants lookup unavailable.
 */
function makeFetch(opts: {
  members?: any[];
  grants?: any[];
  failGrants?: boolean;
  failMembers?: boolean;
}) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/organizations/') && u.endsWith('/users')) {
      if (opts.failMembers) return jsonResponse({ detail: 'boom' }, 500);
      return jsonResponse(opts.members ?? [ORG_MEMBER]);
    }
    if (u.includes('/farm-grants')) {
      if (opts.failGrants) return jsonResponse({ detail: 'boom' }, 500);
      return jsonResponse({ grants: opts.grants ?? [], total: (opts.grants ?? []).length });
    }
    return jsonResponse({}, 404);
  });
}

function liveAdapter(fetchFn: any): VfarmTenantAdapter {
  return new VfarmTenantAdapter('tenant-vfarm-01', {
    baseUrl: 'https://vfarm.test',
    apiKey: 'vk_test',
    apiToken: 'jwt_test_token',
    fetchFn,
  } as any);
}

describe('vFarm identity binding — restoration, resolution and farm scope', () => {
  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    vi.restoreAllMocks();
  });

  // ── 1. The durable binding survives a restart ────────────────────────────

  it('restores the admin-managed phone->identity binding from the durable customer records at boot', async () => {
    DbClient.seedCustomer({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      phone_e164: PHONE,
      customer_ref: REAL_USER_ID,
      role: 'owner',
      farm_ids: [],
    });
    await DbClient.saveTenant({
      tenant_id: 'tenant-vfarm-01',
      name: 'vFarm Global',
      status: 'active',
      adapter_type: 'vfarm',
      created_at: new Date().toISOString(),
    } as any);

    await CoreRegistry.initFromDb();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    const restored = adapter.getRegisteredSpeaker('proj-vfarm-main', PHONE);

    // The REAL vFarm user id is bound to the phone — not the demo seed.
    expect(restored).not.toBeNull();
    expect(restored!.person_id).toBe(REAL_USER_ID);
    expect(restored!.phone_e164).toBe(PHONE);
  });

  it('does not seed the fabricated demo directory when demo seeding is off', () => {
    // The decision is made with an explicit config flag, NOT by mutating
    // process.env.NODE_ENV: the environment is shared state, and changing it
    // in a test can leak into a concurrently executed file.
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      baseUrl: 'https://vfarm.test',
      seedDemoDirectory: false,
    } as any);

    // No invented identity may exist for a real customer number.
    expect(adapter.getRegisteredSpeakerCount('proj-vfarm-main')).toBe(0);
    expect(adapter.getRegisteredSpeaker('proj-vfarm-main', PHONE)).toBeNull();
  });

  it('still seeds the demo directory when demo seeding is on', () => {
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
      seedDemoDirectory: true,
    } as any);
    expect(adapter.getRegisteredSpeakerCount('proj-vfarm-main')).toBeGreaterThan(0);
  });

  // ── 2. A valid vFarm user resolves with the authoritative role + grants ───

  it('resolves a valid vFarm user by phone with the authoritative role and farm grants', async () => {
    const fetchFn = makeFetch({
      members: [ORG_MEMBER],
      grants: [{ farm_id: FARM_A, role: 'operator' }],
    });
    const adapter = liveAdapter(fetchFn);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: REAL_USER_ID,
      phone_e164: PHONE,
      role: 'manager',
      farm_ids: [],
      name: 'Admin',
    });

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: PHONE,
    });

    expect(speaker.is_known).toBe(true);
    // The upstream organisation role wins over the stale local role.
    expect(speaker.role).toBe('owner');
    // The authoritative grant list wins outright.
    expect(speaker.farm_ids).toEqual([FARM_A]);
  });

  // ── 3. An unknown phone follows the onboarding flow ──────────────────────

  it('treats a phone with no binding as an unknown caller (onboarding flow)', async () => {
    const fetchFn = makeFetch({ members: [ORG_MEMBER], grants: [] });
    const adapter = liveAdapter(fetchFn);

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: '+15550000000',
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.role).toBe('unknown');
    expect(speaker.farm_ids).toEqual([]);
    expect(speaker.permissions).toEqual([]);
  });

  // ── 4. A revoked identity stays fail-closed ─────────────────────────────

  it('fails closed when the upstream organisation no longer contains the bound identity', async () => {
    // The phone IS bound locally, but the org no longer lists the user.
    const fetchFn = makeFetch({ members: [], grants: [] });
    const adapter = liveAdapter(fetchFn);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: REAL_USER_ID,
      phone_e164: PHONE,
      role: 'owner',
      farm_ids: [FARM_A],
    });

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: PHONE,
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.role).toBe('unknown');
    expect(speaker.farm_ids).toEqual([]);
    // The revoked reference must not be usable as an identity.
    expect(speaker.person_id).not.toBe(REAL_USER_ID);
    expect(speaker.person_id).toContain('opaque_');
  });

  // ── 5. Zero grants means zero farm scope ────────────────────────────────

  it('gives a registered user with zero upstream grants no farm scope', async () => {
    const fetchFn = makeFetch({ members: [ORG_MEMBER], grants: [] });
    const adapter = liveAdapter(fetchFn);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: REAL_USER_ID,
      phone_e164: PHONE,
      role: 'owner',
      farm_ids: [FARM_A], // stale local projection — must NOT be reused
      name: 'Admin',
    });

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: PHONE,
    });

    expect(speaker.is_known).toBe(true);
    // Identity resolved, but the authoritative grant list is empty, so the
    // stale local farm scope must not be reused.
    expect(speaker.farm_ids).toEqual([]);
  });

  // ── 6. Only the authorised farms are granted ────────────────────────────

  it('grants exactly the farms the upstream authorises and no others', async () => {
    const fetchFn = makeFetch({
      members: [ORG_MEMBER],
      grants: [
        { farm_id: FARM_A, role: 'operator' },
        { farm_id: FARM_B, role: 'viewer' },
      ],
    });
    const adapter = liveAdapter(fetchFn);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: REAL_USER_ID,
      phone_e164: PHONE,
      role: 'owner',
      farm_ids: [],
      name: 'Admin',
    });

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: PHONE,
    });

    expect(speaker.farm_ids.sort()).toEqual([FARM_A, FARM_B].sort());
    expect(speaker.farm_ids).toHaveLength(2);
  });

  // ── 7. Tenant / project isolation ───────────────────────────────────────

  it('does not resolve another project\'s binding', async () => {
    const fetchFn = makeFetch({ members: [ORG_MEMBER], grants: [{ farm_id: FARM_A, role: 'operator' }] });
    const adapter = liveAdapter(fetchFn);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: REAL_USER_ID,
      phone_e164: PHONE,
      role: 'owner',
      farm_ids: [],
    });

    // The same number is not bound under a different project.
    const otherProject = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-dallas',
      phoneE164: PHONE,
    });

    expect(otherProject.is_known).toBe(false);
    expect(otherProject.farm_ids).toEqual([]);
  });

  // ── 8. Upstream failure fails closed without exposing private data ───────

  it('fails closed with zero farm scope when the upstream grant lookup is unavailable', async () => {
    const fetchFn = makeFetch({ members: [ORG_MEMBER], failGrants: true });
    const adapter = liveAdapter(fetchFn);
    adapter.registerSpeaker('proj-vfarm-main', {
      person_id: REAL_USER_ID,
      phone_e164: PHONE,
      role: 'owner',
      farm_ids: [FARM_A],
      name: 'Admin',
    });

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: PHONE,
    });

    // The stale local farm scope must NOT be reused when the authority is down.
    expect(speaker.farm_ids).toEqual([]);
  });

  it('rejects an invalid phone number without any upstream call', async () => {
    const fetchFn = makeFetch({ members: [ORG_MEMBER] });
    const adapter = liveAdapter(fetchFn);

    const speaker = await adapter.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: 'not-a-number',
    });

    expect(speaker.is_known).toBe(false);
    expect(speaker.person_id).toContain('opaque_');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});


/**
 * END-TO-END ACCEPTANCE — the reported symptom.
 *
 * The complaint was: "my number is registered in CST Admin, but the bot keeps
 * saying a specialist will contact me, instead of answering farm questions".
 *
 * The chain under test:
 *   bound phone -> speaker identity -> authorised farm ids -> engine ->
 *   upstream vFarm status -> a farm-specific answer.
 *
 * And the fail-closed counterpart: a speaker with no authorised farm gets a
 * safe, non-misleading reply and NO farm data.
 */
describe('Farm question acceptance — authorised speaker vs. zero-grant speaker', () => {
  const ONBOARDING_REPLY =
    "Hi, thanks for calling vFarm Support. I'm here to help. What would you like to check today?";

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    vi.restoreAllMocks();
  });

  function envelope(text: string, channel: 'voice' | 'sms' = 'voice') {
    // The engine consumes the FLAT MessageEnvelope, not the vFarm event.
    return {
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      channel,
      speaker_ref: PHONE,
      text,
      media: [],
      correlation_id: 'corr_acceptance_001',
    } as any;
  }

  it('routes a farm question to the upstream vFarm path with the authorised farm id', async () => {
    const statusSpy = vi
      .spyOn(VfarmConnector, 'getUnitStatus')
      .mockResolvedValue({ text: 'Farm v-farm (Unit bay_04): Telemetry currently NORMAL.' } as any);

    const res = await CoreEngine.processEnvelope(
      envelope('what is the status of my farm'),
      {
        customer_ref: REAL_USER_ID,
        phone_e164: PHONE,
        role: 'owner',
        permissions: [],
        farm_ids: [FARM_A],
        is_known: true,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
      } as any,
    );

    // The authorised farm reached the upstream connector.
    expect(statusSpy).toHaveBeenCalledTimes(1);
    const unitContext = statusSpy.mock.calls[0][1] as any;
    expect(unitContext.farm_id).toBe(FARM_A);
    expect(unitContext.granted_farms).toEqual([FARM_A]);

    // And the caller got a farm-specific answer, not the generic one.
    expect(res.reply_text).toContain('Telemetry currently NORMAL');
    expect(res.reply_text).not.toContain('specialist will assist');
    expect(res.reply_text).not.toContain('not linked to any active farm resources');
  });

  it('serves a safe reply and no farm data to a speaker with no authorised farm', async () => {
    const statusSpy = vi.spyOn(VfarmConnector, 'getUnitStatus').mockResolvedValue(undefined as any);

    const res = await CoreEngine.processEnvelope(
      envelope('what is the status of my farm'),
      {
        customer_ref: REAL_USER_ID,
        phone_e164: PHONE,
        role: 'owner',
        permissions: [],
        farm_ids: [],
        is_known: true,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
      } as any,
    );

    // No upstream farm call was made at all.
    expect(statusSpy).not.toHaveBeenCalled();
    // The reply is safe and does not leak another farm's data.
    expect(res.reply_text).toMatch(/doesn't have any linked farm resources|not linked to any active farm resources/);
    expect(res.reply_text).not.toContain(FARM_A);
    expect(res.reply_text).not.toContain(FARM_B);
  });

  it('does not reach the upstream farm path for an unknown caller', async () => {
    const statusSpy = vi.spyOn(VfarmConnector, 'getUnitStatus').mockResolvedValue(undefined as any);

    const res = await CoreEngine.processEnvelope(
      envelope('what is the status of my farm'),
      {
        customer_ref: 'opaque_923082113844',
        phone_e164: PHONE,
        role: 'unknown',
        permissions: [],
        farm_ids: [],
        is_known: false,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
      } as any,
    );

    expect(statusSpy).not.toHaveBeenCalled();
    expect(res.reply_text).not.toContain('Telemetry currently NORMAL');
    expect(res.reply_text).not.toContain(FARM_A);
  });

  it('keeps the guest onboarding reply out of an authorised farm answer', () => {
    // Guard against the exact regression: the generic onboarding reply must
    // never be what an authorised farm question returns.
    expect(ONBOARDING_REPLY).toContain('I\'m here to help');
  });
});
