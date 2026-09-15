import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlackNotifier, SlackAlertPayload } from '../../engine/src/notifications/slack.js';
import { Logger } from '../../engine/src/config/logger.js';

describe('SlackNotifier — Error Alert Notifications', () => {
  beforeEach(() => {
    SlackNotifier.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    SlackNotifier.reset();
  });

  it('formats and dispatches structured Slack error alerts with mock handler', async () => {
    let capturedPayload: SlackAlertPayload | null = null;
    let capturedBody: any = null;

    SlackNotifier.setMockHandler((payload, rawBody) => {
      capturedPayload = payload;
      capturedBody = rawBody;
    });

    const sent = await SlackNotifier.sendErrorAlert({
      title: 'Database Pool Exhaustion',
      message: 'Too many open clients in pool',
      severity: 'CRITICAL',
      tenant_id: 'tenant-vfarm-01',
      correlation_id: 'corr_db_exhaust_001',
      error: new Error('connection timeout after 30000ms'),
      meta: { activeClients: 10, maxClients: 10 },
    });

    expect(sent).toBe(true);
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload!.title).toBe('Database Pool Exhaustion');
    expect(capturedPayload!.severity).toBe('CRITICAL');
    expect(capturedPayload!.tenant_id).toBe('tenant-vfarm-01');

    // Verify Slack payload structure
    expect(capturedBody).toBeDefined();
    expect(capturedBody.text).toContain('[CRITICAL] Database Pool Exhaustion');
    expect(capturedBody.attachments).toHaveLength(1);

    const attachment = capturedBody.attachments[0];
    expect(attachment.color).toBe('#E01E5A'); // Red for CRITICAL
    expect(attachment.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Severity', value: ':rotating_light: CRITICAL' }),
        expect.objectContaining({ title: 'Service', value: 'CUSTOMER_TWIN' }),
        expect.objectContaining({ title: 'Tenant ID', value: 'tenant-vfarm-01' }),
        expect.objectContaining({ title: 'Correlation ID', value: 'corr_db_exhaust_001' }),
      ])
    );
    expect(attachment.text).toContain('connection timeout after 30000ms');
  });

  it('deduplicates identical error alerts within the deduplication window', async () => {
    let callCount = 0;
    SlackNotifier.setMockHandler(() => {
      callCount++;
    });

    const alert: SlackAlertPayload = {
      title: 'Twilio Gateway Timeout',
      message: 'Twilio API returned 504 Gateway Timeout',
      severity: 'ERROR',
      tenant_id: 'tenant-vfarm-01',
    };

    // First call sends
    const first = await SlackNotifier.sendErrorAlert(alert);
    expect(first).toBe(true);
    expect(callCount).toBe(1);

    // Second immediate call with identical content is throttled
    const second = await SlackNotifier.sendErrorAlert(alert);
    expect(second).toBe(false);
    expect(callCount).toBe(1);

    // Different error alert passes through
    const different = await SlackNotifier.sendErrorAlert({
      ...alert,
      title: 'Different Alert Title',
    });
    expect(different).toBe(true);
    expect(callCount).toBe(2);
  });

  it('triggers Slack alert automatically via Logger.error()', async () => {
    let capturedTitle = '';
    let capturedMessage = '';

    SlackNotifier.setMockHandler((payload) => {
      capturedTitle = payload.title;
      capturedMessage = payload.message;
    });

    Logger.error('Unhandled database disconnection', { tenant_id: 'tenant-test' });

    // Allow microtask resolution
    await new Promise((r) => setTimeout(r, 10));

    expect(capturedTitle).toBe('System Error');
    expect(capturedMessage).toBe('Unhandled database disconnection');
  });

  it('triggers critical Slack alert via Logger.infra() on permanent failure', async () => {
    let capturedSeverity: string | undefined;
    let capturedMessage = '';

    SlackNotifier.setMockHandler((payload) => {
      capturedSeverity = payload.severity;
      capturedMessage = payload.message;
    });

    Logger.infra({
      message: 'Permanent Twilio delivery failure: invalid destination number',
      commercial_impact: 'Outbound customer message permanently undeliverable.',
      meta: { tenant_id: 'tenant-vfarm-01' },
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(capturedSeverity).toBe('CRITICAL');
    expect(capturedMessage).toContain('Permanent Twilio delivery failure');
  });

  it('triggers Slack alert on security audit errors', async () => {
    let capturedSeverity: string | undefined;
    let capturedTitle = '';

    SlackNotifier.setMockHandler((payload) => {
      capturedSeverity = payload.severity;
      capturedTitle = payload.title;
    });

    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: 'tenant-vfarm-01',
      actor: 'system',
      role: 'worker',
      entry_point: 'api',
      tool_or_route: 'outboundQueue',
      outcome: 'error',
      reason: 'Cross-tenant message send attempt rejected',
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(capturedSeverity).toBe('ERROR');
    expect(capturedTitle).toContain('Security Ledger Error: outboundQueue');
  });

  it('ensures fail-safe handling: never throws if webhook network call rejects', async () => {
    // Force real fetch path with invalid URL that fails
    const originalUrl = process.env.SLACK_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = 'http://localhost:59999/nonexistent';

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Must resolve cleanly to false without throwing an unhandled rejection
    const res = await SlackNotifier.sendErrorAlert({
      title: 'Test Fail-Safe',
      message: 'Should handle network error cleanly',
    });

    expect(res).toBe(false);

    if (originalUrl) {
      process.env.SLACK_WEBHOOK_URL = originalUrl;
    } else {
      delete process.env.SLACK_WEBHOOK_URL;
    }
  });
});
