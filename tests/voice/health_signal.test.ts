import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('Destiny Voice-Lane Health Signal (Step 5)', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
  });

  it('evaluates to "healthy" (200) when clone is configured and 0 deliveries in last 24h', async () => {
    // Clone is configured by default in SystemsRegistry (Hmy97GCI840wuICQesiM), but store has 0 deliveries
    // Delivery count is a traffic metric, not a health signal — 0 deliveries means no one called,
    // not that voice is broken.
    const res = await request(app).get('/health/voice');

    expect(res.status).toBe(200);
    expect(res.body.voice_lane).toBeDefined();
    expect(res.body.voice_lane.can_route_voice).toBe(true);
    expect(res.body.voice_lane.status).toBe('healthy');
    expect(res.body.voice_lane.clone_configured).toBe(true);
    expect(res.body.voice_lane.successful_deliveries_24h).toBe(0);
    expect(res.body.voice_lane.reason).toContain('No successful deliveries in the last 24 hours');
  });

  it('evaluates to "healthy" (200) when clone is configured and >=1 delivery in last 24h', async () => {
    // Record a successful spoken delivery
    await DbClient.recordVoiceDelivery({
      system_id: 'system-vfarm-01',
      tenant_id: 'tenant-vfarm-01',
      status: 'synthesized',
      voice_id: 'Hmy97GCI840wuICQesiM',
      character_count: 50,
      audio_bytes: 4096,
      correlation_id: 'corr_health_test_1',
      delivered_at: new Date().toISOString(),
    });

    const res = await request(app).get('/health/voice');

    expect(res.status).toBe(200);
    expect(res.body.voice_lane.status).toBe('healthy');
    expect(res.body.voice_lane.can_route_voice).toBe(true);
    expect(res.body.voice_lane.clone_configured).toBe(true);
    expect(res.body.voice_lane.successful_deliveries_24h).toBe(1);
    expect(res.body.voice_lane.last_successful_spoken_delivery).toBeDefined();
    expect(res.body.voice_lane.reason).toContain('Front-line voice routing permitted');
  });

  it('evaluates to "unconfigured" (503) when voice clone pointer is missing', async () => {
    // Unconfigure voice ID in registry and env
    const vfarm = SystemsRegistry.getSystemById('system-vfarm-01')!;
    vfarm.elevenlabs_voice_id = undefined;

    const origEnvVoice = process.env.ELEVENLABS_VOICE_ID;
    const origVfarmVoice = process.env.VFARM_ELEVENLABS_VOICE_ID;
    delete process.env.ELEVENLABS_VOICE_ID;
    delete process.env.VFARM_ELEVENLABS_VOICE_ID;

    try {
      const res = await request(app).get('/health/voice');

      expect(res.status).toBe(503);
      expect(res.body.voice_lane.status).toBe('unconfigured');
      expect(res.body.voice_lane.can_route_voice).toBe(false);
      expect(res.body.voice_lane.clone_configured).toBe(false);
      expect(res.body.voice_lane.reason).toContain('CST remains SMS-only');
    } finally {
      if (origEnvVoice) process.env.ELEVENLABS_VOICE_ID = origEnvVoice;
      if (origVfarmVoice) process.env.VFARM_ELEVENLABS_VOICE_ID = origVfarmVoice;
    }
  });

  it('evaluates to "healthy" (200) when clone is configured but readings are older than 24h', async () => {
    // Stale delivery from 26 hours ago — delivery count is a traffic metric,
    // not a health signal. Clone is still configured, so voice is ready.
    const staleTime = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    await DbClient.recordVoiceDelivery({
      system_id: 'system-vfarm-01',
      tenant_id: 'tenant-vfarm-01',
      status: 'synthesized',
      voice_id: 'Hmy97GCI840wuICQesiM',
      character_count: 50,
      audio_bytes: 4096,
      correlation_id: 'corr_health_stale_test',
      created_at: staleTime,
      delivered_at: staleTime,
    });

    const res = await request(app).get('/health/voice');

    expect(res.status).toBe(200);
    expect(res.body.voice_lane.can_route_voice).toBe(true);
    expect(res.body.voice_lane.status).toBe('healthy');
    expect(res.body.voice_lane.successful_deliveries_24h).toBe(0);
    expect(res.body.voice_lane.reason).toContain('No successful deliveries in the last 24 hours');
  });
});
