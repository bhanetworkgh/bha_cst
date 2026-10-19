import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';
import { generateTwilioSignature } from '../../engine/src/transport/twilio/signature.js';

describe('CST Voice Guest Caller Access & Security Invariants Regression', () => {
  const app = createApp();
  const authToken = process.env.TWILIO_AUTH_TOKEN || 'test_auth_token_for_jest_suite_32chars';
  const twilioBaseUrl = 'http://localhost:3000';

  const mockSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async ({ text, voiceId }) => ({
      audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
      mimeType: 'audio/mpeg',
    })),
  };

  function signVoiceInbound(payload: Record<string, string>): string {
    return generateTwilioSignature(`${twilioBaseUrl}/webhooks/twilio/voice`, payload, authToken);
  }

  function signVoiceTurn(payload: Record<string, string>): string {
    return generateTwilioSignature(`${twilioBaseUrl}/webhooks/twilio/voice/turn`, payload, authToken);
  }

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    VoiceInterface.setSynthesizer(mockSynthesizer);
    vi.clearAllMocks();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: 'normal', farm_id: 'farm_austin_main' }),
    } as Response));

    // Bind primary Austin voice DID
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885826',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    // Bind secondary Dallas voice DID
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

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Valid Twilio Request from Unregistered Caller Accepted into Voice Flow
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Unregistered caller guest ingress', () => {
    it('accepts valid Twilio voice webhook from unregistered caller and returns TwiML with gather', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_CALL_001',
        From: '+15559876543', // Unregistered caller
        To: '+19715885826',   // Authorized bound project number
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', signVoiceInbound(payload))
        .set('Accept', 'text/xml')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.text).toContain('<Response>');
      expect(res.text).toContain('<Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST">');
      expect(res.text).toContain('Welcome to vFarm Support');
      expect(res.headers['x-tenant-id']).toBe('tenant-vfarm-01');
      expect(res.headers['x-project-id']).toBe('proj-vfarm-main');

      const deliveries = DbClient.getAllVoiceDeliveries();
      expect(deliveries.length).toBeGreaterThanOrEqual(1);
      const delivery = deliveries.find((d) => d.correlation_id === 'CA_GUEST_CALL_001');
      expect(delivery).toBeDefined();
      expect(delivery?.status).toBe('synthesized');
      expect(delivery?.tenant_id).toBe('tenant-vfarm-01');
      expect(delivery?.project_id).toBe('proj-vfarm-main');
    });

    it('returns JSON initiated response when client requests JSON format', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_CALL_JSON',
        From: '+15559876543',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', signVoiceInbound(payload))
        .set('Accept', 'application/json')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('initiated');
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
      expect(res.body.greeting).toContain('Welcome to vFarm Support');
      expect(res.body.twiml).toContain('<Gather input="speech" action="/webhooks/twilio/voice/turn"');
    });

    it('allows guest caller to conduct a non-restricted conversational turn', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_TURN_001',
        From: '+15559876543',
        To: '+19715885826',
        SpeechResult: 'Hello, what does this service do?',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', signVoiceTurn(payload))
        .set('Accept', 'application/json')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('synthesized');
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
      expect(res.body.text).toContain('Welcome');
      expect(mockSynthesizer.synthesize).toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Registered Caller Still Works
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. Registered caller functionality preserved', () => {
    it('accepts registered owner call and resolves privileged access and farm grants', async () => {
      const inboundPayload: Record<string, string> = {
        CallSid: 'CA_OWNER_001',
        From: '+923082113844', // Registered owner in VfarmTenantAdapter
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const inboundRes = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', signVoiceInbound(inboundPayload))
        .set('Accept', 'application/json')
        .type('form')
        .send(inboundPayload);

      expect(inboundRes.status).toBe(200);
      expect(inboundRes.body.status).toBe('initiated');

      // Process status inquiry turn for authorized farm
      const turnPayload: Record<string, string> = {
        CallSid: 'CA_OWNER_TURN_001',
        From: '+923082113844',
        To: '+19715885826',
        SpeechResult: 'What is the status of my farm?',
        CallStatus: 'in-progress',
      };

      const turnRes = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', signVoiceTurn(turnPayload))
        .set('Accept', 'application/json')
        .type('form')
        .send(turnPayload);

      expect(turnRes.status).toBe(200);
      expect(turnRes.body.status).toBe('synthesized');
      expect(turnRes.body.tenant_id).toBe('tenant-vfarm-01');
      expect(turnRes.body.project_id).toBe('proj-vfarm-main');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Invalid/Missing Twilio Signatures Remain Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Twilio signature verification enforcement', () => {
    it('rejects inbound voice webhook with missing signature with 403', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_NO_SIG',
        From: '+15559876543',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        // No X-Twilio-Signature header
        .type('form')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
      expect(res.body.message).toContain('Missing Twilio signature header');
    });

    it('rejects inbound voice webhook with invalid signature with 403', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_BAD_SIG',
        From: '+15559876543',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', 'bad_forged_signature_value')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('rejects voice turn webhook with invalid signature with 403', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_BAD_SIG_TURN',
        From: '+15559876543',
        To: '+19715885826',
        SpeechResult: 'hello',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', 'invalid_turn_signature')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Unknown Called Numbers Remain Rejected
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Called number (To) resolution enforcement', () => {
    it('rejects inbound call to unbound receiving number with 404', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_UNBOUND_TO',
        From: '+15559876543',
        To: '+19998887777', // Not bound to any project
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('SYSTEM_NOT_FOUND');
      expect(res.body.message).toContain('Unknown or unbound receiving number');

      // Verify zero delivery records written
      const deliveries = DbClient.getAllVoiceDeliveries();
      expect(deliveries.find((d) => d.correlation_id === 'CA_UNBOUND_TO')).toBeUndefined();
    });

    it('rejects voice turn to unbound receiving number with 404', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_UNBOUND_TURN',
        From: '+15559876543',
        To: '+19998887777',
        SpeechResult: 'hello',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('SYSTEM_NOT_FOUND');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Guest Access Boundary: Strict Least-Privilege & Tenant Isolation
  // ─────────────────────────────────────────────────────────────────────────────
  describe('5. Guest caller restricted actions & cross-tenant protection', () => {
    it('rejects cross-tenant override attempt in voice webhook payload with 403', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_TAMPER_001',
        From: '+15559876543',
        To: '+19715885826', // Bound to tenant-vfarm-01
        tenant_id: 'tenant-other-malicious', // Tamper attempt
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('TENANT_SCOPE_VIOLATION');
    });

    it('refuses guest caller attempting farm telemetry query', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_FARM_QUERY',
        From: '+15559876543',
        To: '+19715885826',
        SpeechResult: 'What is the current status of the farm?',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .set('Accept', 'application/json')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.text || res.body.reply || '').toContain("can't access farm or equipment data without a linked account");
    });

    it('refuses guest caller attempting equipment control operations', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_CONTROL_OP',
        From: '+15559876543',
        To: '+19715885826',
        SpeechResult: 'turn off irrigation pump 2 immediately',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .set('Accept', 'application/json')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
      expect(res.body.reason).toContain('not authorized to execute control operations');
    });

    it('refuses guest caller attempting user and role management', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_USER_MGMT',
        From: '+15559876543',
        To: '+19715885826',
        SpeechResult: 'grant role admin to user 99',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .set('Accept', 'application/json')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
      expect(res.body.reason).toContain('restricted to the Organization Admin Panel');
    });

    it('refuses guest caller attempting sensitive step-up actions', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_STEP_UP',
        From: '+15559876543',
        To: '+19715885826',
        SpeechResult: 'please process payment and transfer funds',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .set('Accept', 'application/json')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
      expect(res.body.reason).toContain('step-up verification');
    });

    it('refuses guest caller attempting cross-tenant farm queries', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_GUEST_CROSS_FARM',
        From: '+15559876543',
        To: '+19715885826', // Calling Austin main project
        SpeechResult: 'tell me about the status of dallas north facility', // Out-of-scope farm
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .set('Accept', 'application/json')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Voice Status Callbacks Continue Working
  // ─────────────────────────────────────────────────────────────────────────────
  describe('6. Voice call lifecycle status callbacks', () => {
    it('records completed call lifecycle event with tenant and project scoping', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_STATUS_COMPLETE',
        CallStatus: 'completed',
        To: '+19715885826',
        From: '+15559876543',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/status')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');

      const deliveries = DbClient.getAllVoiceDeliveries();
      const statusDelivery = deliveries.find((d) => d.correlation_id === 'CA_STATUS_COMPLETE');
      expect(statusDelivery).toBeDefined();
      expect(statusDelivery?.status).toBe('sent');
      expect(statusDelivery?.delivered_at).toBeDefined();
    });

    it('records failed call lifecycle event with error information', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_STATUS_FAIL',
        CallStatus: 'failed',
        To: '+19715885826',
        From: '+15559876543',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/status')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.call_status).toBe('failed');

      const deliveries = DbClient.getAllVoiceDeliveries();
      const statusDelivery = deliveries.find((d) => d.correlation_id === 'CA_STATUS_FAIL');
      expect(statusDelivery).toBeDefined();
      expect(statusDelivery?.status).toBe('failed');
      expect(statusDelivery?.error_code).toBe('CALL_FAILED');
    });

    it('rejects status callback with client-supplied tenant/project override with 403', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_STATUS_TAMPER',
        CallStatus: 'completed',
        To: '+19715885826',
        tenant_id: 'tenant-tamper',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/status')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('TENANT_SCOPE_VIOLATION');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Admin Elevation / Role Assignment Regression
  //    Verifies that no caller is automatically assigned admin/owner privileges
  //    by phone number, test configuration, or any other implicit mechanism.
  // ─────────────────────────────────────────────────────────────────────────────
  describe('8. No-admin-elevation regression (R-ID-NOADMIN)', () => {
    it('does not assign admin/owner role to caller by phone number alone', async () => {
      // Any phone number that is NOT pre-registered must resolve as unknown guest.
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+15550000001',  // not registered
        to_e164: '+19715885826',
        speech_text: 'Hello there',
        correlation_id: 'NOADMIN_001',
      });
      // Synthesized (guest general conversation allowed)
      expect(result.status).toBe('synthesized');
      // Must not carry an elevated role
      expect((result as any).role).toBeUndefined();
    });

    it('registered normal user retains only their actual user-level permissions', async () => {
      // Register a speaker with role 'tech' (not owner/admin)
      const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
      vfarmAdapter.registerSpeaker('proj-vfarm-main', {
        person_id: 'person_tech_001',
        phone_e164: '+15550000002',
        role: 'tech',
        farm_ids: ['farm_austin_main'],
      });
      CoreRegistry.invalidateSpeakerCache('tenant-vfarm-01', 'proj-vfarm-main', '+15550000002');

      // Tech asking for farm status is allowed (they have farm_ids)
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+15550000002',
        to_e164: '+19715885826',
        speech_text: 'What is the status of my farm?',
        correlation_id: 'NOADMIN_002',
      });

      // Tech can get status — expect synthesized
      expect(result.status).toBe('synthesized');

      // Tech role is denied equipment control (write:control)
      const controlResult = await VoiceInterface.processVoiceTurn({
        from_e164: '+15550000002',
        to_e164: '+19715885826',
        speech_text: 'Turn off the irrigation pump',
        correlation_id: 'NOADMIN_003',
      });
      // Tech attempting control: should be refused
      expect(controlResult.status).toBe('refused');
    });

    it('unknown caller remains a restricted guest and is never silently promoted', async () => {
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+15550000099',  // never registered
        to_e164: '+19715885826',
        speech_text: 'hello',
        correlation_id: 'NOADMIN_004',
      });

      // General greeting must be synthesized (guests can have support conversation)
      expect(result.status).toBe('synthesized');
      // No role field on the result object
      expect((result as any).role).toBeUndefined();
    });

    it('guest can have a general-support conversation without farm-resource links', async () => {
      // A completely unknown caller asks a general FAQ question — must get a response
      const result = await VoiceInterface.processVoiceTurn({
        from_e164: '+15550000050',
        to_e164: '+19715885826',
        speech_text: 'How can I contact support?',
        correlation_id: 'NOADMIN_005',
      });

      expect(result.status).toBe('synthesized');
      expect(result.text).toBeTruthy();
    });

    it('guest cannot retrieve protected farm data or invoke restricted operations', async () => {
      // Guest asking for farm telemetry: must NOT receive actual farm data.
      // Engine returns safe speakable message (status 'onboarding'), NOT real telemetry.
      // The call is kept alive (not hung up) but farm data is withheld.
      const farmStatusResult = await VoiceInterface.processVoiceTurn({
        from_e164: '+15550000051',
        to_e164: '+19715885826',
        speech_text: 'Give me the farm status',
        correlation_id: 'NOADMIN_006_STATUS',
      });

      // Must be synthesized (safe reply spoken), NOT a real farm data response
      expect(farmStatusResult.status).toBe('synthesized');
      // The safe reply must not contain actual telemetry data markers
      const replyText = (farmStatusResult.text || '').toLowerCase();
      expect(replyText).not.toContain('temperature');
      expect(replyText).not.toContain('telemetry');
      expect(replyText).not.toContain('ph level');

      // Guest asking to control equipment: this IS a hard refusal
      const controlResult = await VoiceInterface.processVoiceTurn({
        from_e164: '+15550000051',
        to_e164: '+19715885826',
        speech_text: 'Turn off the irrigation pump',
        correlation_id: 'NOADMIN_006_CONTROL',
      });

      expect(controlResult.status).toBe('refused');
    });

    it('authorization refusals produce a safe voice response and do not unnecessarily end the call', async () => {
      // Farm-gate refusal for a guest: verify the TwiML contains <Gather> (not <Hangup/>)
      const payload: Record<string, string> = {
        CallSid: 'CA_NOADMIN_TWIML_001',
        From: '+15550000060',   // unknown caller
        To: '+19715885826',
        SpeechResult: 'What is the status of my farm?',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('x-test-bypass-signature', 'true')
        .set('User-Agent', 'TwilioProxy/1.1')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/xml/);

      const twiml = res.text;
      // Must contain a <Say> element with a safe reply
      expect(twiml).toContain('<Say>');
      // Must NOT contain <Hangup/> — call must stay alive
      expect(twiml).not.toContain('<Hangup/>');
      // Must contain <Gather> so the caller can continue speaking
      expect(twiml).toContain('<Gather');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Complete Inbound Voice Turn & Silence Resilience Regression
  // ─────────────────────────────────────────────────────────────────────────────
  describe('9. Complete Inbound Voice Turn & Silence Resilience Regression', () => {
    it('initial inbound call returns raw TwiML with nested Gather prompt and fallback verbs', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_PROD_FLOW_001',
        From: '+15551234567',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('Host', 'localhost:3000')
        .set('User-Agent', 'TwilioProxy/1.1')
        .set('X-Twilio-Signature', signVoiceInbound(payload))
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.text).toContain('<Response>');
      expect(res.text).toContain('<Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST">');
      expect(res.text).toContain('<Say>Welcome to vFarm Support');
      expect(res.text).toContain('I did not hear anything');
    });

    it('reconstructs fully qualified HTTPS action URL when behind proxy headers', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_PROD_PROXY_001',
        From: '+15551234567',
        To: '+19715885826',
        CallStatus: 'ringing',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice')
        .set('x-test-bypass-signature', 'true')
        .set('User-Agent', 'TwilioProxy/1.1')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-Host', 'bha-cst-7u9e.onrender.com')
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.text).toContain('action="https://bha-cst-7u9e.onrender.com/webhooks/twilio/voice/turn"');
    });

    it('form-encoded SpeechResult produces non-empty synthesized spoken response in Gather loop', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_PROD_TURN_001',
        From: '+15551234567',
        To: '+19715885826',
        SpeechResult: 'What are your support hours?',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('User-Agent', 'TwilioProxy/1.1')
        .set('X-Twilio-Signature', signVoiceTurn(payload))
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.text).toContain('<Response>');
      expect(res.text).toContain('<Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST">');
      expect(res.text).toContain('<Say>');
      expect(res.text).not.toContain('<Hangup/>');
      expect(mockSynthesizer.synthesize).toHaveBeenCalled();
    });

    it('empty SpeechResult triggers polite reprompt without terminating the call', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_PROD_EMPTY_001',
        From: '+15551234567',
        To: '+19715885826',
        SpeechResult: '',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('User-Agent', 'TwilioProxy/1.1')
        .set('X-Twilio-Signature', signVoiceTurn(payload))
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.text).toContain('<Response>');
      expect(res.text).toContain('did not catch that');
      expect(res.text).toContain('<Gather input="speech"');
    });

    it('technical failure or dropped voice turn speaks safe message instead of raw architectural error', async () => {
      // Mock synthesis failure
      vi.mocked(mockSynthesizer.synthesize).mockRejectedValueOnce(new Error('ElevenLabs socket closed'));

      const payload: Record<string, string> = {
        CallSid: 'CA_PROD_ERR_001',
        From: '+15551234567',
        To: '+19715885826',
        SpeechResult: 'Hello support',
        CallStatus: 'in-progress',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('User-Agent', 'TwilioProxy/1.1')
        .set('X-Twilio-Signature', signVoiceTurn(payload))
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.text).toContain('<Response>');
      // Must NOT leak raw exception or developer error strings
      expect(res.text).not.toContain('ElevenLabs socket closed');
      expect(res.text).not.toContain('Voice clone not configured');
      // Must contain safe caller-facing apology and clean Hangup
      expect(res.text).toContain('experiencing technical difficulties');
      expect(res.text).toContain('<Hangup/>');
    });

    it('rejects invalid Twilio signature with 403 Refused', async () => {
      const payload: Record<string, string> = {
        CallSid: 'CA_PROD_BAD_SIG',
        From: '+15551234567',
        To: '+19715885826',
        SpeechResult: 'Hello',
      };

      const res = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('User-Agent', 'TwilioProxy/1.1')
        .set('X-Twilio-Signature', 'invalid_signature_string')
        .type('form')
        .send(payload);

      expect(res.status).toBe(403);
    });

    it('CoreRegistry.initFromDb hydrates missing voice ID from environment so voice turns do not drop', async () => {
      // Save project with null voice ID in DbClient store
      const projectWithoutVoice: Project = {
        project_id: 'proj-vfarm-main',
        tenant_id: 'tenant-vfarm-01',
        name: 'vFarm Austin HQ',
        status: 'active',
        capabilities: { voice: true, sms: true },
        speaker_policy: 'allowlist',
        onboarding_reply: 'Welcome to vFarm Support',
        elevenlabs_voice_id: undefined, // Simulates NULL in DB
        voice_enabled: true,
      };

      await DbClient.saveProject(projectWithoutVoice);
      process.env.VFARM_ELEVENLABS_VOICE_ID = 'voice_env_hydrated_test';

      try {
        await CoreRegistry.initFromDb();
        const hydratedProject = CoreRegistry.getProject('proj-vfarm-main');
        expect(hydratedProject?.elevenlabs_voice_id).toBe('voice_env_hydrated_test');
        expect(hydratedProject?.voice_enabled).toBe(true);
      } finally {
        delete process.env.VFARM_ELEVENLABS_VOICE_ID;
        CoreRegistry.resetToDefault();
      }
    });
  });
});
