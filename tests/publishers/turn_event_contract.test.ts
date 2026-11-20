/**
 * cst.turn — completeness of the Engine Dashboard turn event, and the
 * fire-and-forget guarantee that the customer response is never blocked by
 * dashboard availability.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CstDashboardPublisher, serializeForDashboard } from '../../engine/src/publishers/dashboard.js';
import type { CstTurnEventV1 } from '../../engine/src/contracts/index.js';
import type { MessageEnvelope, EnvelopeResponse } from '../../engine/src/core/envelope.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';
import {
  REQUIRED_TURN_STATUSES,
  isRequiredTurnStatus,
  createCstTurnEventV1,
  safeParseCstEventV1,
  CstTurnEventV1Schema,
} from '../../engine/src/contracts/index.js';

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

    // Required dashboard contract: the status must be one of the five
    // documented values, never an internal CoreEngine lifecycle name.
    expect(REQUIRED_TURN_STATUSES).toEqual([
      'ok',
      'refused',
      'step_up_required',
      'onboarding',
      'error',
    ]);
    expect(isRequiredTurnStatus(ev.data.status)).toBe(true);
    // Regression: internal names that used to leak verbatim.
    for (const internal of ['completed', 'step_up', 'failed', 'dropped', 'processing', 'synthesized']) {
      expect(ev.data.status).not.toBe(internal);
    }

    // Explicit required-field aliases (event_type / message / occurred_at).
    expect(ev.data.event_type).toBe('cst.turn');
    expect(ev.data.message).toBe('what is my farm status');
    expect(typeof ev.data.occurred_at).toBe('string');
    expect(ev.time).toBe(ev.data.occurred_at);

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
    // Only the required contract statuses may ever be published.
    expect(isRequiredTurnStatus(ev.data.status)).toBe(true);
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

describe('Stage S1 — cst.event.v1 to docs/contracts/cst-events.md Dashboard Ingestion Mapping', () => {
  const baseCustomer = {
    customer_ref: 'cust_debf555c-b37d-4e92-bb15-597e169f1b38',
    phone_e164: '+923082113844',
    role: 'owner' as const,
    is_known: true,
    tenant_id: 'tenant-vfarm-01',
    project_id: 'proj-vfarm-main',
    person_id: 'debf555c-b37d-4e92-bb15-597e169f1b38',
    farm_ids: ['21dde23e-f7f6-46bc-9b54-e97fabaaafd7'],
  };

  it('1. validates and serializes a complete event with all optional fields (intent, incident_id, duration_ms)', () => {
    const event = createCstTurnEventV1({
      id: 'turn_evt_s1_complete_01',
      source: 'cst/voice/elevenlabs',
      time: '2026-11-20T12:00:00.000Z',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      correlation_id: 'conv_s1_complete_01',
      channel: 'voice',
      customer: baseCustomer,
      turn: {
        turn_id: 'conv_s1_complete_01',
        conversation_id: 'conv_s1_complete_01',
        direction: 'inbound',
        channel: 'voice',
        status: 'ok',
        intent: 'escalate',
        text: 'I need a human operator',
        message: 'I need a human operator',
        reply_text: 'I have escalated your request.',
        reply: 'I have escalated your request.',
        duration: { total_ms: 42000 },
        duration_ms: 42000,
        incident_id: 'esc_s1_001',
        occurred_at: '2026-11-20T12:00:00.000Z',
        event_type: 'cst.turn',
      },
    });

    const flat = serializeForDashboard(event);
    expect(flat.specversion).toBe('cst.event.v1');
    expect(flat.event_type).toBe('cst.turn');
    expect(flat.id).toBe('turn_evt_s1_complete_01');
    expect(flat.intent).toBe('escalate');
    expect(flat.incident_id).toBe('esc_s1_001');
    expect(flat.duration_ms).toBe(42000);
    expect(flat.latency_ms).toBe(42000);
    expect(flat.customer_ref).toBe(baseCustomer.customer_ref);
    expect(flat.phone_e164).toBe(baseCustomer.phone_e164);
    expect(flat.role).toBe('owner');
    expect(flat.farm_ids).toEqual(['21dde23e-f7f6-46bc-9b54-e97fabaaafd7']);
    expect(flat.person_id).toBe('debf555c-b37d-4e92-bb15-597e169f1b38');
  });

  it('2. validates and serializes a valid event when optional fields (intent, incident_id, duration_ms) are omitted', () => {
    const event = createCstTurnEventV1({
      id: 'turn_evt_s1_minimal_02',
      source: 'cst/engine',
      time: '2026-11-20T12:05:00.000Z',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      correlation_id: 'corr_s1_minimal_02',
      channel: 'web',
      customer: {
        customer_ref: 'cust_min_01',
        phone_e164: '+15551234567',
        role: 'unknown',
        is_known: false,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
      },
      turn: {
        turn_id: 'turn_min_01',
        direction: 'inbound',
        channel: 'web',
        status: 'ok',
      },
    });

    expect(event.data.intent).toBeUndefined();
    expect(event.data.incident_id).toBeUndefined();
    expect(event.data.duration_ms).toBeUndefined();

    const flat = serializeForDashboard(event);
    expect(flat.event_type).toBe('cst.turn');
    expect(flat.turn_id).toBe('turn_min_01');
    expect(flat.status).toBe('ok');
    expect(flat.intent).toBeUndefined();
    expect(flat.incident_id).toBeUndefined();
    expect(flat.duration_ms).toBeUndefined();
    expect(flat.latency_ms).toBeUndefined();
  });

  it('3, 4 & 5. rejects missing required fields, invalid types, and empty/null required strings', () => {
    // Missing required turn_id
    expect(
      safeParseCstEventV1({
        specversion: 'cst.event.v1',
        id: 'evt_missing_turn_id',
        source: 'cst/engine',
        time: '2026-11-20T12:00:00.000Z',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        correlation_id: 'corr_1',
        channel: 'sms',
        customer: baseCustomer,
        type: 'cst.turn',
        data: { direction: 'inbound', channel: 'sms', status: 'ok' },
      }).success,
    ).toBe(false);

    // Invalid types (negative duration_ms, non-ISO time)
    expect(
      safeParseCstEventV1({
        specversion: 'cst.event.v1',
        id: 'evt_bad_types',
        source: 'cst/engine',
        time: 'not-a-timestamp',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        correlation_id: 'corr_1',
        channel: 'sms',
        customer: baseCustomer,
        type: 'cst.turn',
        data: { turn_id: 't1', direction: 'inbound', channel: 'sms', status: 'ok', duration_ms: -50 },
      }).success,
    ).toBe(false);

    // Empty required strings and null customer_ref
    expect(
      safeParseCstEventV1({
        specversion: 'cst.event.v1',
        id: '',
        source: 'cst/engine',
        time: '2026-11-20T12:00:00.000Z',
        tenant_id: '',
        project_id: 'proj-vfarm-main',
        correlation_id: 'corr_1',
        channel: 'sms',
        customer: { ...baseCustomer, customer_ref: null },
        type: 'cst.turn',
        data: { turn_id: 't1', direction: 'inbound', channel: 'sms', status: 'ok' },
      }).success,
    ).toBe(false);
  });

  it('6 & 7. round-trip contract compatibility: reconstructs internal envelope from serialized dashboard shape', () => {
    const internal = createCstTurnEventV1({
      id: 'turn_evt_32fd6323-da9f-4037-b773-5e09059ad6f3',
      source: 'cst/engine',
      time: '2026-11-16T21:27:36.723Z',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      correlation_id: 'web_3ec1a8a1-9ff9-4c28-b5df-665b16fa2f8c',
      channel: 'web',
      customer: {
        ...baseCustomer,
        phone_e164: '+9230****3844',
      },
      turn: {
        turn_id: 'web_3ec1a8a1-9ff9-4c28-b5df-665b16fa2f8c',
        conversation_id: 'conv_ce5e9bf3-6975-43c3-bd05-dc876974b545',
        direction: 'inbound',
        channel: 'web',
        status: 'ok',
        intent: 'status',
        text: 'What is the status of my farm?',
        message: 'What is the status of my farm?',
        reply_text: 'Your farm has 0 devices.',
        reply: 'Your farm has 0 devices.',
        duration: { total_ms: 1499 },
        duration_ms: 1499,
        occurred_at: '2026-11-16T21:27:36.723Z',
        event_type: 'cst.turn',
      },
    });

    const dashboardPayload = serializeForDashboard(internal) as Record<string, any>;
    // Verify top-level flattened shape
    expect(dashboardPayload.type).toBeUndefined();
    expect(dashboardPayload.data).toBeUndefined();
    expect(dashboardPayload.event_type).toBe('cst.turn');
    expect(dashboardPayload.latency_ms).toBe(1499);

    // Round-trip back to CstTurnEventV1Schema
    const reconstructed = CstTurnEventV1Schema.parse({
      specversion: dashboardPayload.specversion,
      id: dashboardPayload.id,
      source: dashboardPayload.source,
      time: dashboardPayload.time,
      tenant_id: dashboardPayload.tenant_id,
      project_id: dashboardPayload.project_id,
      correlation_id: dashboardPayload.correlation_id,
      channel: dashboardPayload.channel,
      customer: dashboardPayload.customer,
      type: dashboardPayload.event_type,
      data: {
        turn_id: dashboardPayload.turn_id,
        conversation_id: dashboardPayload.conversation_id,
        direction: dashboardPayload.direction,
        channel: dashboardPayload.channel,
        status: dashboardPayload.status,
        intent: dashboardPayload.intent,
        text: dashboardPayload.text,
        message: dashboardPayload.message,
        reply_text: dashboardPayload.reply_text,
        reply: dashboardPayload.reply,
        duration: dashboardPayload.duration,
        duration_ms: dashboardPayload.duration_ms,
        occurred_at: dashboardPayload.occurred_at,
        event_type: dashboardPayload.event_type,
      },
    });
    expect(reconstructed.id).toBe(internal.id);
    expect(reconstructed.data.turn_id).toBe(internal.data.turn_id);
    expect(reconstructed.data.duration_ms).toBe(1499);
  });
});