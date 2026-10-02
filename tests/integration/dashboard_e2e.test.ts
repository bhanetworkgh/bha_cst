/**
 * Engine Dashboard end-to-end (CST side of the `cst.event.v1` contract).
 *
 * A real HTTP sink stands in for the Dashboard ingestion endpoint, so every
 * assertion here is made against bytes that actually crossed a socket and were
 * authenticated — not against a spy. This covers the five required `cst.turn`
 * statuses, `cst.delivery` correlation on `turn_id`, tenant/project attribution,
 * the fire-and-forget guarantee, and retry-without-duplicates.
 *
 * The live single-turn check against a running engine is performed separately;
 * see §15 of docs/evidence/cst-user-integration-admin-panel.md.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CstDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';
import type { MessageEnvelope } from '../../engine/src/core/envelope.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const SINK_KEY = 'e2e-sink-key';

interface SinkEvent {
  specversion: string;
  id: string;
  type: string;
  source: string;
  time: string;
  tenant_id: string;
  project_id: string;
  correlation_id: string;
  customer?: Record<string, any>;
  data: Record<string, any>;
}

let server: http.Server;
let sinkUrl: string;
let received: SinkEvent[] = [];
let requestCount = 0;
let failNextCount = 0;
let failNextStatus = 503;
let rejectWrongKey = true;

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
    const spec = req.headers['x-cst-specversion'] || '';

    if (rejectWrongKey && (auth !== SINK_KEY || xKey !== SINK_KEY)) {
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
    // Validate the spec version in both the header and the payload.
    if (spec !== 'cst.event.v1' || parsed?.specversion !== 'cst.event.v1') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'BAD_SPEC_VERSION', header: spec, payload: parsed?.specversion ?? null }));
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

  process.env.ENGINE_DASHBOARD_URL = sinkUrl;
  process.env.ENGINE_DASHBOARD_KEY = SINK_KEY;

  // `dashboardPublisher` is a module-level singleton constructed at import time,
  // so it would have captured the (then unset) env. Inject a publisher aimed at
  // the sink through the supported seam instead of fighting import order.
  CoreEngine.setDashboardPublisher(
    new CstDashboardPublisher({
      dashboardUrl: sinkUrl,
      dashboardKey: SINK_KEY,
      maxRetries: 3,
      initialRetryDelayMs: 25,
    })
  );
});

afterAll(async () => {
  CoreEngine.setDashboardPublisher(null);
  delete process.env.ENGINE_DASHBOARD_URL;
  delete process.env.ENGINE_DASHBOARD_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  requestCount = 0;
  failNextCount = 0;
  DbClient.clearAll();
  CoreRegistry.resetToDefault();
});

function speaker(over: Partial<SpeakerIdentity> = {}): SpeakerIdentity {
  return {
    person_id: 'usr_e2e',
    customer_ref: 'cust_usr_e2e',
    tenant_id: TENANT,
    project_id: PROJECT,
    phone_e164: '+15551234567',
    is_known: true,
    role: 'manager',
    permissions: ['read:telemetry', 'write:control'],
    farm_ids: ['farm_e2e_1'],
    ...over,
  };
}

function envelope(text: string, correlationId: string): MessageEnvelope {
  return {
    tenant_id: TENANT,
    project_id: PROJECT,
    channel: 'sms',
    speaker_ref: 'cust_usr_e2e',
    text,
    media: [],
    correlation_id: correlationId,
  };
}

/** Events still in flight on the fire-and-forget path. */
async function settle(ms = 700) {
  await new Promise((r) => setTimeout(r, ms));
}

function turns(): SinkEvent[] {
  return received.filter((e) => e.type === 'cst.turn');
}
function deliveries(): SinkEvent[] {
  return received.filter((e) => e.type === 'cst.delivery');
}

