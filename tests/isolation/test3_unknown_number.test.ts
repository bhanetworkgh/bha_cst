import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';

describe('Isolation Test 3: Unknown Receiving Number', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
  });

  it('refuses unknown receiving number with zero DB touch and no reply', async () => {
    let twilioSendCalled = false;
    TwilioClientWrapper.setMockHandler(async () => {
      twilioSendCalled = true;
      return { sid: 'SM123', status: 'queued' };
    });

    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_TEST_3_001',
        From: '+15551234567',
        To: '+19998887777', // Unknown receiving number
        Body: 'Hello on unknown number',
      });

    // 1. Check refusal HTTP status
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SYSTEM_NOT_FOUND');

    // 2. Check zero DB touch (no inbound queue, no conversations, no transcripts)
    expect(DbClient.getInboundMessage('SM_TEST_3_001')).toBeUndefined();
    expect(DbClient.getConversationCount()).toBe(0);
    expect(DbClient.getTranscriptCount()).toBe(0);

    // 3. Check no outbound Twilio send triggered
    expect(twilioSendCalled).toBe(false);
  });
});
