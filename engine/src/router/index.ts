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

/**
 * Live-state vocabulary, matched on WORD BOUNDARIES.
 *
 * The previous keyword list was matched with `text.includes(kw)` and two of
 * its tokens are two letters long — 'ph' is inside "phone", "because",
 * "graph", "sulphur"; 'ec' is inside "because", "each", "secure", "spec".
 * An ordinary sentence containing those substrings was therefore routed to
 * the vFarm status lane instead of the BHARAG knowledge lane.
 */
const LIVE_STATE_WORD_RE = new RegExp(
  '\\b(status|statuses|temps?|temperatures?|telemetry|readings?|humidity|moisture|ph|ec|water-level|bays?|racks?|zones?|sensors?|devices?)\\b',
  'i',
);

/**
 * A request scoped to the CALLER'S OWN farm / unit / zone / device.
 *
 * "my form(s)" is a narrow SPEECH-RECOGNITION correction: CST has no form
 * domain at all (every "form" in the codebase is "shape" or
 * "form-urlencoded"), so "my form data" here is a mis-transcription of
 * "my farm data". It is scoped to the possessive + live-data-noun case, so a
 * legitimate form-related request ("where is the maintenance form?") is
 * untouched. It is NOT a global "form" -> "farm" replacement.
 */
const POSSESSIVE_SCOPE_RE = new RegExp(
  '\\bmy\\s+(?:own\\s+)?(?:farms?|forms?|units?|sites?|zones?|locations?|devices?|racks?|greenhouses?)\\b',
  'i',
);

/** Nouns that make a possessive request a request for LIVE data. */
const LIVE_DATA_NOUN_RE = new RegExp(
  '\\b(data|status|statuses|state|stats|readings?|alerts?|alarms?|devices?|zone|zones|location|locations|rack|racks|crop|crops|sensor|sensors|telemetry|health|condition|conditions?|performance|overview|summary|latest|now)\\b',
  'i',
);

/**
 * An explicit request for a live reading. Overrides a knowledge marker:
 * "how do I check the status of my farm?" is a status request even though it
 * starts with "how do I".
 */
const LIVE_READING_MARKER_RE = new RegExp(
  '\\b(status of|status for|my status|right now|currently|at the moment|latest|live|reading|readings|temperature|humidity|alerts? on|alerts? for)\\b',
  'i',
);

