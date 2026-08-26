import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('Isolation Test 4: Bad X-Twilio-Signature', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
  });

  it('rejects request with invalid signature BEFORE any DB touch', async () => {
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('X-Twilio-Signature', 'invalid_bogus_signature_hash')
      .type('form')
      .send({
        MessageSid: 'SM_TEST_4_BAD_SIG',
        From: '+15551234567',
        To: '+15550001111', // Valid receiving number
        Body: 'Attacker payload',
      });

    // 1. Must reject with 403 Forbidden
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');

    // 2. Zero DB touch: no inbound message stored, no conversation, no transcript
    expect(DbClient.getInboundMessage('SM_TEST_4_BAD_SIG')).toBeUndefined();
    expect(DbClient.getConversationCount()).toBe(0);
    expect(DbClient.getTranscriptCount()).toBe(0);
  });
});
