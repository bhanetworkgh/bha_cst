import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';
import { TextLogPoster, buildTextLogMessage } from '../../engine/src/notifications/text_log.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('CST text alert card', () => {
  it('masks the sender, escapes their text and says what happened', () => {
    const { text, blocks } = buildTextLogMessage({
      from_e164: '+15550001111', to_e164: '+19715885823', body: 'Hi <!channel> & you', message_sid: 'SM1', outcome: 'calls_only_sent',
    });
    const json = JSON.stringify(blocks);
    expect(blocks[0].type).toBe('header');
    expect(json).not.toContain('+15550001111');
    expect(json).toContain('&lt;!channel&gt; &amp; you');
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('Calls-only reply sent');
    expect(text).not.toContain('<!channel>');
  });
});

describe('every text on 971 posts one alert with its outcome', () => {
  const app = createApp();
  let cards: { channel: string; text: string; blocks: any[] }[];
  const text = (from: string, body: string, sid: string) =>
    request(app).post('/webhooks/twilio/sms').set('x-test-bypass-signature', 'true').type('form')
      .send({ MessageSid: sid, From: from, To: '+19715885823', Body: body });
  const settle = () => new Promise((r) => setTimeout(r, 200));

  beforeEach(() => {
    vi.stubEnv('CST_SMS_AGENT_REPLIES', '');
    vi.stubEnv('CST_SMS_KEYWORD_REPLIES', '');
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();
    cards = [];
    TextLogPoster.mockHandler = async (m) => { cards.push(m); return { ok: true, ts: '1.1' }; };
    TwilioClientWrapper.setMockHandler(async () => ({ sid: 'SM_OUT', status: 'queued' }));
  });
  afterEach(() => {
    TextLogPoster.mockHandler = null;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('alerts for a normal text, a repeat, HELP, STOP and a text after STOP', async () => {
    const from = '+15550007777';
    for (const [body, sid] of [['hello', 'A1'], ['again', 'A2'], ['HELP', 'A3'], ['STOP', 'A4'], ['still there?', 'A5']]) {
      await text(from, body, sid);
      await settle();
    }
    const said = cards.map((c) => JSON.stringify(c.blocks));
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.channel === 'C0BD6D53HAM')).toBe(true);
    expect(said[0]).toContain('Calls-only reply sent');
    expect(said[1]).toContain('already got the calls-only reply today');
    expect(said[2]).toContain('approved HELP reply');
    expect(said[3]).toContain('Opt-out recorded');
    expect(said[4]).toContain('has opted out');
  });

  it('START after STOP opts the sender back in, so their next text gets the calls-only reply', async () => {
    const from = '+15550009999';
    for (const [body, sid] of [['STOP', 'C1'], ['START', 'C2'], ['hello', 'C3']]) {
      await text(from, body, sid);
      await settle();
    }
    const said = cards.map((c) => JSON.stringify(c.blocks));
    expect(said[1]).toContain('Opt-in recorded');
    expect(said[2]).toContain('Calls-only reply sent');
  });

  it('answers HELP, STOP and START itself for a sender outside +1, with Twilio wording', async () => {
    const sent: any[] = [];
    TwilioClientWrapper.setMockHandler(async (p: any) => { sent.push(p); return { sid: `SM_O_${sent.length}`, status: 'queued' }; });
    const from = '+2348000000001';
    for (const [body, sid] of [['HELP', 'D1'], ['STOP', 'D2'], ['START', 'D3']]) {
      await text(from, body, sid);
      await settle();
    }
    expect(sent.map((m) => m.body)).toEqual([
      expect.stringContaining('Bays Horizon Network (vFarm) support'),
      expect.stringContaining("you're unsubscribed"),
      expect.stringContaining("you're subscribed again"),
    ]);
    const said = cards.map((c) => JSON.stringify(c.blocks));
    expect(said[0]).toContain('Answered by the CST service');
    expect(said[2]).toContain('Opt-in recorded and confirmed by the CST service');
  });

  it('leaves keyword replies to Twilio for a +1 sender', async () => {
    const sent: any[] = [];
    TwilioClientWrapper.setMockHandler(async (p: any) => { sent.push(p); return { sid: 'SM_X', status: 'queued' }; });
    await text('+15550004321', 'HELP', 'E1');
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('raises a card that Slack refuses instead of dropping it', async () => {
    TextLogPoster.mockHandler = async () => ({ ok: false, error: 'not_in_channel' });
    const r = await TextLogPoster.post({ from_e164: '+15550008888', to_e164: '+19715885823', body: 'hi', message_sid: 'B1', outcome: 'calls_only_sent' });
    expect(r.posted).toBe(false);
    expect(r.error).toContain('not_in_channel');
  });
});
