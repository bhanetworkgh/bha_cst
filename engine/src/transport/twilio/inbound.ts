import { Router, Request, Response } from 'express';
import { verifyTwilioSignature } from './signature.js';
import { SystemsRegistry } from '../../systems/registry.js';
import { enforceTenancyGate } from '../../middleware/tenancy.js';
import { normalizeTwilioInbound } from './normalize.js';
import { DbClient } from '../../db/client.js';
import { IdentityResolver } from '../../identity/resolver.js';
import { IntentRouter } from '../../router/index.js';
import { Logger } from '../../config/logger.js';
import { processOutboundQueue } from './outbound.js';

export const inboundRouter = Router();

// Middleware 1: Twilio Signature Verification (MUST happen BEFORE DB touch)
inboundRouter.post('/twilio/sms', verifyTwilioSignature);

// Middleware 2: Server-side receiving-number tenancy resolution (MUST happen BEFORE DB touch)
inboundRouter.post('/twilio/sms', (req: Request, res: Response, next) => {
  const receivingNumber = (req.body?.To as string || '').trim();

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

  const system = SystemsRegistry.resolveSystemByPhoneNumber(receivingNumber);

  if (!system) {
    // Unknown receiving number: refuse + log + no DB touch + no reply (TEST 3)
    res.status(404).json({ error: 'SYSTEM_NOT_FOUND', message: 'Unknown receiving number' });
    return;
  }

  // Attach server-resolved tenancy context to request
  req.tenancy = {
    tenant_id: system.tenant_id,
    system_id: system.system_id,
    role: 'customer_ingress',
    scope_resolved_by: 'receiving_number',
  };

  next();
});

// Middleware 3: Shared Tenancy Gate
inboundRouter.post('/twilio/sms', enforceTenancyGate);

// Handler: Message normalization, deduplication, fast 204 return, async enqueue & handle()
inboundRouter.post('/twilio/sms', async (req: Request, res: Response) => {
  try {
    const tenancy = req.tenancy!;
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

    // Return HTTP 204 quickly to Twilio before async processing
    res.status(204).send();

    // Async pipeline processing (decoupled from HTTP response loop)
    setImmediate(async () => {
      try {
        const system = SystemsRegistry.getSystemById(tenancy.system_id)!;
        const identity = await IdentityResolver.resolveSenderIdentity(
          normalizedMsg.from_e164,
          system
        );

        await IntentRouter.routeAndHandle(normalizedMsg, identity);

        // Process outbound worker after handler enqueues message
        await processOutboundQueue();
      } catch (err: any) {
        Logger.error(`Async message handler error: ${err.message}`, {
          message_id: normalizedMsg.message_id,
          tenant_id: tenancy.tenant_id,
        });
      }
    });
  } catch (err: any) {
    Logger.error(`Webhook handling failure: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  }
});
