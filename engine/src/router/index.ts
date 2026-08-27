import { InboundMessage, IdentityContext, OutboundMessage, SystemConfig } from '../transport/twilio/types.js';
import { SystemsRegistry } from '../systems/registry.js';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';

// ── Source Connectors (Imported and ready for activation) ────────────────────
import { VfarmConnector }           from '../connectors/vfarm.js';
import { BharagRagConnector }       from '../connectors/bharag_rag.js';
import { BharagIncidentsConnector }  from '../connectors/bharag_incidents.js';
import { MediaServerConnector }     from '../connectors/media.js';

export type DetectedIntent = 'status' | 'knowledge' | 'images' | 'escalate' | 'default';

export class IntentRouter {
  /**
   * Detect intent from message text using keyword matching (Spec §2 & §4).
   * Intent classification remains active to audit incoming queries.
   */
  static detectIntent(body: string, _systemConfig?: SystemConfig | null): DetectedIntent {
    const text = (body || '').toLowerCase().trim();

    // 1. Escalation / fault triggers (highest priority)
    const faultKeywords = ['alarm', 'fault', 'leak', 'failure', 'broken', 'emergency', 'escalate', 'error', 'urgent', 'help!'];
    if (faultKeywords.some((kw) => text.includes(kw))) return 'escalate';

    // 2. Image / photo requests
    const imageKeywords = ['photo', 'image', 'picture', 'snap', 'look', 'view', 'capture', 'camera'];
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
   * Main Router Execution Pipeline (Spec §4).
   *
   * CONNECTOR INTEGRATION STATUS:
   *   All 4 connectors are compiled and ready in engine/src/connectors/.
   *   Their execution blocks are commented out below until external servers are live.
   *   Currently, the router echoes back ONLY the message received from the user.
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

    // ── Unknown Sender Path ──────────────────────────────────────────────────
    if (!identity.is_known_customer) {
      Logger.info(`IntentRouter: Unknown sender ${msg.from_e164} on ${identity.system_id} → onboarding path`, {
        tenant_id: identity.tenant_id,
      });
      replyBody = onboardingReply;

    // ── Known Customer Path ──────────────────────────────────────────────────
    } else {
      const intent = this.detectIntent(msg.body, systemConfig);
      Logger.info(`IntentRouter: Detected intent "${intent}" for ${identity.customer_ref}`, {
        tenant_id:       identity.tenant_id,
        conversation_id,
        intent,
      });

      // ── Connector Executions (Commented out; sends back user's query) ──────
      switch (intent) {

        // ── Source 1: vFarm Telemetry Connector ────────────────────────────
        case 'status': {
          // TODO: Uncomment when vFarm Server Read API is live
          // const statusRes = await VfarmConnector.getUnitStatus(identity.customer_ref, identity.unit_context);
          // replyBody = statusRes.text;
          replyBody = msg.body;
          break;
        }

        // ── Source 2: BHARAG RAG Knowledge Connector ────────────────────────
        case 'knowledge': {
          // TODO: Uncomment when BHARAG Ask API is live
          // replyBody = await BharagRagConnector.askKnowledge(msg.body, systemConfig?.bharag_workspace_key);
          replyBody = msg.body;
          break;
        }

        // ── Source 4: Media Server Signed S3 URL Connector ──────────────────
        case 'images': {
          // TODO: Uncomment when Media Server API is live
          // const unitId = (identity.unit_context?.unit_id as string) || 'unit_bay_04';
          // mediaUrl = await MediaServerConnector.getSignedMediaUrl(unitId);
          // replyBody = `vFarm Media Capture for ${unitId}: Photo retrieved successfully.`;
          replyBody = msg.body;
          break;
        }

        // ── Source 3: BHARAG Incidents.v0 Ticket Connector ─────────────────
        case 'escalate': {
          // TODO: Uncomment when BHARAG Incidents API is live
          // const incidentRes = await BharagIncidentsConnector.fileIncident({
          //   customerRef:    identity.customer_ref,
          //   conversationId: conversation_id,
          //   summary:        `Customer escalation: "${msg.body}"`,
          //   workspaceKey:   systemConfig?.bharag_workspace_key,
          //   priority:       'high',
          // });
          // replyBody = `vFarm Support Alert: Incident ticket #${incidentRes.incident_id} filed in BHARAG. An engineer has been paged.`;
          replyBody = msg.body;
          break;
        }

        case 'default':
        default: {
          replyBody = msg.body;
          break;
        }
      }
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
      role:       identity.is_known_customer ? 'customer' : 'unknown_sender',
      entry_point: 'webhook',
      tool_or_route: 'IntentRouter.routeAndHandle()',
      outcome:    'ok',
      reason:     identity.is_known_customer
        ? `Intent "${this.detectIntent(msg.body)}" processed (user message echoed)`
        : 'Onboarding reply sent',
      correlation_id: msg.correlation_id,
    });

    // Suppress unused imports check for connectors until activated
    void VfarmConnector;
    void BharagRagConnector;
    void BharagIncidentsConnector;
    void MediaServerConnector;

    return savedOutbound;
  }
}
