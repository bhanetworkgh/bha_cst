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
import { CallLogPoster, collected } from '../../notifications/call_log.js';
import { FailureDetector } from '../../observability/failure_detector.js';
import { CutOverManager } from '../../observability/cut_over.js';
import { getDashboardPublisher } from '../../publishers/dashboard.js';
import { currentRelayTrace, traceId, traceRelay } from '../../observability/relay_trace.js';

export interface WebhookProcessResult {
  status: 'processed' | 'already_processed' | 'ignored_pre_cutover' | 'failed';
  conversation_id: string;
  events_count: number;
  event_ids: string[];
  slack_delivered: boolean;
  escalation_created: boolean;
  escalation_id?: string;
  /** True only once the dashboard accepted this call's cst.turn. */
  dashboard_published?: boolean;
  dashboard_error?: string;
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
        const bodyCandidates = Array.from(new Set([
          (req as any).rawBody,
          rawBody,
          typeof req.body === 'string' ? req.body : undefined,
          req.body ? JSON.stringify(req.body) : undefined,
        ].filter((c): c is string => typeof c === 'string' && c.length > 0)));

        const secretsToTry = [secret];
        if (secret.startsWith('wsec_')) {
          secretsToTry.push(secret.slice(5));
        }

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
              for (const sec of secretsToTry) {
                for (const bodyCandidate of bodyCandidates) {
                  const signedPayload = `${timestamp}.${bodyCandidate}`;
                  const expectedHmac = createHmac('sha256', sec).update(signedPayload).digest('hex');
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
          }
        }

        // Case B: Direct HMAC or "sha256=<hex>" format (used in tests and fallback)
        const signature = sigHeader.startsWith('sha256=') ? sigHeader.slice(7) : sigHeader;
        for (const sec of secretsToTry) {
          for (const bodyCandidate of bodyCandidates) {
            const expectedHmac = createHmac('sha256', sec).update(bodyCandidate).digest('hex');
            if (signature.length === expectedHmac.length) {
              const match = timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedHmac, 'utf8'));
              if (match) {
                FailureDetector.recordWebhookAuthSuccess();
                return true;
              }
            }
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

