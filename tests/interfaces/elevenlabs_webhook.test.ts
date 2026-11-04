import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../../engine/src/app.js';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { CutOverManager } from '../../engine/src/observability/cut_over.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('ElevenLabs Post-Call Webhook & cst.event.v1 Pipeline (Deliverable D)', () => {
  const app = createApp();
  const testSecret = 'test_webhook_secret_12345';

  const validPayload = {
    type: 'post_call_transcription',
    call_id: 'conv_live_test_001',
    conversation_id: 'conv_live_test_001',
    agent_id: 'agent_vfarm_cs_v1',
    start_time_unix_secs: Math.floor(Date.now() / 1000) - 60,
    call_duration_secs: 42,
    transcript: [
      { role: 'user', message: 'Hi, what is the temperature in Austin HQ?', time_in_call_secs: 2 },
      { role: 'agent', message: 'Austin HQ temperature is 24.5C and normal.', time_in_call_secs: 5 },
    ],
    analysis: {
      transcript_summary: 'Customer checked Austin HQ temperature. Informed normal at 24.5C.',
      call_successful: 'success',
      evaluation_criteria_results: {
        escalation_requested: false,
        human_handoff: false,
      },
      data_collection_results: {
        customer_name: 'Austin Lead',
        customer_email: 'lead@austinhq.example',
      },
    },
    metadata: {
      custom_variables: {
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        caller_phone: '+923082113844',
        channel: 'voice',
      },
      caller_id: '+923082113844',
    },
  };

  function computeSignature(payload: unknown, secret = testSecret): string {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return createHmac('sha256', secret).update(raw).digest('hex');
  }

  beforeEach(() => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = testSecret;
    ElevenLabsWebhookService.reset();
    ErrorRouter.reset();
    ErrorRouter.setMockHandler(vi.fn().mockResolvedValue(true));
    FailureDetector.reset();
    CutOverManager.reset();
    DbClient.clearInMemory();
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  });

  it('1. Successfully processes a real completed-call payload and normalizes to cst.event.v1', async () => {
    const mockSlack = vi.fn().mockResolvedValue(true);
    ErrorRouter.setMockHandler(mockSlack);

    const sig = computeSignature(validPayload);
    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.events_count).toBeGreaterThanOrEqual(3); // start, transcript, outcome
    expect(res.body.slack_delivered).toBe(true);

    const persisted = ElevenLabsWebhookService.getPersistedEvents();
    expect(persisted.length).toBeGreaterThanOrEqual(3);

    // Verify cst.event.v1 structure
    const startEvt = persisted.find((e) => e.type === 'cst.interaction.start');
    const trscEvt = persisted.find((e) => e.type === 'cst.transcript');
    const outcEvt = persisted.find((e) => e.type === 'cst.outcome');

    expect(startEvt).toBeDefined();
    expect(startEvt?.specversion).toBe('cst.event.v1');
    expect(startEvt?.correlation_id).toBe('conv_live_test_001');
    expect(startEvt?.tenant_id).toBe('tenant-vfarm-01');

    expect(trscEvt).toBeDefined();
    expect(trscEvt?.type).toBe('cst.transcript');
    expect((trscEvt as any).data.messages.length).toBe(2);

    expect(outcEvt).toBeDefined();
    expect(outcEvt?.type).toBe('cst.outcome');
    expect((outcEvt as any).data.status).toBe('resolved');

    // Verify Slack event delivered to #bha-customer-service-twin
    expect(mockSlack).toHaveBeenCalledWith(
      expect.objectContaining({
        destination_channel: '#bha-customer-service-twin',
        error_class: 'CS_HANDOFF',
      }),
      expect.anything()
    );
  });

  it('2. Supports completed message / WhatsApp payload', async () => {
    const whatsAppPayload = {
      ...validPayload,
      call_id: 'conv_whatsapp_998',
      conversation_id: 'conv_whatsapp_998',
      metadata: {
        custom_variables: {
          tenant_id: 'tenant-vfarm-01',
          project_id: 'proj-vfarm-main',
          caller_phone: '+923082113844',
          channel: 'whatsapp',
        },
      },
    };

    const sig = computeSignature(whatsAppPayload);
    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(whatsAppPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');

    const persisted = ElevenLabsWebhookService.getPersistedEvents();
    const startEvt = persisted.find((e) => e.correlation_id === 'conv_whatsapp_998');
    expect(startEvt?.channel).toBe('whatsapp');
  });

  it('3. Rejects requests with invalid or missing webhook authentication', async () => {
    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', 'bad_forged_signature')
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('4. Rejects invalid payload missing both call_id and conversation_id', async () => {
    const invalidPayload = {
      type: 'post_call_transcription',
      transcript: [],
    };
    const sig = computeSignature(invalidPayload);

    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(invalidPayload);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  it('5. Ensures duplicate webhook deliveries are idempotent without duplicating events', async () => {
    const mockSlack = vi.fn().mockResolvedValue(true);
    ErrorRouter.setMockHandler(mockSlack);

    const sig = computeSignature(validPayload);

    // First send -> processed
    const res1 = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(validPayload);
    expect(res1.status).toBe(200);
    expect(res1.body.status).toBe('processed');
    expect(mockSlack).toHaveBeenCalledTimes(1);

    // Second send (duplicate retry from provider) -> already_processed
    const res2 = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(validPayload);
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('already_processed');
    expect(mockSlack).toHaveBeenCalledTimes(1); // Did not re-send Slack alert
  });

  it('6. Generates escalation event and persists escalation record when human assistance is requested', async () => {
    const escalationPayload = {
      ...validPayload,
      call_id: 'conv_escalate_404',
      conversation_id: 'conv_escalate_404',
      transcript: [
        { role: 'user', message: 'I need to speak with a human technician urgently', time_in_call_secs: 2 },
        { role: 'agent', message: 'I will escalate this immediately to our support team.', time_in_call_secs: 4 },
      ],
      analysis: {
        transcript_summary: 'Customer requested human technician for pump fault.',
        call_successful: false,
        evaluation_criteria_results: {
          escalation_requested: true,
          human_handoff: true,
        },
        data_collection_results: {
          customer_name: 'Lead Farmer',
          customer_email: 'farmer@austin.test',
        },
      },
    };

    const sig = computeSignature(escalationPayload);
    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(escalationPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.escalation_created).toBe(true);
    expect(res.body.escalation_id).toBeDefined();

    const persisted = ElevenLabsWebhookService.getPersistedEvents();
    const esclEvt = persisted.find((e) => e.type === 'cst.escalation');
    expect(esclEvt).toBeDefined();
    expect((esclEvt as any).data.reason).toContain('human technician');
    expect((esclEvt as any).data.customer_contact.name).toBe('Lead Farmer');

    // Verify durable escalation record in DbClient
    const record = await DbClient.getEscalationRecord(res.body.escalation_id);
    expect(record).not.toBeNull();
    expect(record?.caller_email).toBe('farmer@austin.test');
    expect(record?.status).toBe('pending');
  });

  it('7. Handles Slack failure safely and records for retry without breaking event persistence', async () => {
    const mockSlack = vi.fn().mockRejectedValue(new Error('Slack API 500 error'));
    ErrorRouter.setMockHandler(mockSlack);

    const payload = { ...validPayload, call_id: 'conv_slack_retry_001', conversation_id: 'conv_slack_retry_001' };
    const sig = computeSignature(payload);

    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.slack_delivered).toBe(false);

    // Event was still persisted
    const persisted = ElevenLabsWebhookService.getPersistedEvents();
    expect(persisted.some((e) => e.correlation_id === 'conv_slack_retry_001')).toBe(true);

    // ErrorRouter tracks failed delivery for retry
    expect(ErrorRouter.getFailedDeliveries().length).toBeGreaterThan(0);
  });

  it('8. Successfully authenticates using official ElevenLabs-Signature format (t=<timestamp>,v0=<hex_hmac>)', async () => {
    const payload = { ...validPayload, call_id: 'conv_official_sig_001', conversation_id: 'conv_official_sig_001' };
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${rawBody}`;
    const hmacHex = createHmac('sha256', testSecret).update(signedPayload).digest('hex');
    const headerValue = `t=${timestamp},v0=${hmacHex}`;

    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('ElevenLabs-Signature', headerValue)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.conversation_id).toBe('conv_official_sig_001');
  });

  it('9. Rejects expired ElevenLabs-Signature where timestamp is older than tolerance', async () => {
    const payload = { ...validPayload, call_id: 'conv_expired_sig_002', conversation_id: 'conv_expired_sig_002' };
    const rawBody = JSON.stringify(payload);
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago (exceeds 30 min tolerance)
    const signedPayload = `${expiredTimestamp}.${rawBody}`;
    const hmacHex = createHmac('sha256', testSecret).update(signedPayload).digest('hex');
    const headerValue = `t=${expiredTimestamp},v0=${hmacHex}`;

    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('ElevenLabs-Signature', headerValue)
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });
});
