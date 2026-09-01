import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';

import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('Isolation Test 5: New Contact Auto-Registration Path', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();

    // Mock the BHARAG RAG connector fetch so connectors don't hit real network
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

  it('auto-registers a new sender and serves them via connectors without a wall', async () => {
    let sentMessageParams: SendSmsParams | null = null;
    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      sentMessageParams = params;
      return { sid: 'SM_OUTBOUND_TEST5', status: 'queued' };
    });

    const newSenderPhone = '+15550009999'; // Sender not pre-registered
    const validReceivingNumber = '+19715885823'; // vFarm system #1 number

    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_TEST_5_NEW_CONTACT',
        From: newSenderPhone,
        To: validReceivingNumber,
        Body: 'Hello, I need help with my new farm',
      });

    expect(res.status).toBe(204);

    // Wait briefly for async handler execution
    await new Promise((r) => setTimeout(r, 150));

    // Verify outbound reply was sent (real connector response, not an onboarding wall)
    expect(sentMessageParams).not.toBeNull();
    const sent = sentMessageParams as SendSmsParams | null;
    expect(sent?.to).toBe(newSenderPhone);
    expect(sent?.body).toBeTruthy();

    // Verify the new sender was auto-registered as a customer
    const autoRecord = DbClient.lookupCustomerByPhone(newSenderPhone, 'tenant-vfarm-01');
    expect(autoRecord).not.toBeNull();
    expect(autoRecord?.customer_ref).toMatch(/^auto_tenant-vfarm-01_/);

    // Verify conversation and message transcript were stored
    expect(DbClient.getConversationCount()).toBe(1);
    const storedMsg = DbClient.getInboundMessage('SM_TEST_5_NEW_CONTACT');
    expect(storedMsg).toBeDefined();
    expect(storedMsg?.tenant_id).toBe('tenant-vfarm-01');
  });
});
