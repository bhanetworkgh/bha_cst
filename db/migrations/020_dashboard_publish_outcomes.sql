-- Dashboard publish outcomes — durable evidence that a CST event reached the
-- Engine Dashboard, and a dead-letter for events that did not.
--
-- WHY: `CstDashboardPublisher` is fire-and-forget. A failed publish was logged
-- and returned to the caller, but never persisted, so an event that was
-- dropped could not be found, replayed, or audited after the log rotated.
-- The verification surface therefore had no way to answer "was every customer
-- turn actually ingested?" beyond a log grep.
--
-- This table makes the publish outcome durable:
--   * one row per publish attempt, including successes;
--   * failures are queryable (status <> 'published') and carry the payload so
--     the event can be replayed;
--   * the payload is masked and TTL-bounded, matching `alert_audit_log`, so a
--     replay window cannot become an unbounded store of customer content.
--
-- Idempotent and additive: creates one table and two indexes, touches no
-- existing table, and migrates no data.

CREATE TABLE IF NOT EXISTS dashboard_publish_outcomes (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  specversion    TEXT,
  turn_id        TEXT,
  correlation_id TEXT,
  tenant_id      TEXT,
  project_id     TEXT,
  status         TEXT NOT NULL,
  http_status    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  error          TEXT,
  payload        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL,
  replayed_at    TIMESTAMPTZ
);

-- Primary operational query: "which events have not been ingested?"
CREATE INDEX IF NOT EXISTS idx_dashboard_publish_outcomes_status
  ON dashboard_publish_outcomes (status, created_at);

-- Retention sweep.
CREATE INDEX IF NOT EXISTS idx_dashboard_publish_outcomes_created
  ON dashboard_publish_outcomes (created_at);

-- One live row per event, so a retry does not multiply the audit trail.
-- Superseded rows are kept (the outcome history is the evidence) but only the
-- newest attempt is the current one.
CREATE UNIQUE INDEX IF NOT EXISTS unq_dashboard_publish_outcomes_event
  ON dashboard_publish_outcomes (event_id, event_type)
  WHERE replayed_at IS NULL;
