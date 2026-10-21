/**
 * Regression tests for durable Dashboard publish outcomes.
 *
 * The publisher is fire-and-forget. Before this, a failed publish was logged
 * and returned to the caller but never persisted, so an event that was dropped
 * could not be found, replayed, or audited once the log rotated. The
 * verification surface had no way to answer "was every customer turn actually
 * ingested?" beyond a log grep.
 *
 * These tests pin:
 *   1. every publish path records a durable outcome;
 *   2. a failed publish appears in the dead-letter view;
 *   3. a failed publish can be replayed, and a successful replay clears it;
 *   4. the stored payload is masked, so the evidence table cannot become an
 *      unbounded store of raw customer contact details.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CstDashboardPublisher,
  maskEventForStorage,
  replayUnpublishedDashboardEvents,
} from '../../engine/src/publishers/dashboard.js';
import { DbClient } from '../../engine/src/db/client.js';
import { createCstTurnEventV1 } from '../../engine/src/contracts/events.js';
import type { CustomerPayload } from '../../engine/src/contracts/events.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';

const customer: CustomerPayload = {
  customer_ref: 'cust_durable_001',
  phone_e164: '+15551234567',
  role: 'manager',
  is_known: true,
  tenant_id: TENANT,
  project_id: PROJECT,
  person_id: 'usr_durable_001',
  farm_ids: ['farm_e2e_1'],
};

function buildTurnEvent(id = 'turn_evt_durable_001'): any {
  return createCstTurnEventV1({
    id,
    tenant_id: TENANT,
    project_id: PROJECT,
    correlation_id: 'corr_durable_001',
    channel: 'sms',
    customer,
    turn: {
      turn_id: 'turn_durable_001',
      direction: 'inbound',
      channel: 'sms',
      status: 'ok',
      intent: 'knowledge',
      text: 'How do I clean the filter?',
      reply_text: 'Clean the filter mesh weekly.',
      duration: { total_ms: 42 },
    },
  });
}

function jsonResponse(status: number, body: unknown = { id: 'evt_1' }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('Durable Dashboard publish outcomes', () => {
  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    vi.restoreAllMocks();
  });

  // ── 1. Every path records an outcome ─────────────────────────────────────

  it('records a published outcome on a 2xx response', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    const result = await publisher.publish(buildTurnEvent());
    expect(result.success).toBe(true);

    const outcomes = DbClient.getAllDashboardPublishOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('published');
    expect(outcomes[0].http_status).toBe(201);
    expect(outcomes[0].event_id).toBe('turn_evt_durable_001');
    expect(outcomes[0].event_type).toBe('cst.turn');
    expect(outcomes[0].turn_id).toBe('turn_durable_001');
    expect(outcomes[0].correlation_id).toBe('corr_durable_001');
  });

  it('records a failed outcome on a non-retryable 4xx', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(422, { error: 'rejected' }));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    const result = await publisher.publish(buildTurnEvent());
    expect(result.success).toBe(false);

    const outcomes = DbClient.getAllDashboardPublishOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].http_status).toBe(422);
    expect(outcomes[0].error).toContain('HTTP_422');
  });

  it('records a missing_configuration outcome when the publisher is not configured', async () => {
    // Empty strings (not undefined) so the constructor does not fall back to
    // the environment, which does carry a Dashboard URL in the local .env.
    const publisher = new CstDashboardPublisher({
      dashboardUrl: '',
      dashboardKey: '',
    });

    const result = await publisher.publish(buildTurnEvent());
    expect(result.success).toBe(false);
    expect(result.error).toBe('MISSING_CONFIGURATION');

    const outcomes = DbClient.getAllDashboardPublishOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('missing_configuration');
  });

  it('records a dry_run outcome and makes no remote request', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      dryRun: true,
      fetchFn: fetchFn as any,
    });

    const result = await publisher.publish(buildTurnEvent());
    expect(result.success).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();

    const outcomes = DbClient.getAllDashboardPublishOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('dry_run');
  });

  // ── 2. The dead-letter view ──────────────────────────────────────────────

  it('lists a failed publish as unpublished and excludes a successful one', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, { error: 'rejected' }))
      .mockResolvedValueOnce(jsonResponse(201));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    await publisher.publish(buildTurnEvent());
    await publisher.publish(buildTurnEvent('turn_evt_durable_002'));

    const unpublished = await DbClient.getUnpublishedDashboardOutcomes();
    expect(unpublished).toHaveLength(1);
    expect(unpublished[0].event_id).toBe('turn_evt_durable_001');
    expect(unpublished[0].status).toBe('failed');
  });

  // ── 3. Replay ────────────────────────────────────────────────────────────

  it('replays a failed publish and clears it from the dead-letter view', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(422, { error: 'rejected' }))
      .mockResolvedValueOnce(jsonResponse(201));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    await publisher.publish(buildTurnEvent());
    expect(await DbClient.getUnpublishedDashboardOutcomes()).toHaveLength(1);

    const results = await replayUnpublishedDashboardEvents(publisher);

    expect(results).toHaveLength(1);
    expect(results[0].event_id).toBe('turn_evt_durable_001');
    expect(results[0].success).toBe(true);
    // The replayed event is no longer outstanding.
    expect(await DbClient.getUnpublishedDashboardOutcomes()).toHaveLength(0);
  });

  it('does not replay a published event', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(201));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    await publisher.publish(buildTurnEvent());
    const results = await replayUnpublishedDashboardEvents(publisher);

    expect(results).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // ── 4. Test isolation ────────────────────────────────────────────────────

  it('clears recorded outcomes with the rest of the test-visible state', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(422, { error: 'rejected' }));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    await publisher.publish(buildTurnEvent());
    expect(DbClient.getAllDashboardPublishOutcomes()).toHaveLength(1);

    // DbClient.clearAll() must clear the publish outcomes too, or one test
    // file's dead letters surface in the next file's view.
    DbClient.clearAll();
    expect(DbClient.getAllDashboardPublishOutcomes()).toHaveLength(0);
    expect(await DbClient.getUnpublishedDashboardOutcomes()).toHaveLength(0);
  });

  // ── 5. The stored payload is masked ──────────────────────────────────────

  it('masks phone numbers in the stored payload', () => {
    const masked = maskEventForStorage(buildTurnEvent()) as any;

    // The customer payload carries the recipient's phone number.
    expect(JSON.stringify(masked)).not.toContain('+15551234567');
    expect(masked.customer.phone_e164).toContain('4567');
    // Non-phone fields survive intact.
    expect(masked.data.text).toBe('How do I clean the filter?');
    expect(masked.tenant_id).toBe(TENANT);
  });

  it('does not store the raw recipient number in the recorded outcome', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(422, { error: 'rejected' }));
    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.example/ingest',
      dashboardKey: 'test-key',
      fetchFn: fetchFn as any,
    });

    await publisher.publish(buildTurnEvent());

    const outcomes = DbClient.getAllDashboardPublishOutcomes();
    const serialized = JSON.stringify(outcomes[0]);
    expect(serialized).not.toContain('+15551234567');
  });

  it('bounds a very large payload', () => {
    const huge = buildTurnEvent();
    huge.data.text = 'x'.repeat(5000);
    const masked = maskEventForStorage(huge) as any;
    expect(masked.data.text.length).toBeLessThan(2100);
    expect(masked.data.text).toContain('truncated');
  });
});
