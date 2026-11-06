// Read-only evidence collection. Never posts, updates, retries, or replays a message.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function readDispatchEvidence(log, dispatchId) {
  const rows = log.split('\n').flatMap((line) => {
    try { return [JSON.parse(line.slice(line.indexOf('{')))]; } catch { return []; }
  }).filter((r) => r.trace_schema === 'pbt5.relay.v1');
  const attempts = rows.filter((r) => r.stage === 'slack_dispatch_attempt' && r.dispatch_id === dispatchId);
  if (attempts.length !== 1) throw new Error('Expected exactly one dispatch attempt in the supplied log');
  const attempt = attempts[0];
  const results = rows.filter((r) => r.stage === 'slack_dispatch_result' && r.dispatch_id === dispatchId
    && r.webhook_receive_id === attempt.webhook_receive_id && r.http_ok === true);
  if (results.length !== 1) throw new Error('Missing unique successful transport result; no receipt can be certified');
  const committed = attempt.committed_rows;
  if (!Array.isArray(committed) || committed.length === 0 || !committed.every((ref) =>
    rows.some((r) => r.stage === 'db_write' && r.persistence === 'committed'
      && r.webhook_receive_id === attempt.webhook_receive_id
      && r.db_row_id === ref.db_row_id && r.event_id === ref.event_id))) {
    throw new Error('Committed DB row evidence missing from the supplied log');
  }
  return attempt;
}

export async function collectSlackReceipt({ evidence, channel, botId, oldest, latest, token, fetchFn = fetch }) {
  if (!/^dispatch_[a-f0-9-]{36}$/.test(evidence.dispatch_id || '')
    || !/^[CG][A-Z0-9]+$/.test(channel) || !/^B[A-Z0-9]+$/.test(botId)
    || !/^\d+(\.\d+)?$/.test(oldest) || !/^\d+(\.\d+)?$/.test(latest)
    || Number(latest) <= Number(oldest) || Number(latest) - Number(oldest) > 3600 || !token) {
    throw new Error('Require dispatch ID, channel ID, sending bot ID, token, and a UTC epoch window of at most one hour');
  }
  const apiRequestIds = [];
  const get = async (method, params) => {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetchFn(url, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Slack read failed HTTP ${response.status}; preserve the partial evidence and retry collection later`);
    apiRequestIds.push(response.headers.get('x-slack-req-id'));
    const data = await response.json();
    if (!data.ok) throw new Error('Slack read rejected; check token scope and channel membership');
    return data;
  };
  const marker = `[PBT5 trace: ${evidence.dispatch_id}]`;
  const matches = [];
  let cursor = '';
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const data = await get('conversations.history', { channel, oldest, latest, inclusive: 'true', limit: '15', cursor });
    for (const message of data.messages || []) {
      if (message.bot_id === botId && typeof message.text === 'string' && message.text.endsWith(`\n${marker}`)) {
        matches.push(message);
      }
    }
    const next = data.response_metadata?.next_cursor || '';
    if (!next) {
      if (data.has_more) throw new Error('Incomplete Slack history pagination; do not certify a receipt');
      break;
    }
    if (seen.has(next) || page === 99) throw new Error('Incomplete Slack history pagination; do not certify a receipt');
    seen.add(next);
    cursor = next;
  }
  if (matches.length !== 1) throw new Error('Expected exactly one message from the configured bot with this dispatch marker');
  const message = matches[0];
  if (!/^\d+\.\d+$/.test(message.ts || '') || message.edited) throw new Error('Message ID missing or message was edited; review required');
  const link = await get('chat.getPermalink', { conversation_id: channel, message_ts: message.ts });
  if (typeof link.permalink !== 'string' || !link.permalink.startsWith('https://')) throw new Error('Slack did not supply a permalink');
  const observedHash = createHash('sha256').update(message.text).digest('hex');
  return {
    trace_schema: 'pbt5.relay.v1', stage: 'slack_message_observed', observed_at: new Date().toISOString(),
    webhook_receive_id: evidence.webhook_receive_id,
    provider_request_id: evidence.provider_request_id,
    provider_request_id_source: evidence.provider_request_id_source,
    provider_conversation_id: evidence.provider_conversation_id,
    provider_call_sid: evidence.provider_call_sid,
    dispatch_id: evidence.dispatch_id, committed_rows: evidence.committed_rows,
    slack_channel_id: channel, slack_message_id: message.ts, slack_bot_id: botId,
    slack_permalink: link.permalink, slack_read_request_ids: apiRequestIds,
    slack_text_sha256: observedHash,
    dispatch_text_matches: observedHash === evidence.slack_text_sha256,
    // A read receipt is not an automatic PBT5 reviewer pass.
    review_required: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [logPath, dispatchId, channel, botId, oldest, latest] = process.argv.slice(2);
    if (!logPath || !dispatchId) throw new Error('Usage: node scripts/pbt5_slack_receipt.mjs trace.jsonl dispatch_ID CHANNEL_ID BOT_ID oldest_epoch latest_epoch');
    const evidence = readDispatchEvidence(readFileSync(logPath, 'utf8'), dispatchId);
    const receipt = await collectSlackReceipt({ evidence, channel, botId, oldest, latest, token: process.env.PBT5_SLACK_READ_TOKEN });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    // Do not print request objects, tokens, message bodies, or response payloads.
    console.error(error instanceof Error ? error.message : 'Receipt collection failed');
    process.exitCode = 1;
  }
}
