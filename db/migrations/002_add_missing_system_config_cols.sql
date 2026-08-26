-- Migration: 002_add_missing_system_config_cols.sql
-- Adds per-system config columns required by spec §2 that were missing from 001.
-- Ref: 2026-08-26-spec-bha-cst-architecture-v1.0.md §2 "What bha-cst HOLDS"

-- Twilio Messaging Service SID reference (per-system, stored as reference not secret)
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS messaging_service_sid TEXT;

-- Media server base URL for signed URL fetches (per-system)
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS media_base_url TEXT;

-- Escalation rules: when/how to file incidents in BHARAG incidents.v0
-- Structure: [{trigger, subsystem, engine, priority}]
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS escalation_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Routing rules: which intents auto-answer, which escalate, canned replies, quiet hours
-- Structure: [{intent, action, canned_reply?, quiet_hours?}]
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS routing_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

-- messages_out: record which Twilio number was used to send (from_e164)
-- Required so delivery logs can trace which system number sent the message
ALTER TABLE messages_out
  ADD COLUMN IF NOT EXISTS from_e164 VARCHAR(32);
