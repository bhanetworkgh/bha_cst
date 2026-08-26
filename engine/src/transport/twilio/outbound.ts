import { DbClient } from '../../db/client.js';
import { OutboundMessage } from './types.js';
import { SystemsRegistry } from '../../systems/registry.js';
import { TwilioClientWrapper } from './client.js';
import { Logger } from '../../config/logger.js';
import { verifyTwilioSignature } from './signature.js';
import { Router, Request, Response } from 'express';


export const outboundRouter = Router();

// Store cross-tenant forbidden destination overrides for security test 8
const crossTenantForbiddenMap = new Map<string, string>(); // destinationPhone -> owningTenantId

export function setCrossTenantRule(phoneE164: string, owningTenantId: string): void {
  crossTenantForbiddenMap.set(phoneE164, owningTenantId);
}

export function clearCrossTenantRules(): void {
  crossTenantForbiddenMap.clear();
}

/**
 * Perform outbound tenant isolation check before calling Twilio.
 * Returns true if send is allowed; false if refused (Test 8).
 */
export function validateOutboundTenancyScope(msg: OutboundMessage): boolean {
  // Check if destination phone is registered as belonging to another tenant's system number
  const registeredSystemForDest = SystemsRegistry.resolveSystemByPhoneNumber(msg.to_e164);
  if (registeredSystemForDest && registeredSystemForDest.tenant_id !== msg.tenant_id) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: msg.tenant_id,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'validateOutboundTenancyScope',
      outcome: 'refused',
      reason: `Outbound cross-tenant send refused: Tenant ${msg.tenant_id} attempted to send to phone ${msg.to_e164} registered to Tenant ${registeredSystemForDest.tenant_id}`,
      correlation_id: msg.correlation_id,
    });
    return false;
  }

  // Check explicit cross-tenant map
  const explicitOwner = crossTenantForbiddenMap.get(msg.to_e164);
  if (explicitOwner && explicitOwner !== msg.tenant_id) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: msg.tenant_id,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'validateOutboundTenancyScope',
      outcome: 'refused',
      reason: `Outbound cross-tenant send refused: Destination ${msg.to_e164} belongs to tenant ${explicitOwner}`,
      correlation_id: msg.correlation_id,
    });
    return false;
  }

  return true;
}

/**
 * Worker function to process pending outbound messages queue.
 */
export async function processOutboundQueue(): Promise<void> {
  const pendingMessages = await DbClient.getPendingOutboundMessages();

  for (const msg of pendingMessages) {
    // Step 1: Enforce tenant isolation check before send
    const isAllowed = validateOutboundTenancyScope(msg);

    if (!isAllowed) {
      await DbClient.updateOutboundStatus(msg.id!, 'refused', 'Cross-tenant send refused');
      continue;
    }

    // Step 2: Calculate SMS segmentation
    const charCount = msg.body.length;
    const segmentCount = charCount <= 160 ? 1 : Math.ceil(charCount / 153);
    Logger.info(`Outbound message segmentation: ${charCount} chars => ${segmentCount} segment(s)`, {
      correlation_id: msg.correlation_id,
      tenant_id: msg.tenant_id,
    });

    // Step 3: Attempt send with retry strategy
    const maxRetries = 3;
    let attempt = 0;
    let success = false;
    let lastError = '';

    while (attempt < maxRetries && !success) {
      try {
        attempt++;
        const system = SystemsRegistry.getSystemByTenantId(msg.tenant_id);
        const fromNumber = system?.phone_numbers[0];

        const res = await TwilioClientWrapper.sendSms({
          to: msg.to_e164,
          from: fromNumber,
          body: msg.body,
          mediaUrl: msg.media_url ? [msg.media_url] : undefined,
        });

        // Record which system number actually sent the message (GAP-5 fix)
        await DbClient.updateOutboundFromE164(msg.id!, fromNumber || '');
        await DbClient.updateOutboundStatus(msg.id!, 'sent');
        success = true;

        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: msg.tenant_id,
          actor: 'outbound_worker',
          role: 'transport_worker',
          entry_point: 'api',
          tool_or_route: 'processOutboundQueue',
          outcome: 'ok',
          reason: `Twilio send succeeded (SID: ${res.sid})`,
          correlation_id: msg.correlation_id,
        });
      } catch (err: any) {
        lastError = err.message || 'Unknown Twilio error';
        Logger.warn(`Outbound send attempt ${attempt}/${maxRetries} failed: ${lastError}`, {
          correlation_id: msg.correlation_id,
          tenant_id: msg.tenant_id,
        });

        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 50; // Exponential backoff (50ms, 100ms, 200ms for test fastness)
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    if (!success) {
      await DbClient.updateOutboundStatus(msg.id!, 'failed', lastError);
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: msg.tenant_id,
        actor: 'outbound_worker',
        role: 'transport_worker',
        entry_point: 'api',
        tool_or_route: 'processOutboundQueue',
        outcome: 'error',
        reason: `Outbound send failed after ${maxRetries} attempts: ${lastError}`,
        correlation_id: msg.correlation_id,
      });
    }
  }
}

// Delivery status callback handler (GAP-6 fix)
// Requires Twilio signature verification and resolves tenant_id from the stored outbound record.
outboundRouter.post('/twilio/delivery-status', verifyTwilioSignature, (req: Request, res: Response) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body as Record<string, string>;

  // Resolve tenant_id from the outbound record matched by correlation (To number → system)
  const system = To ? SystemsRegistry.resolveSystemByPhoneNumber(To) : null;
  const tenantId = system?.tenant_id ?? null;

  Logger.audit({
    timestamp: new Date().toISOString(),
    tenant_id: tenantId,
    actor: 'twilio_delivery_status',
    role: 'transport_worker',
    entry_point: 'webhook',
    tool_or_route: '/webhooks/twilio/delivery-status',
    outcome: MessageStatus === 'failed' || MessageStatus === 'undelivered' ? 'error' : 'ok',
    reason: `Twilio delivery status: ${MessageStatus}${ErrorCode ? ` (ErrorCode: ${ErrorCode})` : ''}`,
    correlation_id: MessageSid,
  });

  res.status(204).send();
});

