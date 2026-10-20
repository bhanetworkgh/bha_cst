-- Migration: 021_repair_service_number_bindings.sql
-- Repairs the durable `service_number_bindings` registry so it matches the
-- service numbers CST is actually authorised to use.
--
-- WHY A FORWARD MIGRATION
--   `010_add_projects_bindings_and_project_id.sql` seeded two rows:
--     ('+19715885823', 'tenant-vfarm-01', 'proj-vfarm-main',   'sms', 'bound')
--     ('+19715885824', 'tenant-vfarm-01', 'proj-vfarm-dallas', 'sms', 'bound')
--   010 is already applied on deployed databases and must not be edited. The
--   in-memory `CoreRegistry.resetToDefault()` seed was corrected separately,
--   but the durable row is loaded independently by `CoreRegistry.initFromDb()`,
--   so the database row is what production actually uses. This migration is
--   the forward fix.
--
-- WHAT IS WRONG AND WHY
--   1. `+19715885823` is bound with capability 'sms', so the voice lane could
--      not use it. The number is a single Twilio-owned line that serves BOTH
--      SMS and voice, which the application models with the combined
--      'sms_voice' capability (`engine/src/core/types.ts` -> `matchesCapability`).
--      A service number is bought once; one line serving both transports is the
--      normal case, not an exception.
--
--   2. `+19715885824` is NOT a Twilio-owned number and has no authorised use.
--      Leaving it bound lets a project originate traffic from a number the
--      account does not own, which is what produces Twilio error 21659
--      ("the 'From' number is not a valid phone number, shortcode or
--      alphanumeric sender id"). Binding it is not merely wasteful: it is an
--      unauthorised-sender surface.
--
-- HOW THE STALE ROW IS REMOVED
--   The schema carries `status` and `unbound_at` precisely so a binding can be
--   retired without deleting the row and without losing the record of which
--   number was bound to which project. This migration UNBINDS it
--   (`status = 'unbound'`) rather than deleting it, so the audit trail
--   survives. The in-memory registry filters on `status = 'bound'`, so an
--   unbound row is inert.
--
--   `+19715885825` is NOT deleted or unbound here: it was never seeded into
--   `service_number_bindings` by 010, and this migration must not touch
--   records it does not own.
--
-- DALLAS
--   No replacement sender is invented. `proj-vfarm-dallas` is deliberately
--   left with NO bound SMS number, so Dallas outbound SMS fails closed until
--   an actual owned and approved number is bound for it. Redirecting Dallas
--   traffic through the main project's number would be an unapproved routing
--   decision and is explicitly not done here.
--
-- IDEMPOTENT
--   Re-running makes no further changes: the first UPDATE is guarded to rows
--   that are not already 'sms_voice', and the second to rows still 'bound'.

-- ── 1. The owned number serves both SMS and voice ─────────────────────────
-- Guarded on the tenant/project targets existing, so a fresh database that has
-- not seeded the projects yet is left untouched rather than failing.
UPDATE service_number_bindings
SET capability = 'sms_voice',
    status     = 'bound',
    bound_at   = COALESCE(bound_at, NOW()),
    unbound_at = NULL
WHERE phone_e164 = '+19715885823'
  AND tenant_id  = 'tenant-vfarm-01'
  AND project_id = 'proj-vfarm-main'
  AND capability IS DISTINCT FROM 'sms_voice'
  AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = 'proj-vfarm-main')
  AND EXISTS (SELECT 1 FROM organizations o WHERE o.organization_id = 'tenant-vfarm-01');

-- ── 2. The unowned number is unbound, not deleted ─────────────────────────
-- Only this exact row is affected. Any other row is left alone.
UPDATE service_number_bindings
SET status     = 'unbound',
    unbound_at = NOW()
WHERE phone_e164 = '+19715885824'
  AND tenant_id  = 'tenant-vfarm-01'
  AND project_id = 'proj-vfarm-dallas'
  AND status = 'bound';
