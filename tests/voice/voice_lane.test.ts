import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { BharagRagConnector } from '../../engine/src/connectors/bharag_rag.js';
import { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';

describe('ElevenLabs Voice Clone Integration into CST (5-Step debrief)', () => {
  const app = createApp();

  const mockSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async ({ text, voiceId }) => {
      const audioBytes = Buffer.from(`synthetic-voice-audio-for-${voiceId}-${text.slice(0, 10)}`);
      return {
        audioBase64: audioBytes.toString('base64'),
        mimeType: 'audio/mpeg',
      };
    }),
  };

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    VoiceLaneService.setSynthesizer(mockSynthesizer);
    vi.clearAllMocks();
    vi.spyOn(BharagRagConnector, 'askKnowledge').mockResolvedValue(
      'Clean the filter mesh weekly with vinegar solution.'
    );

    // Seed test customers in customer registry
    DbClient.seedCustomer({
      phone_e164: '+15551112222',
      customer_ref: 'cust_manager_01',
      tenant_id: 'tenant-vfarm-01',
      organization_id: 'tenant-vfarm-01',
      workspace_id: 'ws-vfarm-main',
      role: 'manager',
      unit_id: 'bay_04',
      farm_id: 'farm_austin_main',
    });

    DbClient.seedCustomer({
      phone_e164: '+15553334444',
      customer_ref: 'cust_tech_01',
      tenant_id: 'tenant-vfarm-01',
      organization_id: 'tenant-vfarm-01',
      workspace_id: 'ws-vfarm-main',
      role: 'tech',
      unit_id: 'bay_04',
      farm_id: 'farm_austin_main',
    });
  });

  // ── STEP 1: Voice Pointer in Registry ─────────────────────────────────────
  it('Step 1: Registry holds ElevenLabs voice pointer, not the clone itself', () => {
    const vfarm = SystemsRegistry.getSystemById('system-vfarm-01');
    expect(vfarm).toBeDefined();
    expect(vfarm?.elevenlabs_voice_id).toBe(process.env.VFARM_ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID);
    expect(vfarm?.elevenlabs_model_id).toBe(process.env.ELEVENLABS_MODEL_ID);
    expect(vfarm?.voice_enabled).toBe(true);
  });

  // ── STEP 2: Authorization Chain in Front of Voice ─────────────────────────
  it('Step 2: Authorized BHARAG-backed answer is synthesized in Jason voice clone', async () => {
    vi.spyOn(BharagRagConnector, 'askKnowledge').mockResolvedValueOnce(
      'Clean the filter mesh weekly with vinegar solution.'
    );

    const res = await request(app)
      .post('/voice/turn')
      .send({
        from_e164: '+15551112222', // Known manager
        to_e164: '+19715885823',   // vFarm system number
        speech_text: 'How do I clean the filter?',
        correlation_id: 'corr_voice_step2_test',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('synthesized');
    expect(res.body.text).toContain('Clean the filter');
    expect(res.body.audioBase64).toBeDefined();
    expect(res.body.mimeType).toBe('audio/mpeg');

    // Verify ElevenLabs synthesizer was invoked with Jason's voice pointer
    expect(mockSynthesizer.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceId: process.env.VFARM_ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID,
        modelId: process.env.ELEVENLABS_MODEL_ID,
        text: 'Clean the filter mesh weekly with vinegar solution.',
      })
    );
  });

  // ── STEP 3: Fail-Closed Rule ──────────────────────────────────────────────
  it('Step 3: Refuses to speak if CST authorization chain refuses text (tech control action)', async () => {
    const res = await request(app)
      .post('/voice/turn')
      .send({
        from_e164: '+15553334444', // Tech role
        to_e164: '+19715885823',
        speech_text: 'turn off pump bay 4', // Control action forbidden for tech
        correlation_id: 'corr_voice_tech_refused',
      });

    // Spoken turn MUST be refused
    expect(res.status).toBe(403);
    expect(res.body.status).toBe('refused');
    expect(res.body.reason).toContain('tech');

    // Synthesizer must NOT be called for refused operational control
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('Step 3: Drops spoken turn if voice pointer is missing (no generic voice fallback)', async () => {
    // Unconfigure voice ID for system
    const system = SystemsRegistry.getSystemById('system-vfarm-01')!;
    system.elevenlabs_voice_id = undefined;

    const res = await request(app)
      .post('/voice/turn')
      .send({
        from_e164: '+15551112222',
        to_e164: '+19715885823',
        speech_text: 'How do I clean the filter?',
        correlation_id: 'corr_voice_no_pointer',
      });

    expect(res.status).toBe(422);
    expect(res.body.status).toBe('dropped');
    expect(res.body.reason).toContain('generic voice fallback is forbidden');
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('Step 3: Drops spoken turn if ElevenLabs synthesis fails upstream (no fallback to substitute voice)', async () => {
    vi.spyOn(mockSynthesizer, 'synthesize').mockRejectedValueOnce(
      new Error('ElevenLabs quota exceeded: 429')
    );

    const res = await request(app)
      .post('/voice/turn')
      .send({
        from_e164: '+15551112222',
        to_e164: '+19715885823',
        speech_text: 'How do I clean the filter?',
        correlation_id: 'corr_voice_upstream_failure',
      });

    expect(res.status).toBe(502);
    expect(res.body.status).toBe('failed');
    expect(res.body.reason).toContain('turn dropped');

    // Verify delivery failure was recorded
    const deliveries = await DbClient.getVoiceDeliveriesInLast24Hours('system-vfarm-01');
    expect(deliveries.length).toBe(0); // Only successful deliveries are returned in healthy 24h count

    const allDeliveries = DbClient.getAllVoiceDeliveries();
    const failedRecord = allDeliveries.find((d) => d.correlation_id === 'corr_voice_upstream_failure');
    expect(failedRecord).toBeDefined();
    expect(failedRecord?.status).toBe('failed');
    expect(failedRecord?.error_code).toBe('SYNTHESIS_FAILED');
  });

  // ── STEP 4: Wire Voice into Audit and Health Surfaces ──────────────────────
  it('Step 4: Records delivery event in voice_deliveries and alert_audit_log', async () => {
    vi.spyOn(BharagRagConnector, 'askKnowledge').mockResolvedValueOnce(
      'Filter procedure: Rinse with water.'
    );

    const res = await request(app)
      .post('/voice/turn')
      .send({
        from_e164: '+15551112222',
        to_e164: '+19715885823',
        speech_text: 'How do I clean the filter?',
        correlation_id: 'corr_voice_audit_linkage',
      });

    expect(res.status).toBe(200);

    // Verify voice_deliveries recorded
    const deliveries = await DbClient.getVoiceDeliveriesInLast24Hours('system-vfarm-01');
    expect(deliveries.length).toBeGreaterThan(0);
    const deliv = deliveries[0];
    expect(deliv.status).toBe('synthesized');
    expect(deliv.voice_id).toBe('Hmy97GCI840wuICQesiM');
    expect(deliv.audio_bytes).toBeGreaterThan(0);
    expect(deliv.character_count).toBeGreaterThan(0);

    // Verify transcript was linked
    const transcripts = DbClient.getAllTranscripts();
    const voiceMsg = transcripts.find((t: any) => t.from_e164 === '+19715885823' && t.direction === 'outbound');
    expect(voiceMsg).toBeDefined();
    expect(voiceMsg.body).toBe('Filter procedure: Rinse with water.');
    expect(voiceMsg.media_refs).toContain('voice:elevenlabs:Hmy97GCI840wuICQesiM');
  });

  // ── Direct Audio Speak Endpoint (Reference §4) ────────────────────────────
  it('serves direct TTS synthesis at POST /audio/speak', async () => {
    const res = await request(app)
      .post('/audio/speak')
      .send({
        text: 'System alert: pH reading is normal.',
        voiceId: 'Hmy97GCI840wuICQesiM',
      });

    expect(res.status).toBe(200);
    expect(res.body.audioBase64).toBeDefined();
    expect(res.body.mimeType).toBe('audio/mpeg');
    expect(mockSynthesizer.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'System alert: pH reading is normal.',
        voiceId: 'Hmy97GCI840wuICQesiM',
      })
    );
  });
});
