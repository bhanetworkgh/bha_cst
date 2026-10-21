/**
 * Delivery-Status Webhook Acceptance Tests (Section C)
 *
 * Tests the POST /webhooks/twilio/delivery-status handler end-to-end
 * through the real Express app (not mocked internals), covering:
 *
 * 1. Signature enforcement — requests without bypass header or valid signature
 *    are rejected at 401/403 before any DB access.
 * 2. Tenant/project resolution — the handler resolves context from the `To`
 *    service-number binding and from the stored outbound row.
 * 3. Provider SID reconciliation — status update uses MessageSid as the join key.
 * 4. Carrier error code persistence — ErrorCode is stored in error_message.
 * 5. Duplicate callback idempotency — a second callback with the same status
 *    returns 204 without changing a terminal stored state.
 * 6. Monotonic state guard — a late lower-ranked status (e.g. 'sent' after
 *    'delivered') does not overwrite the stored terminal state.
 * 7. Unknown provider SID — returns 204 (webhook must always ack Twilio) but
 *    does not create a spurious message row.
 * 8. Missing required fields — returns 400 BAD_REQUEST.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { dashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import { resetMonotonicStore } from '../../engine/src/publishers/delivery.js';

const app = createApp();
const PRIMARY_DID = '+19715885823';
const TEST_RECIPIENT = '+15551234567';
const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_ID = 'proj-vfarm-main';

/** POST a delivery-status callback with the test bypass header */
const postCallback = (body: Record<string, string>) =>
  request(app)
    .post('/webhooks/twilio/delivery-status')
    .set('x-test-bypass-signature', 'true')
    .type('form')
    .send(body);

/** POST a delivery-status callback WITHOUT any auth headers */
const postCallbackUnauthenticated = (body: Record<string, string>) =>
  request(app)
    .post('/webhooks/twilio/delivery-status')
    .type('form')
    .send(body);

/** Seed a sent outbound message and return its provider_sid */
const seedSentMessage = async (id: string, providerSid: string, overrides: Record<string, any> = {}) => {
  await DbClient.saveOutboundMessage({
    id,
    tenant_id: TENANT_ID,
    project_id: PROJECT_ID,
    from_e164: PRIMARY_DID,
    to_e164: TEST_RECIPIENT,
    body: 'Delivery status test message',
    correlation_id: `turn_${id}`,
    turn_id: `turn_${id}`,
    provider_sid: providerSid,
    status: 'sent',
    ...overrides,
  });
  return providerSid;
};

