import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { processOutboundQueue } from '../../engine/src/transport/twilio/outbound.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';

describe('Outbound Transport Unit Tests', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
  });

  it('handles delivery status callbacks cleanly with HTTP 204', async () => {
    const res = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true') // Dev bypass — same as all inbound tests
      .type('form')
      .send({
        MessageSid: 'SM_DELIVERY_TEST_001',
        MessageStatus: 'delivered',
        To: '+15551234567',
        From: '+15550001111',
      });

    expect(res.status).toBe(204);
  });


  it('retries failed Twilio API calls with backoff up to max attempts', async () => {
    let callCount = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Transient Twilio network timeout');
      }
      return { sid: 'SM_RETRY_SUCCESS', status: 'sent' };
    });

    await DbClient.saveOutboundMessage({
      tenant_id: 'tenant-vfarm-01',
      to_e164: '+15551234567',
      body: 'Testing retry mechanism',
      correlation_id: 'corr_retry_test',
    });

    await processOutboundQueue();

    // Must have retried 3 times and succeeded on the 3rd attempt
    expect(callCount).toBe(3);
  });
});
