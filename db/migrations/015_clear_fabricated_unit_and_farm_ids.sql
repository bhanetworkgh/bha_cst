-- Migration: 015_clear_fabricated_unit_and_farm_ids.sql
-- Removes invented vFarm unit/farm identifiers from `customers`.
--
-- 006_seed_initial_customers.sql used to write literal strings
-- ('unit_bay_01', 'unit_bay_04', 'unit_bay_12', 'bay_04', 'farm_austin_main').
-- Those names identify units and farms that do not exist upstream, so anything
-- keyed off them was either dead or wrong.
--
-- Evidence that no real value can be lost here — the live vFarm OpenAPI
-- (130 paths / 213 operations, 405,961 bytes) and 14 GET probes:
--
--   * There is NO user -> unit/zone/location endpoint. `user_id` appears 12
--     times as an exact JSON key and every occurrence is a role or grant
--     schema, never a place schema. `assignee`, `assigned`, `technician`,
--     `staff`, and `person` are 0 occurrences. `DevicePlacement` has exactly
--     three properties — zone_id, location_id, sublocation_id — and
--     `additionalProperties: true` with prose confirming rack_id/node_id/
--     position "are gone with the columns they wrote".
--   * Upstream acknowledges the column and withholds it: `InventoryUpdate`
--     states "the registered_complete CHECK also requires device_id, farm_id,
--     owner_user_id and registered_at" and concludes "Those columns belong to
--     the assignment spec", yet `owner_user_id` is 0 occurrences and
--     `InventoryResponse` exposes 21 fields without it.
--   * vFarm has no phone or e164 field anywhere (0 occurrences of phone,
--     e164, mobile, msisdn, whatsapp, sms_number in the whole spec), so
--     CST cannot resolve a caller to a vFarm member either.
--
-- Real vFarm identifiers are UUIDs (zone f94741fb-…, farm
-- ed95e120-…/21dde23e-…). Therefore any value on this column that is not a
-- UUID is fabricated seed data, and clearing it loses nothing real.
--
-- This is also the only correct source of farm authorization: the live
-- `GET /api/v1/users/{user_id}/farm-grants` lookup. `customers.unit_id` is
-- never read to build a unit context; the sole unit id CST trusts is
-- `speaker.unit_context.unit_id`, which the adapter omits unless vFarm
-- supplies one.
--
-- Scoped to tenant-vfarm-01, and additive to 006 rather than a rewrite of it:
-- 006 is already applied on deployed databases and must not be edited, while
-- a fresh database still needs it to stop writing fabricated ids.
--
-- Idempotent: re-running clears nothing.

UPDATE customers
SET unit_id = NULL
WHERE tenant_id = 'tenant-vfarm-01'
  AND unit_id IS NOT NULL
  AND unit_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE customers
SET farm_id = NULL
WHERE tenant_id = 'tenant-vfarm-01'
  AND farm_id IS NOT NULL
  AND farm_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
