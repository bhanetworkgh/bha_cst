import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { processOutboundQueue } from '../../engine/src/transport/twilio/outbound.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';

describe('Outbound Transport Unit Tests', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    // Outbound SMS tenancy resolves through project -> service_number_binding.
    CoreRegistry.resetToDefault();
  });

  it('handles delivery status callbacks cleanly and advances the stored delivery state', async () => {
    // Seed an outbound message record
    await DbClient.saveOutboundMessage({
      id: 'out_deliv_001',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      to_e164: '+15551234567',
      from_e164: '+19715885823',
      body: 'Status delivery test',
      correlation_id: 'corr_deliv_test',
      turn_id: 'corr_deliv_test',
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
  });

  it('never moves a terminal delivery state backwards (delivered then failed/undelivered)', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_deliv_monotonic',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      to_e164: '+15551234567',
      from_e164: '+19715885823',
      body: 'Monotonic delivery test',
      correlation_id: 'corr_deliv_mono',
      turn_id: 'corr_deliv_mono',
      provider_sid: 'SM_DELIVERY_MONO_001',
      status: 'sent',
    });

    const callback = (status: string, errorCode?: string) =>
      request(app)
        .post('/webhooks/twilio/delivery-status')
        .set('x-test-bypass-signature', 'true')
        .type('form')
        .send({
          MessageSid: 'SM_DELIVERY_MONO_001',
          MessageStatus: status,
          ErrorCode: errorCode,
          To: '+19715885823',
          From: '+15551234567',
        });

    expect((await callback('delivered')).status).toBe(204);
    const record = DbClient.getAllMessagesOut().find((m) => m.id === 'out_deliv_monotonic');
    expect(record?.status).toBe('delivered');

    // Regression: a late `failed` callback used to overwrite `delivered`.
    expect((await callback('failed', '30008')).status).toBe(204);
    expect(record?.status).toBe('delivered');

    expect((await callback('undelivered')).status).toBe(204);
    expect(record?.status).toBe('delivered');

    // Nor can it regress all the way back to a non-terminal state.
    expect((await callback('sent')).status).toBe(204);
    expect(record?.status).toBe('delivered');
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

    // Pre-record consent so the consent gate doesn't block this operational SMS
    await import('../../engine/src/consent/service.js').then(m => m.recordConsent(
      'tenant-vfarm-01', '+15551234567', { projectId: 'proj-vfarm-main', source: 'test' },
    ));

    await DbClient.saveOutboundMessage({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      to_e164: '+15551234567',
      body: 'Testing retry mechanism',
      correlation_id: 'corr_retry_test',
    });

    await processOutboundQueue();

    // Must have retried 3 times and succeeded on the 3rd attempt
    expect(callCount).toBe(3);
  });
});
