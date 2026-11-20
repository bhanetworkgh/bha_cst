import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { DbClient } from '../../engine/src/db/client.js';
import { EscalationService } from '../../engine/src/escalation/service.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { SlackNotifier } from '../../engine/src/notifications/slack.js';
import type { EscalationRequest } from '../../engine/src/escalation/types.js';

const DB_ENABLED = process.env.CST_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);

describe('EscalationService', () => {
  let savedSlackErrorUrl: string | undefined;
  let savedSlackUrl: string | undefined;
  let savedSlackBotToken: string | undefined;
  let savedSlackCsUrl: string | undefined;
  let savedSlackCustUrl: string | undefined;

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    // Ensure Slack is not configured during tests (no real webhook calls)
    savedSlackErrorUrl = process.env.SLACK_ERROR_WEBHOOK_URL;
    savedSlackUrl = process.env.SLACK_WEBHOOK_URL;
    savedSlackBotToken = process.env.SLACK_BOT_TOKEN;
    savedSlackCsUrl = process.env.SLACK_CS_WEBHOOK_URL;
    savedSlackCustUrl = process.env.SLACK_CUSTOMER_SERVICE_WEBHOOK_URL;
    delete process.env.SLACK_ERROR_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_CS_WEBHOOK_URL;
    delete process.env.SLACK_CUSTOMER_SERVICE_WEBHOOK_URL;
    ErrorRouter.reset();
    SlackNotifier.reset();
  });

  afterEach(() => {
    // Restore env vars
    if (savedSlackErrorUrl) process.env.SLACK_ERROR_WEBHOOK_URL = savedSlackErrorUrl;
    if (savedSlackUrl) process.env.SLACK_WEBHOOK_URL = savedSlackUrl;
    if (savedSlackBotToken) process.env.SLACK_BOT_TOKEN = savedSlackBotToken;
    if (savedSlackCsUrl) process.env.SLACK_CS_WEBHOOK_URL = savedSlackCsUrl;
    if (savedSlackCustUrl) process.env.SLACK_CUSTOMER_SERVICE_WEBHOOK_URL = savedSlackCustUrl;
    ErrorRouter.reset();
    SlackNotifier.reset();
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

  it('routes notification through ErrorRouter (CS_HANDOFF -> #bha-customer-service-twin) and transitions status across pending, notified, failed, and acknowledged', async () => {
    // 1. Pending when unconfigured
    const pendingRes = await EscalationService.escalate({
      ...baseRequest,
      conversation_id: 'conv_esc_lifecycle_1',
    });
    expect(pendingRes.created).toBe(true);
    expect(pendingRes.slack_notified).toBe(false);
    let rec = await EscalationService.getEscalation(pendingRes.escalation_id!);
    expect(rec?.status).toBe('pending');

    // 2. Duplicate retry for the same conversation_id does not create a duplicate escalation row
    const dupeId = await DbClient.createEscalationRecord({
      caller_phone: baseRequest.caller_phone,
      tenant_id: baseRequest.tenant_id,
      project_id: baseRequest.project_id,
      conversation_id: 'conv_esc_lifecycle_1',
      correlation_id: baseRequest.correlation_id,
      reason: baseRequest.reason,
    });
    expect(dupeId).toBe(pendingRes.escalation_id);

    // 3. Failed dispatch transitions escalation status to failed and records error
    ErrorRouter.setMockHandler(async () => {
      throw new Error('Slack API 500 failure');
    });
    const failedRes = await EscalationService.escalate({
      ...baseRequest,
      conversation_id: 'conv_esc_lifecycle_2',
      correlation_id: 'corr_esc_002',
    });
    expect(failedRes.created).toBe(true);
    expect(failedRes.slack_notified).toBe(false);
    expect(failedRes.error).toContain('Slack API 500 failure');
    const failedRec = await EscalationService.getEscalation(failedRes.escalation_id!);
    expect(failedRec?.status).toBe('failed');
    expect(failedRec?.slack_error).toContain('Slack API 500 failure');

    // 4. Successful dispatch transitions escalation status to notified ('sent')
    let routedChannel = '';
    ErrorRouter.setMockHandler(async (classified) => {
      routedChannel = classified.destination_channel;
      return true;
    });
    const sentRes = await EscalationService.escalate({
      ...baseRequest,
      conversation_id: 'conv_esc_lifecycle_3',
      correlation_id: 'corr_esc_003',
    });
    expect(sentRes.slack_notified).toBe(true);
    expect(routedChannel).toBe('#bha-customer-service-twin');
    const sentRec = await EscalationService.getEscalation(sentRes.escalation_id!);
    expect(sentRec?.status).toBe('notified');
    expect(sentRec?.slack_notified).toBe(true);

    // 5. Human operator acknowledgement transitions status to acknowledged
    const ackRes = await EscalationService.acknowledgeEscalation(sentRes.escalation_id!, 'Destiny Arupi (U0AEW3TBYH1)');
    expect(ackRes.acknowledged).toBe(true);
    expect(ackRes.record?.status).toBe('acknowledged');
    expect(ackRes.record?.acknowledged_by).toBe('Destiny Arupi (U0AEW3TBYH1)');
    expect(ackRes.record?.acknowledged_at).toBeDefined();
  });
});

