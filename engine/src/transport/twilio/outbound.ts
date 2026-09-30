import { DbClient } from '../../db/client.js';
import { OutboundMessage } from './types.js';
import { SystemsRegistry } from '../../systems/registry.js';
import { TwilioClientWrapper } from './client.js';
import { Logger } from '../../config/logger.js';
import { verifyTwilioSignature } from './signature.js';
import { Router, Request, Response } from 'express';
import { AlertAuditLog } from '../../audit/alert_audit.js';
import { publishDelivery } from '../../publishers/delivery.js';


export const outboundRouter = Router();

// Store cross-tenant forbidden destination overrides for security test 8
const crossTenantForbiddenMap = new Map<string, string>(); // destinationPhone -> owningTenantId

export function setCrossTenantRule(phoneE164: string, owningTenantId: string): void {
  crossTenantForbiddenMap.set(phoneE164, owningTenantId);
}

export function clearCrossTenantRules(): void {
  crossTenantForbiddenMap.clear();
}

import { CoreRegistry } from '../../core/registry.js';

/**
 * Perform outbound tenant isolation check before calling Twilio.
 * Returns true if send is allowed; false if refused (Test 8 & Spec §9).
 */
export function validateOutboundTenancyScope(msg: OutboundMessage): boolean {
  // Check CoreRegistry service number bindings
  const boundServiceNumber = CoreRegistry.resolveServiceNumber(msg.to_e164);
  if (boundServiceNumber && (boundServiceNumber.tenant_id !== msg.tenant_id)) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: msg.tenant_id,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'validateOutboundTenancyScope',
      outcome: 'refused',
      reason: `Outbound send refused: destination ${msg.to_e164} is a service number bound to tenant "${boundServiceNumber.tenant_id}", project "${boundServiceNumber.project_id}"`,
      correlation_id: msg.correlation_id,
    });
    return false;
  }

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

let isProcessingQueue = false;

/**
 * Worker function to process pending & queued outbound messages.
 * Manages status transitions: pending/queued -> sending -> sent | failed | refused
 * Concurrency-safe: uses atomic queue claiming so multiple workers can process concurrently
 * without duplicate sends.
 */
