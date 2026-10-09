import { DbClient } from '../../db/client.js';
import { OutboundMessage } from './types.js';
import { SystemsRegistry } from '../../systems/registry.js';
import { TwilioClientWrapper } from './client.js';
import { Logger } from '../../config/logger.js';
import { verifyTwilioSignature } from './signature.js';
import { Router, Request, Response } from 'express';
import { AlertAuditLog } from '../../audit/alert_audit.js';
import { publishDelivery } from '../../publishers/delivery.js';
import { canSendSms } from '../../consent/service.js';


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
 * Resolve the sending DID for an outbound message.
 *
 * ONLY chain supported:
 *   OutboundMessage.project_id -> service_number_binding -> phone_e164
 *
 * The old "look up the tenant's SystemsRegistry entry and take
 * phone_numbers[0]" logic is gone: it ignored the project boundary entirely
 * (any project of the tenant could originate from any of its numbers) and it
 * depended on the static `VFARM_PHONE_NUMBERS` env list. If the project has no
 * bound SMS service number the message is refused — a number that is not
 * explicitly bound to this tenant+project may not originate its traffic.
 */
export function resolveOutboundSendingNumber(msg: OutboundMessage): string | null {
  const binding = CoreRegistry.resolveProjectServiceNumber(msg.tenant_id, msg.project_id, 'sms');
  if (binding?.phone_e164) return binding.phone_e164;

  // A reply queued by the SMS ingress lane already carries the receiving
  // service number in `from_e164`. Accept it only if it is genuinely bound to
  // this tenant+project — never because it merely appears in some list.
  const queuedFrom = (msg.from_e164 || '').trim();
  if (queuedFrom) {
    const fromBinding = CoreRegistry.resolveServiceNumber(queuedFrom);
    if (
      fromBinding &&
      fromBinding.tenant_id === msg.tenant_id &&
      fromBinding.project_id === msg.project_id &&
      fromBinding.capability === 'sms'
    ) {
      return fromBinding.phone_e164;
    }
  }

  return null;
}

/**
 * Re-check the CURRENT project capability immediately before sending.
 *
 * A message can sit in the queue while an operator disables SMS for its
 * project. Capability is re-evaluated here — not just at enqueue time — so a
 * disabled channel never actually transmits.
 */
export function isSmsCapabilityEnabled(msg: OutboundMessage): boolean {
  if (!msg.project_id) return false;
  const project = CoreRegistry.getProject(msg.project_id);
  if (!project) return false;
  if (project.tenant_id !== msg.tenant_id) return false;
  return project.capabilities.sms === true;
}

/**
 * Guard for the `consent_exempt` bypass. The flag must never be usable by a
 * customer-originated sender — it is reserved for platform messages only
 * (onboarding replies, opt-out confirmations). If a message claims exempt
 * status but its `from_e164` is not a service number bound to the exact
 * tenant/project sending it, refuse the message.
 *
 * @param resolvedFromE164 The resolved sending number from the binding chain,
 *  if available. If provided, this takes precedence over `msg.from_e164`.
 */
