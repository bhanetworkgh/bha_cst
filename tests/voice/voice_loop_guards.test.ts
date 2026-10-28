import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';
import { generateTwilioSignature } from '../../engine/src/transport/twilio/signature.js';

/**
 * Regression: a caller must never hear the same sentence over and over.
 *
 * Covers the three repeat loops found on live calls:
 *   1. Unregistered (guest) callers were answered with the generic onboarding text on
 *      every turn - the same text they had just heard as the call greeting.
 *   2. Empty / silent turns replayed the identical "did not catch that" prompt forever.
 *   3. A failed identity lookup (degraded adapter) was spoken as raw internal text
 *      ("Tenant adapter unavailable (degraded state)") and re-listened on every turn;
 *      a REGISTERED caller whose lookup failed was treated as a guest.
 */
describe('Voice loop guards (no endless repeated prompts)', () => {
  const app = createApp();
  const authToken = process.env.TWILIO_AUTH_TOKEN || 'test_auth_token_for_jest_suite_32chars';
  const baseUrl = 'http://localhost:3000';
  const TURN = '/webhooks/twilio/voice/turn';

  const GUEST = '+15559876543'; // not registered anywhere
  const MANAGER = '+15551234567'; // registered manager in the default vFarm adapter
  const VOICE_DID = '+19715885826';

  const mockSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async ({ text, voiceId }) => ({
      audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
      mimeType: 'audio/mpeg',
    })),
  };

  beforeEach(() => {

  // The programmatic voice API is guarded by a shared secret. This suite

  // exercises it, so it must configure the secret itself rather than

  // depending on another file leaving it set.

  process.env.CST_API_KEY = 'test_programmatic_api_key_32_chars_long';
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    VoiceInterface.setSynthesizer(mockSynthesizer);
    vi.clearAllMocks();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: 'normal', farm_id: 'farm_austin_main' }),
    } as Response));

    CoreRegistry.bindServiceNumber({
      phone_e164: VOICE_DID,
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function twilioTurn(path: string, payload: Record<string, string>) {
    return request(app)
      .post(path)
      .set('Host', 'localhost:3000')
      .set('User-Agent', 'TwilioProxy/1.1')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send(payload);
  }

  const turnPayload = (from: string, speech: string, sid = 'CA_LOOP_001') => ({
    CallSid: sid,
    From: from,
    To: VOICE_DID,
    SpeechResult: speech,
    CallStatus: 'in-progress',
  });

  // ── 1. Guest callers ───────────────────────────────────────────────────────
  describe('1. Unregistered caller is not answered with the same onboarding text every turn', () => {
    it('first guest turn: speaks a distinct "not registered" message, keeps the call alive, and arms the guest counter', async () => {
      const res = await twilioTurn(TURN, turnPayload(GUEST, 'Hello, can you help me?'));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/xml');
      expect(res.text).toContain('this number is not registered yet');
      // Must NOT replay the project's generic greeting text.
      expect(res.text).not.toContain('Welcome to vFarm Support');
      expect(res.text).toContain(`action="${TURN}?g=1"`);
      expect(res.text).toContain('<Gather');
      expect(res.text).not.toContain('<Hangup/>');
    });

    it('second guest turn (g=1): says goodbye and hangs up instead of looping', async () => {
      const res = await twilioTurn(`${TURN}?g=1`, turnPayload(GUEST, 'Hello again?', 'CA_LOOP_002'));

      expect(res.status).toBe(200);
      expect(res.text).toContain('Goodbye');
      expect(res.text).toContain('<Hangup/>');
      expect(res.text).not.toContain('<Gather');
      expect(res.text).not.toContain('Welcome to vFarm Support');
    });

    it('a registered caller is unaffected: plain action URL, no counters, call continues', async () => {
      const res = await twilioTurn(TURN, turnPayload(MANAGER, 'What are your support hours?', 'CA_LOOP_003'));

      expect(res.status).toBe(200);
      expect(res.text).toContain(`action="${TURN}" method="POST"`);
      expect(res.text).not.toContain('?g=');
      expect(res.text).not.toContain('not registered yet');
      expect(res.text).not.toContain('<Hangup/>');
    });

    it('the JSON/API contract for guests is unchanged (still synthesized with the onboarding text)', async () => {
      const res = await request(app)
        .post(TURN)
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .set('Accept', 'application/json')
        .type('form')
        .send(turnPayload(GUEST, 'Hello, what does this service do?', 'CA_LOOP_004'));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('synthesized');
      expect(res.body.text).toContain('vFarm Support');
      expect(res.body.guest_onboarding).toBe(true);
    });

    it('accepts a REAL Twilio signature computed over the URL including the loop counter', async () => {
      const payload = turnPayload(GUEST, 'Anyone there?', 'CA_LOOP_005');
      const signature = generateTwilioSignature(`${baseUrl}${TURN}?g=1`, payload, authToken);

      const res = await request(app)
        .post(`${TURN}?g=1`)
        .set('Host', 'localhost:3000')
        .set('User-Agent', 'TwilioProxy/1.1')
        .set('X-Twilio-Signature', signature)
        .type('form')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.text).toContain('<Hangup/>');
    });
  });

  // ── 2. Empty / silent turns ────────────────────────────────────────────────
  describe('2. Empty speech is re-prompted a bounded number of times', () => {
    const empty = (sid: string) => turnPayload(MANAGER, '', sid);

    it('1st empty turn: reprompts and arms empty=1', async () => {
      const res = await twilioTurn(TURN, empty('CA_EMPTY_1'));
      expect(res.status).toBe(200);
      expect(res.text).toContain('did not catch that');
      expect(res.text).toContain(`action="${TURN}?empty=1"`);
    });

    it('2nd empty turn (empty=1): reprompts once more and arms empty=2', async () => {
      const res = await twilioTurn(`${TURN}?empty=1`, empty('CA_EMPTY_2'));
      expect(res.status).toBe(200);
      expect(res.text).toContain('did not catch that');
      expect(res.text).toContain(`action="${TURN}?empty=2"`);
    });

    it('3rd empty turn (empty=2): ends the call instead of repeating the prompt', async () => {
      const res = await twilioTurn(`${TURN}?empty=2`, empty('CA_EMPTY_3'));
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('did not catch that');
      expect(res.text).not.toContain('<Gather');
      expect(res.text).toContain('Goodbye');
      expect(res.text).toContain('<Hangup/>');
    });

    it('keeps the guest counter when re-prompting, with an XML-escaped separator', async () => {
      const res = await twilioTurn(`${TURN}?g=1`, turnPayload(GUEST, '', 'CA_EMPTY_4'));
      expect(res.status).toBe(200);
      expect(res.text).toContain(`action="${TURN}?g=1&amp;empty=1"`);
    });

    it('ignores garbage / hostile counter values', async () => {
      const res = await twilioTurn(`${TURN}?empty=abc&g=-5`, empty('CA_EMPTY_5'));
      expect(res.status).toBe(200);
      expect(res.text).toContain(`action="${TURN}?empty=1"`);
    });

    it('JSON/API clients still get the plain empty_speech response', async () => {
      const res = await request(app)
        .post(TURN)
        .set('Host', 'localhost:3000')
        .set('x-test-bypass-signature', 'true')
        .set('Accept', 'application/json')
        .type('form')
        .send(empty('CA_EMPTY_6'));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('empty_speech');
    });
  });

  // ── 3. Degraded identity / adapter ─────────────────────────────────────────
  describe('3. Identity-lookup failure is not spoken as raw text and is not treated as a guest', () => {
    it('registered caller whose identity lookup throws hears a safe "trouble verifying" message and the call ends', async () => {
      const adapter: any = CoreRegistry.getAdapter('tenant-vfarm-01');
      expect(adapter).toBeTruthy();
      vi.spyOn(adapter, 'resolveSpeaker').mockRejectedValue(new Error('vFarm identity API timed out'));
      CoreRegistry.invalidateSpeakerCache();

      const res = await twilioTurn(TURN, turnPayload(MANAGER, 'What is my farm status?', 'CA_DEGRADED_1'));

      expect(res.status).toBe(200);
      expect(res.text).toContain('trouble verifying your account');
      expect(res.text).toContain('<Hangup/>');
      expect(res.text).not.toContain('<Gather');
      expect(res.text).not.toContain('Welcome to vFarm Support'); // not mistaken for a guest
      expect(res.text).not.toContain('Tenant adapter');            // no internal wording
      expect(res.text).not.toContain('degraded');
    });

    it('records the failed turn and reports SERVICE_UNAVAILABLE to API clients', async () => {
      const adapter: any = CoreRegistry.getAdapter('tenant-vfarm-01');
      vi.spyOn(adapter, 'resolveSpeaker').mockRejectedValue(new Error('boom'));
      CoreRegistry.invalidateSpeakerCache();

      const result = await VoiceInterface.processVoiceTurn({
        from_e164: MANAGER,
        to_e164: VOICE_DID,
        speech_text: 'status please',
        correlation_id: 'CA_DEGRADED_2',
      });

      expect(result.status).toBe('refused');
      expect(result.error).toBe('SERVICE_UNAVAILABLE');
      expect(result.httpStatus).toBe(403);
      const rows = DbClient.getAllVoiceDeliveries().filter((d) => d.correlation_id === 'CA_DEGRADED_2');
      expect(rows.length).toBe(1);
      expect(rows[0].error_code).toBe('ADAPTER_DEGRADED');
      expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
    });

    it('an unhealthy adapter (health check) is also spoken safely, not as internal text', async () => {
      const adapter: any = CoreRegistry.getAdapter('tenant-vfarm-01');
      adapter.getHealth = vi.fn(async () => ({ status: 'degraded' }));

      const res = await twilioTurn(TURN, turnPayload(MANAGER, 'Hello', 'CA_DEGRADED_3'));

      expect(res.status).toBe(200);
      expect(res.text).toContain('trouble verifying your account');
      expect(res.text).toContain('<Hangup/>');
      expect(res.text).not.toContain('Tenant adapter unavailable');
    });

    it('a genuinely unknown caller is still treated as a guest (lookup succeeded, number just not registered)', async () => {
      const res = await twilioTurn(TURN, turnPayload(GUEST, 'Hello', 'CA_DEGRADED_4'));
      expect(res.status).toBe(200);
      expect(res.text).toContain('this number is not registered yet');
      expect(res.text).not.toContain('trouble verifying');
    });
  });
});
