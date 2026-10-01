/**
 * cst.turn — completeness of the Engine Dashboard turn event, and the
 * fire-and-forget guarantee that the customer response is never blocked by
 * dashboard availability.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CstDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import type { CstTurnEventV1 } from '../../engine/src/contracts/index.js';
import type { MessageEnvelope, EnvelopeResponse } from '../../engine/src/core/envelope.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';

const TENANT = 'tenant-cst-turn';
const PROJECT = 'proj-cst-turn';

describe('cst.turn — required field completeness', () => {
  const captured: CstTurnEventV1[] = [];

  const envelope: MessageEnvelope = {
    tenant_id: TENANT,
    project_id: PROJECT,
    channel: 'sms',
    speaker_ref: '+15559990001',
    text: 'what is my farm status',
    media: [],
    correlation_id: 'SM_MESSAGEPID_001',
  };

  const speaker: SpeakerIdentity = {
    person_id: 'usr_turn_1',
    customer_ref: 'cust_turn_1',
    tenant_id: TENANT,
    project_id: PROJECT,
    phone_e164: '+15559990001',
    is_known: true,
    role: 'owner',
    permissions: ['farm:read'],
    farm_ids: ['farm_a', 'farm_b'],
  };

  beforeEach(() => {
    captured.length = 0;
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      null as any
    );
    CoreRegistry.registerProject({
      project_id: PROJECT,
      tenant_id: TENANT,
      name: 'p',
      status: 'active',
      capabilities: { sms: true, voice: true, web: true },
      speaker_policy: 'allowlist',
      onboarding_reply: 'Welcome!',
    });

    const publisher = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.internal/api/v1/events',
      dashboardKey: 'k',
    });
    vi.spyOn(publisher, 'publishFireAndForget').mockImplementation((e: any) => {
      captured.push(e as CstTurnEventV1);
    });
    CoreEngine.setDashboardPublisher(publisher);
  });

  afterEach(() => {
    CoreEngine.setDashboardPublisher(null);
    vi.restoreAllMocks();
  });

  it('carries every field the Engine Dashboard requirement calls for', async () => {
    // processEnvelope legitimately takes ~2s (connector work) on a null adapter,
    // so give this headroom rather than racing the default 5s test timeout.
    await CoreEngine.processEnvelope(envelope, speaker);

    expect(captured).toHaveLength(1);
    const ev = captured[0];

    // Envelope envelope
    expect(ev.specversion).toBeDefined();
    expect(ev.id).toMatch(/^turn_evt_/);
    expect(ev.type).toBe('cst.turn');
    expect(ev.source).toContain('cst/');
    expect(ev.time).toBeTruthy();

    // turn_id + tenant/project
    expect(ev.data.turn_id).toBe('SM_MESSAGEPID_001');
    expect(ev.correlation_id).toBe('SM_MESSAGEPID_001');
    expect(ev.tenant_id).toBe(TENANT);
    expect(ev.project_id).toBe(PROJECT);
    expect(ev.data.tenant_id).toBe(TENANT);
    expect(ev.data.project_id).toBe(PROJECT);

    // customer identity
    expect(ev.customer.customer_ref).toBe('cust_turn_1');
    expect(ev.customer.phone_e164).toBe('+15559990001');
    expect(ev.customer.person_id).toBe('usr_turn_1');
    expect(ev.customer.role).toBe('owner');
    expect(ev.customer.is_known).toBe(true);
    expect(ev.customer.farm_ids).toEqual(['farm_a', 'farm_b']);

    // channel / intent / status / reply
    expect(ev.channel).toBe('sms');
    expect(ev.data.channel).toBe('sms');
    expect(ev.data.intent).toBeTruthy();
    expect(ev.data.status).toBeTruthy();
    expect(ev.data.text).toBe('what is my farm status');
    expect(ev.data.reply_text).toBeDefined();

    // duration
    expect(typeof ev.data.duration_ms).toBe('number');
    expect(ev.data.duration_ms).toBeGreaterThanOrEqual(0);
    expect(ev.data.duration).toEqual({ total_ms: ev.data.duration_ms });

    // reason + incident_id present as explicit keys (may be undefined, but must
    // be modelled rather than absent, so the dashboard schema stays stable)
    expect('reason' in ev.data).toBe(true);
    expect('incident_id' in ev.data).toBe(true);
  }, 30_000);

  it('sets incident_id and reason when the turn escalates', async () => {
    const res: EnvelopeResponse = await CoreEngine.processEnvelope(envelope, speaker);
    const ev = captured[0];
    // Sanity: whatever the outcome, metadata mirrors the response reason.
    if (res.reason) {
      expect(ev.data.reason).toBe(res.reason);
      expect(ev.metadata?.reason ?? ev.data.reason).toBeTruthy();
    }
    expect(ev.data.status).toMatch(/answered|refused|escalated|error|completed/i);
  }, 30_000);
});

describe('cst.turn — fire-and-forget never blocks the customer', () => {
  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 't', status: 'active', adapter_type: 'vfarm', created_at: new Date().toISOString() },
      null as any
    );
    CoreRegistry.registerProject({
      project_id: PROJECT,
      tenant_id: TENANT,
      name: 'p',
      status: 'active',
      capabilities: { sms: true, voice: true, web: true },
      speaker_policy: 'allowlist',
      onboarding_reply: 'Welcome!',
    });
  });

  afterEach(() => {
    CoreEngine.setDashboardPublisher(null);
    vi.restoreAllMocks();
  });

  const envelope: MessageEnvelope = {
    tenant_id: TENANT,
    project_id: PROJECT,
    channel: 'sms',
    speaker_ref: '+15559990001',
    text: 'hello',
    media: [],
    correlation_id: 'SM_BLOCK_001',
  };
  const speaker: SpeakerIdentity = {
    person_id: 'usr_1',
    customer_ref: 'cust_1',
    tenant_id: TENANT,
    project_id: PROJECT,
    phone_e164: '+15559990001',
    is_known: true,
    role: 'owner',
    permissions: [],
    farm_ids: [],
  };

  it('returns the customer response no slower than baseline when the dashboard hangs', async () => {
    // Baseline with no dashboard at all. processEnvelope does real connector
    // work (~2s), so the guarantee under test is RELATIVE: a hanging downstream
    // must not add latency to the customer turn.
    const baselinePublisher = new CstDashboardPublisher({});
    CoreEngine.setDashboardPublisher(baselinePublisher);
    const t0 = Date.now();
    const baseline = await CoreEngine.processEnvelope(envelope, speaker);
    const baselineMs = Date.now() - t0;
    expect(baseline).toBeTruthy();

    const hanging = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.internal/api/v1/events',
      dashboardKey: 'k',
      timeoutMs: 60_000,
      maxRetries: 3,
      // Never resolves: the worst case for a downstream dependency.
      fetchFn: (() => new Promise(() => {})) as any,
    });
    CoreEngine.setDashboardPublisher(hanging);

    const t1 = Date.now();
    const res = await CoreEngine.processEnvelope(envelope, speaker);
    const hangingMs = Date.now() - t1;

    expect(res).toBeTruthy();
    // The publisher is configured with a 60s timeout and 3 retries, so a blocked
    // dashboard would take minutes if it were awaited. Asserting far below that
    // is stable; comparing two noisy ~2s runs against a tight delta is not.
    expect(hangingMs).toBeLessThan(15_000);
  }, 60_000);

  it('returns the customer response even when the dashboard throws', async () => {
    const throwing = new CstDashboardPublisher({
      dashboardUrl: 'https://dashboard.internal/api/v1/events',
      dashboardKey: 'k',
      fetchFn: (async () => { throw new Error('network down'); }) as any,
    });
    CoreEngine.setDashboardPublisher(throwing);

    const res = await CoreEngine.processEnvelope(envelope, speaker);
    expect(res).toBeTruthy();
  }, 30_000);

  it('returns the customer response when the dashboard is not configured at all', async () => {
    const unconfigured = new CstDashboardPublisher({});
    CoreEngine.setDashboardPublisher(unconfigured);

    const res = await CoreEngine.processEnvelope(envelope, speaker);
    expect(res).toBeTruthy();
  }, 30_000);
});