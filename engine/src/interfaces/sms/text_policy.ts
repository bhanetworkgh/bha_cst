/**
 * What the 971 number does with a text that is not START, HELP or STOP
 * (8 Nov 2026, Destiny).
 *
 * The number's text scope is START, HELP and STOP only, each with one
 * automated reply. Customer chat moves to WhatsApp and the social accounts.
 * Every other text gets one fixed reply pointing the sender to a call with
 * CST Genie or the support page, and nothing goes to the Core Engine.
 *
 * The reply goes out at most once per sender per day, so the number can never
 * loop with another auto-responder. A sender who has opted out gets nothing:
 * that check runs before this one in the SMS route.
 *
 * CST_SMS_AGENT_REPLIES=on brings back the old Core Engine replies. It is off
 * unless set.
 */
import { DbClient } from '../../db/client.js';

export const CALLS_ONLY_REPLY =
  "Hi, this is Bays Horizon Network. This number doesn't take texts. Call it to talk to CST Genie, or visit bhanetwork.org/support. Reply HELP for help or STOP to opt out.";

export const CALLS_ONLY_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function agentRepliesEnabled(): boolean {
  return (process.env.CST_SMS_AGENT_REPLIES || '').trim().toLowerCase() === 'on';
}

/**
 * True when this sender should get the fixed reply now: they have not had it
 * from this number in the last day.
 */
export async function shouldSendCallsOnlyReply(fromServiceNumber: string, toSender: string, now = new Date()): Promise<boolean> {
  const since = new Date(now.getTime() - CALLS_ONLY_REPLY_WINDOW_MS).toISOString();
  const already = await DbClient.hasRecentOutboundBody(fromServiceNumber, toSender, CALLS_ONLY_REPLY, since);
  return !already;
}

/**
 * Who answers START, HELP and STOP on this number (8 Nov 2026, Destiny).
 *
 * Twilio's opt-out management on the approved messaging service already
 * answers all three with the campaign's registered wording (seen live: HELP
 * from 945 got Twilio's reply). If this service answered as well, every
 * keyword would get two replies. So by default this service records the
 * opt-in or opt-out and sends nothing; CST_SMS_KEYWORD_REPLIES=app brings back
 * this service's own keyword replies (for a number without Twilio's handling).
 */
export function appSendsKeywordReplies(senderE164?: string): boolean {
  if ((process.env.CST_SMS_KEYWORD_REPLIES || '').trim().toLowerCase() === 'app') return true;
  // Twilio's opt-out replies only went to US and Canadian senders on Destiny's
  // live test (8 Nov 2026): his Nigerian number got the calls-only reply but
  // nothing for HELP, STOP or START. So this service answers keywords itself
  // for any sender outside +1, using the same wording Twilio uses.
  return !!senderE164 && !senderE164.startsWith('+1');
}

/** Twilio's keyword wording on the approved service, for senders outside +1. */
export const KEYWORD_REPLY = {
  help: 'Bays Horizon Network (vFarm) support: call this number to talk to Genie, our automated assistant, or email support@bhanetwork.org. More at bhanetwork.org. Msg&data rates may apply. Reply STOP to opt out.',
  stop: "Bays Horizon Network: you're unsubscribed and won't get more texts from this number. Reply START to rejoin.",
  start: "Bays Horizon Network: you're subscribed again. Reply HELP for help or STOP to opt out. Msg & data rates may apply.",
};

/**
 * Dashboard record for a text (8 Nov 2026, Destiny): the CST page and Bays read
 * the dashboard, and the calls-only and keyword paths never reach the Core
 * Engine that used to write the turn. Every text now writes one cst.turn with
 * channel sms, what they wrote, what we replied and the outcome as its intent.
 */
import { randomUUID } from 'node:crypto';
import { getDashboardPublisher } from '../../publishers/dashboard.js';
import { isTestRunner } from '../../config/runtime.js';

export function publishTextTurn(input: {
  message_sid: string;
  tenant_id: string;
  project_id?: string;
  from_e164: string;
  body: string;
  reply: string | null;
  outcome: string;
}): void {
  const now = new Date().toISOString();
  const customer = { customer_ref: input.from_e164, phone_e164: input.from_e164, role: 'unknown', is_known: false, tenant_id: input.tenant_id, project_id: input.project_id };
  const replied = !!input.reply;
  try {
    getDashboardPublisher().publishFireAndForget({
      specversion: 'cst.event.v1',
      id: `turn_evt_${randomUUID()}`,
      source: 'cst/sms/text_policy',
      time: now,
      tenant_id: input.tenant_id,
      project_id: input.project_id,
      correlation_id: input.message_sid,
      channel: 'sms',
      customer,
      type: 'cst.turn',
      data: {
        turn_id: input.message_sid,
        conversation_id: input.message_sid,
        direction: 'inbound',
        channel: 'sms',
        status: replied ? 'ok' : 'dropped',
        intent: input.outcome,
        text: input.body,
        message: input.body,
        reply_text: input.reply || '',
        reply: input.reply || '',
        duration: { total_ms: 0 },
        duration_ms: 0,
        tenant_id: input.tenant_id,
        project_id: input.project_id,
        customer,
        event_type: 'cst.turn',
        occurred_at: now,
        ...(isTestRunner() ? { test: true } : {}),
        metadata: { source: 'text_policy', outcome: input.outcome },
      },
    });
  } catch {
    // The publisher reports and replays its own failures.
  }
}
