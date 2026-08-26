import { InboundMessage, IdentityContext, OutboundMessage } from '../transport/twilio/types.js';
import { SystemsRegistry } from '../systems/registry.js';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';

export async function handle(
  msg: InboundMessage,
  identity: IdentityContext
): Promise<OutboundMessage | null> {
  const systemConfig = SystemsRegistry.getSystemByTenantId(identity.tenant_id);
  const onboardingReply = systemConfig?.onboarding_reply || 'Welcome to Support!';

  // Create or get conversation for transcript tracking
  const { conversation_id } = await DbClient.getOrCreateConversation(
    identity.tenant_id,
    identity.system_id,
    identity.customer_ref
  );

  // Store inbound transcript
  await DbClient.addMessageToTranscript({
    message_id: msg.message_id,
    conversation_id,
    tenant_id: identity.tenant_id,
    direction: 'inbound',
    from_e164: msg.from_e164,
    to_e164: msg.to_e164,
    body: msg.body,
    media_refs: msg.media,
    provider_sid: msg.message_id,
  });

  // Determine reply body
  let replyBody: string;
  if (!identity.is_known_customer) {
    Logger.info(`Triggering tenant onboarding reply for unknown sender`, {
      tenant_id: identity.tenant_id,
      from: msg.from_e164,
    });
    replyBody = onboardingReply;
  } else {
    replyBody = `Echo: ${msg.body}`;
  }

  // Create outbound message record for transport worker
  const outboundMessage: OutboundMessage = {
    tenant_id: identity.tenant_id,
    to_e164: msg.from_e164,
    body: replyBody,
    correlation_id: msg.correlation_id,
    status: 'pending',
  };

  const savedOutbound = await DbClient.saveOutboundMessage(outboundMessage);

  Logger.audit({
    timestamp: new Date().toISOString(),
    tenant_id: identity.tenant_id,
    actor: identity.customer_ref,
    role: identity.is_known_customer ? 'customer' : 'unknown_sender',
    entry_point: 'webhook',
    tool_or_route: 'handle()',
    outcome: 'ok',
    reason: identity.is_known_customer ? 'canned echo reply generated' : 'onboarding reply generated',
    correlation_id: msg.correlation_id,
  });

  return savedOutbound;
}
