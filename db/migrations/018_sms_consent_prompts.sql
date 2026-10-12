-- Migration: 018_sms_consent_prompts.sql
-- Feature: SMS Consent Spine — prompt evidence tracking
--
-- Tracks every canonical consent prompt sent to a phone so that a subsequent
-- YES / I AGREE reply can be cryptographically (and forensically) tied to a
-- real prompt that was actually dispatched. This closes the gap where any
-- inbound "yes" from any caller was sufficient to record consent without proof
-- that a consent prompt had been shown to that phone.

CREATE TABLE IF NOT EXISTS sms_consent_prompts (
  id                VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  consent_id        VARCHAR(64),
  phone_e164        VARCHAR(32)  NOT NULL,
  tenant_id         VARCHAR(64)  NOT NULL,
  project_id        VARCHAR(64),
  prompt_type       VARCHAR(32)  NOT NULL,
  -- 'onboarding'   — initial consent prompt shown during onboarding
  -- 'resubscribe'  — re-subscribe prompt shown after START
  wording_version   VARCHAR(64)  NOT NULL,
  wording_snapshot  TEXT         NOT NULL,
  sent_at           TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at        TIMESTAMPTZ  NOT NULL
);

-- One active prompt record per (tenant, project, phone). A new prompt
-- upserts the record for the same destination, matching the single-source
-- "what was the last thing we told the customer" contract.
CREATE UNIQUE INDEX IF NOT EXISTS unq_sms_consent_prompts_active
  ON sms_consent_prompts (tenant_id, COALESCE(project_id, ''), phone_e164);

-- FK to the consent record this prompt ultimately led to (nullable until YES).
CREATE INDEX IF NOT EXISTS idx_sms_consent_prompts_consent
  ON sms_consent_prompts(consent_id)
  WHERE consent_id IS NOT NULL;

-- Look up prompt for an inbound YES by phone+tenant+project.
CREATE INDEX IF NOT EXISTS idx_sms_consent_prompts_active_lookup
  ON sms_consent_prompts (tenant_id, COALESCE(project_id, ''), phone_e164, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_consent_prompts_phone ON sms_consent_prompts(phone_e164);
CREATE INDEX IF NOT EXISTS idx_sms_consent_prompts_tenant ON sms_consent_prompts(tenant_id);