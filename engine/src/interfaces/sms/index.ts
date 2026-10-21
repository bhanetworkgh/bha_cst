import { maskPhone } from '../../util/privacy.js';
import { Router, Request, Response } from 'express';
import { verifyTwilioSignature } from '../../transport/twilio/signature.js';
import { CoreRegistry } from '../../core/registry.js';
import { CoreEngine } from '../../core/engine.js';
import { MessageEnvelope } from '../../core/envelope.js';
import { normalizeTwilioInbound } from '../../transport/twilio/normalize.js';
import { DbClient } from '../../db/client.js';
import { Logger } from '../../config/logger.js';
import { matchesCapability } from '../../core/types.js';
import { processOutboundQueue } from '../../transport/twilio/outbound.js';
import { OutboundMessage } from '../../transport/twilio/types.js';
import { recordOptOut, isOptOutMessage, STOP_KEYWORDS, recordConsent, getConsentStatus, isConsentResponse, handleInboundConsentMessage, handleInboundResubscribeMessage, isResubscribeRequest, isConsentPromptValid, recordConsentPrompt, getConsentPrompt, activateConsentViaPrompt, handleInboundHelpMessage, isHelpMessage, HELP_RESPONSE_TEXT } from '../../consent/service.js';
import { getConsentWording } from '../../consent/wording.js';

export const smsInterfaceRouter = Router();

// Middleware 1: Twilio Signature Verification (MUST happen BEFORE DB touch)
smsInterfaceRouter.post('/twilio/sms', verifyTwilioSignature);

// Middleware 2: Explicit Service Number Tenancy Resolution (MUST happen BEFORE DB touch)
smsInterfaceRouter.post('/twilio/sms', (req: Request, res: Response, next) => {
  const receivingNumber = ((req.body?.To as string) || '').trim();

  if (!receivingNumber) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'twilio_webhook',
      role: 'untrusted_ingress',
      entry_point: 'webhook',
      tool_or_route: '/webhooks/twilio/sms',
      outcome: 'refused',
      reason: 'Missing receiving To number in webhook body',
    });
    res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing receiving To number' });
    return;
  }

  // Look up explicitly bound service number (R-NUM-S2, R-NUM-S4)
  const binding = CoreRegistry.resolveServiceNumber(receivingNumber);

  if (!binding) {
    // Unknown or unbound receiving number: refuse + log + no DB touch + no reply (404)
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'twilio_webhook',
      role: 'untrusted_ingress',
      entry_point: 'webhook',
      tool_or_route: '/webhooks/twilio/sms',
      outcome: 'refused',
      reason: `Unknown or unbound receiving service number ${receivingNumber}`,
    });
    res.status(404).json({ error: 'SYSTEM_NOT_FOUND', message: 'Unknown or unbound receiving number' });
    return;
  }

  if (!matchesCapability(binding.capability, 'sms')) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: binding.tenant_id,
      actor: 'twilio_webhook',
      role: 'untrusted_ingress',
      entry_point: 'webhook',
      tool_or_route: '/webhooks/twilio/sms',
      outcome: 'refused',
      reason: `Service number ${receivingNumber} is bound to capability "${binding.capability}", not "sms"`,
    });
    res.status(404).json({ error: 'CAPABILITY_DISABLED', message: 'Service number is not enabled for SMS' });
    return;
  }

  const project = CoreRegistry.getProject(binding.project_id);
  if (!project || !project.capabilities.sms) {

    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: binding.tenant_id,
      actor: 'twilio_webhook',
      role: 'untrusted_ingress',
      entry_point: 'webhook',
      tool_or_route: '/webhooks/twilio/sms',
      outcome: 'refused',
      reason: `SMS capability disabled for project ${binding.project_id}`,
    });
    res.status(404).json({ error: 'CAPABILITY_DISABLED', message: 'SMS capability is disabled for this project' });
    return;
  }

  // Attach server-resolved tenancy context
  req.tenancy = {
    tenant_id: binding.tenant_id,
    system_id: binding.project_id,
    role: 'customer_ingress',
    scope_resolved_by: 'receiving_number',
  };

  (req as any).serviceBinding = binding;
  next();
});

