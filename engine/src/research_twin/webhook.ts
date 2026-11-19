import { Router, Request, Response } from 'express';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';
import { ResearchTwinInboundCallbackSchema } from './schemas.js';

export const researchTwinWebhookRouter = Router();

const MAX_TIMESTAMP_DRIFT_SECONDS = 300;
const processedCallbackEventIds = new Set<string>();

/**
 * Reset callback idempotency cache (for testing).
 */
export function resetCallbackDeduplication(): void {
  processedCallbackEventIds.clear();
}

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

researchTwinWebhookRouter.post('/callback', async (req: Request, res: Response): Promise<void> => {
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

  const rawBody = (req as any).rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  const isValid = verifyResearchTwinSignature(rawBody, sigHeader, secret);
  if (!isValid) {
    Logger.warn('Research Twin webhook rejected: invalid HMAC signature');
    res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Invalid HMAC signature',
    });
    return;
  }

  const rawPayload = req.body || {};
  const timestamp = rawPayload.timestamp || rawPayload.occurred_at || rawPayload.observed_at;
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

  const parsed = ResearchTwinInboundCallbackSchema.safeParse(rawPayload);
  const callbackData = parsed.success ? parsed.data : rawPayload;
  const investigationId = callbackData.investigation_id || callbackData.id || 'unknown';
  const status = callbackData.lifecycle_status || callbackData.status || 'updated';
  const externalEventId = callbackData.external_event_id || `evt_${randomUUID()}`;

  // Idempotency: check duplicate callback event ID
  if (processedCallbackEventIds.has(externalEventId)) {
    Logger.info(`Research Twin callback: duplicate external event ${externalEventId} ignored`);
    res.status(200).json({
      status: 'received',
      investigation_id: investigationId,
      duplicate: true,
      verified: true,
      processed_at: new Date().toISOString(),
    });
    return;
  }
  processedCallbackEventIds.add(externalEventId);

  // Durable persistence into dashboard_publish_outcomes
  const callbackRowId = `dpo_rt_cb_${randomUUID()}`;
  try {
    await DbClient.recordDashboardPublishOutcome({
      id: callbackRowId,
      event_id: externalEventId,
      event_type: 'cst.research_twin.callback',
      specversion: 'cst.event.v1',
      correlation_id: investigationId,
      tenant_id: callbackData.tenant_id || 'tenant-vfarm-01',
      project_id: callbackData.project_id || 'proj-vfarm-main',
      status: 'internal_only',
      attempts: 1,
      payload: {
        investigation_id: investigationId,
        lifecycle_status: status,
        assignment: callbackData.assignment ?? null,
        notes: callbackData.notes ?? null,
        observed_at: callbackData.observed_at,
        details: callbackData.details ?? null,
      },
    });
  } catch (dbErr: any) {
    Logger.warn(`Research Twin callback: failed to persist outcome: ${dbErr?.message}`);
  }

  Logger.info(`Research Twin callback verified: investigation ${investigationId} status ${status}`);

  res.status(200).json({
    status: 'received',
    investigation_id: investigationId,
    verified: true,
    processed_at: new Date().toISOString(),
  });
});
