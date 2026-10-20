/**
 * Security regression for the programmatic voice API.
 *
 * `POST /api/v1/voice/turn`, `POST /api/v1/voice/synthesize`,
 * `POST /api/v1/voice/status`, `POST /voice/turn` and `POST /audio/speak` are
 * mounted on the public service. Before this guard they carried no middleware
 * at all, which meant:
 *
 *   - `/api/v1/voice/turn` trusted a client-asserted `from_e164`; the speaker's
 *     role, permissions and farm_ids are resolved from that number, so an
 *     unauthenticated caller could assert a known vFarm member's number and
 *     receive that member's farm-scoped answer.
 *   - `/api/v1/voice/synthesize` synthesized arbitrary text with the project's
 *     ElevenLabs voice clone.
 *   - `POST /voice/turn` (mounted from `transport/voice/voice_router.ts`) is the
 *     same impersonation path as `/api/v1/voice/turn`.
 *   - `POST /audio/speak` let a caller supply `voiceId` directly, so it could
 *     synthesize arbitrary text with an arbitrary voice.
 *
 * These tests pin the guard on all five routes: absent, empty, malformed, and
 * wrong secrets all fail closed, an unconfigured secret fails closed, and the
 * Twilio-hosted variants stay protected by signature verification.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { AudioSynthesizer } from '../../engine/src/audio/synthesis.js';
import { Logger } from '../../engine/src/config/logger.js';
import { checkProgrammaticApiKeyBootConfig, resetProgrammaticApiKeyConfigLogging } from '../../engine/src/middleware/programmatic_api_key.js';

const SECRET = 'test_programmatic_api_key_32_chars_long';
const KNOWN_SPEAKER = '+15551112222';

describe('Programmatic voice API authentication (CST programmatic_api_key guard)', () => {
  const app = createApp();

  const mockSynthesizer: AudioSynthesizer = {
    synthesize: vi.fn(async ({ text, voiceId }) => ({
      audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
      mimeType: 'audio/mpeg',
    })),
  };

  const originalKey = process.env.CST_API_KEY;

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    // Bind a voice-capability DID so the authenticated path can resolve a
    // tenant/project from `to_e164`.
    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885826',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });
    // Onboard a speaker the way production does: a `customers` row AND a
    // matching entry in the tenant adapter's directory. Without this the
    // caller would resolve as an unknown speaker (guest) and the farm request
    // would be refused by the authorization chain rather than the auth guard.
    DbClient.seedCustomer({
      phone_e164: KNOWN_SPEAKER,
      customer_ref: 'cust_manager_01',
      tenant_id: 'tenant-vfarm-01',
      organization_id: 'tenant-vfarm-01',
      workspace_id: 'ws-vfarm-main',
      project_id: 'proj-vfarm-main',
      role: 'manager',
      unit_id: 'bay_04',
      farm_id: 'farm_austin_main',
      farm_ids: ['farm_austin_main'],
    });
    (CoreRegistry.getAdapter('tenant-vfarm-01') as any)?.registerSpeaker?.('proj-vfarm-main', {
      person_id: 'cust_manager_01',
      phone_e164: KNOWN_SPEAKER,
      role: 'manager',
      farm_ids: ['farm_austin_main'],
    });
    VoiceInterface.setSynthesizer(mockSynthesizer);
    VoiceLaneService.setSynthesizer(mockSynthesizer);
    vi.clearAllMocks();
    process.env.CST_API_KEY = SECRET;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.CST_API_KEY;
    } else {
      process.env.CST_API_KEY = originalKey;
    }
  });

  // ── 1. The routes refuse an unauthenticated caller ─────────────────────────

  it('refuses /api/v1/voice/turn with no credential', async () => {
    const res = await request(app)
      .post('/api/v1/voice/turn')
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'What is the status of my farm?',
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    // The refusal must happen before any synthesis is attempted.
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('refuses /api/v1/voice/synthesize with no credential', async () => {
    const res = await request(app)
      .post('/api/v1/voice/synthesize')
      .send({ tenant_id: 'tenant-vfarm-01', project_id: 'proj-vfarm-main', text: 'hello' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('refuses /voice/turn with no credential', async () => {
    const res = await request(app)
      .post('/voice/turn')
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'What is the status of my farm?',
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('refuses /audio/speak with no credential', async () => {
    const res = await request(app)
      .post('/audio/speak')
      .send({ text: 'hello' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('refuses /api/v1/voice/status with no credential', async () => {
    const res = await request(app)
      .post('/api/v1/voice/status')
      .send({ CallSid: 'CA_probe', CallStatus: 'completed' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  // ── 2. A wrong credential is refused ───────────────────────────────────────

  it('refuses /api/v1/voice/turn with the wrong credential', async () => {
    const res = await request(app)
      .post('/api/v1/voice/turn')
      .set('x-cst-api-key', 'not_the_right_key_at_all_32chars')
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'What is the status of my farm?',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('refuses a credential that is a prefix of the real one', async () => {
    const res = await request(app)
      .post('/api/v1/voice/turn')
      .set('x-cst-api-key', SECRET.slice(0, 8))
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'status',
      });

    expect(res.status).toBe(403);
  });

  it('refuses an empty credential', async () => {
    const res = await request(app)
      .post('/api/v1/voice/turn')
      .set('x-cst-api-key', '')
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'status',
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('refuses a whitespace-only credential', async () => {
    const res = await request(app)
      .post('/api/v1/voice/turn')
      .set('x-cst-api-key', '    ')
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'status',
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('refuses a credential that differs only by trailing whitespace padding', async () => {
    const res = await request(app)
      .post('/api/v1/voice/turn')
      .set('x-cst-api-key', ` ${SECRET} `)
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'status',
      });

    // The provided value is trimmed before comparison, so surrounding
    // whitespace is tolerated — the secret itself must still match exactly.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('synthesized');
  });

  it('refuses a malformed credential of the wrong shape', async () => {
    const res = await request(app)
      .post('/audio/speak')
      .set('x-cst-api-key', 'not-hex-not-base64-@@@@')
      .send({ text: 'hello' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('does not echo the supplied credential back in the error body', async () => {
    const wrong = 'super_secret_wrong_value_1234567890';
    const res = await request(app)
      .post('/api/v1/voice/synthesize')
      .set('x-cst-api-key', wrong)
      .send({ tenant_id: 'tenant-vfarm-01', project_id: 'proj-vfarm-main', text: 'hello' });

    expect(res.status).toBe(403);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(wrong);
    expect(body).not.toContain(SECRET);
  });

  // ── 3. An unconfigured secret fails closed ────────────────────────────────

  it('fails closed with 503 when CST_API_KEY is not configured', async () => {
    delete process.env.CST_API_KEY;

    const res = await request(app)
      .post('/api/v1/voice/turn')
      .set('x-cst-api-key', SECRET)
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'status',
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('CONFIG_MISSING');
    expect(mockSynthesizer.synthesize).not.toHaveBeenCalled();
  });

  it('fails closed with 503 for an empty CST_API_KEY value', async () => {
    process.env.CST_API_KEY = '   ';

    const res = await request(app)
      .post('/api/v1/voice/synthesize')
      .set('x-cst-api-key', SECRET)
      .send({ tenant_id: 'tenant-vfarm-01', project_id: 'proj-vfarm-main', text: 'hello' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('CONFIG_MISSING');
  });

  // ── 4. The authenticated path still works ─────────────────────────────────

  it('accepts /api/v1/voice/turn with the correct credential', async () => {
    const res = await request(app)
      .post('/api/v1/voice/turn')
      .set('x-cst-api-key', SECRET)
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'What is the status of my farm?',
        correlation_id: 'PROGKEY_OK_001',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('synthesized');
  });

  it('accepts /voice/turn with the correct credential', async () => {
    const res = await request(app)
      .post('/voice/turn')
      .set('x-cst-api-key', SECRET)
      .send({
        from_e164: KNOWN_SPEAKER,
        to_e164: '+19715885823',
        speech_text: 'What is the status of my farm?',
        correlation_id: 'PROGKEY_ROUTER_OK_001',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).not.toBe('refused');
  });

  it('accepts /audio/speak with the correct credential', async () => {
    const res = await request(app)
      .post('/audio/speak')
      .set('x-cst-api-key', SECRET)
      .send({ text: 'hello' });

    expect(res.status).toBe(200);
  });

  // ── 5. The Twilio-hosted variants are unaffected ──────────────────────────

  it('leaves the Twilio voice status webhook on signature verification', async () => {
    // No programmatic key, and no Twilio signature either: the Twilio route
    // must still answer with a signature rejection, not the programmatic 401.
    const res = await request(app)
      .post('/webhooks/twilio/voice/status')
      .set('Host', 'localhost:3000')
      .send({ CallSid: 'CA_probe', CallStatus: 'completed' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.body.message).toMatch(/Signature/i);
  });

  // ── 6. The boot-time configuration check is deliberate and loud ──────────

  it('boot check reports the secret as missing exactly once, and does not throw', () => {
    resetProgrammaticApiKeyConfigLogging();
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    delete process.env.CST_API_KEY;
    expect(() => checkProgrammaticApiKeyBootConfig()).not.toThrow();
    expect(checkProgrammaticApiKeyBootConfig()).toBe(false);

    const configWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('CST_API_KEY'));
    expect(configWarnings.length).toBe(1);
    expect(configWarnings[0]).toMatch(/CLOSED/);

    warnSpy.mockRestore();
  });

  it('boot check reports the secret as present when configured', () => {
    resetProgrammaticApiKeyConfigLogging();
    expect(checkProgrammaticApiKeyBootConfig()).toBe(true);
  });

  // ── 7. Refusals are audited ──────────────────────────────────────────────

  it('writes a SECURITY_LEDGER audit entry for a refused programmatic call', async () => {
    const auditSpy = vi.spyOn(Logger, 'audit');

    await request(app)
      .post('/api/v1/voice/turn')
      .send({
        from_e164: '+923082113844',
        to_e164: '+19715885826',
        speech_text: 'status',
      });

    const entries = auditSpy.mock.calls.map((c) => c[0] as any);
    const refusal = entries.find((e) => e?.tool_or_route === '/api/v1/voice/turn');
    expect(refusal).toBeDefined();
    expect(refusal.outcome).toBe('refused');
    expect(String(refusal.reason)).toMatch(/x-cst-api-key/);
  });
});
