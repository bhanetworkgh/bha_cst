import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';

describe('Isolation Test 5: Unknown Sender Path', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
  });

  it('triggers tenant onboarding reply for unknown sender without guessing identity', async () => {
    let sentMessageParams: SendSmsParams | null = null;
    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      sentMessageParams = params;
      return { sid: 'SM_OUTBOUND_TEST5', status: 'queued' };
    });

    const unknownSenderPhone = '+15550009999'; // Sender not in known customer map
    const validReceivingNumber = '+15550001111'; // vFarm system #1 number

    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_TEST_5_UNKNOWN_SENDER',
        From: unknownSenderPhone,
        To: validReceivingNumber,
        Body: 'Hello, I need help with my new farm',
      });

    expect(res.status).toBe(204);

    // Wait briefly for async handler execution
    await new Promise((r) => setTimeout(r, 100));

    // Verify outbound onboarding response was dispatched
    expect(sentMessageParams).not.toBeNull();
    const sent = sentMessageParams as SendSmsParams | null;
    expect(sent?.to).toBe(unknownSenderPhone);
    expect(sent?.body).toContain('Welcome to vFarm Support!');

    // Verify conversation stored opaque customer_ref and did not guess existing customer
    expect(DbClient.getConversationCount()).toBe(1);
    const storedMsg = DbClient.getInboundMessage('SM_TEST_5_UNKNOWN_SENDER');
    expect(storedMsg).toBeDefined();
    expect(storedMsg?.tenant_id).toBe('tenant-vfarm-01');
  });
});
