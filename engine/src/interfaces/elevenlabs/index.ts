import { Router, Request, Response } from 'express';
import { ElevenLabsPostCallWebhookPayloadSchema } from './schemas.js';
import { ElevenLabsWebhookService } from './service.js';
import { FailureDetector } from '../../observability/failure_detector.js';
import { createRelayTrace, traceRelay, withRelayTrace } from '../../observability/relay_trace.js';

export const elevenlabsWebhookRouter = Router();

/**
 * POST /webhooks/elevenlabs/post-call
 * Ingests completed call/chat transcripts, normalizes to cst.event.v1, persists, and publishes to Slack.
 */
elevenlabsWebhookRouter.post('/post-call', async (req: Request, res: Response): Promise<void> => {
  // 1. Authenticate webhook
  const rawBody = (req as any).rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  const providerHeader = req.header('x-elevenlabs-request-id') ? 'x-elevenlabs-request-id' : 'x-request-id';
  const trace = process.env.CST_RELAY_TRACE === 'true'
    ? createRelayTrace(rawBody, req.header(providerHeader), providerHeader)
    : undefined;
  const isAuthenticated = ElevenLabsWebhookService.authenticate(req, rawBody);
  if (!isAuthenticated) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Invalid webhook signature or missing webhook secret',
    });
    return;
  }

  // 2. Validate payload shape
  const parseResult = ElevenLabsPostCallWebhookPayloadSchema.safeParse(req.body);
  if (!parseResult.success) {
    FailureDetector.recordWebhookValidationFailure(parseResult.error.format());
    res.status(400).json({
      error: 'INVALID_PAYLOAD',
      message: 'Payload failed ElevenLabs post-call validation',
      details: parseResult.error.issues,
    });
    return;
  }

  // 3. Process webhook through service
  try {
    const outcome = trace
      ? await withRelayTrace(trace, async () => {
        traceRelay('webhook_receive', { authenticated: true, validated: true });
        res.setHeader('X-CST-Webhook-Receive-ID', trace.webhook_receive_id);
        const result = await ElevenLabsWebhookService.process(parseResult.data);
        traceRelay('webhook_result', {
          processing_status: result.status,
          event_ids: result.event_ids,
          slack_delivered: result.slack_delivered,
          dashboard_published: result.dashboard_published ?? null,
          response_status: result.status === 'failed' ? 500 : 200,
        });
        return result;
      })
      : await ElevenLabsWebhookService.process(parseResult.data);
    if (outcome.status === 'failed') {
      res.status(500).json({
        error: 'PROCESSING_FAILED',
        message: outcome.error || 'Failed to process post-call interaction',
        conversation_id: outcome.conversation_id,
      });
      return;
    }

    res.status(200).json(outcome);
  } catch (err: any) {
    FailureDetector.recordWebhookProcessingFailure(err?.message);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: err?.message || 'Unexpected error processing webhook',
    });
  }
});

/**
 * GET /webhooks/elevenlabs/health
 * Failure detection and operational health check for ElevenLabs webhook subsystem.
 */
elevenlabsWebhookRouter.get('/health', (_req: Request, res: Response) => {
  const report = FailureDetector.getHealthReport();
  const statusCode = report.readiness === 'unready' ? 503 : 200;
  res.status(statusCode).json({
    service: 'elevenlabs_webhook_receiver',
    status: report.subsystems.elevenlabs_webhook.status,
    metrics: report.subsystems.elevenlabs_webhook.metrics,
    overall_readiness: report.readiness,
  });
});
