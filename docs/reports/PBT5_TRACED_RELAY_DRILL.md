# Issue #33: tracing-only relay draft

Baseline inspected: `932521d9b8a491e5372f29ed2928a0e660a43ea8` (PR #32).
No production drill, deployment, migration, historical row edit, or replay is
authorized by this draft. PBT5 stays In Progress and its fresh relay Pending.

## What changes (and what does not)

`CST_RELAY_TRACE=true` enables observational tracing for authenticated, validated
ElevenLabs post-call requests. Default is off. Existing routes, targets,
authentication, cutover, deduplication, retry counts, response bodies/statuses,
and error handling stay unchanged. No dependencies or DB migrations are added.

When enabled, the webhook response gains `X-CST-Webhook-Receive-ID`, and the
existing CS Slack text gains one suffix: `[PBT5 trace: dispatch_<uuid>]`.
This is the only Slack payload change. The marker is appended **after** routing
and duplicate decisions, so it cannot defeat the existing deduplication key.
Other notifications outside the traced request context are unaffected.

Tracing does not fix existing swallowed persistence failures or delivery logic.
It labels failed/in-memory writes honestly instead of treating a returned ID as
committed. A successful HTTP response or `slack_delivered` alone still cannot
pass the drill. Rejected/unauthenticated requests retain their existing behavior
and do not produce this successful-relay trace.

## ID map and evidence locations

All server evidence uses JSON log records with `trace_schema=pbt5.relay.v1`.
AsyncLocalStorage isolates concurrent requests and propagates one
`webhook_receive_id` through existing awaited operations.

| Stage | Evidence |
|---|---|
| Provider | `provider_request_id` from `x-elevenlabs-request-id`, otherwise `x-request-id`, and its header name; actual `provider_conversation_id` and `provider_call_sid` from the accepted payload |
| Receive | Locally generated `webhook_receive_id`, `received_at`, `payload_sha256`; `webhook_receive` and `provider_link` log records; receive ID also in response header |
| DB | `db_write` records with actual `db_row_id`, `event_id`, and `persistence=committed/failed/memory_only`; committed is logged only after the existing standalone PostgreSQL INSERT resolves |
| Dispatch | Unique `dispatch_id`, same receive/provider IDs, snapshot of committed row/event pairs, intended channel name, text SHA-256, and actual HTTP status in `slack_dispatch_attempt/result` |
| Slack | Separate read-only collector emits `slack_message_observed` with the same receive/provider/dispatch/DB IDs, actual channel ID, message `ts`, bot ID, permalink, read API request IDs, and text-hash comparison |

Provider request IDs are **observed header values**, not invented identifiers or
proof of header origin. Headers are not authenticated by a body HMAC. They may
be proxy IDs; verify their source against provider/request records. If neither
header is supplied or the value is invalid, the field is explicitly null. The
locally generated receive ID is never relabeled as a provider request ID. If
the provider supplies no request ID, the reviewer must decide how to handle
that missing field; this draft does not silently waive the acceptance standard.

`payload_sha256` covers the receiver's existing `rawBody` when present, otherwise
its existing JSON serialization fallback. Preserve the provider export/body
separately; do not describe the fallback hash as a wire-byte capture.
No new trace record logs speech, caller phone, authorization headers, signing
secrets, webhook URLs, or bot tokens. Trace logs contain operational IDs and
should retain normal restricted log access/retention.

## Slack receipt approach and permissions

Incoming webhooks do not return a message `ts`. The send route is deliberately
not switched to `chat.postMessage`. Instead a read-only operator tool searches
a bounded history window for the exact dispatch suffix from the **expected
sending bot**. It rejects missing/duplicate matches, edited messages, incomplete
pagination, rate limits, and missing committed-write/transport evidence. It
then calls `chat.getPermalink` and emits a JSON observation. No send/update/delete
API is available in the tool, and it does not retry dispatch.

After separate deployment/configuration approval:

- Runtime: enable `CST_RELAY_TRACE=true` for the drill. No webhook target changes.
- Operator only: `PBT5_SLACK_READ_TOKEN` in a secure local environment. Do not add
  the token to source, command arguments, trace files, or shared screenshots.
- Reading a public target channel requires `channels:history`; a private one
  requires `groups:history`. The read bot must have access/membership. Request
  only the scope for the actual target. No new `chat:write` scope is needed.
- Record the actual Slack channel ID and the webhook's **sending** bot ID. The
  read token's bot may be different. Do not infer either from a channel label.
- Any needed Slack installation/scope changes require reviewer approval; this
  PR performs none. Existing eligible read access may be reused.

References: [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/),
[conversations.history](https://docs.slack.dev/reference/methods/conversations.history/),
[chat.getPermalink](https://docs.slack.dev/reference/methods/chat.getPermalink/).

## One drill, only after explicit merge/deployment approval

1. Record the approved PR/commit, actual deployed SHA, Render deployment/service
   IDs, ElevenLabs agent/webhook identifiers and target URL without credentials,
   tracing flag, actual Slack target channel/bot IDs. Preserve which identifiers
   were read directly versus supplied by an operator. No secrets in the packet.
2. Run one authorized new call. Preserve provider call/conversation export,
   request/delivery ID if available, and original webhook request/response in
   the approved evidence store. Do not reuse historical PBT5 rows or replay a call.
3. Export the receiver's logs as `trace.jsonl`, retaining JSON lines and UTC
   timestamps. Filter `pbt5.relay.v1` and the response receive ID. Require a
   provider-link record, committed DB writes, dispatch attempt/result, and
   webhook result. Check failures/duplicates rather than hiding them.
4. In a read-only DB session, query the exact logged DB row IDs and preserve the
   SQL/results. Confirm event/conversation IDs match. Failed or memory-only
   writes cannot establish the required durable chain.
5. Set `PBT5_SLACK_READ_TOKEN` privately and run the read-only receipt collector
   on an operator machine, using a <=1-hour UTC epoch window around dispatch:

   ```sh
   node scripts/pbt5_slack_receipt.mjs trace.jsonl dispatch_UUID CHANNEL_ID SENDING_BOT_ID OLDEST_EPOCH LATEST_EPOCH > slack-receipt.json
   ```

   Substitute actual IDs/epochs. The collector reads at most 100 pages, 15
   messages per page, and stops on rate limits without retrying. If collection
   fails, preserve the failure and retry the **read** later; do not resend the
   customer message. Slack may transform text formatting; a hash difference
   requires explicit content review, not a verbatim claim.
6. Attach provider/request evidence, logs, exact SELECT output, Slack observation
   and permalink, configuration/deployment identifiers, and any gaps. The
   collector is a read-back observation, not a Slack send-response message ID
   (incoming webhooks do not supply one). It always says `review_required=true`.
   A reviewer must check the complete chain and record the pass on the loop.

Latency was not validated in PBT5 and no latency guarantee is made. A fresh
trace is current-behavior evidence only. Historical provenance dispositions
remain intact. No automated closure or pass is emitted.

## Local validation

Use an environment without production credentials or a sourced `.env`:

```sh
npm run typecheck
npm test -- tests/interfaces/pbt5_relay_trace.test.ts tests/interfaces/elevenlabs_webhook.test.ts
```

The new suite mocks PostgreSQL, dashboard publishing, Slack sending and Slack
reading. It checks ID joins, null tool turns, failed/memory-only persistence,
disabled tracing, duplicate behavior, Slack failure handling, concurrency,
missing provider request IDs and invalid/ambiguous Slack observations.
