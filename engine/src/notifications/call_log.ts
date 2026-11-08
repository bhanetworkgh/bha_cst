/**
 * Call log: one post per finished CST Genie call in #bha-customer-service-twin,
 * from the CS Twin app (8 Nov 2026, Destiny).
 *
 * The main message is a Block Kit card: who called (number masked), how long,
 * a short summary, whether they wanted a person and whether that went
 * through, anything Genie could not answer, and how the call scored. The full
 * transcript goes in the thread as a text file, so the channel stays readable.
 *
 * Delivery is checked, never assumed. With SLACK_BOT_TOKEN the card is posted
 * with chat.postMessage and every Slack answer is read for ok:false. If the
 * file upload is refused (for example a missing files:write scope) the
 * transcript is posted in the thread as text instead. Without a bot token the
 * card goes through the customer service webhook with the transcript inline.
 * A failure is returned to the caller, which reports it to CST ops; it never
 * throws into the webhook.
 */

import { createHash, randomUUID } from 'node:crypto';
import { maskPhone } from '../util/privacy.js';
import { currentRelayTrace, traceRelay } from '../observability/relay_trace.js';

export const CALL_LOG_DEFAULT_CHANNEL = 'C0BD6D53HAM';

export interface CallLogLine {
  role: 'user' | 'agent' | 'system';
  message: string;
  time_in_call_secs?: number;
}

export interface CallLogInput {
  conversation_id: string;
  caller_phone: string;
  started_unix?: number;
  duration_secs: number;
  summary?: string;
  lines: CallLogLine[];
  data_collection?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
}

export interface CallLogResult {
  posted: boolean;
  via: 'bot' | 'webhook' | 'none';
  ts?: string;
  transcript: 'file' | 'thread_text' | 'inline' | 'none' | 'failed';
  error?: string;
}

