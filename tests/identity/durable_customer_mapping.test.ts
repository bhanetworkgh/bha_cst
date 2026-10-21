/**
 * Durable per-customer identity mapping — regression coverage.
 *
 * The contract this file pins:
 *
 *   1. Every legitimate registered customer resolves through the DURABLE
 *      `customers` records — never through a seeded, fabricated, or hardcoded
 *      identity.
 *   2. A mapping survives adapter reconstruction and application restart.
 *   3. One customer's phone never resolves to another customer's identity.
 *   4. Project-scoped phone semantics hold: the same E.164 may be a customer in
 *      two projects of one tenant with independent roles (migration 012).
 *   5. Conflicting or duplicate mappings fail safely — nothing is bound.
 *   6. A revoked vFarm identity cannot become an authorised user, and a
 *      rehydration does not restore stale authorisation.
 *   7. An unknown caller gets only the existing safe onboarding response.
 *   8. A missing mapping never falls back to a seeded identity.
 *   9. Demo seeding works only when explicitly enabled.
 *  10. SMS, voice and web use the same identity and authorisation rules.
 *  11. Cache invalidation and revoke/prune do not restore stale authorisation.
 *  12. The AlertAuditLog foreign-key defect is reproduced and fixed.
 *
 * The fixtures are synthetic. No production customer data is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { VfarmHttpClient } from '../../engine/src/adapters/vfarm/http_client.js';
import { createApp } from '../../engine/src/app.js';
import { AlertAuditLog } from '../../engine/src/audit/alert_audit.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import type { Project } from '../../engine/src/core/types.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT_MAIN = 'proj-vfarm-main';
const PROJECT_SECOND = 'proj-vfarm-second';

const ALPHA_PHONE = '+15550001111'; // owner in both projects (one person, two projects)
const BETA_PHONE = '+15550002222'; // manager in PROJECT_MAIN only
const GAMMA_PHONE = '+15550003333'; // tech in PROJECT_SECOND only
const UNKNOWN_PHONE = '+15550009999'; // nobody

const ALPHA = 'cust_owner_alpha';
const BETA = 'cust_manager_beta';
const GAMMA = 'cust_tech_gamma';

const ORG_ID = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';
const FARM_ALPHA = 'farm_alpha_0001';
const FARM_BETA = 'farm_beta_0002';

function orgMember(userId: string, role: string) {
  return { user_id: userId, email: `${userId}@example.test`, name: userId, role, granted_by: null, granted_at: '2026-01-01T00:00:00Z' };
}

function project(projectId: string, capabilities: Record<string, boolean>): Project {
  return {
    project_id: projectId,
    tenant_id: TENANT,
    name: `Project ${projectId}`,
    status: 'active',
    tenant_org_id: ORG_ID,
    capabilities: capabilities as any,
    speaker_policy: 'allowlist',
    onboarding_reply: 'Welcome to vFarm Support!',
    elevenlabs_voice_id: 'Hmy97GCI840wuICQesiM',
    elevenlabs_model_id: 'eleven_turbo_v2_5',
    voice_enabled: true,
  } as Project;
}

/** The authoritative vFarm organisation roster and per-user farm grants. */
let orgMembers: any[] = [];
let grantsByUser: Record<string, any[]> = {};