export function validateConsentExempt(
  msg: OutboundMessage,
  resolvedFromE164: string | null = null
): boolean {
  if (!msg.consent_exempt) return true;

  // Use the resolved sending number (project-bound DID) if available;
  // otherwise fall back to the raw queued from_e164 for backward compatibility.
  const fromE164 = resolvedFromE164 || (msg.from_e164 || '').trim();
  const fromBinding = CoreRegistry.resolveServiceNumber(fromE164);
  if (!fromBinding) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: msg.tenant_id,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'validateConsentExempt',
      outcome: 'refused',
      reason: `Outbound consent_exempt bypass refused: ${fromE164} is not a bound service number`,
      correlation_id: msg.correlation_id,
      commercial_impact:
        'An outbound SMS was blocked because it requested the consent-exempt bypass from an untrusted originating number. The bypass may have been set in error or exploited by a caller.',
    });
    return false;
  }

  if (fromBinding.capability !== 'sms') {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: msg.tenant_id,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'validateConsentExempt',
      outcome: 'refused',
      reason: `Outbound consent_exempt bypass refused: ${fromE164} is bound to capability "${fromBinding.capability}", not "sms"`,
      correlation_id: msg.correlation_id,
      commercial_impact:
        'An outbound SMS was blocked because it requested the consent-exempt bypass through a non-SMS service number.',
    });
    return false;
  }

  if (fromBinding.tenant_id !== msg.tenant_id || fromBinding.project_id !== msg.project_id) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: msg.tenant_id,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'validateConsentExempt',
      outcome: 'refused',
      reason: `Outbound consent_exempt bypass refused: ${fromE164} is bound to tenant "${fromBinding.tenant_id}" project "${fromBinding.project_id}", not the sender's "${msg.tenant_id}" / "${msg.project_id}"`,
      correlation_id: msg.correlation_id,
      commercial_impact:
        'An outbound SMS was blocked because it requested the consent-exempt bypass from a service number not bound to this tenant+project (scope mismatch).',
    });
    return false;
  }

  return true;
}

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

    // Step 1b: Re-check the current project capability (may have been disabled
    // after the message was queued). Disabled => do not send, fail with reason.
    if (!isSmsCapabilityEnabled(msg)) {
      const reason = !msg.project_id
        ? 'Outbound send refused: message has no project_id, so no project service number binding can be authorized'
        : 'Outbound send refused: SMS capability is currently disabled for this project';
      await DbClient.updateOutboundStatus(msg.id, 'refused', reason);
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: msg.tenant_id,
        actor: 'outbound_worker',
        role: 'transport_worker',
        entry_point: 'api',
        tool_or_route: 'processOutboundQueue',
        outcome: 'refused',
        reason,
        correlation_id: msg.correlation_id,
      });
      Logger.infra({
        message: `Outbound SMS refused (capability/project binding): ${reason}`,
        commercial_impact:
          'A queued customer reply was not delivered. The customer will not receive an answer on this channel; confirm the project SMS capability and service-number binding.',
        meta: {
          tenant_id: msg.tenant_id,
          project_id: msg.project_id || null,
          to_e164: msg.to_e164,
          correlation_id: msg.correlation_id,
        },
      });
      continue;
    }

    // Step 1b: Re-check the current project capability (may have been disabled
    // after the message was queued). Disabled => do not send, fail with reason.
    if (!isSmsCapabilityEnabled(msg)) {
      const reason = !msg.project_id
        ? 'Outbound send refused: message has no project_id, so no project service number binding can be authorized'
        : 'Outbound send refused: SMS capability is currently disabled for this project';
      await DbClient.updateOutboundStatus(msg.id, 'refused', reason);
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: msg.tenant_id,
        actor: 'outbound_worker',
        role: 'transport_worker',
        entry_point: 'api',
        tool_or_route: 'processOutboundQueue',
        outcome: 'refused',
        reason,
        correlation_id: msg.correlation_id,
        commercial_impact:
          'A queued customer reply was not delivered. The customer will not receive an answer on this channel; confirm the project SMS capability and service-number binding.',
      });
      continue;
    }

    // Step 1d: SMS consent enforcement — opt-out/no-consent recipients are blocked.
    // Consent is a separate dimension from identity: a valid vFarm member who
    // opted out must not receive SMS. Onboarding replies and system notifications
    // marked consent_exempt bypass this check (the safe generic onboarding reply
    // is how CST initially collects consent — blocking it would deadlock).
    if (!msg.consent_exempt) {
      const consentCheck = await canSendSms(msg.tenant_id, msg.to_e164, msg.project_id);
      if (!consentCheck.allowed) {
        const reason = consentCheck.reason;
        await DbClient.updateOutboundStatus(msg.id, 'refused', reason);
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: msg.tenant_id,
          actor: 'outbound_worker',
          role: 'transport_worker',
          entry_point: 'api',
          tool_or_route: 'processOutboundQueue',
          outcome: 'refused',
          reason,
          correlation_id: msg.correlation_id,
          commercial_impact:
            'An outbound SMS was blocked because the recipient has not consented to or has opted out of SMS. The customer will not receive this message.',
        });
        continue;
      }
    }

    // Step 1c: Resolve the sending DID through the binding chain.
    const resolvedFromNumber = resolveOutboundSendingNumber(msg);
    if (!resolvedFromNumber) {
      const reason = `Outbound send refused: no SMS service number is bound to project "${msg.project_id}" for tenant "${msg.tenant_id}"`;
      await DbClient.updateOutboundStatus(msg.id, 'refused', reason);
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: msg.tenant_id,
        actor: 'outbound_worker',
        role: 'transport_worker',
        entry_point: 'api',
        tool_or_route: 'resolveOutboundSendingNumber',
        outcome: 'refused',
        reason,
        correlation_id: msg.correlation_id,
      });
      continue;
    }

    // Step 1c.5: Guard the consent_exempt bypass — validate the resolved
    // sending number (project-bound DID) against the binding chain. This runs
    // after resolveOutboundSendingNumber so platform messages queued without
    // an explicit from_e164 (onboarding replies, STOP confirmations) can be
    // authorized from their project-bound service number. This closes a
    // potential bypass where a caller could set consent_exempt on an outbound
    // to a service number they control.
    if (!validateConsentExempt(msg, resolvedFromNumber)) {
      const reason = 'Outbound send refused: consent_exempt bypass validation failed';
      await DbClient.updateOutboundStatus(msg.id, 'refused', reason);
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: msg.tenant_id,
        actor: 'outbound_worker',
        role: 'transport_worker',
        entry_point: 'api',
        tool_or_route: 'processOutboundQueue',
        outcome: 'refused',
        reason,
        correlation_id: msg.correlation_id,
        commercial_impact:
          'An outbound SMS was blocked because the consent-exempt bypass was requested from an untrusted originating number.',
      });
      continue;
    }

    // Publish initial queued event
    publishDelivery({
      providerSid: msg.provider_sid || msg.id!,
      messageId: msg.id,
      turnId: msg.turn_id,
      channel: 'sms',
      to: msg.to_e164,
      from: resolvedFromNumber,
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
          from: resolvedFromNumber,
          status: 'sending',
          tenantId: msg.tenant_id,
          projectId: msg.project_id || '',
          correlationId: msg.correlation_id,
          retryCount: attempt - 1,
        });
        const fromNumber = resolvedFromNumber;

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
          from: resolvedFromNumber,
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
// Requires Twilio signature verification, validates payload, resolves
// tenant_id + project_id, and updates database records.
//
// Tenancy chain:  Twilio To -> service_number_binding -> tenant_id + project_id
// The legacy `SystemsRegistry.resolveSystemByPhoneNumber(To)` lookup is no
// longer the tenancy authority; a callback for a DID that is not bound to any
// project cannot be attributed, and an unattributable delivery event is never
// published.
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

  // Resolve tenant_id + project_id from the receiving DID's service-number binding.
  const binding = To ? CoreRegistry.resolveServiceNumber(To.trim()) : null;

  // Map Twilio status to allowed internal status
  const normalizedStatus = MessageStatus.toLowerCase();
  let mappedStatus: 'sent' | 'delivered' | 'failed' | 'undelivered' = 'delivered';

  if (normalizedStatus === 'failed') mappedStatus = 'failed';
  else if (normalizedStatus === 'undelivered') mappedStatus = 'undelivered';
  else if (normalizedStatus === 'sent') mappedStatus = 'sent';

  const errorDetails = ErrorCode ? `Twilio ErrorCode: ${ErrorCode}` : undefined;

  // Update DB records across outbound queue and message transcripts.
  // This is also where correlation comes from: the stored row carries the
  // outbound message's project_id and turn_id (=== cst.turn.turn_id).
  const updateResult = await DbClient.updateDeliveryStatusByProviderSid(
    MessageSid,
    mappedStatus,
    errorDetails
  );

  const tenantId = binding?.tenant_id || updateResult.tenant_id || null;
  const projectId = binding?.project_id || updateResult.project_id || '';
  const isFailure = mappedStatus === 'failed' || mappedStatus === 'undelivered';

  Logger.audit({
    timestamp: new Date().toISOString(),
    tenant_id: tenantId,
    actor: 'twilio_delivery_status',
    role: 'transport_worker',
    entry_point: 'webhook',
    tool_or_route: '/webhooks/twilio/delivery-status',
    outcome: isFailure ? 'error' : 'ok',
    reason: `Twilio delivery status update: ${mappedStatus}${ErrorCode ? ` (${errorDetails})` : ''}${
      updateResult.advanced ? '' : ' (duplicate/regressing callback — stored state unchanged)'
    }`,
    correlation_id: MessageSid,
  });

  // Publish cst.delivery for webhook-driven status transitions
  // (delivered / undelivered / sent callbacks from Twilio).
  // Never publish without BOTH a tenant and a project: an un-attributable
  // delivery cannot be joined back to a cst.turn and would pollute the
  // dashboard's per-project reporting.
  if (!tenantId || !projectId) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      actor: 'twilio_delivery_status',
      role: 'transport_worker',
      entry_point: 'webhook',
      tool_or_route: '/webhooks/twilio/delivery-status',
      outcome: 'refused',
      reason: `cst.delivery not published for ${MessageSid}: tenancy unresolved (To=${To || 'n/a'} binding=${
        binding ? 'found' : 'none'
      }, stored project_id=${projectId || 'none'})`,
      correlation_id: MessageSid,
    });
    Logger.infra({
      message: `Delivery callback for ${MessageSid} could not be attributed to a tenant project`,
      commercial_impact:
        'Delivery status was recorded against the message row but no dashboard delivery event was emitted, so the Dashboard will not show this delivery outcome. Check the receiving number is bound to a project.',
      meta: { message_sid: MessageSid, to: To || null, status: mappedStatus },
    });
    res.status(204).send();
    return;
  }

  publishDelivery({
    providerSid: MessageSid,
    messageId: updateResult.message_id,
    // cst.delivery.turn_id === cst.turn.turn_id for the same customer turn.
    turnId: updateResult.turn_id,
    channel: 'sms',
    to: updateResult.to_e164 || To || '',
    from: updateResult.from_e164 || To || '',
    status: mappedStatus,
    tenantId,
    projectId,
    correlationId: MessageSid,
    errorCode: ErrorCode || undefined,
    errorMessage: errorDetails,
  });

  res.status(204).send();
});


