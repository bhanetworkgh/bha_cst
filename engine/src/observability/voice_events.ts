/**
 * Voice Observability & Event Capture Service (PBT5 / LOOP-1793729831162-PBT5)
 *
 * Implements durable event capture and Customer Service Slack observability
 * for ElevenLabs- and Twilio-routed inbound voice calls and call status callbacks.
 *
 * Guarantees:
 *  1. DURABLE PERSISTENCE: Every valid inbound call and status callback produces
 *     a canonical cst.event.v1 record stored in dashboard_publish_outcomes and
 *     voice_deliveries before returning success.
 *  2. IDEMPOTENCY: Duplicate deliveries are safely deduplicated without creating
 *     duplicate logical events or double-posting to Slack.
 *  3. OUT-OF-ORDER CALLBACK RESILIENCE: Monotonic status ranking prevents late-arriving
 *     intermediate callbacks from regressing terminal call states.
 *  4. DEDICATED SLACK OBSERVABILITY: Publishes notifications directly to
 *     #bha-customer-service-twin (Channel ID: C0BD6D53HAM).
 *  5. TENANT ISOLATION: Resolves tenant/project via service number bindings and
 *     strictly rejects client-supplied tenant overrides (anti-tamper).
 *  6. PRIVACY: PII (phone numbers) is masked in logs, event summaries, and Slack.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Logger } from '../config/logger.js';
import { DbClient, type VoiceDeliveryRecord } from '../db/client.js';
import { CoreRegistry } from '../core/registry.js';
import { maskPhone } from '../util/privacy.js';
import {
  type CstEventV1,
  type CustomerPayload,
  createCstInteractionStartEventV1,
  createCstDeliveryEventV1,
  createCstOutcomeEventV1,
  CST_EVENT_SPEC_VERSION,
  type AllowedDeliveryStatus,
} from '../contracts/events.js';
import { FailureDetector } from './failure_detector.js';

// ============================================================================
// 1. Telephony Schemas & Types
// ============================================================================

export const SUPPORTED_TWILIO_CALL_STATUSES = [
  'initiated',
  'queued',
  'ringing',
  'in-progress',
  'answered',
  'completed',
  'busy',
  'no-answer',
  'failed',
  'canceled',
] as const;

export type SupportedTwilioCallStatus = (typeof SUPPORTED_TWILIO_CALL_STATUSES)[number];

/**
 * Monotonic state rank for call lifecycle transitions.
 * Prevents out-of-order callbacks from regressing terminal states.
 */
export const CALL_STATUS_RANK: Record<string, number> = {
  initiated: 1,
  queued: 1,
  ringing: 2,
  'in-progress': 3,
  answered: 3,
  completed: 4,
  busy: 4,
  'no-answer': 4,
  failed: 4,
  canceled: 4,
};

