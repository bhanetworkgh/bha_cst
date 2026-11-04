import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { Logger } from '../../engine/src/config/logger.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';
import { generateTwilioSignature } from '../../engine/src/transport/twilio/signature.js';

describe('CS Twin v1 Brain API & Shared Orchestration (engine/src/brain)', () => {
  const app = createApp();
  const TEST_API_KEY = 'cst_test_key_shared_brain_orchestration_32_chars';
  const twilioAuthToken = 'test_twilio_auth_token_32_chars_long';
  const twilioBaseUrl = 'http://localhost:3000';

  const mockSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async ({ text, voiceId }) => ({
      audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
      mimeType: 'audio/mpeg',
    })),
  };

  function twilioSigTurn(payload: Record<string, string>): string {
    return generateTwilioSignature(`${twilioBaseUrl}/webhooks/twilio/voice/turn`, payload, twilioAuthToken);
  }

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.CST_API_KEY = TEST_API_KEY;
    process.env.TWILIO_AUTH_TOKEN = twilioAuthToken;
    delete process.env.TEST_ALLOW_DEMO_AUTH;

    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    VoiceInterface.setSynthesizer(mockSynthesizer);

    // Ensure main project has web and voice enabled
    const project = CoreRegistry.getProject('proj-vfarm-main')!;
    project.capabilities.web = true;
    project.capabilities.voice = true;
    project.elevenlabs_voice_id = 'Hmy9...esiM';
    CoreRegistry.registerProject(project);

    // Bind voice & SMS DID
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885823',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'sms_voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: 'normal', farm_id: 'farm_austin_main', answer: 'All 4 vertical racks operational.' }),
    } as Response));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ══════════════════════════════════════════════════════════════════
  // 1. Authentication & Security Gate
  // ══════════════════════════════════════════════════════════════════
  describe('1. Authentication Gate', () => {
    it('refuses unauthenticated requests with HTTP 401 AUTH_REQUIRED', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .send({ text: 'What is the status of my farm?' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('AUTH_REQUIRED');
    });

    it('refuses requests with invalid API key with HTTP 401', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', 'wrong_invalid_key')
        .send({ text: 'Status query' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('AUTH_REQUIRED');
    });

    it('accepts requests with valid CST_API_KEY', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({ text: 'Hello CS Twin' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.reply_text).toBeDefined();
    });

    it('accepts requests with valid session token', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-session', 'demo-session')
        .send({ text: 'Check telemetry' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. Schema Validation & Input Boundary
  // ══════════════════════════════════════════════════════════════════
  describe('2. Schema & Input Validation', () => {
    it('rejects empty input text with HTTP 400 BAD_REQUEST', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({ text: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('Input text cannot be empty');
    });

    it('rejects text exceeding 4000 characters with HTTP 400', async () => {
      const longText = 'a'.repeat(4001);
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({ text: longText });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('Text exceeds maximum limit');
    });

    it('validates complete response schema conformity', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({
          text: 'What is the current temperature?',
          channel: 'api',
          speaker_ref: '+923082113844',
          correlation_id: 'corr_schema_test_001',
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        turn_id: expect.stringMatching(/^turn_/),
        conversation_id: expect.any(String),
        correlation_id: 'corr_schema_test_001',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        speaker_ref: '+923082113844',
        channel: 'api',
        role: expect.any(String),
        input_text: 'What is the current temperature?',
        reply_text: expect.any(String),
        status: 'ok',
        intent: expect.any(String),
        duration_ms: expect.any(Number),
        timestamp: expect.any(String),
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 3. Strict Server-Side Tenancy & Tamper Prevention
  // ══════════════════════════════════════════════════════════════════
  describe('3. Tenancy Isolation & Tamper Prevention', () => {
    it('refuses cross-tenant body override attempt with HTTP 403 TENANT_SCOPE_VIOLATION', async () => {
      const auditSpy = vi.spyOn(Logger, 'audit');

      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({
          text: 'What is the pH level?',
          tenant_id: 'malicious-attacker-tenant', // Attempting cross-tenant spoof
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('TENANT_SCOPE_VIOLATION');
      expect(res.body.message).toContain('Cross-tenant tenant_id override strictly prohibited');

      // Verify security ledger audit entry was recorded
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'refused',
          reason: expect.stringContaining('Cross-tenant payload tamper attempt'),
        })
      );
    });

    it('resolves tenancy context server-side when no tenant_id is sent', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({ text: 'Status of Austin farm' });

      expect(res.status).toBe(200);
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 4. Conversation State & Transcript Persistence
  // ══════════════════════════════════════════════════════════════════
  describe('4. Durable Persistence & Continuity', () => {
    it('persists conversation row and transcript messages to database', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({
          text: 'Record this message in conversation history',
          correlation_id: 'corr_persist_001',
        });

      expect(res.status).toBe(200);
      const convId = res.body.conversation_id;
      expect(convId).toBeDefined();

      // Verify conversation exists in DB
      const allConvs = DbClient.getAllConversations();
      expect(allConvs.some((c: any) => c.conversation_id === convId)).toBe(true);

      // Verify transcript message stored
      const allTranscripts = DbClient.getAllTranscripts();
      expect(allTranscripts.some((t: any) => t.conversation_id === convId && t.body.includes('Record this message'))).toBe(true);
    });

    it('maintains conversation continuity across multiple turns', async () => {
      // Turn 1
      const turn1 = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({ text: 'First inquiry' });

      expect(turn1.status).toBe(200);
      const convId = turn1.body.conversation_id;

      // Turn 2 passing existing conversation_id
      const turn2 = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({
          text: 'Follow up question',
          conversation_id: convId,
        });

      expect(turn2.status).toBe(200);
      expect(turn2.body.conversation_id).toBe(convId);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 5. Human Escalation Signaling
  // ══════════════════════════════════════════════════════════════════
  describe('5. Escalation Signaling', () => {
    it('detects escalation request and records escalation payload', async () => {
      const res = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({ text: 'I need to speak to a human representative right now' });

      expect(res.status).toBe(200);
      expect(res.body.escalation).toBeDefined();
      expect(res.body.escalation.requested).toBe(true);
      expect(res.body.escalation.reason).toContain('speak to a human');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 6. Shared Orchestration Integration Across Web, Voice and Brain
  // ══════════════════════════════════════════════════════════════════
  describe('6. Shared Brain Orchestration Across All Transports', () => {
    it('executes identically via Brain API, Web Interface, and Twilio Voice Turn', async () => {
      // 1. Direct Brain API
      const brainRes = await request(app)
        .post('/api/v1/brain/turn')
        .set('x-cst-api-key', TEST_API_KEY)
        .send({ text: 'What is the status of my farm?' });

      expect(brainRes.status).toBe(200);
      expect(brainRes.body.reply_text).toBeDefined();

      // 2. Web Interface Adapter
      const webSessionRes = await request(app)
        .post('/api/v1/web/session')
        .send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });
      expect(webSessionRes.status).toBe(201);
      const sessionToken = webSessionRes.body.session;

      const webRes = await request(app)
        .post('/api/v1/web/message')
        .set('x-cst-session', sessionToken)
        .send({ text: 'What is the status of my farm?' });

      expect(webRes.status).toBe(200);
      expect(webRes.body.reply_text).toBeDefined();

      // 3. Twilio Telephony Ingress
      const voicePayload: Record<string, string> = {
        CallSid: 'CALL_ORCHESTRATION_TEST_001',
        From: '+923082113844',
        To: '+19715885823',
        SpeechResult: 'What is the status of my farm?',
        CallStatus: 'in-progress',
      };

      const voiceRes = await request(app)
        .post('/webhooks/twilio/voice/turn')
        .set('Host', 'localhost:3000')
        .set('X-Twilio-Signature', twilioSigTurn(voicePayload))
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send(voicePayload);

      expect(voiceRes.status).toBe(200);
      expect(voiceRes.body.status).toBe('synthesized');
      expect(voiceRes.body.text).toBeDefined();

      // All 3 routes target the same tenant and project
      expect(brainRes.body.tenant_id).toBe('tenant-vfarm-01');
      expect(webRes.body.tenant_id).toBe('tenant-vfarm-01');
      expect(voiceRes.body.tenant_id).toBe('tenant-vfarm-01');
    });
  });
});
