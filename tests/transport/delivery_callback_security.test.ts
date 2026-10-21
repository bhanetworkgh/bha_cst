/**
 * Delivery-status callback — attribution, signature security, idempotency and
 * publication-failure safety.
 *
 * The callback is the only place where a delivery outcome becomes a customer-
 * visible fact, so it is held to a strict standard:
 *
 *   - the Twilio signature is verified BEFORE any database access;
 *   - the RECIPIENT number (`To`) is never an authority for tenancy;
 *   - attribution comes only from the persisted outbound message row;
 *   - a callback with no matching row, or a row with no tenancy, fails
 *     closed: acknowledged to Twilio, no event, no invented tenant;
 *   - a duplicate callback publishes no second event;
 *   - a publication failure never corrupts the message state.
 *
 * No live Twilio, no database, no customer data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { resetMonotonicStore } from '../../engine/src/publishers/delivery.js';
import {
  CstDashboardPublisher,
  getDashboardPublisher,
  setActiveDashboardPublisher,
} from '../../engine/src/publishers/dashboard.js';

const app = createApp();
const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const SERVICE_DID = '+19715885823';
const RECIPIENT = '+15551234567';

const postCallback = (body: Record<string, string>) =>
  request(app)
    .post('/webhooks/twilio/delivery-status')
    .set('x-test-bypass-signature', 'true')
    .type('form')
    .send(body);

const seedRow = async (id: string, providerSid: string, overrides: Record<string, any> = {}) => {
  await DbClient.saveOutboundMessage({
    id,
    tenant_id: TENANT,
    project_id: PROJECT,
    from_e164: SERVICE_DID,
    to_e164: RECIPIENT,
    body: 'delivery callback fixture',
    correlation_id: `turn_${id}`,
    turn_id: `turn_${id}`,
    provider_sid: providerSid,
    status: 'sent',
    ...overrides,
  } as any);
  return providerSid;
};

describe('delivery-status callback — attribution', () => {
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

  it('attributes a callback from the persisted outbound row, not from the recipient', async () => {
    const sid = await seedRow('out_attr_001', 'SM_ATTR_001');

    // The recipient number is deliberately NOT a bound service number.
    const res = await postCallback({
      MessageSid: sid,
      MessageStatus: 'delivered',
      To: RECIPIENT,
      From: SERVICE_DID,
    });

    expect(res.status).toBe(204);
    const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
    expect(row?.status).toBe('delivered');
  });

  it('fails closed when no outbound row exists for the MessageSid', async () => {
    const res = await postCallback({
      MessageSid: 'SM_UNKNOWN_ROW_001',
      MessageStatus: 'delivered',
      To: RECIPIENT,
      From: SERVICE_DID,
    });

    // Acknowledged to Twilio, but nothing is published and nothing is
    // invented.
    expect(res.status).toBe(204);
    expect(DbClient.getAllMessagesOut().find((m) => m.provider_sid === 'SM_UNKNOWN_ROW_001')).toBeUndefined();
  });

  it('fails closed when the persisted row carries no project', async () => {
    const sid = await seedRow('out_attr_002', 'SM_ATTR_002', { project_id: '', tenant_id: '' });

    const res = await postCallback({
      MessageSid: sid,
      MessageStatus: 'delivered',
      To: RECIPIENT,
      From: SERVICE_DID,
    });

    expect(res.status).toBe(204);
  });

  it('does not confuse the sending number with the recipient', async () => {
    const sid = await seedRow('out_attr_003', 'SM_ATTR_003');

    // `To` is the RECIPIENT and `From` is the SENDING number in a Twilio
    // status callback. Swapping them must not change the attribution.
    const res = await postCallback({
      MessageSid: sid,
      MessageStatus: 'delivered',
      To: SERVICE_DID,
      From: RECIPIENT,
    });

    expect(res.status).toBe(204);
    const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
    expect(row?.status).toBe('delivered');
  });

  it('a callback cannot update another tenant\'s message', async () => {
    // Two tenants, two messages, two provider ids. A callback for tenant A's
    // message must advance A's row and leave B's row untouched — the
    // attribution is the matched row's OWN tenant, never a caller-supplied
    // one, and the callback carries no tenant field at all.
    const otherTenant = 'tenant-other-01';
    const otherProject = 'proj-other-01';
    await seedRow('out_x_tenant_a', 'SM_XTENANT_A');
    await DbClient.saveOutboundMessage({
      id: 'out_x_tenant_b',
      tenant_id: otherTenant,
      project_id: otherProject,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'other tenant message',
      correlation_id: 'turn_x_tenant_b',
      turn_id: 'turn_x_tenant_b',
      provider_sid: 'SM_XTENANT_B',
      status: 'sent',
    } as any);

    const res = await postCallback({
      MessageSid: 'SM_XTENANT_A',
      MessageStatus: 'delivered',
      To: RECIPIENT,
      From: SERVICE_DID,
    });
    expect(res.status).toBe(204);

    const a = DbClient.getAllMessagesOut().find((m) => m.provider_sid === 'SM_XTENANT_A');
    const b = DbClient.getAllMessagesOut().find((m) => m.provider_sid === 'SM_XTENANT_B');
    expect(a?.status).toBe('delivered');
    // The other tenant's message is untouched.
    expect(b?.status).toBe('sent');
    expect(b?.tenant_id).toBe(otherTenant);
    expect(b?.project_id).toBe(otherProject);
  });

  it('an out-of-order callback cannot downgrade or falsely upgrade delivery state', async () => {
    const sid = await seedRow('out_order_001', 'SM_ORDER_001', { status: 'delivered' });

    // `sent` arriving after `delivered` is a regression: the stored terminal
    // state must stand and nothing may be published.
    const res = await postCallback({
      MessageSid: sid,
      MessageStatus: 'sent',
      To: RECIPIENT,
      From: SERVICE_DID,
    });

    expect(res.status).toBe(204);
    const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
    expect(row?.status).toBe('delivered');
  });

  it('a queued callback is followed by sent and delivered, each advancing the state', async () => {
    const sid = await seedRow('out_order_002', 'SM_ORDER_002', { status: 'pending' });

    await postCallback({ MessageSid: sid, MessageStatus: 'queued', To: RECIPIENT, From: SERVICE_DID });
    expect(DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status).toBe('queued');

    await postCallback({ MessageSid: sid, MessageStatus: 'sent', To: RECIPIENT, From: SERVICE_DID });
    expect(DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status).toBe('sent');

    await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: RECIPIENT, From: SERVICE_DID });
    expect(DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status).toBe('delivered');
  });
});

describe('delivery-status callback — signature verification precedes database access', () => {
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

  it('rejects an unsigned callback before touching the message store', async () => {
    const sid = await seedRow('out_sig_001', 'SM_SIG_001');
    const before = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status;

    // No `x-test-bypass-signature` header: the real signature check runs.
    // A MISSING signature is refused with 401 (an invalid one with 403) —
    // both before any database access.
    const res = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .type('form')
      .send({ MessageSid: sid, MessageStatus: 'delivered', To: RECIPIENT, From: SERVICE_DID });

    expect(res.status).toBe(401);

    // The message state is untouched: no unauthenticated request can mutate
    // a message.
    const after = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status;
    expect(after).toBe(before);
  });

  it('rejects a callback with an invalid signature before touching the message store', async () => {
    const sid = await seedRow('out_sig_002', 'SM_SIG_002');
    const before = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status;

    const res = await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-twilio-signature', 'not-a-valid-signature')
      .type('form')
      .send({ MessageSid: sid, MessageStatus: 'delivered', To: RECIPIENT, From: SERVICE_DID });

    expect(res.status).toBe(403);
    const after = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid)?.status;
    expect(after).toBe(before);
  });
});

describe('delivery-status callback — idempotency and publication-failure safety', () => {
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

  it('a duplicate callback does not publish a second delivery event', async () => {
    const sid = await seedRow('out_dup_001', 'SM_DUP_001');
    const publisher = getDashboardPublisher();
    // `mockImplementation` (not a call-through spy): the test must never
    // issue a real HTTP request to a configured Dashboard.
    const publishSpy = vi
      .spyOn(publisher as any, 'publish')
      .mockResolvedValue({ success: true, status: 201 } as any);

    await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: RECIPIENT, From: SERVICE_DID });
    await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: RECIPIENT, From: SERVICE_DID });
    // Publication is fire-and-forget, so let the scheduled dispatch run.
    await new Promise((r) => setTimeout(r, 200));

    const deliveryPublishes = publishSpy.mock.calls.filter((call: any[]) => {
      const event = call[0];
      return event?.type === 'cst.delivery';
    });
    expect(deliveryPublishes.length).toBe(1);
  });

  it('keeps the message state correct when the Dashboard publication fails', async () => {
    const sid = await seedRow('out_pubfail_001', 'SM_PUBFAIL_001');

    // A publisher whose HTTP call always fails with a retryable status, so
    // the real publish path runs and records its outcome.
    const failingPublisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: 'unavailable' }),
      })) as any,
    });
    const previous = getDashboardPublisher();
    setActiveDashboardPublisher(failingPublisher);

    try {
      const res = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: RECIPIENT,
        From: SERVICE_DID,
      });

      // The callback is still acknowledged — Twilio must not keep retrying.
      expect(res.status).toBe(204);
      // The durable message state advanced regardless of the publication.
      const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
      expect(row?.status).toBe('delivered');
      // And the failure is recorded durably, so the event can be replayed.
      // Publication is fire-and-forget, so the outcome is recorded a moment
      // later than the callback response.
      await new Promise((r) => setTimeout(r, 1500));
      const outcomes = await DbClient.getUnpublishedDashboardOutcomes();
      expect(outcomes.length).toBeGreaterThan(0);
      expect(outcomes.some((o) => o.status !== 'published')).toBe(true);
    } finally {
      setActiveDashboardPublisher(previous as any);
    }
  });

  it('an unknown provider status leaves the stored state untouched', async () => {
    const sid = await seedRow('out_unknown_status_001', 'SM_UNKNOWN_STATUS_001', { status: 'sent' });

    const res = await postCallback({
      MessageSid: sid,
      MessageStatus: 'some-new-provider-status',
      To: RECIPIENT,
      From: SERVICE_DID,
    });

    expect(res.status).toBe(204);
    const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
    expect(row?.status).toBe('sent');
  });
});
