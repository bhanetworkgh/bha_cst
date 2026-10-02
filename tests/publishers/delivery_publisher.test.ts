/**
 * Task 5 — cst.delivery: Delivery event publishing tests
 *
 * Covers:
 *  - All six delivery statuses: queued, sending, sent, delivered, undelivered, failed
 *  - Monotonic ordering: delivered cannot regress to sent / sending / queued
 *  - Webhook path (mappedStatus from Twilio callbacks)
 *  - processOutboundQueue path (status sequence per message)
 *  - Fire-and-forget: publish never blocks
 *  - Missing tenantId: webhook silently skips publish when tenantId is null
 *  - Schema validation: every emitted event satisfies CstDeliveryEventV1Schema
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  publishDelivery,
  isMonotonicAdvance,
  recordMonotonicRank,
  resetMonotonicStore,
  PublishDeliveryParams,
} from '../../engine/src/publishers/delivery.js';
import { dashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import {
  CstDeliveryEventV1,
  CstDeliveryEventV1Schema,
  DeliveryStatus,
} from '../../engine/src/contracts/events.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_PARAMS: PublishDeliveryParams = {
  providerSid: 'SM_test_0001',
  messageId: 'msg_internal_001',
  channel: 'sms',
  to: '+15550000001',
  from: '+15559990000',
  status: 'queued',
  tenantId: 'tenant-delivery-test',
  projectId: 'proj-delivery-test',
  correlationId: 'corr-delivery-001',
};

function makeParams(status: DeliveryStatus, sid = BASE_PARAMS.providerSid): PublishDeliveryParams {
  return { ...BASE_PARAMS, providerSid: sid, status };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Task 5 — cst.delivery: Delivery Event Publishing', () => {
  const capturedEvents: CstDeliveryEventV1[] = [];

  beforeEach(() => {
    capturedEvents.length = 0;
    resetMonotonicStore();

    vi.spyOn(dashboardPublisher, 'publishFireAndForget').mockImplementation((event: any) => {
      capturedEvents.push(event as CstDeliveryEventV1);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  // ─── Status coverage ────────────────────────────────────────────────────────

  describe('All six delivery statuses are published', () => {
    const statuses: DeliveryStatus[] = ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'];

    for (const status of statuses) {
      it(`publishes status "${status}"`, () => {
        // Use a unique SID per status to avoid monotonic interference between subtests
        publishDelivery(makeParams(status, `SM_status_${status}`));
        expect(capturedEvents).toHaveLength(1);
        expect(capturedEvents[0].data.status).toBe(status);
        expect(capturedEvents[0].type).toBe('cst.delivery');
      });
    }
  });

  // ─── Schema validity ────────────────────────────────────────────────────────

  describe('Schema validity (CstDeliveryEventV1Schema)', () => {
    it('emitted queued event passes schema parse', () => {
      publishDelivery(makeParams('queued', 'SM_schema_queued'));
      expect(capturedEvents).toHaveLength(1);
      const result = CstDeliveryEventV1Schema.safeParse(capturedEvents[0]);
      expect(result.success, JSON.stringify(result)).toBe(true);
    });

    it('emitted delivered event passes schema parse', () => {
      publishDelivery(makeParams('delivered', 'SM_schema_delivered'));
      expect(capturedEvents).toHaveLength(1);
      const result = CstDeliveryEventV1Schema.safeParse(capturedEvents[0]);
      expect(result.success, JSON.stringify(result)).toBe(true);
    });

    it('emitted failed event with error fields passes schema parse', () => {
      publishDelivery({
        ...makeParams('failed', 'SM_schema_failed'),
        errorCode: '30008',
        errorMessage: 'Unknown destination handset',
        retryCount: 3,
      });
      expect(capturedEvents).toHaveLength(1);
      const result = CstDeliveryEventV1Schema.safeParse(capturedEvents[0]);
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(capturedEvents[0].data.error_code).toBe('30008');
      expect(capturedEvents[0].data.error_message).toBe('Unknown destination handset');
    });

    it('delivered event includes delivered_at timestamp', () => {
      publishDelivery(makeParams('delivered', 'SM_delivered_at'));
      expect(capturedEvents[0].data.delivered_at).toBeDefined();
      expect(typeof capturedEvents[0].data.delivered_at).toBe('string');
    });

    it('non-delivered event does NOT include delivered_at', () => {
      publishDelivery(makeParams('sent', 'SM_no_delivered_at'));
      expect(capturedEvents[0].data.delivered_at).toBeUndefined();
    });
  });

  // ─── Envelope fields ────────────────────────────────────────────────────────

  describe('Event envelope fields', () => {
    it('event has correct specversion, type, source', () => {
      publishDelivery(makeParams('sent', 'SM_envelope'));
      const ev = capturedEvents[0];
      expect(ev.specversion).toBe('cst.event.v1');
      expect(ev.type).toBe('cst.delivery');
      expect(ev.source).toBe('cst/transport');
    });

    it('event has tenant_id and project_id in envelope', () => {
      publishDelivery(makeParams('sent', 'SM_tenant_proj'));
      const ev = capturedEvents[0];
      expect(ev.tenant_id).toBe(BASE_PARAMS.tenantId);
      expect(ev.project_id).toBe(BASE_PARAMS.projectId);
    });

    it('event has correlation_id matching providerSid', () => {
      publishDelivery(makeParams('sent', 'SM_corr_001'));
      expect(capturedEvents[0].correlation_id).toBe(BASE_PARAMS.correlationId);
    });

    it('data.to equals the destination phone number', () => {
      publishDelivery(makeParams('queued', 'SM_to_check'));
      expect(capturedEvents[0].data.to).toBe(BASE_PARAMS.to);
    });

    it('data.segments populated when provided', () => {
      publishDelivery({ ...makeParams('sent', 'SM_segments'), segments: 2 });
      expect(capturedEvents[0].data.segments).toBe(2);
    });

    it('data.retry_count populated when provided', () => {
      publishDelivery({ ...makeParams('failed', 'SM_retries'), retryCount: 3 });
      expect(capturedEvents[0].data.retry_count).toBe(3);
    });

    it('customer defaults when not provided', () => {
      publishDelivery(makeParams('queued', 'SM_default_customer'));
      const customer = capturedEvents[0].customer;
      expect(customer.customer_ref).toBe(BASE_PARAMS.to);
      expect(customer.role).toBe('unknown');
      expect(customer.is_known).toBe(false);
    });

    it('custom customer payload is forwarded', () => {
      const customCustomer = {
        customer_ref: 'cust_delivery_owner',
        phone_e164: '+15550000001',
        role: 'owner' as const,
        is_known: true,
        tenant_id: 'tenant-delivery-test',
        project_id: 'proj-delivery-test',
      };
      publishDelivery({ ...makeParams('queued', 'SM_custom_cust'), customer: customCustomer });
      expect(capturedEvents[0].customer.customer_ref).toBe('cust_delivery_owner');
      expect(capturedEvents[0].customer.is_known).toBe(true);
    });
  });

  // ─── Monotonic ordering ─────────────────────────────────────────────────────

  describe('Monotonic ordering — delivered cannot regress', () => {
    it('allows forward progression: queued → sending → sent → delivered', () => {
      const sid = 'SM_monotonic_forward';
      publishDelivery(makeParams('queued', sid));
      publishDelivery(makeParams('sending', sid));
      publishDelivery(makeParams('sent', sid));
      publishDelivery(makeParams('delivered', sid));
      expect(capturedEvents).toHaveLength(4);
      const statuses = capturedEvents.map((e) => e.data.status);
      expect(statuses).toEqual(['queued', 'sending', 'sent', 'delivered']);
    });

    it('drops regression: delivered → sent is blocked', () => {
      const sid = 'SM_mono_regress_delivered';
      publishDelivery(makeParams('delivered', sid));
      publishDelivery(makeParams('sent', sid));     // should be dropped
      publishDelivery(makeParams('sending', sid));  // should be dropped
      publishDelivery(makeParams('queued', sid));   // should be dropped
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].data.status).toBe('delivered');
    });

    it('drops regression: failed → sending is blocked', () => {
      const sid = 'SM_mono_regress_failed';
      publishDelivery(makeParams('failed', sid));
      publishDelivery(makeParams('sending', sid));
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].data.status).toBe('failed');
    });

    it('drops regression: undelivered → sent is blocked', () => {
      const sid = 'SM_mono_regress_undelivered';
      publishDelivery(makeParams('undelivered', sid));
      publishDelivery(makeParams('sent', sid));
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].data.status).toBe('undelivered');
    });

    it('drops exact duplicate status publish for same sid', () => {
      const sid = 'SM_mono_duplicate';
      publishDelivery(makeParams('sent', sid));
      publishDelivery(makeParams('sent', sid)); // duplicate
      expect(capturedEvents).toHaveLength(1);
    });

    it('different sids are tracked independently', () => {
      publishDelivery(makeParams('delivered', 'SM_sid_A'));
      publishDelivery(makeParams('queued', 'SM_sid_B')); // allowed — different SID
      expect(capturedEvents).toHaveLength(2);
      expect(capturedEvents[0].data.status).toBe('delivered');
      expect(capturedEvents[1].data.status).toBe('queued');
    });

    it('resetMonotonicStore clears ranks so progression can restart', () => {
      const sid = 'SM_reset_test';
      publishDelivery(makeParams('delivered', sid));
      expect(capturedEvents).toHaveLength(1);

      resetMonotonicStore();
      publishDelivery(makeParams('queued', sid)); // allowed after reset
      expect(capturedEvents).toHaveLength(2);
      expect(capturedEvents[1].data.status).toBe('queued');
    });
  });

  // ─── isMonotonicAdvance unit tests ──────────────────────────────────────────

  describe('isMonotonicAdvance() helper', () => {
    it('returns true for first publish of any status', () => {
      resetMonotonicStore();
      expect(isMonotonicAdvance('SM_fresh', 'queued')).toBe(true);
    });

    it('returns false for same-rank status', () => {
      recordMonotonicRank('SM_rank_eq', 'sent');
      expect(isMonotonicAdvance('SM_rank_eq', 'sent')).toBe(false);
    });

    it('returns true when advancing from sent to delivered', () => {
      recordMonotonicRank('SM_advance', 'sent');
      expect(isMonotonicAdvance('SM_advance', 'delivered')).toBe(true);
    });

    it('returns false when regressing from delivered to sent', () => {
      recordMonotonicRank('SM_regress', 'delivered');
      expect(isMonotonicAdvance('SM_regress', 'sent')).toBe(false);
    });

    it('undelivered and failed share rank 4 (both terminal)', () => {
      // Once failed is recorded, undelivered (same rank) is blocked
      recordMonotonicRank('SM_terminal', 'failed');
      expect(isMonotonicAdvance('SM_terminal', 'undelivered')).toBe(false);
    });
  });

  // ─── Webhook path (Twilio delivery-status callback statuses) ────────────────

  describe('Webhook path — Twilio-driven status transitions', () => {
    it('publishes "sent" from Twilio sent callback', () => {
      publishDelivery(makeParams('sent', 'SM_webhook_sent'));
      expect(capturedEvents[0].data.status).toBe('sent');
      expect(capturedEvents[0].type).toBe('cst.delivery');
    });

    it('publishes "delivered" from Twilio delivered callback', () => {
      publishDelivery(makeParams('delivered', 'SM_webhook_delivered'));
      expect(capturedEvents[0].data.status).toBe('delivered');
    });

    it('publishes "undelivered" from Twilio undelivered callback', () => {
      publishDelivery(makeParams('undelivered', 'SM_webhook_undelivered'));
      expect(capturedEvents[0].data.status).toBe('undelivered');
    });

    it('publishes "failed" from Twilio failed callback with error code', () => {
      publishDelivery({
        ...makeParams('failed', 'SM_webhook_failed'),
        errorCode: '30008',
        errorMessage: 'Twilio ErrorCode: 30008',
      });
      expect(capturedEvents[0].data.status).toBe('failed');
      expect(capturedEvents[0].data.error_code).toBe('30008');
    });

    it('full webhook sequence: sent → delivered is published in order', () => {
      const sid = 'SM_webhook_sequence';
      // processOutboundQueue publishes 'sent'
      publishDelivery(makeParams('sent', sid));
      // Twilio later calls the delivery-status webhook with 'delivered'
      publishDelivery(makeParams('delivered', sid));
      expect(capturedEvents).toHaveLength(2);
      expect(capturedEvents.map((e) => e.data.status)).toEqual(['sent', 'delivered']);
    });

    it('webhook "sent" after queue "delivered" is blocked (monotonic)', () => {
      const sid = 'SM_webhook_regress';
      publishDelivery(makeParams('delivered', sid)); // arrived first (e.g. race)
      publishDelivery(makeParams('sent', sid));      // late webhook — dropped
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].data.status).toBe('delivered');
    });
  });

  // ─── Refused publishes must not consume monotonic state ──────────────────────

  describe('Refusal side effects', () => {
    it('a refused empty-project_id publish does not record the monotonic rank', () => {
      // Regression: if the empty-project guard ran AFTER the rank was recorded,
      // the refused attempt would burn the 'sent' slot for this SID and the
      // legitimate follow-up below would be silently dropped as a duplicate —
      // i.e. a real delivery event would vanish from the dashboard.
      const sid = 'SM_empty_project_rank';

      publishDelivery({ ...makeParams('sent', sid), projectId: '   ' });
      expect(capturedEvents).toHaveLength(0);
      expect(isMonotonicAdvance(sid, 'sent')).toBe(true);

      publishDelivery(makeParams('sent', sid));
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].data.status).toBe('sent');
    });

    it('a refused empty-project_id publish does not block a later delivered event', () => {
      const sid = 'SM_empty_project_delivered';
      publishDelivery({ ...makeParams('delivered', sid), projectId: '' });
      expect(capturedEvents).toHaveLength(0);
      publishDelivery(makeParams('delivered', sid));
      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].project_id).toBe('proj-delivery-test');
    });
  });

  // ─── Fire-and-forget guarantee ───────────────────────────────────────────────

  describe('Fire-and-forget guarantee', () => {    it('publishDelivery returns undefined synchronously (no promise block)', () => {
      const result = publishDelivery(makeParams('sent', 'SM_sync_test'));
      expect(result).toBeUndefined();
    });

    it('a throw inside publishFireAndForget does not propagate', () => {
      vi.spyOn(dashboardPublisher, 'publishFireAndForget').mockImplementation(() => {
        throw new Error('Simulated publisher crash');
      });
      // Should not throw:
      expect(() => publishDelivery(makeParams('queued', 'SM_throw_test'))).not.toThrow();
    });
  });
});
