import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { getEnv } from '../../config/env.js';
import { Logger } from '../../config/logger.js';

export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  const env = getEnv();
  const twilioSignature = req.headers['x-twilio-signature'] as string;

  // Allow explicit test signature bypass header in dev/test environment for testing
  if (process.env.NODE_ENV !== 'production' && req.headers['x-test-bypass-signature'] === 'true') {
    return next();
  }

  if (!twilioSignature) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'twilio_webhook',
      role: 'unauthenticated',
      entry_point: 'webhook',
      tool_or_route: req.originalUrl || req.path,
      outcome: 'refused',
      reason: 'Missing X-Twilio-Signature header (rejected before DB access)',
    });
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing Twilio signature header' });
    return;
  }

  // Construct full request URL including protocol and host
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['host'] || 'localhost:3000';
  const url = `${protocol}://${host}${req.originalUrl || req.url}`;

  const authToken = env.TWILIO_AUTH_TOKEN;
  const params = (req.body || {}) as Record<string, string>;

  const isValid = twilio.validateRequest(authToken, twilioSignature, url, params);

  if (!isValid) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'twilio_webhook',
      role: 'unauthenticated',
      entry_point: 'webhook',
      tool_or_route: req.originalUrl || req.path,
      outcome: 'refused',
      reason: 'Invalid X-Twilio-Signature (rejected before DB access)',
    });
    res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid Twilio signature' });
    return;
  }

  next();
}
