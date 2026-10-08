import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';

import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('Definition of Done: Twilio Transport E2E Roundtrip', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'BHARAG Knowledge: Bay 4 telemetry parameters normal.' }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes full SMS roundtrip: webhook in -> verify -> resolve -> canned handle() -> outbound queue -> Twilio send', async () => {
    let outboundCall: SendSmsParams | null = null;
    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      outboundCall = params;
      return { sid: 'SM_ROUNDTRIP_REPLY_SID', status: 'sent' };
    });

    const knownSender = '+15551234567'; // Known vFarm customer
    const validReceivingNumber = '+19715885823'; // vFarm system #1 number
    const messageId = 'SM_E2E_ROUNDTRIP_001';

    // Pre-record SMS consent for the known sender so the outbound consent gate
    // allows the reply through. Consent is separate from vFarm identity — the
    // test is exercising the transport path, not the consent flow.
    const { recordConsent } = await import('../../engine/src/consent/service.js');
    await recordConsent('tenant-vfarm-01', knownSender, {
      projectId: 'proj-vfarm-main',
      source: 'e2e_test_setup',
    });

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

    // Wait for async execution (BHARAG cluster call adds latency)
    await new Promise((r) => setTimeout(r, 3000));

    // 3. Verify conversation row exists in DB
    expect(DbClient.getConversationCount()).toBeGreaterThanOrEqual(1);

    // 4. Verify message transcript stored
    expect(DbClient.getTranscriptCount()).toBeGreaterThanOrEqual(1);

// 5. Verify IntentRouter reply was dispatched via outbound worker.
    // The roundtrip completes regardless of whether the intent could be
    // answered: "How is Bay 4 doing today?" is a status intent, and the caller
    // has no vFarm-verified unit (vFarm does not expose a unit id on
    // org-member / farm-grant records), so the router refuses rather than
    // substituting the farm id where a unit id belongs. The refusal still
    // reaches Twilio, which is what this test verifies.
    expect(outboundCall).not.toBeNull();
    const sent = outboundCall as SendSmsParams | null;
    expect(sent?.to).toBe(knownSender);
    expect(sent?.body).toContain('not linked to an active vFarm unit');
    // And it must never be answered with fabricated telemetry about Bay 4.
    expect(sent?.body).not.toContain('BHARAG Knowledge: Bay 4');
  });
});