export async function processOutboundQueue(): Promise<void> {
  if (isProcessingQueue) {
    return;
  }
  isProcessingQueue = true;

  try {
    const pendingMessages = await DbClient.getPendingOutboundMessages();

  for (const msg of pendingMessages) {
    if (!msg.id) continue;

    // Atomically claim the message before processing.
    // If another concurrent worker already claimed it, claimOutboundMessage returns false.
    const isClaimed = await DbClient.claimOutboundMessage(msg.id);
    if (!isClaimed) {
      continue;
    }

    // Step 1: Enforce tenant isolation check before send
    const isAllowed = validateOutboundTenancyScope(msg);

    if (!isAllowed) {
      await DbClient.updateOutboundStatus(msg.id, 'refused', 'Cross-tenant send refused');
      continue;
    }

    // Publish initial queued event
    publishDelivery({
      providerSid: msg.provider_sid || msg.id!,
      messageId: msg.id,
      turnId: msg.turn_id,
      channel: 'sms',
      to: msg.to_e164,
      from: msg.from_e164,
      status: 'queued',
      tenantId: msg.tenant_id,
      projectId: msg.project_id || '',
      correlationId: msg.correlation_id,
    });

    // Step 2: Calculate SMS segmentation
    const charCount = msg.body.length;
    const segmentCount = charCount <= 160 ? 1 : Math.ceil(charCount / 153);
    Logger.info(`Outbound message segmentation: ${charCount} chars => ${segmentCount} segment(s)`, {
      correlation_id: msg.correlation_id,
      tenant_id: msg.tenant_id,
    });

    const maxRetries = msg.max_retries || 3;
    let attempt = msg.retry_count || 0;
    let success = false;
    let lastError = '';
    let isPermanentFailure = false;

    while (attempt < maxRetries && !success) {
      try {
        attempt++;

        // Publish sending status at each attempt
        publishDelivery({
          providerSid: msg.provider_sid || msg.id!,
          messageId: msg.id,
          turnId: msg.turn_id,
          channel: 'sms',
          to: msg.to_e164,
          from: msg.from_e164,
          status: 'sending',
          tenantId: msg.tenant_id,
          projectId: msg.project_id || '',
          correlationId: msg.correlation_id,
          retryCount: attempt - 1,
        });
        const system = SystemsRegistry.getSystemByTenantId(msg.tenant_id);
        const fromNumber = system?.phone_numbers[0];

        const res = await TwilioClientWrapper.sendSms({
          to: msg.to_e164,
          from: fromNumber,
          body: msg.body,
          mediaUrl: msg.media_url ? [msg.media_url] : undefined,
        });

        // Record sending system number, provider_sid, and status 'sent'
        await DbClient.updateOutboundFromE164(msg.id, fromNumber || '');
        if (res.sid) {
          await DbClient.updateOutboundProviderSid(msg.id, res.sid);
        }
        await DbClient.updateOutboundStatus(msg.id, 'sent', undefined, attempt);
        success = true;

        // Publish sent status (Twilio accepted the message)
        publishDelivery({
          providerSid: res.sid || msg.provider_sid || msg.id!,
          messageId: msg.id,
          turnId: msg.turn_id,
          channel: 'sms',
          to: msg.to_e164,
          from: fromNumber,
          status: 'sent',
          tenantId: msg.tenant_id,
          projectId: msg.project_id || '',
          correlationId: msg.correlation_id,
          segments: segmentCount,
          retryCount: attempt,
        });

        // 018M: Immutable Alert Audit Log with write-time masking & size cap
        await AlertAuditLog.write(
          msg.id,
          msg.tenant_id,
          msg.body
        );

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
        lastError = err.message || 'Unknown Twilio API error';
        const isNonRetriable = err.isNonRetriable || TwilioClientWrapper.isNonRetriableError(err);

        Logger.warn(`Outbound send attempt ${attempt}/${maxRetries} failed: ${lastError}`, {
          correlation_id: msg.correlation_id,
          tenant_id: msg.tenant_id,
          attempt,
          maxRetries,
          isNonRetriable,
        });

        // Permanent non-retriable error (e.g. invalid phone number, geo permission denied)
        if (isNonRetriable) {
          isPermanentFailure = true;
          Logger.error(`Permanent non-retriable Twilio error encountered for destination ${msg.to_e164}: ${lastError}`);
          Logger.infra({
            message: `Permanent Twilio delivery failure: non-retriable error for ${msg.to_e164}`,
            commercial_impact: 'Outbound customer message permanently undeliverable. Customer will not receive reply. Manual follow-up or channel switch required.',
            meta: { tenant_id: msg.tenant_id, to_e164: msg.to_e164, error: lastError, correlation_id: msg.correlation_id },
          });
          break;
        }

        if (attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 50; // Exponential backoff (50ms, 100ms, 200ms)
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    if (!success) {
      const isRetriable = !isPermanentFailure && attempt < maxRetries;
      const nextRetryAt = isRetriable ? new Date(Date.now() + Math.pow(2, attempt) * 1000).toISOString() : undefined;
      const finalStatus = isRetriable ? 'queued' : 'failed';
      await DbClient.updateOutboundStatus(msg.id, finalStatus, lastError, attempt, nextRetryAt);

      // Publish failed delivery event (non-retriable exhaustion)
      if (finalStatus === 'failed') {
        publishDelivery({
          providerSid: msg.provider_sid || msg.id!,
          messageId: msg.id,
          turnId: msg.turn_id,
          channel: 'sms',
          to: msg.to_e164,
          from: msg.from_e164,
          status: 'failed',
          tenantId: msg.tenant_id,
          projectId: msg.project_id || '',
          correlationId: msg.correlation_id,
          errorMessage: lastError,
          retryCount: attempt,
        });

        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: msg.tenant_id,
          actor: 'outbound_worker',
          role: 'transport_worker',
          entry_point: 'api',
          tool_or_route: 'processOutboundQueue',
          outcome: 'error',
          reason: `Outbound send failed after ${attempt} attempts: ${lastError}`,
          correlation_id: msg.correlation_id,
          commercial_impact: 'Outbound customer message failed after all retries. Customer has not received a reply. Investigate Twilio account status and destination number validity.',
        });
        Logger.infra({
          message: `Outbound send failed after ${attempt} attempt(s): ${lastError}`,
          commercial_impact: 'Outbound customer message failed after all retries. Customer has not received a reply. Investigate Twilio account status and destination number validity.',
          meta: { tenant_id: msg.tenant_id, to_e164: msg.to_e164, attempt, correlation_id: msg.correlation_id },
        });
      }
    }
  }
} finally {
  isProcessingQueue = false;
}
}

// Delivery status callback handler
// Requires Twilio signature verification, validates payload, resolves tenant_id, and updates database records.
outboundRouter.post('/twilio/delivery-status', verifyTwilioSignature, async (req: Request, res: Response) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body as Record<string, string>;

  if (!MessageSid || !MessageStatus) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'twilio_delivery_status',
      role: 'transport_worker',
      entry_point: 'webhook',
      tool_or_route: '/webhooks/twilio/delivery-status',
      outcome: 'refused',
      reason: 'Missing MessageSid or MessageStatus parameter in delivery status callback',
    });
    res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing MessageSid or MessageStatus' });
    return;
  }

  // Resolve tenant_id from the system number (To parameter in delivery status webhook)
  const system = To ? SystemsRegistry.resolveSystemByPhoneNumber(To) : null;
  const resolvedTenantIdFromPhone = system?.tenant_id;

  // Map Twilio status to allowed internal status
  const normalizedStatus = MessageStatus.toLowerCase();
  let mappedStatus: 'sent' | 'delivered' | 'failed' | 'undelivered' = 'delivered';

  if (normalizedStatus === 'failed') mappedStatus = 'failed';
  else if (normalizedStatus === 'undelivered') mappedStatus = 'undelivered';
  else if (normalizedStatus === 'sent') mappedStatus = 'sent';

  const errorDetails = ErrorCode ? `Twilio ErrorCode: ${ErrorCode}` : undefined;

  // Update DB records across outbound queue and message transcripts
  const updateResult = await DbClient.updateDeliveryStatusByProviderSid(
    MessageSid,
    mappedStatus,
    errorDetails
  );

  const tenantId = resolvedTenantIdFromPhone || updateResult.tenant_id || null;
  const isFailure = mappedStatus === 'failed' || mappedStatus === 'undelivered';

  Logger.audit({
    timestamp: new Date().toISOString(),
    tenant_id: tenantId,
    actor: 'twilio_delivery_status',
    role: 'transport_worker',
    entry_point: 'webhook',
    tool_or_route: '/webhooks/twilio/delivery-status',
    outcome: isFailure ? 'error' : 'ok',
    reason: `Twilio delivery status update: ${mappedStatus}${ErrorCode ? ` (${errorDetails})` : ''}`,
    correlation_id: MessageSid,
  });

  // Publish cst.delivery event for webhook-driven status transitions
  // (delivered / undelivered / sent callbacks from Twilio)
  if (tenantId) {
    publishDelivery({
      providerSid: MessageSid,
      channel: 'sms',
      to: To || '',
      status: mappedStatus,
      tenantId,
      projectId: '',
      correlationId: MessageSid,
      errorCode: ErrorCode || undefined,
      errorMessage: errorDetails,
    });
  }

  res.status(204).send();
});


