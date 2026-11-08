import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../../engine/src/app.js';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { CallLogPoster } from '../../engine/src/notifications/call_log.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { DbClient } from '../../engine/src/db/client.js';

// 8 Nov 2026: WhatsApp conversations from the CST Genie WhatsApp agent. The
// sender comes as metadata.whatsapp.whatsapp_user_id, the channel is whatsapp,
// and the Slack card posts only when CST Genie closed it after the customer
// confirmed (end_call).
describe('WhatsApp post-call', () => {
  const app = createApp();
  const secret = 'test_webhook_secret_whatsapp';
  let cards: { text: string; blocks: any[] }[];

  const payload = (id: string, termination: string) => ({
    type: 'post_call_transcription',
    conversation_id: id,
    agent_id: 'agent_whatsapp',
    start_time_unix_secs: Math.floor(Date.now() / 1000) - 120,
    call_duration_secs: 90,
    transcript: [
      { role: 'agent', message: "Hi, you've reached Bays Horizon Network.", time_in_call_secs: 0 },
      { role: 'user', message: 'How do I check my farm?', time_in_call_secs: 5 },
      { role: 'agent', message: 'Use the vFarm app. Anything else, or shall I close this chat?', time_in_call_secs: 8 },
      { role: 'user', message: "No, that's all", time_in_call_secs: 20 },
    ],
    analysis: { transcript_summary: 'Customer asked how to check their farm.', call_successful: 'success', data_collection_results: {} },
    metadata: {
      conversation_initiation_source: 'whatsapp',
      termination_reason: termination,
      whatsapp: { direction: 'inbound', whatsapp_user_id: '2348000000001', recipient: { phone: '2348000000001' } },
    },
  });
  const send = (body: unknown) =>
    request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex'))
      .send(body);

  beforeEach(() => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = secret;
    ElevenLabsWebhookService.reset();
    ErrorRouter.reset();
    ErrorRouter.setMockHandler(vi.fn().mockResolvedValue(true));
    cards = [];
    CallLogPoster.mockHandler = (m) => { cards.push(m); return { posted: true, via: 'bot', ts: '1.1', transcript: 'file' }; };
    FailureDetector.reset();
    DbClient.clearInMemory();
  });
  afterEach(() => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    CallLogPoster.mockHandler = null;
  });

  it('posts a WhatsApp card when CST Genie closed it after the customer confirmed', async () => {
    const res = await send(payload('conv_wa_1', 'end_call tool was called.'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(cards).toHaveLength(1);
    const json = JSON.stringify(cards[0].blocks);
    expect(json).toContain('WhatsApp conversation closed');
    expect(json).toContain('Closed by CST Genie after the customer confirmed');
    expect(json).toContain('Customer +234');
    expect(json).not.toContain('2348000000001');
  });

  it('does not post a card for a chat that went quiet, but still processes it for the dashboard', async () => {
    const res = await send(payload('conv_wa_2', 'Conversation ended due to inactivity'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.slack_delivered).toBe(false);
    expect(cards).toHaveLength(0);
  });

  it('always posts a card for a WhatsApp call, even when the caller hung up', async () => {
    const body: any = payload('conv_wa_3', 'Client disconnected: 1000');
    body.metadata.text_only = false;
    body.metadata.whatsapp.call_result = 'answered';
    const res = await send(body);
    expect(res.status).toBe(200);
    expect(cards).toHaveLength(1);
    const json = JSON.stringify(cards[0].blocks);
    expect(json).toContain('WhatsApp call ended');
    expect(json).toContain('Caller hung up');
  });
});
