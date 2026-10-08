import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';

import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('Isolation Test 5: Unknown Sender Safe Onboarding Response Path', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'Your farm status is healthy.' }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves unknown sender a safe generic onboarding reply without auto-registering customer data', async () => {
    let sentMessageParams: SendSmsParams | null = null;
    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      sentMessageParams = params;
      return { sid: 'SM_OUTBOUND_TEST5', status: 'queued' };
    });

    const unknownSenderPhone = '+15550009999'; // Sender not pre-registered
    const validReceivingNumber = '+19715885823'; // vFarm system #1 number

    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_TEST_5_NEW_CONTACT',
        From: unknownSenderPhone,
        To: validReceivingNumber,
        Body: 'Hello, I need help with my new farm',
      });

    expect(res.status).toBe(204);

    // Wait briefly for async handler execution
    await new Promise((r) => setTimeout(r, 150));

    // 1. Verify outbound reply was sent containing the safe onboarding reply
    expect(sentMessageParams).not.toBeNull();
    const sent = sentMessageParams as SendSmsParams | null;
    expect(sent?.to).toBe(unknownSenderPhone);
    const systemConfig = SystemsRegistry.getSystemByTenantId('tenant-vfarm-01');
    expect(sent?.body).toContain(systemConfig?.onboarding_reply);
    expect(sent?.body).toContain('To opt in, reply YES');

    // 2. Verify the unknown sender was NOT auto-registered in the customer registry
    const customerRecord = DbClient.lookupCustomerByPhone(unknownSenderPhone, 'tenant-vfarm-01');
    expect(customerRecord).toBeNull();

    // 3. Verify conversation transcript was logged under opaque reference
    expect(DbClient.getConversationCount()).toBe(1);
    const storedMsg = DbClient.getInboundMessage('SM_TEST_5_NEW_CONTACT');
    expect(storedMsg).toBeDefined();
    expect(storedMsg?.tenant_id).toBe('tenant-vfarm-01');
  });
});
