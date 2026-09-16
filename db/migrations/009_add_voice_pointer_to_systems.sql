-- Migration: 009_add_voice_pointer_to_systems.sql
-- Feature: ElevenLabs Voice Clone Integration for CST
-- Adds voice pointer fields to systems table and voice_deliveries ledger for health signals and audit.

-- ── systems: Voice Clone Pointer ─────────────────────────────────────────────
-- Pointer to Jason's voice clone hosted on ElevenLabs.
-- CST only stores the pointer, never the clone itself.
ALTER TABLE systems
  ADD COLUMN IF NOT EXISTS elevenlabs_voice_id TEXT,
  ADD COLUMN IF NOT EXISTS elevenlabs_model_id TEXT,
  ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ── voice_deliveries: Voice lane delivery tracking & health ledger ────────────
-- Records each spoken delivery event for Destiny health signal computation:
-- "clone configured + at least one successful spoken delivery in the last 24h"
CREATE TABLE IF NOT EXISTS voice_deliveries (
  id                  VARCHAR(64)  PRIMARY KEY DEFAULT gen_random_uuid()::text,
  system_id           VARCHAR(64)  NOT NULL REFERENCES systems(system_id),
  tenant_id           VARCHAR(64)  NOT NULL,
  conversation_id     VARCHAR(64),
  message_id          VARCHAR(128),
  status              VARCHAR(32)  NOT NULL, -- 'synthesized' | 'sent' | 'failed' | 'refused'
  voice_id            VARCHAR(128),
  model_id            VARCHAR(64),
  character_count     INT          NOT NULL DEFAULT 0,
  audio_bytes         INT          NOT NULL DEFAULT 0,
  mime_type           VARCHAR(64)  DEFAULT 'audio/mpeg',
  error_code          VARCHAR(64),
  error_message       TEXT,
  correlation_id      VARCHAR(128),
  delivered_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_voice_deliveries_system_created ON voice_deliveries(system_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_deliveries_tenant_created ON voice_deliveries(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_deliveries_status         ON voice_deliveries(status, created_at DESC);
