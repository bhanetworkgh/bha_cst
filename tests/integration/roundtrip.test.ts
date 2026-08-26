import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';

describe('Definition of Done: Twilio Transport E2E Roundtrip', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
  });

  it('completes full SMS roundtrip: webhook in -> verify -> resolve -> canned handle() -> outbound queue -> Twilio send', async () => {
    let outboundCall: SendSmsParams | null = null;
    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      outboundCall = params;
      return { sid: 'SM_ROUNDTRIP_REPLY_SID', status: 'sent' };
    });

    const knownSender = '+15551234567'; // Known vFarm customer
    const validReceivingNumber = '+15550001111'; // vFarm system #1 number
    const messageId = 'SM_E2E_ROUNDTRIP_001';

    // 1. Send simulated Twilio webhook request
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: messageId,
        From: knownSender,
        To: validReceivingNumber,
        Body: 'How is Bay 4 doing today?',
      });

    // 2. Webhook returns HTTP 204 fast
    expect(res.status).toBe(204);

    // Wait for async execution
    await new Promise((r) => setTimeout(r, 150));

    // 3. Verify conversation row exists in DB
    expect(DbClient.getConversationCount()).toBeGreaterThanOrEqual(1);

    // 4. Verify message transcript stored
    expect(DbClient.getTranscriptCount()).toBeGreaterThanOrEqual(1);

    // 5. Verify canned handle() reply was dispatched via outbound worker
    expect(outboundCall).not.toBeNull();
    const sent = outboundCall as SendSmsParams | null;
    expect(sent?.to).toBe(knownSender);
    expect(sent?.body).toBe('Echo: How is Bay 4 doing today?');
  });
});
