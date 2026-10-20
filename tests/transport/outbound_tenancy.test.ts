/**
 * Items 4, 5 and 9 — outbound SMS tenancy, delivery-callback tenancy/correlation,
 * and capability enforcement at send time.
 *
 * Chains under test:
 *   OutboundMessage.project_id -> service_number_binding -> phone_e164   (item 4)
 *   Twilio To -> service_number_binding -> tenant_id + project_id       (item 5)
 *   cst.delivery.turn_id === cst.turn.turn_id                           (item 5)
 *   project capability re-checked immediately before send               (item 9)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import {
  processOutboundQueue,
  resolveOutboundSendingNumber,
  isSmsCapabilityEnabled,
} from '../../engine/src/transport/twilio/outbound.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';
import { publishDelivery, resetMonotonicStore } from '../../engine/src/publishers/delivery.js';
import { dashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { CstDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import type { CstDeliveryEventV1, CstTurnEventV1 } from '../../engine/src/contracts/index.js';
import type { OutboundMessage } from '../../engine/src/transport/twilio/types.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const OTHER_PROJECT = 'proj-vfarm-dallas';
const DID_MAIN = '+19715885823';
const DID_DALLAS = '+19715550100';

describe('Item 4 — outbound sending DID resolves through project -> service_number_binding', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    TwilioClientWrapper.setMockHandler(null);
  });

  const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
    tenant_id: TENANT,
    project_id: PROJECT,
    to_e164: '+15551112222',
    body: 'hello',
    correlation_id: 'corr_1',
    ...over,
  });

  it('uses the number bound to the message project', () => {
    // The production seed only carries service numbers the Twilio account
    // actually owns, so a second project's DID is bound here as a fixture.
    CoreRegistry.bindServiceNumber({
      phone_e164: DID_DALLAS,
      tenant_id: TENANT,
      project_id: OTHER_PROJECT,
      capability: 'sms',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    expect(resolveOutboundSendingNumber(msg({ project_id: OTHER_PROJECT }))).toBe(DID_DALLAS);
    expect(resolveOutboundSendingNumber(msg())).toBe(DID_MAIN);
  });

  it('never picks "the first phone of the tenant" — the other project bound number is not used', () => {
    // SystemsRegistry still lists numbers for the tenant; none of them is
    // reachable without a project binding for THAT project.
    const vfarmSystem = SystemsRegistry.getSystemByTenantId(TENANT);
    expect(vfarmSystem?.phone_numbers.length).toBeGreaterThan(0);

    const unboundProject: OutboundMessage = msg({ project_id: 'proj-does-not-exist' });
    expect(resolveOutboundSendingNumber(unboundProject)).toBeNull();
  });

  it('refuses when the message carries no project at all (no binding can be authorized)', () => {
    expect(resolveOutboundSendingNumber(msg({ project_id: undefined }))).toBeNull();
  });

  it('refuses a queued from_e164 that is not bound to the same tenant+project', () => {
    // A message claiming it came from the Dallas DID while scoped to the Austin
    // project must not send from the Dallas number.
    expect(resolveOutboundSendingNumber(msg({ from_e164: DID_DALLAS }))).toBe(DID_MAIN);
  });

  it('accepts a queued from_e164 that IS bound to the same tenant+project', () => {
    const m = msg({ from_e164: DID_MAIN });
    expect(resolveOutboundSendingNumber(m)).toBe(DID_MAIN);
  });

  it('sends from the bound project number in the real queue worker', async () => {
    const sent: SendSmsParams[] = [];
    TwilioClientWrapper.setMockHandler(async (p) => {
      sent.push(p);
      return { sid: 'SM_BOUND_001', status: 'sent' };
    });

    await DbClient.saveOutboundMessage({ ...msg({ correlation_id: 'corr_bound' }), id: 'o1', consent_exempt: true });
    await processOutboundQueue();

    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe(DID_MAIN);
  });

  it('marks the message refused (with a reason) and never calls Twilio when no project is set', async () => {
    let calls = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      calls++;
      return { sid: 'SM_NO', status: 'sent' };
    });

    await DbClient.saveOutboundMessage({ ...msg({ project_id: undefined }), id: 'o2' });
    await processOutboundQueue();

    expect(calls).toBe(0);
    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'o2');
    expect(row?.status).toBe('refused');
    expect(row?.error_message).toContain('project_id');
  });
});

describe('Item 9 — capability is re-checked immediately before sending', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    TwilioClientWrapper.setMockHandler(null);
  });

  it('does not send a queued message when SMS was disabled after enqueue', async () => {
    let calls = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      calls++;
      return { sid: 'SM_SHOULD_NOT_SEND', status: 'sent' };
    });

    await DbClient.saveOutboundMessage({
      id: 'o_cap_1',
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+15551112222',
      body: 'queued earlier',
      correlation_id: 'corr_cap',
      status: 'pending',
    });

    // Operator disables SMS for the project while the message sits in the queue.
    const project = CoreRegistry.getProject(PROJECT)!;
    CoreRegistry.registerProject({ ...project, capabilities: { ...project.capabilities, sms: false } });

    expect(isSmsCapabilityEnabled({
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+1555',
      body: '',
      correlation_id: 'x',
    })).toBe(false);

    await processOutboundQueue();

    expect(calls).toBe(0);
    const row = DbClient.getAllMessagesOut().find((m) => m.id === 'o_cap_1');
    // Marked per the existing queue failure semantics for a refused send, with
    // the reason recorded on the row.
    expect(row?.status).toBe('refused');
    expect(row?.error_message).toContain('SMS capability is currently disabled');
  });

  it('still sends when the capability is enabled', async () => {
    let calls = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      calls++;
      return { sid: 'SM_CAP_OK', status: 'sent' };
    });

    await DbClient.saveOutboundMessage({
      id: 'o_cap_2',
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+15551112222',
      body: 'capability intact',
      correlation_id: 'corr_cap_ok',
      status: 'pending',
      consent_exempt: true,
    });
    await processOutboundQueue();

    expect(calls).toBe(1);
    expect(DbClient.getAllMessagesOut().find((m) => m.id === 'o_cap_2')?.status).toBe('sent');
  });

  it('refuses when the project is not known or belongs to another tenant', () => {
    expect(isSmsCapabilityEnabled({
      tenant_id: TENANT,
      project_id: 'proj-nope',
      to_e164: '+1',
      body: '',
      correlation_id: 'x',
    })).toBe(false);
    expect(isSmsCapabilityEnabled({
      tenant_id: 'tenant-other',
      project_id: PROJECT,
      to_e164: '+1',
      body: '',
      correlation_id: 'x',
    })).toBe(false);
  });
});

describe('Item 5 — Twilio delivery callback tenancy and turn correlation', () => {
  const app = createApp();
  let captured: any[] = [];

  beforeEach(() => {
    captured = [];
    resetMonotonicStore();
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    vi.spyOn(dashboardPublisher, 'publishFireAndForget').mockImplementation((e: any) => {
      captured.push(e);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  const callback = (body: Record<string, string>) =>
    request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send(body);

  async function seedOutbound(over: Partial<OutboundMessage> = {}) {
    const record = await DbClient.saveOutboundMessage({
      id: 'o_del',
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+15551112222',
      from_e164: DID_MAIN,
      body: 'reply body',
      correlation_id: 'SM_TURN_0001',
      turn_id: 'SM_TURN_0001',
      provider_sid: 'SM_DEL_0001',
      status: 'sent',
      ...over,
    });
    return record;
  }

  it('delivered: resolves tenant+project from the To binding and publishes a correlated event', async () => {
    await seedOutbound();
    const res = await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'delivered', To: DID_MAIN });
    expect(res.status).toBe(204);

    expect(captured).toHaveLength(1);
    const ev = captured[0] as CstDeliveryEventV1;
    expect(ev.type).toBe('cst.delivery');
    expect(ev.tenant_id).toBe(TENANT);
    expect(ev.project_id).toBe(PROJECT);
    expect(ev.project_id).not.toBe('');
    expect(ev.data.status).toBe('delivered');
    expect(ev.data.delivered_at).toBeTruthy();
    // cst.delivery.turn_id === cst.turn.turn_id for the same customer turn.
    expect(ev.data.turn_id).toBe('SM_TURN_0001');
    expect(ev.data.to).toBe('+15551112222');
    expect(ev.data.from).toBe(DID_MAIN);
    expect(DbClient.getAllMessagesOut()[0].status).toBe('delivered');
  });

  it('undelivered: publishes the failure status', async () => {
    await seedOutbound();
    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'undelivered', To: DID_MAIN });
    expect(captured).toHaveLength(1);
    expect(captured[0].data.status).toBe('undelivered');
    expect(captured[0].project_id).toBe(PROJECT);
  });

  it('failed: publishes the failure status with the Twilio error code', async () => {
    await seedOutbound();
    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'failed', ErrorCode: '30008', To: DID_MAIN });
    expect(captured).toHaveLength(1);
    expect(captured[0].data.status).toBe('failed');
    expect(captured[0].data.error_code).toBe('30008');
    expect(DbClient.getAllMessagesOut()[0].error_message).toContain('30008');
  });

  it('unknown DID: falls back to the stored row project and never publishes an empty project_id', async () => {
    await seedOutbound();
    // The receiving DID is not a bound service number, so there is no binding
    // to attribute the callback to. The stored outbound row still carries the
    // authoritative project, so the event stays attributable — but never empty.
    const res = await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'delivered', To: '+19998887777' });
    expect(res.status).toBe(204);

    for (const ev of captured) {
      expect(ev.project_id).toBeTruthy();
      expect(ev.project_id).not.toBe('');
    }
    expect(captured[0].project_id).toBe(PROJECT);
    expect(captured[0].tenant_id).toBe(TENANT);
  });

  it('publishes nothing at all when neither the binding nor the stored row resolves tenancy', async () => {
    const res = await callback({ MessageSid: 'SM_NEVER_SENT', MessageStatus: 'delivered', To: '+19998887777' });
    expect(res.status).toBe(204);
    expect(captured).toHaveLength(0);
  });

  it('publishes nothing when the stored row has no project either', async () => {
    // A legacy/unscoped row with no project and an unbound To number: the
    // callback is refused rather than published with project_id = ''.
    await DbClient.saveOutboundMessage({
      id: 'o_no_project',
      tenant_id: TENANT,
      to_e164: '+15551112222',
      body: 'legacy row',
      correlation_id: 'corr_legacy',
      provider_sid: 'SM_LEGACY_1',
      status: 'sent',
    });
    const res = await callback({ MessageSid: 'SM_LEGACY_1', MessageStatus: 'delivered', To: '+19998887777' });
    expect(res.status).toBe(204);
    expect(captured).toHaveLength(0);
  });

  it('falls back to the stored row project when the receiving DID is no longer bound', async () => {
    // The DID was unbound after the send, but the outbound row still carries the
    // authoritative project — the event stays attributable.
    await seedOutbound();
    CoreRegistry.unbindServiceNumber(DID_MAIN);

    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'delivered', To: DID_MAIN });
    expect(captured).toHaveLength(1);
    expect(captured[0].project_id).toBe(PROJECT);
    expect(captured[0].tenant_id).toBe(TENANT);
    expect(captured[0].data.turn_id).toBe('SM_TURN_0001');
  });

  it('the To binding wins over a conflicting stored row', async () => {
    // Trust model: the callback is Twilio-signature-verified, and the stored row
    // was itself written from a project binding at send time. So the stored row
    // is a safe fallback (covered above) — but when a binding for the actual
    // receiving number IS present, it is the current authority and must win, so
    // a reassigned number attributes to its new project rather than to the
    // project the message was originally sent from.
    await seedOutbound();
    CoreRegistry.unbindServiceNumber(DID_MAIN);
    CoreRegistry.bindServiceNumber({
      phone_e164: DID_MAIN,
      tenant_id: TENANT,
      project_id: 'proj-vfarm-dallas',
      capability: 'sms',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'delivered', To: DID_MAIN });
    expect(captured).toHaveLength(1);
    expect(captured[0].project_id).toBe('proj-vfarm-dallas');
    // The turn_id join key still comes from the stored row, which is the only
    // place the originating cst.turn id exists.
    expect(captured[0].data.turn_id).toBe('SM_TURN_0001');
  });

  it('duplicate delivery callbacks do not emit a second event', async () => {
    await seedOutbound();
    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'delivered', To: DID_MAIN });
    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'delivered', To: DID_MAIN });
    expect(captured).toHaveLength(1);
  });

  it('delivery state never moves backwards', async () => {
    await seedOutbound();
    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'delivered', To: DID_MAIN });
    expect(captured[0].data.status).toBe('delivered');

    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'sent', To: DID_MAIN });
    await callback({ MessageSid: 'SM_DEL_0001', MessageStatus: 'failed', ErrorCode: '30008', To: DID_MAIN });

    expect(captured).toHaveLength(1);
    expect(DbClient.getAllMessagesOut()[0].status).toBe('delivered');
  });

  it('publishDelivery itself refuses to emit an event with an empty project_id', () => {
    publishDelivery({
      providerSid: 'SM_EMPTY_PROJ',
      channel: 'sms',
      to: '+15551112222',
      status: 'delivered',
      tenantId: TENANT,
      projectId: '',
      correlationId: 'corr_empty',
    });
    expect(captured).toHaveLength(0);
  });
});

describe('Item 5/6 — cst.turn and cst.delivery share the same turn_id end to end', () => {
  const app = createApp();
  let turnEvents: CstTurnEventV1[] = [];
  let deliveryEvents: any[] = [];

  beforeEach(() => {
    turnEvents = [];
    deliveryEvents = [];
    resetMonotonicStore();
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    CoreRegistry.registerTenant(
      {
        tenant_id: TENANT,
        name: 't',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
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

    const publisher = new CstDashboardPublisher({ dashboardUrl: 'https://d.internal/e', dashboardKey: 'k' });
    vi.spyOn(publisher, 'publishFireAndForget').mockImplementation((e: any) => {
      if (e.type === 'cst.turn') turnEvents.push(e as CstTurnEventV1);
      else deliveryEvents.push(e);
    });
    CoreEngine.setDashboardPublisher(publisher);
  });

  afterEach(() => {
    CoreEngine.setDashboardPublisher(null);
    vi.restoreAllMocks();
    resetMonotonicStore();
  });

  it('the delivery event emitted by the queue worker joins to the cst.turn by turn_id', async () => {
    TwilioClientWrapper.setMockHandler(async () => ({ sid: 'SM_CORR_1', status: 'sent' }));

    const { CoreEngine: Engine } = await import('../../engine/src/core/engine.js');
    const { default: _ } = { default: null as any };

    // Drive a real turn so a cst.turn is published.
    const res = await Engine.processEnvelope(
      {
        tenant_id: TENANT,
        project_id: PROJECT,
        channel: 'sms',
        speaker_ref: '+15559990001',
        text: 'what is my farm status',
        media: [],
        correlation_id: 'SM_CORR_1',
      },
      {
        person_id: 'usr_1',
        customer_ref: 'cust_1',
        tenant_id: TENANT,
        project_id: PROJECT,
        phone_e164: '+15559990001',
        is_known: true,
        role: 'owner',
        permissions: [],
        farm_ids: ['farm_a'],
      }
    );
    expect(res).toBeTruthy();
    expect(turnEvents).toHaveLength(1);
    const turnId = turnEvents[0].data.turn_id;

    // Now the outbound reply for that same turn goes through the queue worker.
    await DbClient.saveOutboundMessage({
      id: 'o_corr',
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+15559990001',
      body: res.reply_text,
      correlation_id: turnId,
      turn_id: turnId,
      status: 'pending',
      consent_exempt: true,
    });

    const delivered: any[] = [];
    const publisher = new CstDashboardPublisher({ dashboardUrl: 'https://d.internal/e', dashboardKey: 'k' });
    vi.spyOn(publisher, 'publishFireAndForget').mockImplementation((e: any) => {
      if (e.type === 'cst.delivery') delivered.push(e);
    });
    // Spy on the publisher the engine is actually configured to use. Both the
    // cst.turn path (CoreEngine) and the cst.delivery path (publishDelivery)
    // resolve through this one seam, so spying anywhere else would capture only
    // half the events.
    vi.spyOn(CoreEngine.getDashboardPublisher(), 'publishFireAndForget').mockImplementation((e: any) => {
      if (e.type === 'cst.delivery') delivered.push(e);
    });

    await processOutboundQueue();
    expect(delivered.length).toBeGreaterThan(0);
    const sentEvent = delivered.find((e) => e.data.status === 'sent');
    expect(sentEvent.data.turn_id).toBe(turnId);
    expect(sentEvent.project_id).toBe(PROJECT);

    // And the Twilio callback for the same message keeps the join key.
    const row = DbClient.getAllMessagesOut()[0];
    await DbClient.updateOutboundProviderSid(row.id!, 'SM_CORR_1');
    await request(app)
      .post('/webhooks/twilio/delivery-status')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({ MessageSid: 'SM_CORR_1', MessageStatus: 'delivered', To: DID_MAIN });

    const deliveredEvent = delivered.find((e) => e.data.status === 'delivered');
    expect(deliveredEvent.data.turn_id).toBe(turnId);
    expect(deliveredEvent.data.turn_id).toBe(turnEvents[0].data.turn_id);
  }, 30_000);
});
