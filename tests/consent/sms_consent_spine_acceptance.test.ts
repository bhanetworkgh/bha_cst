/**
 * Comprehensive Acceptance Test Suite for NI8F — SMS Consent Spine
 * Loop: LOOP-1791467054702-NI8F
 *
 * Verifies all 12 minimum acceptance criteria defined in Section 5:
 * 1. Explicit opt-in permits an eligible SMS.
 * 2. Explicit opt-out blocks an SMS.
 * 3. Unknown consent blocks an SMS.
 * 4. Missing consent records block an SMS.
 * 5. Consent database errors fail closed.
 * 6. Opt-out after queue insertion prevents delivery.
 * 7. Retry processing re-checks consent (an opt-out before retry aborts delivery).
 * 8. Repeated STOP callbacks are idempotent.
 * 9. Consent events retain correct tenant and project attribution.
 * 10. One tenant cannot use another tenant's consent record.
 * 11. Existing voice functionality remains unaffected.
 * 12. All outbound SMS paths use the canonical enforcement boundary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  canSendSms,
  getConsentStatus,
  recordConsent,
  recordOptOut,
  handleInboundConsentMessage,
} from '../../engine/src/consent/service.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';
import {
  processOutboundQueue,
  evaluateOutboundConsent,
} from '../../engine/src/transport/twilio/outbound.js';
import { OutboundMessage } from '../../engine/src/transport/twilio/types.js';

const TENANT_1 = 'tenant-vfarm-01';
const PROJECT_1 = 'proj-vfarm-main';
const TENANT_2 = 'tenant-other-02';
const PROJECT_2 = 'proj-other-main';
const SENDER_DID = '+19715885823';
const RECIPIENT_PHONE = '+15551234567';

describe('NI8F: SMS Consent Spine — Canonical Acceptance Verification', () => {
  let dispatchedSms: SendSmsParams[] = [];

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.setPool(null);
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    dispatchedSms = [];

    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      dispatchedSms.push(params);
      return {
        sid: `SM_TEST_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        status: 'sent',
      };
    });
  });

  afterEach(() => {
    DbClient.setPool(null);
    DbClient.clearAll();
  });

  // Criterion 1: Explicit opt-in permits an eligible SMS
  it('1. Explicit opt-in permits an eligible SMS', async () => {
    await recordConsent(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1 });

    const consentCheck = await canSendSms(TENANT_1, RECIPIENT_PHONE, PROJECT_1);
    expect(consentCheck.allowed).toBe(true);
    expect(consentCheck.status).toBe('opted_in');

    const msg: OutboundMessage = {
      id: 'out_msg_optin_1',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: RECIPIENT_PHONE,
      body: 'Your farm temperature alert',
      correlation_id: 'corr_optin_1',
      turn_id: 'turn_optin_1',
      status: 'pending',
    };
    await DbClient.saveOutboundMessage(msg);
    await processOutboundQueue();

    expect(dispatchedSms.length).toBe(1);
    expect(dispatchedSms[0].to).toBe(RECIPIENT_PHONE);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === msg.id)?.status).toBe('sent');
  });

  // Criterion 2: Explicit opt-out blocks an SMS
  it('2. Explicit opt-out blocks an SMS', async () => {
    await recordConsent(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1 });
    await recordOptOut(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1, reason: 'STOP received' });

    const consentCheck = await canSendSms(TENANT_1, RECIPIENT_PHONE, PROJECT_1);
    expect(consentCheck.allowed).toBe(false);
    expect(consentCheck.status).toBe('opted_out');

    const msg: OutboundMessage = {
      id: 'out_msg_optout_1',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: RECIPIENT_PHONE,
      body: 'Blocked notification',
      correlation_id: 'corr_optout_1',
      turn_id: 'turn_optout_1',
      status: 'pending',
    };
    await DbClient.saveOutboundMessage(msg);
    await processOutboundQueue();

    expect(dispatchedSms.length).toBe(0);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === msg.id)?.status).toBe('refused');
  });

  // Criterion 3 & 4: Unknown / missing consent records block an SMS
  it('3 & 4. Unknown and missing consent records block an SMS (fail-closed)', async () => {
    const unconsentedPhone = '+15559990000';
    const status = await getConsentStatus(TENANT_1, unconsentedPhone, PROJECT_1);
    expect(status.status).toBe('not_consented');
    expect(status.record).toBeNull();

    const consentCheck = await canSendSms(TENANT_1, unconsentedPhone, PROJECT_1);
    expect(consentCheck.allowed).toBe(false);
    expect(consentCheck.status).toBe('not_consented');

    const msg: OutboundMessage = {
      id: 'out_msg_missing_consent',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: unconsentedPhone,
      body: 'Unconsented message',
      correlation_id: 'corr_missing_1',
      turn_id: 'turn_missing_1',
      status: 'pending',
    };
    await DbClient.saveOutboundMessage(msg);
    await processOutboundQueue();

    expect(dispatchedSms.length).toBe(0);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === msg.id)?.status).toBe('refused');
  });

  // Criterion 5: Consent database errors fail closed
  it('5. Consent database errors fail closed', async () => {
    // 1. Queue a pending message first
    const msg: OutboundMessage = {
      id: 'out_msg_db_error',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: '+15558887777',
      body: 'Message during DB outage',
      correlation_id: 'corr_db_err',
      turn_id: 'turn_db_err',
      status: 'pending',
    };
    await DbClient.saveOutboundMessage(msg);

    // 2. Inject broken pool that specifically fails consent queries
    const brokenPool: any = {
      query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('sms_consents')) {
          throw new Error('PostgreSQL connection timeout / crash');
        }
        if (sql.includes('FROM messages_out')) {
          return {
            rows: [
              {
                id: msg.id,
                tenant_id: msg.tenant_id,
                project_id: msg.project_id,
                from_e164: msg.from_e164,
                to_e164: msg.to_e164,
                body: msg.body,
                status: 'pending',
                retry_count: 0,
                created_at: new Date().toISOString(),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE messages_out')) {
          return { rows: [{ id: params ? params[0] : msg.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    DbClient.setPool(brokenPool);

    // canSendSms must catch the error, log audit, and return allowed: false
    const check = await canSendSms(TENANT_1, '+15558887777', PROJECT_1);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('database error');

    // evaluateOutboundConsent must fail closed with lookup_error
    const evalResult = await evaluateOutboundConsent(msg);
    expect(evalResult.allowed).toBe(false);
    expect(evalResult.status).toBe('lookup_error');
    expect(evalResult.reason).toContain('consent lookup failed');

    // Queue worker must refuse message and NEVER dispatch to Twilio
    await processOutboundQueue();
    expect(dispatchedSms.length).toBe(0);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === msg.id)?.status).toBe('refused');
  });

  // Criterion 6: Opt-out after queue insertion prevents delivery
  it('6. Opt-out after queue insertion prevents delivery', async () => {
    // 1. Recipient is initially consented
    await recordConsent(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1 });

    // 2. Message is enqueued
    const msg: OutboundMessage = {
      id: 'out_msg_queued_before_stop',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: RECIPIENT_PHONE,
      body: 'Message queued before opt-out',
      correlation_id: 'corr_queue_stop',
      turn_id: 'turn_queue_stop',
      status: 'pending',
    };
    await DbClient.saveOutboundMessage(msg);

    // 3. Recipient opts out while message sits in queue
    await recordOptOut(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1, reason: 'STOP in queue' });

    // 4. Queue worker processes queue — must re-check and block
    await processOutboundQueue();

    expect(dispatchedSms.length).toBe(0);
    const updated = DbClient.getAllMessagesOut().find((m) => m.id === msg.id);
    expect(updated?.status).toBe('refused');
    expect(updated?.error_message).toContain('opted out');
  });

  // Criterion 7: Retry processing re-checks consent (opt-out before retry aborts delivery)
  it('7. Retry processing re-checks consent immediately before delivery', async () => {
    await recordConsent(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1 });

    let sendAttempts = 0;
    TwilioClientWrapper.setMockHandler(async (params: SendSmsParams) => {
      sendAttempts++;
      if (sendAttempts === 1) {
        // Between attempt 1 and attempt 2, simulate recipient texting STOP
        await recordOptOut(TENANT_1, RECIPIENT_PHONE, {
          projectId: PROJECT_1,
          reason: 'User sent STOP during in-process backoff',
        });
        throw new Error('Twilio 503 Service Unavailable');
      }
      dispatchedSms.push(params);
      return { sid: 'SM_RETRY_OK', status: 'sent' };
    });

    // Enqueue message
    const msg: OutboundMessage = {
      id: 'out_msg_retry_consent_check',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: RECIPIENT_PHONE,
      body: 'Message that will fail first attempt',
      correlation_id: 'corr_retry_check',
      turn_id: 'turn_retry_check',
      status: 'pending',
      max_retries: 3,
    };
    await DbClient.saveOutboundMessage(msg);

    // Queue worker processes: attempt 1 runs and fails; opt-out recorded during backoff;
    // attempt 2 pre-dispatch check catches the opt-out and aborts the retry!
    await processOutboundQueue();

    // sendSms was called exactly once (attempt 1). Attempt 2 was blocked by preDispatchConsent!
    expect(sendAttempts).toBe(1);
    expect(dispatchedSms.length).toBe(0);

    const finalMsg = DbClient.getAllMessagesOut().find((m) => m.id === msg.id);
    expect(finalMsg?.status).toBe('refused');
    expect(finalMsg?.error_message).toContain('opted out');
  });

  // Criterion 8: Repeated STOP callbacks are idempotent
  it('8. Repeated STOP callbacks are idempotent', async () => {
    // First STOP callback
    const res1 = await handleInboundConsentMessage(
      TENANT_1,
      RECIPIENT_PHONE,
      'STOP',
      PROJECT_1,
      'corr_stop_cb_1'
    );
    expect(res1?.isOptOut).toBe(true);
    expect(res1?.record?.consent_status).toBe('opted_out');

    const status1 = await getConsentStatus(TENANT_1, RECIPIENT_PHONE, PROJECT_1);
    expect(status1.status).toBe('opted_out');

    // Duplicate/repeated STOP callback with same keyword
    const res2 = await handleInboundConsentMessage(
      TENANT_1,
      RECIPIENT_PHONE,
      'STOP',
      PROJECT_1,
      'corr_stop_cb_2'
    );
    expect(res2?.isOptOut).toBe(true);
    expect(res2?.record?.consent_status).toBe('opted_out');

    const status2 = await getConsentStatus(TENANT_1, RECIPIENT_PHONE, PROJECT_1);
    expect(status2.status).toBe('opted_out');

    // Still blocked on outbound
    const canSend = await canSendSms(TENANT_1, RECIPIENT_PHONE, PROJECT_1);
    expect(canSend.allowed).toBe(false);
  });

  // Criterion 9 & 10: Tenant & project isolation
  it('9 & 10. Consent is scoped strictly by tenant/project and never leaks across tenants', async () => {
    // Tenant 1 opts in
    await recordConsent(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1 });

    // Tenant 2 has no consent for the same phone
    const checkT2 = await canSendSms(TENANT_2, RECIPIENT_PHONE, PROJECT_2);
    expect(checkT2.allowed).toBe(false);
    expect(checkT2.status).toBe('not_consented');

    // Tenant 1 opts out
    await recordOptOut(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1 });
    // Tenant 2 records opt in
    await recordConsent(TENANT_2, RECIPIENT_PHONE, { projectId: PROJECT_2 });

    const t1Check = await canSendSms(TENANT_1, RECIPIENT_PHONE, PROJECT_1);
    const t2Check = await canSendSms(TENANT_2, RECIPIENT_PHONE, PROJECT_2);

    expect(t1Check.allowed).toBe(false);
    expect(t1Check.status).toBe('opted_out');
    expect(t2Check.allowed).toBe(true);
    expect(t2Check.status).toBe('opted_in');
  });

  // Criterion 11: Existing voice functionality remains unaffected
  it('11. Voice interface operates independently and is unaffected by SMS consent state', async () => {
    // Opt-out recipient for SMS
    await recordOptOut(TENANT_1, RECIPIENT_PHONE, { projectId: PROJECT_1 });

    // Recipient is blocked for SMS
    const smsCheck = await canSendSms(TENANT_1, RECIPIENT_PHONE, PROJECT_1);
    expect(smsCheck.allowed).toBe(false);

    // Voice channel capabilities and service numbers remain valid
    const binding = CoreRegistry.resolveServiceNumber(SENDER_DID);
    expect(binding).toBeDefined();
    expect(binding?.tenant_id).toBe(TENANT_1);
    expect(binding?.capability).toBe('sms_voice');

    // Voice project retains voice capability
    const proj = CoreRegistry.getProject(PROJECT_1);
    expect(proj?.capabilities.voice).toBe(true);
  });

  // Criterion 12: All outbound SMS paths use canonical enforcement boundary
  it('12. All outbound SMS paths enforce consent before delivery', async () => {
    // 1. Regular SMS to unconsented phone -> refused
    const regularMsg: OutboundMessage = {
      id: 'out_boundary_reg',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: '+15557770001',
      body: 'Regular message',
      status: 'pending',
      correlation_id: 'corr_b1',
    };
    await DbClient.saveOutboundMessage(regularMsg);

    // 2. Opted-out phone -> refused
    await recordOptOut(TENANT_1, '+15557770002', { projectId: PROJECT_1 });
    const optedOutMsg: OutboundMessage = {
      id: 'out_boundary_opted_out',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: '+15557770002',
      body: 'Message to opted out',
      status: 'pending',
      correlation_id: 'corr_b2',
    };
    await DbClient.saveOutboundMessage(optedOutMsg);

    // 3. Opted-in phone -> allowed & sent
    await recordConsent(TENANT_1, '+15557770003', { projectId: PROJECT_1 });
    const consentedMsg: OutboundMessage = {
      id: 'out_boundary_opted_in',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: '+15557770003',
      body: 'Message to consented',
      status: 'pending',
      correlation_id: 'corr_b3',
    };
    await DbClient.saveOutboundMessage(consentedMsg);

    await processOutboundQueue();

    expect(dispatchedSms.length).toBe(1);
    expect(dispatchedSms[0].to).toBe('+15557770003');
    expect(DbClient.getAllMessagesOut().find((m) => m.id === regularMsg.id)?.status).toBe('refused');
    expect(DbClient.getAllMessagesOut().find((m) => m.id === optedOutMsg.id)?.status).toBe('refused');
    expect(DbClient.getAllMessagesOut().find((m) => m.id === consentedMsg.id)?.status).toBe('sent');
  });

  // Criterion 13: End-to-end international recipient lifecycle verification (+923082113844)
  it('13. End-to-end international recipient lifecycle verification (+923082113844)', async () => {
    const rawNumber = '923082113844';
    const e164Number = '+923082113844';

    // Step A: Initially unconsented — must fail closed
    const initialCheck = await canSendSms(TENANT_1, rawNumber, PROJECT_1);
    expect(initialCheck.allowed).toBe(false);
    expect(initialCheck.status).toBe('not_consented');

    // Queue message prior to consent
    const unconsentedMsg: OutboundMessage = {
      id: 'out_user_unconsented',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: e164Number,
      body: 'Pre-consent test notification',
      status: 'pending',
      correlation_id: 'corr_user_1',
    };
    await DbClient.saveOutboundMessage(unconsentedMsg);
    await processOutboundQueue();
    expect(dispatchedSms.length).toBe(0);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === unconsentedMsg.id)?.status).toBe('refused');

    // Step B: Record explicit opt-in (accepts raw or e164)
    const consent = await recordConsent(TENANT_1, rawNumber, {
      projectId: PROJECT_1,
      source: 'web_form',
      actor: 'user_acceptance_test',
    });
    expect(consent.phone_e164).toBe(e164Number);
    expect(consent.consent_status).toBe('opted_in');
    expect(consent.wording_version).toBe('cst_sms_consent_v1');

    // Step C: Outbound send is now permitted through unified boundary
    const consentedMsg: OutboundMessage = {
      id: 'out_user_consented',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: e164Number,
      body: 'Verified consent delivery test',
      status: 'pending',
      correlation_id: 'corr_user_2',
    };
    await DbClient.saveOutboundMessage(consentedMsg);
    await processOutboundQueue();

    expect(dispatchedSms.length).toBe(1);
    expect(dispatchedSms[0].to).toBe(e164Number);
    expect(dispatchedSms[0].from).toBe(SENDER_DID);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === consentedMsg.id)?.status).toBe('sent');

    // Step D: Recipient texts STOP
    const stopResult = await handleInboundConsentMessage(TENANT_1, e164Number, 'STOP', PROJECT_1);
    expect(stopResult?.isOptOut).toBe(true);
    expect(stopResult?.record?.consent_status).toBe('opted_out');

    // Step E: Subsequent outbound send is refused
    const blockedMsg: OutboundMessage = {
      id: 'out_user_post_stop',
      tenant_id: TENANT_1,
      project_id: PROJECT_1,
      from_e164: SENDER_DID,
      to_e164: e164Number,
      body: 'Post-stop message should be blocked',
      status: 'pending',
      correlation_id: 'corr_user_3',
    };
    await DbClient.saveOutboundMessage(blockedMsg);
    await processOutboundQueue();

    expect(dispatchedSms.length).toBe(1); // No new dispatch
    expect(DbClient.getAllMessagesOut().find((m) => m.id === blockedMsg.id)?.status).toBe('refused');
  });
});
