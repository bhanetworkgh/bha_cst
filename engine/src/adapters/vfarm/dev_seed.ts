/**
 * ============================================================================
 * DEV / TEST FIXTURE — NOT PRODUCTION CONFIGURATION
 * ============================================================================
 *
 * Everything in this file is a FIXTURE. It exists so the test-suite and the
 * local demo have a tenant, projects, farms, a directory and a service number
 * to work with. None of it is configuration: production tenancy comes from
 * the database (`CoreRegistry.initFromDb()`) and, optionally, from live vFarm
 * discovery (`VfarmTenantAdapter.pullProjects()` /
 * `pullResourceScopes()`).
 *
 * WHY IT WAS EXTRACTED
 *   These values used to live inline in `VfarmTenantAdapter.initDefaultData()`
 *   and `CoreRegistry.resetToDefault()`, so a hardcoded two-project, one-org,
 *   three-farm, four-speaker world was compiled into the production binary.
 *   That is what made CST single-tenant by construction: adding a vFarm
 *   organization or a project required editing source.
 *
 *   It also had an authorization consequence. `initDefaultData()` ran in
 *   PRODUCTION too, so the adapter's project map and resource-scope map
 *   always contained two projects and three FABRICATED farm ids
 *   (`farm_austin_main`, `farm_austin_east`, `farm_dallas_north`) — see
 *   migration 015, which cleared those ids from the `customers` table for
 *   exactly that reason. A project the tenant does not have, pointing at an
 *   organization it may not own, with invented farm scopes in the
 *   grant-comparison path, is not a harmless default.
 *
 * HOW IT IS NOW REACHED
 *   - `VfarmTenantAdapter.initDefaultData()` seeds from here ONLY when the
 *     adapter is in dev/test mode (`seedDemoDirectory`, defaulting to
 *     `NODE_ENV !== 'production'`).
 *   - `CoreRegistry.resetToDefault()` seeds from here ONLY in a test runner
 *     or when the database is completely empty AND `NODE_ENV !==
 *     'production'` (see `CoreRegistry.initFromDb()`).
 *
 *   In production both paths seed NOTHING, so a tenant's projects, farms and
 *   service numbers are exactly what the database and vFarm say they are.
 *
 * The identifiers below are invented. They are not vFarm organization ids,
 * farm ids or user ids — with the single documented exception of
 * `DEV_FIXTURE_ORG_ID`, which is the real vFarm organization the CST
 * development tenant belongs to.
 */
import type { Project, SpeakerRecord, ResourceScope } from '../../core/types.js';

/** The tenant the fixture belongs to. */
export const DEV_FIXTURE_TENANT_ID = 'tenant-vfarm-01';
export const DEV_FIXTURE_TENANT_NAME = 'vFarm Global';

/**
 * The real vFarm organization UUID the CST development tenant belongs to.
 * Discovered from `GET /api/v1/organizations`. It is a DEFAULT for the
 * fixture only — production tenancy organization ids come from the database
 * (`projects.tenant_org_id`) or from live discovery.
 */
export const DEV_FIXTURE_ORG_ID = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';

/**
 * The ElevenLabs voice id used by the fixture. In production the voice
 * pointer lives on the project row (`projects.elevenlabs_voice_id`) or comes
 * from `VFARM_ELEVENLABS_VOICE_ID`.
 */
export const DEV_FIXTURE_VOICE_ID = 'Hmy97GCI840wuICQesiM';
export const DEV_FIXTURE_VOICE_MODEL_ID = 'eleven_turbo_v2_5';

export const DEV_FIXTURE_ONBOARDING_REPLY =
  'Hi, thanks for calling vFarm Support. I'm here to help.What would you like to check today?';
export const DEV_FIXTURE_SECONDARY_ONBOARDING_REPLY =
  'Welcome to vFarm Dallas Support! Contact your site manager for access.';

/** The fixture projects, in the shape `Project` expects. */
export function buildDevFixtureProjects(
  tenantId: string = DEV_FIXTURE_TENANT_ID,
  orgId: string = DEV_FIXTURE_ORG_ID,
  onboardingReply: string = DEV_FIXTURE_ONBOARDING_REPLY,
): Project[] {
  return [
    {
      project_id: 'proj-vfarm-main',
      tenant_id: tenantId,
      name: 'vFarm Austin HQ',
      status: 'active',
      tenant_org_id: orgId,
      capabilities: { sms: true, voice: true },
      speaker_policy: 'allowlist',
      onboarding_reply: onboardingReply,
    },
    {
      project_id: 'proj-vfarm-dallas',
      tenant_id: tenantId,
      name: 'vFarm Dallas Operations',
      status: 'active',
      tenant_org_id: orgId,
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
      onboarding_reply: DEV_FIXTURE_SECONDARY_ONBOARDING_REPLY,
    },
  ];
}

/**
 * The fixture resource scopes (farms) per project.
 *
 * Every id here is INVENTED — these are not real vFarm farm ids (see
 * migration 015). They exist so the local demo has something to compare a
 * grant against.
 */
export function buildDevFixtureResourceScopes(): Map<string, ResourceScope[]> {
  return new Map<string, ResourceScope[]>([
    [
      'proj-vfarm-main',
      [
        { id: 'farm_austin_main', name: 'Austin Main Facility', type: 'farm' },
        { id: 'farm_austin_east', name: 'Austin East Greenhouses', type: 'farm' },
      ],
    ],
    [
      'proj-vfarm-dallas',
      [{ id: 'farm_dallas_north', name: 'Dallas North Facility', type: 'farm' }],
    ],
  ]);
}

/**
 * The fixture phone -> identity directory, per project.
 *
 * Every `person_id` here is INVENTED and matches no vFarm user, so the live
 * organisation-membership check refuses them — which is correct: they are
 * demo identities, not real ones.
 */
export function buildDevFixtureSpeakers(): Map<string, Map<string, SpeakerRecord>> {
  const main = new Map<string, SpeakerRecord>();
  main.set('+923082113844', {
    person_id: '142d03f7-4b7e-4246-b999-70835e004f33',
    phone_e164: '+923082113844',
    role: 'owner',
    farm_ids: ['farm_austin_main'],
    name: 'ahad',
  });
  main.set('+15551234567', {
    person_id: 'usr_vfarm_001',
    phone_e164: '+15551234567',
    role: 'manager',
    farm_ids: ['farm_austin_main'],
    name: 'John Doe',
  });
  main.set('+15558887777', {
    person_id: 'usr_vfarm_002',
    phone_e164: '+15558887777',
    role: 'tech',
    farm_ids: ['farm_austin_main'],
    name: 'Alice Smith',
  });

  const dallas = new Map<string, SpeakerRecord>();
  dallas.set('+15559990000', {
    person_id: 'usr_vfarm_dallas_001',
    phone_e164: '+15559990000',
    role: 'owner',
    farm_ids: ['farm_dallas_north'],
    name: 'Dallas Owner',
  });

  return new Map<string, Map<string, SpeakerRecord>>([
    ['proj-vfarm-main', main],
    ['proj-vfarm-dallas', dallas],
  ]);
}

/** The fixture service numbers the demo tenant owns. */
export const DEV_FIXTURE_CANDIDATE_NUMBERS: string[] = ['+19715885823'];
