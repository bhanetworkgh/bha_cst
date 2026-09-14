import { InboundMessage, IdentityContext, OutboundMessage, SystemConfig } from '../transport/twilio/types.js';
import { SystemsRegistry } from '../systems/registry.js';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';
import { StepUpAuthService } from '../identity/stepup.js';

// ── Source Connectors ──────────────────────────────────────────────────────────
import { VfarmConnector }           from '../connectors/vfarm.js';
import { BharagRagConnector }       from '../connectors/bharag_rag.js';
import { BharagIncidentsConnector }  from '../connectors/bharag_incidents.js';
import { MediaServerConnector }     from '../connectors/media.js';

export type DetectedIntent = 'status' | 'knowledge' | 'images' | 'escalate' | 'default';

export class IntentRouter {
  /**
   * Detect intent from message text using keyword matching.
   * Intent classification remains active to audit incoming queries.
   */
  static detectIntent(body: string, _systemConfig?: SystemConfig | null): DetectedIntent {
    const text = (body || '').toLowerCase().trim();

    // 1. Escalation / fault triggers (highest priority)
    const faultKeywords = ['alarm', 'fault', 'leak', 'failure', 'broken', 'emergency', 'escalate', 'error', 'urgent', 'help!'];
    if (faultKeywords.some((kw) => text.includes(kw))) return 'escalate';

    // 2. Image / photo requests
    const imageKeywords = ['photo', 'image', 'picture', 'snap', 'look', 'view', 'capture', 'camera', 'send'];
    if (imageKeywords.some((kw) => text.includes(kw))) return 'images';

    // 3. Status & telemetry inquiries
    const statusKeywords = ['status', 'temp', 'temperature', 'ph', 'ec', 'check', 'telemetry', 'reading', 'bay', 'water'];
    if (statusKeywords.some((kw) => text.includes(kw))) return 'status';

    // 4. Knowledge / FAQ questions
    const knowledgeKeywords = ['how', 'what', 'why', 'clean', 'filter', 'light', 'cycle', 'guide', 'doc', 'manual', 'procedure'];
    if (knowledgeKeywords.some((kw) => text.includes(kw))) return 'knowledge';

    return 'default';
  }

  /**
   * Check if message text attempts user or role management operations.
   */
  private static isUserManagementAttempt(text: string): boolean {
    const keywords = ['grant role', 'change role', 'add user', 'set permission', 'promote user', 'demote user', 'make owner', 'make admin'];
    return keywords.some((kw) => text.includes(kw));
  }

  /**
   * Check if message text attempts operational control actions.
   */
  private static isControlAttempt(text: string): boolean {
    const keywords = ['turn off', 'turn on', 'pump off', 'valve open', 'setpoint', 'override', 'reboot', 'reset'];
    return keywords.some((kw) => text.includes(kw));
  }

