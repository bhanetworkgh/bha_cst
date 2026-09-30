import { MessageEnvelope, EnvelopeResponse } from './envelope.js';
import { SpeakerIdentity } from './types.js';
import { CoreRegistry } from './registry.js';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';
import { StepUpAuthService } from '../identity/stepup.js';
import { IntentRouter, DetectedIntent } from '../router/index.js';
import { dashboardPublisher, CstDashboardPublisher } from '../publishers/dashboard.js';
import {
  CstTurnEventV1,
  CST_EVENT_SPEC_VERSION,
  AllowedTurnStatus,
  CustomerPayload,
} from '../contracts/events.js';
import { randomUUID } from 'crypto';

// Connectors
import { VfarmConnector } from '../connectors/vfarm.js';
import { BharagRagConnector } from '../connectors/bharag_rag.js';
import { BharagIncidentsConnector } from '../connectors/bharag_incidents.js';
import { MediaServerConnector } from '../connectors/media.js';

export class CoreEngine {
  private static customPublisher: CstDashboardPublisher | null = null;

  static setDashboardPublisher(publisher: CstDashboardPublisher | null): void {
    this.customPublisher = publisher;
  }

  static getDashboardPublisher(): CstDashboardPublisher {
    return this.customPublisher || dashboardPublisher;
  }

  /**
   * Helper to format and dispatch a canonical cst.turn event.
   * Fail-safe: Never throws or interrupts customer interaction flow.
   */
  private static publishTurn(params: {
    envelope: MessageEnvelope;
    speaker: SpeakerIdentity;
    status: AllowedTurnStatus;
    durationMs: number;
    intent?: string;
    replyText?: string;
    mediaUrl?: string;
    conversationId?: string;
    reason?: string;
    error?: string;
    incidentId?: string;
    metadata?: Record<string, unknown>;
  }): void {
    try {
      const {
        envelope,
        speaker,
        status,
        durationMs,
        intent,
        replyText,
        mediaUrl,
        conversationId,
        reason,
        error,
        incidentId,
        metadata,
      } = params;

      const customerRole = (['owner', 'manager', 'tech', 'unknown'].includes(speaker?.role as any)
        ? speaker.role
        : 'unknown') as 'owner' | 'manager' | 'tech' | 'unknown';

      const customer: CustomerPayload = {
        customer_ref: speaker?.customer_ref || envelope.speaker_ref || 'unknown_ref',
        phone_e164: speaker?.phone_e164 || envelope.speaker_ref || 'unknown',
        role: customerRole,
        is_known: Boolean(speaker?.is_known),
        tenant_id: envelope.tenant_id,
        project_id: envelope.project_id,
        person_id: speaker?.person_id,
        name: speaker?.customer_ref,
        farm_ids: speaker?.farm_ids,
      };

      const event: CstTurnEventV1 = {
        specversion: CST_EVENT_SPEC_VERSION,
        id: `turn_evt_${randomUUID()}`,
        source: `cst/${envelope.channel || 'core'}`,
        time: new Date().toISOString(),
        tenant_id: envelope.tenant_id,
        project_id: envelope.project_id,
        correlation_id: envelope.correlation_id,
        channel: envelope.channel,
        customer,
        type: 'cst.turn',
        data: {
          turn_id: envelope.correlation_id,
          conversation_id: conversationId,
          direction: 'inbound',
          channel: envelope.channel,
          status,
          intent,
          text: envelope.text,
          reply_text: replyText,
          reply: replyText,
          audio_url: mediaUrl,
          duration: {
            total_ms: durationMs,
          },
          duration_ms: durationMs,
          incident_id: incidentId,
          tenant_id: envelope.tenant_id,
          project_id: envelope.project_id,
          customer,
          reason,
          error,
          metadata: {
            ...envelope.metadata,
            ...metadata,
            conversation_id: conversationId,
            tenant_id: envelope.tenant_id,
            project_id: envelope.project_id,
            duration_ms: durationMs,
            incident_id: incidentId,
            intent,
            reason,
          },
        },
        metadata: {
          ...envelope.metadata,
          conversation_id: conversationId,
          duration_ms: durationMs,
          incident_id: incidentId,
        },
      };

      this.getDashboardPublisher().publishFireAndForget(event);
    } catch (err: any) {
      Logger.warn(`CoreEngine: Failed to publish turn event: ${err?.message ?? String(err)}`);
    }
  }

