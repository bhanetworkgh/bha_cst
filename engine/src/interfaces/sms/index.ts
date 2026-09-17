import { Router, Request, Response } from 'express';
import { verifyTwilioSignature } from '../../transport/twilio/signature.js';
import { CoreRegistry } from '../../core/registry.js';
import { CoreEngine } from '../../core/engine.js';
import { MessageEnvelope } from '../../core/envelope.js';
import { normalizeTwilioInbound } from '../../transport/twilio/normalize.js';
import { DbClient } from '../../db/client.js';
import { Logger } from '../../config/logger.js';
import { processOutboundQueue } from '../../transport/twilio/outbound.js';
import { OutboundMessage } from '../../transport/twilio/types.js';

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

  if (binding.capability !== 'sms') {
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
    const normalizedMsg = normalizeTwilioInbound(req.body, tenancy.tenant_id);

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

        // Save outbound message and process queue
        const outboundRecord: OutboundMessage = {
          tenant_id: binding.tenant_id,
          from_e164: normalizedMsg.to_e164,
          to_e164: normalizedMsg.from_e164,
          body: engineResponse.reply_text,
          media_url: engineResponse.media_url,
          correlation_id: normalizedMsg.correlation_id,
          status: 'pending',
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
