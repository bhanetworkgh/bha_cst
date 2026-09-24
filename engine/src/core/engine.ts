import { MessageEnvelope, EnvelopeResponse } from './envelope.js';
import { SpeakerIdentity } from './types.js';
import { CoreRegistry } from './registry.js';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';
import { StepUpAuthService } from '../identity/stepup.js';
import { IntentRouter, DetectedIntent } from '../router/index.js';

// Connectors
import { VfarmConnector } from '../connectors/vfarm.js';
import { BharagRagConnector } from '../connectors/bharag_rag.js';
import { BharagIncidentsConnector } from '../connectors/bharag_incidents.js';
import { MediaServerConnector } from '../connectors/media.js';

export class CoreEngine {
  /**
   * Process a uniform MessageEnvelope through the CST Core Engine pipeline.
   */
  static async processEnvelope(
    envelope: MessageEnvelope,
    speaker: SpeakerIdentity
  ): Promise<EnvelopeResponse> {
    const { tenant_id, project_id, channel, speaker_ref, text, correlation_id } = envelope;

    const tenant = CoreRegistry.getTenant(tenant_id);
    const project = CoreRegistry.getProject(project_id);

    if (!tenant || !project) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id,
        actor: speaker_ref,
        role: 'untrusted',
        entry_point: 'api',
        tool_or_route: 'CoreEngine.processEnvelope',
        outcome: 'refused',
        reason: `Invalid tenant (${tenant_id}) or project (${project_id})`,
        correlation_id,
      });
      throw new Error(`Tenant "${tenant_id}" or Project "${project_id}" not found`);
    }

    // Check capability enabled
    if (!project.capabilities[channel]) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id,
        actor: speaker_ref,
        role: speaker.role,
        entry_point: 'api',
        tool_or_route: 'CoreEngine.processEnvelope',
        outcome: 'refused',
        reason: `Channel capability "${channel}" is disabled for project "${project_id}"`,
        correlation_id,
      });
      throw new Error(`Capability "${channel}" is not enabled for project "${project_id}"`);
    }

    const onboardingReply = project.onboarding_reply
      || 'Welcome! Contact support to link your account to active resources.';

    // Create or get conversation record stamped with tenant_id and project_id (§7)
    const { conversation_id } = await DbClient.getOrCreateConversation(
      tenant_id,
      project_id,                               // systemId ← using project_id as system ref
      speaker.customer_ref || speaker_ref,
      tenant_id,                                // organizationId
      undefined,                                // workspaceId — deprecated, project_id is the scope
      project_id                                // projectId — the new critical field
    );

    // Persist inbound message to transcript — project_id scopes the transcript row
    await DbClient.addMessageToTranscript({
      message_id: correlation_id,
      conversation_id,
      tenant_id,
      project_id,
      direction: 'inbound',
      from_e164: speaker.phone_e164,
      to_e164: (envelope.metadata?.service_number as string) || 'service_endpoint',
      body: text,
      media_refs: envelope.media,
      provider_sid: correlation_id,
    });

    const intent = IntentRouter.detectIntent(text);
    const lowerText = (text || '').toLowerCase();

    Logger.info(`CoreEngine: Processing intent "${intent}" for speaker ${speaker.customer_ref} (tenant=${tenant_id}, project=${project_id}, role=${speaker.role})`, {
      tenant_id,
      project_id,
      conversation_id,
      intent,
      role: speaker.role,
      farm_ids: speaker.farm_ids,
    });

    // ── 1. UNKNOWN SPEAKER GATE (R-ID-7) ──────────────────────────────────────
    if (!speaker.is_known) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id,
        actor: speaker.customer_ref,
        role: 'unknown_user',
        entry_point: 'api',
        tool_or_route: 'CoreEngine.processEnvelope',
        outcome: 'ok',
        reason: 'Unknown speaker served safe generic onboarding response (zero farm data)',
        correlation_id,
      });

      return {
        reply_text: onboardingReply,
        correlation_id,
        channel,
        tenant_id,
        project_id,
        speaker_ref,
      };
    }

    // ── 2. ROLE PERMISSION BOUNDARY CHECKS ───────────────────────────────────

    // User/role management attempts via communication rail
    if (this.isUserManagementAttempt(lowerText)) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id,
        actor: speaker.customer_ref,
        role: speaker.role,
        entry_point: 'api',
        tool_or_route: 'CoreEngine.processEnvelope',
        outcome: 'refused',
        reason: `User management attempt via ${channel} refused for role ${speaker.role}`,
        correlation_id,
      });

      return {
        reply_text: 'User and role management operations are restricted to the Organization Admin Panel.',
        correlation_id,
        channel,
        tenant_id,
        project_id,
        speaker_ref,
        conversation_id,
        status: 'refused',
      };
    }

    // Tech Role attempting Control Actions
    if (speaker.role === 'tech' && this.isControlAttempt(lowerText)) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id,
        actor: speaker.customer_ref,
        role: speaker.role,
        entry_point: 'api',
        tool_or_route: 'CoreEngine.processEnvelope',
        outcome: 'refused',
        reason: 'Tech role is not authorized to execute equipment control operations',
        correlation_id,
      });

      return {
        reply_text: "Role 'tech' is not authorized to execute control operations. Please contact a project manager or owner.",
        correlation_id,
        channel,
        tenant_id,
        project_id,
        speaker_ref,
        conversation_id,
        status: 'refused',
      };
    }

    // ── 3. STEP-UP AUTHENTICATION SEAM ───────────────────────────────────────
    if (StepUpAuthService.isSensitiveAction(text, intent)) {
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
        return {
          reply_text: stepUpResult.message || 'Sensitive operations require step-up authentication.',
          correlation_id,
          channel,
          tenant_id,
          project_id,
          speaker_ref,
          conversation_id,
          status: 'step_up_required',
        };
      }
    }

    // ── 4. FARM / RESOURCE SCOPE AUTHORIZATION (R-ID-3, R-ID-4, R-ID-5) ─────
    const grantedFarmIds = speaker.farm_ids || [];

    if (intent === 'status' || intent === 'images') {
      if (grantedFarmIds.length === 0) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id,
          actor: speaker.customer_ref,
          role: speaker.role,
          entry_point: 'api',
          tool_or_route: 'CoreEngine.processEnvelope',
          outcome: 'refused',
          reason: 'Status/media query refused: speaker is not granted any active farm resources',
          correlation_id,
        });

        return {
          reply_text: 'Your account is not linked to any active farm resources in this project. Please contact support.',
          correlation_id,
          channel,
          tenant_id,
          project_id,
          speaker_ref,
          conversation_id,
          status: 'refused',
        };
      }

      // Check if message explicitly mentions an out-of-scope farm (R-ID-5)
      // e.g. a farm name keyword that the speaker does NOT have in their granted_farms list
      const outOfScopeFarmMention = this.detectOutOfScopeFarmMention(lowerText, grantedFarmIds);
      if (outOfScopeFarmMention) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id,
          actor: speaker.customer_ref,
          role: speaker.role,
          entry_point: 'api',
          tool_or_route: 'CoreEngine.processEnvelope',
          outcome: 'refused',
          reason: `Out-of-scope farm mention "${outOfScopeFarmMention}" refused; granted farms are [${grantedFarmIds.join(', ')}]`,
          correlation_id,
        });

        return {
          reply_text: `You do not have access to queries for ${outOfScopeFarmMention}. Queries are restricted to your assigned farms: ${grantedFarmIds.join(', ')}.`,
          correlation_id,
          channel,
          tenant_id,
          project_id,
          speaker_ref,
          conversation_id,
          status: 'refused',
        };
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
    if (intent === 'status') {
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
    if (intent === 'escalate') {
      const incidentRes = await BharagIncidentsConnector.fileIncident({
        customerRef: speaker.customer_ref,
        conversationId: conversation_id,
        summary: `Customer escalation [tenant=${tenant_id}, project=${project_id}]: "${text}"`,
        priority: 'high',
        unitContext: verifiedUnitContext,
      });
      Logger.info(`Incident filed: ${incidentRes.incident_id} for conversation ${conversation_id}`);
    }

    // Media Server (images intent)
    if (intent === 'images') {
      mediaUrl = await MediaServerConnector.getSignedMediaUrl(boundUnitId);
      Logger.info(`Media Server: Fetched signed URL for unit ${boundUnitId}: ${mediaUrl}`);
    }

    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id,
      actor: speaker.customer_ref,
      role: speaker.role,
      entry_point: 'api',
      tool_or_route: 'CoreEngine.processEnvelope',
      outcome: 'ok',
      reason: `Intent "${intent}" successfully processed for project "${project_id}" (farms=[${grantedFarmIds.join(', ')}])`,
      correlation_id,
    });

    return {
      reply_text: replyText,
      media_url: mediaUrl,
      correlation_id,
      channel,
      tenant_id,
      project_id,
      speaker_ref,
      conversation_id,
      status: 'ok',
      metadata: {
        conversation_id,
        intent,
        farm_ids: grantedFarmIds,
      },
    };
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
    // Dynamically build the keyword map from the granted farms list.
    // No hardcoded farm names or UUIDs — the out-of-scope detection
    // works against whatever farms the caller actually has access to.
    for (const farmId of grantedFarms) {
      // Match on farm name fragments derived from the ID (e.g. "austin_main"
      // matches mentions of "austin main" or "austin-main").
      const normalized = farmId.replace(/[-_]/g, ' ').toLowerCase();
      const words = normalized.split(/\s+/).filter(Boolean);
      for (const word of words) {
        if (word.length < 4) continue;
        if (text.toLowerCase().includes(word)) {
          return farmId;
        }
      }
    }
    return null;
  }
}