  /**
   * Process a uniform MessageEnvelope through the CST Core Engine pipeline.
   */
  static async processEnvelope(
    envelope: MessageEnvelope,
    speaker: SpeakerIdentity
  ): Promise<EnvelopeResponse> {
    const startTime = Date.now();
    let detectedIntent: string | undefined;
    let conversationId: string | undefined;

    try {
      const { tenant_id, project_id, channel, speaker_ref, text, correlation_id } = envelope;

      // Detect intent early so it is available across all exits including refusals and errors
      detectedIntent = IntentRouter.detectIntent(text);
      const lowerText = (text || '').toLowerCase();

      const tenant = CoreRegistry.getTenant(tenant_id);
      const project = CoreRegistry.getProject(project_id);

      if (!tenant || !project) {
        const errorMsg = `Tenant "${tenant_id}" or Project "${project_id}" not found`;
        const reason = `Invalid tenant (${tenant_id}) or project (${project_id})`;
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id,
          actor: speaker_ref,
          role: 'untrusted',
          entry_point: 'api',
          tool_or_route: 'CoreEngine.processEnvelope',
          outcome: 'refused',
          reason,
          correlation_id,
        });
        this.publishTurn({
          envelope,
          speaker,
          status: 'refused',
          durationMs: Date.now() - startTime,
          intent: detectedIntent,
          reason,
          error: errorMsg,
        });
        throw new Error(errorMsg);
      }

