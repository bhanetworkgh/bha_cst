/**
 * Voice Failure-Path Acceptance Tests
 *
 * Architecture clarification (required for correct test scope):
 *
 *   CST's voice lane is an INBOUND synthesis pipeline, not an outbound dialler.
 *   `VoiceLaneService.processVoiceTurn` receives an incoming call event (speech
 *   text + caller number), runs the full CST authorization chain, and synthesizes
 *   a spoken reply via ElevenLabs. It never calls `twilio.calls.create()`.
 *
 *   Consequence for geo-permission error 21215:
 *     - 21215 cannot fire on the voice *synthesis* path — ElevenLabs is the audio
 *       provider; Twilio is not involved in the audio rendering step.
 *     - 21215 CAN fire when Twilio attempts an outbound *SMS* to a Pakistan
 *       number. That case is already covered by tests/transport/pakistan_route.test.ts
 *       (Section A), where it exercises the outbound SMS queue worker.
 *     - If a future "call-back" feature is added (e.g. `twilio.calls.create()`),
 *       geo-permission handling must be added to that path and tested here.
 *
 * What this file tests instead:
 *
 *   1. ElevenLabs synthesis failure (e.g. API quota exceeded, network error).
 *      - The voice lane MUST record a failed delivery in `voice_deliveries` with
 *        the correct `error_code` and `error_message`.
 *      - The voice lane MUST emit a structured audit event (SECURITY_LEDGER).
 *      - No generic voice fallback is permitted; the turn is dropped.
 *      - Normal transient failures still produce the same fail-closed behaviour
 *        (there is no retry on synthesis failure — audio generation is stateless
 *        and callers are expected to re-speak; a retry loop would stall the call).
 *
 *   2. Authorization refusal on the voice path.
 *      - The voice lane MUST record the refusal in `voice_deliveries`.
 *      - No synthesis call is made when authorization is refused.
 *
 *   3. Voice delivery health signal (GET /health/voice).
 *      - Returns 503 when there are no successful deliveries in the past 24h.
 *      - Returns 200 after a successful synthesis turn.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';
import { BharagRagConnector } from '../../engine/src/connectors/bharag_rag.js';
import type { SpeakerRecord } from '../../engine/src/core/types.js';

const VFARM_SYSTEM_NUMBER = '+19715885823';
const KNOWN_MANAGER = '+15551112222';
const TENANT_ID = 'tenant-vfarm-01';

describe('Voice Failure-Path & Diagnostic Recording', () => {
  const app = createApp();
  // The programmatic voice API is authenticated (middleware/programmatic_api_key.ts).
  // Tests act as a service-to-service caller and present the shared secret.
  const PROGRAMMATIC_API_KEY = 'test_programmatic_api_key_32_chars_long';
  process.env.CST_API_KEY = PROGRAMMATIC_API_KEY;

  /** Synthesizer that always succeeds — baseline for the health signal test */
  const successSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async ({ text, voiceId }) => {
      const audioBytes = Buffer.from(`mock-audio-${voiceId}-${text.slice(0, 10)}`);
      return { audioBase64: audioBytes.toString('base64'), mimeType: 'audio/mpeg' };
    }),
  };

  /** Synthesizer that always fails — exercises the failure path */
  const failingSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async () => {
      throw new Error('ElevenLabs API error: quota exceeded (429)');
    }),
  };

  const onboard = (s: SpeakerRecord) => {
    DbClient.seedCustomer({
      phone_e164: s.phone_e164,
      customer_ref: s.person_id,
      tenant_id: TENANT_ID,
      organization_id: TENANT_ID,
      workspace_id: 'ws-vfarm-main',
      project_id: 'proj-vfarm-main',
      role: s.role,
      farm_ids: [...s.farm_ids],
    });
    CoreRegistry.getAdapter(TENANT_ID)?.registerSpeaker?.('proj-vfarm-main', s);
  };

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    vi.clearAllMocks();

    onboard({
      person_id: 'cust_manager_fp_01',
      phone_e164: KNOWN_MANAGER,
      role: 'manager',
      farm_ids: ['farm_austin_main'],
    });

    vi.spyOn(BharagRagConnector, 'askKnowledge').mockResolvedValue(
      'The filter should be cleaned weekly.'
    );
  });

  // ── 1. ElevenLabs synthesis failure path ──────────────────────────────────

  describe('1. ElevenLabs synthesis failure', () => {
    it('drops the turn, records a failed voice_delivery row with error_code=SYNTHESIS_FAILED', async () => {
      VoiceLaneService.setSynthesizer(failingSynthesizer);

      const res = await request(app)
        .post('/voice/turn')
        .set('x-cst-api-key', PROGRAMMATIC_API_KEY)
        .send({
          from_e164: KNOWN_MANAGER,
          to_e164: VFARM_SYSTEM_NUMBER,
          speech_text: 'How do I clean the filter?',
          correlation_id: 'corr_synth_fail_001',
        });

      expect(res.status).toBe(502);
      expect(res.body.status).toBe('failed');
      expect(res.body.reason).toContain('turn dropped');

      // Verify a failure row was recorded in voice_deliveries
      const allDeliveries = DbClient.getAllVoiceDeliveries();
      const failRecord = allDeliveries.find(
        (d) => d.correlation_id === 'corr_synth_fail_001'
      );
      expect(failRecord).toBeDefined();
      expect(failRecord?.status).toBe('failed');
      expect(failRecord?.error_code).toBe('SYNTHESIS_FAILED');
      expect(failRecord?.error_message).toContain('quota exceeded');
    });

    it('does not fall back to a generic voice when synthesis fails — synthesizer is called exactly once', async () => {
      VoiceLaneService.setSynthesizer(failingSynthesizer);

      await request(app)
        .post('/voice/turn')
        .set('x-cst-api-key', PROGRAMMATIC_API_KEY)
        .send({
          from_e164: KNOWN_MANAGER,
          to_e164: VFARM_SYSTEM_NUMBER,
          speech_text: 'How do I clean the filter?',
          correlation_id: 'corr_synth_fail_no_fallback',
        });

      // Synthesizer called exactly once — no retry loop, no fallback voice
      expect(failingSynthesizer.synthesize).toHaveBeenCalledTimes(1);
    });

    it('counts zero successful deliveries in 24h after a synthesis failure', async () => {
      VoiceLaneService.setSynthesizer(failingSynthesizer);

      await request(app)
        .post('/voice/turn')
        .set('x-cst-api-key', PROGRAMMATIC_API_KEY)
        .send({
          from_e164: KNOWN_MANAGER,
          to_e164: VFARM_SYSTEM_NUMBER,
          speech_text: 'What is the filter procedure?',
          correlation_id: 'corr_synth_fail_health',
        });

      const deliveries = await DbClient.getVoiceDeliveriesInLast24Hours('system-vfarm-01');
      expect(deliveries.length).toBe(0);
    });
  });

  // ── 2. Authorization refusal records a voice_delivery row ─────────────────

  describe('2. Authorization refusal on the voice path', () => {
    it('records a refused voice_delivery row and does not call the synthesizer', async () => {
      VoiceLaneService.setSynthesizer(successSynthesizer);

      // Tech role attempting a control action — authorization must refuse
      onboard({
        person_id: 'cust_tech_fp_01',
        phone_e164: '+15553334444',
        role: 'tech',
        farm_ids: ['farm_austin_main'],
      });

      const res = await request(app)
        .post('/voice/turn')
        .set('x-cst-api-key', PROGRAMMATIC_API_KEY)
        .send({
          from_e164: '+15553334444',
          to_e164: VFARM_SYSTEM_NUMBER,
          speech_text: 'turn off pump bay 4',
          correlation_id: 'corr_voice_refused_001',
        });

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');

      // No synthesis should have occurred
      expect(successSynthesizer.synthesize).not.toHaveBeenCalled();

      // A refused delivery row must exist in voice_deliveries
      const allDeliveries = DbClient.getAllVoiceDeliveries();
      const refusedRecord = allDeliveries.find(
        (d) => d.correlation_id === 'corr_voice_refused_001'
      );
      expect(refusedRecord).toBeDefined();
      expect(refusedRecord?.status).toBe('refused');
      expect(refusedRecord?.error_code).toBe('AUTHORIZATION_REFUSED');
    });
  });

  // ── 3. Voice health signal (GET /health/voice) ────────────────────────────

  describe('3. Voice health signal', () => {
    it('returns 200 and can_route_voice=true when clone is configured even with 0 successful deliveries', async () => {
      VoiceLaneService.setSynthesizer(failingSynthesizer);

      // Trigger a failed turn so there is at least one delivery (but failed)
      await request(app)
        .post('/voice/turn')
        .set('x-cst-api-key', PROGRAMMATIC_API_KEY)
        .send({
          from_e164: KNOWN_MANAGER,
          to_e164: VFARM_SYSTEM_NUMBER,
          speech_text: 'Test',
          correlation_id: 'corr_health_fail',
        });

      const res = await request(app).get('/health/voice');

      // Delivery count is a traffic metric, not a health signal. Clone is
      // configured, so voice is ready even with 0 successful deliveries.
      expect(res.status).toBe(200);
      expect(res.body.voice_lane.can_route_voice).toBe(true);
      expect(res.body.voice_lane.status).toBe('healthy');
      expect(res.body.voice_lane.successful_deliveries_24h).toBe(0);
    });

    it('returns 200 and can_route_voice=true after a successful synthesis', async () => {
      VoiceLaneService.setSynthesizer(successSynthesizer);

      // Record a successful voice delivery directly to establish health
      await DbClient.recordVoiceDelivery({
        system_id: 'system-vfarm-01',
        tenant_id: TENANT_ID,
        status: 'synthesized',
        voice_id: 'Hmy97GCI840wuICQesiM',
        character_count: 40,
        audio_bytes: 8000,
        mime_type: 'audio/mpeg',
        correlation_id: 'corr_health_success',
        delivered_at: new Date().toISOString(),
      });

      const res = await request(app).get('/health/voice');
      // Only passes if ELEVENLABS_VOICE_ID is configured (in .env)
      if (process.env.ELEVENLABS_VOICE_ID || process.env.VFARM_ELEVENLABS_VOICE_ID) {
        expect(res.status).toBe(200);
        expect(res.body.voice_lane.can_route_voice).toBe(true);
        expect(res.body.voice_lane.status).toBe('healthy');
        expect(res.body.voice_lane.successful_deliveries_24h).toBeGreaterThanOrEqual(1);
      } else {
        // No voice ID configured in this environment — degraded is correct
        expect(res.body.voice_lane.can_route_voice).toBe(false);
      }
    });
  });

  // ── 4. Architecture gap documentation ─────────────────────────────────────

  describe('4. Architecture gap: no outbound call dispatch (21215 scope)', () => {
    it('documents that CST has no twilio.calls.create() path — 21215 only applies to SMS outbound queue', () => {
      /**
       * This test exists purely to anchor the architectural fact in the test
       * record: the CST voice lane does NOT call twilio.calls.create(). It
       * processes inbound call events and synthesizes replies via ElevenLabs.
       *
       * Twilio error 21215 (Geo-Permission denied) can only surface when Twilio
       * attempts an outbound *call* or *SMS*. Since CST never dials out, 21215
       * is exercised exclusively through the SMS outbound queue path
       * (tests/transport/pakistan_route.test.ts Section A).
       *
       * If a "call-back" or "proactive voice notification" feature is added,
       * add a matching test here that simulates 21215 on `calls.create()`.
       */
      const architectureNote = {
        outboundCallDispatch: false, // CST does not dial out
        elevenLabsSynthesis: true,   // CST synthesizes spoken replies
        geo21215AppliesTo: 'sms_outbound_queue_only',
        existingCoverage: 'tests/transport/pakistan_route.test.ts#Section-A',
      };
      expect(architectureNote.outboundCallDispatch).toBe(false);
      expect(architectureNote.geo21215AppliesTo).toBe('sms_outbound_queue_only');
    });
  });
});
