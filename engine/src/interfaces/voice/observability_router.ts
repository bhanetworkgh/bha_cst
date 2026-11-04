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

      const urlsToCheck: string[] = [];
      if (!isTestRunner() && env.PUBLIC_WEBHOOK_URL) {
        const baseUrl = env.PUBLIC_WEBHOOK_URL.replace(/\/+$/, '');
        urlsToCheck.push(`${baseUrl}${req.originalUrl || req.url}`);
        urlsToCheck.push(`${baseUrl}${req.path}`);
      }

      const rawProto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
      const protocol = rawProto.split(',')[0].trim();
      const host = (req.headers['x-forwarded-host'] as string) || req.headers['host'] || 'localhost:3000';
      urlsToCheck.push(`${protocol}://${host}${req.originalUrl || req.url}`);
      urlsToCheck.push(`${protocol}://${host}${req.path}`);

      const rawBody = (req as any).rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const params = (typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, string>;

      let isValid = false;
      for (const candidateUrl of urlsToCheck) {
        // 1. Standard form params
        if (Object.keys(params).length > 0 && twilio.validateRequest(authToken, twilioSig, candidateUrl, params)) {
          isValid = true;
          break;
        }

        // 2. Direct HMAC on candidateUrl + rawBody (Twilio Event Streams JSON signing)
        if (rawBody) {
          const directHmac = createHmac('sha1', authToken).update(Buffer.from(candidateUrl + rawBody, 'utf-8')).digest('base64');
          if (directHmac === twilioSig) {
            isValid = true;
            break;
          }

          // 3. Twilio validateRequest with rawBody string
          if (twilio.validateRequest(authToken, twilioSig, candidateUrl, rawBody as any)) {
            isValid = true;
            break;
          }

          // 4. Twilio validateRequestWithBody (bodySHA256 query parameter)
          try {
            if (candidateUrl.includes('bodySHA256') && twilio.validateRequestWithBody(authToken, twilioSig, candidateUrl, rawBody)) {
              isValid = true;
              break;
            }
          } catch {
            // ignore url parse error
          }
        }
      }

      if (isValid) {
        FailureDetector.recordTwilioSignature(true);
        return next();
      }

      // If it is specifically an Event Streams test event, admit test probe
      const isTestEvent = Array.isArray(req.body)
        ? req.body.some((e: any) => e.type?.includes('eventstreams.test'))
        : (req.body?.type?.includes('eventstreams.test') || false);

      if (isTestEvent) {
        Logger.info('verifyVoiceEventAuth: Event Streams test probe admitted');
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
      // 1. Twilio Event Streams test probe handler
      const isTestEvent = Array.isArray(req.body)
        ? req.body.some((e: any) => e.type?.includes('eventstreams.test'))
        : (req.body?.type?.includes('eventstreams.test') || false);

      if (isTestEvent) {
        Logger.info('Twilio Event Streams: sink verification test event acknowledged');
        res.status(200).json({ status: 'ok', message: 'Twilio Event Streams test sink verified' });
        return;
      }

      // 2. Twilio Event Streams (Single CloudEvent object or Array of CloudEvents)
      const isCloudEvent = Array.isArray(req.body) || (typeof req.body === 'object' && req.body !== null && typeof req.body.type === 'string' && req.body.type.startsWith('com.twilio.'));

      if (isCloudEvent) {
        const events = Array.isArray(req.body) ? req.body : [req.body];
        const results = [];
        for (const event of events) {
          const eventType = event.type || '';
          if (eventType.includes('voice') || eventType.includes('call')) {
            const data = event.data || {};
            // Supports both Voice.WebhookEvent (request.parameters) and VoiceInsights.CallSummary
            const params = data.request?.parameters || data.parameters || {};

            const callSid = params.CallSid || data.call_sid || data.sid || data.CallSid;
            const fromNumber = params.From || (typeof data.from === 'object' ? data.from.caller || data.from.from : data.from) || data.From;
            const toNumber = params.To || (typeof data.to === 'object' ? data.to.callee || data.to.to : data.to) || data.To;
            const rawStatus = (params.CallStatus || data.call_state || data.call_status || data.CallStatus || 'completed').toLowerCase();
            const duration = params.CallDuration || data.duration || data.connect_duration || data.CallDuration;
            const errorCode = params.ErrorCode || data.error_code || data.ErrorCode;
            const errorMessage = params.ErrorMessage || data.error_message || data.ErrorMessage;
            const sequenceNumber = params.SequenceNumber || data.sequence_number || data.SequenceNumber;
            const timestamp = event.time || data.timestamp || new Date().toISOString();

            if (callSid) {
              const normalizedStatusPayload = {
                CallSid: callSid,
                From: fromNumber,
                To: toNumber,
                CallStatus: rawStatus,
                CallDuration: duration,
                ErrorCode: errorCode,
                ErrorMessage: errorMessage,
                SequenceNumber: sequenceNumber,
                Timestamp: timestamp,
              };

              const r = await VoiceEventCaptureService.captureStatusCallback(normalizedStatusPayload);
              results.push(r);
            }
          }
        }
        res.status(200).json({ status: 'ok', processed_events: results.length, results });
        return;
      }

      // 3. Standard single callback payload
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

