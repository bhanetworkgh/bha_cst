-- 014_messages_out_next_retry_at.sql
--
-- The outbound queue poller (`DbClient.getPendingOutboundMessages`, run every
-- few seconds by the SMS worker) selects and filters on `next_retry_at`:
--
--   WHERE (status = 'pending')
--      OR (status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
--
-- The column existed in `OutboundMessage` and in the TypeScript type, but no
-- migration ever created it. Against PostgreSQL that query failed on every
-- single poll with
--
--   ERROR: column "next_retry_at" does not exist
--
-- The error was caught and logged, so the process stayed up while the poller
-- silently returned no rows: a queued SMS waiting for its retry backoff was
-- never picked up again, and the failure was invisible except in logs.
--
-- Nullable, so existing rows need no backfill (NULL means "retry immediately").

ALTER TABLE messages_out
  ADD COLUMN IF NOT EXISTS next_retry_at timestamp with time zone;

COMMENT ON COLUMN messages_out.next_retry_at IS
  'Earliest time a queued outbound message may be retried; NULL means due now';

-- Partial index for the poller: only rows the worker actually scans.
CREATE INDEX IF NOT EXISTS idx_messages_out_due
  ON messages_out (next_retry_at)
  WHERE status IN ('pending', 'queued');
