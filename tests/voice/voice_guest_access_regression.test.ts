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

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
      expect(res.body.reason).toContain('not linked to any active farm resources');
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
});