    const d = payload.data;
    const conversationId = String(payload.conversation_id || payload.call_id || d?.conversation_id || d?.call_id);
    const trace = currentRelayTrace();
    if (trace) {
      trace.provider_conversation_id = traceId(conversationId);
      const phone = (d?.metadata || payload.metadata || {}) as Record<string, any>;
      trace.provider_call_sid = traceId(phone.phone_call?.call_sid);
      traceRelay('provider_link');
    }
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
    const startUnix = payload.start_time_unix_secs || d?.start_time_unix_secs || payload.event_timestamp || Math.floor(Date.now() / 1000);
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
    const agentId = payload.agent_id || d?.agent_id;
    const metadata = (d?.metadata || payload.metadata || {}) as Record<string, any>;
    const analysis = (d?.analysis || payload.analysis || {}) as Record<string, any>;
    const customVars = (metadata.custom_variables || {}) as Record<string, any>;
    const tenantId = String(customVars.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01');
    const projectId = String(customVars.project_id || 'proj-vfarm-main');
    const phoneCall = (metadata.phone_call || {}) as Record<string, any>;
    // Preserve source precedence, but never fabricate or coerce a caller identity.
    // WhatsApp (8 Nov 2026): the sender comes as metadata.whatsapp.whatsapp_user_id,
    // digits with the country code and no '+'.
    const whatsappMeta = (metadata.whatsapp || {}) as Record<string, any>;
    const isWhatsApp = metadata.conversation_initiation_source === 'whatsapp' || !!metadata.whatsapp;
    const whatsappUser = String(whatsappMeta.whatsapp_user_id || whatsappMeta.recipient?.phone || '').replace(/\D/g, '');
    const suppliedPhone = [customVars.caller_phone, phoneCall.external_number, metadata.caller_id, whatsappUser ? `+${whatsappUser}` : undefined]
      .find((value) => value !== undefined && value !== null && value !== '');
    const callerPhone = typeof suppliedPhone === 'string' ? suppliedPhone.trim() : '';
    if (!/^\+[1-9]\d{1,14}$/.test(callerPhone)) {
      const error = suppliedPhone === undefined ? 'CALLER_IDENTITY_MISSING' : 'CALLER_IDENTITY_INVALID';
      FailureDetector.recordWebhookProcessingFailure(error);
      Logger.warn(`ElevenLabsWebhookService: ${error}`);
      return {
        status: 'failed',
        conversation_id: conversationId,
        events_count: 0,
        event_ids: [],
        slack_delivered: false,
        escalation_created: false,
        error,
      };
    }
    // A WhatsApp call (not a chat) carries metadata.whatsapp.call_result, and its
    // conversation is not text-only (seen live 8 Nov 2026).
    const isWhatsAppCall = isWhatsApp && (!!whatsappMeta.call_result || metadata.text_only === false);
    const rawChannel = String(customVars.channel || (isWhatsApp ? 'whatsapp' : 'voice')).toLowerCase();
    const channel: AllowedChannel = rawChannel === 'whatsapp' ? 'whatsapp' : 'voice';

    // Tool turns carry no text; only spoken lines go on.
    const transcriptList = ((payload.transcript || payload.message_history || d?.transcript || d?.message_history || []) as ElevenLabsTranscriptMessage[])
      .filter((m): m is ElevenLabsTranscriptMessage & { message: string } => typeof m.message === 'string' && m.message.trim() !== '');
    const dataCollection = (analysis.data_collection_results || {}) as Record<string, any>;
    // CST Genie collects caller_name and caller_email (8 Nov 2026); the older
    // customer_* names are still read so earlier reports keep working.
    const customerName = collected(dataCollection, 'caller_name', 'customer_name') as string | undefined;
    const customerEmail = collected(dataCollection, 'caller_email', 'customer_email') as string | undefined;
    const durationSecs = Number(payload.call_duration_secs ?? d?.call_duration_secs ?? metadata.call_duration_secs ?? 0);
    const summary = typeof analysis.transcript_summary === 'string' ? analysis.transcript_summary : undefined;

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
      if (startUnix) {
        const startIso = new Date(startUnix * 1000).toISOString();
        const startEventId = `evt_start_${randomUUID()}`;
        const startEvent = createCstInteractionStartEventV1({
          id: startEventId,
          source: channel === 'whatsapp' ? 'cst/whatsapp/elevenlabs' : 'cst/voice/elevenlabs',
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
            metadata: { agent_id: agentId },
          },
        });
        generatedEvents.push(startEvent);
        eventIds.push(startEventId);
      }

      // 4B. Normalize Transcript Event
      const transcriptMessages = transcriptList.map((m) => ({
        role: (m.role === 'agent' || m.role === 'assistant' ? 'agent' : m.role === 'system' ? 'system' : 'user') as 'user' | 'agent' | 'system',
        message: m.message,
        time_in_call_secs: m.time_in_call_secs,
        timestamp: nowIso,
      }));

      const transcriptEventId = `evt_trsc_${randomUUID()}`;
      const transcriptEvent = createCstTranscriptEventV1({
        id: transcriptEventId,
        source: channel === 'whatsapp' ? 'cst/whatsapp/elevenlabs' : 'cst/voice/elevenlabs',
        time: nowIso,
        tenant_id: tenantId,
        project_id: projectId,
        correlation_id: conversationId,
        channel,
        customer: customerPayload,
        transcript: {
          interaction_id: conversationId,
          channel,
          duration_secs: durationSecs,
          messages: transcriptMessages,
          summary: summary,
          metadata: { agent_id: agentId },
        },
      });
      generatedEvents.push(transcriptEvent);
      eventIds.push(transcriptEventId);

