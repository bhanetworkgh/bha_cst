import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { Logger } from '../config/logger.js';

export const researchTwinWebhookRouter = Router();

const MAX_TIMESTAMP_DRIFT_SECONDS = 300;

export function verifyResearchTwinSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  try {
    const cleanHeader = signatureHeader.replace(/^sha256=/i, '').trim();
    const expectedSig = createHmac('sha256', secret).update(rawBody).digest('hex');
    const headerBuf = Buffer.from(cleanHeader, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    if (headerBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(headerBuf, expectedBuf);
  } catch {
    return false;
  }
}

researchTwinWebhookRouter.post('/callback', (req: Request, res: Response) => {
  const secret = process.env.RT_CALLBACK_SIGNING_SECRET;
  if (!secret) {
    Logger.error('Research Twin webhook called but RT_CALLBACK_SIGNING_SECRET is not configured');
    res.status(503).json({
      error: 'CONFIG_MISSING',
      message: 'RT_CALLBACK_SIGNING_SECRET is not configured',
    });
    return;
  }

  const sigHeader = (req.header('x-rt-signature') || req.header('x-signature') || '') as string;
  if (!sigHeader) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Missing X-RT-Signature header',
    });
    return;
  }

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const isValid = verifyResearchTwinSignature(rawBody, sigHeader, secret);
  if (!isValid) {
    Logger.warn('Research Twin webhook rejected: invalid HMAC signature');
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Invalid HMAC signature',
    });
    return;
  }

  const payload = req.body || {};
  const timestamp = payload.timestamp || payload.occurred_at;
  if (timestamp) {
    const eventTime = Date.parse(timestamp);
    if (!isNaN(eventTime)) {
      const now = Date.now();
      const diffSec = Math.abs(now - eventTime) / 1000;
      if (diffSec > MAX_TIMESTAMP_DRIFT_SECONDS) {
        Logger.warn(`Research Twin webhook rejected: timestamp drift ${diffSec}s exceeds limit`);
        res.status(400).json({
          error: 'REPLAY_DETECTED',
          message: `Payload timestamp is outside the ${MAX_TIMESTAMP_DRIFT_SECONDS}s acceptance window`,
        });
        return;
      }
    }
  }

  const investigationId = payload.investigation_id || payload.id || 'unknown';
  const status = payload.status || 'updated';

  Logger.info(`Research Twin callback verified: investigation ${investigationId} status ${status}`);

  res.status(200).json({
    status: 'received',
    investigation_id: investigationId,
    verified: true,
    processed_at: new Date().toISOString(),
  });
});