export const InboundCallPayloadSchema = z.object({
  CallSid: z.string().optional(),
  call_id: z.string().optional(),
  conversation_id: z.string().optional(),
  From: z.string().optional(),
  from_number: z.string().optional(),
  caller_id: z.string().optional(),
  To: z.string().optional(),
  to_number: z.string().optional(),
  CallStatus: z.string().optional(),
  Direction: z.string().optional(),
  agent_id: z.string().optional(),
  voice_id: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
  correlation_id: z.string().optional(),
  tenant_id: z.string().optional(),
  project_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (data) => Boolean(data.CallSid || data.call_id || data.conversation_id),
  { message: 'Either CallSid, call_id, or conversation_id must be provided' }
);

export type InboundCallPayload = z.infer<typeof InboundCallPayloadSchema>;

export const StatusCallbackPayloadSchema = z.object({
  CallSid: z.string().min(1, 'CallSid is required'),
  AccountSid: z.string().optional(),
  From: z.string().optional(),
  To: z.string().optional(),
  CallStatus: z.string().min(1, 'CallStatus is required'),
  CallDuration: z.union([z.string(), z.number()]).optional(),
  Duration: z.union([z.string(), z.number()]).optional(),
  ErrorCode: z.union([z.string(), z.number()]).optional(),
  ErrorMessage: z.string().optional(),
  SequenceNumber: z.union([z.string(), z.number()]).optional(),
  Timestamp: z.string().optional(),
  CallbackSource: z.string().optional(),
  RecordingUrl: z.string().optional(),
  correlation_id: z.string().optional(),
  tenant_id: z.string().optional(),
  project_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type StatusCallbackPayload = z.infer<typeof StatusCallbackPayloadSchema>;

export interface InboundCallCaptureResult {
  status: 'processed' | 'already_processed' | 'failed' | 'refused';
  call_sid: string;
  event_id?: string;
  tenant_id: string;
  project_id: string;
  slack_delivered: boolean;
  unresolved_attribution: boolean;
  error?: string;
}

export interface StatusCallbackCaptureResult {
  status: 'processed' | 'already_processed' | 'failed' | 'refused' | 'unsupported_status';
  call_sid: string;
  call_status: string;
  delivery_status?: AllowedDeliveryStatus;
  event_ids: string[];
  tenant_id: string;
  project_id: string;
  slack_delivered: boolean;
  out_of_order: boolean;
  unresolved_attribution: boolean;
  error?: string;
}

export interface CustomerServiceSlackNotification {
  channel: string;
  channel_id: string;
  title: string;
  text: string;
  event_type: 'inbound_call' | 'status_callback';
  call_sid: string;
  call_status?: string;
  timestamp: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  duration_secs?: number;
  error_code?: string | number;
  error_message?: string;
  event_reference_id?: string;
  meta?: Record<string, unknown>;
}

export type SlackNotificationHandler = (
  notification: CustomerServiceSlackNotification,
  rawSlackBody: Record<string, unknown>
) => boolean | Promise<boolean>;

// ============================================================================
// 2. Voice Event Capture Service
// ============================================================================

export class VoiceEventCaptureService {
  public static readonly TARGET_SLACK_CHANNEL = '#bha-customer-service-twin';
  public static readonly TARGET_SLACK_CHANNEL_ID = 'C0BD6D53HAM';

  private static processedIdempotencyKeys = new Set<string>();
  private static recordedEvents = new Map<string, CstEventV1>();
  private static callHighestRank = new Map<string, number>();
  private static mockSlackHandler: SlackNotificationHandler | null = null;
  private static failedSlackDeliveries: CustomerServiceSlackNotification[] = [];

  static reset(): void {
    this.processedIdempotencyKeys.clear();
    this.recordedEvents.clear();
    this.callHighestRank.clear();
    this.mockSlackHandler = null;
    this.failedSlackDeliveries = [];
  }

  static setMockSlackHandler(handler: SlackNotificationHandler | null): void {
    this.mockSlackHandler = handler;
  }

  static getRecordedEvents(): CstEventV1[] {
    return Array.from(this.recordedEvents.values());
  }

  static getFailedSlackDeliveries(): CustomerServiceSlackNotification[] {
    return [...this.failedSlackDeliveries];
  }

  /**
   * Map Twilio CallStatus to canonical CST DeliveryStatus.
   */
  static mapCallStatusToDeliveryStatus(callStatus: string): AllowedDeliveryStatus {
    const normalized = callStatus.toLowerCase().trim();
    switch (normalized) {
      case 'queued':
      case 'initiated':
        return 'queued';
      case 'ringing':
        return 'sending';
      case 'in-progress':
      case 'answered':
        return 'sent';
      case 'completed':
        return 'delivered';
      case 'no-answer':
        return 'undelivered';
      case 'busy':
      case 'failed':
        return 'failed';
      case 'canceled':
        return 'refused';
      default:
        return 'failed';
    }
  }

  /**
   * Capture and persist an inbound voice call event.
   */
  static async captureInboundCall(
    rawPayload: unknown
  ): Promise<InboundCallCaptureResult> {
    FailureDetector.recordTwilioCallback();

    const parsed = InboundCallPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      FailureDetector.recordWebhookValidationFailure(parsed.error.flatten());
      return {
        status: 'failed',
        call_sid: 'unknown',
        tenant_id: 'unknown',
        project_id: 'unknown',
        slack_delivered: false,
        unresolved_attribution: true,
        error: `Invalid inbound call payload: ${JSON.stringify(parsed.error.flatten())}`,
      };
    }

    const payload = parsed.data;
    const callSid = payload.CallSid || payload.call_id || payload.conversation_id!;
    const idempotencyKey = `voice:inbound:${callSid}`;

    // 1. Idempotency Check
    if (this.processedIdempotencyKeys.has(idempotencyKey)) {
      FailureDetector.recordWebhookDuplicate();
      Logger.info(`VoiceEventCaptureService: duplicate inbound call ignored for ${callSid}`);
      return {
        status: 'already_processed',
        call_sid: callSid,
        tenant_id: 'known',
        project_id: 'known',
        slack_delivered: false,
        unresolved_attribution: false,
      };
    }

    // 2. Resolve Service Number & Tenancy
    const receivingNumber = (payload.To || payload.to_number || '').trim();
    const callerNumber = (payload.From || payload.from_number || payload.caller_id || '').trim();

    let tenantId = 'unresolved';
    let projectId = 'unresolved';
    let unresolvedAttribution = true;

    if (receivingNumber) {
      const binding = CoreRegistry.resolveServiceNumber(receivingNumber);
      if (binding) {
        tenantId = binding.tenant_id;
        projectId = binding.project_id;
        unresolvedAttribution = false;
      }
    }

    // Tenancy anti-tamper check (R-NUM-S4): Client-provided tenant overrides are forbidden
    if (payload.tenant_id && !unresolvedAttribution && payload.tenant_id !== tenantId) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        actor: 'voice_inbound_capture',
        role: 'untrusted_ingress',
        entry_point: 'webhook',
        tool_or_route: '/webhooks/voice/inbound',
        outcome: 'refused',
        reason: `Cross-tenant payload mismatch: body tenant_id (${payload.tenant_id}) !== resolved (${tenantId})`,
        correlation_id: callSid,
      });
      return {
        status: 'refused',
        call_sid: callSid,
        tenant_id: tenantId,
        project_id: projectId,
        slack_delivered: false,
        unresolved_attribution: false,
        error: 'TENANT_SCOPE_VIOLATION: Client-provided tenant overrides are strictly forbidden',
      };
    }

    if (unresolvedAttribution) {
      FailureDetector.recordTwilioUnresolvedAttribution(callSid);
      Logger.warn(`VoiceEventCaptureService: Inbound call ${callSid} has unresolved attribution for receiving number ${receivingNumber}`);
    }

    // 3. Normalize into canonical cst.event.v1 (cst.interaction.start)
    const nowIso = new Date().toISOString();
    const eventTime = payload.timestamp
      ? (typeof payload.timestamp === 'number'
          ? new Date(payload.timestamp * (payload.timestamp < 1e11 ? 1000 : 1)).toISOString()
          : new Date(payload.timestamp).toISOString())
      : nowIso;

    const eventId = `evt_start_${randomUUID()}`;
    const customerPayload: CustomerPayload = {
      phone_e164: callerNumber || '+15550000000',
      customer_ref: callerNumber || callSid,
      role: 'unknown',
      is_known: !unresolvedAttribution,
      tenant_id: tenantId,
      project_id: projectId,
    };

    const startEvent = createCstInteractionStartEventV1({
      id: eventId,
      source: 'cst/voice/inbound',
      time: eventTime,
      tenant_id: tenantId,
      project_id: projectId,
      correlation_id: callSid,
      channel: 'voice',
      customer: customerPayload,
      start: {
        interaction_id: callSid,
        session_id: payload.conversation_id,
        channel: 'voice',
        direction: 'inbound',
        started_at: eventTime,
        metadata: {
          provider: payload.conversation_id ? 'elevenlabs' : 'twilio',
          call_sid: callSid,
          conversation_id: payload.conversation_id,
          agent_id: payload.agent_id,
          voice_id: payload.voice_id,
          from_masked: maskPhone(callerNumber),
          to_masked: maskPhone(receivingNumber),
          unresolved_attribution: unresolvedAttribution,
        },
      },
    });

    // 4. Durably Persist Before Acknowledging
    try {
      // Record to dashboard_publish_outcomes
      await DbClient.recordDashboardPublishOutcome({
        id: `dpo_${eventId}`,
        event_id: eventId,
        event_type: 'cst.interaction.start',
        specversion: CST_EVENT_SPEC_VERSION,
        correlation_id: callSid,
        tenant_id: tenantId,
        project_id: projectId,
        status: 'published',
        attempts: 1,
        payload: startEvent,
      });

      // Record to voice_deliveries ledger
      await DbClient.recordVoiceDelivery({
        system_id: projectId,
        project_id: projectId,
        tenant_id: tenantId,
        status: 'synthesized',
        character_count: 0,
        audio_bytes: 0,
        correlation_id: callSid,
        delivered_at: eventTime,
      });

      this.processedIdempotencyKeys.add(idempotencyKey);
      this.recordedEvents.set(eventId, startEvent);
      this.callHighestRank.set(callSid, CALL_STATUS_RANK['ringing'] || 2);
    } catch (err: any) {
      FailureDetector.recordWebhookPersistenceFailure(err.message);
      Logger.error(`VoiceEventCaptureService: persistence failure for inbound call ${callSid}: ${err.message}`);
      return {
        status: 'failed',
        call_sid: callSid,
        tenant_id: tenantId,
        project_id: projectId,
        slack_delivered: false,
        unresolved_attribution: unresolvedAttribution,
        error: `Database persistence failed: ${err.message}`,
      };
    }

    // 5. Publish to Slack #bha-customer-service-twin (C0BD6D53HAM)
    const slackNotification: CustomerServiceSlackNotification = {
      channel: this.TARGET_SLACK_CHANNEL,
      channel_id: this.TARGET_SLACK_CHANNEL_ID,
      title: 'Inbound Voice Call Received',
      text: `Inbound voice call initiated from ${maskPhone(callerNumber)} to ${maskPhone(receivingNumber)}`,
      event_type: 'inbound_call',
      call_sid: callSid,
      call_status: payload.CallStatus || 'ringing',
      timestamp: eventTime,
      tenant_id: tenantId,
      project_id: projectId,
      correlation_id: callSid,
      event_reference_id: eventId,
      meta: {
        agent_id: payload.agent_id,
        conversation_id: payload.conversation_id,
        unresolved_attribution: unresolvedAttribution,
      },
    };

    const slackDelivered = await this.publishSlackNotification(slackNotification);

    return {
      status: 'processed',
      call_sid: callSid,
      event_id: eventId,
      tenant_id: tenantId,
      project_id: projectId,
      slack_delivered: slackDelivered,
      unresolved_attribution: unresolvedAttribution,
    };
  }

  /**
   * Capture and persist a Twilio voice status callback.
   */
  static async captureStatusCallback(
    rawPayload: unknown
  ): Promise<StatusCallbackCaptureResult> {
    FailureDetector.recordTwilioCallback();

    const parsed = StatusCallbackPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      FailureDetector.recordWebhookValidationFailure(parsed.error.flatten());
      return {
        status: 'failed',
        call_sid: 'unknown',
        call_status: 'unknown',
        event_ids: [],
        tenant_id: 'unknown',
        project_id: 'unknown',
        slack_delivered: false,
        out_of_order: false,
        unresolved_attribution: true,
        error: `Invalid status callback payload: ${JSON.stringify(parsed.error.flatten())}`,
      };
    }

    const payload = parsed.data;
    const callSid = payload.CallSid;
    const rawStatus = (payload.CallStatus || '').toLowerCase().trim();

    // Validate that the status is a supported Twilio status
    const isSupportedStatus = (SUPPORTED_TWILIO_CALL_STATUSES as readonly string[]).includes(rawStatus);
    if (!isSupportedStatus) {
      Logger.warn(`VoiceEventCaptureService: received unsupported/unknown call status "${rawStatus}" for call ${callSid}`);
      return {
        status: 'unsupported_status',
        call_sid: callSid,
        call_status: rawStatus,
        event_ids: [],
        tenant_id: 'unknown',
        project_id: 'unknown',
        slack_delivered: false,
        out_of_order: false,
        unresolved_attribution: true,
        error: `Unsupported call status "${rawStatus}". Unknown statuses must not be classified as successful.`,
      };
    }

    const idempotencyKey = `voice:status:${callSid}:${rawStatus}:${payload.SequenceNumber || ''}`;
    if (this.processedIdempotencyKeys.has(idempotencyKey)) {
      FailureDetector.recordWebhookDuplicate();
      Logger.info(`VoiceEventCaptureService: duplicate status callback ignored for ${callSid} (${rawStatus})`);
      return {
        status: 'already_processed',
        call_sid: callSid,
        call_status: rawStatus,
        delivery_status: this.mapCallStatusToDeliveryStatus(rawStatus),
        event_ids: [],
        tenant_id: 'known',
        project_id: 'known',
        slack_delivered: false,
        out_of_order: false,
        unresolved_attribution: false,
      };
    }

    // 2. Resolve Tenancy & Service Number
    const receivingNumber = (payload.To || '').trim();
    const callerNumber = (payload.From || '').trim();

    let tenantId = 'unresolved';
    let projectId = 'unresolved';
    let unresolvedAttribution = true;

    if (receivingNumber) {
      const binding = CoreRegistry.resolveServiceNumber(receivingNumber);
      if (binding) {
        tenantId = binding.tenant_id;
        projectId = binding.project_id;
        unresolvedAttribution = false;
      }
    }

    // Anti-tamper check
    if (payload.tenant_id && !unresolvedAttribution && payload.tenant_id !== tenantId) {
      return {
        status: 'refused',
        call_sid: callSid,
        call_status: rawStatus,
        event_ids: [],
        tenant_id: tenantId,
        project_id: projectId,
        slack_delivered: false,
        out_of_order: false,
        unresolved_attribution: false,
        error: 'TENANT_SCOPE_VIOLATION: Client-provided tenant overrides are strictly forbidden',
      };
    }

    if (unresolvedAttribution) {
      FailureDetector.recordTwilioUnresolvedAttribution(callSid);
    }

    // 3. Out-of-Order Check & Monotonic State Ranking
    const incomingRank = CALL_STATUS_RANK[rawStatus] || 0;
    const currentHighestRank = this.callHighestRank.get(callSid) || 0;
    const isOutOfOrder = incomingRank > 0 && currentHighestRank > 0 && incomingRank < currentHighestRank;

    if (isOutOfOrder) {
      FailureDetector.recordTwilioInvalidTransition(callSid, `rank_${currentHighestRank}`, rawStatus);
      Logger.warn(
        `VoiceEventCaptureService: Out-of-order callback detected for ${callSid}. ` +
        `Incoming status "${rawStatus}" (rank ${incomingRank}) < current highest rank (${currentHighestRank}). ` +
        `Event will be audited but state regression is suppressed.`
      );
    } else if (incomingRank > currentHighestRank) {
      this.callHighestRank.set(callSid, incomingRank);
    }

    // 4. Normalize to cst.event.v1 (cst.delivery & optional cst.outcome)
    const nowIso = new Date().toISOString();
    const callbackTime = payload.Timestamp ? new Date(payload.Timestamp).toISOString() : nowIso;
    const durationSecs = payload.CallDuration !== undefined
      ? Number(payload.CallDuration)
      : payload.Duration !== undefined
      ? Number(payload.Duration)
      : undefined;

    const deliveryStatus = this.mapCallStatusToDeliveryStatus(rawStatus);
    const deliveryEventId = `evt_del_${randomUUID()}`;
    const generatedEventIds: string[] = [deliveryEventId];

    const customerPayload: CustomerPayload = {
      phone_e164: callerNumber || '+15550000000',
      customer_ref: callerNumber || callSid,
      role: 'unknown',
      is_known: !unresolvedAttribution,
      tenant_id: tenantId,
      project_id: projectId,
    };

    const deliveryEvent = createCstDeliveryEventV1({
      id: deliveryEventId,
      source: 'cst/voice/status_callback',
      time: callbackTime,
      tenant_id: tenantId,
      project_id: projectId,
      correlation_id: callSid,
      channel: 'voice',
      customer: customerPayload,
      delivery: {
        delivery_id: `del_${callSid}_${rawStatus}`,
        provider_sid: callSid,
        channel: 'voice',
        to: receivingNumber || 'unknown',
        from: callerNumber || undefined,
        status: deliveryStatus,
        duration: durationSecs !== undefined ? { total_ms: durationSecs * 1000, call_seconds: durationSecs } : undefined,
        error_code: payload.ErrorCode ? String(payload.ErrorCode) : undefined,
        error_message: payload.ErrorMessage || undefined,
        delivered_at: rawStatus === 'completed' ? callbackTime : undefined,
        metadata: {
          provider: 'twilio',
          call_status: rawStatus,
          sequence_number: payload.SequenceNumber !== undefined ? Number(payload.SequenceNumber) : undefined,
          out_of_order: isOutOfOrder,
          unresolved_attribution: unresolvedAttribution,
        },
      },
    });

    // If terminal status, also produce a cst.outcome event
    let outcomeEvent: CstEventV1 | null = null;
    if (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'busy' || rawStatus === 'no-answer') {
      const outcomeEventId = `evt_outcome_${randomUUID()}`;
      outcomeEvent = createCstOutcomeEventV1({
        id: outcomeEventId,
        source: 'cst/voice/status_callback',
        time: callbackTime,
        tenant_id: tenantId,
        project_id: projectId,
        correlation_id: callSid,
        channel: 'voice',
        customer: customerPayload,
        outcome: {
          interaction_id: callSid,
          status: rawStatus === 'completed' ? 'resolved' : 'failed',
          duration_secs: durationSecs || 0,
          summary: `Call ${callSid} finished with status "${rawStatus}"${durationSecs ? ` (duration: ${durationSecs}s)` : ''}`,
          metadata: {
            call_status: rawStatus,
            error_code: payload.ErrorCode,
            error_message: payload.ErrorMessage,
          },
        },
      });
      generatedEventIds.push(outcomeEventId);
    }

    // 5. Durably Persist
    try {
      // Record delivery event
      await DbClient.recordDashboardPublishOutcome({
        id: `dpo_${deliveryEventId}`,
        event_id: deliveryEventId,
        event_type: 'cst.delivery',
        specversion: CST_EVENT_SPEC_VERSION,
        correlation_id: callSid,
        tenant_id: tenantId,
        project_id: projectId,
        status: 'published',
        attempts: 1,
        payload: deliveryEvent,
      });
      this.recordedEvents.set(deliveryEventId, deliveryEvent);

      // Record outcome event if generated
      if (outcomeEvent) {
        await DbClient.recordDashboardPublishOutcome({
          id: `dpo_${outcomeEvent.id}`,
          event_id: outcomeEvent.id,
          event_type: 'cst.outcome',
          specversion: CST_EVENT_SPEC_VERSION,
          correlation_id: callSid,
          tenant_id: tenantId,
          project_id: projectId,
          status: 'published',
          attempts: 1,
          payload: outcomeEvent,
        });
        this.recordedEvents.set(outcomeEvent.id, outcomeEvent);
      }

      // Update voice_deliveries only if NOT an out-of-order state regression
      if (!isOutOfOrder) {
        const recordStatus: VoiceDeliveryRecord['status'] =
          rawStatus === 'completed'
            ? 'sent'
            : rawStatus === 'failed' || rawStatus === 'busy' || rawStatus === 'no-answer'
            ? 'failed'
            : rawStatus === 'canceled'
            ? 'refused'
            : 'synthesized';

        await DbClient.recordVoiceDelivery({
          system_id: projectId,
          project_id: projectId,
          tenant_id: tenantId,
          status: recordStatus,
          error_code: payload.ErrorCode ? String(payload.ErrorCode) : undefined,
          error_message: payload.ErrorMessage || undefined,
          character_count: 0,
          audio_bytes: 0,
          correlation_id: callSid,
          delivered_at: rawStatus === 'completed' ? callbackTime : undefined,
        });
      }

      this.processedIdempotencyKeys.add(idempotencyKey);
    } catch (err: any) {
      FailureDetector.recordWebhookPersistenceFailure(err.message);
      Logger.error(`VoiceEventCaptureService: persistence failure for status callback ${callSid}: ${err.message}`);
      return {
        status: 'failed',
        call_sid: callSid,
        call_status: rawStatus,
        event_ids: [],
        tenant_id: tenantId,
        project_id: projectId,
        slack_delivered: false,
        out_of_order: isOutOfOrder,
        unresolved_attribution: unresolvedAttribution,
        error: `Database persistence failed: ${err.message}`,
      };
    }

    // 6. Publish Notification to #bha-customer-service-twin (C0BD6D53HAM)
    const slackNotification: CustomerServiceSlackNotification = {
      channel: this.TARGET_SLACK_CHANNEL,
      channel_id: this.TARGET_SLACK_CHANNEL_ID,
      title: `Voice Call Status: ${rawStatus}`,
      text: `Call ${callSid} status updated to *${rawStatus}*${durationSecs ? ` (duration: ${durationSecs}s)` : ''}`,
      event_type: 'status_callback',
      call_sid: callSid,
      call_status: rawStatus,
      timestamp: callbackTime,
      tenant_id: tenantId,
      project_id: projectId,
      correlation_id: callSid,
      duration_secs: durationSecs,
      error_code: payload.ErrorCode,
      error_message: payload.ErrorMessage,
      event_reference_id: deliveryEventId,
      meta: {
        out_of_order: isOutOfOrder,
        sequence_number: payload.SequenceNumber,
        unresolved_attribution: unresolvedAttribution,
      },
    };

    const slackDelivered = await this.publishSlackNotification(slackNotification);

    return {
      status: 'processed',
      call_sid: callSid,
      call_status: rawStatus,
      delivery_status: deliveryStatus,
      event_ids: generatedEventIds,
      tenant_id: tenantId,
      project_id: projectId,
      slack_delivered: slackDelivered,
      out_of_order: isOutOfOrder,
      unresolved_attribution: unresolvedAttribution,
    };
  }

  /**
   * Internal Slack dispatcher for Customer Service Twin notifications.
   */
  private static async publishSlackNotification(
    notification: CustomerServiceSlackNotification
  ): Promise<boolean> {
    FailureDetector.recordSlackAttempt();

    const severity =
      notification.call_status === 'failed' || notification.error_code
        ? 'ERROR'
        : notification.call_status === 'busy' || notification.call_status === 'no-answer'
        ? 'WARN'
        : 'INFO';

    const color =
      severity === 'ERROR' ? '#D00000' : severity === 'WARN' ? '#ECB22E' : '#2EB886';

    const fields = [
      { title: 'Event Type', value: notification.event_type === 'inbound_call' ? 'Inbound Voice Call' : 'Twilio Status Callback', short: true },
      { title: 'Call SID', value: notification.call_sid, short: true },
      { title: 'Call Status', value: notification.call_status || 'unknown', short: true },
      { title: 'Channel ID', value: notification.channel_id, short: true },
      { title: 'Tenant / Project', value: `${notification.tenant_id} / ${notification.project_id}`, short: true },
      { title: 'Correlation ID', value: notification.correlation_id, short: true },
      { title: 'Timestamp', value: notification.timestamp, short: true },
    ];

    if (notification.duration_secs !== undefined) {
      fields.push({ title: 'Duration', value: `${notification.duration_secs}s`, short: true });
    }

    if (notification.error_code || notification.error_message) {
      fields.push({
        title: 'Error Details',
        value: `Code: ${notification.error_code ?? 'N/A'} - ${notification.error_message ?? 'N/A'}`,
        short: false,
      });
    }

    const slackBody = {
      channel: notification.channel_id,
      text: `[${notification.event_type.toUpperCase()}] ${notification.title}: ${notification.text}`,
      attachments: [
        {
          color,
          title: notification.title,
          text: notification.text,
          fields,
          footer: `CST Observability (PBT5) | Event Ref: ${notification.event_reference_id || 'N/A'}`,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    // If mock handler is set (for testing)
    if (this.mockSlackHandler) {
      try {
        const ok = await this.mockSlackHandler(notification, slackBody);
        if (ok) {
          FailureDetector.recordSlackSuccess();
          return true;
        } else {
          FailureDetector.recordSlackFailure('Mock handler returned false');
          this.failedSlackDeliveries.push(notification);
          return false;
        }
      } catch (err: any) {
        FailureDetector.recordSlackFailure(err.message);
        this.failedSlackDeliveries.push(notification);
        return false;
      }
    }

    // Resolve webhook URL
    const webhookUrl =
      process.env.SLACK_CUSTOMER_SERVICE_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL;

    if (!webhookUrl) {
      FailureDetector.recordSlackDeferred(this.TARGET_SLACK_CHANNEL);
      // In development/test with no webhook URL configured, we preserve the delivery for retry
      this.failedSlackDeliveries.push(notification);
      return false;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackBody),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        FailureDetector.recordSlackFailure(`HTTP ${response.status}: ${errText}`);
        this.failedSlackDeliveries.push(notification);
        return false;
      }

      FailureDetector.recordSlackSuccess();
      return true;
    } catch (err: any) {
      FailureDetector.recordSlackFailure(err.message);
      this.failedSlackDeliveries.push(notification);
      return false;
    }
  }

  /**
   * Retry failed Slack notifications.
   */
  static async retryFailedSlackDeliveries(): Promise<number> {
    const queue = [...this.failedSlackDeliveries];
    this.failedSlackDeliveries = [];
    let successCount = 0;

    for (const item of queue) {
      const ok = await this.publishSlackNotification(item);
      if (ok) {
        successCount++;
        FailureDetector.recordSlackSuccess();
      }
    }

    return successCount;
  }
}