describe('Delivery-Status Webhook — Acceptance (Section C)', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
  });

  // ── 1. Signature enforcement ───────────────────────────────────────────────

  describe('1. Webhook signature enforcement', () => {
    it('rejects a request with no Twilio signature and no test-bypass header (401)', async () => {
      const res = await postCallbackUnauthenticated({
        MessageSid: 'SM_NOSIG_001',
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });
      // Missing X-Twilio-Signature → 401 Unauthorized
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('rejects a request with an invalid Twilio signature (403)', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/delivery-status')
        .set('x-twilio-signature', 'invalid-signature-value')
        .type('form')
        .send({
          MessageSid: 'SM_BADSIG_001',
          MessageStatus: 'delivered',
          To: PRIMARY_DID,
        });
      // Present but invalid signature → 403 Forbidden
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FORBIDDEN');
    });

    it('does not create any message row when signature validation fails', async () => {
      await postCallbackUnauthenticated({
        MessageSid: 'SM_NOSIG_ROW_001',
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });
      // No row must exist for this SID
      const row = DbClient.getAllMessagesOut().find(
        (m) => m.provider_sid === 'SM_NOSIG_ROW_001'
      );
      expect(row).toBeUndefined();
    });
  });

  // ── 2. Tenant/project resolution ───────────────────────────────────────────

  describe('2. Tenant/project resolution via service-number binding', () => {
    it('resolves tenant and project from the To field service-number binding', async () => {
      const sid = await seedSentMessage('out_tenant_resolve_001', 'SM_RESOLVE_001');

      const res = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });

      expect(res.status).toBe(204);

      const row = DbClient.getAllMessagesOut().find((m) => m.provider_sid === sid);
      expect(row?.status).toBe('delivered');
      expect(row?.tenant_id).toBe(TENANT_ID);
      expect(row?.project_id).toBe(PROJECT_ID);
    });
  });

  // ── 3. Provider SID reconciliation ────────────────────────────────────────

  describe('3. Provider SID reconciliation', () => {
    it('reconciles the status update using MessageSid as the join key', async () => {
      const sid = await seedSentMessage('out_sid_reconcile_001', 'SM_SID_KEY_001');

      const res = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });

      expect(res.status).toBe(204);

      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_sid_reconcile_001');
      expect(row?.status).toBe('delivered');
    });

    it('returns 204 but updates nothing for an unknown provider SID (does not create a row)', async () => {
      const unknownSid = 'SM_UNKNOWN_SID_NEVER_SENT';
      const beforeCount = DbClient.getAllMessagesOut().length;

      const res = await postCallback({
        MessageSid: unknownSid,
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });

      // Must ack Twilio unconditionally
      expect(res.status).toBe(204);
      // No new row must be created
      expect(DbClient.getAllMessagesOut().length).toBe(beforeCount);
    });
  });

  // ── 4. Carrier error code persistence ─────────────────────────────────────

  describe('4. Carrier error code persistence', () => {
    it('stores ErrorCode 30005 (unknown handset) in the message error_message field', async () => {
      const sid = await seedSentMessage('out_30005_persist', 'SM_30005_PERSIST');

      const res = await postCallback({
        MessageSid: sid,
        MessageStatus: 'undelivered',
        ErrorCode: '30005',
        To: PRIMARY_DID,
      });

      expect(res.status).toBe(204);

      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_30005_persist');
      expect(row?.status).toBe('undelivered');
      expect(row?.error_message).toContain('30005');
    });

    it('stores ErrorCode 30007 (carrier violation / A2P filter) in error_message', async () => {
      const sid = await seedSentMessage('out_30007_persist', 'SM_30007_PERSIST');

      await postCallback({
        MessageSid: sid,
        MessageStatus: 'failed',
        ErrorCode: '30007',
        ErrorMessage: 'Carrier Violation (A2P Filter)',
        To: PRIMARY_DID,
      });

      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_30007_persist');
      expect(row?.status).toBe('failed');
      expect(row?.error_message).toContain('30007');
    });

    it('stores ErrorCode 21215 (geo-permission denied) if Twilio surfaces it via a callback', async () => {
      const sid = await seedSentMessage('out_21215_cb', 'SM_21215_CB');

      await postCallback({
        MessageSid: sid,
        MessageStatus: 'failed',
        ErrorCode: '21215',
        To: PRIMARY_DID,
      });

      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_21215_cb');
      expect(row?.status).toBe('failed');
      expect(row?.error_message).toContain('21215');
    });
  });

  // ── 5. Duplicate callback idempotency ─────────────────────────────────────

  describe('5. Duplicate callback idempotency', () => {
    it('handles identical duplicate callbacks returning 204 without re-applying the transition', async () => {
      const sid = await seedSentMessage('out_dup_cb_001', 'SM_DUP_CB_001');

      const res1 = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });
      expect(res1.status).toBe(204);

      const res2 = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });
      expect(res2.status).toBe(204);

      // Status remains 'delivered' — not doubled, not reset
      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_dup_cb_001');
      expect(row?.status).toBe('delivered');
    });
  });

  // ── 6. Monotonic state guard ───────────────────────────────────────────────

  describe('6. Monotonic state guard — late lower-ranked status is rejected', () => {
    it('does not overwrite delivered with a late undelivered callback', async () => {
      const sid = await seedSentMessage('out_monotonic_001', 'SM_MONO_001');

      await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: PRIMARY_DID });
      await postCallback({ MessageSid: sid, MessageStatus: 'undelivered', To: PRIMARY_DID });

      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_monotonic_001');
      expect(row?.status).toBe('delivered');
    });

    it('does not overwrite delivered with a late failed callback', async () => {
      const sid = await seedSentMessage('out_monotonic_002', 'SM_MONO_002');

      await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: PRIMARY_DID });
      await postCallback({
        MessageSid: sid,
        MessageStatus: 'failed',
        ErrorCode: '30008',
        To: PRIMARY_DID,
      });

      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_monotonic_002');
      expect(row?.status).toBe('delivered');
    });

    it('does not regress a terminal state back to sent', async () => {
      const sid = await seedSentMessage('out_monotonic_003', 'SM_MONO_003');

      await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: PRIMARY_DID });
      await postCallback({ MessageSid: sid, MessageStatus: 'sent', To: PRIMARY_DID });

      const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_monotonic_003');
      expect(row?.status).toBe('delivered');
    });
  });

  // ── 7. Missing required fields ────────────────────────────────────────────

  describe('7. Missing required fields', () => {
    it('returns 400 BAD_REQUEST when MessageSid is absent', async () => {
      const res = await postCallback({
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BAD_REQUEST');
    });

    it('returns 400 BAD_REQUEST when MessageStatus is absent', async () => {
      const res = await postCallback({
        MessageSid: 'SM_NOSTA_001',
        To: PRIMARY_DID,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BAD_REQUEST');
    });

    it('returns 400 BAD_REQUEST when both required fields are absent', async () => {
      const res = await postCallback({ To: PRIMARY_DID });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BAD_REQUEST');
    });
  });

  // ── 8. Dashboard delivery publication + attribution authority ──────────────
  //
  // The reported production symptom was: the callback WAS recorded against
  // the message row, but CST could not resolve the project and therefore
  // SKIPPED the Dashboard delivery event.
  //
  // Two defects are covered here:
  //
  //  (a) ATTRIBUTION. The `To` field of a Twilio delivery-status callback is
  //      the RECIPIENT, not the service number that sent the message. The
  //      handler used it as the primary attribution source, and it took
  //      PRECEDENCE over the persisted outbound row — which is the message
  //      that was actually sent and which carries the tenant/project/turn the
  //      send was authorised under. A recipient whose number happened to be
  //      bound as a service number would file the event against the
  //      recipient's project.
  //
  //  (b) IDEMPOTENCY. The Dashboard event was published on every callback,
  //      including a duplicate or a regressing one. The only guard was the
  //      publisher's IN-MEMORY monotonic map, which is lost on restart — so a
  //      duplicate callback after a redeploy published a second event. The
  //      durable `advanced` flag from the message row is now the gate.

  describe('8. Dashboard delivery publication and attribution authority', () => {
    let published: any[];

    beforeEach(() => {
      published = [];
      resetMonotonicStore();
      vi.spyOn(dashboardPublisher, 'publishFireAndForget').mockImplementation((e: any) => {
        published.push(e);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      resetMonotonicStore();
    });

    it('publishes one cst.delivery event attributed to the persisted outbound row', async () => {
      const sid = await seedSentMessage('out_publish_001', 'SM_PUBLISH_001');

      const res = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: TEST_RECIPIENT,
      });

      expect(res.status).toBe(204);
      expect(published).toHaveLength(1);
      const event = published[0];
      expect(event.tenant_id).toBe(TENANT_ID);
      expect(event.project_id).toBe(PROJECT_ID);
      // The join key back to the cst.turn is the row's turn_id.
      expect(event.data?.turn_id).toBe('turn_out_publish_001');
      expect(event.data?.provider_sid).toBe(sid);
      expect(event.data?.status).toBe('delivered');
    });

    it('attributes to the persisted row even when the recipient is bound to another project', async () => {
      // The recipient number is ALSO bound as a service number — but to a
      // different project. The durable row must win.
      CoreRegistry.registerProject({
        project_id: 'proj-vfarm-other',
        tenant_id: TENANT_ID,
        name: 'Other project',
        status: 'active',
        capabilities: { sms: true, voice: false, web: false },
        speaker_policy: 'allowlist',
        onboarding_reply: 'other project',
        voice_enabled: false,
      } as any);
      CoreRegistry.bindServiceNumber({
        phone_e164: TEST_RECIPIENT,
        tenant_id: TENANT_ID,
        project_id: 'proj-vfarm-other',
        capability: 'sms',
        status: 'bound',
        bound_at: new Date().toISOString(),
      });
      const sid = await seedSentMessage('out_publish_002', 'SM_PUBLISH_002');

      const res = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: TEST_RECIPIENT,
      });

      expect(res.status).toBe(204);
      expect(published).toHaveLength(1);
      // NOT the recipient's project.
      expect(published[0].project_id).toBe(PROJECT_ID);
      expect(published[0].project_id).not.toBe('proj-vfarm-other');
    });

    it('publishes no event when the persisted row carries no tenancy', async () => {
      // A row with no tenant_id/project_id cannot be attributed. The callback
      // must still ack Twilio, and must NOT invent a project.
      const sid = await seedSentMessage('out_publish_003', 'SM_PUBLISH_003', {
        tenant_id: '',
        project_id: '',
      });

      const res = await postCallback({
        MessageSid: sid,
        MessageStatus: 'delivered',
        To: '+15550009999',
      });

      expect(res.status).toBe(204);
      expect(published).toHaveLength(0);
    });

    it('publishes no event for an unknown provider message id', async () => {
      const res = await postCallback({
        MessageSid: 'SM_NEVER_SENT_999',
        MessageStatus: 'delivered',
        To: PRIMARY_DID,
      });

      expect(res.status).toBe(204);
      expect(published).toHaveLength(0);
    });

    it('publishes exactly one event for a duplicate callback', async () => {
      const sid = await seedSentMessage('out_publish_004', 'SM_PUBLISH_004');

      await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: TEST_RECIPIENT });
      await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: TEST_RECIPIENT });

      expect(published).toHaveLength(1);
    });

    it('publishes no second event for a regressing callback', async () => {
      const sid = await seedSentMessage('out_publish_005', 'SM_PUBLISH_005');

      await postCallback({ MessageSid: sid, MessageStatus: 'delivered', To: TEST_RECIPIENT });
      await postCallback({ MessageSid: sid, MessageStatus: 'sent', To: TEST_RECIPIENT });

      expect(published).toHaveLength(1);
    });

    it('does not publish a delivery event before the signature is verified', async () => {
      const sid = await seedSentMessage('out_publish_006', 'SM_PUBLISH_006');

      const res = await request(app)
        .post('/webhooks/twilio/delivery-status')
        .set('x-twilio-signature', 'invalid-signature-value')
        .type('form')
        .send({ MessageSid: sid, MessageStatus: 'delivered', To: TEST_RECIPIENT });

      expect([401, 403]).toContain(res.status);
      expect(published).toHaveLength(0);
    });
  });
});