/** General procedure, how-to and recommendation markers — the BHARAG lane. */
const KNOWLEDGE_MARKER_RE = new RegExp(
  '\\b(how do i|how do you|how to|how can i|how should i|what should i|recommended|recommendation|best way|best practice|guide|manual|procedure|steps to|troubleshoot|calibrat\\w*|install\\w*|replac\\w*|clean the filter|clean filter|for tomatoes|for crops)\\b',
  'i',
);

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

    // 3. Farm-scoped live state (KMG9: the vFarm lane, never BHARAG).
    //
    //    A request about the CALLER'S OWN farm, unit or device that asks for
    //    live data is farm data — not documentation. "Show me my farm data" and
    //    "What alerts are open for my farm?" were being sent to the BHARAG
    //    knowledge cluster, which by design (KMG9) is never given a farm id and
    //    therefore can never answer them.
    if (this.isFarmSpecificLiveStateRequest(text)) return 'status';

    // 4. General procedure / recommendation questions.
    //
    //    Checked BEFORE the live-state vocabulary so that "what pH is
    //    recommended for tomatoes?" is a knowledge question and not a reading
    //    request. "recommended" and "how do I" are the markers; an explicit
    //    live reading ("status of", "right now", "latest", …) overrides them.
    if (this.isGeneralKnowledgeRequest(text)) return 'knowledge';

    // 5. Live-state vocabulary.
    //
    //    Matched on WORD BOUNDARIES. The previous list was matched with
    //    `text.includes(kw)`, and two of its tokens are two letters long:
    //    'ph' is inside "phone", "because", "graph", "sulphur"; 'ec' is inside
    //    "because", "each", "secure", "spec". Any ordinary sentence containing
    //    those substrings was routed to the vFarm status lane instead of the
    //    BHARAG knowledge lane.
    if (LIVE_STATE_WORD_RE.test(text)) return 'status';

    // 6. Knowledge / FAQ questions
    const knowledgeKeywords = ['how', 'what', 'why', 'clean', 'filter', 'light', 'cycle', 'guide', 'doc', 'manual', 'procedure'];
    if (knowledgeKeywords.some((kw) => text.includes(kw))) return 'knowledge';

    return 'default';
  }

  /**
   * Detect a request for the CALLER'S OWN live farm data.
   *
   * Two ways to qualify:
   *   1. The explicit patterns below (status of my …, my farm's alerts, …).
   *   2. A POSSESSIVE scope ("my farm", "my unit", …) together with a
   *      live-data noun ("data", "alerts", "devices", "readings", …).
   *
   * The possessive requirement is what keeps general questions on BHARAG:
   * "how do I clean the filter", "what pH is recommended for tomatoes" and
   * "how do I calibrate the sensor" never name the caller's own farm, so they
   * stay documentation questions.
   *
   * A general-knowledge marker ("recommended", "how do I", "guide", …)
   * wins over the possessive rule UNLESS the request also names a live
   * reading, so "what is the recommended pH for my farm?" is advice while
   * "how do I check the status of my farm?" is a status request.
   */
  private static isFarmSpecificLiveStateRequest(text: string): boolean {
    const farmStatePatterns = [
      // "how is my farm", "how's my farm", "why is my farm", "why is my unit"
      /how is my farm/i, /how's my farm/i,
      /why is my farm/i, /why is my unit/i,
      // "status of my", "my farm's status", "my unit's status"
      /status of my/i, /my farm's status/i, /my unit's status/i,
      // sensor/telemetry possessives
      /my water temperature/i, /my ph\b/i, /my ec\b/i, /my temperature/i,
      /my humidity/i, /my water level/i, /my sensor/i, /my telemetry/i, /my reading/i,
      // alert possessives
      /any alerts on my/i, /alerts on my/i, /my alerts\b/i, /my farm's alerts/i,
      // performance/condition possessives
      /my farm performing/i, /my farm condition/i, /how is .* doing\b/i,
      // explicit "what is my" + live data vocab
      /what is my water/i, /what is my ph\b/i, /what is my ec\b/i, /what is my temperature/i,
      /what is my humidity/i, /what is my sensor/i, /what is my reading/i,
    ];
    if (farmStatePatterns.some((re) => re.test(text))) return true;

    // Possessive scope + live-data noun.
    //
    // "my form(s)" is included as a SPEECH-RECOGNITION correction only:
    // CST has no form domain at all (every "form" in the codebase is
    // "shape" or "form-urlencoded"), so "my form data" in this product is a
    // mis-transcription of "my farm data". It is deliberately narrow —
    // possessive + live-data noun — so a legitimate form-related request
    // ("where is the maintenance form?") is untouched, and it is NOT a global
    // "form" -> "farm" replacement.
    if (!POSSESSIVE_SCOPE_RE.test(text)) return false;
    if (!LIVE_DATA_NOUN_RE.test(text)) return false;
    // An explicit knowledge marker wins unless a live reading is named.
    if (KNOWLEDGE_MARKER_RE.test(text) && !LIVE_READING_MARKER_RE.test(text)) return false;
    return true;
  }

  /**
   * Detect a GENERAL procedure, how-to or recommendation question.
   *
   * These belong to the BHARAG knowledge lane even when they mention a farm:
   * "how do I clean the filter?", "what pH is recommended for tomatoes?",
   * "how do I calibrate the sensor?".
   */
  private static isGeneralKnowledgeRequest(text: string): boolean {
    if (LIVE_READING_MARKER_RE.test(text)) return false;
    return KNOWLEDGE_MARKER_RE.test(text);
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
    // The workspace is the project scope. No hardcoded legacy workspace id:
    // an unbound caller is stamped with the tenant id rather than a
    // platform-wide constant that would blur project boundaries.
    const wsId = identity.workspace_id || identity.project_id || orgId;

    // Create or fetch conversation record scoped to Organization and Workspace.
    // project_id is passed explicitly: the ON CONFLICT target is
    // (tenant_id, project_id, customer_ref), and a NULL project_id can never match
    // a unique index (NULL != NULL), which would append a duplicate conversation
    // row on every repeat message. DbClient resolves system_id from tenant_id.
    const { conversation_id } = await DbClient.getOrCreateConversation(
      orgId,
      identity.system_id,
      identity.customer_ref,
      orgId,
      wsId,
      identity.project_id || undefined
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
      // Refuse only when NOTHING about the caller's farm is known.
      //
      // The previous guard refused when EITHER the farm or the unit was
      // missing. vFarm exposes no user -> device mapping, so a caller with a
      // valid farm grant never has a unit id — which meant the refusal fired
      // for every correctly identified customer, even though the farm was
      // known, authorized and readable.
      //
      // With a farm bound but no unit, the request continues to the vFarm
      // connector, which answers at FARM level (farm health and device
      // counts) and states plainly that per-unit readings are not available.
      // The farm id still comes from the caller's verified identity — it is
      // never taken from the message text, and no default farm is invented.
      if (!boundFarmId) {
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
        msg.body,
        identity,
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

    // BHARAG Incidents Connector (escalate intent).
    // Integrity: a failed create never yields an incident id — the customer is
    // told the truth and the failure is logged with commercial impact.
    let incidentId: string | undefined;
    if (intent === 'escalate') {
      const incidentRes = await BharagIncidentsConnector.fileIncident({
        customerRef:    identity.customer_ref,
        conversationId: conversation_id,
        summary:        `Customer escalation [org=${orgId}, ws=${wsId}]: "${msg.body}"`,
        workspaceKey:   systemConfig?.bharag_workspace_key,
        priority:       'high',
        unitContext:    verifiedUnitContext,
      });
      if (incidentRes.created && incidentRes.incident_id) {
        incidentId = incidentRes.incident_id;
        Logger.info(`Incident filed: ${incidentId} for conversation ${conversation_id}`);
      } else {
        Logger.audit({
          timestamp:     new Date().toISOString(),
          tenant_id:     orgId,
          actor:         identity.customer_ref,
          role:          identity.role,
          entry_point:   'webhook',
          tool_or_route: 'IntentRouter.routeAndHandle()',
          outcome:       'error',
          reason:        `Escalation NOT ticketed — BHARAG incident creation failed: ${incidentRes.error || 'unavailable'}`,
          correlation_id: msg.correlation_id,
          commercial_impact:
            'Customer asked for help and no incident was created. No one is tracking this escalation; support must be contacted directly.',
        });
        replyBody =
          'I could not open a support ticket for this escalation because our incident system is unavailable. '
          + 'Please contact vFarm support directly so a specialist can follow up.';
      }
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