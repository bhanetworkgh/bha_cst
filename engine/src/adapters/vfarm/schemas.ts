import { z } from 'zod';

/**
 * Schemas for the verified vFarm OpenAPI contract (source of truth:
 * .openapi-vfarm.json in the project root — parsed from https://bhavfarm1.duckdns.org/openapi.json).
 *
 * Each schema is aligned to a named component in the OpenAPI spec.
 * passthrough() on leaf objects ensures forward-compat with new fields.
 */

// ── GET /api/v1/organizations/{org_id}/users ────────────────────────────────
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
export const farmUserSchema = z.object({
  user_id: z.string().min(1),
  role: z.string().optional(),
}).passthrough();
export type FarmUser = z.infer<typeof farmUserSchema>;
export const farmUserListSchema = z.array(farmUserSchema);

// ── GET /api/v1/users/{user_id}/farm-grants ─────────────────────────────────
export const farmGrantSchema = z.object({
  farm_id: z.string().min(1),
  role: z.string().optional(),
}).passthrough();
export type FarmGrant = z.infer<typeof farmGrantSchema>;
export const farmGrantListSchema = z.array(farmGrantSchema);

/**
 * Normalize a farm-grants payload that may arrive either as a bare array or as
 * an envelope like `{ grants: [...], total: n }`.
 *
 * The repository previously carried two contradictory assumptions (the http
 * client required a bare array, the live client required the envelope). Getting
 * this wrong is not a loud failure: `pullSpeakers` treats a farm-grants error as
 * best-effort and keeps the last-known `farm_ids`, so farm scope would go
 * silently stale. Accepting both shapes removes that failure mode without
 * guessing which one vFarm actually returns.
 */
export function normalizeFarmGrants(raw: unknown): FarmGrant[] {
  const direct = farmGrantListSchema.safeParse(raw);
  if (direct.success) return direct.data;

  const enveloped = BulkGrantResponseSchema.safeParse(raw);
  if (enveloped.success) return enveloped.data.grants;

  throw new Error('farm-grants response matched neither array nor { grants } shape');
}

// ── GET /api/v1/inventory/{serial_number} ───────────────────────────────────
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
}).passthrough();
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

// ── GET /api/v1/inventory/{serial_number}/config ────────────────────────────
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

// ── GET /api/v1/health ──────────────────────────────────────────────────────
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'error']).default('ok'),
  db: z.enum(['ok', 'error']).default('ok'),
  version: z.string().default('1.0.0'),
}).passthrough();
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ── GET /api/v1/organizations ──────────────────────────────────────────────
export const orgResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  is_active: z.boolean(),
  created_by: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();
export type OrgResponse = z.infer<typeof orgResponseSchema>;

export const orgListResponseSchema = z.object({
  organizations: z.array(orgResponseSchema),
  total: z.number().int(),
}).passthrough();
export type OrgListResponse = z.infer<typeof orgListResponseSchema>;

// ── GET /api/v1/farms & /api/v1/farms/{farm_id} ──────────────────────────────
export const farmResponseSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  code: z.string().optional(),
  is_active: z.boolean().optional(),
  device_count: z.number().int().optional(),
  org_id: z.string().nullable().optional(),
  org_name: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();
export type FarmResponse = z.infer<typeof farmResponseSchema>;

export const farmListResponseSchema = z.object({
  farms: z.array(farmResponseSchema),
  total: z.number().int().optional(),
}).passthrough();
export type FarmListResponse = z.infer<typeof farmListResponseSchema>;

// ── GET /api/v1/farms/{farm_id}/health ──────────────────────────────────────
export const farmHealthResponseSchema = z.object({
  status: z.string().optional(),
  health_score: z.number().optional(),
  score: z.number().optional(),
}).passthrough();
export type FarmHealthResponse = z.infer<typeof farmHealthResponseSchema>;

// ── GET /api/v1/farms/{farm_id}/layout ──────────────────────────────────────
export const layoutZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  // `kind` is null in the live response (verified against the running vFarm
  // service), and the upstream spec declares it as
  // `anyOf: [{type: "string"}, {type: "null"}]`. It was declared `.optional()`
  // only, so a real layout response failed validation here and getFarmLayout()
  // threw a ZodError in production. Match the spec.
  kind: z.string().nullable().optional(),
  cabinet_serial: z.string().nullable().optional(),
  sort_order: z.number().int().nullable().optional(),
  is_active: z.boolean().optional(),
  config: z.record(z.unknown()).nullable().optional(),
  locations: z.array(z.record(z.unknown())).optional(),
}).passthrough();
export type LayoutZone = z.infer<typeof layoutZoneSchema>;

export const layoutResponseSchema = z.object({
  farm_id: z.string(),
  farm_code: z.string().optional(),
  zones: z.array(layoutZoneSchema),
}).passthrough();
export type LayoutResponse = z.infer<typeof layoutResponseSchema>;

