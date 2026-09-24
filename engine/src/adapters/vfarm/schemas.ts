import { z } from 'zod';

/**
 * Schemas for the verified vFarm OpenAPI contract (source of truth:
 * https://bhavfarm1.duckdns.org/openapi.json — see
 * docs handoff "vFarm ↔ CST Integration Handoff" §19).
 *
 * These intentionally validate ONLY the fields that were verified against the
 * live OpenAPI document. Do not add fields here on the strength of a guess —
 * re-check the live document first (handoff §"Source of truth").
 */

// ── GET /api/v1/organizations/{org_id}/users ────────────────────────────────
// Operation: list_organization_members_api_v1_organizations__org_id__users_get
// NOTE: verified response does NOT include a phone/phone_e164/phone_number/mobile
// field. Do not add one here — see handoff §6.
export const orgMemberSchema = z.object({
  user_id: z.string().min(1),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  granted_by: z.string().nullish().transform((v) => v ?? null),
  granted_at: z.string().min(1),
});
export type OrgMember = z.infer<typeof orgMemberSchema>;
export const orgMemberListSchema = z.array(orgMemberSchema);

// ── GET /api/v1/farms/{farm_id}/users ────────────────────────────────────────
// Field-level shape for this endpoint was not enumerated in the verified
// handoff beyond "list users with roles for a farm" — validate defensively
// (only the fields we actually rely on) rather than fabricating a full shape.
export const farmUserSchema = z.object({
  user_id: z.string().min(1),
  role: z.string().optional(),
}).passthrough();
export type FarmUser = z.infer<typeof farmUserSchema>;
export const farmUserListSchema = z.array(farmUserSchema);

// ── GET /api/v1/users/{user_id}/farm-grants ─────────────────────────────────
// Same caveat as farmUserSchema above: exact shape wasn't enumerated in the
// verified handoff. Only `farm_id` is treated as load-bearing; anything else
// is passed through without being assumed/relied upon.
export const farmGrantSchema = z.object({
  farm_id: z.string().min(1),
  role: z.string().optional(),
}).passthrough();
export type FarmGrant = z.infer<typeof farmGrantSchema>;
export const farmGrantListSchema = z.array(farmGrantSchema);

// ── GET /api/v1/inventory/{serial_number} ───────────────────────────────────
// Operation: get_inventory_item_api_v1_inventory__serial_number__get
// `farm_id` is load-bearing for authorization (handoff §9) — nullable in the
// live contract, and CST must fail closed when it is missing/null/empty.
export const inventoryItemSchema = z.object({
  serial_number: z.string().min(1),
  catalog_id: z.string(),
  device_name: z.string(),
  family_id: z.string(),
  family_label: z.string(),
  hardware_revision: z.string().nullable().optional(),
  catalog_is_active: z.boolean(),
  firmware_version: z.string().nullable().optional(),
  status: z.string(),
  farm_id: z.string().nullable(),
  farm_name: z.string().nullable().optional(),
  org_id: z.string().nullable().optional(),
  org_name: z.string().nullable().optional(),
  device_id: z.string().nullable().optional(),
  registered_at: z.string().nullable().optional(),
  allocated_at: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  connected: z.boolean().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  connection_state: z.string().nullable().optional(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

// ── GET /api/v1/inventory/{serial_number}/config ────────────────────────────
// Operation: get_unit_config_api_v1_inventory__serial_number__config_get
export const unitConfigCurrentSchema = z.object({
  config_hash: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string(),
  spec_version: z.string(),
  cad_revision: z.string().nullish().transform((v) => v ?? null),
  effective_at: z.string().min(1),
});
export type UnitConfigCurrent = z.infer<typeof unitConfigCurrentSchema>;

export const unitConfigHistoryItemSchema = z.object({
  config_hash: z.string().regex(/^[0-9a-f]{64}$/),
  effective_at: z.string().min(1),
});

export const unitConfigResponseSchema = z.object({
  serial_number: z.string().min(1),
  current: unitConfigCurrentSchema,
  history: z.array(unitConfigHistoryItemSchema),
});
export type UnitConfigResponse = z.infer<typeof unitConfigResponseSchema>;

// ── GET /api/v1/configs/{config_hash} ────────────────────────────────────────
// Operation: get_config_api_v1_configs__config_hash__get
export const configPartSchema = z.object({
  part_code: z.string(),
  part_kind: z.string(),
  length_mm: z.number().int(),
  width_mm: z.number().int(),
  height_mm: z.number().int(),
  attributes: z.record(z.unknown()),
  quantity: z.number().int(),
});

export const configResponseSchema = z.object({
  config_hash: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string(),
  spec_version: z.string(),
  cad_revision: z.string().nullish().transform((v) => v ?? null),
  created_at: z.string(),
  parts: z.array(configPartSchema),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

/** 64-char lowercase hex — validate before using a config_hash in a request path. */
export const CONFIG_HASH_RE = /^[0-9a-f]{64}$/;
