import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CstDashboardPublisher,
  PublishResult,
} from '../../engine/src/publishers/dashboard.js';
import {
  createCstTurnEventV1,
  createCstDeliveryEventV1,
  CustomerPayload,
} from '../../engine/src/contracts/index.js';
import { Logger } from '../../engine/src/config/logger.js';

describe('Task 2 — Dashboard Publisher (CstDashboardPublisher)', () => {
  const sampleCustomer: CustomerPayload = {
    customer_ref: 'cust_vfarm_001_john_doe',
    phone_e164: '+15551234567',
    role: 'owner',
    is_known: true,
    tenant_id: 'tenant_vfarm',
    project_id: 'proj_vfarm_primary',
  };

  const sampleTurnEvent = createCstTurnEventV1({
    id: 'evt_test_turn_101',
    tenant_id: 'tenant_vfarm',
    project_id: 'proj_vfarm_primary',
    correlation_id: 'corr_test_turn_101',
    channel: 'voice',
    customer: sampleCustomer,
    turn: {
      turn_id: 'turn_101',
      direction: 'inbound',
      channel: 'voice',
      status: 'synthesized',
      intent: 'status',
      text: 'What is the pump pressure?',
      reply_text: 'Pump pressure is 45 PSI.',
      duration: { total_ms: 1200 },
    },
  });

  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    CstDashboardPublisher.resetConfigLogging();
    delete process.env.ENGINE_DASHBOARD_URL;
    delete process.env.ENGINE_DASHBOARD_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('Configuration & Boot Logging', () => {
    it('logs missing configuration warning only once at boot', () => {
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

      // First check when unconfigured
      const configured1 = CstDashboardPublisher.checkBootConfig();
      expect(configured1).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('Missing configuration: ENGINE_DASHBOARD_URL, ENGINE_DASHBOARD_KEY');

      // Subsequent checks should be suppressed (no duplicate warning)
      const configured2 = CstDashboardPublisher.checkBootConfig();
      expect(configured2).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('returns true and does not warn when fully configured', () => {
      process.env.ENGINE_DASHBOARD_URL = 'https://dashboard.example.com/api/v1/events';
      process.env.ENGINE_DASHBOARD_KEY = 'secret-dashboard-key';
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

      const configured = CstDashboardPublisher.checkBootConfig();
      expect(configured).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('gracefully fails publish with MISSING_CONFIGURATION when unconfigured', async () => {
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const publisher = new CstDashboardPublisher();

      const result = await publisher.publish(sampleTurnEvent);
      expect(result.success).toBe(false);
      expect(result.error).toBe('MISSING_CONFIGURATION');
      expect(result.attempts).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Independent Event Delivery', () => {
    it('sends a valid cst.event.v1 with correct headers and payload', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any = null;

      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        capturedUrl = url;
        capturedHeaders = init.headers;
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      });

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'dash-key-12345',
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleTurnEvent);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(result.attempts).toBe(1);
      expect(result.eventId).toBe('evt_test_turn_101');

      expect(capturedUrl).toBe('https://dashboard.internal/api/v1/events');
      expect(capturedHeaders['Authorization']).toBe('Bearer dash-key-12345');
      expect(capturedHeaders['x-dashboard-key']).toBe('dash-key-12345');
      expect(capturedHeaders['x-cst-specversion']).toBe('cst.event.v1');
      expect(capturedBody.specversion).toBe('cst.event.v1');
      expect(capturedBody.event_type).toBe('cst.turn');
      expect(capturedBody.turn_id).toBe('turn_101');
    });

    it('sends a cst.delivery event independently', async () => {
      const sampleDeliveryEvent = createCstDeliveryEventV1({
        id: 'evt_test_del_202',
        tenant_id: 'tenant_vfarm',
        project_id: 'proj_vfarm_primary',
        correlation_id: 'corr_test_del_202',
        channel: 'sms',
        customer: sampleCustomer,
        delivery: {
          delivery_id: 'del_202',
          provider_sid: 'SM12345678',
          channel: 'sms',
          to: '+15551234567',
          status: 'delivered',
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ received: true }), { status: 201 })
      );

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'dash-key-12345',
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleDeliveryEvent);
      expect(result.success).toBe(true);
      expect(result.status).toBe(201);
      expect(result.eventId).toBe('evt_test_del_202');
    });
  });

  describe('Timeout Handling (5-second default)', () => {
    it('aborts and retries when timeout is exceeded', async () => {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});

      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async (_url, init) => {
        callCount++;
        // Simulate abort on timeout
        if (callCount < 3) {
          const error: any = new Error('The operation was aborted');
          error.name = 'AbortError';
          throw error;
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      });

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'key',
        timeoutMs: 50,
        initialRetryDelayMs: 5,
        maxRetries: 3,
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleTurnEvent);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
    });
  });

  describe('Fire-and-Forget & Never Block Customer Flow', () => {
    it('publishFireAndForget returns void immediately and handles errors asynchronously', async () => {
      const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

      const mockFetch = vi.fn().mockRejectedValue(new Error('Network offline'));

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'key',
        maxRetries: 1,
        fetchFn: mockFetch as any,
      });

      // Does not throw and returns void
      expect(() => publisher.publishFireAndForget(sampleTurnEvent)).not.toThrow();

      // Wait a tick for setImmediate
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('publish with { fireAndForget: true } returns immediately with success', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'key',
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleTurnEvent, { fireAndForget: true });
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(0);
    });

    it('never throws even when all network attempts fail permanently', async () => {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});

      const mockFetch = vi.fn().mockRejectedValue(new Error('Fatal connection reset'));

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'key',
        maxRetries: 2,
        initialRetryDelayMs: 5,
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleTurnEvent);
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.error).toBe('Fatal connection reset');
    });
  });

  describe('Retry Policy: Network / 408 / 429 / 5xx', () => {
    it('retries on HTTP 408 Request Timeout and succeeds on retry', async () => {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return new Response('Request Timeout', { status: 408 });
        }
        return new Response('OK', { status: 200 });
      });

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'key',
        maxRetries: 3,
        initialRetryDelayMs: 5,
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleTurnEvent);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(calls).toBe(2);
    });

    it('retries on HTTP 429 Rate Limit and succeeds on retry', async () => {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return new Response('Too Many Requests', { status: 429 });
        }
        return new Response('OK', { status: 200 });
      });

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'key',
        maxRetries: 3,
        initialRetryDelayMs: 5,
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleTurnEvent);
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(calls).toBe(2);
    });

    it('retries on HTTP 500, 502, 503, 504 and exhausts retries', async () => {
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 503 })
      );

      const publisher = new CstDashboardPublisher({
        dashboardUrl: 'https://dashboard.internal/api/v1/events',
        dashboardKey: 'key',
        maxRetries: 3,
        initialRetryDelayMs: 5,
        fetchFn: mockFetch as any,
      });

      const result = await publisher.publish(sampleTurnEvent);
      expect(result.success).toBe(false);
      expect(result.status).toBe(503);
      expect(result.attempts).toBe(3);
      expect(result.error).toBe('HTTP_503');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('Non-Retryable 4xx Policy', () => {
    it.each([400, 401, 403, 404, 422])(
      'does NOT retry on HTTP %i and stops immediately after 1 attempt',
      async (status) => {
        vi.spyOn(Logger, 'warn').mockImplementation(() => {});

        const mockFetch = vi.fn().mockResolvedValue(
          new Response(`Client Error ${status}`, { status })
        );

        const publisher = new CstDashboardPublisher({
          dashboardUrl: 'https://dashboard.internal/api/v1/events',
          dashboardKey: 'key',
          maxRetries: 3,
          initialRetryDelayMs: 5,
          fetchFn: mockFetch as any,
        });

        const result = await publisher.publish(sampleTurnEvent);

        expect(result.success).toBe(false);
        expect(result.status).toBe(status);
        expect(result.attempts).toBe(1); // Crucial: exactly 1 attempt, no retry!
        expect(result.error).toBe(`HTTP_${status}`);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }
    );
  });
});
