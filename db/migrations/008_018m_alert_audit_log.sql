-- Migration: 009_018m_alert_audit_log.sql
-- Feature: 018M — Alert Audit & Rendered Body Schema
-- Adds immutable alert audit log with rendered body, template metadata,
-- write-time secret masking stamp, hard size cap tracking, and TTL/expires_at retention.

-- ── alert_audit_log ───────────────────────────────────────────────────────────
-- Immutable authoritative record of every alert/notification sent.
-- Stores the FULL rendered body at send time (not template replay).
-- Secrets are stripped at write time (masked_at records when stripping occurred).
-- expires_at enforces retention policy; rows may be pruned after this timestamp.
CREATE TABLE IF NOT EXISTS alert_audit_log (
  id                  VARCHAR(64)  PRIMARY KEY DEFAULT gen_random_uuid()::text,

  -- Source linkage
  outbound_message_id VARCHAR(64)  NOT NULL REFERENCES messages_out(id) ON DELETE CASCADE,
  tenant_id           VARCHAR(64)  NOT NULL,             -- Row-level tenant isolation
  organization_id     VARCHAR(64),                       -- Top-level org boundary

  -- Authoritative rendered body (immutable after write)
  -- Stored at send time; truncated to ALERT_AUDIT_MAX_BYTES (65536) if oversized.
  rendered_body       TEXT         NOT NULL,
  truncated           BOOLEAN      NOT NULL DEFAULT FALSE, -- TRUE if rendered_body was truncated at write time

  -- Template metadata (optional; populated when a template engine is in use)
  template_id         VARCHAR(128),
  version             VARCHAR(64),
  params              JSONB,                             -- Template parameters used to render the body

  -- Security: write-time masking
  -- masked_at is set to the write timestamp whenever secret stripping was performed.
  -- NULL means no secrets were detected/stripped (not that stripping was skipped).
  masked_at           TIMESTAMPTZ,

  -- Retention / TTL
  -- expires_at = created_at + 90 days (configurable at write time).
  -- Rows with expires_at <= NOW() are eligible for pruning.
  expires_at          TIMESTAMPTZ  NOT NULL,

  -- Lineage
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Tenant-scoped queries (CS dashboards, audit reports)
CREATE INDEX IF NOT EXISTS idx_alert_audit_tenant    ON alert_audit_log(tenant_id, created_at DESC);
-- Retention / TTL pruning job
CREATE INDEX IF NOT EXISTS idx_alert_audit_expires   ON alert_audit_log(expires_at);
-- Join from messages_out
CREATE INDEX IF NOT EXISTS idx_alert_audit_outbound  ON alert_audit_log(outbound_message_id);
-- Org-level compliance queries
CREATE INDEX IF NOT EXISTS idx_alert_audit_org       ON alert_audit_log(organization_id, created_at DESC);
