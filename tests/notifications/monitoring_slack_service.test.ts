import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  MonitoringSlackService,
  sanitizeMrkdwn,
  sanitizeMeta,
  MonitoringAlertEvent,
  IncidentNotificationEvent,
  EscalationNotificationEvent,
  RecoveryNotificationEvent,
} from '../../engine/src/notifications/monitoring_slack_service.js';
import { notifyDeviceHealthStatus, notifySensorHealthStatus } from '../../engine/src/connectors/vfarm.js';

describe('CST Monitoring Slack App Integration (Deliverable & Evidence Gate)', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    MonitoringSlackService.reset();
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test-cst-monitoring-bot-token');
    vi.stubEnv('SLACK_MONITORING_CHANNEL_ID', 'C0_VFARM_MONITORING_TEST');
    vi.stubEnv('SLACK_CS_CHANNEL_ID', 'C0BD6D53HAM');
    vi.stubEnv('SLACK_ALERTS_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // 1. Successful Slack message delivery
  it('1. delivers monitoring alert successfully via chat.postMessage with valid bot token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channel: 'C0_VFARM_MONITORING_TEST', ts: '1795000001.000100' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const alert: MonitoringAlertEvent = {
      type: 'sensor_offline',
      severity: 'HIGH',
      system: 'vFarm',
      farm_id: 'farm-austin-1',
      device_id: 'device-rack-1',
      sensor_id: 'sensor-temp-01',
      reason: 'Sensor stopped reporting heartbeats',
      correlation_id: 'corr-mon-001',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-main',
    };

    const res = await MonitoringSlackService.sendMonitoringAlert(alert);
    expect(res.dispatched).toBe(true);
    expect(res.status).toBe('sent');
    expect(res.channel_id).toBe('C0_VFARM_MONITORING_TEST');
    expect(res.message_ts).toBe('1795000001.000100');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.headers['Authorization']).toBe('Bearer xoxb-test-cst-monitoring-bot-token');
    const body = JSON.parse(init.body);
    expect(body.channel).toBe('C0_VFARM_MONITORING_TEST');
    expect(body.text).toContain('Sensor Offline');
    expect(body.blocks[0].text.text).toContain('Sensor Offline');
  });

  // 2. Missing Slack token
  it('2. defers delivery safely with structured warning when SLACK_BOT_TOKEN is missing', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendMonitoringAlert({
      type: 'sensor_offline',
      severity: 'HIGH',
      system: 'vFarm',
      reason: 'Sensor timeout',
    });

    expect(res.dispatched).toBe(false);
    expect(res.status).toBe('deferred');
    expect(res.error).toContain('SLACK_BOT_TOKEN is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 3. Missing channel configuration
  it('3. defers delivery safely when SLACK_MONITORING_CHANNEL_ID is not configured', async () => {
    vi.stubEnv('SLACK_MONITORING_CHANNEL_ID', '');
    vi.stubEnv('SLACK_VFARM_MONITORING_CHANNEL_ID', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendMonitoringAlert({
      type: 'device_degraded',
      severity: 'HIGH',
      system: 'vFarm',
      farm_id: 'farm-1',
      device_id: 'dev-1',
      reason: 'Upstream sensor failure',
    });

    expect(res.dispatched).toBe(false);
    expect(res.status).toBe('deferred');
    expect(res.channel_name).toBe('#bha-vfarm-monitoring-twin');
    expect(res.error).toContain('SLACK_MONITORING_CHANNEL_ID is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 4. Slack API authentication failure
  it('4. handles Slack invalid_auth failure without crashing or retrying infinitely', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendMonitoringAlert({
      type: 'vfarm_api_failure',
      severity: 'CRITICAL',
      system: 'vFarm',
      reason: 'vFarm gateway returned 502 Bad Gateway',
    });

    expect(res.dispatched).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('chat.postMessage error: invalid_auth');
    // Non-retryable auth error should fail immediately on first attempt
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MonitoringSlackService.getFailedDeliveries()).toHaveLength(1);
  });

  // 5. Slack rate limiting (HTTP 429)
  it('5. handles Slack HTTP 429 rate limit with Retry-After backoff and records failure if limit persists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '1', 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendMonitoringAlert({
      type: 'sensor_stale',
      severity: 'WARN',
      system: 'vFarm',
      reason: 'Reading older than 24h',
    });

    expect(res.dispatched).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('rate limit');
    // Initial attempt + 2 retries = 3 attempts total
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // 6. Slack API 5xx response
  it('6. retries on Slack HTTP 500 server error and records failure if server remains down', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendIncidentNotification({
      title: 'Farm Water Controller Failure',
      severity: 'CRITICAL',
      system: 'vFarm',
      farm_id: 'farm-1',
      reason: 'Pump relay disconnected',
    });

    expect(res.dispatched).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('Slack server error (HTTP 500)');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // 7. Network timeout
  it('7. handles network abort/timeout gracefully with bounded retries', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendMonitoringAlert({
      type: 'vfarm_api_failure',
      severity: 'HIGH',
      system: 'vFarm',
      reason: 'Connection dropped',
    });

    expect(res.dispatched).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('Network timeout');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // 8. Retry behavior (transient failure followed by success)
  it('8. succeeds on retry when transient HTTP 503 is followed by HTTP 200 ok: true', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: 'C0_VFARM_MONITORING_TEST', ts: '1795000002.000200' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendMonitoringAlert({
      type: 'device_degraded',
      severity: 'HIGH',
      system: 'vFarm',
      farm_id: 'farm-austin-1',
      device_id: 'device-pump-01',
      reason: 'Sensors offline',
    });

    expect(res.dispatched).toBe(true);
    expect(res.status).toBe('sent');
    expect(res.retry_count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 9. Duplicate event suppression
  it('9. suppresses duplicate alerts for the same event within the 60-second window', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channel: 'C0_VFARM_MONITORING_TEST', ts: '1795000003.000300' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const alert: MonitoringAlertEvent = {
      type: 'sensor_stale',
      severity: 'WARN',
      system: 'vFarm',
      farm_id: 'farm-austin-1',
      sensor_id: 'temp-sensor-01',
      reason: 'Reading age exceeds 24h threshold',
    };

    const first = await MonitoringSlackService.sendMonitoringAlert(alert);
    expect(first.dispatched).toBe(true);
    expect(first.status).toBe('sent');

    const second = await MonitoringSlackService.sendMonitoringAlert(alert);
    expect(second.dispatched).toBe(false);
    expect(second.status).toBe('suppressed');
    expect(second.error).toContain('Duplicate monitoring alert suppressed');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 10. Correct channel routing
  it('10. routes monitoring to #bha-vfarm-monitoring-twin and escalations to #bha-customer-service-twin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channel: 'C0_DEFAULT', ts: '1795000004.000400' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Monitoring alert routes to monitoring channel
    await MonitoringSlackService.sendMonitoringAlert({
      type: 'sensor_offline',
      severity: 'HIGH',
      system: 'vFarm',
      reason: 'Sensor unplugged',
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).channel).toBe('C0_VFARM_MONITORING_TEST');

    // Customer escalation routes to CS channel (C0BD6D53HAM)
    await MonitoringSlackService.sendEscalationNotification({
      caller_phone: '+19715885823',
      reason: 'Customer wants a live person for leak issue',
      conversation_id: 'conv_123',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).channel).toBe('C0BD6D53HAM');
  });

  // 11. Tenant isolation
  it('11. preserves tenant_id and project_id boundaries in structured metadata fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channel: 'C0_VFARM_MONITORING_TEST', ts: '1795000005.000500' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await MonitoringSlackService.sendIncidentNotification({
      title: 'Tenant Scope Boundary Test',
      severity: 'CRITICAL',
      system: 'vFarm',
      tenant_id: 'tenant-acme-corp',
      project_id: 'proj-hydro-01',
      farm_id: 'farm-acme-main',
      reason: 'Nutrient flow failure',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const fields = body.blocks.find((b: any) => b.fields)?.fields || [];
    const tenantField = fields.find((f: any) => f.text.includes('Tenant'));
    expect(tenantField).toBeDefined();
    expect(tenantField.text).toContain('tenant-acme-corp');
  });

  // 12. Sensitive data redaction & mrkdwn sanitization
  it('12. redacts customer phone numbers, sanitizes mrkdwn injection, and removes secrets from metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, channel: 'C0BD6D53HAM', ts: '1795000006.000600' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await MonitoringSlackService.sendEscalationNotification({
      caller_phone: '+19715885823',
      reason: 'Check user <script>alert("hack")</script> & token',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Raw phone +19715885823 must NOT appear in the JSON payload
    expect(JSON.stringify(body)).not.toContain('+19715885823');
    // Masked phone +1971***5823 should appear
    expect(JSON.stringify(body)).toContain('5823');

    // Mrkdwn injection characters (<, >, &) must be escaped
    expect(JSON.stringify(body)).not.toContain('<script>');
    expect(JSON.stringify(body)).toContain('&lt;script&gt;');

    // Verify sanitizeMeta
    const metaWithSecrets = {
      user_id: 'usr_123',
      api_key: 'super-secret-key',
      auth_token: 'bearer-xyz',
      normal_metric: 42,
    };
    const cleaned = sanitizeMeta(metaWithSecrets);
    expect(cleaned?.user_id).toBe('usr_123');
    expect(cleaned?.api_key).toBe('[REDACTED]');
    expect(cleaned?.auth_token).toBe('[REDACTED]');
    expect(cleaned?.normal_metric).toBe(42);
  });

  // 13. Recovery notification behavior
  it('13. dispatches recovery notification referencing original incident only when incident was recorded', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, channel: 'C0_VFARM_MONITORING_TEST', ts: '1795000007.000700' }), {
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Case A: Unrecorded incident recovery must be suppressed
    const unrecordedRecovery = await MonitoringSlackService.sendRecoveryNotification({
      system: 'vFarm',
      farm_id: 'farm-ghost',
      device_id: 'device-ghost',
      previous_state: 'degraded',
      current_state: 'healthy',
      recovery_reason: 'Resolved without prior record',
    });
    expect(unrecordedRecovery.dispatched).toBe(false);
    expect(unrecordedRecovery.status).toBe('suppressed');
    expect(unrecordedRecovery.error).toContain('no prior incident recorded');
    expect(fetchMock).not.toHaveBeenCalled();

    // Case B: Record an initial degraded device incident
    const alertRes = await MonitoringSlackService.sendMonitoringAlert({
      type: 'device_degraded',
      severity: 'HIGH',
      system: 'vFarm',
      farm_id: 'farm-austin-1',
      device_id: 'device-pump-01',
      reason: 'All upstream sensors offline',
      correlation_id: 'inc_pump_degraded_99',
    });
    expect(alertRes.dispatched).toBe(true);

    // Case C: Recovery now succeeds and targets original incident channel
    const recordedRecovery = await MonitoringSlackService.sendRecoveryNotification({
      system: 'vFarm',
      farm_id: 'farm-austin-1',
      device_id: 'device-pump-01',
      previous_state: 'degraded',
      current_state: 'healthy',
      recovery_reason: 'Sensors came back online and telemetry verified',
      duration_ms: 45000,
    });

    expect(recordedRecovery.dispatched).toBe(true);
    expect(recordedRecovery.status).toBe('sent');
    const recoveryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(recoveryBody.text).toContain('[RECOVERED]');
    expect(recoveryBody.blocks[0].text.text).toContain('Incident Recovered');
    expect(JSON.stringify(recoveryBody)).toContain('inc_pump_degraded_99');
    expect(JSON.stringify(recoveryBody)).toContain('45s');
  });

  // 14. Notification failures not blocking customer-facing requests
  it('14. never throws or blocks when Slack throws fatal errors during monitoring triggers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      throw new Error('Kernel socket crash');
    }));

    // Calling connector helper methods must resolve safely without unhandled rejections
    await expect(
      notifyDeviceHealthStatus({
        farmId: 'farm-1',
        deviceId: 'dev-1',
        status: 'DEGRADED',
        sensorStates: ['offline'],
      }),
    ).resolves.not.toThrow();

    await expect(
      notifySensorHealthStatus({
        farmId: 'farm-1',
        sensorId: 'sensor-1',
        isStale: true,
        lastReadingAt: '2026-11-19T00:00:00Z',
      }),
    ).resolves.not.toThrow();

    await expect(
      MonitoringSlackService.sendMonitoringAlert({
        type: 'vfarm_api_failure',
        severity: 'CRITICAL',
        system: 'vFarm',
        reason: 'Fatal crash test',
      }),
    ).resolves.toMatchObject({ dispatched: false, status: 'failed' });
  });

  // Test failed delivery queue and retry
  it('15. tracks failed deliveries in queue and successfully retries them when connectivity restores', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('Connection refused 1'))
      .mockRejectedValueOnce(new Error('Connection refused 2'))
      .mockRejectedValueOnce(new Error('Connection refused 3'))
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true, channel: 'C0_VFARM_MONITORING_TEST', ts: '1795000008.000800' }), {
            status: 200,
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = await MonitoringSlackService.sendMonitoringAlert({
      type: 'vfarm_api_failure',
      severity: 'HIGH',
      system: 'vFarm',
      reason: 'Connection failure for retry test',
    });
    expect(first.dispatched).toBe(false);
    expect(first.status).toBe('failed');
    expect(MonitoringSlackService.getFailedDeliveries()).toHaveLength(1);

    // Connectivity restored: retrying queue succeeds
    const recovered = await MonitoringSlackService.retryFailedDeliveries();
    expect(recovered).toBe(1);
    expect(MonitoringSlackService.getFailedDeliveries()).toHaveLength(0);
  });

  // Test SLACK_ALERTS_ENABLED=false
  it('16. disables all dispatches when SLACK_ALERTS_ENABLED=false', async () => {
    vi.stubEnv('SLACK_ALERTS_ENABLED', 'false');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await MonitoringSlackService.sendMonitoringAlert({
      type: 'sensor_offline',
      severity: 'HIGH',
      system: 'vFarm',
      reason: 'Alerts disabled test',
    });

    expect(res.dispatched).toBe(false);
    expect(res.status).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Test default fallback channel C0B8JTE51PG
  it('17. falls back to default channel C0B8JTE51PG when SLACK_MONITORING_CHANNEL_ID is unset', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test-cst-monitoring-bot-token');
    vi.stubEnv('SLACK_ALERTS_ENABLED', 'true');
    delete process.env.SLACK_MONITORING_CHANNEL_ID;
    delete process.env.SLACK_VFARM_MONITORING_CHANNEL_ID;

    const resolved = MonitoringSlackService.resolveChannel('monitoring');
    expect(resolved.channelId).toBe('C0B8JTE51PG');
    expect(resolved.channelName).toBe('#bha-vfarm-monitoring-twin');
    expect(resolved.isConfigured).toBe(true);
  });
});
