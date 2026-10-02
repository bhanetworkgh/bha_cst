-- 013_messages_out_turn_id.sql
--
-- Durable cst.turn <-> cst.delivery correlation.
--
-- `cst.turn.turn_id` is `MessageEnvelope.correlation_id` (the Twilio
-- MessageSid) for every channel. `OutboundMessage.turn_id` carried it in memory
-- and was published on `cst.delivery`, but it was never persisted — so a
-- delivery callback that arrived after a restart, or for a row written by
-- another process, had no durable way to recover the originating turn_id and
-- the dashboard join key was lost.
--
-- `correlation_id` happens to equal `turn_id` on the SMS lane today, but making
-- the join key an explicit, indexed column means a future channel (where
-- correlation_id is not the turn id) does not silently break delivery
-- correlation, and the delivery callback can resolve the turn without relying
-- on a LIKE '%sid%' match.

ALTER TABLE messages_out
  ADD COLUMN IF NOT EXISTS turn_id character varying(128);

COMMENT ON COLUMN messages_out.turn_id IS
  'cst.turn.turn_id this outbound message is the reply to (join key for cst.delivery)';

-- Partial index: only rows that actually carry a turn are looked up by it.
CREATE INDEX IF NOT EXISTS idx_messages_out_turn_id
  ON messages_out (turn_id)
  WHERE turn_id IS NOT NULL;

-- Backfill from correlation_id for rows written before this migration. They were
-- produced by the SMS ingress lane, where turn_id === correlation_id.
UPDATE messages_out
   SET turn_id = correlation_id
 WHERE turn_id IS NULL
   AND correlation_id IS NOT NULL;