/* The four checks set on the agent on 8 Nov 2026, in the order they read best. */
const CHECK_LABELS: Record<string, string> = {
  answered_from_pages: 'Answered from help pages only',
  handoff_honest: 'Person handoff done honestly',
  stayed_in_bounds: 'Stayed within limits',
  urgent_handled: 'Urgent safety handled',
};

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A data collection result arrives as { value, rationale } or as a bare value. */
export function collected(data: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!data) return undefined;
  for (const key of keys) {
    const raw = data[key] as any;
    const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

const truthy = (v: unknown): boolean => v === true || String(v).toLowerCase() === 'true';

export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

export function formatClock(secs: number | undefined): string {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function newYorkTime(unix?: number): string {
  const when = unix ? new Date(unix * 1000) : new Date();
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(when);
}

/** Plain text transcript for the thread file. */
export function buildTranscriptText(input: CallLogInput): string {
  const head = [
    'CST Genie call transcript',
    `Conversation: ${input.conversation_id}`,
    `Caller: ${maskPhone(input.caller_phone)}`,
    `Started: ${newYorkTime(input.started_unix)} New York`,
    `Length: ${formatDuration(input.duration_secs)}`,
    '',
  ];
  const body = input.lines.map((l) => `[${formatClock(l.time_in_call_secs)}] ${l.role === 'agent' ? 'Genie' : l.role === 'user' ? 'Caller' : 'System'}: ${l.message}`);
  return [...head, ...(body.length ? body : ['(nothing was said on this call)'])].join('\n') + '\n';
}

/** The Block Kit card for the channel, plus the notification fallback text. */
export function buildCallLogMessage(input: CallLogInput): { text: string; blocks: any[] } {
  const dc = input.data_collection;
  const wantedPerson = truthy(collected(dc, 'wanted_person'));
  const handoffSent = truthy(collected(dc, 'handoff_sent'));
  const urgent = truthy(collected(dc, 'urgent'));
  const name = collected(dc, 'caller_name', 'customer_name');
  const email = collected(dc, 'caller_email', 'customer_email');
  const reason = collected(dc, 'reason_for_call');
  const unanswered = collected(dc, 'unanswered_question');
  const callerTurns = input.lines.filter((l) => l.role === 'user').length;

  const title = urgent
    ? ':rotating_light:  Urgent call'
    : wantedPerson
      ? ':raising_hand:  Call ended: caller asked for a person'
      : ':telephone_receiver:  Call ended';

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `CST Genie  •  ${formatDuration(input.duration_secs)}  •  ${newYorkTime(input.started_unix)} New York  •  Caller ${esc(maskPhone(input.caller_phone))}`,
      }],
    },
  ];

  const summary = input.summary || (callerTurns === 0 ? 'The caller hung up before saying anything.' : String(reason || 'No summary was produced for this call.'));
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Summary*\n${esc(summary)}` } });

  const handoff = !wantedPerson ? 'Not asked for' : handoffSent ? ':white_check_mark: Sent to the team' : ':x: Not sent';
  const fields = [
    { type: 'mrkdwn', text: `*Wanted a person*\n${wantedPerson ? 'Yes' : 'No'}` },
    { type: 'mrkdwn', text: `*Handoff*\n${handoff}` },
    { type: 'mrkdwn', text: `*Urgent*\n${urgent ? ':red_circle: Yes' : 'No'}` },
    { type: 'mrkdwn', text: `*Caller turns*\n${callerTurns}` },
  ];
  if (name) fields.push({ type: 'mrkdwn', text: `*Name*\n${esc(name)}` });
  if (email) fields.push({ type: 'mrkdwn', text: `*Email*\n${esc(email)}` });
  blocks.push({ type: 'section', fields });

  if (unanswered) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Genie couldn't answer*\n>${esc(unanswered).replace(/\n/g, '\n>')}` } });
  }

  const evaluation = input.evaluation || {};
  const checkIds = [...Object.keys(CHECK_LABELS).filter((id) => id in evaluation), ...Object.keys(evaluation).filter((id) => !(id in CHECK_LABELS))];
  if (checkIds.length) {
    const mark = (r: string) => (r === 'success' ? 'white_check_mark' : r === 'failure' ? 'x' : 'heavy_minus_sign');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'rich_text',
      elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'Call checks', style: { bold: true } }] },
        {
          type: 'rich_text_list',
          style: 'bullet',
          elements: checkIds.map((id) => {
            const result = String((evaluation[id] as any)?.result ?? evaluation[id] ?? 'unknown');
            return {
              type: 'rich_text_section',
              elements: [
                { type: 'emoji', name: mark(result) },
                { type: 'text', text: `  ${CHECK_LABELS[id] || id}${result === 'unknown' ? ' (not applicable)' : ''}` },
              ],
            };
          }),
        },
      ],
    });
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Conversation \`${esc(input.conversation_id)}\`  •  Full transcript in the thread` }] });

  const text = `${urgent ? 'URGENT ' : ''}CST Genie call (${formatDuration(input.duration_secs)}, ${maskPhone(input.caller_phone)}): ${esc(summary)}`.slice(0, 300);
  return { text, blocks };
}

