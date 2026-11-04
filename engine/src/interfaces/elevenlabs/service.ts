import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { Logger } from '../../config/logger.js';
import { DbClient } from '../../db/client.js';
import { maskPhone } from '../../util/privacy.js';
import {
  CstEventV1,
  CustomerPayload,
  createCstInteractionStartEventV1,
  createCstTranscriptEventV1,
  createCstOutcomeEventV1,
  createCstEscalationEventV1,
  AllowedChannel,
} from '../../contracts/events.js';
import {
  ElevenLabsPostCallWebhookPayload,
  ElevenLabsTranscriptMessage,
} from './schemas.js';
import { ErrorRouter } from '../../notifications/error_router.js';
import { FailureDetector } from '../../observability/failure_detector.js';
import { CutOverManager } from '../../observability/cut_over.js';

export interface WebhookProcessResult {
  status: 'processed' | 'already_processed' | 'ignored_pre_cutover' | 'failed';
  conversation_id: string;
  events_count: number;
  event_ids: string[];
  slack_delivered: boolean;
  escalation_created: boolean;
  escalation_id?: string;
  error?: string;
}

export class ElevenLabsWebhookService {
  private static processedIdempotencyKeys = new Set<string>();
  private static persistedEvents = new Map<string, CstEventV1>();

  static reset(): void {
    this.processedIdempotencyKeys.clear();
    this.persistedEvents.clear();
  }

  static getPersistedEvents(): CstEventV1[] {
    return Array.from(this.persistedEvents.values());
  }

