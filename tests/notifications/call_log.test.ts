import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CallLogPoster,
  buildCallLogMessage,
  buildTranscriptText,
  formatDuration,
  type CallLogInput,
} from '../../engine/src/notifications/call_log.js';

const base: CallLogInput = {
  conversation_id: 'conv_test_1',
  caller_phone: '+19455550100',
  started_unix: 1794122460,
  duration_secs: 78,
  summary: 'Caller asked how to check farm status and was pointed to the vFarm app.',
  lines: [
    { role: 'agent', message: "Hi, you've reached Bays Horizon Network.", time_in_call_secs: 0 },
    { role: 'user', message: 'How do I check my farm status?', time_in_call_secs: 6 },
  ],
  data_collection: { wanted_person: { value: false }, urgent: { value: false } },
  evaluation: {
    answered_from_pages: { result: 'success' },
    handoff_honest: { result: 'unknown' },
    stayed_in_bounds: { result: 'failure' },
  },
};

describe('CST Genie call log card', () => {
  it('builds a readable card with summary, fields and checks, and masks the caller', () => {
    const { text, blocks } = buildCallLogMessage(base);
    expect(blocks[0]).toMatchObject({ type: 'header' });
    expect(blocks[0].text.text).toContain('Call ended');
    const json = JSON.stringify(blocks);
    expect(json).toContain('Caller asked how to check farm status');
    expect(json).toContain('1m 18s');
    expect(json).not.toContain('+19455550100');
    const checks = blocks.find((b) => b.type === 'rich_text');
    expect(checks.elements[1].style).toBe('bullet');
    expect(JSON.stringify(checks)).toContain('Stayed within limits');
    expect(JSON.stringify(checks)).toContain('(not applicable)');
    expect(text).toContain('CST Genie call');
  });

  it('says how the call ended and shows the Call SID, flagging a guardrail cut-off', () => {
    const { blocks } = buildCallLogMessage({ ...base, termination_reason: "Conversation was stopped because the 'No prices, orders or promises' custom guardrail was triggered", call_sid: 'CA123' });
    const json = JSON.stringify(blocks);
    expect(json).toContain('How it ended');
    expect(json).toContain(':warning: Cut off by a safety rule');
    expect(json).toContain('CA123');
    expect(JSON.stringify(buildCallLogMessage({ ...base, termination_reason: 'Call ended by remote party' }).blocks)).toContain('Caller hung up');
  });

  it('flags an urgent call and a person request in the header', () => {
    const urgent = buildCallLogMessage({ ...base, data_collection: { urgent: { value: true }, wanted_person: { value: true }, handoff_sent: { value: true } } });
    expect(urgent.blocks[0].text.text).toContain('Urgent');
    const person = buildCallLogMessage({ ...base, data_collection: { wanted_person: true, handoff_sent: false } });
    expect(person.blocks[0].text.text).toContain('asked for a person');
    expect(JSON.stringify(person.blocks)).toContain('Not sent');
  });

  it('escapes caller-supplied text so it cannot break the Slack markup', () => {
    const { blocks, text } = buildCallLogMessage({ ...base, summary: 'Asked about <!channel> & more', data_collection: { unanswered_question: 'What is <b>this</b>?' } });
    const json = JSON.stringify(blocks);
    expect(text).not.toContain('<!channel>');
    expect(json).toContain('&lt;!channel&gt; &amp; more');
    expect(json).not.toContain('<!channel>');
  });

  it('writes a plain transcript with timestamps and speaker names', () => {
    const t = buildTranscriptText(base);
    expect(t).toContain('[00:06] Caller: How do I check my farm status?');
    expect(t).toContain('[00:00] Genie:');
    expect(t).not.toContain('+19455550100');
    expect(formatDuration(5)).toBe('5s');
  });
});

describe('CallLogPoster delivery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    CallLogPoster.mockHandler = null;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('posts the card, then the transcript file in the thread', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, ts: '111.222' }))
      .mockResolvedValueOnce(json({ ok: true, upload_url: 'https://files.slack.invalid/up', file_id: 'F1' }))
      .mockResolvedValueOnce(new Response('OK', { status: 200 }))
      .mockResolvedValueOnce(json({ ok: true }));
    const result = await CallLogPoster.post(base);
    expect(result).toMatchObject({ posted: true, via: 'bot', ts: '111.222', transcript: 'file' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).channel).toBe('C0BD6D53HAM');
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).thread_ts).toBe('111.222');
  });

  it('falls back to a threaded text transcript when the file upload is refused', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, ts: '111.222' }))
      .mockResolvedValueOnce(json({ ok: false, error: 'missing_scope' }))
      .mockResolvedValueOnce(json({ ok: true, ts: '111.333' }));
    const result = await CallLogPoster.post(base);
    expect(result).toMatchObject({ posted: true, transcript: 'thread_text' });
    expect(result.error).toContain('missing_scope');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).thread_ts).toBe('111.222');
  });

  it('reports ok:false from Slack instead of claiming the post landed', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: 'not_in_channel' }));
    const result = await CallLogPoster.post(base);
    expect(result.posted).toBe(false);
    expect(result.error).toContain('not_in_channel');
  });

  it('uses the customer service webhook when there is no bot token, and checks its answer', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('SLACK_CUSTOMER_SERVICE_WEBHOOK_URL', 'https://hooks.slack.invalid/cs');
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    expect(await CallLogPoster.post(base)).toMatchObject({ posted: true, via: 'webhook', transcript: 'inline' });
    fetchMock.mockResolvedValueOnce(new Response('invalid_blocks', { status: 400 }));
    expect((await CallLogPoster.post(base)).posted).toBe(false);
  });
});