// ── GET /api/v1/farms/{farm_id}/zones ───────────────────────────────────────
export const zoneResponseSchema = z.object({
  farm_id: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
}).passthrough();
export type ZoneResponse = z.infer<typeof zoneResponseSchema>;

// ── GET /api/v1/devices ──────────────────────────────────────────────────────
export const deviceResponseSchema = z.object({
  id: z.string(),
  device_type: z.string().optional(),
  device_type_label: z.string().optional(),
  device_model: z.string().nullable().optional(),
  device_model_name: z.string().nullable().optional(),
  sensor_type_id: z.string().nullable().optional(),
  device_type_id: z.string().nullable().optional(),
  parent_device_id: z.string().nullable().optional(),
  child_device_count: z.number().int().optional(),
  farm_id: z.string().nullable().optional(),
  zone_id: z.string().nullable().optional(),
  location_id: z.string().nullable().optional(),
  sublocation_id: z.string().nullable().optional(),
  status: z.string().optional(),
  health_score: z.number().nullable().optional(),
  last_seen_at: z.string().nullable().optional(),
  last_reading_at: z.string().nullable().optional(),
  current_state: z.record(z.unknown()).nullable().optional(),
  capabilities: z.array(z.unknown()).nullable().optional(),
  firmware_version: z.string().nullable().optional(),
  hardware_revision: z.string().nullable().optional(),
  mac_address: z.string().nullable().optional(),
  ip_address: z.string().nullable().optional(),
  config: z.record(z.unknown()).nullable().optional(),
  calibration_data: z.record(z.unknown()).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  notes: z.string().nullable().optional(),
  installed_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  children: z.array(z.unknown()).nullable().optional(),
}).passthrough();
export type DeviceResponse = z.infer<typeof deviceResponseSchema>;

export const deviceListResponseSchema = z.object({
  devices: z.array(deviceResponseSchema),
  total: z.number().int().optional(),
  online_count: z.number().int().optional(),
  offline_count: z.number().int().optional(),
  registered_count: z.number().int().optional(),
  maintenance_count: z.number().int().optional(),
}).passthrough();
export type DeviceListResponse = z.infer<typeof deviceListResponseSchema>;

// ── GET /api/v1/devices/{device_id}/rollup ──────────────────────────────────
export const attachedDeviceSchema = z.object({
  id: z.string(),
  device_type: z.string().optional(),
}).passthrough();

export const deviceRollupResponseSchema = z.object({
  device_id: z.string(),
  attached: z.array(attachedDeviceSchema),
  total_attached: z.number().int(),
}).passthrough();
export type DeviceRollupResponse = z.infer<typeof deviceRollupResponseSchema>;

// ── GET /api/v1/readings/latest ──────────────────────────────────────────────
export const latestReadingResponseSchema = z.object({
  device_id: z.string().optional(),
  sensor_id: z.string().optional(),
  reading_at: z.string().optional(),
  value: z.unknown().optional(),
  unit: z.string().optional(),
}).passthrough();
export type LatestReadingResponse = z.infer<typeof latestReadingResponseSchema>;

// ── GET /api/v1/readings ────────────────────────────────────────────────────
export const readingItemSchema = z.object({
  reading_at: z.string(),
  value: z.unknown(),
  unit: z.string().optional(),
}).passthrough();

export const readingsListResponseSchema = z.object({
  readings: z.array(readingItemSchema).optional(),
  items: z.array(readingItemSchema).optional(),
  total: z.number().int().optional(),
}).passthrough();
export type ReadingsListResponse = z.infer<typeof readingsListResponseSchema>;

// ── GET /api/v1/readings/stats ──────────────────────────────────────────────
export const statsResponseSchema = z.object({
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  avg: z.number().nullable().optional(),
  count: z.number().int().optional(),
  unit: z.string().optional(),
  window: z.string().optional(),
}).passthrough();
export type StatsResponse = z.infer<typeof statsResponseSchema>;

// ── GET /api/v1/alerts/threshold/counts ─────────────────────────────────────
export const placeCountSchema = z.object({
  rung: z.string().optional(),
  farm_id: z.string().optional(),
  zone_id: z.string().nullable().optional(),
  location_id: z.string().nullable().optional(),
  sublocation_id: z.string().nullable().optional(),
  farm_name: z.string().nullable().optional(),
  farm_code: z.string().nullable().optional(),
  zone_name: z.string().nullable().optional(),
  location_name: z.string().nullable().optional(),
  sublocation_name: z.string().nullable().optional(),
  critical: z.number().int().optional(),
  warning: z.number().int().optional(),
  info: z.number().int().optional(),
  total: z.number().int().optional(),
}).passthrough();
export type PlaceCount = z.infer<typeof placeCountSchema>;

