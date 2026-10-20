import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { ITenantAdapter } from '../../engine/src/adapters/types.js';
import { generateTwilioSignature } from '../../engine/src/transport/twilio/signature.js';
import { Project, SpeakerRecord } from '../../engine/src/core/types.js';

describe('CST Tenancy Verification & Full Lifecycle (Spec §§2-11)', () => {
  const app = createApp();
  const authToken = process.env.TWILIO_AUTH_TOKEN || 'test_auth_token_for_jest_suite_32chars';
  const webhookUrl = 'http://localhost:3000/webhooks/twilio/sms';

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    // The production seed only carries service numbers the Twilio account
    // actually owns, so a second project's DID is bound here as a fixture.
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715550100',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-dallas',
      capability: 'sms',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({
          status: 'normal',
          unit_id: 'unit_bay_04',
          farm_id: 'farm_austin_main',
          water_temp_c: 21.5,
          ph_level: 6.2,
          ec_level: 1.8,
          water_level: 'normal',
        }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sendTwilioSms(payload: Record<string, string>, signatureOverride?: string) {
    const signature = signatureOverride !== undefined
      ? signatureOverride
      : generateTwilioSignature(webhookUrl, payload, authToken);

    return request(app)
      .post('/webhooks/twilio/sms')
      .set('Host', 'localhost:3000')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(payload);
  }

  // ── Area 1 & 5: Complete Onboarding Lifecycle via Actual APIs ─────────────
  it('executes full 7-step onboarding lifecycle through actual Admin APIs and SMS ingress', async () => {
    // 1. Create a mock adapter for a new tenant "GreenGrow"
    const greenGrowSpeakers: Map<string, SpeakerRecord> = new Map([
      [
        '+15552223333',
        {
          person_id: 'person_greengrow_owner',
          phone_e164: '+15552223333',
          role: 'owner',
          farm_ids: ['farm_green_01'],
        },
      ],
    ]);

    const greenGrowAdapter: ITenantAdapter = {
      tenantId: 'tenant-greengrow',
      pullProjects: async (tenantId: string): Promise<Project[]> => [
        {
          project_id: 'proj-greengrow-austin',
          tenant_id: tenantId,
          name: 'GreenGrow Austin Facility',
          status: 'active',
          capabilities: { sms: true },
          speaker_policy: 'allowlist',
          onboarding_reply: 'Welcome to GreenGrow Support!',
        },
      ],
      pullResourceScopes: async () => [{ id: 'farm_green_01', type: 'farm' }],
      pullSpeakers: async () => Array.from(greenGrowSpeakers.values()),
      pullCandidateNumbers: async () => ['+19715554444'],
      resolveSpeaker: async ({ phoneE164 }) => {
        const found = greenGrowSpeakers.get(phoneE164);
        if (!found) {
          return {
            person_id: `opaque_${phoneE164}`,
            customer_ref: `opaque_${phoneE164}`,
            tenant_id: 'tenant-greengrow',
            project_id: 'proj-greengrow-austin',
            phone_e164: phoneE164,
            is_known: false,
            role: 'unknown',
            permissions: [],
            farm_ids: [],
          };
        }
        return {
          person_id: found.person_id,
          customer_ref: found.person_id,
          tenant_id: 'tenant-greengrow',
          project_id: 'proj-greengrow-austin',
          phone_e164: found.phone_e164,
          is_known: true,
          role: found.role,
          permissions: ['farm:read'],
          farm_ids: found.farm_ids,
        };
      },
    };

    // Step 1: Register Tenant via POST /api/v1/admin/tenants
    const resTenant = await request(app)
      .post('/api/v1/admin/tenants')
      .send({
        tenant_id: 'tenant-greengrow',
        name: 'GreenGrow AgriTech',
        adapter_type: 'greengrow',
      });
    expect(resTenant.status).toBe(201);
    CoreRegistry.registerTenant(resTenant.body.tenant, greenGrowAdapter);

    // Step 2: Sync Projects via POST /api/v1/admin/projects/sync
    const resProjSync = await request(app)
      .post('/api/v1/admin/projects/sync')
      .send({ tenant_id: 'tenant-greengrow' });
    expect(resProjSync.status).toBe(200);
    expect(resProjSync.body.count).toBe(1);

    // Step 3: Configure Capabilities & Speaker Policy via PATCH /api/v1/admin/projects/:projectId
    const resProjPatch = await request(app)
      .patch('/api/v1/admin/projects/proj-greengrow-austin')
      .send({
        capabilities: { sms: true },
        speaker_policy: 'allowlist',
      });
    expect(resProjPatch.status).toBe(200);
    expect(resProjPatch.body.project.capabilities.sms).toBe(true);

    // Step 4: Sync Candidate Numbers via POST /api/v1/admin/numbers/sync
    const resNumSync = await request(app)
      .post('/api/v1/admin/numbers/sync')
      .send({ tenant_id: 'tenant-greengrow' });
    expect(resNumSync.status).toBe(200);
    expect(resNumSync.body.numbers).toContain('+19715554444');

    // Step 5: Bind DID via POST /api/v1/admin/numbers/bind
    const resBind = await request(app)
      .post('/api/v1/admin/numbers/bind')
      .send({
        phone_e164: '+19715554444',
        tenant_id: 'tenant-greengrow',
        project_id: 'proj-greengrow-austin',
        capability: 'sms',
      });
    expect(resBind.status).toBe(201);
    expect(resBind.body.binding.status).toBe('bound');

    // Step 6: Sync Speakers via POST /api/v1/admin/speakers/sync
    const resSpeakerSync = await request(app)
      .post('/api/v1/admin/speakers/sync')
      .send({
        tenant_id: 'tenant-greengrow',
        project_id: 'proj-greengrow-austin',
      });
    expect(resSpeakerSync.status).toBe(200);
    expect(resSpeakerSync.body.count).toBe(1);

    // Step 7: Inbound SMS to the bound DID from registered speaker
    const smsPayload = {
      MessageSid: 'SM_greengrow_001',
      From: '+15552223333',
      To: '+19715554444',
      Body: 'Status check on GreenGrow farm',
    };

    const resSms = await sendTwilioSms(smsPayload);
    expect(resSms.status).toBe(204);

    await new Promise((r) => setTimeout(r, 150));

    const outMessages = DbClient.getAllMessagesOut();
    const reply = outMessages.find((m) => m.to_e164 === '+15552223333');
    expect(reply).toBeDefined();
    expect(reply?.body).toBeDefined();
  });

  // ── Area 2: Capabilities & Twilio Gate ────────────────────────────────────
  it('enforces strict gating: invalid signature, unbound DID, disabled capability', async () => {
    // 1. Invalid Twilio signature -> HTTP 403
    const resBadSig = await sendTwilioSms(
      {
        MessageSid: 'SM_badsig_001',
        From: '+15551234567',
        To: '+19715885823',
        Body: 'Hello',
      },
      'bad_invalid_signature'
    );
    expect(resBadSig.status).toBe(403);

    // 2. Unbound DID -> HTTP 404 SYSTEM_NOT_FOUND, zero DB touches
    const resUnbound = await sendTwilioSms({
      MessageSid: 'SM_unbound_002',
      From: '+15551234567',
      To: '+19991112222',
      Body: 'Hello',
    });
    expect(resUnbound.status).toBe(404);
    expect(resUnbound.body.error).toBe('SYSTEM_NOT_FOUND');
    expect(DbClient.getConversationCount()).toBe(0);

    // 3. Project SMS capability disabled -> HTTP 404 CAPABILITY_DISABLED
    const project = CoreRegistry.getProject('proj-vfarm-dallas')!;
    project.capabilities.sms = false;
    CoreRegistry.registerProject(project);

    const resDisabled = await sendTwilioSms({
      MessageSid: 'SM_disabled_002',
      From: '+15559990000',
      To: '+19715550100',
      Body: 'Hello Dallas',
    });
    expect(resDisabled.status).toBe(404);
    expect(resDisabled.body.error).toBe('CAPABILITY_DISABLED');

    // 4. Binding capability not "sms" (e.g. voice only) -> HTTP 404 CAPABILITY_DISABLED
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885825',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'voice',
      status: 'bound',
    });

    const resVoiceOnly = await sendTwilioSms({
      MessageSid: 'SM_voice_only_001',
      From: '+923082113844',
      To: '+19715885825',
      Body: 'Texting a voice number',
    });
    expect(resVoiceOnly.status).toBe(404);
    expect(resVoiceOnly.body.error).toBe('CAPABILITY_DISABLED');
  });

  // ── Area 3: Speaker Resolution & Invalidation ─────────────────────────────
  it('forces fresh live resolution when speaker cache is invalidated or expired', async () => {
    // 1. Initial resolution works
    const res1 = await CoreRegistry.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: '+923082113844',
    });
    expect(res1.is_known).toBe(true);

    // 2. Invalidate speaker cache via POST /api/v1/admin/speakers/invalidate
    const resInvalidate = await request(app)
      .post('/api/v1/admin/speakers/invalidate')
      .send({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        phone_e164: '+923082113844',
      });
    expect(resInvalidate.status).toBe(200);
    expect(resInvalidate.body.status).toBe('invalidated');

    // 3. Adapter failure / degraded fails closed and never leaks stale auth
    const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    vfarmAdapter.setDegraded(true);

    const resDegraded = await CoreRegistry.resolveSpeaker({
      tenantId: 'tenant-vfarm-01',
      projectId: 'proj-vfarm-main',
      phoneE164: '+923082113844',
    });

    expect(resDegraded.is_known).toBe(false);
    expect(resDegraded.role).toBe('unknown');
    expect(resDegraded.farm_ids).toEqual([]);
  });

  // ── Area 4: Farm Scope Enforced on Real Inbound Message Path ──────────────
  it('blocks out-of-scope farm requests and handles farm_ids=[] via real inbound path', async () => {
    // 4A. Out-of-scope farm mention (Austin owner asking for Dallas farm)
    const payloadOutOfScope = {
      MessageSid: 'SM_scope_001',
      From: '+923082113844', // Owns farm_austin_main
      To: '+19715885823',   // Austin DID
      Body: 'Please give me status on Dallas site',
    };

    const resA = await sendTwilioSms(payloadOutOfScope);
    expect(resA.status).toBe(204);
    await new Promise((r) => setTimeout(r, 150));

    const messagesA = DbClient.getAllMessagesOut();
    const replyA = messagesA.find((m) => m.to_e164 === '+923082113844');
    expect(replyA).toBeDefined();
    expect(replyA?.body).toContain('You do not have access to queries for farm_dallas_north');
    expect(replyA?.body).toContain('farm_austin_main');

    // 4B. User with farm_ids=[] gets refused with generic notice and zero farm telemetry
    const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    // Register temporary speaker with empty farm grants
    vfarmAdapter.registerSpeaker('proj-vfarm-main', {
      person_id: 'person_nofarms',
      phone_e164: '+15550009999',
      role: 'owner',
      farm_ids: [],
    });
    CoreRegistry.invalidateSpeakerCache('tenant-vfarm-01', 'proj-vfarm-main', '+15550009999');

    const payloadNoFarms = {
      MessageSid: 'SM_nofarms_001',
      From: '+15550009999',
      To: '+19715885823',
      Body: 'Water temperature status',
    };

    const resB = await sendTwilioSms(payloadNoFarms);
    expect(resB.status).toBe(204);
    await new Promise((r) => setTimeout(r, 150));

    const messagesB = DbClient.getAllMessagesOut();
    const replyB = messagesB.find((m) => m.to_e164 === '+15550009999');
    expect(replyB).toBeDefined();
    expect(replyB?.body).toContain('not linked to any active farm resources');
    expect(replyB?.body).not.toContain('water_temp_c');
    expect(replyB?.body).not.toContain('farm_austin');
  });

  // ── Area 6: Verification Health Endpoint ──────────────────────────────────
  it('returns full tenant, capability, DID, transport, and connector health in /health/verification', async () => {
    const res = await request(app).get('/api/v1/admin/health/verification');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');

    // Tenant & projects configuration checked
    expect(res.body.tenants.length).toBeGreaterThan(0);
    const vfarm = res.body.tenants.find((t: any) => t.tenant_id === 'tenant-vfarm-01');
    expect(vfarm).toBeDefined();
    expect(vfarm.projects.length).toBeGreaterThan(0);
    expect(vfarm.projects[0].capabilities).toBeDefined();

    // Service numbers checked
    expect(res.body.service_numbers.total_bound).toBeGreaterThan(0);

    // Transport health checked
    expect(res.body.transport.status).toBe('healthy');
    expect(res.body.transport.pending_outbound_count).toBeGreaterThanOrEqual(0);

    // Connectors checked
    expect(res.body.connectors.bharag_rag.status).toBe('healthy');
    expect(res.body.connectors.vfarm_telemetry.status).toBe('healthy');
  });

  // ── Area 7: MMS Inbound Media URL Storage ─────────────────────────────────
  it('stores and references inbound MMS URLs against the conversation without external processing', async () => {
    const mmsPayload = {
      MessageSid: 'MM_media_001',
      From: '+923082113844',
      To: '+19715885823',
      Body: 'Here is a photo of the crop leaf',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME1',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME2',
      MediaContentType1: 'image/png',
    };

    const res = await sendTwilioSms(mmsPayload);
    expect(res.status).toBe(204);

    await new Promise((r) => setTimeout(r, 150));

    // Verify inbound queue stored media URLs
    const inbound = DbClient.getInboundMessage('MM_media_001');
    expect(inbound).toBeDefined();
    expect(inbound?.media).toHaveLength(2);
    expect(inbound?.media[0]).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME1');
    expect(inbound?.media[1]).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME2');

    // Verify transcript stored media refs against the conversation
    const transcripts = DbClient.getAllTranscripts();
    const transcriptEntry = transcripts.find((t: any) => t.provider_sid === 'MM_media_001');
    expect(transcriptEntry).toBeDefined();
    expect(transcriptEntry.media_refs).toEqual([
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME1',
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME2',
    ]);
  });
});
