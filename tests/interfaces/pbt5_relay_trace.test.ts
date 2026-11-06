import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { elevenlabsWebhookRouter } from '../../engine/src/interfaces/elevenlabs/index.js';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { DbClient } from '../../engine/src/db/client.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { CstDashboardPublisher, setActiveDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import { CutOverManager } from '../../engine/src/observability/cut_over.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { createRelayTrace, withRelayTrace, traceRelay } from '../../engine/src/observability/relay_trace.js';
import { collectSlackReceipt, readDispatchEvidence } from '../../scripts/pbt5_slack_receipt.mjs';

describe('PBT5 passive relay evidence (all I/O mocked)', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let query: ReturnType<typeof vi.fn>;
  let network: ReturnType<typeof vi.fn>;
  const app = express();
  app.use(express.json());
  app.use('/webhooks/elevenlabs', elevenlabsWebhookRouter);
  const traces = () => log.mock.calls.flatMap(([line]) => {
    try { const row = JSON.parse(String(line)); return row.trace_schema ? [row] : []; } catch { return []; }
  });
  const post = (id = 'conv_trace_1', traced = true) => {
    const payload = {
      type: 'post_call_transcription', event_timestamp: Math.floor(Date.now() / 1000),
      data: {
        conversation_id: id, transcript: [{ role: 'agent', message: null }, { role: 'user', message: 'A test question' }],
        metadata: { phone_call: { call_sid: 'CA123', external_number: '+12025550123' }, call_duration_secs: 12 },
      },
    };
    const body = JSON.stringify(payload);
    vi.stubEnv('CST_RELAY_TRACE', traced ? 'true' : 'false');
    return request(app).post('/webhooks/elevenlabs/post-call')
      .set('x-elevenlabs-request-id', 'provider_request_1')
      .set('elevenlabs-signature', createHmac('sha256', 'test-secret').update(body).digest('hex'))
      .send(payload);
  };

  beforeEach(() => {
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', 'test-secret');
    vi.stubEnv('SLACK_CS_WEBHOOK_URL', 'https://slack.invalid/webhook');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    network = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', network);
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    DbClient.setPool({ query } as any);
    DbClient.clearInMemory();
    ErrorRouter.reset();
    ElevenLabsWebhookService.reset();
    FailureDetector.reset();
    CutOverManager.reset();
    setActiveDashboardPublisher(new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.invalid/events', dashboardKey: 'test-key', dryRun: false, fetchFn: network as any,
    }));
  });

  afterEach(() => {
    DbClient.setPool(null);
    setActiveDashboardPublisher(null);
    ErrorRouter.reset();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  });

  it('joins provider, receive, successful INSERT rows, dispatch and exact observed Slack message', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body.slack_delivered).toBe(true);
    expect(response.body.events_count).toBe(3);
    const rows = traces();
    const attempt = rows.find((r) => r.stage === 'slack_dispatch_attempt');
    expect(attempt.provider_request_id).toBe('provider_request_1');
    expect(attempt.provider_call_sid).toBe('CA123');
    expect(attempt.provider_conversation_id).toBe('conv_trace_1');
    expect(attempt.webhook_receive_id).toBe(response.headers['x-cst-webhook-receive-id']);
    expect(attempt.committed_rows).toHaveLength(4); // 3 internal events + dashboard outcome
    expect(rows.filter((r) => r.stage === 'db_write').every((r) => r.persistence === 'committed')).toBe(true);
    const sqlIds = query.mock.calls.map(([, args]) => args[0]);
    expect(attempt.committed_rows.every((r: any) => sqlIds.includes(r.db_row_id))).toBe(true);
    const slackCall = network.mock.calls.find(([url]) => url === 'https://slack.invalid/webhook');
    const slackBody = JSON.parse(slackCall![1].body);
    expect(slackBody.text).toContain(`[PBT5 trace: ${attempt.dispatch_id}]`);
    expect(slackBody.channel).toBe('#bha-customer-service-twin');
    const evidence = readDispatchEvidence(rows.map((r) => JSON.stringify(r)).join('\n'), attempt.dispatch_id);
    const reads = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, messages: [{ bot_id: 'B123', ts: '100.001', text: slackBody.text }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, permalink: 'https://example.slack.com/archives/C123/p100001' })));
    const receipt = await collectSlackReceipt({ evidence, channel: 'C123', botId: 'B123', oldest: '99', latest: '101', token: 'read-test', fetchFn: reads });
    expect(receipt.slack_message_id).toBe('100.001');
    expect(receipt.dispatch_text_matches).toBe(true);
    expect(receipt.committed_rows).toEqual(attempt.committed_rows);
    expect(receipt.review_required).toBe(true);
    expect(reads.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('test-secret');
    expect(JSON.stringify(rows)).not.toContain('+12025550123');
    expect(JSON.stringify(rows)).not.toContain('A test question');
    expect(JSON.stringify(rows)).not.toContain('https://slack.invalid');
  });

  it('does not mistake failed or memory-only writes for committed rows, without changing webhook handling', async () => {
    query.mockRejectedValue(new Error('test DB failure'));
    const failed = await post('conv_failed');
    expect(failed.status).toBe(200); // Existing behavior intentionally retained.
    expect(failed.body.slack_delivered).toBe(true);
    expect(traces().filter((r) => r.stage === 'db_write').every((r) => r.persistence === 'failed')).toBe(true);
    const attempt = traces().find((r) => r.stage === 'slack_dispatch_attempt');
    expect(attempt.committed_rows).toEqual([]);
    expect(() => readDispatchEvidence(traces().map((r) => JSON.stringify(r)).join('\n'), attempt.dispatch_id)).toThrow('Committed DB');
    log.mockClear(); DbClient.setPool(null);
    await post('conv_memory');
    expect(traces().filter((r) => r.stage === 'db_write').every((r) => r.persistence === 'memory_only')).toBe(true);
  });

  it('leaves disabled payload and response unchanged, without trace logs or a Slack marker', async () => {
    const response = await post('conv_off', false);
    expect(response.status).toBe(200);
    expect(response.headers['x-cst-webhook-receive-id']).toBeUndefined();
    expect(traces()).toEqual([]);
    const body = JSON.parse(network.mock.calls.find(([url]) => url === 'https://slack.invalid/webhook')![1].body);
    expect(body.text).not.toContain('PBT5 trace');
    expect(body.correlation_id).toBe('conv_off');
  });

  it('retains duplicate suppression and does not manufacture a second dispatch', async () => {
    await post();
    const count = network.mock.calls.length;
    const duplicate = await post();
    expect(duplicate.body.status).toBe('already_processed');
    expect(network.mock.calls).toHaveLength(count);
    expect(traces().filter((r) => r.stage === 'slack_dispatch_attempt')).toHaveLength(1);
  });

  it('retains Slack failure behavior with one attempt and no false exact-message receipt', async () => {
    network.mockImplementation(async (url) => new Response(url === 'https://slack.invalid/webhook' ? 'invalid_payload' : '{}', { status: url === 'https://slack.invalid/webhook' ? 400 : 200 }));
    const result = await post();
    expect(result.status).toBe(200);
    expect(result.body.slack_delivered).toBe(false);
    expect(network.mock.calls.filter(([url]) => url === 'https://slack.invalid/webhook')).toHaveLength(1);
    const dispatch = traces().find((r) => r.stage === 'slack_dispatch_result');
    expect(dispatch.http_status).toBe(400);
    expect(dispatch.slack_message_id).toBeNull();
  });

  it('isolates simultaneous receive contexts and reports absent provider request IDs honestly', async () => {
    const a = createRelayTrace('{}'); const b = createRelayTrace('{}', 'provider_b', 'x-request-id');
    await Promise.all([a, b].map((trace) => withRelayTrace(trace, async () => {
      await Promise.resolve(); traceRelay('isolated');
    })));
    const rows = traces();
    expect(rows.find((r) => r.webhook_receive_id === a.webhook_receive_id).provider_request_id).toBeNull();
    expect(rows.find((r) => r.webhook_receive_id === b.webhook_receive_id).provider_request_id).toBe('provider_b');
    expect(createRelayTrace('{}', 'https://secret.invalid/path').provider_request_id).toBeNull();
  });

  it('rejects ambiguous, wrong-bot, edited or rate-limited Slack observations', async () => {
    const evidence = { dispatch_id: 'dispatch_00000000-0000-0000-0000-000000000000' };
    const message = { bot_id: 'B123', ts: '100.001', text: `text\n[PBT5 trace: ${evidence.dispatch_id}]` };
    const options = { evidence, channel: 'C123', botId: 'B123', oldest: '99', latest: '101', token: 'read-test' };
    for (const messages of [[message, message], [{ ...message, bot_id: 'BOTHER' }], [{ ...message, edited: {} }]]) {
      const reads = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, messages })));
      await expect(collectSlackReceipt({ ...options, fetchFn: reads })).rejects.toThrow();
      expect(reads).toHaveBeenCalledTimes(1);
    }
    const limited = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    await expect(collectSlackReceipt({ ...options, fetchFn: limited })).rejects.toThrow('429');
    expect(limited).toHaveBeenCalledTimes(1);
  });

  it('reads every history page before deciding uniqueness and rejects incomplete pagination', async () => {
    const evidence = { dispatch_id: 'dispatch_00000000-0000-0000-0000-000000000000' };
    const message = { bot_id: 'B123', ts: '100.001', text: `text\n[PBT5 trace: ${evidence.dispatch_id}]` };
    const options = { evidence, channel: 'C123', botId: 'B123', oldest: '99', latest: '101', token: 'read-test' };
    const pages = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, messages: [message], response_metadata: { next_cursor: 'next' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, messages: [message] })));
    await expect(collectSlackReceipt({ ...options, fetchFn: pages })).rejects.toThrow('exactly one');
    expect(pages).toHaveBeenCalledTimes(2);
    const incomplete = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, messages: [message], has_more: true })));
    await expect(collectSlackReceipt({ ...options, fetchFn: incomplete })).rejects.toThrow('Incomplete');
  });
});
