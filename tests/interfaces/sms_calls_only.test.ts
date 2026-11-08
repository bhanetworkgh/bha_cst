import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';
import { CALLS_ONLY_REPLY } from '../../engine/src/interfaces/sms/text_policy.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

// 971 texts are START, HELP and STOP only (8 Nov 2026). This file runs with the
// production default: agent replies off.
describe('971 texts: calls-only reply', () => {
  const app = createApp();
  const NUMBER = '+19715885823';
  let sent: SendSmsParams[];

  const text = (from: string, body: string, sid: string) =>
    request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({ MessageSid: sid, From: from, To: NUMBER, Body: body });
  const settle = () => new Promise((r) => setTimeout(r, 200));

  beforeEach(() => {
    vi.stubEnv('CST_SMS_AGENT_REPLIES', '');
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();
    sent = [];
    TwilioClientWrapper.setMockHandler(async (p: SendSmsParams) => {
      sent.push(p);
      return { sid: `SM_OUT_${sent.length}`, status: 'queued' };
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('answers an ordinary text with the fixed reply and never calls the Core Engine', async () => {
    const engine = vi.spyOn(CoreEngine, 'processEnvelope');
    const res = await text('+15550001111', 'Hi, is my farm okay?', 'SM_CO_1');
    expect(res.status).toBe(204);
    await settle();
    expect(engine).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('+15550001111');
    expect(sent[0].body).toBe(CALLS_ONLY_REPLY);
  });

  it('sends the fixed reply at most once a day to the same sender', async () => {
    await text('+15550002222', 'hello', 'SM_CO_2');
    await settle();
    await text('+15550002222', 'hello again', 'SM_CO_3');
    await settle();
    expect(sent.filter((m) => m.body === CALLS_ONLY_REPLY)).toHaveLength(1);
  });

  it('still answers HELP and STOP with their own replies', async () => {
    await text('+15550003333', 'HELP', 'SM_CO_4');
    await settle();
    expect(sent[0].body).toContain('Reply STOP to cancel');
    await text('+15550003333', 'STOP', 'SM_CO_5');
    await settle();
    expect(sent[1].body).toContain('You have been unsubscribed');
  });

  it('stays silent to a sender who has opted out', async () => {
    await text('+15550004444', 'STOP', 'SM_CO_6');
    await settle();
    const before = sent.length;
    await text('+15550004444', 'are you there?', 'SM_CO_7');
    await settle();
    expect(sent.length).toBe(before);
  });
});
