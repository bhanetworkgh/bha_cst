/**
 * CST Event Contract & Types (cst.event.v1)
 *
 * Defines canonical CST-side event contracts, payloads, and validation
 * schemas for conversation turns, outbound deliveries, and audit streams.
 */

import { z } from 'zod';

// ============================================================================
// 1. Allowed Channels
// ============================================================================

export const ALLOWED_CHANNELS = ['sms', 'voice', 'web', 'whatsapp', 'email'] as const;
export type AllowedChannel = (typeof ALLOWED_CHANNELS)[number];
export type CstChannel = AllowedChannel;

export const CstChannelSchema = z.enum(ALLOWED_CHANNELS);

export function isAllowedChannel(value: unknown): value is AllowedChannel {
  return typeof value === 'string' && (ALLOWED_CHANNELS as readonly string[]).includes(value);
}

// ============================================================================
// 2. Allowed Statuses & Delivery Status
// ============================================================================

/**
 * Lifecycle statuses for a conversation turn.
 */
export const ALLOWED_TURN_STATUSES = [
  'received',
  'processing',
  'synthesized',
  'completed',
  'refused',
  'dropped',
  'failed',
  'timeout',
  'step_up',
  'step_up_required',
  'onboarding',
] as const;
export type AllowedTurnStatus = (typeof ALLOWED_TURN_STATUSES)[number];

export const AllowedTurnStatusSchema = z.enum(ALLOWED_TURN_STATUSES);

/**
 * Outbound delivery statuses for SMS, Voice, and webhook callbacks.
 */
export const ALLOWED_DELIVERY_STATUSES = [
  'pending',
  'queued',
  'sending',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'refused',
] as const;
export type DeliveryStatus = (typeof ALLOWED_DELIVERY_STATUSES)[number];
export type AllowedDeliveryStatus = DeliveryStatus;

export const DeliveryStatusSchema = z.enum(ALLOWED_DELIVERY_STATUSES);

/**
 * Operational statuses for platform tenants and projects.
 */
export const ALLOWED_OPERATIONAL_STATUSES = [
  'active',
  'suspended',
  'closed',
] as const;
export type OperationalStatus = (typeof ALLOWED_OPERATIONAL_STATUSES)[number];

export const OperationalStatusSchema = z.enum(ALLOWED_OPERATIONAL_STATUSES);

/**
 * Aggregate allowed statuses across turns, deliveries, and operations.
 */
export const ALLOWED_STATUSES = [
  ...ALLOWED_TURN_STATUSES,
  ...ALLOWED_DELIVERY_STATUSES,
  ...ALLOWED_OPERATIONAL_STATUSES,
] as const;
export type AllowedStatus = AllowedTurnStatus | DeliveryStatus | OperationalStatus;

export const AllowedStatusSchema = z.union([
  AllowedTurnStatusSchema,
  DeliveryStatusSchema,
  OperationalStatusSchema,
]);

export function isAllowedTurnStatus(value: unknown): value is AllowedTurnStatus {
  return typeof value === 'string' && (ALLOWED_TURN_STATUSES as readonly string[]).includes(value);
}

export function isAllowedDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (ALLOWED_DELIVERY_STATUSES as readonly string[]).includes(value);
}

export function isAllowedStatus(value: unknown): value is AllowedStatus {
  return typeof value === 'string' && (ALLOWED_STATUSES as readonly string[]).includes(value);
}

// ============================================================================
// 3. Intents
// ============================================================================

export const ALLOWED_INTENTS = ['status', 'knowledge', 'images', 'escalate', 'default'] as const;
export type StandardIntent = (typeof ALLOWED_INTENTS)[number];
export type CstIntent = StandardIntent | (string & {});

export const StandardIntentSchema = z.enum(ALLOWED_INTENTS);
export const CstIntentSchema = z.string();

export function isStandardIntent(value: unknown): value is StandardIntent {
  return typeof value === 'string' && (ALLOWED_INTENTS as readonly string[]).includes(value);
}

export const IntentPayloadSchema = z.object({
  name: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  extracted_entities: z.record(z.unknown()).optional(),
  raw_query: z.string().optional(),
});
export type IntentPayload = z.infer<typeof IntentPayloadSchema>;

// ============================================================================
// 4. Duration
// ============================================================================

export const StructuredDurationSchema = z.object({
  total_ms: z.number().nonnegative(),
  processing_ms: z.number().nonnegative().optional(),
  synthesis_ms: z.number().nonnegative().optional(),
  network_ms: z.number().nonnegative().optional(),
  audio_seconds: z.number().nonnegative().optional(),
  call_seconds: z.number().nonnegative().optional(),
  delivery_ms: z.number().nonnegative().optional(),
});
export type StructuredDuration = z.infer<typeof StructuredDurationSchema>;

export const CstDurationSchema = z.union([
  z.number().nonnegative(),
  StructuredDurationSchema,
]);
export type CstDuration = number | StructuredDuration;

// ============================================================================
// 5. Customer Payload
// ============================================================================

export const ALLOWED_CUSTOMER_ROLES = ['owner', 'manager', 'tech', 'unknown'] as const;
export type CustomerRole = (typeof ALLOWED_CUSTOMER_ROLES)[number];
export const CustomerRoleSchema = z.enum(ALLOWED_CUSTOMER_ROLES);

