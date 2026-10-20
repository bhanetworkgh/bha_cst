/**
 * Regression tests for SMS and voice routing, and for the misleading
 * "Unknown receiving phone number" warning.
 *
 * TWO DISTINCT RESOLUTIONS
 *   A. RECEIVING-NUMBER ROUTING — "which tenant/project does this inbound
 *      number belong to?" Resolved from the durable `service_number_bindings`
 *      registry. An unbound number is refused fail-closed.
 *   B. SENDER IDENTITY RESOLUTION — "who is this caller?" Resolved from the
 *      admin-managed phone -> identity directory, then re-verified against
 *      vFarm upstream. These are separate and must stay separate: the
 *      receiving number identifies the SYSTEM, the sender identifies the
 *      CUSTOMER.
 *
 * THE MISLEADING WARNING
 *   `SystemsRegistry.resolveSystemByPhoneNumber` is used both as a positive
 *   resolution (A) and as a negative cross-tenant probe. For the negative
 *   probe a miss is the NORMAL case — a customer's own phone is not a CST
 *   system number — but it was reported at WARN level with a tripwire audit
 *   entry, so an ordinary outbound reply to a customer looked like a routing
 *   failure ("Unknown receiving phone number <customer number>").
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { Logger } from '../../engine/src/config/logger.js';

const CST_SMS_DID = '+19715885823';
const CST_VOICE_DID = '+19715885826';
const CUSTOMER = '+923082113844';

describe('SMS and voice routing', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    vi.restoreAllMocks();

    CoreRegistry.bindServiceNumber({
      phone_e164: CST_SMS_DID,
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'sms_voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });
    CoreRegistry.bindServiceNumber({
      phone_e134: undefined,
      phone_e164: CST_VOICE_DID,
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    } as any);
  });

  // ── A. Receiving-number routing (fail-closed) ────────────────────────────

  it('refuses an inbound SMS addressed to an unbound receiving number', async () => {
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({ MessageSid: 'SM_unknown', From: CUSTOMER, To: '+19990000000', Body: 'status' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SYSTEM_NOT_FOUND');
  });

  it('routes an inbound SMS on a bound receiving number to the right tenant/project', async () => {
    const auditSpy = vi.spyOn(Logger, 'audit');
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({ MessageSid: 'SM_bound', From: CUSTOMER, To: CST_SMS_DID, Body: 'status' });

    // The receiving number resolved, so the request was NOT refused as
    // "unknown receiving number" and NOT refused as a capability failure.
    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const unknownReceiving = entries.find((e) =>
      String(e?.reason ?? '').includes('Unknown or unbound receiving service number'),
    );
    expect(unknownReceiving).toBeUndefined();
    // 204: the inbound message is accepted and the reply is dispatched
    // asynchronously through the outbound queue.
    expect(res.status).toBe(204);

    // And the resolved tenancy is the bound one, not a guess.
    const stored = DbClient.getAllMessagesIn();
    const inbound = stored.find((m: any) => m.message_id === 'SM_bound');
    expect(inbound).toBeDefined();
    expect(inbound!.tenant_id).toBe('tenant-vfarm-01');
    expect((inbound as any).project_id).toBe('proj-vfarm-main');
  });

  it('refuses an inbound SMS on a number bound for voice only', async () => {
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({ MessageSid: 'SM_voiceonly', From: CUSTOMER, To: CST_VOICE_DID, Body: 'status' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CAPABILITY_DISABLED');
  });

  it('accepts an inbound SMS on a number bound with the combined sms_voice capability', async () => {
    const auditSpy = vi.spyOn(Logger, 'audit');
    const res = await request(app)
      .post('/webhooks/twilio/sms')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({ MessageSid: 'SM_combined', From: CUSTOMER, To: CST_SMS_DID, Body: 'status' });

    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const capabilityRefusal = entries.find((e) =>
      String(e?.reason ?? '').includes('not "sms"'),
    );
    expect(capabilityRefusal).toBeUndefined();
    expect(res.status).not.toBe(404);
  });

  // ── B. The misleading warning ────────────────────────────────────────────

  it('does not report an unknown receiving number for a negative cross-tenant probe', () => {
    const auditSpy = vi.spyOn(Logger, 'audit');

    // A customer destination is not a CST system number. The negative probe
    // must return null WITHOUT writing a tripwire refusal entry.
    const result = SystemsRegistry.resolveSystemByPhoneNumber(CUSTOMER, { required: false });

    expect(result).toBeNull();
    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const warned = entries.find((e) => String(e?.reason ?? '').includes('Unknown receiving phone number'));
    expect(warned).toBeUndefined();
  });

  it('still reports an unknown receiving number for a positive resolution', () => {
    const auditSpy = vi.spyOn(Logger, 'audit');

    const result = SystemsRegistry.resolveSystemByPhoneNumber(CUSTOMER);

    expect(result).toBeNull();
    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const warned = entries.find((e) => String(e?.reason ?? '').includes('Unknown receiving phone number'));
    expect(warned).toBeDefined();
    expect(warned.outcome).toBe('refused');
  });
});
