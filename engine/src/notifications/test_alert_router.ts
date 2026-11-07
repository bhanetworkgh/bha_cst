/**
 * Operator alert test: POST /api/v1/alerts/test
 *
 * Lets an operator prove, on the live service, that CST's Slack alerts reach
 * the right channels through the right Slack app, without waiting for a real
 * failure. It sends clearly labelled TEST alerts through the SAME code paths
 * real alerts use:
 *
 *   - `error`      → ErrorRouter, class CST (SLACK_CST_OPS_WEBHOOK_URL and its
 *                    fallbacks), the path Twilio and application errors take.
 *   - `cs_handoff` → ErrorRouter, class CS_HANDOFF (SLACK_CS_WEBHOOK_URL and its
 *                    fallbacks), the "talk to a person" path.
 *   - `notifier`   → SlackNotifier (SLACK_ERROR_WEBHOOK_URL / SLACK_WEBHOOK_URL),
 *                    the general error-alert path.
 *
 * What this route does NOT do: it changes no call, text, consent, routing or
 * storage behaviour, writes nothing to the database, and calls no provider.
 * It only posts test messages. It is locked behind the programmatic API key
 * (`x-cst-api-key` / CST_API_KEY) and fails closed when that key is unset.
 *
 * The response names each destination and its outcome (sent / deferred /
 * failed), never a webhook URL.
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { requireProgrammaticApiKey } from '../middleware/programmatic_api_key.js';
import { ErrorRouter } from './error_router.js';
import { SlackNotifier } from './slack.js';
import { Logger } from '../config/logger.js';

export const testAlertRouter = Router();

type TestKind = 'error' | 'cs_handoff' | 'notifier';
const ALL_KINDS: TestKind[] = ['error', 'cs_handoff', 'notifier'];

function requestedKinds(body: unknown): TestKind[] | null {
  const raw = (body as { kinds?: unknown } | undefined)?.kinds;
  if (raw === undefined) return ALL_KINDS;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const kinds = raw.filter((k): k is TestKind => ALL_KINDS.includes(k as TestKind));
  return kinds.length === raw.length ? kinds : null;
}

testAlertRouter.post('/api/v1/alerts/test', requireProgrammaticApiKey, async (req: Request, res: Response) => {
  const kinds = requestedKinds(req.body);
  if (!kinds) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: `kinds must be a non-empty list drawn from: ${ALL_KINDS.join(', ')}`,
    });
    return;
  }

  const testId = `alert_test_${randomUUID()}`;
  const requestedBy = typeof req.body?.requested_by === 'string' ? req.body.requested_by.slice(0, 80) : 'operator';
  const label = `TEST ALERT, no action needed (${testId}, requested by ${requestedBy})`;
  const results: Array<Record<string, unknown>> = [];

  for (const kind of kinds) {
    try {
      if (kind === 'notifier') {
        const sent = await SlackNotifier.sendErrorAlert({
          title: 'CST alert test',
          message: label,
          severity: 'WARN',
          service: 'CUSTOMER_TWIN',
          correlation_id: testId,
        });
        results.push({ kind, path: 'SlackNotifier', status: sent ? 'sent' : 'not_sent' });
      } else {
        const result = await ErrorRouter.route(
          {
            service: kind === 'cs_handoff' ? 'CS_HANDOFF' : 'CST',
            category: kind === 'cs_handoff' ? 'cs_handoff' : 'alert_test',
            source: 'alert_test',
            message: label,
            severity: 'WARN',
            correlation_id: testId,
          },
          true,
        );
        results.push({
          kind,
          path: 'ErrorRouter',
          error_class: result.error_class,
          destination_channel: result.destination_channel,
          status: result.status,
          ...(result.error ? { error: result.error.replace(/https?:\/\/\S+/g, '[url]') } : {}),
        });
      }
    } catch (err: any) {
      results.push({ kind, status: 'failed', error: String(err?.message ?? err).replace(/https?:\/\/\S+/g, '[url]') });
    }
  }

  const ok = results.every((r) => r.status === 'sent');
  Logger.info('Alert test run', { test_id: testId, requested_by: requestedBy, ok, results });
  res.status(ok ? 200 : 502).json({ ok, test_id: testId, results });
});
