/**
 * Pakistan Route Acceptance Tests
 *
 * Validates CST behaviour when attempting to reach Pakistan (+92) numbers
 * through Twilio's default restricted configuration.
 *
 * Two distinct failure modes are covered:
 *
 * A. VOICE — Twilio Geo-Permission Denied (error 21215)
 *    Twilio blocks outbound voice calls to Pakistan by default. The outbound
 *    worker MUST classify this as a permanent (non-retriable) failure on the
 *    very first attempt and record status="failed" with the error code.
 *    OPERATOR ACTION: enable PK dialing under Twilio Console >
 *      Voice > Settings > Geo-Permissions, then re-queue the message.
 *
 * B. SMS — Carrier-Level Rejection (error 30005)
 *    International long-code SMS to Pakistan is rejected by the receiving
 *    carrier (Jazz/Mobilink, Telenor-PK, etc.) at the SMSC layer. Twilio
 *    surfaces this as error 30005 ("Unknown destination handset"). No retry
 *    will succeed; the outbound worker MUST mark the message permanently
 *    failed on the first attempt.
 *    OPERATOR ACTION: use a local Pakistani SIM, an approved international
 *    A2P short code, or a WhatsApp Business channel for PK delivery.
 *
 * Neither failure mode indicates a CST bug. They reflect Twilio account
 * configuration and carrier policy. The tests confirm CST handles them
 * correctly (fail-fast, no retry burn, correct audit trail).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { TwilioClientWrapper, SendSmsParams } from '../../engine/src/transport/twilio/client.js';
import { processOutboundQueue } from '../../engine/src/transport/twilio/outbound.js';
import { recordConsent } from '../../engine/src/consent/service.js';

const PRIMARY_SENDER_DID = '+19715885823';
const PK_JAZZ_NUMBER = '+923082113844';
const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_ID = 'proj-vfarm-main';

/** Build a Twilio-style error object with the given code */
function twilioError(code: number, message: string): Error & { code: number; isNonRetriable?: boolean } {
  const err = new Error(message) as Error & { code: number; isNonRetriable?: boolean };
  err.code = code;
  return err;
}

