import { InboundMessage, TwilioWebhookPayload } from './types.js';
import { randomUUID } from 'crypto';

export function normalizeTwilioInbound(
  payload: TwilioWebhookPayload,
  tenantId: string
): InboundMessage {
  const messageId = payload.MessageSid || payload.SmsSid || `msg_${randomUUID()}`;
  const fromE164 = (payload.From || '').trim();
  const toE164 = (payload.To || '').trim();
  const body = (payload.Body || '').trim();

  const media: string[] = [];
  const numMedia = parseInt(String(payload.NumMedia || '0'), 10);
  for (let i = 0; i < numMedia; i++) {
    const mediaUrl = payload[`MediaUrl${i}`];
    if (typeof mediaUrl === 'string' && mediaUrl.length > 0) {
      media.push(mediaUrl);
    }
  }

  return {
    message_id: messageId,
    tenant_id: tenantId,
    from_e164: fromE164,
    to_e164: toE164,
    body,
    media,
    received_at: new Date().toISOString(),
    correlation_id: `corr_${messageId}_${Date.now()}`,
  };
}