export const placeCountListResponseSchema = z.object({
  counts: z.array(placeCountSchema),
}).passthrough();
export type PlaceCountListResponse = z.infer<typeof placeCountListResponseSchema>;

// ── GET /api/v1/alerts/threshold/open ───────────────────────────────────────
export const openAlertSchema = z.object({
  id: z.string(),
  rule_id: z.string().optional(),
  device_id: z.string().optional(),
  severity: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().nullable().optional(),
  last_value: z.number().nullable().optional(),
  opened_at: z.string().optional(),
  farm_id: z.string().optional(),
  zone_id: z.string().nullable().optional(),
  location_id: z.string().nullable().optional(),
  sublocation_id: z.string().nullable().optional(),
  farm_name: z.string().nullable().optional(),
  zone_name: z.string().nullable().optional(),
  location_name: z.string().nullable().optional(),
  sublocation_name: z.string().nullable().optional(),
}).passthrough();
export type OpenAlert = z.infer<typeof openAlertSchema>;

export const openAlertListResponseSchema = z.object({
  alerts: z.array(openAlertSchema),
  total: z.number().int(),
}).passthrough();
export type OpenAlertListResponse = z.infer<typeof openAlertListResponseSchema>;

// ── GET /api/v1/alerts/history ──────────────────────────────────────────────
export const alertHistoryItemSchema = z.object({
  id: z.string(),
  event_id: z.string().optional(),
  device_id: z.string().optional(),
  event_type: z.string().optional(),
  rule_id: z.string().optional(),
  channel_id: z.string().optional(),
  status: z.string().optional(),
  suppression_reason: z.string().nullable().optional(),
  response_code: z.number().int().nullable().optional(),
  latency_ms: z.number().nullable().optional(),
  alerted_at: z.string().optional(),
}).passthrough();
export type AlertHistoryItem = z.infer<typeof alertHistoryItemSchema>;

export const alertHistoryListResponseSchema = z.object({
  alerts: z.array(alertHistoryItemSchema),
  total: z.number().int(),
}).passthrough();
export type AlertHistoryListResponse = z.infer<typeof alertHistoryListResponseSchema>;

// ── GET /api/v1/vision/images/latest ────────────────────────────────────────
export const imageAnalysisSchema = z.object({
  image_id: z.string().optional(),
  analysed: z.boolean().optional(),
  duplicate_of: z.string().nullable().optional(),
  job: z.unknown().nullable().optional(),
  summary: z.string().nullable().optional(),
  verdicts: z.array(z.unknown()).nullable().optional(),
  detail: z.unknown().nullable().optional(),
}).passthrough();
export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;

// ── Auth / token schemas (dynamic auth flow) ────────────────────────────────
export const loginResponseSchema = z.object({
  access_token: z.string().optional(),
  token: z.string().optional(),
  token_type: z.string().optional(),
}).passthrough();
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const tokenCreatedResponseSchema = z.object({
  id: z.string().optional(),
  raw_key: z.string().optional(),
  farm_id: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  expires_at: z.string().nullable().optional(),
}).passthrough();
export type TokenCreatedResponse = z.infer<typeof tokenCreatedResponseSchema>;

export const tokenResponseSchema = z.object({
  id: z.string().optional(),
  farm_id: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  last_used_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
}).passthrough();
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

// ── Backward-compat aliases (used by live_client.ts and index.ts) ──────────
export const OrgMemberResponseSchema = orgMemberSchema;
export type OrgMemberResponse = OrgMember;
export const FarmUserRowSchema = farmUserSchema;
export type FarmUserRow = FarmUser;
export const GrantedFarmRowSchema = farmGrantSchema;
export type GrantedFarmRow = FarmGrant;
export const BulkGrantResponseSchema = z.object({
  grants: z.array(farmGrantSchema),
  total: z.number().int().optional(),
}).passthrough();
export type BulkGrantResponse = z.infer<typeof BulkGrantResponseSchema>;
export const InventoryResponseSchema = inventoryItemSchema;
export type InventoryResponse = InventoryItem;
export const UnitConfigResponseSchema = unitConfigResponseSchema;
export const ConfigResponseSchema = configResponseSchema;
export const CONFIG_HASH_PATTERN = CONFIG_HASH_RE;
export const FarmResponseSchema = farmResponseSchema;
export const FarmListResponseSchema = farmListResponseSchema;
export const FarmHealthResponseSchema = farmHealthResponseSchema;
export const DeviceListResponseSchema = deviceListResponseSchema;
export const LatestReadingResponseSchema = latestReadingResponseSchema;
export const ReadingsListResponseSchema = readingsListResponseSchema;
export const StatsResponseSchema = statsResponseSchema;
export const LoginResponseSchema = loginResponseSchema;
export const TokenCreatedResponseSchema = tokenCreatedResponseSchema;
export const TokenResponseSchema = tokenResponseSchema;


