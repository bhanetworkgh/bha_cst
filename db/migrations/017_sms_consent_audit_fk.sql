-- Migration: 017_sms_consent_audit_fk.sql
-- Feature: SMS Consent Spine — harden audit integrity
--
-- Adds a real foreign-key constraint from sms_consent_audit.consent_id
-- to sms_consents.id so an audit row can never reference a consent record
-- that does not exist. The previous migration (016) created only an index
-- on the column, which left audit rows free to point at arbitrary ids.

-- Ensure sms_consents has unique constraint on (id, tenant_id) for composite FK
CREATE UNIQUE INDEX IF NOT EXISTS unq_sms_consents_id_tenant
  ON sms_consents (id, tenant_id);

ALTER TABLE sms_consent_audit
  ADD CONSTRAINT fk_sms_consent_audit_consent
  FOREIGN KEY (consent_id, tenant_id) REFERENCES sms_consents(id, tenant_id)
  ON DELETE CASCADE;

-- Enforce append-only protection on sms_consent_audit
CREATE OR REPLACE FUNCTION enforce_sms_consent_audit_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sms_consent_audit is append-only: updates and deletes are prohibited';
END;
$$;

DROP TRIGGER IF EXISTS trg_sms_consent_audit_append_only ON sms_consent_audit;
CREATE TRIGGER trg_sms_consent_audit_append_only
  BEFORE UPDATE OR DELETE ON sms_consent_audit
  FOR EACH ROW EXECUTE FUNCTION enforce_sms_consent_audit_append_only();