/**
 * Voice Observability Webhook Router (PBT5 / LOOP-1793729831162-PBT5)
 *
 * Dedicated ingestion routes for Twilio and ElevenLabs voice inbound call
 * and call status callback events.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import { Logger } from '../../config/logger.js';
import { getEnv } from '../../config/env.js';
import { isTestRunner } from '../../config/runtime.js';
import { VoiceEventCaptureService } from '../../observability/voice_events.js';
import { FailureDetector } from '../../observability/failure_detector.js';

export const voiceObservabilityRouter = Router();

/**
 * Multi-provider authentication guard for voice observability webhooks.
 * Supports Twilio signatures, ElevenLabs HMAC signatures, and CST API keys.
 */
export function verifyVoiceEventAuth(req: Request, res: Response, next: NextFunction): void {
  // 1. Test runner bypass header
  if (isTestRunner() && req.headers['x-test-bypass-signature'] === 'true') {
    return next();
  }

  const twilioSig = (req.headers['x-twilio-signature'] as string || '').trim();
  const elevenlabsSig = (req.headers['elevenlabs-signature'] || req.headers['x-elevenlabs-signature'] || '') as string;
  const apiKeyHeader = (req.headers['x-cst-api-key'] || req.headers['x-webhook-secret'] || '') as string;
  const authHeader = (req.headers['authorization'] || '') as string;

  // Case A: Twilio Signature Verification
  if (twilioSig) {
    try {
      const env = getEnv();
      const authToken = env.TWILIO_AUTH_TOKEN;

      let url: string;
      if (!isTestRunner() && env.PUBLIC_WEBHOOK_URL) {
        const baseUrl = env.PUBLIC_WEBHOOK_URL.replace(/\/+$/, '');
        const path = req.originalUrl || req.url;
        url = `${baseUrl}${path}`;
      } else {
        const rawProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
        const protocol = rawProto.split(',')[0].trim();
        const host = (req.headers['x-forwarded-host'] as string) || req.headers['host'] || 'localhost:3000';
        url = `${protocol}://${host}${req.originalUrl || req.url}`;
      }

      const params = (req.body || {}) as Record<string, string>;
      const isValid = twilio.validateRequest(authToken, twilioSig, url, params);

      if (isValid) {
        FailureDetector.recordTwilioSignature(true);
        return next();
      }

      FailureDetector.recordTwilioSignature(false);
      res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid Twilio signature' });
      return;
    } catch (err: any) {
      Logger.warn(`verifyVoiceEventAuth: Twilio validation error: ${err.message}`);
    }
  }

  // Case B: ElevenLabs Signature Verification (HMAC-SHA256)
  if (elevenlabsSig) {
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET || process.env.CST_API_KEY;
    if (secret) {
      try {
        const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const expectedHmac = createHmac('sha256', secret).update(rawBody).digest('hex');
        const signature = elevenlabsSig.startsWith('sha256=') ? elevenlabsSig.slice(7) : elevenlabsSig;

        if (signature.length === expectedHmac.length) {
          const match = timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedHmac, 'utf8'));
          if (match) {
            FailureDetector.recordWebhookAuthSuccess();
            return next();
          }
        }
      } catch (err: any) {
        Logger.warn(`verifyVoiceEventAuth: ElevenLabs signature verification error: ${err.message}`);
      }
    }
    FailureDetector.recordWebhookAuthFailure('Invalid ElevenLabs signature');
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid ElevenLabs signature' });
    return;
  }

  // Case C: Shared Secret / API Key
  const secretKey = process.env.CST_API_KEY || process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (secretKey) {
    if (apiKeyHeader && apiKeyHeader.length === secretKey.length) {
      if (timingSafeEqual(Buffer.from(apiKeyHeader, 'utf8'), Buffer.from(secretKey, 'utf8'))) {
        return next();
      }
    }
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (token.length === secretKey.length && timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(secretKey, 'utf8'))) {
        return next();
      }
    }
  }

  // If none matched, reject safely
  FailureDetector.recordWebhookAuthFailure('Missing or invalid authentication signature/key');
  res.status(401).json({
    error: 'UNAUTHORIZED',
    message: 'Missing or invalid authentication credentials (X-Twilio-Signature, ElevenLabs-Signature, or CST-API-Key required)',
  });
}

// ── Inbound Voice Call Routes ───────────────────────────────────────────────
const inboundPaths = ['/inbound', '/inbound-call', '/twilio/inbound', '/elevenlabs/inbound'];
inboundPaths.forEach((path) => {
  voiceObservabilityRouter.post(path, verifyVoiceEventAuth, async (req: Request, res: Response) => {
    try {
      const result = await VoiceEventCaptureService.captureInboundCall(req.body);

      if (result.status === 'refused') {
        res.status(403).json(result);
        return;
      }

      if (result.status === 'failed') {
        res.status(500).json(result);
        return;
      }

      res.status(200).json(result);
    } catch (err: any) {
      Logger.error(`voiceObservabilityRouter: inbound handler exception: ${err.message}`);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
    }
  });
});

// ── Voice Status Callback Routes ────────────────────────────────────────────
const statusPaths = ['/status', '/status-callback', '/twilio/status', '/elevenlabs/status'];
statusPaths.forEach((path) => {
  voiceObservabilityRouter.post(path, verifyVoiceEventAuth, async (req: Request, res: Response) => {
    try {
      const result = await VoiceEventCaptureService.captureStatusCallback(req.body);

      if (result.status === 'refused') {
        res.status(403).json(result);
        return;
      }

      if (result.status === 'unsupported_status') {
        res.status(422).json(result);
        return;
      }

      if (result.status === 'failed') {
        res.status(500).json(result);
        return;
      }

      res.status(200).json(result);
    } catch (err: any) {
      Logger.error(`voiceObservabilityRouter: status handler exception: ${err.message}`);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
    }
  });
});

// ── Retry Slack Publications Endpoint ───────────────────────────────────────
voiceObservabilityRouter.post('/retry-slack', async (_req: Request, res: Response) => {
  try {
    const retriedCount = await VoiceEventCaptureService.retryFailedSlackDeliveries();
    res.status(200).json({
      status: 'ok',
      retried_count: retriedCount,
      remaining_failed: VoiceEventCaptureService.getFailedSlackDeliveries().length,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'RETRY_FAILED', message: err.message });
  }
});

