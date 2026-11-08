import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ErrorRouter, RawErrorEvent } from '../../engine/src/notifications/error_router.js';

describe('Error Routing by Class & Destination Isolation (Deliverable E)', () => {
  beforeEach(() => {
    ErrorRouter.reset();
  });

  it('1. Routes Twilio transport error to #bha-pipeline-errors', () => {
    const event: RawErrorEvent = {
      service: 'TWILIO',
      source: 'twilio_voice_webhook',
      message: 'Twilio webhook signature verification failed',
      severity: 'ERROR',
      route: '/webhooks/twilio/voice/turn',
      correlation_id: 'CA1234567890',
    };

    const classified = ErrorRouter.classify(event);
    expect(classified.error_class).toBe('Twilio');
    expect(classified.destination_channel).toBe('#bha-pipeline-errors');
    expect(classified.canonical_owner).toContain('Twilio');
  });

  it('2. Routes vFarm sensor & 422 error to Monitoring Twin (#vfarm-monitoring)', () => {
    const event: RawErrorEvent = {
      service: 'VFARM',
      source: 'vfarm_telemetry_adapter',
      category: 'sensor_timeout',
      message: 'vFarm sensor rack1_mq7 request timed out after 5000ms',
      severity: 'WARN',
      route: '/api/v1/readings',
      correlation_id: 'corr_vfarm_timeout_01',
    };

    const classified = ErrorRouter.classify(event);
    expect(classified.error_class).toBe('vFarm');
    expect(classified.destination_channel).toBe('#vfarm-monitoring');
    expect(classified.canonical_owner).toContain('Monitoring Twin');
  });

  it('3. Routes CST application error to CST operations (#bha-pipeline-errors)', () => {
    const event: RawErrorEvent = {
      service: 'CUSTOMER_TWIN',
      source: 'core_engine',
      message: 'Database query execution error in conversations store',
      severity: 'ERROR',
      correlation_id: 'corr_cst_app_01',
    };

    const classified = ErrorRouter.classify(event);
    expect(classified.error_class).toBe('CST');
    expect(classified.destination_channel).toBe('#bha-pipeline-errors');
    expect(classified.canonical_owner).toContain('CST Application');
  });

  it('4. Routes North Star error to North Star channel (#northstar-alerts)', () => {
    const event: RawErrorEvent = {
      service: 'NORTH_STAR',
      source: 'north_star_twin',
      message: 'North star fleet metric calculation divergence',
      severity: 'CRITICAL',
      correlation_id: 'corr_ns_fleet_01',
    };

    const classified = ErrorRouter.classify(event);
    expect(classified.error_class).toBe('NS');
    expect(classified.destination_channel).toBe('#northstar-alerts');
    expect(classified.canonical_owner).toContain('North Star');
  });

  it('5. Routes customer handoff / escalation to #bha-customer-service-twin', () => {
    const event: RawErrorEvent = {
      category: 'escalation',
      source: 'cst_escalation_service',
      message: 'Customer requested human assistance for water leak',
      severity: 'WARN',
      correlation_id: 'corr_escl_handoff_01',
    };

    const classified = ErrorRouter.classify(event);
    expect(classified.error_class).toBe('CS_HANDOFF');
    expect(classified.destination_channel).toBe('#bha-customer-service-twin');
  });

  it('6. Explicitly prevents critical engine alerts from routing to #bha-customer-service-twin', async () => {
    const criticalEngineAlert: RawErrorEvent = {
      category: 'escalation',
      message: 'Fatal memory exhaustion in engine pipeline',
      severity: 'CRITICAL',
    };

    const result = await ErrorRouter.route(criticalEngineAlert);
    expect(result.dispatched).toBe(false);
    expect(result.status).toBe('suppressed');
    expect(result.error).toContain('CRITICAL engine alerts cannot be routed');
  });

  it('7. Enforces that exactly one destination is selected per error event', async () => {
    const mockDispatcher = vi.fn().mockResolvedValue(true);
    ErrorRouter.setMockHandler(mockDispatcher);

    const event: RawErrorEvent = {
      service: 'TWILIO',
      message: 'Call teardown failed',
    };

    const res = await ErrorRouter.route(event);
    expect(res.dispatched).toBe(true);
    expect(mockDispatcher).toHaveBeenCalledTimes(1);
    expect(mockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ destination_channel: '#bha-pipeline-errors' }),
      expect.anything()
    );
  });

  it('8. Enforces deduplication for rapid repeated error bursts', async () => {
    const mockDispatcher = vi.fn().mockResolvedValue(true);
    ErrorRouter.setMockHandler(mockDispatcher);

    const event: RawErrorEvent = {
      service: 'VFARM',
      message: 'vFarm gateway 504 Gateway Timeout',
    };

    const res1 = await ErrorRouter.route(event);
    const res2 = await ErrorRouter.route(event);

    expect(res1.dispatched).toBe(true);
    expect(res2.dispatched).toBe(false);
    expect(res2.suppressed_as_duplicate).toBe(true);
    expect(mockDispatcher).toHaveBeenCalledTimes(1);
  });

  it('9. Retries failed Slack deliveries without losing error context', async () => {
    let failFirst = true;
    const mockDispatcher = vi.fn(async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('Slack connection refused');
      }
      return true;
    });
    ErrorRouter.setMockHandler(mockDispatcher);

    const event: RawErrorEvent = {
      service: 'CST',
      message: 'Unexpected null pointer in message router',
    };

    const res1 = await ErrorRouter.route(event);
    expect(res1.status).toBe('failed');
    expect(ErrorRouter.getFailedDeliveries().length).toBe(1);

    // Now retry
    const retriedCount = await ErrorRouter.retryFailedDeliveries();
    expect(retriedCount).toBe(1);
    expect(ErrorRouter.getFailedDeliveries().length).toBe(0);
  });
});


