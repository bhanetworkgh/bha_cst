/**
 * Outbound Queue Delay — Regression Tests
 *
 * These tests cover the code-owned defects found while investigating why
 * production outbound SMS was reported as delivered hours late (or not at
 * all):
 *
 *  1. PROVIDER STATUS MAPPING — a Twilio `queued`/`accepted` callback was
 *     recorded as `delivered`. That produced a FALSE delivery report at the
 *     moment the message was only sitting in the carrier queue, and because
 *     delivery state is monotonic it also suppressed the genuine later
 *     `sent`/`delivered` callbacks, so the real outcome was never reported.
 *
 *  2. CLAIM LEASE — a row claimed for sending that never reached a terminal
 *     state (worker died mid-send) stayed in `sending` FOREVER. It was not
 *     selected by the queue, could not be claimed again, and was never
 *     failed or dead-lettered: the customer message was silently lost.
 *
 *  3. RETRY SCHEDULE PERSISTENCE — `next_retry_at` was accepted but never
 *     written to the database, so the documented exponential backoff never
 *     applied in production and every retry fired on the next poll.
 *
 *  4. BOUNDED TWILIO SEND — one slow provider call could hold the whole
 *     serial batch, blocking every unrelated message behind it.
 *
 * All of these are proven here against deterministic, in-memory doubles.
 * No live Twilio, no live database, no real customer numbers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { resetMonotonicStore } from '../../engine/src/publishers/delivery.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';
import {
  mapProviderDeliveryStatus,
  processOutboundQueue,
} from '../../engine/src/transport/twilio/outbound.js';

const app = createApp();
const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_ID = 'proj-vfarm-main';
const SERVICE_DID = '+19715885823';
const RECIPIENT = '+15551234567';

const postCallback = (body: Record<string, string>) =>
  request(app)
    .post('/webhooks/twilio/delivery-status')
    .set('x-test-bypass-signature', 'true')
    .type('form')
    .send(body);

const seedSent = async (id: string, providerSid: string, overrides: Record<string, any> = {}) => {
  await DbClient.saveOutboundMessage({
    id,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    from_e164: SERVICE_DID,
    to_e164: RECIPIENT,
    body: 'Queue regression message',
    correlation_id: `turn_${id}`,
    turn_id: `turn_${id}`,
    provider_sid: providerSid,
    status: 'sent',
    ...overrides,
  } as any);
  return providerSid;
};

/**
 * Record SMS consent so the consent gate does not refuse the operational
 * send. Consent is a separate dimension from identity; a queue test is not a
 * consent test.
 */
const recordConsent = async () => {
  const { recordConsent: record } = await import('../../engine/src/consent/service.js');
  await record(TENANT_ID, RECIPIENT, { projectId: PROJECT_ID, source: 'test' });
};

describe('Outbound queue delay — provider status mapping', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    resetMonotonicStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  it('never maps an unrecognised provider status to "delivered"', () => {
    // The old mapping defaulted EVERY unknown status to `delivered`.
    expect(mapProviderDeliveryStatus('queued')).not.toBe('delivered');
    expect(mapProviderDeliveryStatus('accepted')).not.toBe('delivered');
    expect(mapProviderDeliveryStatus('sending')).toBeNull();
    expect(mapProviderDeliveryStatus('read')).toBe('delivered');
    expect(mapProviderDeliveryStatus('partial')).toBe('sent');
    expect(mapProviderDeliveryStatus('canceled')).toBe('failed');
    expect(mapProviderDeliveryStatus('something-new')).toBeNull();
    expect(mapProviderDeliveryStatus('')).toBeNull();
  });

  it('maps "queued" to "queued" — the message is in the carrier queue, not delivered', async () => {
    const sid = await seedSent('out_q_001', 'SM_Q_001', { status: 'pending' });

    const res = await postCallback({ MessageSid: sid, MessageStatus: 'queued', To: RECIPIENT });
    expect(res.status).toBe(204);

    const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
    expect(row?.status).toBe('queued');
    expect(row?.status).not.toBe('delivered');
  });

  it('does not let a "queued" callback mask the later "delivered" callback', async () => {
    // This is the production symptom: `queued` was recorded as `delivered`,
    // and because delivery state is monotonic the genuine `delivered`
    // callback that followed could no longer advance the stored state, so
    // it was treated as a duplicate and nothing was reported.
    const sid = await seedSent('out_q_002', 'SM_Q_002', { status: 'pending' });

    await postCallback({ MessageSid: sid, MessageStatus: 'queued', To: RECIPIENT });
    expect(DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status).toBe('queued');

    await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: RECIPIENT });
    expect(DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status).toBe('delivered');
  });

  it('leaves the stored state untouched for a provider status with no CST equivalent', async () => {
    const sid = await seedSent('out_q_003', 'SM_Q_003', { status: 'sent' });

    const res = await postCallback({ MessageSid: sid, MessageStatus: 'sending', To: RECIPIENT });
    expect(res.status).toBe(204);

    const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
    expect(row?.status).toBe('sent');
  });

  it('never regresses a terminal state when an in-flight provider status arrives', async () => {
    const sid = await seedSent('out_q_004', 'SM_Q_004', { status: 'delivered' });

    await postCallback({ MessageSid: sid, MessageStatus: 'queued', To: RECIPIENT });
    await postCallback({ MessageSid: sid, MessageStatus: 'sending', To: RECIPIENT });

    const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
    expect(row?.status).toBe('delivered');
  });
});