describe('Pakistan Route — Geo-Permission & Carrier Rejection Handling', () => {
  let twilioCallCount: number;

  beforeEach(async () => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    CoreRegistry.resetToDefault();
    twilioCallCount = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TwilioClientWrapper.setMockHandler(null);
  });

  // ── A. Voice Geo-Permission (21215) ────────────────────────────────────────

  describe('A. Voice Geo-Permission denied (error 21215)', () => {
    it('classifies 21215 as a non-retriable error without retrying', () => {
      const err = twilioError(21215, 'Geo-Permission: Outbound call cannot be placed to this country/region.');
      expect(TwilioClientWrapper.isNonRetriableError(err)).toBe(true);
    });

    it('immediately marks queued SMS as permanently failed on 21215 — no retries attempted', async () => {
      await recordConsent(TENANT_ID, PK_JAZZ_NUMBER, { projectId: PROJECT_ID });

      TwilioClientWrapper.setMockHandler(async (_params: SendSmsParams) => {
        twilioCallCount++;
        const err = twilioError(
          21215,
          'Geo-Permission: Outbound call cannot be placed. Enable Pakistan (+92) in Twilio Console > Voice > Settings > Geo-Permissions.'
        );
        err.isNonRetriable = true;
        throw err;
      });

      await DbClient.saveOutboundMessage({
        id: 'out_pk_voice_geo_001',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        from_e164: PRIMARY_SENDER_DID,
        to_e164: PK_JAZZ_NUMBER,
        body: 'Your vFarm water level is at 72%. Please check the irrigation schedule.',
        correlation_id: 'corr_pk_voice_geo_001',
        turn_id: 'corr_pk_voice_geo_001',
        status: 'pending',
        consent_exempt: false,
      });

      await processOutboundQueue();

      // Twilio was called exactly once (no retry on non-retriable)
      expect(twilioCallCount).toBe(1);

      const stored = DbClient.getAllMessagesOut().find((m) => m.id === 'out_pk_voice_geo_001');
      expect(stored).toBeDefined();
      expect(stored?.status).toBe('failed');
      // Error message must surface the error code for operator diagnosis
      expect(stored?.error_message).toContain('21215');
    });

    it('does not retry a 21215 failure even when max_retries is greater than 1', async () => {
      await recordConsent(TENANT_ID, PK_JAZZ_NUMBER, { projectId: PROJECT_ID });

      TwilioClientWrapper.setMockHandler(async (_params: SendSmsParams) => {
        twilioCallCount++;
        const err = twilioError(21215, 'Geo-Permission denied');
        err.isNonRetriable = true;
        throw err;
      });

      await DbClient.saveOutboundMessage({
        id: 'out_pk_voice_retry_002',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        from_e164: PRIMARY_SENDER_DID,
        to_e164: PK_JAZZ_NUMBER,
        body: 'Farm status update',
        correlation_id: 'corr_pk_voice_retry_002',
        turn_id: 'corr_pk_voice_retry_002',
        status: 'pending',
        max_retries: 5,
        consent_exempt: false,
      });

      await processOutboundQueue();

      // Despite max_retries=5, Twilio must be called only once
      expect(twilioCallCount).toBe(1);

      const stored = DbClient.getAllMessagesOut().find((m) => m.id === 'out_pk_voice_retry_002');
      expect(stored?.status).toBe('failed');
    });
  });

  // ── B. SMS Carrier Rejection (30005) ───────────────────────────────────────

  describe('B. SMS Carrier-Level Rejection (error 30005)', () => {
    it('classifies 30005 as a non-retriable error', () => {
      const err = twilioError(30005, 'Unknown destination handset');
      expect(TwilioClientWrapper.isNonRetriableError(err)).toBe(true);
    });

    it('immediately marks outbound SMS as permanently failed on 30005 — no retries', async () => {
      await recordConsent(TENANT_ID, PK_JAZZ_NUMBER, { projectId: PROJECT_ID });

      TwilioClientWrapper.setMockHandler(async (_params: SendSmsParams) => {
        twilioCallCount++;
        const err = twilioError(
          30005,
          'Unknown destination handset. The destination carrier (Jazz/Mobilink PK) has permanently rejected this message.'
        );
        err.isNonRetriable = true;
        throw err;
      });

      await DbClient.saveOutboundMessage({
        id: 'out_pk_sms_30005_001',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        from_e164: PRIMARY_SENDER_DID,
        to_e164: PK_JAZZ_NUMBER,
        body: 'Hello from CST — your farm status is ready.',
        correlation_id: 'corr_pk_sms_30005_001',
        turn_id: 'corr_pk_sms_30005_001',
        status: 'pending',
        consent_exempt: false,
      });

      await processOutboundQueue();

      expect(twilioCallCount).toBe(1);

      const stored = DbClient.getAllMessagesOut().find((m) => m.id === 'out_pk_sms_30005_001');
      expect(stored).toBeDefined();
      expect(stored?.status).toBe('failed');
      expect(stored?.error_message).toContain('30005');
    });

    it('classifies 30008 (unknown permanent carrier failure) as non-retriable', () => {
      const err = twilioError(30008, 'Unknown error — permanent carrier delivery failure');
      expect(TwilioClientWrapper.isNonRetriableError(err)).toBe(true);
    });

    it('immediately marks outbound SMS as permanently failed on 30008', async () => {
      await recordConsent(TENANT_ID, PK_JAZZ_NUMBER, { projectId: PROJECT_ID });

      TwilioClientWrapper.setMockHandler(async (_params: SendSmsParams) => {
        twilioCallCount++;
        const err = twilioError(30008, 'Unknown error');
        err.isNonRetriable = true;
        throw err;
      });

      await DbClient.saveOutboundMessage({
        id: 'out_pk_sms_30008_001',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        from_e164: PRIMARY_SENDER_DID,
        to_e164: PK_JAZZ_NUMBER,
        body: 'Farm telemetry notification',
        correlation_id: 'corr_pk_sms_30008_001',
        turn_id: 'corr_pk_sms_30008_001',
        status: 'pending',
        consent_exempt: false,
      });

      await processOutboundQueue();

      expect(twilioCallCount).toBe(1);

      const stored = DbClient.getAllMessagesOut().find((m) => m.id === 'out_pk_sms_30008_001');
      expect(stored?.status).toBe('failed');
      expect(stored?.error_message).toContain('30008');
    });
  });

  // ── C. Retriable errors are still retried (regression guard) ──────────────

  describe('C. Retriable errors are still retried (regression guard)', () => {
    it('retries a transient non-retriable-coded error up to max_retries then succeeds', async () => {
      await recordConsent(TENANT_ID, '+15551230000', { projectId: PROJECT_ID });

      TwilioClientWrapper.setMockHandler(async (_params: SendSmsParams) => {
        twilioCallCount++;
        if (twilioCallCount < 3) {
          // 50300 is NOT in the non-retriable set — simulates a transient 5xx
          const err = twilioError(50300, 'Twilio internal error');
          throw err;
        }
        return { sid: 'SM_TRANSIENT_RECOVERY', status: 'sent' };
      });

      await DbClient.saveOutboundMessage({
        id: 'out_transient_recovery_001',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        from_e164: PRIMARY_SENDER_DID,
        to_e164: '+15551230000',
        body: 'Transient retry test',
        correlation_id: 'corr_transient_001',
        turn_id: 'corr_transient_001',
        status: 'pending',
        max_retries: 3,
        consent_exempt: false,
      });

      await processOutboundQueue();

      // 2 failures + 1 success = 3 total calls
      expect(twilioCallCount).toBe(3);

      const stored = DbClient.getAllMessagesOut().find((m) => m.id === 'out_transient_recovery_001');
      expect(stored?.status).toBe('sent');
    });
  });
});