      // 4C. Normalize Outcome Event
      const isCallSuccess = analysis.call_successful === true || analysis.call_successful === 'success';
      const outcomeEventId = `evt_outc_${randomUUID()}`;
      const outcomeEvent = createCstOutcomeEventV1({
        id: outcomeEventId,
        source: channel === 'whatsapp' ? 'cst/whatsapp/elevenlabs' : 'cst/voice/elevenlabs',
        time: nowIso,
        tenant_id: tenantId,
        project_id: projectId,
        correlation_id: conversationId,
        channel,
        customer: customerPayload,
        outcome: {
          interaction_id: conversationId,
          status: isCallSuccess ? 'resolved' : 'transferred',
          summary: summary || 'Call completed',
          duration_secs: durationSecs,
          evaluation_criteria_results: analysis.evaluation_criteria_results as Record<string, unknown> | undefined,
          data_collected: analysis.data_collection_results as Record<string, unknown> | undefined,
        },
      });
      generatedEvents.push(outcomeEvent);
      eventIds.push(outcomeEventId);

      // 4D. Detect Escalation & Normalize Escalation Event
      const evalResults = (analysis.evaluation_criteria_results || {}) as Record<string, any>;
      // The caller asked for a person when CST Genie's own analysis says so.
      // The old word match ("agent", "human" and so on) flagged ordinary calls,
      // and the live handoff now goes through CST Genie's request_person tool.
      const wantedPerson = collected(dataCollection, 'wanted_person');
      const escalationRequested =
        wantedPerson === true || String(wantedPerson).toLowerCase() === 'true' ||
        evalResults.escalation_requested === true ||
        evalResults.human_handoff === true ||
        evalResults.escalate === true;

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
            reason: summary || 'Customer requested human follow-up',
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
            reason: summary || 'Customer requested human follow-up',
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

