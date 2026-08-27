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

  it('handles delivery status callbacks cleanly and updates DbClient status for delivered and failed status', async () => {
    // Seed an outbound message record
    await DbClient.saveOutboundMessage({
      id: 'out_deliv_001',
      tenant_id: 'tenant-vfarm-01',
      to_e164: '+15551234567',
      from_e164: '+19715885823',
      body: 'Status delivery test',
      correlation_id: 'corr_deliv_test',
      provider_sid: 'SM_DELIVERY_TEST_001',
      status: 'sent',
    });

    const res = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_DELIVERY_TEST_001',
        MessageStatus: 'delivered',
        To: '+19715885823',
        From: '+15551234567',
      });

    expect(res.status).toBe(204);

    // Verify database record was updated to 'delivered'
    const outboundRecord = DbClient.getAllMessagesOut().find((m) => m.id === 'out_deliv_001');
    expect(outboundRecord?.status).toBe('delivered');

    // Test failure status update
    const resFailed = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_DELIVERY_TEST_001',
        MessageStatus: 'failed',
        ErrorCode: '30008',
        To: '+19715885823',
        From: '+15551234567',
      });

    expect(resFailed.status).toBe(204);
    expect(outboundRecord?.status).toBe('failed');
    expect((outboundRecord as any)?.error_message).toContain('30008');
  });

  it('returns HTTP 400 Bad Request when delivery status payload is missing required fields', async () => {
    const res = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
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