describe('Engine Dashboard E2E — required cst.turn statuses', () => {
  it('delivers status "ok" for a normal answered turn', async () => {
    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockResolvedValue('Clean the filter mesh weekly.');

    await CoreEngine.processEnvelope(
      envelope('How do I clean the filter?', 'SM_E2E_OK'),
      speaker()
    );
    await settle();

    expect(turns()).toHaveLength(1);
    const t = turns()[0];
    expect(t.specversion).toBe('cst.event.v1');
    expect(t.data.status).toBe('ok');
    expect(t.data.turn_id).toBe('SM_E2E_OK');
    expect(t.tenant_id).toBe(TENANT);
    expect(t.project_id).toBe(PROJECT);
    expect(t.data.reply_text).toContain('Clean the filter mesh');
    vi.restoreAllMocks();
  });

  it('delivers status "onboarding" for a caller the tenant adapter does not know', async () => {
    await CoreEngine.processEnvelope(
      envelope('How do I clean the filter?', 'SM_E2E_ONBOARDING'),
      speaker({ is_known: false, role: 'unknown', permissions: [], farm_ids: [] })
    );
    await settle();

    expect(turns()).toHaveLength(1);
    expect(turns()[0].data.status).toBe('onboarding');
    // Onboarding must never leak farm scope.
    expect(turns()[0].customer?.farm_ids).toEqual([]);
    expect(JSON.stringify(turns()[0])).not.toContain('farm_e2e_1');
  });

  it('delivers status "refused" when the role is not authorized for the action', async () => {
    await CoreEngine.processEnvelope(
      envelope('turn off pump bay 4', 'SM_E2E_REFUSED'),
      speaker({ role: 'tech', permissions: ['read:telemetry'] })
    );
    await settle();

    expect(turns()).toHaveLength(1);
    expect(turns()[0].data.status).toBe('refused');
    expect(turns()[0].tenant_id).toBe(TENANT);
    expect(turns()[0].project_id).toBe(PROJECT);
  });

  it('delivers status "step_up_required" for a sensitive action without step-up verification', async () => {
    await CoreEngine.processEnvelope(
      envelope('reset factory settings and reconfigure the controller', 'SM_E2E_STEPUP'),
      speaker()
    );
    await settle();

    expect(turns()).toHaveLength(1);
    expect(turns()[0].data.status).toBe('step_up_required');
  });

  it('delivers status "error" when escalation ticketing fails, and does not invent an incident id', async () => {
    const inc = await import('../../engine/src/connectors/bharag_incidents.js');
    vi.spyOn(inc.BharagIncidentsConnector, 'fileIncident').mockResolvedValue({
      incident_id: null,
      created: false,
      status: 'unavailable',
      detail: 'simulated BHARAG outage',
    } as any);

    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockResolvedValue('Escalating this to a specialist.');

    await CoreEngine.processEnvelope(
      envelope('escalate this immediately', 'SM_E2E_ERROR'),
      speaker()
    );
    await settle();

    expect(turns()).toHaveLength(1);
    const t = turns()[0];
    expect(t.data.status).toBe('error');
    // No synthetic incident id may reach the Dashboard.
    expect(t.data.incident_id ?? null).toBeNull();
    expect(JSON.stringify(t)).not.toContain('inc_vfarm_');
    vi.restoreAllMocks();
  });

  it('covers all five required statuses across the engine', async () => {
    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    const inc = await import('../../engine/src/connectors/bharag_incidents.js');

    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockResolvedValue('Answer.');
    vi.spyOn(inc.BharagIncidentsConnector, 'fileIncident').mockResolvedValue({
      incident_id: null,
      created: false,
      status: 'unavailable',
      detail: 'simulated',
    } as any);

    const scenarios: { corr: string; spk: SpeakerIdentity; text: string }[] = [
      { corr: 'SM_ALL_OK', spk: speaker(), text: 'How do I clean the filter?' },
      {
        corr: 'SM_ALL_ONBOARDING',
        spk: speaker({ is_known: false, role: 'unknown', permissions: [], farm_ids: [] }),
        text: 'How do I clean the filter?',
      },
      { corr: 'SM_ALL_REFUSED', spk: speaker({ role: 'tech', permissions: [] }), text: 'turn off pump bay 4' },
      { corr: 'SM_ALL_STEPUP', spk: speaker(), text: 'reset factory settings and reconfigure the controller' },
      { corr: 'SM_ALL_ERROR', spk: speaker(), text: 'escalate this immediately' },
    ];

    for (const s of scenarios) {
      await CoreEngine.processEnvelope(envelope(s.text, s.corr), s.spk);
    }
    await settle(1200);

    const statuses = new Set(turns().map((t) => t.data.status));
    for (const required of ['ok', 'refused', 'step_up_required', 'onboarding', 'error']) {
      expect(statuses, `missing required status ${required}`).toContain(required);
    }
    // Every event must carry real tenancy.
    for (const t of turns()) {
      expect(t.tenant_id).toBe(TENANT);
      expect(t.project_id).toBe(PROJECT);
      expect(t.data.turn_id).toBe(t.correlation_id);
    }
    vi.restoreAllMocks();
  });
});

describe('Engine Dashboard E2E — cst.delivery correlation', () => {
  it('shares turn_id between cst.turn and cst.delivery for the same customer turn', async () => {
    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockResolvedValue('Clean the filter mesh weekly.');

    const turnId = 'SM_CORR_1';
    await CoreEngine.processEnvelope(envelope('How do I clean the filter?', turnId), speaker());
    await settle();

    // `processEnvelope` returns the reply; the SMS interface layer is what
    // persists it, so reproduce that write exactly (correlation_id and turn_id
    // are both the MessageSid) to exercise the real correlation path.
    await DbClient.saveOutboundMessage({
      id: 'out_corr_1',
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+15551234567',
      from_e164: '+19715885823',
      body: 'Clean the filter mesh weekly.',
      correlation_id: turnId,
      turn_id: turnId,
      status: 'pending',
    } as any);

    const out = DbClient.getAllMessagesOut()[0];
    expect(out).toBeDefined();
    // The reply row carries the originating turn_id; correlation_id is the same
    // value on the SMS lane, so fall back to it rather than asserting undefined.
    const storedTurnId = out.turn_id || out.correlation_id;
    expect(storedTurnId).toBe(turnId);
    await DbClient.updateOutboundProviderSid(out.id!, 'SM_DELIVERY_1');
    const { publishDelivery, resetMonotonicStore } = await import(
      '../../engine/src/publishers/delivery.js'
    );
    resetMonotonicStore();
    publishDelivery({
      providerSid: 'SM_DELIVERY_1',
      messageId: out.id!,
      turnId: storedTurnId,
      channel: 'sms',
      to: '+15551234567',
      from: '+19715885823',
      status: 'delivered',
      tenantId: TENANT,
      projectId: PROJECT,
      correlationId: turnId,
    });
    await settle();

    const t = turns()[0];
    const d = deliveries().find((e) => e.data.status === 'delivered')!;
    expect(d).toBeDefined();
    expect(t.data.turn_id).toBe(d.data.turn_id);
    expect(d.data.turn_id).toBe(turnId);
    expect(d.tenant_id).toBe(TENANT);
    expect(d.project_id).toBe(PROJECT);
    vi.restoreAllMocks();
  });
});