describe('Outbound queue delay — claim lease', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    resetMonotonicStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  it('reclaims a message whose worker died mid-send', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_stuck_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'stuck in sending',
      correlation_id: 'turn_stuck',
      turn_id: 'turn_stuck',
      status: 'sending',
    } as any);

    // Backdate the claim so the lease has expired.
    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_stuck_001');
    row!.updated_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    DbClient.saveOutboundMessage(row! as any);

    const reclaimed = await DbClient.reclaimStaleOutboundMessages(5 * 60 * 1000);
    expect(reclaimed).toContain('out_stuck_001');

    const after = DbClient.getAllMessagesOut().find((m) => m.id === 'out_stuck_001');
    // No provider_sid means the dispatch outcome is unknown, so the message
    // is parked (not re-queued — that could deliver a duplicate).
    expect(after?.status).toBe('outcome_unknown');
  });

  it('does NOT reclaim a message that is still within its lease', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_live_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'in flight',
      correlation_id: 'turn_live',
      turn_id: 'turn_live',
      status: 'sending',
    } as any);

    const reclaimed = await DbClient.reclaimStaleOutboundMessages(5 * 60 * 1000);
    expect(reclaimed).not.toContain('out_live_001');

    const after = DbClient.getAllMessagesOut().find((m) => m.id === 'out_live_001');
    expect(after?.status).toBe('sending');
  });

  it('marks a stale claim that the provider already accepted as "sent" and never re-sends it', async () => {
    // The provider returned a MessageSid, so the message WAS created. The
    // status write is what failed. Re-queueing it would deliver a SECOND
    // copy to the customer.
    await recordConsent();
    await DbClient.saveOutboundMessage({
      id: 'out_stuck_accepted',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'accepted by the provider before the worker died',
      correlation_id: 'turn_stuck_accepted',
      turn_id: 'turn_stuck_accepted',
      provider_sid: 'SM_ACCEPTED_BEFORE_DEATH',
      status: 'sending',
    } as any);
    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_stuck_accepted');
    row!.updated_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    DbClient.saveOutboundMessage(row! as any);

    const sent: any[] = [];
    TwilioClientWrapper.setMockHandler(async () => {
      sent.push(1);
      return { sid: 'SM_SHOULD_NOT_HAPPEN', status: 'queued' };
    });

    await DbClient.reclaimStaleOutboundMessages(5 * 60 * 1000);

    const after = DbClient.getAllMessagesOut().find((m) => m.id === 'out_stuck_accepted');
    expect(after?.status).toBe('sent');

    await processOutboundQueue();
    // The message was NOT re-dispatched.
    expect(sent.length).toBe(0);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === 'out_stuck_accepted')?.status).toBe('sent');
  });

  it('parks a stale claim with an unknown provider outcome instead of re-sending it', async () => {
    // The worker died around the dispatch, so it cannot be established whether
    // the provider created the message. Re-sending it could deliver a
    // duplicate, so it is parked as `outcome_unknown` for operator
    // reconciliation and is never selected by the queue again.
    await recordConsent();
    await DbClient.saveOutboundMessage({
      id: 'out_stuck_002',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'reclaimed and sent',
      correlation_id: 'turn_stuck2',
      turn_id: 'turn_stuck2',
      status: 'sending',
    } as any);
    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_stuck_002');
    row!.updated_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    DbClient.saveOutboundMessage(row! as any);

    const sent: any[] = [];
    TwilioClientWrapper.setMockHandler(async () => {
      sent.push(1);
      return { sid: 'SM_SHOULD_NOT_HAPPEN', status: 'queued' };
    });

    await DbClient.reclaimStaleOutboundMessages(5 * 60 * 1000);

    const after = DbClient.getAllMessagesOut().find((m) => m.id === 'out_stuck_002');
    expect(after?.status).toBe('outcome_unknown');

    await processOutboundQueue();
    expect(sent.length).toBe(0);

    // The parked message is not eligible again.
    const pending = await DbClient.getPendingOutboundMessages();
    expect(pending.find((m) => m.id === 'out_stuck_002')).toBeUndefined();
  });
});

