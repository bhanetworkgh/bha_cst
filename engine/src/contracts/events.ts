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
 * The Engine Dashboard's REQUIRED `cst.turn` status contract.
 *
 * `ALLOWED_TURN_STATUSES` above is the wide, schema-level union (it also carries
 * internal/transitional values such as `received`, `processing`, `synthesized`
 * and `dropped`, which exist for voice/transport bookkeeping). Everything the
 * dashboard consumes must instead land on exactly one of these five values, so
 * the dashboard never has to interpret CST-internal lifecycle names.
 */
export const REQUIRED_TURN_STATUSES = [
  'ok',
  'refused',
  'step_up_required',
  'onboarding',
  'error',
] as const;
export type RequiredTurnStatus = (typeof REQUIRED_TURN_STATUSES)[number];

export const RequiredTurnStatusSchema = z.enum(REQUIRED_TURN_STATUSES);

export function isRequiredTurnStatus(value: unknown): value is RequiredTurnStatus {
  return typeof value === 'string' && (REQUIRED_TURN_STATUSES as readonly string[]).includes(value);
}

/**
 * Internal `CoreEngine` outcome names, as produced by the pipeline itself.
 * These are never published verbatim — they are translated through
 * {@link mapInternalStatusToContractStatus}.
 */
export const INTERNAL_ENGINE_STATUSES = [
  'completed',
  'refused',
  'step_up',
  'onboarding',
  'failed',
  'dropped',
  'timeout',
  'received',
  'processing',
  'synthesized',
] as const;
export type InternalEngineStatus = (typeof INTERNAL_ENGINE_STATUSES)[number];

/**
 * Explicit, total mapping from an internal CoreEngine result to the required
 * dashboard status. There is deliberately no default pass-through: any internal
 * value that is not recognised becomes `error`, because an unknown status is a
 * contract violation and must never reach the dashboard as-is.
 *
 *   completed  → ok                 (turn produced a customer-facing answer)
 *   refused    → refused            (tenant isolation / RBAC / scope denial)
 *   step_up    → step_up_required   (sensitive action, step-up not satisfied)
 *   onboarding → onboarding          (unknown speaker, safe generic reply)
 *   failed     → error              (unexpected exception)
 *   dropped/timeout/received/processing/synthesized → error / ok per below
 */
export function mapInternalStatusToContractStatus(
  internalStatus: string | undefined | null
): RequiredTurnStatus {
  switch (internalStatus) {
    case 'completed':
    case 'ok':
      return 'ok';
    case 'refused':
    case 'dropped':
      return 'refused';
    case 'step_up':
    case 'step_up_required':
      return 'step_up_required';
    case 'onboarding':
      return 'onboarding';
    case 'synthesized':
    case 'processing':
    case 'received':
      return 'ok';
    case 'failed':
    case 'timeout':
    case 'error':
      return 'error';
    default:
      return 'error';
  }
}

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
  ...REQUIRED_TURN_STATUSES,
  ...ALLOWED_TURN_STATUSES,
  ...ALLOWED_DELIVERY_STATUSES,
  ...ALLOWED_OPERATIONAL_STATUSES,
] as const;
export type AllowedStatus =
  | AllowedTurnStatus
  | RequiredTurnStatus
  | DeliveryStatus
  | OperationalStatus;

export const AllowedStatusSchema = z.union([
  AllowedTurnStatusSchema,
  RequiredTurnStatusSchema,
  DeliveryStatusSchema,
  OperationalStatusSchema,
]);

export function isAllowedTurnStatus(value: unknown): value is AllowedTurnStatus {
  return typeof value === 'string' && (ALLOWED_TURN_STATUSES as readonly string[]).includes(value);
}

export function isAllowedDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (ALLOWED_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * Canonical monotonic rank for a delivery status, shared by the event publisher
 * and the persistence layer so a delivery state can never move backwards in
 * either place.
 *
 *   queued(1) -> sending(2) -> sent(3) -> delivered(4)
 *                                       \-> undelivered(4) | failed(4)
 *
 * An unknown/undefined status ranks 0 so it can never overwrite real state.
 */
export const DELIVERY_STATUS_RANK: Record<string, number> = {
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
};

export function deliveryStatusRank(status: string | undefined | null): number {
  return DELIVERY_STATUS_RANK[(status || '').toLowerCase()] ?? 0;
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
  extracted_entities: z.record(z.string(), z.unknown()).optional(),
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
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CustomerPayload = z.infer<typeof CustomerPayloadSchema>;

// ============================================================================
// 6. Turn Payload (cst.turn)
// ============================================================================

export const TurnDirectionSchema = z.enum(['inbound', 'outbound']);
export type TurnDirection = z.infer<typeof TurnDirectionSchema>;

/**
 * Statuses a `cst.turn` event may carry: the five REQUIRED dashboard contract
 * values, plus the wide `ALLOWED_TURN_STATUSES` set that still backs internal
 * lifecycle/transport bookkeeping (voice synthesis stages, dropped/timeout
 * transport markers) and the historical schema surface.
 *
 * Anything published to the dashboard must additionally satisfy
 * `RequiredTurnStatusSchema` — see `mapInternalStatusToContractStatus`.
 */
export const CstTurnStatusSchema = z.union([RequiredTurnStatusSchema, AllowedTurnStatusSchema]);
export type CstTurnStatus = z.infer<typeof CstTurnStatusSchema>;

export const CstTurnSchema = z.object({
  turn_id: z.string().min(1),
  conversation_id: z.string().optional(),
  direction: TurnDirectionSchema,
  channel: CstChannelSchema,
  status: CstTurnStatusSchema,
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
  /**
   * Explicit aliases for the Engine Dashboard's required field names. `text`
   * (inbound message) and `reply` (outbound answer) already exist above; these
   * spell the dashboard contract out so no consumer has to guess the mapping.
   */
  message: z.string().optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  event_type: z.literal('cst.turn').optional(),
  /** Source-side test traffic marker (cstTestReason classifier). */
  test: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  /** Source-side test traffic marker (cstTestReason classifier). */
  test: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  metadata: z.record(z.string(), z.unknown()).optional(),
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