  /**
   * Main Router Execution Pipeline (8-Step Architecture):
   *
   * 1. Verify Organization/Tenant scope.
   * 2. Resolve Workspace/Project scope.
   * 3. Resolve Customer Identity.
   * 4. Resolve Server-side Role & Permissions (owner / manager / tech).
   * 5. Unknown User Gate -> Safe Onboarding Reply.
   * 6. Role Permission Boundary Check -> Reject unauthorized operations per role.
   * 7. Step-Up Authentication Seam -> Sensitive actions require explicit step-up.
   * 8. Dispatch to Connectors (BHARAG Cluster Ask, Media Server, BHARAG Incidents).
   */
  static async routeAndHandle(
    msg: InboundMessage,
    identity: IdentityContext
  ): Promise<OutboundMessage> {
    const systemConfig = SystemsRegistry.getSystemByOrganizationId(identity.organization_id)
      || SystemsRegistry.getSystemByTenantId(identity.tenant_id);
    const onboardingReply = systemConfig?.onboarding_reply ?? 'Welcome to vFarm Support! Contact our onboarding team to link your phone number to your farm.';

    const orgId = identity.organization_id || identity.tenant_id;
    const wsId = identity.workspace_id || 'ws-vfarm-main';

    // Create or fetch conversation record scoped to Organization and Workspace
    const { conversation_id } = await DbClient.getOrCreateConversation(
      orgId,
      identity.system_id,
      identity.customer_ref,
      orgId,
      wsId
    );

    // Persist inbound message to transcript
    await DbClient.addMessageToTranscript({
      message_id:   msg.message_id,
      conversation_id,
      tenant_id:    orgId,
      direction:    'inbound',
      from_e164:    msg.from_e164,
      to_e164:      msg.to_e164,
      body:         msg.body,
      media_refs:   msg.media,
      provider_sid: msg.message_id,
    });

    let replyBody: string;
    let mediaUrl: string | undefined;

    const intent = this.detectIntent(msg.body, systemConfig);
    const msgText = (msg.body || '').toLowerCase();

    Logger.info(`IntentRouter: Processing intent "${intent}" for actor ${identity.customer_ref} (org=${orgId}, ws=${wsId}, role=${identity.role})`, {
      organization_id: orgId,
      tenant_id:       orgId,
      workspace_id:    wsId,
      conversation_id,
      intent,
      role:            identity.role,
    });

    // ── STEP 5: UNKNOWN USER GATE ─────────────────────────────────────────────
    if (!identity.is_known_customer) {
      Logger.audit({
        timestamp:     new Date().toISOString(),
        tenant_id:     orgId,
        actor:         identity.customer_ref,
        role:          'unknown_user',
        entry_point:   'webhook',
        tool_or_route: 'IntentRouter.routeAndHandle()',
        outcome:       'ok',
        reason:        'Unknown sender served safe generic onboarding response',
        correlation_id: msg.correlation_id,
      });

      const outboundMessage: OutboundMessage = {
        tenant_id:      orgId,
        to_e164:        msg.from_e164,
        body:           onboardingReply,
        correlation_id: msg.correlation_id,
        status:         'pending',
      };

      return await DbClient.saveOutboundMessage(outboundMessage);
    }

    // ── STEP 6: ROLE PERMISSION BOUNDARY CHECKS ──────────────────────────────

    // User/Role Management Attempts via SMS Rail: Always blocked (admin panel only)
    if (this.isUserManagementAttempt(msgText)) {
      Logger.audit({
        timestamp:     new Date().toISOString(),
        tenant_id:     orgId,
        actor:         identity.customer_ref,
        role:          identity.role,
        entry_point:   'webhook',
        tool_or_route: 'IntentRouter.routeAndHandle()',
        outcome:       'refused',
        reason:        `User management attempt via SMS refused for role ${identity.role}`,
        correlation_id: msg.correlation_id,
      });

      const outboundMessage: OutboundMessage = {
        tenant_id:      orgId,
        to_e164:        msg.from_e164,
        body:           'User and role management operations are restricted to the Organization Admin Panel.',
        correlation_id: msg.correlation_id,
        status:         'pending',
      };
      return await DbClient.saveOutboundMessage(outboundMessage);
    }

    // Tech Role attempting Control Actions: Refused by role boundary
    if (identity.role === 'tech' && this.isControlAttempt(msgText)) {
      Logger.audit({
        timestamp:     new Date().toISOString(),
        tenant_id:     orgId,
        actor:         identity.customer_ref,
        role:          identity.role,
        entry_point:   'webhook',
        tool_or_route: 'IntentRouter.routeAndHandle()',
        outcome:       'refused',
        reason:        'Tech role is not authorized to execute equipment control operations',
        correlation_id: msg.correlation_id,
      });

      const outboundMessage: OutboundMessage = {
        tenant_id:      orgId,
        to_e164:        msg.from_e164,
        body:           "Role 'tech' is not authorized to execute control operations. Please contact a workspace manager or owner.",
        correlation_id: msg.correlation_id,
        status:         'pending',
      };
      return await DbClient.saveOutboundMessage(outboundMessage);
    }

    // ── STEP 7: STEP-UP AUTHENTICATION SEAM FOR SENSITIVE WRITE ACTIONS ──────
    if (StepUpAuthService.isSensitiveAction(msg.body, intent)) {
      const stepUpResult = StepUpAuthService.verifyStepUp(identity);
      if (!stepUpResult.verified) {
        replyBody = stepUpResult.message || 'Sensitive operations require step-up authentication.';
        
        const outboundMessage: OutboundMessage = {
          tenant_id:      orgId,
          to_e164:        msg.from_e164,
          body:           replyBody,
          correlation_id: msg.correlation_id,
          status:         'pending',
        };

        return await DbClient.saveOutboundMessage(outboundMessage);
      }
    }

    // ── Multi-Tenancy Security: Enforce caller-verified farm & unit context ──────
    // Strictly isolate query execution to the farm_id and unit_id bound to caller's verified phone number.
    // Never extract or allow cross-farm context overrides from user message text.
    // Never silently default to arbitrary real tenant units (e.g. farm_austin_main / unit_bay_04).
    const boundFarmId = identity.unit_context?.farm_id as string | undefined;
    const boundUnitId = identity.unit_context?.unit_id as string | undefined;

    if (intent === 'status') {
      if (!boundFarmId || !boundUnitId) {
        Logger.audit({
          timestamp:      new Date().toISOString(),
          tenant_id:      orgId,
          actor:          identity.customer_ref,
          role:           identity.role,
          entry_point:    'webhook',
          tool_or_route:  'IntentRouter.routeAndHandle()',
          outcome:        'refused',
          reason:         'Status query refused: caller phone number is not linked to an active vFarm unit',
          correlation_id: msg.correlation_id,
        });

        const outboundMessage: OutboundMessage = {
          tenant_id:      orgId,
          to_e164:        msg.from_e164,
          body:           'Your phone number is not linked to an active vFarm unit. Please contact support or provide your unit ID.',
          correlation_id: msg.correlation_id,
          status:         'pending',
        };

        return await DbClient.saveOutboundMessage(outboundMessage);
      }
    }

    const verifiedUnitContext = {
      farm_id: boundFarmId,
      unit_id: boundUnitId,
      role:    (identity.unit_context?.role as string) || identity.role || 'manager',
    };

    // ── STEP 8: DISPATCH TO CONNECTORS (vFarm Telemetry, BHARAG Cluster, Media, Incidents) ─────

    if (intent === 'status') {
      // Source 1: vFarm Telemetry Connector (queries unit telemetry/status with verified caller context)
      const statusRes = await VfarmConnector.getUnitStatus(
        identity.customer_ref,
        verifiedUnitContext,
        systemConfig?.bharag_workspace_key,
        msg.body
      );
      replyBody = statusRes?.text || `vFarm Unit ${verifiedUnitContext.unit_id} (${verifiedUnitContext.farm_id}): Telemetry currently unavailable for this unit.`;
    } else {
      // Source 2: BHARAG RAG Knowledge Connector (queries cluster ask endpoint using server-resolved workspace key and verified caller context)
      replyBody = await BharagRagConnector.askKnowledge(
        msg.body,
        systemConfig?.bharag_workspace_key,
        verifiedUnitContext
      );
    }

    // BHARAG Incidents Connector (escalate intent)
    if (intent === 'escalate') {
      const incidentRes = await BharagIncidentsConnector.fileIncident({
        customerRef:    identity.customer_ref,
        conversationId: conversation_id,
        summary:        `Customer escalation [org=${orgId}, ws=${wsId}]: "${msg.body}"`,
        workspaceKey:   systemConfig?.bharag_workspace_key,
        priority:       'high',
        unitContext:    verifiedUnitContext,
      });
      Logger.info(`Incident filed: ${incidentRes.incident_id} for conversation ${conversation_id}`);
    }

    // Media Server Connector (images intent)
    if (intent === 'images') {
      const unitId = verifiedUnitContext.unit_id;
      mediaUrl = await MediaServerConnector.getSignedMediaUrl(unitId);
      Logger.info(`Media Server: Fetched signed URL for unit ${unitId}: ${mediaUrl}`);
    }

    // Enqueue outbound reply for transport worker
    const outboundMessage: OutboundMessage = {
      tenant_id:      orgId,
      to_e164:        msg.from_e164,
      body:           replyBody,
      media_url:      mediaUrl,
      correlation_id: msg.correlation_id,
      status:         'pending',
    };

    const savedOutbound = await DbClient.saveOutboundMessage(outboundMessage);

    Logger.audit({
      timestamp:      new Date().toISOString(),
      tenant_id:      orgId,
      actor:          identity.customer_ref,
      role:           identity.role || 'known_customer',
      entry_point:   'webhook',
      tool_or_route: 'IntentRouter.routeAndHandle()',
      outcome:        'ok',
      reason:         `Intent "${intent}" processed for org "${orgId}" (ws="${wsId}", role="${identity.role}", farm="${verifiedUnitContext.farm_id}")`,
      correlation_id: msg.correlation_id,
    });

    return savedOutbound;
  }
}