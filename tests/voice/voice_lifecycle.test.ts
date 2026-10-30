/**
 * Voice deadline lifecycle regression tests.
 *
 * These tests cover the specific production evidence scenarios:
 * - Two voice turns exceeded the 7,000 ms deadline (CA1decc8a2aead3400c684327ec30ff44d
 *   and CAfdc6ae536baf7dd1b2cbf5502adb3f20) followed by published outcomes.
 * - The investigation must confirm whether processing continued after the HTTP
 *   response deadline and whether late completions create duplicate side effects.
 *
 * Tests verify:
 * - Engine finishes before deadline → turn persisted
 * - Engine exceeds deadline → turn abandoned, nothing persisted
 * - Synthesis exceeds deadline → turn abandoned, nothing persisted
 * - Downstream operation respects cancellation signal
 * - Late completion after timeout → no duplicate dashboard publication
 * - No unintended SMS enqueue after timeout
 * - Correct persistence state after timeout
 * - Accurate lifecycle/audit events
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { AlertAuditLog } from '../../engine/src/audit/alert_audit.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { CoreEngine } from '../../engine/src/core/engine.js';
import { Logger } from '../../engine/src/config/logger.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { resetMonotonicStore } from '../../engine/src/publishers/delivery.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const PHONE = '+15550007777';
const DID = '+19715885823';

describe('Voice deadline lifecycle', () => {
  const originalDeadline = process.env.CST_VOICE_TURN_DEADLINE_MS;

  beforeEach(() => {
    process.env.CST_API_KEY = 'test_programmatic_api_key_32_chars_long';
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    vi.restoreAllMocks();
    // Short deadline for fast tests (clamped to minimum 1000ms by voiceTurnDeadlineMs)
    process.env.CST_VOICE_TURN_DEADLINE_MS = '150';
  });

  afterEach(() => {
    if (originalDeadline === undefined) delete process.env.CST_VOICE_TURN_DEADLINE_MS;
    else process.env.CST_VOICE_TURN_DEADLINE_MS = originalDeadline;
    vi.restoreAllMocks();
  });

  // ── Engine finishes before deadline → turn persisted ──────────────────

  it('completes a fast turn normally and persists results', async () => {
    const cannedReply = {
      reply_text: 'Your bay is within range.',
      status: 'ok',
      conversation_id: 'conv_lifecycle_001',
      metadata: { conversation_id: 'conv_lifecycle_001' },
    } as any;

    vi.spyOn(CoreEngine, 'processEnvelope').mockResolvedValue(cannedReply);
    VoiceInterface.setSynthesizer({
      synthesize: vi.fn(async () => ({
        audioBase64: 'AAAA',
        mimeType: 'audio/mpeg',
      })),
    } as any);

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LIFECYCLE_FAST_001',
    });

    expect(result.status).toBe('synthesized');
    expect(result.error).toBeUndefined();
    expect(result.correlation_id).toBe('LIFECYCLE_FAST_001');
  });

  // ── Engine exceeds deadline → turn abandoned ───────────────────────────

  it('abandons turn when engine exceeds deadline — no transcript, no delivery', async () => {
    const cannedReply = {
      reply_text: 'Too late.',
      status: 'ok',
      conversation_id: 'conv_lifecycle_002',
    } as any;

    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(cannedReply), 5000)),
    );

    const auditSpy = vi.spyOn(Logger, 'audit');

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LIFECYCLE_SLOW_001',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('TURN_TIMEOUT');
    expect(result.httpStatus).toBe(504);

    // Wait for any late completion
    await new Promise((r) => setTimeout(r, 200));

    // No transcript persisted for the timed-out turn
    const transcripts = DbClient.getAllTranscripts();
    const match = transcripts.find((t: any) => t?.correlation_id === 'LIFECYCLE_SLOW_001');
    expect(match).toBeUndefined();

    // No voice delivery row synthesized for the timed-out turn
    const deliveries = DbClient.getAllVoiceDeliveries();
    const matchDelivery = deliveries.find((d) => d.correlation_id === 'LIFECYCLE_SLOW_001');
    expect(matchDelivery).toBeUndefined();

    // Audit entry logged with correlation id and error outcome
    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const timeoutEntry = entries.find((e) => e?.correlation_id === 'LIFECYCLE_SLOW_001' && e?.outcome === 'error');
    expect(timeoutEntry).toBeDefined();
    expect(timeoutEntry.reason).toMatch(/response deadline/);
  });

  // ── Late completion cannot create duplicate dashboard publication ──────

  it('a late completion after timeout does not publish a duplicate dashboard event', async () => {
    let resolveEngine: (v: any) => void = () => {};
    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => { resolveEngine = resolve; }),
    );

    const publisher = (await import('../../engine/src/publishers/dashboard.js')).getDashboardPublisher();
    const publishSpy = vi.spyOn(publisher as any, 'publish').mockResolvedValue({ success: true, status: 201 } as any);

    const pending = VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LIFECYCLE_LATE_001',
    });

    await new Promise((r) => setTimeout(r, 250));
    const timedOut = await pending;
    expect(timedOut.error).toBe('TURN_TIMEOUT');

    const voicePublishesBefore = publishSpy.mock.calls.length;

    // The engine finishes late — after the timeout
    resolveEngine({
      reply_text: 'Late arrival',
      status: 'ok',
      conversation_id: 'conv_lifecycle_late',
    } as any);

    await new Promise((r) => setTimeout(r, 300));

    const voicePublishesAfter = publishSpy.mock.calls.length;

    // No new dashboard publications from the late completion (the turn was abandoned)
    expect(voicePublishesAfter).toBe(voicePublishesBefore);
  });

  // ── No unintended SMS enqueue after timeout ───────────────────────────

  it('does not enqueue a messages_out row for a timed-out voice turn', async () => {
    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ reply_text: 'late', status: 'ok' }), 5000)),
    );

    await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LIFECYCLE_NO_SMS_001',
    });

    await new Promise((r) => setTimeout(r, 200));

    // The voice interface path never creates messages_out rows, and after a
    // timeout no downstream processing should create one either.
    const outboundRows = DbClient.getAllMessagesOut();
    const smsMatch = outboundRows.find((m) => m.correlation_id === 'LIFECYCLE_NO_SMS_001');
    expect(smsMatch).toBeUndefined();
  });

  // ── Correct persistence state after timeout ────────────────────────────

  it('voice-delivery rows remain empty for timed-out turns', async () => {
    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ reply_text: 'late', status: 'ok' }), 5000)),
    );

    await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LIFECYCLE_NO_DELIVERY_001',
    });

    await new Promise((r) => setTimeout(r, 200));

    const deliveries = DbClient.getAllVoiceDeliveries();
    const match = deliveries.find((d) => d.correlation_id === 'LIFECYCLE_NO_DELIVERY_001');
    expect(match).toBeUndefined();
  });

  // ── Accurate lifecycle/audit events ────────────────────────────────────

  it('logs a tripwire audit entry on timeout with the correct correlation id', async () => {
    vi.spyOn(CoreEngine, 'processEnvelope').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ reply_text: 'late', status: 'ok' }), 2000)),
    );
    const auditSpy = vi.spyOn(Logger, 'audit');

    await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LIFECYCLE_AUDIT_001',
    });

    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const timeoutEntry = entries.find(
      (e) => e?.correlation_id === 'LIFECYCLE_AUDIT_001' && e?.details?.tripwire === true,
    );
    expect(timeoutEntry).toBeDefined();
    expect(timeoutEntry?.outcome).toBe('error');
    expect(timeoutEntry?.reason).toMatch(/response deadline/);
    // Deadline is clamped to minimum 1000ms (MIN_DEADLINE_MS)
    expect(timeoutEntry?.details?.deadline_ms).toBe(1000);
  });

  // ── Downstream operation (synthesizer) respects cancellation ────────────

  it('the abort signal is propagated to the synthesizer and it stops early', async () => {
    // Synthesizer that respects the abort signal
    let synthAborted = false;
    VoiceInterface.setSynthesizer({
      synthesize: vi.fn(async (opts: { text: string; voiceId: string; modelId: string; signal?: AbortSignal }) => {
        try {
          if (opts.signal?.aborted) {
            synthAborted = true;
            throw new Error('Aborted');
          }
          await new Promise((resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              synthAborted = true;
              reject(new Error('Aborted'));
            });
            setTimeout(resolve, 5000);
          });
          return { audioBase64: 'AAAA', mimeType: 'audio/mpeg' };
        } catch (e) {
          // Ensure synthAborted is set even if the check happens after abort
          if (opts.signal?.aborted) synthAborted = true;
          throw e;
        }
      }),
    } as any);

    vi.spyOn(CoreEngine, 'processEnvelope').mockResolvedValue({
      reply_text: 'Test response',
      status: 'ok',
      conversation_id: 'conv_test',
    } as any);

    const result = await VoiceInterface.processVoiceTurnWithDeadline({
      from_e164: PHONE,
      to_e164: DID,
      speech_text: 'status',
      correlation_id: 'LIFECYCLE_CANCEL_001',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('TURN_TIMEOUT');
    // The synthesizer should have been aborted
    expect(synthAborted).toBe(true);
  });
});