describe('Outbound queue delay — retry schedule', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    resetMonotonicStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  it('persists next_retry_at so the documented backoff actually applies', async () => {
    // The in-memory store always received the schedule; the database did not.
    // A `queued` row with a NULL `next_retry_at` is treated as "due now", so
    // the backoff was silently discarded in production.
    await DbClient.saveOutboundMessage({
      id: 'out_retry_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'retry schedule',
      correlation_id: 'turn_retry',
      turn_id: 'turn_retry',
      status: 'pending',
    } as any);

    const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
    await DbClient.updateOutboundStatus('out_retry_001', 'queued', 'transient', 1, nextRetryAt);

    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_retry_001');
    expect(row?.next_retry_at).toBe(nextRetryAt);
    expect(row?.retry_count).toBe(1);
  });

  it('a deferred retry is not eligible before its scheduled time', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_defer_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'deferred',
      correlation_id: 'turn_defer',
      turn_id: 'turn_defer',
      status: 'queued',
    } as any);

    const future = new Date(Date.now() + 60_000).toISOString();
    await DbClient.updateOutboundStatus('out_defer_001', 'queued', 'transient', 1, future);

    const pending = await DbClient.getPendingOutboundMessages();
    expect(pending.find((m) => m.id === 'out_defer_001')).toBeUndefined();
  });
});

describe('Outbound queue delay — bounded provider call', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    resetMonotonicStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  it('an error in one pass does not permanently stop the worker', async () => {
    // The worker guards against overlapping runs with an in-process flag. If
    // an error left that flag set, EVERY subsequent pass would be skipped
    // and the queue would silently stop draining for the life of the
    // process — the "the deployment succeeded but the worker is not
    // draining" failure.
    await recordConsent();
    const original = DbClient.getPendingOutboundMessages.bind(DbClient);
    const spy = vi.spyOn(DbClient, 'getPendingOutboundMessages').mockImplementation(async () => {
      throw new Error('simulated database failure');
    });

    await expect(processOutboundQueue()).rejects.toThrow('simulated database failure');

    // The guard is released, so the next pass runs normally.
    spy.mockRestore();
    const sent: any[] = [];
    TwilioClientWrapper.setMockHandler(async () => {
      sent.push(1);
      return { sid: 'SM_AFTER_ERROR_1', status: 'queued' };
    });

    await DbClient.saveOutboundMessage({
      id: 'out_after_error_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'after an error',
      correlation_id: 'turn_after_error',
      turn_id: 'turn_after_error',
      status: 'pending',
    } as any);

    await processOutboundQueue();

    expect(sent.length).toBe(1);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === 'out_after_error_001')?.status).toBe('sent');
    void original;
  }, 40_000);

  it('a Twilio send that times out is bounded and is NOT retried into a duplicate', async () => {
    // A timeout does not prove Twilio failed to create the message: the
    // request may have been created and merely not acknowledged in time. The
    // worker must therefore stop after the FIRST attempt and park the
    // message, rather than dispatching it again and risking a second copy
    // reaching the customer.
    await recordConsent();
    let attempts = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      attempts++;
      throw Object.assign(new Error('simulated provider timeout'), { code: 'ETIMEDOUT', status: 408 });
    });

    await DbClient.saveOutboundMessage({
      id: 'out_timeout_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'provider timeout',
      correlation_id: 'turn_timeout',
      turn_id: 'turn_timeout',
      status: 'pending',
      max_retries: 3,
    } as any);

    const started = Date.now();
    await processOutboundQueue();
    const elapsed = Date.now() - started;

    expect(attempts).toBe(1);
    expect(elapsed).toBeLessThan(30_000);

    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_timeout_001');
    // The outcome is preserved as unknown — not retried, not falsely failed.
    expect(row?.status).toBe('outcome_unknown');
    expect(row?.status).not.toBe('failed');

    // And it is not eligible for another dispatch.
    const pending = await DbClient.getPendingOutboundMessages();
    expect(pending.find((m) => m.id === 'out_timeout_001')).toBeUndefined();
  }, 40_000);

  it('a definitive provider rejection IS retried and can still succeed', async () => {
    // The opposite case: a definitive answer from the provider means the
    // message was NOT created, so a retry is safe and must still happen.
    await recordConsent();
    let attempts = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      attempts++;
      if (attempts < 3) {
        // A 503 from the provider is a definitive "not created" answer.
        throw Object.assign(new Error('Twilio 503 Service Unavailable'), { code: 503, status: 503 });
      }
      return { sid: 'SM_RETRY_SUCCESS_1', status: 'queued' };
    });

    await DbClient.saveOutboundMessage({
      id: 'out_retryable_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'retryable provider failure',
      correlation_id: 'turn_retryable',
      turn_id: 'turn_retryable',
      status: 'pending',
      max_retries: 3,
    } as any);

    await processOutboundQueue();

    expect(attempts).toBe(3);
    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_retryable_001');
    expect(row?.status).toBe('sent');
  }, 40_000);

  it('a non-retriable provider error fails the message without retrying it', async () => {
    await recordConsent();
    let attempts = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      attempts++;
      throw Object.assign(new Error('21211: Invalid To Phone Number'), { code: 21211, status: 400 });
    });

    await DbClient.saveOutboundMessage({
      id: 'out_permanent_001',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'permanent failure',
      correlation_id: 'turn_permanent',
      turn_id: 'turn_permanent',
      status: 'pending',
      max_retries: 3,
    } as any);

    await processOutboundQueue();

    expect(attempts).toBe(1);
    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_permanent_001');
    expect(row?.status).toBe('failed');
  }, 40_000);
});
