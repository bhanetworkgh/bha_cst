/**
 * Text alert (8 Nov 2026, Destiny): every text that reaches the CST number gets
 * a short card in the customer service twin channel from the CS Twin app, the
 * same way every call gets a call card. It shows who sent it (masked), what
 * they wrote, when, and what the number did about it.
 *
 * Posted with SLACK_BOT_TOKEN through chat.postMessage to CST_CALL_LOG_CHANNEL_ID
 * (default C0BD6D53HAM, the call card's channel). Slack's answer is read for
 * ok:false. A card that does not land is raised through the ErrorRouter, so it
 * reaches #bha-pipeline-errors from the CS Twin app; nothing fails silently.
 */
import { maskPhone } from '../util/privacy.js';
import { isTestRunner } from '../config/runtime.js';
import { Logger } from '../config/logger.js';
import { ErrorRouter } from './error_router.js';
import { CALL_LOG_DEFAULT_CHANNEL, newYorkTime } from './call_log.js';

export type TextOutcome =
  | 'calls_only_sent'
  | 'calls_only_already_sent'
  | 'help_by_twilio'
  | 'stop_by_twilio'
  | 'start_by_twilio'
  | 'help_by_cst'
  | 'stop_by_cst'
  | 'start_by_cst'
  | 'opted_out_silent'
  | 'agent_reply';

export interface TextLogInput {
  from_e164: string;
  to_e164: string;
  body: string;
  message_sid: string;
  outcome: TextOutcome;
  tenant_id?: string | null;
  project_id?: string | null;
  num_media?: number;
}

export interface TextLogResult {
  posted: boolean;
  ts?: string;
  error?: string;
  skipped?: boolean;
}

const OUTCOME: Record<TextOutcome, { emoji: string; title: string; line: string }> = {
  calls_only_sent: { emoji: ':speech_balloon:', title: 'New text', line: 'Calls-only reply sent (call CST Genie or visit bhanetwork.org/support).' },
  calls_only_already_sent: { emoji: ':speech_balloon:', title: 'New text', line: 'No reply: this sender already got the calls-only reply today.' },
  help_by_twilio: { emoji: ':information_source:', title: 'HELP text', line: 'Answered by Twilio with the approved HELP reply.' },
  stop_by_twilio: { emoji: ':no_entry_sign:', title: 'STOP text: opted out', line: 'Opt-out recorded. Twilio sent the unsubscribe confirmation; no more texts go to this number.' },
  start_by_twilio: { emoji: ':white_check_mark:', title: 'START text: opted back in', line: 'Opt-in recorded. Twilio sent the confirmation.' },
  help_by_cst: { emoji: ':information_source:', title: 'HELP text', line: 'Answered by the CST service with the HELP reply (Twilio only answers US and Canadian numbers).' },
  stop_by_cst: { emoji: ':no_entry_sign:', title: 'STOP text: opted out', line: 'Opt-out recorded and confirmed by the CST service (Twilio only answers US and Canadian numbers); no more texts go to this number.' },
  start_by_cst: { emoji: ':white_check_mark:', title: 'START text: opted back in', line: 'Opt-in recorded and confirmed by the CST service (Twilio only answers US and Canadian numbers).' },
  opted_out_silent: { emoji: ':speech_balloon:', title: 'Text from an opted-out number', line: 'No reply: this sender has opted out.' },
  agent_reply: { emoji: ':speech_balloon:', title: 'New text', line: 'Answered by the agent (CST_SMS_AGENT_REPLIES is on).' },
};

const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildTextLogMessage(input: TextLogInput): { text: string; blocks: any[] } {
  const o = OUTCOME[input.outcome];
  const who = maskPhone(input.from_e164);
  const body = (input.body || '').trim();
  const shown = body.length > 2800 ? `${body.slice(0, 2800)}…` : body;
  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: `${o.emoji}  ${o.title}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `CST number  •  ${newYorkTime()} New York  •  From ${esc(who)}` }] },
    { type: 'section', text: { type: 'mrkdwn', text: `*They wrote*\n>${esc(shown || '(empty text)').replace(/\n/g, '\n>')}` } },
  ];
  if (input.num_media && input.num_media > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:paperclip:  ${input.num_media} attachment(s), not shown here` }] });
  }
  blocks.push({
    type: 'rich_text',
    elements: [
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'What happened', style: { bold: true } }] },
      { type: 'rich_text_list', style: 'bullet', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: o.line }] }] },
    ],
  });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Message ${esc(input.message_sid)}` }] });
  const text = `${o.title} on the CST number from ${who}: ${body.slice(0, 150)}`;
  return { text: esc(text), blocks };
}

export class TextLogPoster {
  /** Tests set this to capture cards instead of calling Slack. */
  static mockHandler: ((msg: { channel: string; text: string; blocks: any[] }) => Promise<{ ok: boolean; ts?: string; error?: string }>) | null = null;

  static async post(input: TextLogInput): Promise<TextLogResult> {
    const channel = (process.env.CST_CALL_LOG_CHANNEL_ID || '').trim() || CALL_LOG_DEFAULT_CHANNEL;
    const message = buildTextLogMessage(input);
    let result: TextLogResult;
    try {
      if (this.mockHandler) {
        const r = await this.mockHandler({ channel, ...message });
        result = r.ok ? { posted: true, ts: r.ts } : { posted: false, error: r.error };
      } else {
        const token = (process.env.SLACK_BOT_TOKEN || '').trim();
        if (!token) {
          if (isTestRunner()) return { posted: false, skipped: true };
          result = { posted: false, error: 'SLACK_BOT_TOKEN is not set' };
        } else {
          const res = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel, text: message.text, blocks: message.blocks, unfurl_links: false, unfurl_media: false }),
          });
          const json: any = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
          result = json.ok ? { posted: true, ts: json.ts } : { posted: false, error: `chat.postMessage: ${json.error}` };
        }
      }
    } catch (err: any) {
      result = { posted: false, error: err?.message || String(err) };
    }

    if (!result.posted && !result.skipped) {
      Logger.warn(`Text alert did not post: ${result.error}`, { message_sid: input.message_sid });
      try {
        await ErrorRouter.route({
          service: 'CST',
          category: 'text_log',
          message: `CST text alert for ${input.message_sid} did not reach the customer service channel: ${result.error}`,
          severity: 'WARN',
          tenant_id: input.tenant_id ?? null,
          project_id: input.project_id ?? null,
          correlation_id: input.message_sid,
        });
      } catch {
        // The router raises its own failures; this card is best-effort beyond that.
      }
    }
    return result;
  }
}
