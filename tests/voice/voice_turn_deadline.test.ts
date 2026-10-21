/**
 * Regression tests for the bounded voice-turn response deadline.
 *
 * A voice turn can include a CoreEngine round trip and an ElevenLabs
 * synthesis. Without a bound, a slow or cold instance holds the Twilio
 * webhook response open until the provider gives up.
 *
 * The deadline is not a bare `Promise.race()`. When it fires, the turn is
 * ABORTED so the in-flight work stops at its next checkpoint and the turn is
 * abandoned WITHOUT persisting a transcript, a voice-delivery row, or an
 * audit entry for a response the caller never received. That is what prevents
 * a duplicate turn and a duplicate billed synthesis.
 */
import { voiceTurnDeadlineMs } from '../../engine/src/transport/voice/turn_deadline.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { Logger } from '../../engine/src/config/logger.js';
import type { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';

const DID = '+19715885826';
const CALLER = '+923082113844';

const cannedReply = {
  reply_text: 'Your bay is within range.',
  status: 'ok',
  conversation_id: 'conv_deadline_001',
  metadata: { conversation_id: 'conv_deadline_001' },
} as any;

describe('Voice turn response deadline', () => {
  const originalDeadline = process.env.CST_VOICE_TURN_DEADLINE_MS;

  beforeEach(() => {

  // The programmatic voice API is guarded by a shared secret. This suite

  // exercises it, so it must configure the secret itself rather than

  // depending on another file leaving it set.

  process.env.CST_API_KEY = 'test_programmatic_api_key_32_chars_long';
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();

    CoreRegistry.bindServiceNumber({
      phone_e164: DID,
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    // A fast synthesizer by default; individual tests override it.
    VoiceInterface.setSynthesizer({
      synthesize: vi.fn(async ({ text, voiceId }) => ({
        audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
        mimeType: 'audio/mpeg',
      })),
    } as AudioSynthesizer);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: 'normal', farm_id: 'farm_austin_main' }),
    } as Response));

    vi.clearAllMocks();
    // Keep the deadline short so the tests do not spend real seconds.
    process.env.CST_VOICE_TURN_DEADLINE_MS = '150';
  });

  afterEach(() => {
    if (originalDeadline === undefined) {
      delete process.env.CST_VOICE_TURN_DEADLINE_MS;
    } else {
      process.env.CST_VOICE_TURN_DEADLINE_MS = originalDeadline;
    }
    vi.restoreAllMocks();
  });

  // ── 1. A fast turn is unaffected ─────────────────────────────────────────

  it('completes a fast turn normally', async () => {
    vi.spyOn(CoreEngine, 'processEnvelope').mockResolvedValue(cannedReply);

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'DEADLINE_FAST_001',
    });

    expect(result.status).toBe('synthesized');
    expect(result.error).toBeUndefined();
    expect(result.correlation_id).toBe('DEADLINE_FAST_001');
  });

  // ── 2. A slow CoreEngine trips the deadline ──────────────────────────────

  it('abandons a turn whose CoreEngine call exceeds the deadline', async () => {
    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(cannedReply), 2000))
    );
    const auditSpy = vi.spyOn(Logger, 'audit');

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'DEADLINE_SLOW_ENGINE_001',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('TURN_TIMEOUT');
    expect(result.httpStatus).toBe(504);
    expect(result.correlation_id).toBe('DEADLINE_SLOW_ENGINE_001');

    // The timeout is recorded with its correlation id.
    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const timeout = entries.find((e) => e?.reason?.includes?.('response deadline'));
    expect(timeout).toBeDefined();
    expect(timeout.correlation_id).toBe('DEADLINE_SLOW_ENGINE_001');
    expect(timeout.outcome).toBe('error');
  });

  // ── 3. An abandoned turn persists nothing ────────────────────────────────

  it('persists no turn when the deadline fires', async () => {
    const synthesizer = {
      synthesize: vi.fn(async ({ text, voiceId }: any) => ({
        audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
        mimeType: 'audio/mpeg',
      })),
    } as AudioSynthesizer;
    VoiceInterface.setSynthesizer(synthesizer);

    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(cannedReply), 2000))
    );

    await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'DEADLINE_NO_PERSIST_001',
    });

    // Give the abandoned turn a chance to (wrongly) complete and persist.
    await new Promise((r) => setTimeout(r, 300));

    // No synthesis was started: the abort checkpoint is before synthesis.
    expect(synthesizer.synthesize).not.toHaveBeenCalled();
    // No transcript row and no synthesized voice-delivery row.
    expect(DbClient.getAllTranscripts()).toHaveLength(0);
    const delivered = DbClient.getAllVoiceDeliveries().filter(
      (d) => d.status === 'synthesized' || d.status === 'sent'
    );
    expect(delivered).toHaveLength(0);
  });

  // ── 4. A slow synthesis trips the deadline too ──────────────────────────

  it('abandons a turn whose synthesis exceeds the deadline', async () => {
    vi.spyOn(CoreEngine, 'processEnvelope').mockResolvedValue(cannedReply);
    const synthesizer = {
      synthesize: vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve({ audioBase64: 'AA==', mimeType: 'audio/mpeg' }), 2000))
      ),
    } as unknown as AudioSynthesizer;
    VoiceInterface.setSynthesizer(synthesizer);

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'DEADLINE_SLOW_SYNTH_001',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('TURN_TIMEOUT');

    await new Promise((r) => setTimeout(r, 300));
    const delivered = DbClient.getAllVoiceDeliveries().filter(
      (d) => d.status === 'synthesized' || d.status === 'sent'
    );
    expect(delivered).toHaveLength(0);
  });

  // ── 5. A genuine synthesis failure is still a synthesis failure ──────────

  it('reports a synthesis rejection as SYNTHESIS_FAILED, not a timeout', async () => {
    vi.spyOn(CoreEngine, 'processEnvelope').mockResolvedValue(cannedReply);
    VoiceInterface.setSynthesizer({
      synthesize: vi.fn(async () => {
        throw new Error('ElevenLabs rejected the request');
      }),
    } as unknown as AudioSynthesizer);

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'DEADLINE_SYNTH_REJECT_001',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('SYNTHESIS_FAILED');
    expect(result.error).not.toBe('TURN_TIMEOUT');
  });

  // ── 6. A late completion cannot overwrite the answer ─────────────────────

  it('does not let a late completion change the returned outcome', async () => {
    let resolveEngine: (v: any) => void = () => {};
    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => { resolveEngine = resolve; })
    );

    const pending = VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'DEADLINE_LATE_001',
    });

    // Let the deadline fire, then release the engine.
    await new Promise((r) => setTimeout(r, 250));
    const timedOut = await pending;
    expect(timedOut.error).toBe('TURN_TIMEOUT');

    // The engine finishes late. The abandoned turn must not persist.
    resolveEngine(cannedReply);
    await new Promise((r) => setTimeout(r, 300));

    const allRows = DbClient.getAllVoiceDeliveries();
    const delivered = allRows.filter((d) => d.status === 'synthesized' || d.status === 'sent');
    expect(delivered).toHaveLength(0);
  });

  // ── 7. The deadline is configurable and clamped ──────────────────────────

  it('reads the deadline from the environment and clamps it to a sane range', () => {
    process.env.CST_VOICE_TURN_DEADLINE_MS = '2500';
    expect(voiceTurnDeadlineMs()).toBe(2500);

    process.env.CST_VOICE_TURN_DEADLINE_MS = '1';
    expect(voiceTurnDeadlineMs()).toBe(1000);

    process.env.CST_VOICE_TURN_DEADLINE_MS = '999999';
    expect(voiceTurnDeadlineMs()).toBe(20000);

    process.env.CST_VOICE_TURN_DEADLINE_MS = 'not-a-number';
    expect(voiceTurnDeadlineMs()).toBe(7000);

    delete process.env.CST_VOICE_TURN_DEADLINE_MS;
    expect(voiceTurnDeadlineMs()).toBe(7000);
  });

  // ── 8. The deadline applies at the HTTP boundary ─────────────────────────

  it('answers the webhook with valid TwiML inside the deadline', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../../engine/src/app.js');
    const app = createApp();

    // The engine never returns within the deadline.
    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(cannedReply), 5000))
    );

    const startedAt = Date.now();
    const res = await request(app)
      .post('/webhooks/twilio/voice/turn')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      // A genuine Twilio voice request asks for XML.
      .set('Accept', 'text/xml')
      .type('form')
      .send({
        CallSid: 'CA_DEADLINE_BOUNDARY_001',
        From: CALLER,
        To: DID,
        SpeechResult: 'What is the status of my farm?',
      });

    const elapsed = Date.now() - startedAt;

    // The webhook answered inside the budget rather than waiting for the
    // engine, and it answered with valid TwiML — not an empty response.
    expect(elapsed).toBeLessThan(3000);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.text).toContain('<Response>');
    expect(res.text).toContain('<Say>');
    // The fallback carries no customer content and no raw exception text.
    expect(res.text).not.toContain(CALLER);
    expect(res.text.toLowerCase()).not.toContain('error:');
  });

  // ── 9. The deadline does not bypass the security gates ───────────────────

  it('still refuses an unbound receiving number and a capability-disabled project', async () => {
    const engineSpy = vi.spyOn(CoreEngine, 'processEnvelope');

    const unbound = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: '+19998887777',
      speech_text: 'status',
      correlation_id: 'DEADLINE_UNBOUND_001',
    });
    expect(unbound.status).toBe('refused');
    expect(unbound.error).toBe('SYSTEM_NOT_FOUND');

    // A voice-disabled project is refused before the engine is reached.
    const dallas = CoreRegistry.getProject('proj-vfarm-dallas')!;
    dallas.capabilities.voice = false;
    CoreRegistry.registerProject(dallas);
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715550100',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-dallas',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    const disabled = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: CALLER,
      to_e164: '+19715550100',
      speech_text: 'status',
      correlation_id: 'DEADLINE_DISABLED_001',
    });
    expect(disabled.status).toBe('refused');
    expect(disabled.error).toBe('CAPABILITY_DISABLED');

    expect(engineSpy).not.toHaveBeenCalled();
  });
});