      // Check capability enabled
      if (!project.capabilities[channel]) {
        const reason = `Channel capability "${channel}" is disabled for project "${project_id}"`;
        const errorMsg = reason;
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id,
          actor: speaker_ref,
          role: speaker.role,
          entry_point: 'api',
          tool_or_route: 'CoreEngine.processEnvelope',
          outcome: 'refused',
          reason,
          correlation_id,
        });
        this.publishTurn({
          envelope,
          speaker,
          status: 'refused',
          durationMs: Date.now() - startTime,
          intent: detectedIntent,
          reason,
          error: errorMsg,
        });
        throw new Error(errorMsg);
      }

      const onboardingReply = project.onboarding_reply
        || 'Welcome! Contact support to link your account to active resources.';

      // Create or get conversation record stamped with tenant_id and project_id (§7)
      const convRecord = await DbClient.getOrCreateConversation(
        tenant_id,
        project_id,                               // systemId ← using project_id as system ref
        speaker.customer_ref || speaker_ref,
        tenant_id,                                // organizationId
        undefined,                                // workspaceId — deprecated, project_id is the scope
        project_id                                // projectId — the new critical field
      );
      conversationId = convRecord.conversation_id;

      // Persist inbound message to transcript — project_id scopes the transcript row
      await DbClient.addMessageToTranscript({
        message_id: correlation_id,
        conversation_id: conversationId,
        tenant_id,
        project_id,
        direction: 'inbound',
        from_e164: speaker.phone_e164,
        to_e164: (envelope.metadata?.service_number as string) || 'service_endpoint',
        body: text,
        media_refs: envelope.media,
        provider_sid: correlation_id,
      });

      Logger.info(`CoreEngine: Processing intent "${detectedIntent}" for speaker ${speaker.customer_ref} (tenant=${tenant_id}, project=${project_id}, role=${speaker.role})`, {
        tenant_id,
        project_id,
        conversation_id: conversationId,
        intent: detectedIntent,
        role: speaker.role,
        farm_ids: speaker.farm_ids,
      });

      // ── 1. UNKNOWN SPEAKER GATE (R-ID-7) (Onboarding) ─────────────────────────
      if (!speaker.is_known) {
        const reason = 'Unknown speaker served safe generic onboarding response (zero farm data)';
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id,
          actor: speaker.customer_ref,
          role: 'unknown_user',
          entry_point: 'api',
          tool_or_route: 'CoreEngine.processEnvelope',
          outcome: 'ok',
          reason,
          correlation_id,
        });

        const durationMs = Date.now() - startTime;
        const res: EnvelopeResponse = {
          reply_text: onboardingReply,
          reply: onboardingReply,
          correlation_id,
          channel,
          tenant_id,
          project_id,
          speaker_ref,
          conversation_id: conversationId,
          intent: detectedIntent,
          reason,
          duration_ms: durationMs,
        };

        this.publishTurn({
          envelope,
          speaker,
          status: 'onboarding',
          durationMs,
          intent: detectedIntent,
          replyText: onboardingReply,
          conversationId,
          reason,
          metadata: { onboarding: true },
        });

        return res;
      }

      // ── 2. ROLE PERMISSION BOUNDARY CHECKS ───────────────────────────────────

      // User/role management attempts via communication rail
      if (this.isUserManagementAttempt(lowerText)) {
        const reason = `User management attempt via ${channel} refused for role ${speaker.role}`;
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id,
          actor: speaker.customer_ref,
          role: speaker.role,
          entry_point: 'api',
          tool_or_route: 'CoreEngine.processEnvelope',
          outcome: 'refused',
          reason,
          correlation_id,
        });

        const durationMs = Date.now() - startTime;
        const res: EnvelopeResponse = {
          reply_text: 'User and role management operations are restricted to the Organization Admin Panel.',
          reply: 'User and role management operations are restricted to the Organization Admin Panel.',
          correlation_id,
          channel,
          tenant_id,
          project_id,
          speaker_ref,
          conversation_id: conversationId,
          status: 'refused',
          intent: detectedIntent,
          reason,
          duration_ms: durationMs,
        };

        this.publishTurn({
          envelope,
          speaker,
          status: 'refused',
          durationMs,
          intent: detectedIntent,
          replyText: res.reply_text,
          conversationId,
          reason,
        });

        return res;
      }

      // Tech Role attempting Control Actions
      if (speaker.role === 'tech' && this.isControlAttempt(lowerText)) {
        const reason = 'Tech role is not authorized to execute equipment control operations';
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id,
          actor: speaker.customer_ref,
          role: speaker.role,
          entry_point: 'api',
          tool_or_route: 'CoreEngine.processEnvelope',
          outcome: 'refused',
          reason,
          correlation_id,
        });

        const durationMs = Date.now() - startTime;
        const res: EnvelopeResponse = {
          reply_text: "Role 'tech' is not authorized to execute control operations. Please contact a project manager or owner.",
          reply: "Role 'tech' is not authorized to execute control operations. Please contact a project manager or owner.",
          correlation_id,
          channel,
          tenant_id,
          project_id,
          speaker_ref,
          conversation_id: conversationId,
          status: 'refused',
          intent: detectedIntent,
          reason,
          duration_ms: durationMs,
        };

        this.publishTurn({
          envelope,
          speaker,
          status: 'refused',
          durationMs,
          intent: detectedIntent,
          replyText: res.reply_text,
          conversationId,
          reason,
        });

        return res;
      }

      // ── 3. STEP-UP AUTHENTICATION SEAM ───────────────────────────────────────
      if (StepUpAuthService.isSensitiveAction(text, detectedIntent)) {
        const stepUpResult = StepUpAuthService.verifyStepUp({
          customer_ref: speaker.customer_ref,
          organization_id: tenant_id,
          tenant_id,
          system_id: project_id,
          workspace_id: project_id,
          is_known_customer: true,
          role: speaker.role,
          permissions: speaker.permissions,
        });
        if (!stepUpResult.verified) {
          const reason = 'Sensitive operations require step-up authentication';
          const durationMs = Date.now() - startTime;
          const res: EnvelopeResponse = {
            reply_text: stepUpResult.message || 'Sensitive operations require step-up authentication.',
            reply: stepUpResult.message || 'Sensitive operations require step-up authentication.',
            correlation_id,
            channel,
            tenant_id,
            project_id,
            speaker_ref,
            conversation_id: conversationId,
            status: 'step_up_required',
            intent: detectedIntent,
            reason,
            duration_ms: durationMs,
          };

          this.publishTurn({
            envelope,
            speaker,
            status: 'step_up',
            durationMs,
            intent: detectedIntent,
            replyText: res.reply_text,
            conversationId,
            reason,
            metadata: { step_up_required: true },
          });

          return res;
        }
      }

      // ── 4. FARM / RESOURCE SCOPE AUTHORIZATION (R-ID-3, R-ID-4, R-ID-5) ─────
      const grantedFarmIds = speaker.farm_ids || [];

      if (detectedIntent === 'status' || detectedIntent === 'images') {
        if (grantedFarmIds.length === 0) {
          const reason = 'Status/media query refused: speaker is not granted any active farm resources';
          Logger.audit({
            timestamp: new Date().toISOString(),
            tenant_id,
            actor: speaker.customer_ref,
            role: speaker.role,
            entry_point: 'api',
            tool_or_route: 'CoreEngine.processEnvelope',
            outcome: 'refused',
            reason,
            correlation_id,
          });

          const durationMs = Date.now() - startTime;
          const res: EnvelopeResponse = {
            reply_text: 'Your account is not linked to any active farm resources in this project. Please contact support.',
            reply: 'Your account is not linked to any active farm resources in this project. Please contact support.',
            correlation_id,
            channel,
            tenant_id,
            project_id,
            speaker_ref,
            conversation_id: conversationId,
            status: 'refused',
            intent: detectedIntent,
            reason,
            duration_ms: durationMs,
          };

          this.publishTurn({
            envelope,
            speaker,
            status: 'refused',
            durationMs,
            intent: detectedIntent,
            replyText: res.reply_text,
            conversationId,
            reason,
          });

          return res;
        }

        // Check if message explicitly mentions an out-of-scope farm (R-ID-5)
        const outOfScopeFarmMention = this.detectOutOfScopeFarmMention(lowerText, grantedFarmIds);
        if (outOfScopeFarmMention) {
          const reason = `Out-of-scope farm mention "${outOfScopeFarmMention}" refused; granted farms are [${grantedFarmIds.join(', ')}]`;
          Logger.audit({
            timestamp: new Date().toISOString(),
            tenant_id,
            actor: speaker.customer_ref,
            role: speaker.role,
            entry_point: 'api',
            tool_or_route: 'CoreEngine.processEnvelope',
            outcome: 'refused',
            reason,
            correlation_id,
          });

          const durationMs = Date.now() - startTime;
          const res: EnvelopeResponse = {
            reply_text: `You do not have access to queries for ${outOfScopeFarmMention}. Queries are restricted to your assigned farms: ${grantedFarmIds.join(', ')}.`,
            reply: `You do not have access to queries for ${outOfScopeFarmMention}. Queries are restricted to your assigned farms: ${grantedFarmIds.join(', ')}.`,
            correlation_id,
            channel,
            tenant_id,
            project_id,
            speaker_ref,
            conversation_id: conversationId,
            status: 'refused',
            intent: detectedIntent,
            reason,
            duration_ms: durationMs,
          };

          this.publishTurn({
            envelope,
            speaker,
            status: 'refused',
            durationMs,
            intent: detectedIntent,
            replyText: res.reply_text,
            conversationId,
            reason,
          });

          return res;
        }
      }

      // Verified resource context
      const primaryFarmId = grantedFarmIds[0] || process.env.VFARM_DEFAULT_FARM_ID || 'farm_default';
      const boundUnitId = (speaker.unit_context?.unit_id as string) || process.env.VFARM_DEFAULT_UNIT_ID || primaryFarmId;
      const verifiedUnitContext = {
        farm_id: primaryFarmId,
        unit_id: boundUnitId,
        role: speaker.role,
        granted_farms: grantedFarmIds,
      };

      let replyText: string;
      let mediaUrl: string | undefined;

      // ── 5. CONNECTOR DISPATCH ────────────────────────────────────────────────
      if (detectedIntent === 'status') {
        const statusRes = await VfarmConnector.getUnitStatus(
          speaker.customer_ref,
          verifiedUnitContext,
          undefined,
          text,
          speaker,
        );
        replyText = statusRes?.text || `Farm ${primaryFarmId} (Unit ${boundUnitId}): Telemetry currently normal.`;
      } else {
        replyText = await BharagRagConnector.askKnowledge(
          text,
          undefined,
          verifiedUnitContext
        );
      }

      // Incidents (escalate intent)
      let incidentId: string | undefined;
      if (detectedIntent === 'escalate') {
        const incidentRes = await BharagIncidentsConnector.fileIncident({
          customerRef: speaker.customer_ref,
          conversationId: conversationId,
          summary: `Customer escalation [tenant=${tenant_id}, project=${project_id}]: "${text}"`,
          priority: 'high',
          unitContext: verifiedUnitContext,
        });
        incidentId = incidentRes.incident_id;
        Logger.info(`Incident filed: ${incidentRes.incident_id} for conversation ${conversationId}`);
      }

      // Media Server (images intent)
      if (detectedIntent === 'images') {
        mediaUrl = await MediaServerConnector.getSignedMediaUrl(boundUnitId);
        Logger.info(`Media Server: Fetched signed URL for unit ${boundUnitId}: ${mediaUrl}`);
      }

      const durationMs = Date.now() - startTime;
      const successReason = `Intent "${detectedIntent}" successfully processed for project "${project_id}" (farms=[${grantedFarmIds.join(', ')}])`;

      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id,
        actor: speaker.customer_ref,
        role: speaker.role,
        entry_point: 'api',
        tool_or_route: 'CoreEngine.processEnvelope',
        outcome: 'ok',
        reason: successReason,
        correlation_id,
      });

      const res: EnvelopeResponse = {
        reply_text: replyText,
        reply: replyText,
        media_url: mediaUrl,
        correlation_id,
        channel,
        tenant_id,
        project_id,
        speaker_ref,
        conversation_id: conversationId,
        status: 'ok',
        intent: detectedIntent,
        reason: successReason,
        incident_id: incidentId,
        duration_ms: durationMs,
        metadata: {
          conversation_id: conversationId,
          intent: detectedIntent,
          farm_ids: grantedFarmIds,
          incident_id: incidentId,
          duration_ms: durationMs,
        },
      };

      this.publishTurn({
        envelope,
        speaker,
        status: 'completed',
        durationMs,
        intent: detectedIntent,
        replyText,
        mediaUrl,
        conversationId,
        incidentId,
        reason: successReason,
        metadata: res.metadata,
      });

      return res;
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isAlreadyPublished =
        (msg.includes('Tenant') && msg.includes('not found')) ||
        (msg.includes('Capability') && msg.includes('not enabled'));

      if (!isAlreadyPublished) {
        this.publishTurn({
          envelope,
          speaker,
          status: 'failed',
          durationMs: Date.now() - startTime,
          intent: detectedIntent,
          conversationId,
          error: msg,
          reason: msg,
        });
      }
      throw err;
    }
  }

  private static isUserManagementAttempt(text: string): boolean {
    const keywords = ['grant role', 'change role', 'add user', 'set permission', 'promote user', 'demote user', 'make owner', 'make admin'];
    return keywords.some((kw) => text.includes(kw));
  }

  private static isControlAttempt(text: string): boolean {
    const keywords = ['turn off', 'turn on', 'pump off', 'valve open', 'setpoint', 'override', 'reboot', 'reset'];
    return keywords.some((kw) => text.includes(kw));
  }

  private static detectOutOfScopeFarmMention(text: string, grantedFarms: string[]): string | null {
    const adapter = CoreRegistry.getVfarmAdapter();
    const allKnownFarmIds = new Set<string>();

    adapter?.getDiscoveredFarmIds().forEach((id) => allKnownFarmIds.add(id));

    const projects = CoreRegistry.getProjectsForTenant('tenant-vfarm-01');
    for (const p of projects) {
      if (p.project_id === 'proj-vfarm-dallas') allKnownFarmIds.add('farm_dallas_north');
      if (p.project_id === 'proj-vfarm-main') {
        allKnownFarmIds.add('farm_austin_main');
        allKnownFarmIds.add('farm_austin_east');
      }
    }

    for (const farmId of allKnownFarmIds) {
      if (grantedFarms.includes(farmId)) continue;

      const normalized = farmId.replace(/[-_]/g, ' ').toLowerCase();
      const words = normalized.split(/\s+/).filter((w) => w.length >= 4 && w !== 'farm');
      for (const word of words) {
        if (text.toLowerCase().includes(word)) {
          return farmId;
        }
      }
    }
    return null;
  }
}
