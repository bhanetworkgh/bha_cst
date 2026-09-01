import { InboundMessage, IdentityContext, OutboundMessage, SystemConfig } from '../transport/twilio/types.js';
import { SystemsRegistry } from '../systems/registry.js';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';

// ── Source Connectors ──────────────────────────────────────────────────────────
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
   * Main Router Execution Pipeline.
   *
   * Primary source: BHARAG RAG Knowledge Connector (text responses)
   * Media source: Media Server Connector (image attachments for images intent)
   */
  static async routeAndHandle(
    msg: InboundMessage,
    identity: IdentityContext
  ): Promise<OutboundMessage> {
    const systemConfig = SystemsRegistry.getSystemByTenantId(identity.tenant_id);
    const onboardingReply = systemConfig?.onboarding_reply ?? 'Welcome to Support!';

    // Create or fetch conversation record
    const { conversation_id } = await DbClient.getOrCreateConversation(
      identity.tenant_id,
      identity.system_id,
      identity.customer_ref
    );

    // Persist inbound message to transcript
    await DbClient.addMessageToTranscript({
      message_id:   msg.message_id,
      conversation_id,
      tenant_id:    identity.tenant_id,
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
    Logger.info(`IntentRouter: Detected intent "${intent}" for ${identity.customer_ref}`, {
      tenant_id:       identity.tenant_id,
      conversation_id,
      intent,
    });

    // ── BHARAG RAG Knowledge Connector (primary source for all text responses) ──
    replyBody = await BharagRagConnector.askKnowledge(msg.body, systemConfig?.bharag_workspace_key);

    // ── BHARAG Incidents Connector (for escalate intent) ───────────────────────
    if (intent === 'escalate') {
      const incidentRes = await BharagIncidentsConnector.fileIncident({
        customerRef:    identity.customer_ref,
        conversationId: conversation_id,
        summary:        `Customer escalation: "${msg.body}"`,
        workspaceKey:   systemConfig?.bharag_workspace_key,
        priority:       'high',
      });
      Logger.info(`Incident filed: ${incidentRes.incident_id} for conversation ${conversation_id}`);
    }

    // ── Media Server Connector (for images intent) ──────────────────────────────
    if (intent === 'images') {
      const unitId = (identity.unit_context?.unit_id as string) || 'unit_bay_04';
      mediaUrl = await MediaServerConnector.getSignedMediaUrl(unitId);
      Logger.info(`Media Server: Fetched signed URL for unit ${unitId}: ${mediaUrl}`);
    }

    // Enqueue outbound reply for transport worker
    const outboundMessage: OutboundMessage = {
      tenant_id:      identity.tenant_id,
      to_e164:        msg.from_e164,
      body:           replyBody,
      media_url:      mediaUrl,
      correlation_id: msg.correlation_id,
      status:         'pending',
    };

    const savedOutbound = await DbClient.saveOutboundMessage(outboundMessage);

    Logger.audit({
      timestamp:  new Date().toISOString(),
      tenant_id:  identity.tenant_id,
      actor:      identity.customer_ref,
      role:       'customer',
      entry_point: 'webhook',
      tool_or_route: 'IntentRouter.routeAndHandle()',
      outcome:    'ok',
      reason:     `Intent "${intent}" processed via BHARAG RAG + Media Server + Incidents`,
      correlation_id: msg.correlation_id,
    });

    return savedOutbound;
  }
}