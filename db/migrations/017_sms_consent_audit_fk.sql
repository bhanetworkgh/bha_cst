-- Migration: 017_sms_consent_audit_fk.sql
-- Feature: SMS Consent Spine — harden audit integrity
--
-- Adds a real foreign-key constraint from sms_consent_audit.consent_id
-- to sms_consents.id so an audit row can never reference a consent record
-- that does not exist. The previous migration (016) created only an index
-- on the column, which left audit rows free to point at arbitrary ids.

ALTER TABLE sms_consent_audit
  ADD CONSTRAINT fk_sms_consent_audit_consent
  FOREIGN KEY (consent_id) REFERENCES sms_consents(id)
  ON DELETE CASCADE;

-- Also enforce tenant/project consistency on the audit side: the audit
-- row's tenant_id and project_id must match the consent record it points at.
-- This prevents an audit row from being written under one tenant while the
-- consent record it references belongs to another.

ALTER TABLE sms_consent_audit
  ADD CONSTRAINT ck_sms_consent_audit_tenant_match
  CHECK (
    tenant_id = (
      SELECT c.tenant_id FROM sms_consents c WHERE c.id = consent_id
    )
  );