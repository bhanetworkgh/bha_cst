import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { DbClient } from '../../engine/src/db/client.js';
import { generateTwilioSignature } from '../../engine/src/transport/twilio/signature.js';

describe('CST Platform Multi-Tenant Core & Tenancy Requirements (Spec §11)', () => {
  const app = createApp();
  const authToken = process.env.TWILIO_AUTH_TOKEN || 'test_auth_token_for_jest_suite_32chars';
  const webhookUrl = 'http://localhost:3000/webhooks/twilio/sms';

  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

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

  // Helper to generate signature-verified Twilio webhook request
  function sendTwilioSms(payload: Record<string, string>) {
    const signature = generateTwilioSignature(webhookUrl, payload, authToken);
    return request(app)
      .post('/webhooks/twilio/sms')
      .set('Host', 'localhost:3000')
      .set('X-Twilio-Signature', signature)
      .type('form')
      .send(payload);
  }

  // Requirement 1: Two vFarm orgs -> two CST projects -> two DIDs; owner A cannot get owner B farms
  it('Req 1: Isolates farm access between two distinct projects and DIDs', async () => {
    // Project 1 (Austin): DID = +19715885823, Owner A = +923082113844 (owns farm_austin_main)
    // Project 2 (Dallas): DID = +19715885824, Owner B = +15559990000 (owns farm_dallas_north)

    const payloadAustin = {
      MessageSid: 'SM_austin_001',
      From: '+923082113844',
      To: '+19715885823',
      Body: 'Status check on farm',
    };

    const res1 = await sendTwilioSms(payloadAustin);
    expect(res1.status).toBe(204);

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 150));

    const outMessages = DbClient.getAllMessagesOut();
    const austinReply = outMessages.find((m) => m.to_e164 === '+923082113844');
    expect(austinReply).toBeDefined();
    expect(austinReply?.body).toContain('farm_austin_main');
    expect(austinReply?.body).not.toContain('farm_dallas_north');
  });

  // Requirement 2: Owner A texts project B's DID with a number not on B's speaker list -> onboarding reply, zero farm data
  it('Req 2: Owner A texting Project B DID receives onboarding reply with zero farm data', async () => {
    // Owner A (+923082113844) texts Dallas DID (+19715885824)
    const payloadCross = {
      MessageSid: 'SM_cross_001',
      From: '+923082113844',
      To: '+19715885824',
      Body: 'What is the temperature reading?',
    };

    const res = await sendTwilioSms(payloadCross);
    expect(res.status).toBe(204);

    await new Promise((r) => setTimeout(r, 150));

    const outMessages = DbClient.getAllMessagesOut();
    const reply = outMessages.find((m) => m.to_e164 === '+923082113844');
    expect(reply).toBeDefined();
    expect(reply?.body).toContain('Welcome to vFarm Dallas Support');
    expect(reply?.body).not.toContain('telemetry');
    expect(reply?.body).not.toContain('farm_austin');
    expect(reply?.body).not.toContain('farm_dallas');
  });

  // Requirement 3: Owner with farms {F1} cannot get telemetry for {F2} even if they type F2 in SMS
  it('Req 3: Blocks telemetry queries for out-of-scope farm mentions (F1 vs F2)', async () => {
    // Austin Owner (+923082113844) asks for Dallas telemetry via Austin DID (+19715885823)
    const payload = {
      MessageSid: 'SM_f1_f2_001',
      From: '+923082113844',
      To: '+19715885823',
      Body: 'Give me the status for Dallas site',
    };

    const res = await sendTwilioSms(payload);
    expect(res.status).toBe(204);

    await new Promise((r) => setTimeout(r, 150));

    const outMessages = DbClient.getAllMessagesOut();
    const reply = outMessages.find((m) => m.to_e164 === '+923082113844');
    expect(reply).toBeDefined();
    expect(reply?.body).toContain('You do not have access to queries for farm_dallas_north');
    expect(reply?.body).toContain('farm_austin_main');
  });

  // Requirement 4: Unbound Twilio number -> HTTP 404, no DB conversation
  it('Req 4: Returns 404 and creates zero DB records for unbound receiving service numbers', async () => {
    const payload = {
      MessageSid: 'SM_unbound_001',
      From: '+15551234567',
      To: '+19998887777', // Not bound in CoreRegistry
      Body: 'Hello',
    };

    const res = await sendTwilioSms(payload);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SYSTEM_NOT_FOUND');

    expect(DbClient.getConversationCount()).toBe(0);
    expect(DbClient.getTranscriptCount()).toBe(0);
  });

  // Requirement 5: SMS capability disabled on project -> HTTP 404 / 403, no handling
  it('Req 5: Refuses inbound SMS when project SMS capability is disabled', async () => {
    // Disable SMS on proj-vfarm-dallas
    const project = CoreRegistry.getProject('proj-vfarm-dallas')!;
    project.capabilities.sms = false;
    CoreRegistry.registerProject(project);

    const payload = {
      MessageSid: 'SM_disabled_001',
      From: '+15559990000',
      To: '+19715885824',
      Body: 'Status',
    };

    const res = await sendTwilioSms(payload);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CAPABILITY_DISABLED');
  });

  // Requirement 6: Speaker removed in vFarm adapter -> next SMS loses farm data
  it('Req 6: Speaker removal in tenant adapter immediately revokes farm data access', async () => {
    const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    expect(vfarmAdapter).toBeDefined();

    // 1. First message: speaker has access
    const payload1 = {
      MessageSid: 'SM_perm_001',
      From: '+15551234567',
      To: '+19715885823',
      Body: 'status',
    };
    await sendTwilioSms(payload1);
    await new Promise((r) => setTimeout(r, 150));
    expect(DbClient.getAllMessagesOut().length).toBe(1);

    // 2. Remove speaker from vFarm project and invalidate cache
    vfarmAdapter.removeSpeaker('proj-vfarm-main', '+15551234567');
    CoreRegistry.invalidateSpeakerCache('tenant-vfarm-01', 'proj-vfarm-main', '+15551234567');

    // 3. Second message: speaker is now unknown -> onboarding response, no farm data
    const payload2 = {
      MessageSid: 'SM_perm_002',
      From: '+15551234567',
      To: '+19715885823',
      Body: 'status',
    };
    await sendTwilioSms(payload2);
    await new Promise((r) => setTimeout(r, 150));

    const outMessages = DbClient.getAllMessagesOut();
    const secondReply = outMessages[1];
    expect(secondReply.body).toContain('Welcome to vFarm Support');
    expect(secondReply.body).not.toContain('Telemetry');
  });

  // Requirement 7: Service number bind collision across projects refused (409 Conflict)
  it('Req 7: Refuses service number binding collisions across projects', async () => {
    // Attempt to bind already bound number +19715885823 to another project (proj-vfarm-dallas)
    const res = await request(app)
      .post('/api/v1/admin/numbers/bind')
      .send({
        phone_e164: '+19715885823',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-dallas',
        capability: 'sms',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('COLLISION_DETECTED');
  });

  // Requirement 8: Adapter timeout / degraded state -> honest unavailable response, zero stale farm data
  it('Req 8: Handles adapter degraded state fail-closed without leaking stale farm data', async () => {
    const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    vfarmAdapter.setDegraded(true);
    CoreRegistry.invalidateSpeakerCache();

    const payload = {
      MessageSid: 'SM_degraded_001',
      From: '+923082113844',
      To: '+19715885823',
      Body: 'status',
    };

    const res = await sendTwilioSms(payload);
    expect(res.status).toBe(204);

    await new Promise((r) => setTimeout(r, 150));

    const outMessages = DbClient.getAllMessagesOut();
    const reply = outMessages[0];
    expect(reply).toBeDefined();
    // In degraded state, speaker identity is unresolved -> served safe onboarding copy, zero farm data
    expect(reply.body).toContain('Welcome to vFarm Support');
    expect(reply.body).not.toContain('farm_austin_main');
  });
});