      // 5. Durable Event Persistence (dashboard_publish_outcomes).
      // These four are CST's own record: the dashboard takes cst.turn and
      // cst.delivery only, so they are never sent and are not marked published.
      // What reaches the dashboard is the one cst.turn built below.
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
            status: 'internal_only',
            attempts: 0,
            payload: event as any,
          });
        } catch (dbErr: any) {
          FailureDetector.recordWebhookPersistenceFailure(dbErr.message);
          Logger.warn(`ElevenLabsWebhookService: could not persist event ${event.id}: ${dbErr.message}`);
        }
      }

      // 5b. The call on the dashboard: one cst.turn, awaited, read from the
      // publisher's own answer. Its outcome row says what really happened, and a
      // failure is replayed at boot. It never fails the webhook.
      const spoken = (who: 'user' | 'agent') =>
        transcriptMessages.filter((m) => m.role === who).map((m) => m.message).join('\n');
      const turnCustomer: CustomerPayload = { ...customerPayload, role: 'unknown', is_known: false };
      const callTime = startUnix ? new Date(startUnix * 1000).toISOString() : nowIso;
      const turnEvent = {
        specversion: 'cst.event.v1',
        id: `turn_evt_${randomUUID()}`,
        source: channel === 'whatsapp' ? 'cst/whatsapp/elevenlabs' : 'cst/voice/elevenlabs',
        time: callTime,
        tenant_id: tenantId,
        project_id: projectId,
        correlation_id: conversationId,
        channel,
        customer: turnCustomer,
        type: 'cst.turn',
        data: {
          turn_id: conversationId,
          conversation_id: conversationId,
          direction: 'inbound',
          channel,
          status: 'ok',
          intent: escalationRequested ? 'escalate' : 'default',
          text: spoken('user'),
          message: spoken('user'),
          reply_text: spoken('agent'),
          reply: spoken('agent'),
          duration: { total_ms: durationSecs * 1000 },
          duration_ms: durationSecs * 1000,
          incident_id: escalationId,
          tenant_id: tenantId,
          project_id: projectId,
          customer: turnCustomer,
          event_type: 'cst.turn',
          occurred_at: callTime,
          metadata: { agent_id: agentId, summary, call_successful: analysis.call_successful, source: 'elevenlabs_post_call' },
        },
      } as unknown as CstEventV1;
      const publishResult = await getDashboardPublisher().publish(turnEvent);
      if (!publishResult.success) {
        FailureDetector.recordWebhookProcessingFailure(`dashboard publish failed: ${publishResult.error}`);
        Logger.error(`ElevenLabsWebhookService: call ${conversationId} did not reach the dashboard: ${publishResult.error}`);
      }

      // 6. Call log in #bha-customer-service-twin from the CS Twin app: a Block
      // Kit card with the summary and checks, transcript as a file in the
      // thread. A failed post is reported to CST ops, never to this channel.
      // WhatsApp (8 Nov 2026, Destiny): a WhatsApp conversation is posted only
      // when the customer confirmed they were done and CST Genie closed it
      // (end_call). One that just went quiet still reaches the dashboard above.
      // A WhatsApp call always gets its card, like a phone call: a caller who
      // hangs up has ended it.
      const terminationReason = typeof metadata.termination_reason === 'string' ? metadata.termination_reason : '';
      if (channel === 'whatsapp' && !isWhatsAppCall && !/end_call/i.test(terminationReason)) {
        Logger.info(`ElevenLabsWebhookService: WhatsApp conversation ${conversationId} closed without the customer confirming (${terminationReason || 'no reason'}); dashboard only, no Slack card`);
        this.processedIdempotencyKeys.add(idempotencyKey);
        FailureDetector.recordWebhookProcessingSuccess();
        return {
          status: 'processed',
          conversation_id: conversationId,
          events_count: generatedEvents.length,
          event_ids: eventIds,
          slack_delivered: false,
          escalation_created: escalationCreated,
          escalation_id: escalationId,
          dashboard_published: publishResult.success && !publishResult.dryRun,
          dashboard_error: publishResult.success ? undefined : publishResult.error,
        };
      }
      const callLog = await CallLogPoster.post({
        channel: channel === 'whatsapp' ? 'whatsapp' : 'voice',
        whatsapp_call: isWhatsAppCall,
        conversation_id: conversationId,
        caller_phone: callerPhone,
        started_unix: startUnix,
        duration_secs: durationSecs,
        summary,
        lines: transcriptMessages.map((m) => ({ role: m.role, message: m.message, time_in_call_secs: m.time_in_call_secs })),
        data_collection: dataCollection,
        evaluation: evalResults,
        termination_reason: typeof metadata.termination_reason === 'string' ? metadata.termination_reason : undefined,
        call_sid: typeof phoneCall.call_sid === 'string' ? phoneCall.call_sid : undefined,
      });
      const slackDelivered = callLog.posted;
      if (callLog.posted && !callLog.error) {
        FailureDetector.recordSlackSuccess();
      } else {
        FailureDetector.recordSlackFailure(callLog.error);
        Logger.error(`ElevenLabsWebhookService: call log for ${conversationId} ${callLog.posted ? 'posted without a transcript file' : 'did not post'}: ${callLog.error}`);
        await ErrorRouter.route({
          service: 'CST',
          category: 'call_log',
          message: callLog.posted
            ? `CST Genie call log for ${conversationId} posted, but the transcript ${callLog.transcript === 'thread_text' ? 'went in as text because the file upload was refused' : 'did not post'}: ${callLog.error}`
            : `CST Genie call log for ${conversationId} did not reach the customer service channel: ${callLog.error}`,
          severity: callLog.posted ? 'WARN' : 'ERROR',
          tenant_id: tenantId,
          project_id: projectId,
          correlation_id: conversationId,
          timestamp: nowIso,
          meta: { interaction_id: conversationId, via: callLog.via, transcript: callLog.transcript, duration_secs: durationSecs },
        });
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
        dashboard_published: publishResult.success && !publishResult.dryRun,
        dashboard_error: publishResult.success ? undefined : publishResult.error,
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
