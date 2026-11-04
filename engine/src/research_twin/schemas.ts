import { z } from 'zod';

/**
 * Canonical Research Twin Investigation Event Types.
 * Defined in docs/contracts/monitoring-research-twin-field-contract.md (v1.1.1, Section 7.1).
 */
export const RESEARCH_TWIN_EVENT_TYPES = [
  'investigation.sensor_telemetry_missing',
  'investigation.sensor_telemetry_stale',
  'investigation.sensor_threshold_breach',
  'investigation.farm_health_anomaly',
  'investigation.device_connectivity_loss',
  'investigation.self_healing_exhaustion',
] as const;

export type ResearchTwinStandardEventType = (typeof RESEARCH_TWIN_EVENT_TYPES)[number];

export const ResearchTwinEventTypeSchema = z.string().min(1);

/**
 * Standard priority levels for investigations.
 */
export const RESEARCH_TWIN_PRIORITIES = [
  'critical',
  'high',
  'medium',
  'low',
  'p1',
  'p2',
  'p3',
] as const;

export type ResearchTwinPriority = (typeof RESEARCH_TWIN_PRIORITIES)[number];

export const ResearchTwinPrioritySchema = z.string().nullable().optional();

/**
 * 1. Outbound Wire Payload Schema (Sent UP from CST to Research Twin RT_ENDPOINT_URL).
 *
 * Aligned with ResearchTwinInvestigationRequest and Monitoring Twin contract v1.1.1.
 */
export const ResearchTwinOutboundPayloadSchema = z
  .object({
    tenant_id: z.string().min(1, 'tenant_id is required'),
    project_id: z.string().min(1, 'project_id is required'),
    correlation_id: z.string().min(1, 'correlation_id is required'),
    source_system: z.string().min(1).default('bha-cst'),
    originating_incident_id: z.string().min(1, 'originating_incident_id is required'),
    occurred_at: z
      .string()
      .min(1, 'occurred_at is required')
      .refine((val) => Number.isFinite(Date.parse(val)), {
        message: 'occurred_at must be a valid ISO 8601 timestamp',
      }),
    event_type: ResearchTwinEventTypeSchema,
    priority: ResearchTwinPrioritySchema.default(null),
    idempotency_key: z.string().min(1, 'idempotency_key is required'),

    // Context & Telemetry metadata (optional/nullable for forwards-compatibility)
    farm_id: z.string().uuid().nullable().optional(),
    sensor_id: z.string().nullable().optional(),
    reading_ts: z.string().nullable().optional(),
    telemetry_value: z.union([z.number(), z.record(z.string(), z.unknown()), z.string()]).nullable().optional(),
    threshold: z.record(z.string(), z.unknown()).nullable().optional(),
    fleet_summary: z.record(z.string(), z.unknown()).nullable().optional(),
    summary: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    details: z.record(z.string(), z.unknown()).nullable().optional(),
    raw_payload: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export type ResearchTwinOutboundPayload = z.infer<typeof ResearchTwinOutboundPayloadSchema>;

/**
 * 2. Success Response Schema (Returned from Research Twin when dispatch succeeds).
 *
 * Handles both investigation_id and research_twin_investigation_id aliases.
 */
export const ResearchTwinSuccessResponseSchema = z
  .object({
    investigation_id: z.string().optional(),
    research_twin_investigation_id: z.string().optional(),
    status: z.string().optional().default('accepted'),
    accepted_at: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough()
  .refine(
    (data) => Boolean((data.investigation_id || data.research_twin_investigation_id)?.trim()),
    {
      message: 'Response must contain either investigation_id or research_twin_investigation_id',
    },
  )
  .transform((data) => ({
    ...data,
    investigation_id: (data.investigation_id || data.research_twin_investigation_id)!.trim(),
    research_twin_investigation_id: (data.research_twin_investigation_id || data.investigation_id)!.trim(),
  }));

export type ResearchTwinSuccessResponse = z.infer<typeof ResearchTwinSuccessResponseSchema>;

/**
 * 3. Structured Error Response Schema (Returned from Research Twin on failure).
 *
 * Handles errors from custom REST APIs, n8n workflows, Express proxies, or cloud gateways.
 */
export const ResearchTwinErrorResponseSchema = z
  .object({
    error: z.string().optional(),
    errorCode: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    message: z.string().optional(),
    errorMessage: z.string().optional(),
    detail: z.string().optional(),
    details: z.unknown().optional(),
    retryable: z.boolean().optional(),
    retry_after_seconds: z.number().optional(),
  })
  .passthrough();

export type ResearchTwinErrorResponse = z.infer<typeof ResearchTwinErrorResponseSchema>;

/**
 * 4. Inbound Signed Callback Payload Schema (POST /webhooks/research-twin/callback).
 *
 * Validates updates received from Research Twin external investigations.
 */
export const ResearchTwinInboundCallbackSchema = z
  .object({
    tenant_id: z.string().min(1).optional(),
    project_id: z.string().min(1).optional(),
    investigation_id: z.string().min(1).optional(),
    research_twin_investigation_id: z.string().min(1).optional(),
    external_event_id: z.string().min(1).optional(),
    event_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    event_type: z.string().optional().default('external_update'),
    assignment: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    lifecycle_status: z.string().nullable().optional(),
    observed_at: z.string().optional(),
    timestamp: z.string().optional(),
    occurred_at: z.string().optional(),
    notes: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .transform((data) => {
    const investigationId = (
      data.research_twin_investigation_id ||
      data.investigation_id ||
      data.id ||
      'unknown'
    ).trim();

    const externalEventId = (
      data.external_event_id ||
      data.event_id ||
      `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    ).trim();

    const lifecycleStatus = data.lifecycle_status ?? data.status ?? null;
    const observedAt = data.observed_at || data.timestamp || data.occurred_at || new Date().toISOString();

    return {
      ...data,
      investigation_id: investigationId,
      research_twin_investigation_id: investigationId,
      external_event_id: externalEventId,
      lifecycle_status: lifecycleStatus,
      observed_at: observedAt,
    };
  });

export type ResearchTwinInboundCallback = z.infer<typeof ResearchTwinInboundCallbackSchema>;
