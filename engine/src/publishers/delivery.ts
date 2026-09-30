/**
 * CstDeliveryPublisher
 *
 * Publishes cst.delivery events to the Engine Dashboard for every outbound
 * SMS status transition produced by processOutboundQueue and the
 * /twilio/delivery-status webhook.
 *
 * Monotonic ordering guarantee
 * ─────────────────────────────
 * Each (provider_sid → status_rank) entry in the monotonic store ensures
 * that a terminal status (delivered, failed, undelivered) can never be
 * regressed to an earlier status (queued, sent, etc.).
 *
 * Status rank order (ascending):
 *   queued(1) → sending(2) → sent(3) → delivered(4)
 *                                    ↘ undelivered(4) | failed(4)
 *
 * Any attempt to publish a status whose rank is ≤ the already-recorded
 * rank for that provider_sid is silently dropped.
 */

import { randomUUID } from 'crypto';
import { Logger } from '../config/logger.js';
import { dashboardPublisher } from './dashboard.js';
import {
  CstDeliveryEventV1,
  DeliveryStatus,
  createCstDeliveryEventV1,
  AllowedChannel,
  CustomerPayload,
} from '../contracts/events.js';

// ─── Monotonic Status Rank ────────────────────────────────────────────────────

/**
 * Supported statuses for cst.delivery events (subset required by Task 5).
 * "pending" and "refused" are internal transport states; they are mapped
 * before this layer is reached so they do not appear here.
 */
const DELIVERY_STATUS_RANK: Record<string, number> = {
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
};

/**
 * In-memory monotonic guard: providerSid → highest rank published so far.
 * Cleared per-process; intentionally ephemeral — restarts reset state which
 * is acceptable given Twilio resends webhooks in order.
 */
const monotonicStore = new Map<string, number>();

/**
 * Returns true if the new status should be published (its rank is strictly
 * greater than the previously recorded rank for this providerSid).
 */
export function isMonotonicAdvance(providerSid: string, newStatus: DeliveryStatus): boolean {
  const newRank = DELIVERY_STATUS_RANK[newStatus] ?? 0;
  const currentRank = monotonicStore.get(providerSid) ?? 0;
  return newRank > currentRank;
}

/**
 * Record the rank for a providerSid after a successful publish attempt.
 */
export function recordMonotonicRank(providerSid: string, status: DeliveryStatus): void {
  const rank = DELIVERY_STATUS_RANK[status] ?? 0;
  const current = monotonicStore.get(providerSid) ?? 0;
  if (rank > current) {
    monotonicStore.set(providerSid, rank);
  }
}

/** Reset monotonic store (test environments only). */
export function resetMonotonicStore(): void {
  monotonicStore.clear();
}

// ─── Delivery Event Builder ───────────────────────────────────────────────────

export interface PublishDeliveryParams {
  /** Twilio MessageSid or internal message ID */
  providerSid: string;
  /** Internal outbound message ID (db row id) */
  messageId?: string;
  /**
   * The originating cst.turn.turn_id — critical join key for the dashboard.
   * Equals envelope.correlation_id = MessageSid for SMS channel.
   */
  turnId?: string;
  channel: AllowedChannel;
  to: string;
  from?: string;
  status: DeliveryStatus;
  tenantId: string;
  projectId: string;
  correlationId: string;
  /** Optional customer context (best-effort; may be missing for webhook-only path) */
  customer?: CustomerPayload;
  segments?: number;
  errorCode?: string | number;
  errorMessage?: string;
  deliveryMs?: number;
  retryCount?: number;
}

/**
 * Builds and fires a cst.delivery event using the singleton dashboard publisher.
 * Fire-and-forget; never throws.
 *
 * Applies monotonic ordering — duplicate or regressed statuses are silently
 * dropped before the event reaches the publisher.
 */
export function publishDelivery(params: PublishDeliveryParams): void {
  const {
    providerSid,
    messageId,
    turnId,
    channel,
    to,
    from,
    status,
    tenantId,
    projectId,
    correlationId,
    customer,
    segments,
    errorCode,
    errorMessage,
    deliveryMs,
    retryCount,
  } = params;

  // ── Monotonic guard ──────────────────────────────────────────────────────
  const sid = providerSid || messageId || correlationId;
  if (!isMonotonicAdvance(sid, status)) {
    Logger.info(
      `[DeliveryPublisher] Dropping regressed/duplicate status "${status}" for ${sid} (monotonic guard)`
    );
    return;
  }

  // ── Build the canonical customer payload ─────────────────────────────────
  const effectiveCustomer: CustomerPayload = customer ?? {
    customer_ref: to,
    phone_e164: to,
    role: 'unknown',
    is_known: false,
    tenant_id: tenantId,
    project_id: projectId,
  };

  // ── Build event ──────────────────────────────────────────────────────────
  let event: CstDeliveryEventV1;
  try {
    event = createCstDeliveryEventV1({
      id: randomUUID(),
      source: 'cst/transport',
      tenant_id: tenantId,
      project_id: projectId,
      correlation_id: correlationId,
      channel,
      customer: effectiveCustomer,
      delivery: {
        delivery_id: messageId || sid,
        turn_id: turnId || undefined,
        provider_sid: providerSid || undefined,
        channel,
        to,
        from: from || undefined,
        status,
        segments: segments ?? undefined,
        error_code: errorCode ?? undefined,
        error_message: errorMessage ?? undefined,
        duration: deliveryMs !== undefined ? { total_ms: deliveryMs } : undefined,
        retry_count: retryCount ?? undefined,
        delivered_at:
          status === 'delivered' ? new Date().toISOString() : undefined,
      },
    });
  } catch (err: any) {
    Logger.warn(
      `[DeliveryPublisher] Failed to build cst.delivery event for ${sid}: ${err?.message}`
    );
    return;
  }

  // ── Record monotonic rank before dispatching ─────────────────────────────
  recordMonotonicRank(sid, status);

  // ── Fire-and-forget via singleton publisher ──────────────────────────────
  try {
    dashboardPublisher.publishFireAndForget(event);
  } catch (err: any) {
    Logger.warn(
      `[DeliveryPublisher] publishFireAndForget threw synchronously for ${sid}: ${err?.message}`
    );
  }
}
