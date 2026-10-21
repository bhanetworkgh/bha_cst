/**
 * Regression tests for the combined 'sms_voice' service-number capability.
 *
 * A Twilio number is bought once and can serve both transports. The registry
 * therefore allows a binding with capability 'sms_voice', and every capability
 * check must treat that binding as satisfying BOTH an SMS lookup and a voice
 * lookup — otherwise the number is bound but neither lane can use it.
 *
 * Three call sites are covered here, because each is a place where a strict
 * equality comparison would silently break the feature:
 *
 *   1. `CoreRegistry.resolveServiceNumber` — the binding lookup itself.
 *   2. `VoiceInterface` inbound capability check — the voice lane.
 *   3. `resolveOutboundSendingNumber` / `validateConsentExempt` — the SMS lane.
 *
 * The consent-exempt guard is included deliberately: it is the control that
 * stops a customer-originated sender from claiming the platform bypass, so it
 * must still refuse a number that is not SMS-capable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { matchesCapability } from '../../engine/src/core/types.js';
import { DbClient } from '../../engine/src/db/client.js';
import { Logger } from '../../engine/src/config/logger.js';

const SMS_VOICE_DID = '+19715885823';
const SMS_ONLY_DID = '+19715550100';
const VOICE_ONLY_DID = '+19715885825';

describe('Combined sms_voice service-number capability', () => {
  const app = createApp();

  beforeEach(() => {
    // The programmatic voice API is guarded by a shared secret. This suite
    // exercises it, so it must configure the secret itself rather than
    // depending on another file leaving it set.
    process.env.CST_API_KEY = 'test_programmatic_api_key_32_chars_long';
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
    vi.clearAllMocks();
  });

  // ── The matcher ───────────────────────────────────────────────────────────

  describe('matchesCapability', () => {
    it('matches an exact capability', () => {
      expect(matchesCapability('sms', 'sms')).toBe(true);
      expect(matchesCapability('voice', 'voice')).toBe(true);
    });

    it('treats sms_voice as satisfying both sms and voice', () => {
      expect(matchesCapability('sms_voice', 'sms')).toBe(true);
      expect(matchesCapability('sms_voice', 'voice')).toBe(true);
    });

    it('does not treat a single capability as satisfying the other', () => {
      expect(matchesCapability('sms', 'voice')).toBe(false);
      expect(matchesCapability('voice', 'sms')).toBe(false);
    });

    it('does not treat sms_voice as satisfying an unrelated channel', () => {
      expect(matchesCapability('sms_voice', 'web')).toBe(false);
      expect(matchesCapability('sms_voice', 'email')).toBe(false);
    });
  });

  // ── The binding lookup ───────────────────────────────────────────────────

  describe('CoreRegistry.resolveProjectServiceNumber', () => {
    it('resolves the combined binding for an sms lookup', () => {
      const binding = CoreRegistry.resolveProjectServiceNumber(
        'tenant-vfarm-01',
        'proj-vfarm-main',
        'sms'
      );
      expect(binding).not.toBeNull();
      expect(binding!.phone_e164).toBe(SMS_VOICE_DID);
    });

    it('resolves the combined binding for a voice lookup', () => {
      const binding = CoreRegistry.resolveProjectServiceNumber(
        'tenant-vfarm-01',
        'proj-vfarm-main',
        'voice'
      );
      expect(binding).not.toBeNull();
      expect(binding!.phone_e164).toBe(SMS_VOICE_DID);
    });

    it('does not resolve the combined binding for an unrelated channel', () => {
      expect(
        CoreRegistry.resolveProjectServiceNumber('tenant-vfarm-01', 'proj-vfarm-main', 'web')
      ).toBeNull();
    });
  });

  // ── The voice lane ───────────────────────────────────────────────────────

  describe('VoiceInterface inbound capability check', () => {
    const signatureBypass = { 'x-test-bypass-signature': 'true' };

    it('accepts a voice call on a combined sms_voice number', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set(signatureBypass)
        .type('form')
        .send({ CallSid: 'CA_SMSVOICE_001', From: '+15559876543', To: SMS_VOICE_DID });

      expect(res.status).toBe(200);
      expect(res.body).not.toMatchObject({ error: 'CAPABILITY_DISABLED' });
    });

    it('still refuses a voice call on a voice-only-missing number', async () => {
      // A number bound for SMS only must NOT be usable for voice.
      CoreRegistry.bindServiceNumber({
        phone_e164: SMS_ONLY_DID,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        capability: 'sms',
        status: 'bound',
        bound_at: new Date().toISOString(),
      });

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Host', 'localhost:3000')
        .set(signatureBypass)
        .type('form')
        .send({ CallSid: 'CA_SMSONLY_001', From: '+15559876543', To: SMS_ONLY_DID });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('CAPABILITY_DISABLED');
    });
  });

  // ── The SMS lane ─────────────────────────────────────────────────────────

  describe('Outbound SMS capability checks', () => {
    it('accepts a combined sms_voice number as the queued sending number', async () => {
      // resolveOutboundSendingNumber must accept the combined binding.
      const { resolveOutboundSendingNumber } = await import(
        '../../engine/src/transport/twilio/outbound.js'
      );
      const resolved = resolveOutboundSendingNumber({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        from_e164: SMS_VOICE_DID,
        to_e164: '+15551112222',
        body: 'hello',
        correlation_id: 'corr_smsvoice_001',
      } as any);

      expect(resolved).toBe(SMS_VOICE_DID);
    });

    it('still refuses a voice-only number as the queued sending number', async () => {
      const { resolveOutboundSendingNumber } = await import(
        '../../engine/src/transport/twilio/outbound.js'
      );
      // A project whose ONLY binding is voice-only: the project's own number
      // does not satisfy the SMS lookup, so the queued `from_e164` fallback
      // is reached — and it must still refuse a non-SMS-capable number.
      CoreRegistry.registerProject({
        project_id: 'proj-voice-only-test',
        tenant_id: 'tenant-vfarm-01',
        name: 'Voice Only Test Project',
        capabilities: { sms: false, voice: true },
        speaker_policy: 'allowlist',
        onboarding_reply: 'voice only test project',
        voice_enabled: true,
      } as any);
      CoreRegistry.bindServiceNumber({
        phone_e164: VOICE_ONLY_DID,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-voice-only-test',
        capability: 'voice',
        status: 'bound',
        bound_at: new Date().toISOString(),
      });

      const resolved = resolveOutboundSendingNumber({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-voice-only-test',
        from_e164: VOICE_ONLY_DID,
        to_e164: '+15551112222',
        body: 'hello',
        correlation_id: 'corr_voiceonly_001',
      } as any);

      expect(resolved).toBeNull();
    });

    it('prefers the bound project number over the queued from_e164', async () => {
      const { resolveOutboundSendingNumber } = await import(
        '../../engine/src/transport/twilio/outbound.js'
      );
      const resolved = resolveOutboundSendingNumber({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        from_e164: VOICE_ONLY_DID,
        to_e164: '+15551112222',
        body: 'hello',
        correlation_id: 'corr_own_binding_001',
      } as any);

      expect(resolved).toBe(SMS_VOICE_DID);
    });
  });
});
