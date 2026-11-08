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
 * storage behaviour, writes nothing to CST's database, and calls no provider.
 * It posts test messages, then writes ONE record of the run to the engine
 * dashboard (`cst_alert_test_run` on /api/engine/events, 8 Nov 2026, Jason:
 * test-alert routes as canonical data, not only a server log). The record's
 * outcome comes back on the response as `recorded`; a record that does not land
 * never changes what the alerts did, and the response says why. It is locked behind the programmatic API key
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

export interface AlertTestRecord {
  test_id: string;
  requested_by: string;
  ok: boolean;
  results: Array<Record<string, unknown>>;
  at: string;
}
export interface RecordOutcome { recorded: boolean; error?: string }

/** The events route beside the cst-events URL CST already posts to. */
export function engineEventsUrl(cstEventsUrl: string): string {
  return new URL('/api/engine/events', cstEventsUrl).toString();
}

export const AlertTestRecorder = {
  /** Tests set this; nothing reaches the network while it is set. */
  mockHandler: null as null | ((r: AlertTestRecord) => RecordOutcome | Promise<RecordOutcome>),
  async record(r: AlertTestRecord): Promise<RecordOutcome> {
    if (this.mockHandler) return this.mockHandler(r);
    if (process.env.VITEST === 'true') return { recorded: false, error: 'not sent under test' };
    const url = process.env.ENGINE_DASHBOARD_URL;
    const key = process.env.ENGINE_DASHBOARD_KEY;
    if (!url || !key) return { recorded: false, error: `not configured: ${!url ? 'ENGINE_DASHBOARD_URL' : 'ENGINE_DASHBOARD_KEY'} is not set` };
    try {
      const res = await fetch(engineEventsUrl(url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dashboard-key': key },
        body: JSON.stringify({
          event_type: 'cst_alert_test_run',
          at: r.at,
          subject_id: r.test_id,
          lane: 'CST',
          actor: r.requested_by,
          source_ref: 'POST /api/v1/alerts/test',
          dedupe_key: `cst_alert_test_run:${r.test_id}`,
          detail: { ok: r.ok, results: r.results, proof_type: 'test_forced' },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { recorded: false, error: `dashboard answered ${res.status}: ${(await res.text()).slice(0, 200)}` };
      return { recorded: true };
    } catch (err: any) {
      return { recorded: false, error: String(err?.message ?? err) };
    }
  },
};

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
  const record = await AlertTestRecorder.record({ test_id: testId, requested_by: requestedBy, ok, results, at: new Date().toISOString() });
  if (!record.recorded) Logger.error(`Alert test ${testId} was not recorded on the dashboard: ${record.error}`);
  Logger.info('Alert test run', { test_id: testId, requested_by: requestedBy, ok, results, recorded: record.recorded });
  res.status(ok ? 200 : 502).json({ ok, test_id: testId, results, recorded: record.recorded, ...(record.error ? { record_error: record.error } : {}) });
});
