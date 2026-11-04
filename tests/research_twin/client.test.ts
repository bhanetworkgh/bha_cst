import { describe, expect, it, vi } from 'vitest';
import { ResearchTwinClient } from '../../engine/src/research_twin/client.js';
import { ResearchTwinHttpError, classifyResearchTwinError, parseRetryAfter } from '../../engine/src/research_twin/errors.js';
import { ResearchTwinTransportError } from '../../engine/src/research_twin/lifecycle.js';
import {
  InMemoryResearchTwinInvestigationStore,
  ProvisionalResearchTwinLifecycle,
} from '../../engine/src/research_twin/lifecycle.js';

describe('Research Twin HTTP Client & Error Handling', () => {
  const sampleRequest = {
    tenant_id: 'tenant-vfarm-01',
    project_id: 'proj-vfarm-main',
    correlation_id: 'corr_voice_001',
    source_system: 'bha-cst',
    originating_incident_id: 'inc_ph_01',
    occurred_at: '2026-11-03T12:00:00.000Z',
    event_type: 'investigation.sensor_threshold_breach',
    priority: 'p1',
    idempotency_key: 'idem_voice_001',
  };

  describe('Error Classification & Retry-After Parser', () => {
    it('parses numeric seconds from Retry-After', () => {
      expect(parseRetryAfter('30')).toBe(30000);
      expect(parseRetryAfter('0')).toBe(0);
      expect(parseRetryAfter(null)).toBeUndefined();
    });

    it('classifies 400 Bad Request as non-retryable invalid_payload', () => {
      const result = classifyResearchTwinError(400, {
        error: 'SCHEMA_VIOLATION',
        message: 'Invalid priority value',
      });
      expect(result.code).toBe('invalid_payload');
      expect(result.retryable).toBe(false);
      expect(result.message).toBe('Invalid priority value');
    });

    it('classifies 401 Unauthorized as non-retryable unauthorized', () => {
      const result = classifyResearchTwinError(401, { message: 'Bad API Key' });
      expect(result.code).toBe('unauthorized');
      expect(result.retryable).toBe(false);
    });

    it('classifies 403 Forbidden as non-retryable forbidden', () => {
      const result = classifyResearchTwinError(403, { message: 'Access denied' });
      expect(result.code).toBe('forbidden');
      expect(result.retryable).toBe(false);
    });

    it('classifies 404 Not Found as non-retryable endpoint_not_found', () => {
      const result = classifyResearchTwinError(404, 'Not Found');
      expect(result.code).toBe('endpoint_not_found');
      expect(result.retryable).toBe(false);
    });

    it('classifies 422 Unprocessable Entity as non-retryable unprocessable_entity', () => {
      const result = classifyResearchTwinError(422, { message: 'Tenant inactive' });
      expect(result.code).toBe('unprocessable_entity');
      expect(result.retryable).toBe(false);
    });

    it('classifies 429 Rate Limited as retryable and extracts retry-after', () => {
      const result = classifyResearchTwinError(
        429,
        { message: 'Rate limit exceeded' },
        { 'retry-after': '45' },
      );
      expect(result.code).toBe('rate_limited');
      expect(result.retryable).toBe(true);
      expect(result.retryAfterMs).toBe(45000);
    });

    it('classifies 500 Internal Error as retryable upstream_internal_error', () => {
      const result = classifyResearchTwinError(500, { message: 'Internal server failure' });
      expect(result.code).toBe('upstream_internal_error');
      expect(result.retryable).toBe(true);
    });

    it('classifies 502/503 Service Unavailable as retryable upstream_unavailable', () => {
      const res502 = classifyResearchTwinError(502, 'Bad Gateway');
      expect(res502.code).toBe('upstream_unavailable');
      expect(res502.retryable).toBe(true);

      const res503 = classifyResearchTwinError(503, 'Service Unavailable');
      expect(res503.code).toBe('upstream_unavailable');
      expect(res503.retryable).toBe(true);
    });

    it('classifies 504 Gateway Timeout as retryable upstream_timeout', () => {
      const result = classifyResearchTwinError(504, 'Gateway Timeout');
      expect(result.code).toBe('upstream_timeout');
      expect(result.retryable).toBe(true);
    });
  });

  describe('ResearchTwinClient Dispatch', () => {
    it('successfully dispatches investigation and sends required headers', async () => {
      const mockFetch = vi.fn(async (_url: string, options: any) => {
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/json');
        expect(options.headers['Authorization']).toBe('Bearer secret-api-key');
        expect(options.headers['X-Service-Key']).toBe('secret-api-key');
        expect(options.headers['X-Correlation-ID']).toBe('corr_voice_001');
        expect(options.headers['X-Tenant-ID']).toBe('tenant-vfarm-01');

        const body = JSON.parse(options.body);
        expect(body.originating_incident_id).toBe('inc_ph_01');
        expect(body.event_type).toBe('investigation.sensor_threshold_breach');

        return new Response(
          JSON.stringify({
            investigation_id: 'rt_inv_success_456',
            status: 'accepted',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new ResearchTwinClient({
        endpointUrl: 'https://research-twin.example.internal/api/v1/investigations',
        apiKey: 'secret-api-key',
        fetchFn: mockFetch as any,
      });

      const result = await client.createInvestigation(sampleRequest);
      expect(result.investigation_id).toBe('rt_inv_success_456');
    });

    it('throws non-retryable error if RT_ENDPOINT_URL is not configured', async () => {
      const client = new ResearchTwinClient({
        endpointUrl: '',
      });

      await expect(client.createInvestigation(sampleRequest)).rejects.toMatchObject({
        code: 'endpoint_not_configured',
        retryable: false,
      });
    });

    it('throws non-retryable error if outbound request schema fails validation', async () => {
      const client = new ResearchTwinClient({
        endpointUrl: 'https://rt.example.com',
      });

      const invalidReq = { ...sampleRequest, tenant_id: '' };
      await expect(client.createInvestigation(invalidReq)).rejects.toMatchObject({
        code: 'invalid_payload',
        retryable: false,
      });
    });

    it('throws ResearchTwinHttpError on 400 Bad Request with details', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: 'MALFORMED_INPUT',
            message: 'Invalid incident format',
            detail: 'originating_incident_id must match regex inc_*',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new ResearchTwinClient({
        endpointUrl: 'https://rt.example.com',
        apiKey: 'key',
        fetchFn: mockFetch as any,
      });

      await expect(client.createInvestigation(sampleRequest)).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ResearchTwinHttpError);
        expect(err).toBeInstanceOf(ResearchTwinTransportError);
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('invalid_payload');
        expect(err.retryable).toBe(false);
        expect(err.details).toBe('originating_incident_id must match regex inc_*');
        return true;
      });
    });

    it('throws retryable ResearchTwinHttpError on 503 Service Unavailable', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response('Backend n8n node starting up', {
          status: 503,
          headers: { 'retry-after': '10' },
        });
      });

      const client = new ResearchTwinClient({
        endpointUrl: 'https://rt.example.com',
        apiKey: 'key',
        fetchFn: mockFetch as any,
      });

      await expect(client.createInvestigation(sampleRequest)).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ResearchTwinHttpError);
        expect(err.statusCode).toBe(503);
        expect(err.code).toBe('upstream_unavailable');
        expect(err.retryable).toBe(true);
        expect(err.retryAfterMs).toBe(10000);
        return true;
      });
    });

    it('throws retryable error on network timeout', async () => {
      const mockFetch = vi.fn(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      });

      const client = new ResearchTwinClient({
        endpointUrl: 'https://rt.example.com',
        apiKey: 'key',
        timeoutMs: 50,
        fetchFn: mockFetch as any,
      });

      await expect(client.createInvestigation(sampleRequest)).rejects.toSatisfy((err: any) => {
        expect(err).toBeInstanceOf(ResearchTwinHttpError);
        expect(err.statusCode).toBe(504);
        expect(err.code).toBe('network_timeout');
        expect(err.retryable).toBe(true);
        return true;
      });
    });

    it('throws non-retryable invalid_creation_response if 200 OK lacks investigation_id', async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(JSON.stringify({ status: 'ok', data: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const client = new ResearchTwinClient({
        endpointUrl: 'https://rt.example.com',
        apiKey: 'key',
        fetchFn: mockFetch as any,
      });

      await expect(client.createInvestigation(sampleRequest)).rejects.toMatchObject({
        code: 'invalid_creation_response',
        retryable: false,
      });
    });
  });

  describe('Integration with ProvisionalResearchTwinLifecycle', () => {
    it('retries transient 503 error and succeeds on subsequent attempt', async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('Overloaded', { status: 503 });
        }
        return new Response(
          JSON.stringify({ investigation_id: 'rt-recovered-101' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const client = new ResearchTwinClient({
        endpointUrl: 'https://rt.example.com',
        apiKey: 'key',
        fetchFn: mockFetch as any,
      });

      const store = new InMemoryResearchTwinInvestigationStore();
      const lifecycle = new ProvisionalResearchTwinLifecycle({
        transport: client,
        store,
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 20,
        sleep: async () => {},
      });

      const result = await lifecycle.createInvestigation(sampleRequest);
      expect(result.record.creation_state).toBe('created');
      expect(result.record.research_twin_investigation_id).toBe('rt-recovered-101');
      expect(result.record.creation_attempts).toBe(2);
      expect(callCount).toBe(2);
    });

    it('stops retry immediately on non-retryable 401 Unauthorized', async () => {
      let callCount = 0;
      const mockFetch = vi.fn(async () => {
        callCount++;
        return new Response('Unauthorized', { status: 401 });
      });

      const client = new ResearchTwinClient({
        endpointUrl: 'https://rt.example.com',
        apiKey: 'bad-key',
        fetchFn: mockFetch as any,
      });

      const store = new InMemoryResearchTwinInvestigationStore();
      const lifecycle = new ProvisionalResearchTwinLifecycle({
        transport: client,
        store,
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 20,
        sleep: async () => {},
      });

      await expect(lifecycle.createInvestigation(sampleRequest)).rejects.toBeInstanceOf(
        ResearchTwinHttpError,
      );

      expect(callCount).toBe(1);
    });
  });
});

