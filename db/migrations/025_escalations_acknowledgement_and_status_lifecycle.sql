-- Migration: 025_escalations_acknowledgement_and_status_lifecycle.sql
-- Feature: IWKX Stage S2 — Escalation Human Acknowledgement & Full Status Lifecycle
--
-- Context:
--   Migration 022 created `escalations` with `ck_escalation_status` permitting
--   only ('pending', 'notified', 'failed') and without dedicated columns for
--   operator acknowledgement (`acknowledged_by`, `acknowledged_at`).
--   Stage S2 requires distinct, durable persistence of all escalation lifecycle
--   statuses ('pending', 'sent', 'notified', 'acknowledged', 'failed') and
--   explicit operator acknowledgement metadata in PostgreSQL so that human
--   acknowledgement is distinguishable from Slack notification delivery.
--
-- Idempotent & Forward-Only:
--   Preserves 022_add_escalations_table.sql unchanged; safely upgrades existing
--   and freshly migrated databases.

ALTER TABLE escalations
  ADD COLUMN IF NOT EXISTS acknowledged_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

ALTER TABLE escalations
  DROP CONSTRAINT IF EXISTS ck_escalation_status;

ALTER TABLE escalations
  ADD CONSTRAINT ck_escalation_status CHECK (
    status IN ('pending', 'sent', 'notified', 'acknowledged', 'failed')
  );

COMMENT ON COLUMN escalations.acknowledged_by IS
  'Human operator identity (name/Slack ID) who acknowledged the customer escalation';

COMMENT ON COLUMN escalations.acknowledged_at IS
  'Timestamp when a human operator acknowledged the customer escalation';