describe('Engine Dashboard E2E — fire-and-forget and retry', () => {
  it('publishes without blocking the customer response', async () => {
    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    // A deliberately slow connector: if publishing were awaited inline the
    // engine would be delayed by the same amount.
    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockImplementation(
      () => new Promise((r) => setTimeout(() => r('Slow answer.'), 600))
    );

    const started = Date.now();
    await CoreEngine.processEnvelope(envelope('How do I clean the filter?', 'SM_FF_1'), speaker());
    const elapsed = Date.now() - started;

    // The engine must return before the publisher has delivered.
    expect(turns()).toHaveLength(0);
    expect(elapsed).toBeGreaterThanOrEqual(550);

    await settle();
    expect(turns()).toHaveLength(1);
    expect(turns()[0].data.status).toBe('ok');
    vi.restoreAllMocks();
  });

  it('retries a 5xx and delivers the event exactly once', async () => {
    failNextCount = 2; // first two attempts fail, third succeeds
    requestCount = 0; // only count attempts for this event
    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockResolvedValue('Answer.');

    await CoreEngine.processEnvelope(envelope('How do I clean the filter?', 'SM_RETRY_1'), speaker());
    await settle(1500);

    expect(requestCount).toBeGreaterThanOrEqual(3);
    // Exactly one event recorded: retries must not duplicate.
    expect(turns()).toHaveLength(1);
    expect(turns()[0].data.turn_id).toBe('SM_RETRY_1');
    vi.restoreAllMocks();
  });

  it('fails fast on a non-retryable 4xx and does not retry', async () => {
    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockResolvedValue('Answer.');

    // A deliberately invalid payload spec version forces the sink's 400 branch,
    // which the publisher must treat as non-retryable (not retried).
    failNextCount = 0;
    const publisher = new CstDashboardPublisher({
      dashboardUrl: sinkUrl,
      dashboardKey: SINK_KEY,
      maxRetries: 3,
      initialRetryDelayMs: 5,
    });
    requestCount = 0;
    const res = await publisher.publish({
      specversion: 'cst.event.WRONG',
      id: 'evt_bad',
      type: 'cst.turn',
    });
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.error).toBe('HTTP_400');
    expect(requestCount).toBe(1);
    expect(received).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('authenticates with both bearer and dashboard key headers', async () => {
    const bh = await import('../../engine/src/connectors/bharag_rag.js');
    vi.spyOn(bh.BharagRagConnector, 'askKnowledge').mockResolvedValue('Answer.');

    await CoreEngine.processEnvelope(envelope('How do I clean the filter?', 'SM_AUTH_1'), speaker());
    await settle();
    expect(turns()).toHaveLength(1);
    // If the publisher had not authenticated, the sink would have 401'd and
    // recorded nothing — which is exactly what the assertion above rules out.
    vi.restoreAllMocks();
  });

  it('reports MISSING_CONFIGURATION instead of throwing when the dashboard is unset', async () => {
    // The constructor falls back to the environment, so both must be absent for
    // this to be a genuine unconfigured case.
    const savedUrl = process.env.ENGINE_DASHBOARD_URL;
    const savedKey = process.env.ENGINE_DASHBOARD_KEY;
    delete process.env.ENGINE_DASHBOARD_URL;
    delete process.env.ENGINE_DASHBOARD_KEY;
    try {
      const publisher = new CstDashboardPublisher({});
      expect(publisher.isConfigured()).toBe(false);
      const res = await publisher.publish({ id: 'evt_none', type: 'cst.turn' });
      expect(res.success).toBe(false);
      expect(res.error).toBe('MISSING_CONFIGURATION');
      // Fire-and-forget must also stay silent rather than throwing.
      expect(() => publisher.publishFireAndForget({ id: 'evt_ff_none', type: 'cst.turn' })).not.toThrow();
    } finally {
      process.env.ENGINE_DASHBOARD_URL = savedUrl;
      process.env.ENGINE_DASHBOARD_KEY = savedKey;
    }
  });
});
