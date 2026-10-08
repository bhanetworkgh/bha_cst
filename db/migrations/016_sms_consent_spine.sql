-- Migration: 016_sms_consent_spine.sql
-- Feature: SMS Consent Spine — canonical opt-in/opt-out consent tracking
--
-- Adds a dedicated persistence model for SMS consent, strictly separate from
-- vFarm membership and the customers table used for identity/farm authorization.
--
-- The CST onboarding flow can now collect a phone number and explicit consent.
-- Identity resolution (phone → vFarm person_id → farm grants → farm authorization)
-- remains unchanged and is NOT derived from consent records.

-- ── 1. sms_consents — canonical consent state per (tenant, project, phone) ────

CREATE TABLE IF NOT EXISTS sms_consents (
  id                VARCHAR(64)  PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id         VARCHAR(64)  NOT NULL,
  project_id        VARCHAR(64),
  phone_e164        VARCHAR(32)  NOT NULL,
  consent_status    VARCHAR(32)  NOT NULL DEFAULT 'not_consented',
  -- Allowed values: 'opted_in', 'opted_out', 'not_consented'
  consented_at      TIMESTAMPTZ,
  opted_out_at      TIMESTAMPTZ,
  wording_version   VARCHAR(64)  NOT NULL,
  wording_snapshot  TEXT         NOT NULL,
  source            VARCHAR(128) NOT NULL DEFAULT 'cst_onboarding',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A phone number has at most one consent record per (tenant, project).
  -- project_id is nullable for backward-compat, but ON CONFLICT uses a
  -- tenant-scoped unique key that handles NULL project_id.
  CONSTRAINT ck_consent_status CHECK (
    consent_status IN ('opted_in', 'opted_out', 'not_consented')
  )
);

-- Unique constraint: one consent record per phone per tenant/project.
-- Uses a computed key so (tenant_id, NULL project_id, phone) is distinct from
-- (tenant_id, 'proj-x', phone) — matching the customers table convention.
CREATE UNIQUE INDEX IF NOT EXISTS unq_sms_consents_tenant_project_phone
  ON sms_consents (tenant_id, COALESCE(project_id, ''), phone_e164);

-- Fast lookups
CREATE INDEX IF NOT EXISTS idx_sms_consents_phone ON sms_consents(phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_consents_tenant ON sms_consents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sms_consents_status ON sms_consents(tenant_id, consent_status);
CREATE INDEX IF NOT EXISTS idx_sms_consents_opted_out
  ON sms_consents(opted_out_at)
  WHERE opted_out_at IS NOT NULL;

-- ── 2. sms_consent_audit — immutable audit trail ────────────────────────────────

CREATE TABLE IF NOT EXISTS sms_consent_audit (
  id                VARCHAR(64)  PRIMARY KEY DEFAULT gen_random_uuid()::text,
  consent_id        VARCHAR(64)  NOT NULL,
  tenant_id         VARCHAR(64)  NOT NULL,
  project_id        VARCHAR(64),
  phone_e164        VARCHAR(32)  NOT NULL,
  action            VARCHAR(32)  NOT NULL,
  -- Allowed values: 'consent_granted', 'consent_revoked', 'consent_updated', 'stop_received'
  previous_status   VARCHAR(32),
  new_status        VARCHAR(32)  NOT NULL,
  wording_version   VARCHAR(64),
  wording_snapshot  TEXT,
  source            VARCHAR(128),
  actor             VARCHAR(255) NOT NULL,  -- 'customer', 'admin', 'stop_keyword', 'twilio_webhook'
  reason            TEXT,
  correlation_id    VARCHAR(128),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- FK to sms_consents (cascade so deletion of a consent record purges its audit)
CREATE INDEX IF NOT EXISTS idx_sms_consent_audit_consent
  ON sms_consent_audit(consent_id);
CREATE INDEX IF NOT EXISTS idx_sms_consent_audit_phone
  ON sms_consent_audit(phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_consent_audit_tenant
  ON sms_consent_audit(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_consent_audit_correlation
  ON sms_consent_audit(correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ── 3. auto-update updated_at on sms_consents ──────────────────────────────────

CREATE OR REPLACE FUNCTION set_sms_consents_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sms_consents_updated_at ON sms_consents;
CREATE TRIGGER trg_sms_consents_updated_at
  BEFORE UPDATE ON sms_consents
  FOR EACH ROW EXECUTE FUNCTION set_sms_consents_updated_at();