describe('CS Twin posts its own Twilio and CST errors (8 Nov 2026)', () => {
  beforeEach(() => ErrorRouter.reset());
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('posts a Block Kit card to #bha-pipeline-errors with the bot token and reads ok', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_CUSTOMER_SERVICE_WEBHOOK_URL', 'https://hooks.slack.invalid/cs');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, ts: '1.1' })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await ErrorRouter.route({ service: 'CST', message: 'Call log did not post', correlation_id: 'conv_1' });
    expect(res).toMatchObject({ dispatched: true, status: 'sent', destination_channel: '#bha-pipeline-errors' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    const body = JSON.parse(init.body);
    expect(body.channel).toBe('C0ATC4CA3G9');
    expect(body.blocks[0].type).toBe('header');
    expect(JSON.stringify(body.blocks)).toContain('Call log did not post');
  });

  it('reports ok:false as a failed delivery and never falls back to the customer service webhook', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_CUSTOMER_SERVICE_WEBHOOK_URL', 'https://hooks.slack.invalid/cs');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'not_in_channel' })));
    vi.stubGlobal('fetch', fetchMock);
    const res = await ErrorRouter.route({ service: 'TWILIO', message: 'Signature check failed' });
    expect(res).toMatchObject({ dispatched: false, status: 'failed' });
    expect(res.error).toContain('not_in_channel');
    expect(fetchMock.mock.calls.every(([u]) => u !== 'https://hooks.slack.invalid/cs')).toBe(true);
    expect(ErrorRouter.getFailedDeliveries().length).toBe(1);
  });

  it('without a bot token, a CST error with no ops webhook is deferred, not sent to the customer service channel', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('SLACK_CUSTOMER_SERVICE_WEBHOOK_URL', 'https://hooks.slack.invalid/cs');
    vi.stubEnv('SLACK_CST_OPS_WEBHOOK_URL', '');
    vi.stubEnv('SLACK_PIPELINE_ERRORS_WEBHOOK_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await ErrorRouter.route({ service: 'CST', message: 'Something broke' });
    expect(res.status).toBe('deferred');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
