import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DbClient } from '../../engine/src/db/client.js';
import { EscalationService } from '../../engine/src/escalation/service.js';
import { SlackNotifier } from '../../engine/src/notifications/slack.js';
import type { EscalationRequest } from '../../engine/src/escalation/types.js';

describe('EscalationService', () => {
  let savedSlackErrorUrl: string | undefined;
  let savedSlackUrl: string | undefined;

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    // Ensure Slack is not configured during tests (no real webhook calls)
    savedSlackErrorUrl = process.env.SLACK_ERROR_WEBHOOK_URL;
    savedSlackUrl = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_ERROR_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    SlackNotifier.reset();
  });

  afterEach(() => {
    // Restore env vars
    if (savedSlackErrorUrl) process.env.SLACK_ERROR_WEBHOOK_URL = savedSlackErrorUrl;
    if (savedSlackUrl) process.env.SLACK_WEBHOOK_URL = savedSlackUrl;
  });

  const baseRequest: EscalationRequest = {
    caller_phone: '+15551234567',
    tenant_id: 'tenant-vfarm-01',
    project_id: 'proj-vfarm-main',
    correlation_id: 'corr_esc_001',
    reason: 'I need to speak to a person about my farm',
    transcript: ['caller: hello', 'agent: how can I help?', 'caller: I need a person'],
  };

  it('creates a durable escalation record and returns the ID', async () => {
    const result = await EscalationService.escalate(baseRequest);

    expect(result.created).toBe(true);
    expect(result.escalation_id).toBeDefined();
    expect(result.escalation_id).toMatch(/^esc_/);
    expect(result.slack_notified).toBe(false);
    expect(result.email_captured).toBe(false);
    expect(result.status_message).toContain('recorded');
    expect(result.status_message).toContain('two hours');
  });

  it('does not claim Slack notification succeeded unless it succeeds', async () => {
    // SlackNotifier is not configured (no SLACK_WEBHOOK_URL), so notification
    // should not be claimed as successful.
    const result = await EscalationService.escalate(baseRequest);

    expect(result.slack_notified).toBe(false);
    expect(result.status_message).toContain('recorded');
    expect(result.status_message).not.toContain('has been notified');
  });

  it('captures caller email when provided', async () => {
    const result = await EscalationService.escalate({
      ...baseRequest,
      caller_email: 'farmer@example.com',
    });

    expect(result.email_captured).toBe(true);
    expect(result.caller_email).toBe('farmer@example.com');
  });

  it('persists the escalation record and is retrievable', async () => {
    const result = await EscalationService.escalate(baseRequest);
    expect(result.created).toBe(true);

    const record = await DbClient.getEscalationRecord(result.escalation_id!);
    expect(record).toBeDefined();
    expect(record!.caller_phone).toBe('+15551234567');
    expect(record!.tenant_id).toBe('tenant-vfarm-01');
    expect(record!.project_id).toBe('proj-vfarm-main');
    expect(record!.correlation_id).toBe('corr_esc_001');
    expect(record!.reason).toBe('I need to speak to a person about my farm');
    expect(record!.status).toBe('pending');
    expect(record!.slack_notified).toBe(false);
  });

  it('captures email after escalation', async () => {
    const result = await EscalationService.escalate(baseRequest);
    expect(result.created).toBe(true);

    const update = await EscalationService.captureEmail(result.escalation_id!, '+15551234567', 'farmer@example.com');
    expect(update.updated).toBe(true);

    const record = await DbClient.getEscalationRecord(result.escalation_id!);
    expect(record!.caller_email).toBe('farmer@example.com');
  });

  it('rejects invalid email format', async () => {
    const result = await EscalationService.escalate(baseRequest);
    expect(result.created).toBe(true);

    const update = await EscalationService.captureEmail(result.escalation_id!, '+15551234567', 'not-an-email');
    expect(update.updated).toBe(false);
    expect(update.error).toContain('Invalid email address');
  });

  it('handles empty transcript gracefully', async () => {
    const result = await EscalationService.escalate({
      ...baseRequest,
      transcript: [],
    });
    expect(result.created).toBe(true);

    const record = await DbClient.getEscalationRecord(result.escalation_id!);
    expect(record!.transcript).toEqual([]);
  });

  it('masks phone in logs (does not throw)', async () => {
    // Just verifies the escalation completes without error even with logging
    const result = await EscalationService.escalate(baseRequest);
    expect(result.created).toBe(true);
  });
});