  /**
   * Authenticate incoming ElevenLabs webhook.
   */
  static authenticate(req: Request, rawBody?: string): boolean {
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET || process.env.CST_API_KEY;

    // 1. Signature-based authentication (elevenlabs-signature / x-elevenlabs-signature)
    const sigHeader = (req.header('elevenlabs-signature') || req.header('x-elevenlabs-signature') || '').trim();
    if (sigHeader && secret) {
      try {
        const bodyToVerify = rawBody || (req as any).rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

        // Case A: Official ElevenLabs format: "t=<timestamp>,v0=<hex_hmac>"
        if (sigHeader.includes('v0=')) {
          const parts = sigHeader.split(',');
          const timestamp = parts.find((p) => p.trim().startsWith('t='))?.trim().slice(2);
          const signature = parts.find((p) => p.trim().startsWith('v0='))?.trim().slice(3);

          if (timestamp && signature) {
            // Check timestamp tolerance (30 minutes)
            const toleranceSecs = 30 * 60;
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const eventTimestamp = parseInt(timestamp, 10);
            if (!isNaN(eventTimestamp) && Math.abs(currentTimestamp - eventTimestamp) <= toleranceSecs) {
              const signedPayload = `${timestamp}.${bodyToVerify}`;
              const expectedHmac = createHmac('sha256', secret).update(signedPayload).digest('hex');
              if (signature.length === expectedHmac.length) {
                const match = timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedHmac, 'utf8'));
                if (match) {
                  FailureDetector.recordWebhookAuthSuccess();
                  return true;
                }
              }
            }
          }
        }

        // Case B: Direct HMAC or "sha256=<hex>" format (used in tests and fallback)
        const signature = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader;
        const expectedHmac = createHmac('sha256', secret).update(bodyToVerify).digest('hex');
        if (signature.length === expectedHmac.length) {
          const match = timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedHmac, 'utf8'));
          if (match) {
            FailureDetector.recordWebhookAuthSuccess();
            return true;
          }
        }
      } catch (err: any) {
        Logger.warn(`ElevenLabsWebhookService: signature verification error: ${err?.message}`);
      }
    }

    // 2. Secret header authentication (x-webhook-secret or Authorization: Bearer <secret>)
    const webhookSecret = (req.header('x-webhook-secret') || '').trim();
    if (webhookSecret && secret) {
      if (webhookSecret.length === secret.length && timingSafeEqual(Buffer.from(webhookSecret, 'utf8'), Buffer.from(secret, 'utf8'))) {
        FailureDetector.recordWebhookAuthSuccess();
        return true;
      }
    }

    const authHeader = (req.header('authorization') || '').trim();
    if (authHeader.startsWith('Bearer ') && secret) {
      const token = authHeader.slice(7).trim();
      if (token.length === secret.length && timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(secret, 'utf8'))) {
        FailureDetector.recordWebhookAuthSuccess();
        return true;
      }
    }

    // If no secret configured and environment is test/dev, permit for testing
    if (!secret && process.env.NODE_ENV === 'test') {
      FailureDetector.recordWebhookAuthSuccess();
      return true;
    }

    FailureDetector.recordWebhookAuthFailure('Invalid signature or missing secret header');
    return false;
  }

  /**
   * Process a post-call webhook payload, normalize into cst.event.v1, persist, and publish to Slack.
   */
  static async process(
    payload: ElevenLabsPostCallWebhookPayload
  ): Promise<WebhookProcessResult> {
    FailureDetector.recordWebhookReceived();

    const conversationId = String(payload.conversation_id || payload.call_id);
    const idempotencyKey = `elevenlabs:${conversationId}:post_call`;

    // 1. Idempotency Check
    if (this.processedIdempotencyKeys.has(idempotencyKey)) {
      FailureDetector.recordWebhookDuplicate();
      Logger.info(`ElevenLabsWebhookService: duplicate webhook delivery ignored for conversation ${conversationId}`);
      return {
        status: 'already_processed',
        conversation_id: conversationId,
        events_count: 0,
        event_ids: [],
        slack_delivered: false,
        escalation_created: false,
      };
    }

    // 2. Forward-Only Cut-Over Check
    const startUnix = payload.start_time_unix_secs || Math.floor(Date.now() / 1000);
    const eligibility = CutOverManager.isEventEligible(startUnix, conversationId);
    if (!eligibility.eligible) {
      Logger.info(`ElevenLabsWebhookService: event ${conversationId} ignored by forward-only cutover policy (${eligibility.reason})`);
      return {
        status: 'ignored_pre_cutover',
        conversation_id: conversationId,
        events_count: 0,
        event_ids: [],
        slack_delivered: false,
        escalation_created: false,
      };
    }

    // 3. Extract Context and Tenant Attribution
    const customVars = payload.metadata?.custom_variables || {};
    const tenantId = String(customVars.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01');
    const projectId = String(customVars.project_id || 'proj-vfarm-main');
    const callerPhone = String(customVars.caller_phone || payload.metadata?.caller_id || '+15550000000');
    const rawChannel = String(customVars.channel || 'voice').toLowerCase();
    const channel: AllowedChannel = rawChannel === 'whatsapp' ? 'whatsapp' : 'voice';

    const transcriptList = payload.transcript || payload.message_history || [];
    const customerName = payload.analysis?.data_collection_results?.customer_name as string | undefined;
    const customerEmail = payload.analysis?.data_collection_results?.customer_email as string | undefined;

    const customerPayload: CustomerPayload = {
      phone_e164: callerPhone,
      customer_ref: customerEmail || callerPhone,
      role: 'owner',
      is_known: true,
      tenant_id: tenantId,
      project_id: projectId,
      farm_ids: ['farm_1'],
    };

    const generatedEvents: CstEventV1[] = [];
    const eventIds: string[] = [];
    const nowIso = new Date().toISOString();

    try {
      // 4A. Normalize Interaction Start Event
      if (payload.start_time_unix_secs) {
        const startIso = new Date(payload.start_time_unix_secs * 1000).toISOString();
        const startEventId = `evt_start_${randomUUID()}`;
        const startEvent = createCstInteractionStartEventV1({
          id: startEventId,
          source: 'cst/voice/elevenlabs',
          time: startIso,
          tenant_id: tenantId,
          project_id: projectId,
          correlation_id: conversationId,
          channel,
          customer: customerPayload,
          start: {
            interaction_id: conversationId,
            channel,
            direction: 'inbound',
            started_at: startIso,
            metadata: { agent_id: payload.agent_id },
          },
        });
        generatedEvents.push(startEvent);
        eventIds.push(startEventId);
      }

      // 4B. Normalize Transcript Event
      const transcriptMessages = transcriptList.map((m: ElevenLabsTranscriptMessage) => ({
        role: (m.role === 'agent' || m.role === 'assistant' ? 'agent' : m.role === 'system' ? 'system' : 'user') as 'user' | 'agent' | 'system',
        message: m.message,
        time_in_call_secs: m.time_in_call_secs,
        timestamp: nowIso,
      }));

      const transcriptEventId = `evt_trsc_${randomUUID()}`;
      const transcriptEvent = createCstTranscriptEventV1({
        id: transcriptEventId,
        source: 'cst/voice/elevenlabs',
        time: nowIso,
        tenant_id: tenantId,
        project_id: projectId,
        correlation_id: conversationId,
        channel,
        customer: customerPayload,
        transcript: {
          interaction_id: conversationId,
          channel,
          duration_secs: payload.call_duration_secs || 0,
          messages: transcriptMessages,
          summary: payload.analysis?.transcript_summary,
          metadata: { agent_id: payload.agent_id },
        },
      });
      generatedEvents.push(transcriptEvent);
      eventIds.push(transcriptEventId);

      // 4C. Normalize Outcome Event
      const isCallSuccess = payload.analysis?.call_successful === true || payload.analysis?.call_successful === 'success';
      const outcomeEventId = `evt_outc_${randomUUID()}`;
      const outcomeEvent = createCstOutcomeEventV1({
        id: outcomeEventId,
        source: 'cst/voice/elevenlabs',
        time: nowIso,
        tenant_id: tenantId,
        project_id: projectId,
        correlation_id: conversationId,
        channel,
        customer: customerPayload,
        outcome: {
          interaction_id: conversationId,
          status: isCallSuccess ? 'resolved' : 'transferred',
          summary: payload.analysis?.transcript_summary || 'Call completed',
          duration_secs: payload.call_duration_secs || 0,
          evaluation_criteria_results: payload.analysis?.evaluation_criteria_results,
          data_collected: payload.analysis?.data_collection_results,
        },
      });
      generatedEvents.push(outcomeEvent);
      eventIds.push(outcomeEventId);

      // 4D. Detect Escalation & Normalize Escalation Event
      const evalResults = payload.analysis?.evaluation_criteria_results || {};
      const escalationRequested =
        evalResults.escalation_requested === true ||
        evalResults.human_handoff === true ||
        evalResults.escalate === true ||
        transcriptList.some((m) => /human|agent|technician|escalat|representative/i.test(m.message));

      let escalationId: string | undefined;
      let escalationCreated = false;

      if (escalationRequested) {
        escalationId = `escl_${randomUUID()}`;
        const escalationEventId = `evt_escl_${randomUUID()}`;
        const firstUserQuestion = transcriptList.find((m) => m.role === 'user')?.message || 'Customer requested human assistance';

        const escalationEvent = createCstEscalationEventV1({
          id: escalationEventId,
          source: 'cst/escalation',
          time: nowIso,
          tenant_id: tenantId,
          project_id: projectId,
          correlation_id: conversationId,
          channel,
          customer: customerPayload,
          escalation: {
            escalation_id: escalationId,
            interaction_id: conversationId,
            reason: payload.analysis?.transcript_summary || 'Customer requested human follow-up',
            urgency: 'high',
            customer_contact: {
              name: customerName,
              email: customerEmail,
              phone_masked: maskPhone(callerPhone),
            },
            customer_question: firstUserQuestion,
            arrival_time: nowIso,
            channel,
          },
        });
        generatedEvents.push(escalationEvent);
        eventIds.push(escalationEventId);

        // Durable persistence into escalations table
        try {
          const persistedEscalationId = await DbClient.createEscalationRecord({
            caller_phone: callerPhone,
            tenant_id: tenantId,
            project_id: projectId,
            conversation_id: conversationId,
            correlation_id: conversationId,
            caller_email: customerEmail,
            reason: payload.analysis?.transcript_summary || 'Customer requested human follow-up',
            transcript: transcriptMessages.map((m) => `${m.role}: ${m.message}`),
            status: 'pending',
          });
          if (persistedEscalationId) {
            escalationId = persistedEscalationId;
            escalationCreated = true;
          }
        } catch (dbErr: any) {
          FailureDetector.recordWebhookPersistenceFailure(dbErr.message);
          Logger.error(`ElevenLabsWebhookService: failed to persist escalation record: ${dbErr.message}`);
        }
      }

      // 5. Durable Event Persistence (dashboard_publish_outcomes)
      for (const event of generatedEvents) {
        this.persistedEvents.set(event.id, event);
        try {
          await DbClient.recordDashboardPublishOutcome({
            event_id: event.id,
            event_type: event.type,
            specversion: event.specversion,
            correlation_id: event.correlation_id,
            tenant_id: event.tenant_id,
            project_id: event.project_id,
            status: 'published',
            attempts: 1,
            payload: event as any,
          });
        } catch (dbErr: any) {
          FailureDetector.recordWebhookPersistenceFailure(dbErr.message);
          Logger.warn(`ElevenLabsWebhookService: could not persist event ${event.id}: ${dbErr.message}`);
        }
      }

      // 6. Slack Event Delivery to Customer Service Channel (#bha-customer-service-twin)
      let slackDelivered = false;
      const firstQuestion = transcriptList.find((m) => m.role === 'user')?.message || 'N/A';
      const summaryText = payload.analysis?.transcript_summary || 'Completed voice interaction';

      const slackResult = await ErrorRouter.route({
        service: 'CS_HANDOFF',
        category: escalationRequested ? 'escalation' : 'cs_handoff',
        message: escalationRequested
          ? `Human escalation requested by ${customerName || maskPhone(callerPhone)} (${channel}): "${firstQuestion}"`
          : `Customer service interaction completed for ${maskPhone(callerPhone)}: ${summaryText}`,
        severity: 'WARN',
        tenant_id: tenantId,
        project_id: projectId,
        correlation_id: conversationId,
        timestamp: nowIso,
        meta: {
          interaction_id: conversationId,
          channel,
          customer_name: customerName || 'unspecified',
          customer_email: customerEmail || 'unspecified',
          customer_phone_masked: maskPhone(callerPhone),
          customer_question: firstQuestion,
          escalation_id: escalationId,
          escalation_created: escalationCreated,
          duration_secs: payload.call_duration_secs || 0,
        },
      });

      slackDelivered = slackResult.dispatched;
      if (slackDelivered) {
        FailureDetector.recordSlackSuccess();
      } else if (slackResult.status === 'failed') {
        FailureDetector.recordSlackFailure(slackResult.error);
      } else if (slackResult.status === 'deferred') {
        FailureDetector.recordSlackDeferred(slackResult.destination_channel);
      }

      // 7. Mark Idempotency Key Complete
      this.processedIdempotencyKeys.add(idempotencyKey);
      FailureDetector.recordWebhookProcessingSuccess();

      return {
        status: 'processed',
        conversation_id: conversationId,
        events_count: generatedEvents.length,
        event_ids: eventIds,
        slack_delivered: slackDelivered,
        escalation_created: escalationCreated,
        escalation_id: escalationId,
      };
    } catch (err: any) {
      FailureDetector.recordWebhookProcessingFailure(err?.message);
      Logger.error(`ElevenLabsWebhookService: processing error for ${conversationId}: ${err?.message}`);
      return {
        status: 'failed',
        conversation_id: conversationId,
        events_count: 0,
        event_ids: [],
        slack_delivered: false,
        escalation_created: false,
        error: err?.message,
      };
    }
  }
}