if (DB_ENABLED) {
  describe('EscalationService — real PostgreSQL schema & lifecycle persistence (Stage S2)', () => {
    let realPool: pg.Pool;
    const createdIds: string[] = [];

    beforeAll(async () => {
      realPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      DbClient.setPool(realPool);
    });

    afterAll(async () => {
      if (realPool && createdIds.length > 0) {
        await realPool.query(`DELETE FROM escalations WHERE id = ANY($1::text[])`, [createdIds]);
      }
      await DbClient.disconnect();
    });

    it('persists pending, sent, notified, failed, and acknowledged statuses with acknowledged_by and acknowledged_at in PostgreSQL', async () => {
      const convId = `conv_pg_esc_${Date.now()}`;
      const escId = await DbClient.createEscalationRecord({
        caller_phone: '+15551234567',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        conversation_id: convId,
        correlation_id: convId,
        caller_email: 'farmer@austin.test',
        reason: 'Pump failure requires technician',
        transcript: ['user: I need a human technician'],
        status: 'pending',
      });
      createdIds.push(escId);

      // Duplicate retry with same (tenant_id, project_id, conversation_id) returns identical deterministic ID and does not duplicate row
      const retryId = await DbClient.createEscalationRecord({
        caller_phone: '+15551234567',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        conversation_id: convId,
        correlation_id: convId,
        reason: 'Duplicate retry',
        status: 'pending',
      });
      expect(retryId).toBe(escId);

      const countRes = await realPool.query(`SELECT count(*)::int AS cnt FROM escalations WHERE id = $1`, [escId]);
      expect(countRes.rows[0].cnt).toBe(1);

      // Transition to failed in PostgreSQL
      await DbClient.updateEscalationSlackStatus(escId, false, 'chat.postMessage: channel_not_found');
      DbClient.clearAll();
      let pgRecord = await DbClient.getEscalationRecord(escId);
      expect(pgRecord?.status).toBe('failed');
      expect(pgRecord?.slack_notified).toBe(false);
      expect(pgRecord?.slack_error).toBe('chat.postMessage: channel_not_found');

      // Transition to notified in PostgreSQL
      await DbClient.updateEscalationSlackStatus(escId, true);
      DbClient.clearAll();
      pgRecord = await DbClient.getEscalationRecord(escId);
      expect(pgRecord?.status).toBe('notified');
      expect(pgRecord?.slack_notified).toBe(true);
      expect(pgRecord?.slack_notified_at).toBeDefined();
      expect(pgRecord?.slack_error).toBeUndefined();

      // Transition to acknowledged in PostgreSQL with distinct acknowledged_by / acknowledged_at columns
      const ackTime = '2026-11-20T18:30:00.000Z';
      const ackOk = await DbClient.acknowledgeEscalationRecord(escId, 'Destiny Arupi (U0AEW3TBYH1)', ackTime);
      expect(ackOk).toBe(true);

      DbClient.clearAll();
      pgRecord = await DbClient.getEscalationRecord(escId);
      expect(pgRecord?.status).toBe('acknowledged');
      expect(pgRecord?.acknowledged_by).toBe('Destiny Arupi (U0AEW3TBYH1)');
      expect(pgRecord?.acknowledged_at).toBe(ackTime);
      expect(pgRecord?.reason).toBe('Pump failure requires technician');

      // Subsequent Slack status updates must not downgrade an acknowledged record in PostgreSQL
      await DbClient.updateEscalationSlackStatus(escId, true);
      DbClient.clearAll();
      pgRecord = await DbClient.getEscalationRecord(escId);
      expect(pgRecord?.status).toBe('acknowledged');
      expect(pgRecord?.acknowledged_by).toBe('Destiny Arupi (U0AEW3TBYH1)');

      // Direct status='sent' check against ck_escalation_status constraint
      const sentConvId = `conv_pg_esc_sent_${Date.now()}`;
      const sentEscId = await DbClient.createEscalationRecord({
        caller_phone: '+15551234567',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        conversation_id: sentConvId,
        correlation_id: sentConvId,
        reason: 'Direct sent status test',
        status: 'sent',
      });
      createdIds.push(sentEscId);
      DbClient.clearAll();
      const sentPgRec = await DbClient.getEscalationRecord(sentEscId);
      expect(sentPgRec?.status).toBe('sent');
      expect(sentPgRec?.slack_notified).toBe(true);
    });
  });
}
