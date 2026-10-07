/**
 * Dashboard dry-run + product-contract acceptance tests
 * (LOOP-1790985133891-1TEN / LOOP-1790691898379-S6Q3, Phase 4).
 *
 * A real local HTTP sink stands in for the Dashboard ingestion endpoint so
 * every assertion is made against bytes that actually crossed a socket
 * (or, for dry-run, provably did NOT). This covers the full acceptance
 * matrix:
 *
 *   1. cst.turn,        dry_run=true   → validates, success, NO HTTP, NO persistence
 *   2. cst.delivery,    dry_run=true   → validates, success, NO HTTP, NO persistence
 *   3. dry_run=false                   → HTTP made, record persisted (verified after)
 *   4. invalid payload                 → dry-run: VALIDATION_FAILED; live: HTTP 400, fail fast
 *   5. invalid authentication          → HTTP 401, fail fast, no retry
 *   6. retry on 5xx                    → retries then succeeds, exactly once
 *   7. no configuration / no-op        → MISSING_CONFIGURATION, never throws
 *   8. duplicate / idempotent          → monotonic guard drops regressed delivery
 *   9. turn_id correlation             → cst.turn.turn_id === cst.delivery.turn_id
 *
 * Dry-run is the documented product contract (cst-e2e/DASHBOARD_FLOW.md §5):
 * when DRY_RUN=true the publisher validates the event against cst.event.v1
 * and logs it locally, but makes NO remote request, so the Dashboard
 * persists nothing. The before/after sink counts prove that.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { CstDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import {
  createCstTurnEventV1,
  createCstDeliveryEventV1,
  CustomerPayload,
} from '../../engine/src/contracts/index.js';
import { Logger } from '../../engine/src/config/logger.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const SINK_KEY = 'dry-run-sink-key';

const customer: CustomerPayload = {
  customer_ref: 'cust_dryrun_001',
  phone_e164: '+15551234567',
  role: 'manager',
  is_known: true,
  tenant_id: TENANT,
  project_id: PROJECT,
  person_id: 'usr_dryrun_001',
  farm_ids: ['farm_e2e_1'],
};

const turnEvent = createCstTurnEventV1({
  id: 'turn_evt_dryrun_1',
  tenant_id: TENANT,
  project_id: PROJECT,
  correlation_id: 'SM_DRYRUN_1',
  channel: 'sms',
  customer,
  turn: {
    turn_id: 'SM_DRYRUN_1',
    direction: 'inbound',
    channel: 'sms',
    status: 'ok',
    intent: 'knowledge',
    text: 'How do I clean the filter?',
    reply_text: 'Clean the filter mesh weekly.',
    duration: { total_ms: 42 },
  },
});

const deliveryEvent = createCstDeliveryEventV1({
  id: 'del_evt_dryrun_1',
  tenant_id: TENANT,
  project_id: PROJECT,
  correlation_id: 'SM_DRYRUN_1',
  channel: 'sms',
  customer,
  delivery: {
    delivery_id: 'out_dryrun_1',
    turn_id: 'SM_DRYRUN_1',
    provider_sid: 'SM_DRYRUN_1',
    channel: 'sms',
    to: '+15551234567',
    from: '+19715885823',
    status: 'delivered',
  },
});

interface SinkEvent {
  specversion?: string;
  id?: string;
  event_type?: string;
  tenant_id?: string;
  project_id?: string;
  correlation_id?: string;
  channel?: string;
  customer?: Record<string, any>;
  customer_ref?: string;
  turn_id?: string;
  direction?: string;
  status?: string;
  intent?: string;
  text?: string;
  reply_text?: string;
  latency_ms?: number;
  delivery_id?: string;
  provider_sid?: string;
  to?: string;
  from?: string;
  delivery_latency_ms?: number;
  segments?: number;
  delivered_at?: string;
  retry_count?: number;
}

let server: http.Server;
let sinkUrl: string;
let received: SinkEvent[] = [];
let requestCount = 0;
let failNextCount = 0;
let failNextStatus = 503;
let rejectAuth = false;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    requestCount += 1;
    const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    const xKey = req.headers['x-dashboard-key'] || '';

    if (rejectAuth && (auth !== SINK_KEY || xKey !== SINK_KEY)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_JSON' }));
      return;
    }
    // The real Dashboard validates the cst.event.v1 envelope; model
    // that here so a malformed event is rejected with HTTP 400.
    if (parsed.specversion !== 'cst.event.v1') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_SPECVERSION' }));
      return;
    }
    if (failNextCount > 0) {
      failNextCount -= 1;
      res.writeHead(failNextStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INJECTED_FAULT' }));
      return;
    }
    received.push(parsed);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  sinkUrl = `http://127.0.0.1:${port}/events`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  requestCount = 0;
  failNextCount = 0;
  rejectAuth = false;
  vi.restoreAllMocks();
});

const livePublisher = () =>
  new CstDashboardPublisher({
    dashboardUrl: sinkUrl,
    dashboardKey: SINK_KEY,
    maxRetries: 3,
    initialRetryDelayMs: 5,
  });

const dryRunPublisher = () =>
  new CstDashboardPublisher({
    dashboardUrl: sinkUrl,
    dashboardKey: SINK_KEY,
    dryRun: true,
    maxRetries: 3,
    initialRetryDelayMs: 5,
  });

describe('Dashboard dry-run acceptance (Phase 4 matrix)', () => {
  // ── 1. cst.turn, dry_run=true ──────────────────────────────────────
  it('1. cst.turn dry_run=true: validates, reports success, makes NO HTTP request, persists nothing', async () => {
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {});
    const fetchFn = vi.fn();
    const publisher = new CstDashboardPublisher({
      dashboardUrl: sinkUrl,
      dashboardKey: SINK_KEY,
      dryRun: true,
      fetchFn: fetchFn as any,
    });

    const before = received.length;
    const result = await publisher.publish(turnEvent);
    const after = received.length;

    // Response indicates success.
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.attempts).toBe(0);
    expect(result.eventId).toBe('turn_evt_dryrun_1');

    // No remote request was attempted...
    expect(fetchFn).not.toHaveBeenCalled();
    // ...and no production record was persisted (before/after proof).
    expect(after).toBe(before);
    expect(received).toHaveLength(0);

    // The event was validated and logged locally.
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('Dry-run'))).toBe(true);
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('SM_DRYRUN_1'))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── 2. cst.delivery, dry_run=true ──────────────────────────────────
  it('2. cst.delivery dry_run=true: validates, reports success, makes NO HTTP request, persists nothing', async () => {
    const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {});
    const fetchFn = vi.fn();
    const publisher = new CstDashboardPublisher({
      dashboardUrl: sinkUrl,
      dashboardKey: SINK_KEY,
      dryRun: true,
      fetchFn: fetchFn as any,
    });

    const before = received.length;
    const result = await publisher.publish(deliveryEvent);
    const after = received.length;

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(after).toBe(before);
    expect(received).toHaveLength(0);
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes('del_evt_dryrun_1'))).toBe(true);
  });

  // ── 3. dry_run=false: records persist ──────────────────────────────
  it('3. dry_run=false: makes the HTTP request and the record persists (verified after)', async () => {
    const publisher = livePublisher();
    expect(publisher.isDryRun()).toBe(false);

    const before = received.length;
    const result = await publisher.publish(turnEvent);
    const after = received.length;

    expect(result.success).toBe(true);
    expect(result.status).toBe(202);
    expect(result.attempts).toBe(1);
    expect(result.dryRun).toBeUndefined();

    // The record persisted: the sink now holds exactly one more event.
    expect(after).toBe(before + 1);
    expect(received).toHaveLength(1);
    expect(received[0].event_type).toBe('cst.turn');
    expect(received[0].turn_id).toBe('SM_DRYRUN_1');
    expect(received[0].tenant_id).toBe(TENANT);
    expect(received[0].project_id).toBe(PROJECT);
  });

  // ── 4. invalid payload ─────────────────────────────────────────────
  it('4a. invalid payload dry_run=true: fails validation, makes NO HTTP request', async () => {
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const fetchFn = vi.fn();
    const publisher = new CstDashboardPublisher({
      dashboardUrl: sinkUrl,
      dashboardKey: SINK_KEY,
      dryRun: true,
      fetchFn: fetchFn as any,
    });

    // Structurally invalid: missing the required cst.event.v1 envelope fields.
    const invalid = { id: 'evt_bad', type: 'cst.turn' } as any;
    const before = received.length;
    const result = await publisher.publish(invalid);
    const after = received.length;

    expect(result.success).toBe(false);
    expect(result.error).toBe('VALIDATION_FAILED');
    expect(result.dryRun).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(after).toBe(before);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('validation failed'))).toBe(true);
  });

  it('4b. invalid payload dry_run=false: the sink rejects it with HTTP 400 and the publisher fails fast', async () => {
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const publisher = livePublisher();

    // A wrong specversion forces the sink's 400 branch.
    const invalid = { ...turnEvent, specversion: 'cst.event.WRONG' } as any;
    const result = await publisher.publish(invalid);

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.attempts).toBe(1); // fail fast: exactly one attempt
    expect(result.error).toBe('HTTP_400');
    expect(received).toHaveLength(0);
  });

  // ── 5. invalid authentication ──────────────────────────────────────
  it('5. invalid authentication: HTTP 401 fails fast with no retry', async () => {
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    rejectAuth = true; // sink 401s any request without the correct key

    const publisher = new CstDashboardPublisher({
      dashboardUrl: sinkUrl,
      dashboardKey: 'wrong-key',
      maxRetries: 3,
      initialRetryDelayMs: 5,
    });

    const result = await publisher.publish(turnEvent);

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.attempts).toBe(1); // 401 is non-retryable
    expect(result.error).toBe('HTTP_401');
    expect(requestCount).toBe(1);
  });

  // ── 6. retry on 5xx ────────────────────────────────────────────────
  it('6. retry on 5xx: retries then succeeds and the event is persisted exactly once', async () => {
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    failNextCount = 2; // first two attempts 503, third succeeds
    requestCount = 0;

    const publisher = livePublisher();
    const result = await publisher.publish(turnEvent);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(requestCount).toBe(3);
    // Exactly one persisted record despite three attempts.
    expect(received).toHaveLength(1);
    expect(received[0].turn_id).toBe('SM_DRYRUN_1');
  });

  // ── 7. no configuration / no-op ────────────────────────────────────
  it('7. no configuration: reports MISSING_CONFIGURATION and never throws', async () => {
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const savedUrl = process.env.ENGINE_DASHBOARD_URL;
    const savedKey = process.env.ENGINE_DASHBOARD_KEY;
    delete process.env.ENGINE_DASHBOARD_URL;
    delete process.env.ENGINE_DASHBOARD_KEY;
    try {
      const publisher = new CstDashboardPublisher({});
      expect(publisher.isConfigured()).toBe(false);
      const result = await publisher.publish(turnEvent);
      expect(result.success).toBe(false);
      expect(result.error).toBe('MISSING_CONFIGURATION');
      expect(result.attempts).toBe(0);
      // Fire-and-forget must also stay silent rather than throwing.
      expect(() => publisher.publishFireAndForget(turnEvent)).not.toThrow();
    } finally {
      process.env.ENGINE_DASHBOARD_URL = savedUrl;
      process.env.ENGINE_DASHBOARD_KEY = savedKey;
    }
    expect(received).toHaveLength(0);
  });

  // ── 8. duplicate / idempotent ──────────────────────────────────────
  it('8. duplicate delivery: a regressed status is dropped by the monotonic guard', async () => {
    const { publishDelivery, resetMonotonicStore, isMonotonicAdvance } = await import(
      '../../engine/src/publishers/delivery.js'
    );
    const { setActiveDashboardPublisher } = await import(
      '../../engine/src/publishers/dashboard.js'
    );
    resetMonotonicStore();
    // Route the fire-and-forget singleton at the local sink.
    setActiveDashboardPublisher(livePublisher());
    try {
      // First publish: delivered (rank 4).
      expect(isMonotonicAdvance('SM_DUP_1', 'delivered')).toBe(true);
      publishDelivery({
        providerSid: 'SM_DUP_1',
        messageId: 'out_dup_1',
        turnId: 'SM_DUP_1',
        channel: 'sms',
        to: '+15551234567',
        from: '+19715885823',
        status: 'delivered',
        tenantId: TENANT,
        projectId: PROJECT,
        correlationId: 'SM_DUP_1',
      });

      // A late duplicate `sent` (rank 3) must NOT advance and must NOT publish.
      expect(isMonotonicAdvance('SM_DUP_1', 'sent')).toBe(false);
      publishDelivery({
        providerSid: 'SM_DUP_1',
        messageId: 'out_dup_1',
        turnId: 'SM_DUP_1',
        channel: 'sms',
        to: '+15551234567',
        from: '+19715885823',
        status: 'sent',
        tenantId: TENANT,
        projectId: PROJECT,
        correlationId: 'SM_DUP_1',
      });

      // Allow the fire-and-forget first event to land.
      await new Promise((r) => setTimeout(r, 100));
      const deliveredEvents = received.filter((e) => e.event_type === 'cst.delivery');
      expect(deliveredEvents).toHaveLength(1);
      expect(deliveredEvents[0].status).toBe('delivered');
    } finally {
      setActiveDashboardPublisher(null);
    }
  });

  // ── 9. turn_id correlation ─────────────────────────────────────────
  it('9. turn_id correlation: cst.turn.turn_id === cst.delivery.turn_id for the same customer turn', async () => {
    const publisher = livePublisher();

    await publisher.publish(turnEvent);
    await publisher.publish(deliveryEvent);

    const turn = received.find((e) => e.event_type === 'cst.turn');
    const delivery = received.find((e) => e.event_type === 'cst.delivery');
    expect(turn).toBeDefined();
    expect(delivery).toBeDefined();
    // The join key matches exactly.
    expect(turn!.turn_id).toBe(delivery!.turn_id);
    expect(turn!.turn_id).toBe('SM_DRYRUN_1');
    expect(delivery!.turn_id).toBe('SM_DRYRUN_1');
  });
});

describe('Dashboard dry-run configuration', () => {
  it('defaults dryRun from the DRY_RUN environment variable', async () => {
    const saved = process.env.DRY_RUN;
    try {
      process.env.DRY_RUN = 'true';
      const fromEnv = new CstDashboardPublisher({ dashboardUrl: sinkUrl, dashboardKey: SINK_KEY });
      expect(fromEnv.isDryRun()).toBe(true);

      process.env.DRY_RUN = 'false';
      const explicitOff = new CstDashboardPublisher({ dashboardUrl: sinkUrl, dashboardKey: SINK_KEY });
      expect(explicitOff.isDryRun()).toBe(false);

      delete process.env.DRY_RUN;
      const unset = new CstDashboardPublisher({ dashboardUrl: sinkUrl, dashboardKey: SINK_KEY });
      expect(unset.isDryRun()).toBe(false);

      // An explicit option always wins over the environment.
      process.env.DRY_RUN = 'true';
      const explicit = new CstDashboardPublisher({ dashboardUrl: sinkUrl, dashboardKey: SINK_KEY, dryRun: false });
      expect(explicit.isDryRun()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.DRY_RUN;
      else process.env.DRY_RUN = saved;
    }
  });

  it('dry-run fire-and-forget never contacts the remote sink', async () => {
    const fetchFn = vi.fn();
    const publisher = new CstDashboardPublisher({
      dashboardUrl: sinkUrl,
      dashboardKey: SINK_KEY,
      dryRun: true,
      fetchFn: fetchFn as any,
    });
    const before = received.length;
    publisher.publishFireAndForget(turnEvent);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(received.length).toBe(before);
  });
});
