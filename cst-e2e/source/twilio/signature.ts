import { Request, Response, NextFunction } from 'express';
import twilio from 'twilio';
import { getEnv } from '../../config/env.js';
import { Logger } from '../../config/logger.js';
import { isTestRunner } from '../../config/runtime.js';

export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  const env = getEnv();
  const twilioSignature = req.headers['x-twilio-signature'] as string;

  // Signature bypass header. Previously `NODE_ENV !== 'production'`, which meant
  // ANY non-production environment (including development, and any environment
  // where .env had been sourced) would accept an unauthenticated webhook that
  // simply set x-test-bypass-signature. Restricted to a test runner, which
  // cannot be armed by setting an environment variable in a deployed service.
  if (isTestRunner() && req.headers['x-test-bypass-signature'] === 'true') {
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
  let url: string;
  if (env.PUBLIC_WEBHOOK_URL) {
    const baseUrl = env.PUBLIC_WEBHOOK_URL.replace(/\/+$/, '');
    const path = req.originalUrl || req.url;
    url = `${baseUrl}${path}`;
  } else {
    const rawProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const protocol = rawProto.split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] as string) || req.headers['host'] || 'localhost:3000';
    url = `${protocol}://${host}${req.originalUrl || req.url}`;
  }

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

export function generateTwilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  return twilio.getExpectedTwilioSignature(authToken, url, params);
}
