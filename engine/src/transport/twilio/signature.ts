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
  // Candidate URLs (8 Nov 2026). Twilio signs the exact URL it was configured
  // with. PUBLIC_WEBHOOK_URL is the base when set, but a number or callback can
  // be pointed at the Render host while PUBLIC_WEBHOOK_URL names another one
  // (or the reverse), and then every request was refused. Each candidate still
  // has to pass the HMAC with the account auth token, so this widens nothing
  // beyond "the URL Twilio actually called".
  const path = req.originalUrl || req.url;
  const rawProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const protocol = rawProto.split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] as string) || req.headers['host'] || 'localhost:3000';
  const candidates: string[] = [];
  if (!isTestRunner() && env.PUBLIC_WEBHOOK_URL) {
    candidates.push(`${env.PUBLIC_WEBHOOK_URL.replace(/\/+$/, '')}${path}`);
  }
  candidates.push(`${protocol}://${host}${path}`);
  if (protocol === 'http') candidates.push(`https://${host}${path}`);

  const authToken = env.TWILIO_AUTH_TOKEN;
  const params = (req.body || {}) as Record<string, string>;

  const isValid = candidates.some((url) => twilio.validateRequest(authToken, twilioSignature, url, params));

  if (!isValid) {
    // Names the URLs tried (never the token or the signature) so a refusal
    // says whether the URL or the token is the thing that does not match.
    Logger.warn('Twilio signature did not match any candidate URL', {
      route: path.split('?')[0],
      tried: candidates.map((u) => u.split('?')[0]),
    });
  }

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