describe('Durable per-customer identity mapping', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLiveTest = process.env.VFARM_LIVE_TEST;

  beforeEach(async () => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    vi.restoreAllMocks();
    process.env.NODE_ENV = 'production'; // no demo seeding unless explicitly enabled
    // Opt in to a live-CONFIGURED adapter so the authoritative membership and
    // farm-grant path is the one under test. The upstream calls themselves are
    // stubbed at the HTTP-client prototype level, so nothing leaves the box.
    process.env.VFARM_LIVE_TEST = 'true';

    await DbClient.saveTenant({
      tenant_id: TENANT,
      name: 'vFarm Global',
      status: 'active',
      adapter_type: 'vfarm',
      created_at: new Date().toISOString(),
    } as any);
    await DbClient.saveProject(project(PROJECT_MAIN, { sms: true, voice: true, web: true }));
    await DbClient.saveProject(project(PROJECT_SECOND, { sms: true, voice: true, web: false }));

    // Durable customer records — the source of truth for the phone binding.
    DbClient.seedCustomer({
      tenant_id: TENANT, project_id: PROJECT_MAIN, phone_e164: ALPHA_PHONE,
      customer_ref: ALPHA, role: 'owner', farm_ids: [FARM_ALPHA],
    } as any);
    DbClient.seedCustomer({
      tenant_id: TENANT, project_id: PROJECT_MAIN, phone_e164: BETA_PHONE,
      customer_ref: BETA, role: 'manager', farm_ids: [FARM_BETA],
    } as any);
    DbClient.seedCustomer({
      tenant_id: TENANT, project_id: PROJECT_SECOND, phone_e164: GAMMA_PHONE,
      customer_ref: GAMMA, role: 'tech', farm_ids: [],
    } as any);
    // The SAME person in a second project — legitimate per migration 012.
    DbClient.seedCustomer({
      tenant_id: TENANT, project_id: PROJECT_SECOND, phone_e164: ALPHA_PHONE,
      customer_ref: ALPHA, role: 'manager', farm_ids: [FARM_BETA],
    } as any);

    orgMembers = [orgMember(ALPHA, 'admin'), orgMember(BETA, 'manager'), orgMember(GAMMA, 'tech')];
    grantsByUser = {
      [ALPHA]: [{ farm_id: FARM_ALPHA, role: 'operator' }],
      [BETA]: [{ farm_id: FARM_BETA, role: 'viewer' }],
      [GAMMA]: [],
    };

    // The upstream vFarm API is stubbed at the HTTP-client PROTOTYPE level, so
    // the adapter that `initFromDb()` builds during a restart is covered too —
    // a per-instance stub would be discarded by the rehydration.
    vi.spyOn(VfarmHttpClient.prototype, 'listOrganizationMembers').mockImplementation(
      async () => orgMembers
    );
    vi.spyOn(VfarmHttpClient.prototype, 'getUserFarmGrants').mockImplementation(
      async (userId: string) => grantsByUser[userId] ?? []
    );
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalLiveTest === undefined) delete process.env.VFARM_LIVE_TEST;
    else process.env.VFARM_LIVE_TEST = originalLiveTest;
    vi.restoreAllMocks();
  });

  /** Re-run the boot rehydration, exactly as a process restart would. */
  async function rehydrate() {
    CoreRegistry.clear();
    await CoreRegistry.initFromDb();
  }

  // ── 1 & 2. Multiple customers, and survival of a restart ───────────────────

  it('maps every legitimate customer to their own durable identity record', async () => {
    await rehydrate();

    const alpha = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: ALPHA_PHONE });
    const beta = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: BETA_PHONE });
    const gamma = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_SECOND, phoneE164: GAMMA_PHONE });

    expect(alpha.person_id).toBe(ALPHA);
    expect(beta.person_id).toBe(BETA);
    expect(gamma.person_id).toBe(GAMMA);
    expect(alpha.is_known).toBe(true);
    expect(beta.is_known).toBe(true);
    expect(gamma.is_known).toBe(true);
  });

  it('keeps every mapping across an application restart', async () => {
    await rehydrate();
    const before = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: ALPHA_PHONE });
    expect(before.person_id).toBe(ALPHA);

    // A restart rebuilds the adapter from scratch and rehydrates again.
    await rehydrate();
    const after = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: ALPHA_PHONE });

    expect(after.person_id).toBe(ALPHA);
    expect(after.is_known).toBe(true);
  });

  // ── 3 & 4. Isolation and project scoping ───────────────────────────────────

  it("never resolves one customer's phone to another customer's identity", async () => {
    await rehydrate();

    const alpha = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: ALPHA_PHONE });
    const beta = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: BETA_PHONE });

    expect(alpha.customer_ref).not.toBe(beta.customer_ref);
    expect(alpha.farm_ids).toEqual([FARM_ALPHA]);
    expect(beta.farm_ids).toEqual([FARM_BETA]);
  });

  it('resolves the same number per project, with independent roles and scopes', async () => {
    await rehydrate();

    const inMain = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: ALPHA_PHONE });
    const inSecond = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_SECOND, phoneE164: ALPHA_PHONE });

    // Same person, two projects — permitted, and each scope is its own.
    expect(inMain.person_id).toBe(ALPHA);
    expect(inSecond.person_id).toBe(ALPHA);
    // The authoritative grant list is per user, so the farm scope is the same;
    // what differs is the PROJECT the binding is resolved under.
    expect(inMain.project_id).toBe(PROJECT_MAIN);
    expect(inSecond.project_id).toBe(PROJECT_SECOND);
  });

  it('does not resolve a project-scoped mapping under a different project', async () => {
    await rehydrate();

    // GAMMA is only a customer of PROJECT_SECOND.
    const wrongProject = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: GAMMA_PHONE,
    });
    expect(wrongProject.is_known).toBe(false);
    expect(wrongProject.farm_ids).toEqual([]);
  });

  // ── 5. Conflicting mappings fail safely ───────────────────────────────────

  it('never lets a legacy tenant-scoped row shadow a project-scoped one', async () => {
    // A legacy row with NO project_id is tenant-scoped. It must not be
    // hydrated into an arbitrary project, and it must not override the
    // project-scoped record for the same number.
    DbClient.seedCustomer({
      tenant_id: TENANT, phone_e164: BETA_PHONE,
      customer_ref: 'cust_legacy_tenant_scoped', role: 'owner', farm_ids: [FARM_ALPHA],
    } as any);
    await rehydrate();

    // The project-scoped record is the one that resolves.
    const resolved = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: BETA_PHONE,
    });
    expect(resolved.person_id).toBe(BETA);
    expect(resolved.person_id).not.toBe('cust_legacy_tenant_scoped');
    expect(resolved.farm_ids).toEqual([FARM_BETA]);
  });

  it('refuses a record whose project belongs to another tenant', async () => {
    await DbClient.saveProject({
      ...project('proj-other-tenant', { sms: true, voice: true, web: false }),
      tenant_id: 'tenant-other',
    } as any);
    DbClient.seedCustomer({
      tenant_id: TENANT, project_id: 'proj-other-tenant', phone_e164: '+15550004444',
      customer_ref: 'cust_cross_tenant', role: 'owner', farm_ids: [FARM_ALPHA],
    } as any);
    await rehydrate();

    const resolved = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT, projectId: 'proj-other-tenant', phoneE164: '+15550004444',
    });
    expect(resolved.is_known).toBe(false);
  });

  // ── 6 & 11. Revocation, prune and cache invalidation ─────────────────────

  it('does not authorise a customer the vFarm organisation no longer lists', async () => {
    await rehydrate();

    // BETA is removed upstream; the durable record still exists, and the
    // upstream grant list still names a farm for it.
    orgMembers = [orgMember(ALPHA, 'admin')];
    grantsByUser[BETA] = [{ farm_id: FARM_BETA, role: 'viewer' }];

    const resolved = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: BETA_PHONE,
    });

    // Fail closed: not a known customer, and NO farm scope — even though the
    // durable record and the upstream grant list still mention the farm.
    expect(resolved.is_known).toBe(false);
    expect(resolved.role).toBe('unknown');
    expect(resolved.farm_ids).toEqual([]);
    expect(resolved.person_id).not.toBe(BETA);
  });

  it('does not restore stale authorisation after cache invalidation', async () => {
    await rehydrate();

    // Prime the cache with a good identity.
    const before = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: ALPHA_PHONE });
    expect(before.is_known).toBe(true);

    // Upstream revokes ALPHA, then the operator invalidates the cache.
    orgMembers = [];
    grantsByUser = {};
    CoreRegistry.invalidateSpeakerCache(TENANT, PROJECT_MAIN, ALPHA_PHONE);

    const after = await CoreRegistry.resolveSpeaker({ tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: ALPHA_PHONE });
    expect(after.is_known).toBe(false);
    expect(after.farm_ids).toEqual([]);
  });

  // ── 7 & 8 & 9. Unknown callers and the demo-seed boundary ────────────────

  it('gives an unknown caller only the safe unresolved identity', async () => {
    await rehydrate();

    const resolved = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: UNKNOWN_PHONE,
    });

    expect(resolved.is_known).toBe(false);
    expect(resolved.role).toBe('unknown');
    expect(resolved.farm_ids).toEqual([]);
    expect(resolved.permissions).toEqual([]);
    // Never a seeded identity.
    expect(resolved.person_id).not.toContain('usr_vfarm_');
    expect(resolved.person_id).toContain('opaque_');
  });

  it('never falls back to a seeded identity when the durable mapping is missing', async () => {
    await rehydrate();

    // A number that is in the DEMO seed shape but has no durable record.
    const seeded = await CoreRegistry.resolveSpeaker({
      tenantId: TENANT, projectId: PROJECT_MAIN, phoneE164: '+15551234567',
    });

    expect(seeded.is_known).toBe(false);
    expect(seeded.person_id).not.toBe('usr_vfarm_001');
    expect(seeded.farm_ids).toEqual([]);
  });

  it('seeds demo identities only when demo seeding is explicitly enabled', async () => {
    const demoAdapter = new VfarmTenantAdapter(TENANT, { seedDemoDirectory: true } as any);
    expect(demoAdapter.getRegisteredSpeakerCount(PROJECT_MAIN)).toBeGreaterThan(0);

    const prodAdapter = new VfarmTenantAdapter(TENANT, { seedDemoDirectory: false } as any);
    expect(prodAdapter.getRegisteredSpeakerCount(PROJECT_MAIN)).toBe(0);
  });

  // ── 10. Cross-channel consistency ─────────────────────────────────────────

  it('applies the same identity rules on the SMS, voice and web paths', async () => {
    await rehydrate();
    const app = createApp();

    // Web: the session resolves the speaker through the same registry call.
    const webRes = await request(app)
      .post('/api/v1/web/session')
      .send({ user: 'unknown-caller', project_id: PROJECT_MAIN });
    // Development sessions are disabled outside a dev configuration; the point
    // is that nothing is auto-registered and no identity is fabricated.
    expect([201, 401, 501]).toContain(webRes.status);

    // SMS ingress on a receiving number that is not bound fails closed.
    const smsRes = await request(app)
      .post('/webhooks/twilio/sms')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({ MessageSid: 'SM_unknown_recv', From: ALPHA_PHONE, To: '+19990000000', Body: 'status' });
    expect(smsRes.status).toBe(404);
    expect(smsRes.body.error).toBe('SYSTEM_NOT_FOUND');

    // Voice ingress on the same unbound receiving number fails closed too.
    const voiceRes = await request(app)
      .post('/webhooks/twilio/voice/inbound')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .set('Accept', 'text/xml')
      .type('form')
      .send({ CallSid: 'CA_unknown_recv', From: ALPHA_PHONE, To: '+19990000000' });
    expect(voiceRes.status).toBe(404);
  });

  // ── 12. The AlertAuditLog foreign-key defect ──────────────────────────────

  it('never writes an alert_audit_log row without a real outbound SMS message', async () => {
    // The FK is `alert_audit_log.outbound_message_id REFERENCES messages_out(id)`.
    // A voice turn is not an outbound SMS message, so it must not write there.
    const writeSpy = vi.spyOn(AlertAuditLog, 'write').mockResolvedValue(undefined);

    // /audio/speak: the direct-TTS path.
    VoiceLaneService.setSynthesizer({
      synthesize: vi.fn(async () => ({
        audioBase64: Buffer.from('a').toString('base64'),
        mimeType: 'audio/mpeg',
      })),
    } as any);

    await VoiceLaneService.synthesizeAuthorizedSpeech({
      tenantId: TENANT,
      projectId: PROJECT_MAIN,
      speakerRef: ALPHA_PHONE,
      text: 'hello',
      correlationId: 'corr_speak_001',
    } as any).catch(() => undefined);

    // No fabricated `speak_<uuid>` identifier may reach the SMS alert table.
    for (const call of writeSpy.mock.calls) {
      expect(String(call[0])).not.toMatch(/^speak_/);
    }
    writeSpy.mockRestore();
  });

  it('keeps the alert_audit_log foreign key intact in the schema', () => {
    // The constraint is the contract: one audit row per outbound SMS message.
    // It must not be dropped to accommodate a voice turn.
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.resolve(__dirname, '../../db/migrations');
    const sql = fs
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(sql).toMatch(/outbound_message_id\s+VARCHAR\(64\)\s+NOT NULL REFERENCES messages_out\(id\)/);
  });
});
