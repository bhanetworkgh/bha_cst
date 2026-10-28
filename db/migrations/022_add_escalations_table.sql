-- Migration: 022_add_escalations_table.sql
-- Feature: Human Escalation Records — durable persistence for caller escalations
--
-- Adds the `escalations` table used by `EscalationService` (engine/src/escalation/service.ts)
-- to durably record when a caller requests human assistance. The record captures
-- caller identity (masked), tenant/project scope, correlation ID, optional email,
-- reason, transcript reference, and Slack notification status.
--
-- WHY A SEPARATE TABLE
--   Escalations are distinct from SMS consents (sms_consents) and voice deliveries
--   (voice_deliveries). They model a human-handoff request, not a consent state
--   or a message delivery. Keeping them separate keeps each table's purpose clear
--   and avoids overloading the consent spine.
--
-- DESIGN
--   - caller_phone: E.164 number of the caller (masked in logs, stored raw here)
--   - tenant_id / project_id: CST tenancy scope (from service_number_binding)
--   - conversation_id: links to the voice conversation transcript
--   - correlation_id: call SID or request ID for end-to-end tracing
--   - caller_email: captured during escalation, optional until provided
--   - reason: caller's stated reason for escalation
--   - transcript: array of transcript entries (JSON), truncated if needed
--   - slack_notified / slack_notified_at / slack_error: Slack notification outcome
--   - status: pending → notified | failed
--   - created_at: when the escalation was recorded
--
-- IDEMPOTENT
--   CREATE TABLE IF NOT EXISTS — safe to re-run.
--   No data is modified; only schema is added.

-- ── 1. escalations — durable human-escalation records ────────────────────────

CREATE TABLE IF NOT EXISTS escalations (
  id                VARCHAR(64)   PRIMARY KEY DEFAULT gen_random_uuid()::text,
  caller_phone      VARCHAR(32)   NOT NULL,
  tenant_id         VARCHAR(64)   NOT NULL,
  project_id        VARCHAR(64),
  conversation_id   VARCHAR(64),
  correlation_id    VARCHAR(128)  NOT NULL,
  caller_email      VARCHAR(255),
  reason            TEXT,
  transcript        JSONB,
  slack_notified    BOOLEAN       NOT NULL DEFAULT FALSE,
  slack_notified_at TIMESTAMPTZ,
  slack_error       TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status            VARCHAR(32)   NOT NULL DEFAULT 'pending',
  -- Allowed values: 'pending', 'notified', 'failed'
  CONSTRAINT ck_escalation_status CHECK (
    status IN ('pending', 'notified', 'failed')
  )
);

-- Fast lookups
CREATE INDEX IF NOT EXISTS idx_escalations_correlation ON escalations(correlation_id);
CREATE INDEX IF NOT EXISTS idx_escalations_tenant ON escalations(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
CREATE INDEX IF NOT EXISTS idx_escalations_caller_phone ON escalations(caller_phone);

-- ── 2. auto-update helper (no-op here since escalations are mostly append-only) ──
-- Kept for schema consistency with other tables that use updated_at triggers.
