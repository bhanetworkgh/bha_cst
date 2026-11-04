import { z } from 'zod';

/**
 * Valid turn channels for the CS Twin Brain.
 */
export const BrainTurnChannelSchema = z.enum(['web', 'voice', 'sms', 'whatsapp', 'email', 'api']);
export type BrainTurnChannel = z.infer<typeof BrainTurnChannelSchema>;

/**
 * Status outcomes for CS Twin brain responses.
 */
export const BrainTurnStatusSchema = z.enum(['ok', 'refused', 'step_up_required', 'error']);
export type BrainTurnStatus = z.infer<typeof BrainTurnStatusSchema>;

/**
 * Inbound Request Wire Schema for CS Twin Brain API.
 */
export const BrainTurnRequestSchema = z.object({
  text: z.string().trim().min(1, 'Input text cannot be empty').max(4000, 'Text exceeds maximum limit of 4000 characters'),
  channel: BrainTurnChannelSchema.optional().default('api'),
  project_id: z.string().optional(),
  speaker_ref: z.string().optional(),
  phone_e164: z.string().optional(),
  correlation_id: z.string().optional(),
  conversation_id: z.string().optional(),
  tenant_id: z.string().optional(), // If supplied, strictly validated against server-resolved tenancy
  farm_id: z.string().optional(),
  media: z.array(z.string()).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type BrainTurnRequest = z.infer<typeof BrainTurnRequestSchema>;

/**
 * Escalation outcome sub-schema.
 */
export const BrainEscalationResultSchema = z.object({
  requested: z.boolean(),
  reason: z.string().optional(),
  escalation_id: z.string().optional(),
  status: z.string().optional(),
});

export type BrainEscalationResult = z.infer<typeof BrainEscalationResultSchema>;

/**
 * Outbound Response Wire Schema for CS Twin Brain API.
 */
export const BrainTurnResponseSchema = z.object({
  turn_id: z.string().min(1),
  conversation_id: z.string().min(1),
  correlation_id: z.string().min(1),
  tenant_id: z.string().min(1),
  project_id: z.string().min(1),
  speaker_ref: z.string().min(1),
  channel: BrainTurnChannelSchema,
  role: z.string(),
  input_text: z.string(),
  reply_text: z.string(),
  status: BrainTurnStatusSchema,
  intent: z.string(),
  duration_ms: z.number().nonnegative(),
  escalation: BrainEscalationResultSchema.optional(),
  timestamp: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type BrainTurnResponse = z.infer<typeof BrainTurnResponseSchema>;
