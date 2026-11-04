import { describe, expect, it } from 'vitest';
import {
  ResearchTwinOutboundPayloadSchema,
  ResearchTwinSuccessResponseSchema,
  ResearchTwinErrorResponseSchema,
  ResearchTwinInboundCallbackSchema,
} from '../../engine/src/research_twin/schemas.js';

describe('Research Twin Schemas', () => {
  describe('ResearchTwinOutboundPayloadSchema (Outbound to RT_ENDPOINT_URL)', () => {
    const validPayload = {
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      correlation_id: 'corr_test_12345',
      source_system: 'bha-cst',
      originating_incident_id: 'inc_stale_soil_01',
      occurred_at: '2026-11-03T12:00:00.000Z',
      event_type: 'investigation.sensor_telemetry_stale',
      priority: 'high',
      idempotency_key: 'idem_key_9999',
    };

    it('validates a minimal compliant outbound payload', () => {
      const parsed = ResearchTwinOutboundPayloadSchema.parse(validPayload);
      expect(parsed.tenant_id).toBe('tenant-vfarm-01');
      expect(parsed.event_type).toBe('investigation.sensor_telemetry_stale');
      expect(parsed.priority).toBe('high');
      expect(parsed.source_system).toBe('bha-cst');
    });

    it('defaults source_system to bha-cst and priority to null if omitted', () => {
      const { source_system, priority, ...rest } = validPayload;
      const parsed = ResearchTwinOutboundPayloadSchema.parse(rest);
      expect(parsed.source_system).toBe('bha-cst');
      expect(parsed.priority).toBeNull();
    });

    it('accepts contextual telemetry fields for rich investigation cards', () => {
      const enrichedPayload = {
        ...validPayload,
        farm_id: '21dde23e-f7f6-46bc-9b54-e97fabaaafd7',
        sensor_id: 'rack1_soil',
        reading_ts: '2026-11-03T11:40:00.000Z',
        telemetry_value: 12.5,
        threshold: { min: 20.0, max: 80.0 },
        summary: 'Soil moisture dropped below threshold',
        description: 'Sensor rack1_soil reported 12.5% vs threshold 20.0%',
        details: { rack: 1, shelf: 'top', crop: 'lettuce' },
      };
      const parsed = ResearchTwinOutboundPayloadSchema.parse(enrichedPayload);
      expect(parsed.farm_id).toBe('21dde23e-f7f6-46bc-9b54-e97fabaaafd7');
      expect(parsed.sensor_id).toBe('rack1_soil');
      expect(parsed.telemetry_value).toBe(12.5);
      expect(parsed.summary).toBe('Soil moisture dropped below threshold');
    });

    it('rejects payload if required tenant_id or correlation_id is missing', () => {
      const invalid = { ...validPayload, tenant_id: '' };
      expect(() => ResearchTwinOutboundPayloadSchema.parse(invalid)).toThrow();
    });

    it('rejects payload if occurred_at is not a valid ISO date', () => {
      const invalid = { ...validPayload, occurred_at: 'not-a-date' };
      expect(() => ResearchTwinOutboundPayloadSchema.parse(invalid)).toThrow();
    });

    it('passes through unknown extension fields without stripping them', () => {
      const custom = {
        ...validPayload,
        custom_n8n_flow_id: 'flow_9876',
        diagnostics: { packet_loss_pct: 0.15 },
      };
      const parsed = ResearchTwinOutboundPayloadSchema.parse(custom) as any;
      expect(parsed.custom_n8n_flow_id).toBe('flow_9876');
      expect(parsed.diagnostics.packet_loss_pct).toBe(0.15);
    });
  });

  describe('ResearchTwinSuccessResponseSchema (Response from RT_ENDPOINT_URL)', () => {
    it('accepts investigation_id and normalizes', () => {
      const response = {
        investigation_id: 'rt-inv-001',
        status: 'accepted',
        accepted_at: '2026-11-03T12:00:05.000Z',
      };
      const parsed = ResearchTwinSuccessResponseSchema.parse(response);
      expect(parsed.investigation_id).toBe('rt-inv-001');
      expect(parsed.research_twin_investigation_id).toBe('rt-inv-001');
      expect(parsed.status).toBe('accepted');
    });

    it('accepts research_twin_investigation_id alias and normalizes to investigation_id', () => {
      const response = {
        research_twin_investigation_id: 'rt-inv-002',
      };
      const parsed = ResearchTwinSuccessResponseSchema.parse(response);
      expect(parsed.investigation_id).toBe('rt-inv-002');
      expect(parsed.research_twin_investigation_id).toBe('rt-inv-002');
      expect(parsed.status).toBe('accepted');
    });

    it('rejects if neither investigation_id nor research_twin_investigation_id is provided', () => {
      const invalid = {
        status: 'accepted',
        message: 'all good',
      };
      expect(() => ResearchTwinSuccessResponseSchema.parse(invalid)).toThrow();
    });
  });

  describe('ResearchTwinErrorResponseSchema (Errors from Research Twin)', () => {
    it('parses standard REST error body', () => {
      const errorBody = {
        error: 'INVALID_PAYLOAD',
        code: 400,
        message: 'Missing required field: correlation_id',
        detail: 'Field validation error at root.correlation_id',
        retryable: false,
      };
      const parsed = ResearchTwinErrorResponseSchema.parse(errorBody);
      expect(parsed.error).toBe('INVALID_PAYLOAD');
      expect(parsed.message).toBe('Missing required field: correlation_id');
      expect(parsed.retryable).toBe(false);
    });

    it('parses n8n webhook error response format', () => {
      const n8nError = {
        errorMessage: 'Workflow execution failed: Timeout after 30s',
        code: 'WORKFLOW_TIMEOUT',
        retry_after_seconds: 60,
      };
      const parsed = ResearchTwinErrorResponseSchema.parse(n8nError);
      expect(parsed.errorMessage).toBe('Workflow execution failed: Timeout after 30s');
      expect(parsed.retry_after_seconds).toBe(60);
    });
  });

  describe('ResearchTwinInboundCallbackSchema (Inbound signed callback)', () => {
    it('normalizes inbound callback payload', () => {
      const raw = {
        investigation_id: 'rt-inv-99',
        status: 'in_investigation',
        timestamp: '2026-11-03T12:05:00.000Z',
        assignment: 'lead-agronomist',
      };
      const parsed = ResearchTwinInboundCallbackSchema.parse(raw);
      expect(parsed.investigation_id).toBe('rt-inv-99');
      expect(parsed.research_twin_investigation_id).toBe('rt-inv-99');
      expect(parsed.lifecycle_status).toBe('in_investigation');
      expect(parsed.assignment).toBe('lead-agronomist');
      expect(parsed.observed_at).toBe('2026-11-03T12:05:00.000Z');
      expect(parsed.external_event_id).toBeDefined();
    });
  });
});

