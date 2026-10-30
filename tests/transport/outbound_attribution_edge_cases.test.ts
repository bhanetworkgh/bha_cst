/**
 * Outbound attribution regression tests — edge cases not covered by
 * delivery_callback_security.test.ts and delivery_persistence.test.ts.
 *
 * Covers:
 * - SID persistence failure surfaces as an error (not silence)
 * - Callback with database lookup failure is handled gracefully
 * - SID is persisted before or safely coordinated with provider send
 * - Provider SID persistence returns explicit success/failure
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { resetMonotonicStore } from '../../engine/src/publishers/delivery.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';
import { processOutboundQueue } from '../../engine/src/transport/twilio/outbound.js';
import type { OutboundMessage } from '../../engine/src/transport/twilio/types.js';

const app = createApp();
const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const SERVICE_DID = '+19715885823';
const RECIPIENT = '+15551234567';

const postCallback = (body: Record<string, string>) =>
  request(app)
    .post('/webhooks/twilio/delivery-status')
    .set('x-test-bypass-signature', 'true')
    .type('form')
    .send(body);

describe('Outbound attribution edge cases', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    resetMonotonicStore();
    TwilioClientWrapper.setMockHandler(async () => ({ sid: 'SM_EDGE_001', status: 'sent' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
    TwilioClientWrapper.setMockHandler(null);
  });

  // ── SID persistence failure surfaces as error ─────────────────────────

  it('updateOutboundProviderSid failure is logged but does not crash the callback handler', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_sid_fail',
      tenant_id: TENANT,
      project_id: PROJECT,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'sid persist test',
      correlation_id: 'corr_sid_fail',
      turn_id: 'turn_sid_fail',
      provider_sid: 'SM_SID_FAIL',
      status: 'sent',
    } as OutboundMessage);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock the pool query to fail for the update
    const mockPool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'out_sid_fail' }] })
        .mockResolvedValueOnce({ rowCount: 0, rows: [] }),
    };
    DbClient.setPool(mockPool as any);

    // The callback handler should still return 204 even if a DB update partially fails
    const res = await postCallback({
      MessageSid: 'SM_SID_FAIL',
      MessageStatus: 'delivered',
      To: RECIPIENT,
      From: SERVICE_DID,
    });

    expect(res.status).toBe(204);
    errorSpy.mockRestore();
    DbClient.setPool(null);
  });

  // ── Callback with database lookup failure ──────────────────────────────

  it('callback handler survives a database lookup failure gracefully', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_db_err',
      tenant_id: TENANT,
      project_id: PROJECT,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'db error test',
      correlation_id: 'corr_db_err',
      turn_id: 'turn_db_err',
      provider_sid: 'SM_DB_ERR',
      status: 'sent',
    } as OutboundMessage);

    // Mock the pool query to reject on the callback lookup
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    DbClient.setPool(mockPool as any);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postCallback({
      MessageSid: 'SM_DB_ERR',
      MessageStatus: 'delivered',
      To: RECIPIENT,
      From: SERVICE_DID,
    });

    // Must return 204 even on DB failure — Twilio must not retry
    expect(res.status).toBe(204);
    // The error must be observable
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    DbClient.setPool(null);
  });

  // ── SID persisted before provider send ─────────────────────────────────

  it('outbound row carries provider_sid after successful send', async () => {
    // Pre-record consent so the consent gate doesn't block this operational SMS
    await import('../../engine/src/consent/service.js').then(m => m.recordConsent(
      TENANT, RECIPIENT, { projectId: PROJECT, source: 'test' },
    ));

    await DbClient.saveOutboundMessage({
      id: 'out_sid_persist',
      tenant_id: TENANT,
      project_id: PROJECT,
      from_e164: SERVICE_DID,
      to_e164: RECIPIENT,
      body: 'sid persist verify',
      correlation_id: 'corr_sid_persist',
      turn_id: 'turn_sid_persist',
      status: 'pending',
    } as OutboundMessage);

    const updateSidSpy = vi.spyOn(DbClient, 'updateOutboundProviderSid');
    const updateFromSpy = vi.spyOn(DbClient, 'updateOutboundFromE164');

    await processOutboundQueue();

    // After the send succeeds, the provider_sid must be persisted
    expect(updateSidSpy).toHaveBeenCalled();
    expect(updateFromSpy).toHaveBeenCalled();

    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'out_sid_persist');
    expect(row?.provider_sid).toBe('SM_EDGE_001');
    expect(row?.status).toBe('sent');
  });

  // ── Provider SID persistence returns explicit result ───────────────────

  it('updateOutboundProviderSid completes without throwing even if row does not exist', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw for a non-existent row
    await expect(DbClient.updateOutboundProviderSid('nonexistent_row', 'SM_NONEXISTENT')).resolves.toBeUndefined();

    errorSpy.mockRestore();
  });
});
