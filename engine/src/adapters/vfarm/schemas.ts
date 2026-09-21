/**
 * Zod schemas for vFarm live API responses.
 * Aligned to the live OpenAPI contract at https://bhavfarm1.duckdns.org/openapi.json
 * Schemas are intentionally strict where the contract allows it.
 *
 * IMPORTANT: vFarm user objects (OrgMemberResponse, GrantedFarmRow) do NOT
 * expose any phone / phone_number / phone_e164 / mobile field.
 * Speaker-to-phone mapping must come from CST's authoritative local binding.
 * Never invent a phone lookup from vFarm user records.
 */
import { z } from 'zod';

// ── Config hash pattern (enforced by live OpenAPI) ────────────────────────────
export const CONFIG_HASH_PATTERN = /^[0-9a-f]{64}$/;

// ── Organization member (GET /api/v1/organizations/{org_id}/users) ───────────
// Returns: user_id, email, name, role, granted_by (nullable), granted_at
// DOES NOT return: phone, phone_number, phone_e164, mobile
export const OrgMemberResponseSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  granted_by: z.string().nullable().optional(),
  granted_at: z.string(),
});
export type OrgMemberResponse = z.infer<typeof OrgMemberResponseSchema>;

// ── Farm user row (GET /api/v1/farms/{farm_id}/users) ────────────────────────
// Unschema'd upstream (returns {}), accept a permissive object
export const FarmUserRowSchema = z.object({
  user_id: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
  role: z.string().optional(),
}).passthrough();
export type FarmUserRow = z.infer<typeof FarmUserRowSchema>;

// ── Farm grant row (GET /api/v1/users/{user_id}/farm-grants) ─────────────────
export const GrantedFarmRowSchema = z.object({
  farm_id: z.string(),
  role: z.string(),
  granted_by: z.string().nullable().optional(),
  granted_at: z.string(),
});
export type GrantedFarmRow = z.infer<typeof GrantedFarmRowSchema>;

export const BulkGrantResponseSchema = z.object({
  grants: z.array(GrantedFarmRowSchema),
  total: z.number().int(),
});
export type BulkGrantResponse = z.infer<typeof BulkGrantResponseSchema>;

// ── Inventory (GET /api/v1/inventory/{serial_number}) ────────────────────────
// farm_id is nullable (device may be unallocated); it is the authoritative
// field for cabinet authorization — NEVER use client-supplied farm_id.
export const InventoryResponseSchema = z.object({
  serial_number: z.string(),
  catalog_id: z.string(),
  device_name: z.string(),
  family_id: z.string(),
  family_label: z.string(),
  hardware_revision: z.string().nullable().optional(),
  catalog_is_active: z.boolean(),
  firmware_version: z.string().nullable().optional(),
  status: z.string(),
  farm_id: z.string().nullable().optional(),     // KEY for authorization
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
export type InventoryResponse = z.infer<typeof InventoryResponseSchema>;

// ── Unit config current (part of UnitConfigResponse) ─────────────────────────
export const UnitConfigCurrentSchema = z.object({
  config_hash: z.string().regex(CONFIG_HASH_PATTERN, 'config_hash must be 64 hex chars'),
  name: z.string(),
  spec_version: z.string(),
  cad_revision: z.string().nullable().optional(),
  effective_at: z.string(),
});
export type UnitConfigCurrent = z.infer<typeof UnitConfigCurrentSchema>;

// ── Unit config history item ──────────────────────────────────────────────────
export const UnitConfigHistoryItemSchema = z.object({
  config_hash: z.string().regex(CONFIG_HASH_PATTERN, 'config_hash must be 64 hex chars'),
  effective_at: z.string(),
});
export type UnitConfigHistoryItem = z.infer<typeof UnitConfigHistoryItemSchema>;

// ── UnitConfigResponse (GET /api/v1/inventory/{serial_number}/config) ─────────
// Upstream contract: serial_number, current, and history are all required.
export const UnitConfigResponseSchema = z.object({
  serial_number: z.string(),
  current: UnitConfigCurrentSchema,
  history: z.array(UnitConfigHistoryItemSchema),
});
export type UnitConfigResponse = z.infer<typeof UnitConfigResponseSchema>;

// ── Config part (sub-item of ConfigResponse) ─────────────────────────────────
// length_mm, width_mm, height_mm, and quantity are integers per the live spec.
export const ConfigPartSchema = z.object({
  part_code: z.string(),
  part_kind: z.string(),
  length_mm: z.number().int(),
  width_mm: z.number().int(),
  height_mm: z.number().int(),
  attributes: z.record(z.unknown()),
  quantity: z.number().int(),
});
export type ConfigPart = z.infer<typeof ConfigPartSchema>;

// ── ConfigResponse (GET /api/v1/configs/{config_hash}) ───────────────────────
export const ConfigResponseSchema = z.object({
  config_hash: z.string().regex(CONFIG_HASH_PATTERN, 'config_hash must be 64 hex chars'),
  name: z.string(),
  spec_version: z.string(),
  cad_revision: z.string().nullable().optional(),
  created_at: z.string(),
  parts: z.array(ConfigPartSchema),
});
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;
