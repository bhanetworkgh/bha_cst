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
