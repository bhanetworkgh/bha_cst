import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { VoiceLaneService } from './voice_lane.js';
import { SystemsRegistry } from '../../systems/registry.js';
import { DbClient } from '../../db/client.js';
import { Logger } from '../../config/logger.js';
import { requireProgrammaticApiKey } from '../../middleware/programmatic_api_key.js';

export const voiceRouter = Router();

const audioSpeakSchema = z.object({
  text: z.string().min(1, 'Text is required'),
  voiceId: z.string().optional(),
  modelId: z.string().optional(),
  systemId: z.string().optional(),
  tenantId: z.string().optional(),
});

const voiceTurnSchema = z.object({
  from_e164: z.string().min(1, 'from_e164 is required'),
  to_e164: z.string().min(1, 'to_e164 is required'),
  speech_text: z.string().min(1, 'speech_text is required'),
  correlation_id: z.string().optional(),
});

/**
 * Direct TTS generation endpoint (as specified in ElevenLabs Reference §4).
 * POST /audio/speak
 *
 * Authenticated: the caller may supply `voiceId` directly, so an anonymous
 * caller could synthesize arbitrary text with an arbitrary voice and spend the
 * account's quota. See middleware/programmatic_api_key.ts.
 */
voiceRouter.post('/audio/speak', requireProgrammaticApiKey, async (req: Request, res: Response) => {
  const parsed = audioSpeakSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const audio = await VoiceLaneService.synthesizeAuthorizedSpeech({
      text: parsed.data.text,
      voiceId: parsed.data.voiceId,
      systemId: parsed.data.systemId,
      tenantId: parsed.data.tenantId,
    });
    res.status(200).json(audio);
  } catch (error: any) {
    Logger.warn(`Audio synthesis endpoint failed: ${error.message}`);
    res.status(502).json({ error: 'Audio synthesis failed.', details: error.message });
  }
});

/**
 * Interactive voice lane turn endpoint (orchestrator front door for voice).
 * POST /voice/turn
 *
 * Authenticated: `from_e164` is caller-asserted and the speaker's role and
 * farm scope are resolved from it, so an anonymous caller could impersonate a
 * known vFarm member. See middleware/programmatic_api_key.ts.
 */
voiceRouter.post('/voice/turn', requireProgrammaticApiKey, async (req: Request, res: Response) => {
  const parsed = voiceTurnSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    // Bounded by the SHARED voice-turn deadline, so this path cannot hold the
    // response open past the provider's budget.
    const result = await VoiceLaneService.processVoiceTurnWithDeadline({
      from_e164: parsed.data.from_e164,
      to_e164: parsed.data.to_e164,
      speech_text: parsed.data.speech_text,
      correlation_id: parsed.data.correlation_id,
    });

    if (result.status === 'refused') {
      res.status(403).json(result);
      return;
    }

    if (result.status === 'dropped') {
      res.status(422).json(result);
      return;
    }

    if (result.status === 'failed') {
      res.status(502).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (error: any) {
    Logger.error(`Voice turn handler failure: ${error.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: error.message });
  }
});

/**
 * Destiny Voice-Lane Health Signal Endpoint
 * GET /health/voice
 *
 * Evaluates: "clone configured + at least one successful spoken delivery in the last 24h."
 * If false: CST signals NS/RT to stay SMS-only.
 */
voiceRouter.get('/health/voice', async (_req: Request, res: Response) => {
  // Check system registry for voice clone pointer
  const vfarmSystem =
    SystemsRegistry.getSystemById('system-vfarm-01') ||
    SystemsRegistry.getSystemByTenantId('tenant-vfarm-01');

  const apiKeyConfigured = Boolean(process.env.ELEVENLABS_API_KEY?.trim());
  const cloneConfigured = Boolean(
    apiKeyConfigured &&
      (vfarmSystem?.elevenlabs_voice_id?.trim() ||
        process.env.ELEVENLABS_VOICE_ID?.trim() ||
        process.env.VFARM_ELEVENLABS_VOICE_ID?.trim())
  );

  const voiceId =
    vfarmSystem?.elevenlabs_voice_id?.trim() ||
    process.env.ELEVENLABS_VOICE_ID?.trim() ||
    process.env.VFARM_ELEVENLABS_VOICE_ID?.trim() ||
    null;

  const deliveries24h = await DbClient.getVoiceDeliveriesInLast24Hours(
    vfarmSystem?.system_id
  );

  const successfulDeliveriesCount = deliveries24h.length;
  const lastDelivery = deliveries24h[0] || null;

  let status: 'healthy' | 'degraded' | 'unconfigured';
  let can_route_voice: boolean;
  let reason: string;

  if (!cloneConfigured) {
    status = 'unconfigured';
    can_route_voice = false;
    reason =
      'Voice clone is not configured in registry or ELEVENLABS_API_KEY is missing. CST remains SMS-only.';
  } else if (successfulDeliveriesCount === 0) {
    status = 'degraded';
    can_route_voice = false;
    reason =
      'Voice clone configured, but 0 successful deliveries in the last 24 hours. Voice lane is unverified; CST remains SMS-only.';
  } else {
    status = 'healthy';
    can_route_voice = true;
    reason =
      'Voice clone configured and at least one successful delivery verified in last 24 hours. Front-line voice routing permitted.';
  }

  const httpStatus = can_route_voice ? 200 : 503;

  res.status(httpStatus).json({
    service: 'bha-cst-engine',
    voice_lane: {
      status,
      can_route_voice,
      clone_configured: cloneConfigured,
      voice_id: voiceId ? `${voiceId.slice(0, 4)}...${voiceId.slice(-4)}` : null,
      successful_deliveries_24h: successfulDeliveriesCount,
      last_successful_spoken_delivery: lastDelivery?.delivered_at || null,
      reason,
      computed_at: new Date().toISOString(),
    },
  });
});
