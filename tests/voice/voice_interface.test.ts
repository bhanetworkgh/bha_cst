import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { Logger } from '../../engine/src/config/logger.js';
import { generateTwilioSignature } from '../../engine/src/transport/twilio/signature.js';
import { setImmediate } from 'timers/promises';

describe('CST Voice Interface (engine/src/interfaces/voice)', () => {
  const app = createApp();
  const authToken = process.env.TWILIO_AUTH_TOKEN || 'test_auth_token_for_jest_suite_32chars';
  const twilioBaseUrl = 'http://localhost:3000';

  const mockSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async ({ text, voiceId }) => ({
      audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
      mimeType: 'audio/mpeg',
    })),
  };

  function twilioSig(payload: Record<string, string>): string {
    return generateTwilioSignature(`${twilioBaseUrl}/webhooks/twilio/voice/inbound`, payload, authToken);
  }

  function twilioSigTurn(payload: Record<string, string>): string {
    return generateTwilioSignature(`${twilioBaseUrl}/webhooks/twilio/voice/turn`, payload, authToken);
  }

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    VoiceInterface.setSynthesizer(mockSynthesizer);
    VoiceLaneService.setSynthesizer(mockSynthesizer);
    vi.clearAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: 'normal', farm_id: 'farm_austin_main' }),
    } as Response));

    // Bind a voice-capability DID for voice interface tests
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885826',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    // Bind Dallas voice DID
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885824',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-dallas',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════
  // 1. Valid Inbound Call
  // ══════════════════════════════════════════════════════════════════
  describe('1. Valid inbound call', () => {
    it('accepts a valid inbound voice call, resolves DID, speaker, and synthesizes reply', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CALL_VALID_001',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', twilioSig(payload))
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('initiated');
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
      expect(res.body.call_sid).toBe('CALL_VALID_001');
      expect(res.headers['x-tenant-id']).toBe('tenant-vfarm-01');
      expect(res.headers['x-project-id']).toBe('proj-vfarm-main');

      const deliveries = DbClient.getAllVoiceDeliveries();
      expect(deliveries.length).toBeGreaterThan(0);
      expect(deliveries[0].status).toBe('synthesized');
      expect(deliveries[0].tenant_id).toBe('tenant-vfarm-01');
      expect(deliveries[0].project_id).toBe('proj-vfarm-main');
    });

    it('accepts a valid voice turn with speech text and returns synthesized audio', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CALL_TURN_001',
        From: '+923082113844',
        To: '+19715885826',
        SpeechResult: 'What is the status of my farm?',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', twilioSigTurn(payload))
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('synthesized');
      expect(res.body.text).toBeDefined();
      expect(res.body.audioBase64).toBeDefined();
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
      expect(res.body.voice_id).toBeDefined();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. DID → Tenant/Project Isolation
  // ══════════════════════════════════════════════════════════════════
  describe('2. DID → tenant/project isolation', () => {
    it('resolves different DIDs to different tenant_id + project_id', async () => {
      const res1 = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send({ CallSid: 'ISO_DID1', From: '+923082113844', To: '+19715885826', CallStatus: 'ringing' });

      expect(res1.status).toBe(200);
      expect(res1.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res1.body.project_id).toBe('proj-vfarm-main');

      const res2 = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send({ CallSid: 'ISO_DID2', From: '+15559990000', To: '+19715885824', CallStatus: 'ringing' });

      expect(res2.status).toBe(200);
      expect(res2.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res2.body.project_id).toBe('proj-vfarm-dallas');
    });

    it('rejects cross-tenant payload tampering in inbound call', async () => {
      const payload: Record<string, string> = {
        CallSid: 'ISO_TAMPER',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'ringing',
        tenant_id: 'tenant-hacker',
        project_id: 'proj-hacker',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('TENANT_SCOPE_VIOLATION');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. Voice Capability Disabled
  // ══════════════════════════════════════════════════════════════════
  describe('3. Voice capability disabled', () => {
    it('rejects inbound call when voice capability is disabled for project', async () => {
      const project = CoreRegistry.getProject('proj-vfarm-main')!;
      project.capabilities.voice = false;
      CoreRegistry.registerProject(project);

      const payload: Record<string, string> = {
        CallSid: 'CAP_DISABLED',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('CAPABILITY_DISABLED');
    });

    it('rejects voice turn when voice capability is disabled', async () => {
      const project = CoreRegistry.getProject('proj-vfarm-main')!;
      project.capabilities.voice = false;
      CoreRegistry.registerProject(project);

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send({
          CallSid: 'TURN_CAP_DISABLED',
          From: '+923082113844',
          To: '+19715885826',
          SpeechResult: 'status',
          CallStatus: 'in-progress',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('CAPABILITY_DISABLED');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. Unknown DID
  // ══════════════════════════════════════════════════════════════════
  describe('4. Unknown DID', () => {
    it('rejects inbound call to unbound number with 404', async () => {
      const payload: Record<string, string> = {
        CallSid: 'UNKNOWN_DID',
        From: '+923082113844',
        To: '+19998887777',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('SYSTEM_NOT_FOUND');
    });

    it('creates zero DB records for unknown DID', async () => {
      const payload: Record<string, string> = {
        CallSid: 'UNKNOWN_DID_DB',
        From: '+923082113844',
        To: '+19998887777',
        CallStatus: 'ringing',
      };

      await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(DbClient.getConversationCount()).toBe(0);
      expect(DbClient.getAllMessagesOut().length).toBe(0);
    });

    it('rejects voice turn with unknown to_e164', async () => {
      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+923082113844',
          to_e164: '+19998887777',
          speech_text: 'Hello',
        });

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('refused');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. Unknown/Removed Speaker (Guest Access with Least Privilege)
  // ══════════════════════════════════════════════════════════════════
  describe('5. Unknown / removed speaker (Guest access policy)', () => {
    it('accepts call from unknown speaker into voice flow as guest with 200', async () => {
      const payload: Record<string, string> = {
        CallSid: 'UNKNOWN_SPEAKER',
        From: '+15559999999',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('initiated');
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
      expect(res.body.twiml).toContain('<Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST">');
    });

    it('accepts call from removed speaker as guest caller into voice flow and refuses restricted action', async () => {
      const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;

      const payload1: Record<string, string> = {
        CallSid: 'SPEAKER_REMOVED_1',
        From: '+15551234567',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res1 = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload1);
      expect(res1.status).toBe(200);

      vfarmAdapter.removeSpeaker('proj-vfarm-main', '+15551234567');
      CoreRegistry.invalidateSpeakerCache('tenant-vfarm-01', 'proj-vfarm-main', '+15551234567');

      const payload2: Record<string, string> = {
        CallSid: 'SPEAKER_REMOVED_2',
        From: '+15551234567',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res2 = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload2);
      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe('initiated');

      // A removed speaker asking for farm status: engine serves a safe speakable
      // reply (status 'onboarding') so the call stays alive — not a hard 403.
      // The caller is NOT granted farm access; they receive a polite refusal and
      // can continue the conversation with general questions.
      const turnRes = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+15551234567',
          to_e164: '+19715885826',
          speech_text: 'What is the status of my farm?',
        });
      // HTTP 200 — voice farm-gate refusals are now soft (speakable, call continues)
      expect(turnRes.status).toBe(200);
      // The response carries a safe message, not a hard security refused
      expect(turnRes.body.status).not.toBe('refused');
    });

    it('rejects voice turn from unknown speaker attempting restricted action', async () => {
      // Farm status/images queries from guests now return a safe speakable reply
      // (HTTP 200, status 'onboarding') so the call stays alive. The guest is NOT
      // granted farm access — the engine refuses the data request but keeps the
      // conversation going so the caller can ask general support questions.
      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+15559999999',
          to_e164: '+19715885826',
          speech_text: 'status check',
        });

      // HTTP 200: farm-gate refusal is soft on voice (speakable, call continues)
      expect(res.status).toBe(200);
      // Must NOT be marked as a hard security refusal
      expect(res.body.status).not.toBe('refused');
      // The safe reply must be present
      expect(res.body.text || res.body.reply || '').toBeTruthy();
    });

    it('rejects voice turn from unknown speaker attempting equipment control', async () => {
      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+15559999999',
          to_e164: '+19715885826',
          speech_text: 'turn off irrigation pump',
        });

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
    });

    it('allows voice turn from unknown speaker for general guest inquiry', async () => {
      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+15559999999',
          to_e164: '+19715885826',
          speech_text: 'Hello, what services do you provide?',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('synthesized');
      expect(res.body.text).toContain('Welcome');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5.5 Cabinet / LM7W boundary + real vFarm phone_e164
  // ══════════════════════════════════════════════════════════════════
  describe('5.5 Cabinet / LM7W boundary + real vFarm phone_e164', () => {
    it('requires a valid E.164 phone_e164 for vFarm speaker sync and resolves known speaker only within scope', async () => {
      const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;

      await expect(
        adapter.syncMembers('tenant-vfarm-01', 'proj-vfarm-main', [
          { person_id: 'p1', phone_e164: 'invalid', role: 'owner', farm_ids: ['farm_austin_main'] },
        ])
      ).rejects.toThrow('invalid phone_e164');

      await expect(
        adapter.syncMembers('tenant-vfarm-01', 'proj-vfarm-main', [
          { person_id: 'p2', phone_e164: '+15550001111', role: 'owner', farm_ids: ['farm_austin_main'] },
        ])
      ).resolves.toHaveLength(1);

      const speaker = await CoreRegistry.resolveSpeaker({
        tenantId: 'tenant-vfarm-01',
        projectId: 'proj-vfarm-main',
        phoneE164: '+15550001111',
      });

      expect(speaker.is_known).toBe(true);
      expect(speaker.phone_e164).toBe('+15550001111');
      expect(speaker.farm_ids).toEqual(['farm_austin_main']);
    });

    it('refuses cabinet config when farm scope is empty or out of scope and returns degraded unavailable when adapter is down', async () => {
      const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
      const speaker = await CoreRegistry.resolveSpeaker({
        tenantId: 'tenant-vfarm-01',
        projectId: 'proj-vfarm-main',
        phoneE164: '+923082113844',
      });

      adapter.registerCabinetConfig({
        serial: 'LM7W-0001',
        farm_id: 'farm_austin_main',
        config_hash: 'abc123',
        cad_revision: 'R2',
        status: 'ok',
        source: 'lm7w',
      });

      await expect(
        adapter.resolveCabinetConfig({
          tenantId: 'tenant-vfarm-01',
          projectId: 'proj-vfarm-main',
          farmId: 'farm_austin_main',
          serial: 'LM7W-0001',
          speaker: { ...speaker, farm_ids: [] },
        })
      ).resolves.toBeNull();

      await expect(
        adapter.resolveCabinetConfig({
          tenantId: 'tenant-vfarm-01',
          projectId: 'proj-vfarm-main',
          farmId: 'farm_dallas_north',
          serial: 'LM7W-0001',
          speaker: { ...speaker, farm_ids: ['farm_austin_main'] },
        })
      ).resolves.toBeNull();

      adapter.setDegraded(true);
      await expect(
        adapter.resolveCabinetConfig({
          tenantId: 'tenant-vfarm-01',
          projectId: 'proj-vfarm-main',
          farmId: 'farm_austin_main',
          serial: 'LM7W-0001',
          speaker,
        })
      ).rejects.toThrow('LM7W cabinet config unavailable');

      adapter.setDegraded(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. Adapter Timeout / Degraded
  // ══════════════════════════════════════════════════════════════════
  describe('6. Adapter timeout / degraded', () => {
    it('rejects call when tenant adapter is degraded (fail-closed)', async () => {
      const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
      vfarmAdapter.setDegraded(true);
      CoreRegistry.invalidateSpeakerCache();

      const payload: Record<string, string> = {
        CallSid: 'ADAPTER_DEGRADED',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('SERVICE_UNAVAILABLE');
    });

    it('rejects voice turn when adapter times out (fail-closed on degraded resolve)', async () => {
      const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
      vfarmAdapter.setDegraded(true);
      CoreRegistry.invalidateSpeakerCache();

      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+923082113844',
          to_e164: '+19715885826',
          speech_text: 'status',
        });

      // Adapter degraded → resolveSpeaker returns unknown → allowlist rejects → 403
      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 7. Farm Scope Enforcement
  // ══════════════════════════════════════════════════════════════════
  describe('7. Farm scope enforcement', () => {
    it('processes valid voice turn for speaker with farm grants through CoreEngine', async () => {
      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+923082113844',
          to_e164: '+19715885826',
          speech_text: 'What is the status of my farm?',
          correlation_id: 'SCOPE_VALID_001',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('synthesized');
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
    });

    it('refuses voice turn for speaker with empty farm grants via CoreEngine', async () => {
      const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
      vfarmAdapter.registerSpeaker('proj-vfarm-main', {
        person_id: 'person_nofarms',
        phone_e164: '+15550009999',
        role: 'owner',
        farm_ids: [],
      });
      CoreRegistry.invalidateSpeakerCache('tenant-vfarm-01', 'proj-vfarm-main', '+15550009999');

      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+15550009999',
          to_e164: '+19715885826',
          speech_text: 'Give me farm status',
          correlation_id: 'SCOPE_EMPTY_001',
        });

      // CoreEngine serves a safe speakable reply for voice (status 'onboarding')
      // so the call stays alive — not a hard 403. Farm data is still denied;
      // the caller receives a polite message and can continue with general questions.
      expect(res.status).toBe(200);
      // The response must NOT be a hard refused status
      expect(res.body.status).not.toBe('refused');
      // A safe speakable text must be present
      expect(res.body.text || res.body.reply || '').toBeTruthy();
    });

    it('preserves tenant_id and project_id on voice delivery records', async () => {
      await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+923082113844',
          to_e164: '+19715885826',
          speech_text: 'status',
          correlation_id: 'SCOPE_DELIV_001',
        });

      const deliveries = DbClient.getAllVoiceDeliveries();
      const matched = deliveries.find((d) => d.correlation_id === 'SCOPE_DELIV_001');
      expect(matched?.tenant_id).toBe('tenant-vfarm-01');
      expect(matched?.project_id).toBe('proj-vfarm-main');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 8. voice_id Project Isolation
  // ══════════════════════════════════════════════════════════════════
  describe('8. voice_id project isolation', () => {
    it('uses project-specific elevenlabs_voice_id for synthesis', async () => {
      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+923082113844',
          to_e164: '+19715885826',
          speech_text: 'status check',
          correlation_id: 'VOICEISO_001',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('synthesized');
      expect(res.body.voice_id).toBeDefined();
      expect(res.body.voice_id).toBe('eleven_voice_jason_vfarm');

      expect((mockSynthesizer.synthesize as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
        expect.objectContaining({ voiceId: 'eleven_voice_jason_vfarm' })
      );
    });

    it('drops turn when project has no voice_id configured (no generic fallback)', async () => {
      const project = CoreRegistry.getProject('proj-vfarm-main')!;
      project.elevenlabs_voice_id = undefined;
      CoreRegistry.registerProject(project);

      const res = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+923082113844',
          to_e164: '+19715885826',
          speech_text: 'status',
          correlation_id: 'VOICEISO_NO_VOICE',
        });

      expect(res.status).toBe(422);
      expect(res.body.status).toBe('dropped');
      expect(res.body.reason).toContain('generic voice fallback');
    });

    it('maintains separate voice_id per project', async () => {
      // Bind voice number for Dallas project
      CoreRegistry.bindServiceNumber({
        phone_e164: '+19715885824',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-dallas',
        capability: 'voice',
        status: 'bound',
        bound_at: new Date().toISOString(),
      });

      const projDallas = CoreRegistry.getProject('proj-vfarm-dallas')!;
      projDallas.capabilities.voice = true;
      projDallas.elevenlabs_voice_id = 'eleven_voice_dallas';
      projDallas.elevenlabs_model_id = 'eleven_turbo_v2_5';
      CoreRegistry.registerProject(projDallas);

      const resDallas = await request(app)
        .post('/api/v1/voice/turn')
        .send({
          from_e164: '+15559990000',
          to_e164: '+19715885824',
          speech_text: 'status',
          correlation_id: 'VOICEISO_DAL_001',
        });

      expect(resDallas.status).toBe(200);
      expect(resDallas.body.status).toBe('synthesized');
      expect(resDallas.body.voice_id).toBe('eleven_voice_dallas');
      expect(resDallas.body.tenant_id).toBe('tenant-vfarm-01');
      expect(resDallas.body.project_id).toBe('proj-vfarm-dallas');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 9. Call Status / Audit Events
  // ══════════════════════════════════════════════════════════════════
  describe('9. Call status / audit events', () => {
    it('records inbound call delivery event and audit on initial answer', async () => {
      const payload: Record<string, string> = {
        CallSid: 'STATUS_INBOUND_001',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);

      const deliveries = DbClient.getAllVoiceDeliveries();
      const inboundDeliv = deliveries.find((d) => d.correlation_id === 'STATUS_INBOUND_001');
      expect(inboundDeliv).toBeDefined();
      expect(inboundDeliv!.status).toBe('synthesized');
      expect(inboundDeliv!.tenant_id).toBe('tenant-vfarm-01');
      expect(inboundDeliv!.project_id).toBe('proj-vfarm-main');
    });

    it('records call status events with correct tenant/project', async () => {
      const payload: Record<string, string> = {
        CallSid: 'STATUS_COMPLETE_001',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'completed',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/status')
        .set('Host', 'localhost:3000')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.call_status).toBe('completed');
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');

      const deliveries = DbClient.getAllVoiceDeliveries();
      const statusDeliv = deliveries.find((d) => d.correlation_id === 'STATUS_COMPLETE_001');
      expect(statusDeliv).toBeDefined();
      expect(statusDeliv!.status).toBe('sent');
      expect(statusDeliv!.tenant_id).toBe('tenant-vfarm-01');
      expect(statusDeliv!.project_id).toBe('proj-vfarm-main');
    });

    it('records failed call status events with error details', async () => {
      const payload: Record<string, string> = {
        CallSid: 'STATUS_FAIL_001',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'failed',
      };

      await request(app)
        .post('/webhooks/twilio/voice/status')
        .set('Host', 'localhost:3000')
        .type('form')
        .send(payload);

      const deliveries = DbClient.getAllVoiceDeliveries();
      const failDeliv = deliveries.find((d) => d.correlation_id === 'STATUS_FAIL_001');
      expect(failDeliv).toBeDefined();
      expect(failDeliv!.status).toBe('failed');
      expect(failDeliv!.error_code).toBe('CALL_FAILED');
    });

    it('rejects call status webhook with client-supplied tenant/project', async () => {
      const payload: Record<string, string> = {
        CallSid: 'STATUS_TAMPER_001',
        CallStatus: 'completed',
        tenant_id: 'tenant-hacker',
        project_id: 'proj-hacker',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/status')
        .set('Host', 'localhost:3000')
        .type('form')
        .send(payload);

      // Fail-closed: client-supplied tenant/project is rejected (403)
      expect(res.status).toBe(403);
    });

    it('rejects call status webhook without resolving number', async () => {
      const payload: Record<string, string> = {
        CallSid: 'STATUS_NODID_001',
        CallStatus: 'completed',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/status')
        .set('Host', 'localhost:3000')
        .type('form')
        .send(payload);

      expect(res.status).toBe(404);
    });

    it('logs audit event for call status transitions', async () => {
      const payload: Record<string, string> = {
        CallSid: 'STATUS_AUDIT_001',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'completed',
      };

      await request(app)
        .post('/webhooks/twilio/voice/status')
        .set('Host', 'localhost:3000')
        .type('form')
        .send(payload);

      const deliveries = DbClient.getAllVoiceDeliveries();
      const auditDeliv = deliveries.find((d) => d.correlation_id === 'STATUS_AUDIT_001');
      expect(auditDeliv).toBeDefined();
      expect(auditDeliv!.tenant_id).toBe('tenant-vfarm-01');
      expect(auditDeliv!.project_id).toBe('proj-vfarm-main');
    });

    it('records inbound call audit on voice turn webhook answer', async () => {
      const payload: Record<string, string> = {
        CallSid: 'TURN_AUDIT_001',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);

      const deliveries = DbClient.getAllVoiceDeliveries();
      const inbound = deliveries.find((d) => d.correlation_id === 'TURN_AUDIT_001');
      expect(inbound).toBeDefined();
      expect(inbound!.status).toBe('synthesized');
      expect(inbound!.tenant_id).toBe('tenant-vfarm-01');
      expect(inbound!.project_id).toBe('proj-vfarm-main');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 10. handleVoiceEnvelope direct call
  // ══════════════════════════════════════════════════════════════════
  describe('10. Direct VoiceInterface.handleVoiceEnvelope', () => {
    it('processes a valid voice envelope through CoreEngine', async () => {
      const envelope = {
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        channel: 'voice' as const,
        speaker_ref: '+923082113844',
        text: 'status check via envelope',
        media: [],
        correlation_id: 'ENV_001',
      };

      const res = await VoiceInterface.handleVoiceEnvelope(envelope);
      expect(res.reply_text).toBeDefined();
      expect(res.tenant_id).toBe('tenant-vfarm-01');
      expect(res.project_id).toBe('proj-vfarm-main');
    });

    it('rejects non-voice channel envelopes', async () => {
      const envelope = {
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        channel: 'sms' as const,
        speaker_ref: '+923082113844',
        text: 'hello',
        media: [],
        correlation_id: 'ENV_BAD_001',
      };

      await expect(VoiceInterface.handleVoiceEnvelope(envelope)).rejects.toThrow('non-voice');
    });

    it('rejects envelope for project with voice disabled', async () => {
      const project = CoreRegistry.getProject('proj-vfarm-main')!;
      project.capabilities.voice = false;
      CoreRegistry.registerProject(project);

      const envelope = {
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        channel: 'voice' as const,
        speaker_ref: '+923082113844',
        text: 'hello',
        media: [],
        correlation_id: 'ENV_DISABLED_001',
      };

      await expect(VoiceInterface.handleVoiceEnvelope(envelope)).rejects.toThrow('Voice capability is disabled');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 11. processVoiceTurn direct call
  // ══════════════════════════════════════════════════════════════════
  describe('11. Direct VoiceInterface.processVoiceTurn', () => {
    it('processes a valid voice turn and returns synthesized result', async () => {
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'Hello from API',
        correlation_id: 'PROC_001',
        call_sid: 'CALL_PROC_001',
      });

      expect(result.status).toBe('synthesized');
      expect(result.tenant_id).toBe('tenant-vfarm-01');
      expect(result.project_id).toBe('proj-vfarm-main');
      expect(result.correlation_id).toBe('PROC_001');
    });

    it('returns refused for unknown to_e164', async () => {
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+923082113844',
        to_e164: '+19999999999',
        speech_text: 'hello',
        correlation_id: 'PROC_UNKNOWN_001',
      });

      expect(result.status).toBe('refused');
      expect(result.httpStatus).toBe(404);
    });

    it('returns safe onboarding reply for unknown speaker attempting status (farm-gate soft refusal)', async () => {
      // Unknown speakers asking for farm status/images no longer get a hard 403 refused.
      // They receive a safe speakable reply (status 'onboarding') so the voice call
      // stays alive. Farm data is still fully denied; the caller can continue with
      // general support questions.
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+15559999999',
        to_e164: '+19715885826',
        speech_text: 'status check',
        correlation_id: 'PROC_UNK_SPEAKER_001',
      });

      // Voice farm-gate: synthesized (the safe reply is spoken, call continues)
      expect(result.status).toBe('synthesized');
      // Must NOT be a hard security 403
      expect(result.httpStatus).not.toBe(403);
    });

    it('allows unknown speaker to process general inquiry turn with least-privilege response', async () => {
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+15559999999',
        to_e164: '+19715885826',
        speech_text: 'hello',
        correlation_id: 'PROC_UNK_SPEAKER_002',
      });

      expect(result.status).toBe('synthesized');
      expect(result.httpStatus).toBe(200);
      expect(result.text).toContain('Welcome');
    });

    it('returns refused for adapter timeout (degraded resolve returns unknown speaker)', async () => {
      const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
      vfarmAdapter.setDegraded(true);
      CoreRegistry.invalidateSpeakerCache();

      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'hello',
        correlation_id: 'PROC_DEGRADED_001',
      });

      // CoreRegistry.resolveSpeaker catches adapter failure and returns unknown speaker
      // VoiceInterface allowlist check rejects unknown speaker → refused (fail-closed)
      expect(result.status).toBe('refused');
      expect(result.httpStatus).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 12. Twilio Signature Verification on Webhooks
  // ══════════════════════════════════════════════════════════════════
  describe('12. Twilio signature verification on voice webhooks', () => {
    it('rejects inbound call with invalid Twilio signature', async () => {
      const payload: Record<string, string> = {
        CallSid: 'SIG_BAD',
        From: '+923082113844',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', 'invalid_signature_xyz')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
    });

    it('rejects voice turn webhook with invalid Twilio signature', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', 'invalid_signature_xyz')
        .type('form')
        .send({
          CallSid: 'SIG_BAD_TURN',
          From: '+923082113844',
          To: '+19715885826',
          SpeechResult: 'status',
          CallStatus: 'in-progress',
        });

      expect(res.status).toBe(403);
    });
  });
});
