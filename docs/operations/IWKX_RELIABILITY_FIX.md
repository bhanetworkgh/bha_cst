# IWKX reliability fix — local review

Base: `f5951a3c43da5187ef5f0f70c9fbf013cc09bde6`. Prepared 13 November 2026.

## Problem and resulting behavior

The post-call service previously continued to dashboard/Slack after lifecycle persistence failed, then suppressed redelivery as already processed. Its DB helper also swallowed SQL errors. Six Slack failures could independently make subsystem health `failing` while overall readiness returned `ready`.

This change:

- Adds a required lifecycle-write path using one PostgreSQL connection and transaction. A failed insert or commit returns a webhook processing failure (HTTP 500) before dashboard publication, escalation creation or customer Slack dispatch. Failure does not mark the conversation processed.
- Keeps best-effort publisher persistence separate and unchanged.
- Uses deterministic lifecycle event/row IDs derived from provider name, tenant, project, conversation ID and event kind. `ON CONFLICT (id) DO NOTHING` preserves the original row if a commit succeeded but its response was lost. No historical rows are rewritten or backfilled.
- Publishes committed trace references and in-memory evidence only after successful transaction completion. Test-only no-pool execution remains explicitly memory-only; missing production DB fails closed.
- Records a persistence failure and attempts one class-specific CST error route. Generic logger Slack notification is disabled only for that already-routed failure. A broken alert destination is still subject to ErrorRouter's existing handling; delivery is not guaranteed by this patch.
- Returns `unready` when Slack is `failing`, so `/webhooks/elevenlabs/health` returns HTTP 503.

## Local verification

Four initial regression tests failed on the original implementation, then passed with the fix. Final targeted coverage totals **95 passing tests across 10 suites** (executed in scoped groups), plus TypeScript typecheck and whitespace/diff validation.

Suites: `iwkx_persistence`, `elevenlabs_webhook`, `elevenlabs_whatsapp`, `pbt5_relay_trace`, `failure_detector_cutover`, `error_routing`, `slack`, `dashboard_publish_outcomes`, `dashboard_publisher`, `call_log`.

New cases cover partial insert rollback, commit failure, stable retry IDs after an ambiguous commit, connection acquisition failure, missing production DB, rollback failure/connection disposal, no premature escalation, successful redelivery, same-process duplicate suppression and HTTP 503 on failing Slack health. Existing trace tests now explicitly require HTTP 500 and no customer dispatch when required persistence fails.

All tests used local/in-memory or mocked services. No production requests, real PostgreSQL transaction test, Slack posts, merge or deployment occurred. Dependencies were reused from the existing local installation.

## Boundaries and remaining decisions

- This changes failure behavior: a DB outage now withholds the downstream call card rather than sending a card without required lifecycle evidence. Provider redelivery or an explicitly approved replay is necessary after recovery; the patch does not create a new retry worker.
- This is not an exactly-once dispatch system. Concurrent deliveries, process crashes after successful external dispatch, escalation-table failures, and durable dispatch deduplication remain separate reliability work. Stable lifecycle rows prevent duplicate evidence inserts under the new ID scheme, not duplicate external effects in all crash scenarios.
- IDs change for newly processed lifecycle events. Old UUID-based evidence stays untouched. Historical replay is not authorized by this change.
- The new transaction uses the existing `dashboard_publish_outcomes` primary key; no migration is required. Actual PostgreSQL verification remains a review-stage check before deployment.
- `CST_CUTOVER_APPROVED` semantics are unchanged. Existing code permits forward events with approval false; the accepted forward-only policy does not by itself establish whether that flag should block production ingestion. Confirm with Destiny/Jason whether this is an activation gate or approval metadata before changing it, and record the approved cut-over timestamp.
- These local fixes do not close IWKX, change PBT5/SO8M acceptance, or establish live routing/product sign-off.

## Reproduce

```sh
npm test -- tests/interfaces/iwkx_persistence.test.ts tests/interfaces/elevenlabs_webhook.test.ts tests/interfaces/elevenlabs_whatsapp.test.ts tests/interfaces/pbt5_relay_trace.test.ts tests/observability/failure_detector_cutover.test.ts tests/notifications/error_routing.test.ts tests/notifications/slack.test.ts tests/publishers/dashboard_publish_outcomes.test.ts tests/publishers/dashboard_publisher.test.ts tests/notifications/call_log.test.ts
npm run typecheck
git diff --check
```
