-- Migration: 007_add_provider_sid_and_updated_at_to_messages_out.sql
-- Adds two columns to messages_out that the application code writes to but
-- were absent from 001_initial_schema.sql (the original table definition).
--
-- provider_sid: Twilio MessageSid returned after a successful send.
--   Written by DbClient.updateOutboundProviderSid() immediately after Twilio
--   confirms delivery. Required for delivery-status webhook correlation.
--
-- updated_at: Row-level last-modified timestamp.
--   Kept in sync via the trigger defined below so audit queries can sort
--   outbound messages by their most recent state change.
--
-- Both use ADD COLUMN IF NOT EXISTS -- idempotent, safe to re-run.

-- 1. provider_sid column
ALTER TABLE messages_out
  ADD COLUMN IF NOT EXISTS provider_sid VARCHAR(128);

-- 2. updated_at column (defaults to row creation time for existing rows)
ALTER TABLE messages_out
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 3. Index on provider_sid for fast delivery-status webhook lookups
CREATE INDEX IF NOT EXISTS idx_messages_out_provider_sid ON messages_out(provider_sid)
  WHERE provider_sid IS NOT NULL;

-- 4. Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION set_messages_out_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_out_updated_at ON messages_out;
CREATE TRIGGER trg_messages_out_updated_at
  BEFORE UPDATE ON messages_out
  FOR EACH ROW EXECUTE FUNCTION set_messages_out_updated_at();