export const CustomerPayloadSchema = z.object({
  customer_ref: z.string().min(1),
  phone_e164: z.string().min(1),
  role: CustomerRoleSchema,
  is_known: z.boolean(),
  tenant_id: z.string().min(1),
  project_id: z.string().min(1),
  person_id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  farm_ids: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CustomerPayload = z.infer<typeof CustomerPayloadSchema>;

// ============================================================================
// 6. Turn Payload (cst.turn)
// ============================================================================

export const TurnDirectionSchema = z.enum(['inbound', 'outbound']);
export type TurnDirection = z.infer<typeof TurnDirectionSchema>;

export const CstTurnSchema = z.object({
  turn_id: z.string().min(1),
  conversation_id: z.string().optional(),
  direction: TurnDirectionSchema,
  channel: CstChannelSchema,
  status: AllowedTurnStatusSchema,
  intent: CstIntentSchema.optional(),
  text: z.string().optional(),
  reply_text: z.string().optional(),
  reply: z.string().optional(),
  audio_url: z.string().url().optional(),
  audio_base64: z.string().optional(),
  mime_type: z.string().optional(),
  voice_id: z.string().optional(),
  model_id: z.string().optional(),
  duration: CstDurationSchema.optional(),
  duration_ms: z.number().nonnegative().optional(),
  incident_id: z.string().optional(),
  tenant_id: z.string().optional(),
  project_id: z.string().optional(),
  customer: CustomerPayloadSchema.optional(),
  error: z.string().optional(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CstTurn = z.infer<typeof CstTurnSchema>;

// ============================================================================
// 7. Delivery Payload (cst.delivery)
// ============================================================================

export const CstDeliverySchema = z.object({
  delivery_id: z.string().min(1),
  turn_id: z.string().optional(),          // correlates back to cst.turn.turn_id
  provider_sid: z.string().optional(),
  channel: CstChannelSchema,
  to: z.string().min(1),
  from: z.string().optional(),
  status: DeliveryStatusSchema,
  intent: CstIntentSchema.optional(),
  duration: CstDurationSchema.optional(),
  segments: z.number().int().nonnegative().optional(),
  error_code: z.union([z.string(), z.number()]).optional(),
  error_message: z.string().optional(),
  delivered_at: z.string().datetime({ offset: true }).optional(),
  retry_count: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CstDelivery = z.infer<typeof CstDeliverySchema>;

// ============================================================================
// 8. Event Envelope & Specification (cst.event.v1)
// ============================================================================

export const CST_EVENT_SPEC_VERSION = 'cst.event.v1' as const;
export type CstEventSpecVersion = typeof CST_EVENT_SPEC_VERSION;

const BaseEventEnvelopeSchema = z.object({
  specversion: z.literal(CST_EVENT_SPEC_VERSION),
  id: z.string().min(1),
  source: z.string().min(1),
  time: z.string().datetime({ offset: true }),
  tenant_id: z.string().min(1),
  project_id: z.string().min(1),
  correlation_id: z.string().min(1),
  channel: CstChannelSchema,
  customer: CustomerPayloadSchema,
  metadata: z.record(z.unknown()).optional(),
});

export const CstTurnEventV1Schema = BaseEventEnvelopeSchema.extend({
  type: z.literal('cst.turn'),
  data: CstTurnSchema,
});
export type CstTurnEventV1 = z.infer<typeof CstTurnEventV1Schema>;

export const CstDeliveryEventV1Schema = BaseEventEnvelopeSchema.extend({
  type: z.literal('cst.delivery'),
  data: CstDeliverySchema,
});
export type CstDeliveryEventV1 = z.infer<typeof CstDeliveryEventV1Schema>;

export const CstEventV1Schema = z.discriminatedUnion('type', [
  CstTurnEventV1Schema,
  CstDeliveryEventV1Schema,
]);
export type CstEventV1 = z.infer<typeof CstEventV1Schema>;

// ============================================================================
// 9. Contract Helper Functions & Builders
// ============================================================================

export function parseCstEventV1(payload: unknown): CstEventV1 {
  return CstEventV1Schema.parse(payload);
}

export function safeParseCstEventV1(payload: unknown) {
  return CstEventV1Schema.safeParse(payload);
}

export function createCstTurnEventV1(params: {
  id: string;
  source?: string;
  time?: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  channel: AllowedChannel;
  customer: CustomerPayload;
  turn: CstTurn;
  metadata?: Record<string, unknown>;
}): CstTurnEventV1 {
  return CstTurnEventV1Schema.parse({
    specversion: CST_EVENT_SPEC_VERSION,
    id: params.id,
    source: params.source || 'cst/engine',
    time: params.time || new Date().toISOString(),
    tenant_id: params.tenant_id,
    project_id: params.project_id,
    correlation_id: params.correlation_id,
    channel: params.channel,
    customer: params.customer,
    type: 'cst.turn',
    data: params.turn,
    metadata: params.metadata,
  });
}

export function createCstDeliveryEventV1(params: {
  id: string;
  source?: string;
  time?: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  channel: AllowedChannel;
  customer: CustomerPayload;
  delivery: CstDelivery;
  metadata?: Record<string, unknown>;
}): CstDeliveryEventV1 {
  return CstDeliveryEventV1Schema.parse({
    specversion: CST_EVENT_SPEC_VERSION,
    id: params.id,
    source: params.source || 'cst/transport',
    time: params.time || new Date().toISOString(),
    tenant_id: params.tenant_id,
    project_id: params.project_id,
    correlation_id: params.correlation_id,
    channel: params.channel,
    customer: params.customer,
    type: 'cst.delivery',
    data: params.delivery,
    metadata: params.metadata,
  });
}
