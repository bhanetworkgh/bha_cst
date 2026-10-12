/**
 * A2P Operational Acceptance Test Suite
 *
 * Verifies the 11 operational acceptance requirements for CST Customer Care
 * on approved A2P sender number +1 (971) 588-5823:
 *
 * 1. START produces the expected opt-in response and state transition under the documented policy.
 * 2. A canonical consent prompt is recorded correctly.
 * 3. Valid affirmative consent activates only the matching number/project.
 * 4. An authorized outbound reply is accepted by the provider.
 * 5. HELP produces the expected response.
 * 6. STOP records opt-out and prevents subsequent ordinary outbound messages.
 * 7. Further inbound messages after STOP do not reactivate consent or trigger prohibited replies.
 * 8. Re-subscription behaves exactly as documented.
 * 9. Duplicate and delayed Twilio webhooks do not duplicate state transitions or messages.
 * 10. Failed or blocked sends do not call the provider.
 * 11. Delivery-status callbacks and provider errors are handled and observable where implemented.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';
import { processOutboundQueue } from '../../engine/src/transport/twilio/outbound.js';
import {
  getConsentStatus,
  recordConsentPrompt,
  getConsentPrompt,
  isConsentPromptValid,
  recordOptOut,
  recordConsent,
} from '../../engine/src/consent/service.js';
import {
  CONSENT_WORDING_VERSION,
  CONSENT_WORDING_TEXT,
  HELP_RESPONSE_TEXT,
} from '../../engine/src/consent/wording.js';

const APPROVED_SENDER_DID = '+19715885823';
const TEST_CUSTOMER_NUMBER = '+15552345678';
const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_ID = 'proj-vfarm-main';

describe('A2P Operational Acceptance Verification (+1 971 588-5823)', () => {
  const app = createApp();
  let dispatchedToTwilio: SendSmsParams[] = [];

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    dispatchedToTwilio = [];

    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      dispatchedToTwilio.push(params);
      return {
        sid: `SM_MOCK_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        status: 'sent',
      };
    });
  });

  const sendTwilioWebhook = async (body: {
    MessageSid: string;
    From: string;
    To: string;
    Body: string;
  }) => {
    return request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send(body);
  };

  it('1 & 2. START produces expected response, records canonical consent prompt, and initiates documented re-subscription', async () => {
    // Customer must be opted out first for re-subscription START flow
    await recordOptOut(TENANT_ID, TEST_CUSTOMER_NUMBER, { projectId: PROJECT_ID });
    const preCheck = await getConsentStatus(TENANT_ID, TEST_CUSTOMER_NUMBER, PROJECT_ID);
    expect(preCheck.status).toBe('opted_out');

    const webhookRes = await sendTwilioWebhook({
      MessageSid: 'SM_START_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'START',
    });
    expect(webhookRes.status).toBe(204);

    // Wait for async queue worker
    await new Promise((r) => setTimeout(r, 60));

    // A canonical prompt must be recorded in the store
    const prompt = await getConsentPrompt(TEST_CUSTOMER_NUMBER, TENANT_ID, PROJECT_ID);
    expect(prompt).not.toBeNull();
    expect(prompt!.prompt_type).toBe('resubscribe');
    expect(prompt!.wording_version).toBe(CONSENT_WORDING_VERSION);
    expect(prompt!.wording_snapshot).toBe(CONSENT_WORDING_TEXT);

    // Response must be sent via Twilio with the canonical wording text
    expect(dispatchedToTwilio.length).toBe(1);
    expect(dispatchedToTwilio[0].to).toBe(TEST_CUSTOMER_NUMBER);
    expect(dispatchedToTwilio[0].from).toBe(APPROVED_SENDER_DID);
    expect(dispatchedToTwilio[0].body).toContain(CONSENT_WORDING_TEXT);
    expect(dispatchedToTwilio[0].body).toContain('Reply STOP at any time to opt out');
  });

  it('3. Valid affirmative consent activates only the matching number/project', async () => {
    // Simulate active consent prompt sent to TEST_CUSTOMER_NUMBER
    const recordedPrompt = await recordConsentPrompt(
      TEST_CUSTOMER_NUMBER,
      TENANT_ID,
      'resubscribe',
      { projectId: PROJECT_ID, actor: 'test' },
    );
    expect(recordedPrompt).toBeDefined();

    // Inbound affirmative YES
    const webhookRes = await sendTwilioWebhook({
      MessageSid: 'SM_YES_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'YES',
    });
    expect(webhookRes.status).toBe(204);

    await new Promise((r) => setTimeout(r, 60));

    // Matching number and project must now be opted_in
    const matchingStatus = await getConsentStatus(TENANT_ID, TEST_CUSTOMER_NUMBER, PROJECT_ID);
    expect(matchingStatus.status).toBe('opted_in');
    expect(matchingStatus.record?.wording_version).toBe(CONSENT_WORDING_VERSION);

    // Unrelated project must remain not_consented
    const otherProjectStatus = await getConsentStatus(TENANT_ID, TEST_CUSTOMER_NUMBER, 'proj-other');
    expect(otherProjectStatus.status).toBe('not_consented');

    // Unrelated phone must remain not_consented
    const otherPhoneStatus = await getConsentStatus(TENANT_ID, '+15559990000', PROJECT_ID);
    expect(otherPhoneStatus.status).toBe('not_consented');

    // Opt-in confirmation sent to user
    expect(dispatchedToTwilio.length).toBe(1);
    expect(dispatchedToTwilio[0].body).toContain("You're opted in");
  });

  it('4. An authorized outbound reply is accepted by the provider for consented user', async () => {
    await recordConsent(TENANT_ID, TEST_CUSTOMER_NUMBER, { projectId: PROJECT_ID });

    // Seed customer in DB
    DbClient.seedCustomer({
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      phone_e164: TEST_CUSTOMER_NUMBER,
      customer_ref: 'cust_approved_test',
      role: 'owner',
      farm_ids: ['farm_austin_main'],
    });

    const webhookRes = await sendTwilioWebhook({
      MessageSid: 'SM_AUTH_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'what is my farm status',
    });
    expect(webhookRes.status).toBe(204);

    await new Promise((r) => setTimeout(r, 100));

    expect(dispatchedToTwilio.length).toBe(1);
    expect(dispatchedToTwilio[0].from).toBe(APPROVED_SENDER_DID);
    expect(dispatchedToTwilio[0].to).toBe(TEST_CUSTOMER_NUMBER);
  });

  it('5. HELP produces the expected response with contact info and opt-out instructions', async () => {
    const webhookRes = await sendTwilioWebhook({
      MessageSid: 'SM_HELP_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'HELP',
    });
    expect(webhookRes.status).toBe(204);

    await new Promise((r) => setTimeout(r, 60));

    expect(dispatchedToTwilio.length).toBe(1);
    expect(dispatchedToTwilio[0].from).toBe(APPROVED_SENDER_DID);
    expect(dispatchedToTwilio[0].to).toBe(TEST_CUSTOMER_NUMBER);
    expect(dispatchedToTwilio[0].body).toBe(HELP_RESPONSE_TEXT);
    expect(dispatchedToTwilio[0].body).toContain('support@bhanetwork.org');
    expect(dispatchedToTwilio[0].body).toContain('STOP');
  });

  it('6. STOP records opt-out and prevents subsequent ordinary outbound messages', async () => {
    // Start opted-in
    await recordConsent(TENANT_ID, TEST_CUSTOMER_NUMBER, { projectId: PROJECT_ID });

    const webhookRes = await sendTwilioWebhook({
      MessageSid: 'SM_STOP_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'STOP',
    });
    expect(webhookRes.status).toBe(204);

    await new Promise((r) => setTimeout(r, 60));

    // Status must be opted_out
    const status = await getConsentStatus(TENANT_ID, TEST_CUSTOMER_NUMBER, PROJECT_ID);
    expect(status.status).toBe('opted_out');
    expect(status.record?.opted_out_at).toBeTruthy();

    // STOP confirmation message was dispatched
    expect(dispatchedToTwilio.length).toBe(1);
    expect(dispatchedToTwilio[0].body).toContain('unsubscribed');

    // Attempting an ordinary outbound send now must fail closed
    dispatchedToTwilio = [];
    await DbClient.saveOutboundMessage({
      id: 'out_blocked_after_stop',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: APPROVED_SENDER_DID,
      to_e164: TEST_CUSTOMER_NUMBER,
      body: 'Ordinary support notification',
      correlation_id: 'corr_blocked_stop',
      turn_id: 'corr_blocked_stop',
      status: 'pending',
      consent_exempt: false,
    });
    await processOutboundQueue();

    // Provider must NOT have been called
    expect(dispatchedToTwilio.length).toBe(0);
    const msgRecord = DbClient.getAllMessagesOut().find((m) => m.id === 'out_blocked_after_stop');
    expect(msgRecord?.status).toBe('refused');
    expect(msgRecord?.error_message).toContain('opted out');
  });

  it('7. Further inbound messages after STOP do not reactivate consent or trigger prohibited replies', async () => {
    // Customer is opted out
    await recordOptOut(TENANT_ID, TEST_CUSTOMER_NUMBER, { projectId: PROJECT_ID });

    // Customer texts "hello"
    const webhookRes = await sendTwilioWebhook({
      MessageSid: 'SM_AFTER_STOP_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'Hello, are you there?',
    });
    expect(webhookRes.status).toBe(204);

    await new Promise((r) => setTimeout(r, 80));

    // No reply sent to Twilio
    expect(dispatchedToTwilio.length).toBe(0);

    // Consent must still remain opted_out
    const status = await getConsentStatus(TENANT_ID, TEST_CUSTOMER_NUMBER, PROJECT_ID);
    expect(status.status).toBe('opted_out');
  });

  it('8. Re-subscription behaves exactly as documented (START -> prompt -> YES -> opted_in)', async () => {
    await recordOptOut(TENANT_ID, TEST_CUSTOMER_NUMBER, { projectId: PROJECT_ID });

    // Step 1: START
    await sendTwilioWebhook({
      MessageSid: 'SM_RESUB_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'start',
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(dispatchedToTwilio.length).toBe(1);
    expect(dispatchedToTwilio[0].body).toContain(CONSENT_WORDING_TEXT);

    // Step 2: Unrelated text before YES does not activate consent
    dispatchedToTwilio = [];
    await sendTwilioWebhook({
      MessageSid: 'SM_RESUB_002',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'tell me more',
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(dispatchedToTwilio.length).toBe(0);
    expect((await getConsentStatus(TENANT_ID, TEST_CUSTOMER_NUMBER, PROJECT_ID)).status).toBe('opted_out');

    // Step 3: Affirmative "YES"
    await sendTwilioWebhook({
      MessageSid: 'SM_RESUB_003',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'YES',
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(dispatchedToTwilio.length).toBe(1);
    expect(dispatchedToTwilio[0].body).toContain("You're opted in");

    const finalStatus = await getConsentStatus(TENANT_ID, TEST_CUSTOMER_NUMBER, PROJECT_ID);
    expect(finalStatus.status).toBe('opted_in');
    expect(finalStatus.record?.opted_out_at).toBeNull();
  });

  it('9. Duplicate and delayed Twilio webhooks do not duplicate state transitions or messages', async () => {
    const payload = {
      MessageSid: 'SM_DEDUP_TEST_001',
      From: TEST_CUSTOMER_NUMBER,
      To: APPROVED_SENDER_DID,
      Body: 'HELP',
    };

    // First arrival
    const res1 = await sendTwilioWebhook(payload);
    expect(res1.status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatchedToTwilio.length).toBe(1);

    // Duplicate webhook with same MessageSid
    const res2 = await sendTwilioWebhook(payload);
    expect(res2.status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));

    // Zero additional messages dispatched
    expect(dispatchedToTwilio.length).toBe(1);
  });

  it('10. Failed or blocked sends do not call the provider', async () => {
    // Case 1: unconsented recipient
    await DbClient.saveOutboundMessage({
      id: 'out_unconsented_1',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: APPROVED_SENDER_DID,
      to_e164: '+15550001111', // unconsented
      body: 'Hello unconsented',
      correlation_id: 'corr_unconsented',
      turn_id: 'corr_unconsented',
      status: 'pending',
      consent_exempt: false,
    });

    // Case 2: unbound project (no service number binding)
    await DbClient.saveOutboundMessage({
      id: 'out_unbound_proj',
      tenant_id: TENANT_ID,
      project_id: 'proj-nonexistent',
      from_e164: APPROVED_SENDER_DID,
      to_e164: TEST_CUSTOMER_NUMBER,
      body: 'Hello unbound',
      correlation_id: 'corr_unbound',
      turn_id: 'corr_unbound',
      status: 'pending',
      consent_exempt: false,
    });

    await processOutboundQueue();

    // Provider MUST NOT have been called
    expect(dispatchedToTwilio.length).toBe(0);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === 'out_unconsented_1')?.status).toBe('refused');
    expect(DbClient.getAllMessagesOut().find((m) => m.id === 'out_unbound_proj')?.status).toBe('refused');
  });

  it('11. Delivery-status callbacks and provider errors are handled and observable', async () => {
    // Record outbound message in store with a provider_sid
    await DbClient.saveOutboundMessage({
      id: 'out_delivery_trace_1',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: APPROVED_SENDER_DID,
      to_e164: TEST_CUSTOMER_NUMBER,
      body: 'Delivery tracking test',
      correlation_id: 'turn_corr_delivery_01',
      turn_id: 'turn_corr_delivery_01',
      status: 'sent',
      provider_sid: 'SM_DELIVERY_CALLBACK_001',
    });

    // Twilio delivery callback: delivered
    const callbackRes = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_DELIVERY_CALLBACK_001',
        MessageStatus: 'delivered',
        To: APPROVED_SENDER_DID,
      });

    expect(callbackRes.status).toBe(204);

    const updated = DbClient.getAllMessagesOut().find((m) => m.provider_sid === 'SM_DELIVERY_CALLBACK_001');
    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('delivered');

    // Twilio delivery callback: failed with provider error code
    await DbClient.saveOutboundMessage({
      id: 'out_delivery_trace_2',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: APPROVED_SENDER_DID,
      to_e164: TEST_CUSTOMER_NUMBER,
      body: 'Delivery error test',
      correlation_id: 'turn_corr_delivery_02',
      turn_id: 'turn_corr_delivery_02',
      status: 'sent',
      provider_sid: 'SM_DELIVERY_CALLBACK_ERR',
    });

    const errorCallbackRes = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        MessageSid: 'SM_DELIVERY_CALLBACK_ERR',
        MessageStatus: 'failed',
        ErrorCode: '30007',
        ErrorMessage: 'Carrier Violation (A2P Filter)',
        To: APPROVED_SENDER_DID,
      });

    expect(errorCallbackRes.status).toBe(204);

    const errorUpdated = DbClient.getAllMessagesOut().find((m) => m.provider_sid === 'SM_DELIVERY_CALLBACK_ERR');
    expect(errorUpdated?.status).toBe('failed');
    expect(errorUpdated?.error_message).toContain('30007');
  });
});