// Middleware 3: Tenancy Gate & Cross-Tenant Payload Tamper Prevention
smsInterfaceRouter.post('/twilio/sms', (req: Request, res: Response, next) => {
  const tenancy = req.tenancy!;

  if (req.body && typeof req.body === 'object') {
    if ('tenant_id' in req.body && req.body.tenant_id !== tenancy.tenant_id) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenancy.tenant_id,
        actor: tenancy.tenant_id,
        role: tenancy.role,
        entry_point: 'webhook',
        tool_or_route: '/webhooks/twilio/sms',
        outcome: 'refused',
        reason: `Cross-tenant payload mismatch: body tenant_id (${req.body.tenant_id}) !== resolved (${tenancy.tenant_id})`,
      });
      res.status(403).json({
        error: 'TENANT_SCOPE_VIOLATION',
        message: 'Client-provided tenant_id overrides are strictly forbidden',
      });
      return;
    }
  }

  next();
});

// Ingress Handler: Normalization, Deduplication, Async Core Engine Dispatch
smsInterfaceRouter.post('/twilio/sms', async (req: Request, res: Response) => {
  try {
    const tenancy = req.tenancy!;
    const binding = (req as any).serviceBinding;
    const normalizedMsg = normalizeTwilioInbound(req.body, tenancy.tenant_id, tenancy.system_id);

    // Deduplication check via MessageSid
    const { isDuplicate } = await DbClient.saveInboundMessage(normalizedMsg);

    if (isDuplicate) {
      Logger.info(`Duplicate MessageSid ${normalizedMsg.message_id} ignored`, {
        tenant_id: tenancy.tenant_id,
      });
      res.status(204).send();
      return;
    }

    // Return HTTP 204 immediately to Twilio
    res.status(204).send();

    // Async pipeline processing
    setImmediate(async () => {
      try {
        // Check for STOP/keywords BEFORE any Core Engine processing or vFarm identity
        // resolution. Per the consent spine contract, STOP handling must work for
        // numbers with no vFarm identity — an unknown caller texting "STOP" must be
        // honored immediately. We use the canonical Twilio STOP keyword set from
        // the wording module (stop, stopall, unsubscribe, quit, end, cancel).
        const stopResult = await handleInboundConsentMessage(
          binding.tenant_id,
          normalizedMsg.from_e164,
          normalizedMsg.body,
          binding.project_id,
          normalizedMsg.message_id,
        );
        if (stopResult) {
          // Send the STOP confirmation reply (consent_exempt — opt-out confirmation is allowed)
          const confirmationReply: OutboundMessage = {
            tenant_id: binding.tenant_id,
            project_id: binding.project_id,
            from_e164: normalizedMsg.to_e164,
            to_e164: normalizedMsg.from_e164,
            body: stopResult.confirmationBody!,
            correlation_id: normalizedMsg.message_id,
            turn_id: normalizedMsg.message_id,
            status: 'pending',
            consent_exempt: true,
          };
          await DbClient.saveOutboundMessage(confirmationReply);
          await processOutboundQueue();
          return;
        }

        // Check for HELP keywords (help, info)
        const helpResult = await handleInboundHelpMessage(
          binding.tenant_id,
          normalizedMsg.from_e164,
          normalizedMsg.body,
          binding.project_id,
          normalizedMsg.message_id,
        );
        if (helpResult) {
          const helpReply: OutboundMessage = {
            tenant_id: binding.tenant_id,
            project_id: binding.project_id,
            from_e164: normalizedMsg.to_e164,
            to_e164: normalizedMsg.from_e164,
            body: helpResult.helpBody,
            correlation_id: normalizedMsg.message_id,
            turn_id: normalizedMsg.message_id,
            status: 'pending',
            consent_exempt: true,
          };
          await DbClient.saveOutboundMessage(helpReply);
          await processOutboundQueue();
          return;
        }

        // Check for re-subscription request (START) from opted_out phones.
        // This records a new consent prompt and sends the canonical consent wording.
        const resubscribeResult = await handleInboundResubscribeMessage(
          binding.tenant_id,
          normalizedMsg.from_e164,
          normalizedMsg.body,
          binding.project_id,
          normalizedMsg.message_id,
        );
        if (resubscribeResult) {
          // Send the consent prompt reply (consent_exempt — this is the prompt itself)
          const confirmationReply: OutboundMessage = {
            tenant_id: binding.tenant_id,
            project_id: binding.project_id,
            from_e164: normalizedMsg.to_e164,
            to_e164: normalizedMsg.from_e164,
            body: resubscribeResult.promptBody!,
            correlation_id: normalizedMsg.message_id,
            turn_id: normalizedMsg.message_id,
            status: 'pending',
            consent_exempt: true,
          };
          await DbClient.saveOutboundMessage(confirmationReply);
          await processOutboundQueue();
          return;
        }

        // Check current consent status before further processing
        const { status: consentStatus } = await getConsentStatus(
          binding.tenant_id,
          normalizedMsg.from_e164,
          binding.project_id,
        );

        // If phone has opted out, only valid affirmative response to an active prompt is accepted.
        // Any other message from an opted_out caller MUST NOT trigger replies or bypass STOP.
        if (consentStatus === 'opted_out') {
          const isConsentResp = isConsentResponse(normalizedMsg.body);
          if (isConsentResp) {
            const hasValidPrompt = await isConsentPromptValid(
              normalizedMsg.from_e164,
              binding.tenant_id,
              binding.project_id,
            );

            if (hasValidPrompt) {
              const prompt = await getConsentPrompt(
                normalizedMsg.from_e164,
                binding.tenant_id,
                binding.project_id,
              );
              if (prompt) {
                await activateConsentViaPrompt(
                  prompt.id,
                  binding.tenant_id,
                  normalizedMsg.from_e164,
                  {
                    projectId: binding.project_id,
                    source: 'resubscribe_yes',
                    correlationId: normalizedMsg.message_id,
                    actor: 'sender',
                  },
                );

                Logger.audit({
                  timestamp: new Date().toISOString(),
                  tenant_id: binding.tenant_id,
                  actor: maskPhone(normalizedMsg.from_e164),
                  role: 'sender',
                  entry_point: 'webhook',
                  tool_or_route: '/webhooks/twilio/sms',
                  outcome: 'ok',
                  reason: `Customer replied with affirmative consent response (prompt=${prompt.id})`,
                  correlation_id: normalizedMsg.message_id,
                });

                const confirmationReply: OutboundMessage = {
                  tenant_id: binding.tenant_id,
                  project_id: binding.project_id,
                  from_e164: normalizedMsg.to_e164,
                  to_e164: normalizedMsg.from_e164,
                  body: `You're opted in to Customer Service Twin SMS for vFarm monitoring, account verification, subscription/appointment confirmations, and 1:1 support.\n\nReply STOP at any time to opt out.`,
                  correlation_id: normalizedMsg.message_id,
                  turn_id: normalizedMsg.message_id,
                  status: 'pending',
                  consent_exempt: true,
                };
                await DbClient.saveOutboundMessage(confirmationReply);
                await processOutboundQueue();
                return;
              }
            }
          }

          Logger.info(`Inbound SMS ignored: sender ${maskPhone(normalizedMsg.from_e164)} is opted_out; no reply sent`, {
            tenant_id: binding.tenant_id,
            phone_e164: normalizedMsg.from_e164,
            correlation_id: normalizedMsg.message_id,
          });
          return;
        }

        // For non-opted-out callers (not_consented), check for affirmative consent response (YES / I AGREE)
        if (consentStatus === 'not_consented') {
          const isConsentResp = isConsentResponse(normalizedMsg.body);
          if (isConsentResp) {
            const hasValidPrompt = await isConsentPromptValid(
              normalizedMsg.from_e164,
              binding.tenant_id,
              binding.project_id,
            );

            if (hasValidPrompt) {
              const prompt = await getConsentPrompt(
                normalizedMsg.from_e164,
                binding.tenant_id,
                binding.project_id,
              );
              if (prompt) {
                await activateConsentViaPrompt(
                  prompt.id,
                  binding.tenant_id,
                  normalizedMsg.from_e164,
                  {
                    projectId: binding.project_id,
                    source: 'onboarding_yes',
                    correlationId: normalizedMsg.message_id,
                    actor: 'sender',
                  },
                );

                Logger.audit({
                  timestamp: new Date().toISOString(),
                  tenant_id: binding.tenant_id,
                  actor: maskPhone(normalizedMsg.from_e164),
                  role: 'sender',
                  entry_point: 'webhook',
                  tool_or_route: '/webhooks/twilio/sms',
                  outcome: 'ok',
                  reason: `Customer replied with affirmative consent response (prompt=${prompt.id})`,
                  correlation_id: normalizedMsg.message_id,
                });

                const confirmationReply: OutboundMessage = {
                  tenant_id: binding.tenant_id,
                  project_id: binding.project_id,
                  from_e164: normalizedMsg.to_e164,
                  to_e164: normalizedMsg.from_e164,
                  body: `You're opted in to Customer Service Twin SMS for vFarm monitoring, account verification, subscription/appointment confirmations, and 1:1 support.\n\nReply STOP at any time to opt out.`,
                  correlation_id: normalizedMsg.message_id,
                  turn_id: normalizedMsg.message_id,
                  status: 'pending',
                  consent_exempt: true,
                };
                await DbClient.saveOutboundMessage(confirmationReply);
                await processOutboundQueue();
                return;
              }
            }

            Logger.info(`Affirmative response ignored — no valid consent prompt for ${maskPhone(normalizedMsg.from_e164)}`, {
              tenant_id: binding.tenant_id,
              phone_e164: normalizedMsg.from_e164,
              correlation_id: normalizedMsg.message_id,
            });
          }
        }

        // Construct uniform MessageEnvelope
        const envelope: MessageEnvelope = {
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          channel: 'sms',
          speaker_ref: normalizedMsg.from_e164,
          text: normalizedMsg.body,
          media: normalizedMsg.media,
          correlation_id: normalizedMsg.message_id,
          metadata: {
            service_number: normalizedMsg.to_e164,
          },
        };

        // Dynamically resolve speaker identity via Tenant Adapter (R-ID-1)
        const speaker = await CoreRegistry.resolveSpeaker({
          tenantId: binding.tenant_id,
          projectId: binding.project_id,
          phoneE164: normalizedMsg.from_e164,
        });

        // Process through Core Engine
        const engineResponse = await CoreEngine.processEnvelope(envelope, speaker);

        // Save outbound message and process queue.
        // IMPORTANT: correlation_id = envelope.correlation_id = MessageSid = cst.turn.turn_id
        // This is the critical join key between cst.turn and cst.delivery on the dashboard.
        //
        // consent_exempt: The safe generic onboarding reply (status === 'onboarding')
        // is what CST uses to collect SMS consent from a new caller. Blocking it
        // when the caller has not yet opted in would create a deadlock — the
        // caller can never receive the consent prompt. All other reply types
        // (status, knowledge, images, etc.) go through the normal consent gate
        // in processOutboundQueue.
        const isOnboarding = engineResponse.status === 'onboarding';

        if (isOnboarding) {
          // Record an onboarding consent prompt so affirmative reply (YES) can activate consent
          await recordConsentPrompt(
            normalizedMsg.from_e164,
            binding.tenant_id,
            'onboarding',
            {
              projectId: binding.project_id,
              correlationId: normalizedMsg.message_id,
              actor: 'platform',
            },
          );
        }

        const outboundRecord: OutboundMessage = {
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          from_e164: normalizedMsg.to_e164,
          to_e164: normalizedMsg.from_e164,
          body: engineResponse.reply_text,
          media_url: engineResponse.media_url,
          correlation_id: envelope.correlation_id,   // = MessageSid = turn_id
          turn_id: envelope.correlation_id,           // explicit join key for cst.delivery
          status: 'pending',
          consent_exempt: isOnboarding,
        };

        await DbClient.saveOutboundMessage(outboundRecord);
        await processOutboundQueue();
      } catch (err: any) {
        Logger.error(`Async SMS message handler error: ${err.message}`, {
          message_id: normalizedMsg.message_id,
          tenant_id: tenancy.tenant_id,
        });
      }
    });
  } catch (err: any) {
    Logger.error(`SMS webhook handling failure: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  }
});
