-- 024_add_consent_exempt_to_messages_out.sql
--
-- Migration: Add consent_exempt column to messages_out
-- Workstream: NI8F (CST SMS Consent Spine)
--
-- Context:
-- CST allows certain system/platform transactional replies (e.g. STOP confirmation,
-- HELP instructions, initial onboarding opt-in prompts) to be flagged with
-- `consent_exempt: true`. These messages are strictly gated by `validateConsentExempt()`,
-- which mandates that the message originates from an authorized project-bound DID.
--
-- Problem:
-- `messages_out` previously lacked a `consent_exempt` column in PostgreSQL.
-- The flag was held only in-memory (`messagesOutStore`). If the CST process
-- restarted, crashed, or ran across worker instances while an exempt reply was
-- queued in the database, `DbClient.getPendingOutboundMessages()` could not
-- reconstruct the `consent_exempt` attribute from PostgreSQL. As a result, the
-- reply failed closed at the consent gate and was permanently refused.
--
-- Solution:
-- Add `consent_exempt BOOLEAN NOT NULL DEFAULT FALSE` to `messages_out`.
-- Existing rows default to `FALSE` (non-exempt), preserving fail-closed behavior.

ALTER TABLE messages_out
  ADD COLUMN IF NOT EXISTS consent_exempt BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN messages_out.consent_exempt IS
  'True if this message is a platform/regulatory reply (e.g. STOP confirmation, HELP) exempt from prior consent, strictly guarded by validateConsentExempt';

-- Verification query (run to verify applied migration):
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'messages_out' AND column_name = 'consent_exempt';

