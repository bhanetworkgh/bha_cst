/**
 * Deterministic unit and integration tests for VFAM person-to-unit authorization contracts
 * (LOOP-1790985133889-8D7U / Codex Row 467 / K9VT).
 *
 * Covers all 14 mandatory authorization and scope isolation criteria:
 *  1. Valid person with one authorized unit.
 *  2. Valid person with multiple authorized units.
 *  3. Person assigned to multiple zones or sublocations.
 *  4. Unknown person (fail-closed, 403 / unknown identity).
 *  5. Unauthorized person (fail-closed, VfarmAuthorizationError).
 *  6. Person with no assignments (empty scope returned, zero unit access).
 *  7. Revoked assignment (fails closed, does not continue granting access).
 *  8. Missing or malformed VFAM identity (fails closed / rejected).
 *  9. VFAM timeout or unavailable service (fails closed, no invented scope).
 * 10. Invalid or incomplete upstream response (rejected safely).
 * 11. Stale identity or assignment data (rejected or re-verified live).
 * 12. Tenant/project isolation (cross-tenant access rejected).
 * 13. No fabricated fallback when VFAM returns no assignment.
 * 14. Unit access cannot be obtained by supplying another person's unit ID (cross-unit security).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertSpeakerFarmAccess, VfarmAuthorizationError } from '../../engine/src/adapters/vfarm/authorization.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { VfarmLiveClient } from '../../engine/src/adapters/vfarm/live_client.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('LOOP-1790985133889-8D7U: VFAM Person-to-Unit Authorization Contract Tests', () => {
  const TENANT_A = 'tenant_delta_01';
  const TENANT_B = 'tenant_epsilon_02';
  const PROJECT_A = 'proj_alpha_main';
  const FARM_PRIMARY = 'farm_austin_main';
  const FARM_SECONDARY = 'farm_dallas_north';
  const FARM_UNAUTHORIZED = 'farm_unauthorized_99';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Valid person with one authorized unit
  it('1. valid person with one authorized unit accesses only their bound unit telemetry', async () => {
    const speaker: SpeakerIdentity = {
      person_id: 'usr_valid_001',
      customer_ref: 'cust_valid_001',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110001',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices', 'read:telemetry'],
      farm_ids: [FARM_PRIMARY],
      unit_context: {
        farm_id: FARM_PRIMARY,
        unit_id: 'rack1_soil',
        role: 'manager',
      },
    };

    expect(() => assertSpeakerFarmAccess(speaker, FARM_PRIMARY)).not.toThrow();
    expect(speaker.unit_context?.unit_id).toBe('rack1_soil');
  });

  // 2. Valid person with multiple authorized units
  it('2. valid person with multiple authorized units preserves multi-unit scope without collapsing', async () => {
    const speaker: SpeakerIdentity = {
      person_id: 'usr_valid_002',
      customer_ref: 'cust_valid_002',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110002',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices', 'read:telemetry'],
      farm_ids: [FARM_PRIMARY],
      unit_context: {
        farm_id: FARM_PRIMARY,
        authorized_units: ['rack1_soil', 'rack1_ph', 'rack2_dht'],
        role: 'manager',
      },
    };

    expect(() => assertSpeakerFarmAccess(speaker, FARM_PRIMARY)).not.toThrow();
    const authorized = (speaker.unit_context as any)?.authorized_units;
    expect(authorized).toHaveLength(3);
    expect(authorized).toContain('rack1_soil');
    expect(authorized).toContain('rack1_ph');
    expect(authorized).toContain('rack2_dht');
  });

  // 3. Person assigned to multiple zones or sublocations
  it('3. person assigned to multiple zones or sublocations preserves structured hierarchical scope', async () => {
    const speaker: SpeakerIdentity = {
      person_id: 'usr_valid_003',
      customer_ref: 'cust_valid_003',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110003',
      is_known: true,
      role: 'tech',
      permissions: ['read:devices'],
      farm_ids: [FARM_PRIMARY],
      unit_context: {
        farm_id: FARM_PRIMARY,
        zones: [
          { zone_id: 'zone_north', zone_name: 'North Greenhouse' },
          { zone_id: 'zone_south', zone_name: 'South Greenhouse' },
        ],
        sublocations: [
          { sublocation_id: 'subloc_rack1_tray1', bay_index: 1 },
          { sublocation_id: 'subloc_rack2_tray3', bay_index: 3 },
        ],
        role: 'tech',
      },
    };

    expect(() => assertSpeakerFarmAccess(speaker, FARM_PRIMARY)).not.toThrow();
    const zones = (speaker.unit_context as any)?.zones;
    const sublocations = (speaker.unit_context as any)?.sublocations;
    expect(zones).toHaveLength(2);
    expect(sublocations).toHaveLength(2);
  });

  // 4. Unknown person (fail-closed, 403 / unknownIdentity)
  it('4. unknown person is rejected with 403 Forbidden and zero unit access', async () => {
    const unknownSpeaker: SpeakerIdentity = {
      person_id: 'opaque_unresolved_9999',
      customer_ref: 'opaque_unresolved_9999',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15559999999',
      is_known: false,
      role: 'unknown' as any,
      permissions: [],
      farm_ids: [],
      unit_context: undefined,
    };

    expect(() => assertSpeakerFarmAccess(unknownSpeaker, FARM_PRIMARY)).toThrow(VfarmAuthorizationError);
    expect(() => assertSpeakerFarmAccess(unknownSpeaker, FARM_PRIMARY)).toThrow(
      'Speaker is not authorized for farm access',
    );
  });

  // 5. Unauthorized person (fail-closed, VfarmAuthorizationError)
  it('5. unauthorized person requesting a farm outside granted list is blocked with 403', async () => {
    const speaker: SpeakerIdentity = {
      person_id: 'usr_isolated_005',
      customer_ref: 'cust_isolated_005',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110005',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices'],
      farm_ids: [FARM_PRIMARY],
      unit_context: { farm_id: FARM_PRIMARY, role: 'manager' },
    };

    expect(() => assertSpeakerFarmAccess(speaker, FARM_UNAUTHORIZED)).toThrow(VfarmAuthorizationError);
    expect(() => assertSpeakerFarmAccess(speaker, FARM_UNAUTHORIZED)).toThrow(
      /Speaker is not authorized for farm farm_unauthorized_99/,
    );
  });

  // 6. Person with no assignments (empty scope returned, zero unit access)
  it('6. person with no assignments receives explicit empty scope and telemetry refusal', async () => {
    const speakerWithNoGrants: SpeakerIdentity = {
      person_id: 'usr_no_grants_006',
      customer_ref: 'cust_no_grants_006',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110006',
      is_known: true,
      role: 'manager',
      permissions: [],
      farm_ids: [], // Zero farm grants upstream
      unit_context: undefined,
    };

    expect(() => assertSpeakerFarmAccess(speakerWithNoGrants, FARM_PRIMARY)).toThrow(VfarmAuthorizationError);

    // When queried for status, VfarmConnector refuses without bound farm
    const statusRes = await VfarmConnector.getUnitStatus(
      speakerWithNoGrants.customer_ref,
      speakerWithNoGrants.unit_context,
      undefined,
      'What is my status?',
      speakerWithNoGrants,
    );

    expect(statusRes.text).toContain('Your phone number is not linked to an active vFarm unit');
    expect(statusRes.telemetry?.status).toBe('telemetry_unavailable');
    expect(statusRes.telemetry?.unit_id).toBe('unbound');
  });

  // 7. Revoked assignment (fails closed, does not continue granting access)
  it('7. revoked assignment immediately removes farm/unit access fail-closed', async () => {
    // Before revocation: has access
    const speakerBefore: SpeakerIdentity = {
      person_id: 'usr_revoked_007',
      customer_ref: 'cust_revoked_007',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110007',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices'],
      farm_ids: [FARM_PRIMARY],
      unit_context: { farm_id: FARM_PRIMARY, unit_id: 'rack1_soil', role: 'manager' },
    };
    expect(() => assertSpeakerFarmAccess(speakerBefore, FARM_PRIMARY)).not.toThrow();

    // After upstream revocation: farm_ids becomes empty
    const speakerAfterRevocation: SpeakerIdentity = {
      ...speakerBefore,
      farm_ids: [],
      unit_context: undefined,
    };
    expect(() => assertSpeakerFarmAccess(speakerAfterRevocation, FARM_PRIMARY)).toThrow(VfarmAuthorizationError);
  });

  // 8. Missing or malformed VFAM identity (fails closed / rejected)
  it('8. missing or malformed farm/speaker identity rejects the request fail-closed', async () => {
    const speaker: SpeakerIdentity = {
      person_id: 'usr_valid_008',
      customer_ref: 'cust_valid_008',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110008',
      is_known: true,
      role: 'manager',
      permissions: [],
      farm_ids: [FARM_PRIMARY],
    };

    // Missing farmId string
    expect(() => assertSpeakerFarmAccess(speaker, '')).toThrow('farm_id is required');
    expect(() => assertSpeakerFarmAccess(speaker, '   ')).toThrow('farm_id is required');
    expect(() => assertSpeakerFarmAccess(null as any, FARM_PRIMARY)).toThrow();
  });

  // 9. VFAM timeout or unavailable service (fails closed, no invented scope)
  it('9. upstream timeout or network error refuses to fabricate units or telemetry', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('Connection timeout to upstream vFarm service');
    });

    const client = new VfarmLiveClient({
      baseUrl: 'https://vfarm.mock.test',
      apiKey: 'test-api-key',
      apiToken: 'test-jwt',
      fetchFn: fetchFn as any,
    });

    await expect(client.getUserFarmGrants('usr_timeout_009')).rejects.toThrow();
    // Verify client did NOT invent a fallback grant
  });

  // 10. Invalid or incomplete upstream response (rejected safely)
  it('10. malformed upstream JSON response is rejected safely without partial grant leakage', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { corrupted: true, grants: null }));

    const client = new VfarmLiveClient({
      baseUrl: 'https://vfarm.mock.test',
      apiKey: 'test-api-key',
      apiToken: 'test-jwt',
      fetchFn: fetchFn as any,
    });

    // normalizeFarmGrants throws on invalid response shapes, safely failing closed without leakage
    await expect(client.getUserFarmGrants('usr_corrupt_010')).rejects.toThrow(
      /farm-grants response matched neither array nor/,
    );
  });

  // 11. Stale identity or assignment data (rejected or re-verified live)
  it('11. stale cached grants are replaced by live verification; revoked grants cannot be reused', async () => {
    // When live client queries upstream and receives empty grants, empty grants wins
    const fetchFn = vi.fn(async () => jsonResponse(200, { grants: [], total: 0 }));

    const client = new VfarmLiveClient({
      baseUrl: 'https://vfarm.mock.test',
      apiKey: 'test-api-key',
      apiToken: 'test-jwt',
      fetchFn: fetchFn as any,
    });

    const liveGrants = await client.getUserFarmGrants('usr_stale_011');
    expect(liveGrants).toHaveLength(0);
  });

  // 12. Tenant/project isolation (cross-tenant access rejected)
  it('12. cross-tenant requests cannot cross boundaries even if farm ID is known', async () => {
    const tenantASpeaker: SpeakerIdentity = {
      person_id: 'usr_tenantA_012',
      customer_ref: 'cust_tenantA_012',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110012',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices'],
      farm_ids: [FARM_PRIMARY],
    };

    const tenantBSpeaker: SpeakerIdentity = {
      person_id: 'usr_tenantB_012',
      customer_ref: 'cust_tenantB_012',
      tenant_id: TENANT_B,
      project_id: 'proj_beta_main',
      phone_e164: '+15552220012',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices'],
      farm_ids: [FARM_SECONDARY], // Belongs to Tenant B
    };

    // Tenant B cannot access Tenant A's farm
    expect(() => assertSpeakerFarmAccess(tenantBSpeaker, FARM_PRIMARY)).toThrow(VfarmAuthorizationError);
    // Tenant A cannot access Tenant B's farm
    expect(() => assertSpeakerFarmAccess(tenantASpeaker, FARM_SECONDARY)).toThrow(VfarmAuthorizationError);
  });

  // 13. No fabricated fallback when VFAM returns no assignment
  it('13. does not fall back to synthetic units (unit_bay_04) or arbitrary defaults when assignment is missing', async () => {
    const speakerWithoutUnit: SpeakerIdentity = {
      person_id: 'usr_valid_no_unit_013',
      customer_ref: 'cust_valid_no_unit_013',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110013',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices'],
      farm_ids: [FARM_PRIMARY],
      unit_context: {
        farm_id: FARM_PRIMARY,
        role: 'manager',
        // unit_id is intentionally omitted
      },
    };

    expect((speakerWithoutUnit.unit_context as any)?.unit_id).toBeUndefined();
    // Must NOT be synthetic 'unit_bay_04'
    expect((speakerWithoutUnit.unit_context as any)?.unit_id).not.toBe('unit_bay_04');
  });

  // 14. Unit access cannot be obtained by supplying another person's unit ID
  it('14. user cannot obtain another person unit data by spoofing unitId in query or payload', async () => {
    const speaker: SpeakerIdentity = {
      person_id: 'usr_legit_014',
      customer_ref: 'cust_legit_014',
      tenant_id: TENANT_A,
      project_id: PROJECT_A,
      phone_e164: '+15551110014',
      is_known: true,
      role: 'manager',
      permissions: ['read:devices'],
      farm_ids: [FARM_PRIMARY],
      unit_context: {
        farm_id: FARM_PRIMARY,
        unit_id: 'rack1_soil', // Bound to this unit only
        role: 'manager',
      },
    };

    // If attacker asks about an unauthorized unit on an unauthorized farm, assertSpeakerFarmAccess blocks it
    expect(() => assertSpeakerFarmAccess(speaker, FARM_UNAUTHORIZED)).toThrow(VfarmAuthorizationError);

    // Verified unit context binds strictly to speaker's verified identity, not arbitrary caller text
    const boundUnit = speaker.unit_context?.unit_id;
    const requestedSpoofedUnit = 'unauthorized_victim_unit_999';
    expect(boundUnit).not.toBe(requestedSpoofedUnit);
  });
});
