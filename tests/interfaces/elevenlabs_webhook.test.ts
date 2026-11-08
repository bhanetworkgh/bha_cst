import { CstDashboardPublisher, setActiveDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../../engine/src/app.js';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { CallLogPoster } from '../../engine/src/notifications/call_log.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { CutOverManager } from '../../engine/src/observability/cut_over.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('ElevenLabs Post-Call Webhook & cst.event.v1 Pipeline (Deliverable D)', () => {
  const app = createApp();
  const testSecret = 'test_webhook_secret_12345';
  let callLog: ReturnType<typeof vi.fn>;

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
    callLog = vi.fn().mockResolvedValue({ posted: true, via: 'bot', ts: '1794000000.000100', transcript: 'file' });
    CallLogPoster.mockHandler = callLog;
    FailureDetector.reset();
    CutOverManager.reset();
    DbClient.clearInMemory();
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    CallLogPoster.mockHandler = null;
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

    // The call log card went to the customer service channel, transcript alongside
    expect(callLog).toHaveBeenCalledTimes(1);
    const [card, transcript] = callLog.mock.calls[0];
    expect(card.blocks[0].text.text).toContain('Call ended');
    expect(JSON.stringify(card.blocks)).toContain('Customer checked Austin HQ temperature');
    expect(transcript).toContain('Caller: Hi, what is the temperature in Austin HQ?');
    // Nothing went through the error router on a clean call
    expect(mockSlack).not.toHaveBeenCalled();
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
    expect(callLog).toHaveBeenCalledTimes(1);

    // Second send (duplicate retry from provider) -> already_processed
    const res2 = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', sig)
      .send(validPayload);
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('already_processed');
    expect(callLog).toHaveBeenCalledTimes(1); // Did not re-post the call log
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

  it('6b. Uses CST Genie analysis for a person request, not words in the transcript', async () => {
    const wordsOnly = {
      ...validPayload,
      call_id: 'conv_words_only',
      conversation_id: 'conv_words_only',
      transcript: [
        { role: 'user', message: 'Is the agent a human?', time_in_call_secs: 2 },
        { role: 'agent', message: "I'm Genie, the automated assistant.", time_in_call_secs: 4 },
      ],
    };
    const res1 = await request(app).post('/webhooks/elevenlabs/post-call').set('elevenlabs-signature', computeSignature(wordsOnly)).send(wordsOnly);
    expect(res1.body.escalation_created).toBe(false);

    const asked = {
      ...validPayload,
      call_id: 'conv_genie_person',
      conversation_id: 'conv_genie_person',
      analysis: {
        transcript_summary: 'Caller asked for a person about moving the rack.',
        call_successful: 'success',
        evaluation_criteria_results: { handoff_honest: { criteria_id: 'handoff_honest', result: 'success', rationale: 'ok' } },
        data_collection_results: {
          caller_name: { value: 'Maria Lopez' },
          caller_email: { value: 'maria.lopez@example.com' },
          wanted_person: { value: true },
          handoff_sent: { value: true },
        },
      },
    };
    const res2 = await request(app).post('/webhooks/elevenlabs/post-call').set('elevenlabs-signature', computeSignature(asked)).send(asked);
    expect(res2.body.escalation_created).toBe(true);
    const record = await DbClient.getEscalationRecord(res2.body.escalation_id);
    expect(record?.caller_email).toBe('maria.lopez@example.com');
    const card = callLog.mock.calls[1][0];
    expect(card.blocks[0].text.text).toContain('asked for a person');
    expect(JSON.stringify(card.blocks)).toContain('Sent to the team');
  });

  it('7. Handles Slack failure safely and records for retry without breaking event persistence', async () => {
    const mockSlack = vi.fn().mockRejectedValue(new Error('Slack API 500 error'));
    ErrorRouter.setMockHandler(mockSlack);
    callLog.mockResolvedValue({ posted: false, via: 'bot', transcript: 'none', error: 'chat.postMessage: channel_not_found' });

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

    // The failed call log is reported to CST ops, never to the customer service channel
    expect(mockSlack).toHaveBeenCalledWith(
      expect.objectContaining({ error_class: 'CST', destination_channel: '#cst-ops' }),
      expect.anything()
    );
    // ErrorRouter tracks that report's failed delivery for retry
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

  it('10. Processes real nested data schema sent by ElevenLabs post_call_transcription webhook', async () => {
    const nestedPayload = {
      type: 'post_call_transcription',
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        agent_id: 'agent_5701m66tmyfseeyt84r3crwrg3b7',
        conversation_id: 'conv_nested_real_001',
        status: 'done',
        transcript: [
          { role: 'agent', message: 'Hello, welcome to Bays Horizon Farm. How can I help?', time_in_call_secs: 1 },
          { role: 'user', message: 'Hi, what is the temperature in Greenhouse 2?', time_in_call_secs: 4 },
          { role: 'agent', message: 'Greenhouse 2 temperature is currently 22.4 degrees Celsius and optimal.', time_in_call_secs: 7 },
        ],
        metadata: {
          call_duration_secs: 64,
          phone_call: { external_number: '+12025550123' },
          cost: 110,
          authorization_method: 'xi-api-key',
        },
        analysis: {
          transcript_summary: 'Customer checked Greenhouse 2 temperature. Agent verified normal at 22.4C.',
          call_successful: 'success',
          evaluation_criteria_results: {
            escalation_requested: false,
          },
          data_collection_results: {
            customer_query: 'Greenhouse 2 temperature',
          },
        },
      },
    };

    const rawBody = JSON.stringify(nestedPayload);
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
    expect(res.body.conversation_id).toBe('conv_nested_real_001');

    const persisted = ElevenLabsWebhookService.getPersistedEvents();
    const transcriptEvt = persisted.find((e) => e.correlation_id === 'conv_nested_real_001' && e.type === 'cst.transcript');
    expect(transcriptEvt).toBeDefined();
    expect((transcriptEvt as any).data.messages).toHaveLength(3);
    expect((transcriptEvt as any).data.summary).toContain('Greenhouse 2');

    const outcomeEvt = persisted.find((e) => e.correlation_id === 'conv_nested_real_001' && e.type === 'cst.outcome');
    expect(outcomeEvt).toBeDefined();
    expect((outcomeEvt as any).data.status).toBe('resolved');
    expect((outcomeEvt as any).data.duration_secs).toBe(64);
  });
  it('11. A tool turn with a null message does not refuse the report, and the call goes to the dashboard as one cst.turn', async () => {
    const sent: any[] = [];
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'http://localhost:9/api/engine/cst-events',
      dashboardKey: 'k',
      dryRun: false,
      fetchFn: (async (_u: string, init: any) => {
        sent.push(JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      }) as any,
    });
    setActiveDashboardPublisher(publisher);
    const payload = {
      type: 'post_call_transcription',
      event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        conversation_id: 'conv_toolturn001',
        start_time_unix_secs: Math.floor(Date.now() / 1000),
        transcript: [
          { role: 'user', message: 'What does vFarm do?' },
          { role: 'agent', message: null, tool_calls: [{ tool_name: 'lookup_help_pages' }] },
          { role: 'agent', message: 'It grows food indoors.' },
        ],
        metadata: { call_duration_secs: 30, phone_call: { external_number: '+12025550123' } },
        analysis: { call_successful: 'success' },
      },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const hmacHex = createHmac('sha256', testSecret).update(`${timestamp}.${rawBody}`).digest('hex');
    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('ElevenLabs-Signature', `t=${timestamp},v0=${hmacHex}`)
      .set('Content-Type', 'application/json')
      .send(rawBody);
    setActiveDashboardPublisher(null);

    expect(res.status).toBe(200);
    expect(res.body.dashboard_published).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].event_type).toBe('cst.turn');
    expect(sent[0].turn_id).toBe('conv_toolturn001');
    expect(sent[0].channel).toBe('voice');
    expect(sent[0].message).toBe('What does vFarm do?');
    expect(sent[0].reply).toBe('It grows food indoors.');
    expect(sent[0].duration_ms).toBe(30000);
    expect(sent[0].customer.phone_e164).toBe('+12025550123');
  });
});