/** Transcript as rich text blocks, for when the file upload is refused. */
function transcriptBlocks(input: CallLogInput): any[] {
  const lines = input.lines.slice(0, 80);
  const elements = lines.length
    ? lines.map((l) => ({
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: `[${formatClock(l.time_in_call_secs)}] ${l.role === 'agent' ? 'Genie' : 'Caller'}: `, style: { bold: true } },
          { type: 'text', text: l.message.slice(0, 1500) },
        ],
      }))
    : [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Nothing was said on this call.' }] }];
  const blocks: any[] = [
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Transcript', style: { bold: true } }] }, { type: 'rich_text_list', style: 'bullet', elements }] },
  ];
  if (input.lines.length > lines.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${input.lines.length - lines.length} more lines are in ElevenLabs under this conversation.` }] });
  }
  return blocks;
}

async function slackApi(method: string, token: string, body: Record<string, unknown>, form = false): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: form
      ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
      : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
  return json;
}

async function uploadTranscript(token: string, channel: string, threadTs: string, input: CallLogInput): Promise<{ ok: boolean; error?: string }> {
  const content = buildTranscriptText(input);
  const bytes = Buffer.byteLength(content, 'utf8');
  const filename = `cst-genie-${input.conversation_id}.txt`;
  const ticket = await slackApi('files.getUploadURLExternal', token, { filename, length: String(bytes) }, true);
  if (!ticket.ok) return { ok: false, error: ticket.error || 'upload_url_refused' };
  const put = await fetch(ticket.upload_url, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content });
  if (!put.ok) return { ok: false, error: `upload_http_${put.status}` };
  const done = await slackApi('files.completeUploadExternal', token, {
    files: [{ id: ticket.file_id, title: `Transcript ${input.conversation_id}` }],
    channel_id: channel,
    thread_ts: threadTs,
  });
  return done.ok ? { ok: true } : { ok: false, error: done.error || 'complete_upload_refused' };
}

export class CallLogPoster {
  /** Test hook: replaces delivery entirely. */
  static mockHandler: ((message: { text: string; blocks: any[] }, transcript: string) => Promise<CallLogResult> | CallLogResult) | null = null;

  static async post(input: CallLogInput): Promise<CallLogResult> {
    const message = buildCallLogMessage(input);
    if (this.mockHandler) return this.mockHandler(message, buildTranscriptText(input));

    // PBT5 relay evidence, kept from the earlier one-line post: the marker
    // rides in the fallback text so the receipt tool can match the message.
    const trace = currentRelayTrace();
    const dispatchId = trace ? `dispatch_${randomUUID()}` : undefined;
    if (dispatchId) message.text += `\n[PBT5 trace: ${dispatchId}]`;
    const traceFields = trace ? {
      dispatch_id: dispatchId,
      destination_channel: '#bha-customer-service-twin',
      committed_rows: [...trace.committed_rows],
      slack_text_sha256: createHash('sha256').update(message.text).digest('hex'),
    } : {};
    traceRelay('slack_dispatch_attempt', traceFields);

    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.CST_CALL_LOG_CHANNEL_ID || CALL_LOG_DEFAULT_CHANNEL;
    try {
      if (token) {
        const card = await slackApi('chat.postMessage', token, { channel, text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false });
        traceRelay('slack_dispatch_result', { ...traceFields, http_ok: Boolean(card.ok), http_status: null, slack_message_id: card.ok ? card.ts : null });
        if (!card.ok) return { posted: false, via: 'bot', transcript: 'none', error: `chat.postMessage: ${card.error}` };

        const file = await uploadTranscript(token, channel, card.ts, input).catch((e: any) => ({ ok: false, error: e?.message }));
        if (file.ok) return { posted: true, via: 'bot', ts: card.ts, transcript: 'file' };

        const reply = await slackApi('chat.postMessage', token, {
          channel, thread_ts: card.ts, text: `Transcript for ${input.conversation_id}`, blocks: transcriptBlocks(input), unfurl_links: false,
        });
        return reply.ok
          ? { posted: true, via: 'bot', ts: card.ts, transcript: 'thread_text', error: `file upload refused: ${file.error}` }
          : { posted: true, via: 'bot', ts: card.ts, transcript: 'failed', error: `file upload refused: ${file.error}; thread reply: ${reply.error}` };
      }

      const hook = process.env.SLACK_CUSTOMER_SERVICE_WEBHOOK_URL || process.env.SLACK_CS_WEBHOOK_URL;
      if (!hook) return { posted: false, via: 'none', transcript: 'none', error: 'no SLACK_BOT_TOKEN or customer service webhook configured' };
      const res = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message.text, blocks: [...message.blocks, { type: 'divider' }, ...transcriptBlocks(input)].slice(0, 50) }),
      });
      const body = await res.text().catch(() => '');
      // An incoming webhook returns no message ts, so there is no exact receipt here.
      traceRelay('slack_dispatch_result', { ...traceFields, http_ok: res.ok, http_status: res.status, slack_message_id: null });
      return res.ok && body.trim() === 'ok'
        ? { posted: true, via: 'webhook', transcript: 'inline' }
        : { posted: false, via: 'webhook', transcript: 'none', error: `webhook HTTP ${res.status}: ${body.slice(0, 200)}` };
    } catch (err: any) {
      traceRelay('slack_dispatch_result', { ...traceFields, http_ok: false, http_status: null, slack_message_id: null });
      return { posted: false, via: token ? 'bot' : 'webhook', transcript: 'none', error: err?.message || 'unknown error' };
    }
  }
}
