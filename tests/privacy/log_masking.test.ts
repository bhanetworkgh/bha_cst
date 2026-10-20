/**
 * Regression test for log/audit PII masking.
 *
 * CST logs and SECURITY_LEDGER entries are retained and read by operators,
 * auditors and reviewers, so they must not carry raw customer phone numbers.
 * The Operator Playbook's evidence-sanitization rule is the policy: keep the
 * last 2–4 digits, mask the rest.
 *
 * This file pins the masking for the compliance-critical surface — the SMS
 * consent decision records, which are the entries an auditor reads to justify
 * why a message was or was not sent.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { maskPhone } from '../../engine/src/util/privacy.js';
import { canSendSms, recordOptOut } from '../../engine/src/consent/service.js';
import { DbClient } from '../../engine/src/db/client.js';
import { Logger } from '../../engine/src/config/logger.js';

describe('Log/audit PII masking', () => {
  const PHONE = '+15551234567';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── The helper ────────────────────────────────────────────────────────────

  it('keeps only the last four digits of a phone number', () => {
    expect(maskPhone(PHONE)).toBe('+1555***4567');
  });

  it('returns an empty string for an absent number', () => {
    expect(maskPhone(null)).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });

  it('does not mask a value too short to mask safely', () => {
    expect(maskPhone('+1')).toBe('+1');
  });

  it('never returns the raw number for a full-length input', () => {
    expect(maskPhone(PHONE)).not.toContain('51234567');
    expect(maskPhone(PHONE)).toContain('4567');
  });

  // ── The consent decision records ──────────────────────────────────────────

  describe('canSendSms audit entries', () => {
    let auditSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      DbClient.clearAll();
      DbClient.resetDurableStores();
      auditSpy = vi.spyOn(Logger, 'audit').mockImplementation(() => {});
    });

    it('does not put the raw recipient number in the opt-out refusal record', async () => {
      await recordOptOut('tenant-vfarm-01', PHONE, { reason: 'test stop', projectId: 'proj-vfarm-main' });

      const result = await canSendSms('tenant-vfarm-01', PHONE, 'proj-vfarm-main');

      expect(result.allowed).toBe(false);
      expect(result.reason).not.toContain(PHONE);
      expect(result.reason).toContain(maskPhone(PHONE));

      const entries = auditSpy.mock.calls.map((c) => c[0] as any);
      const refusal = entries.find((e) => String(e?.reason ?? '').includes('opted out'));
      expect(refusal).toBeDefined();
      expect(String(refusal.reason)).not.toContain(PHONE);
    });

    it('does not put the raw recipient number in the no-consent refusal record', async () => {
      const result = await canSendSms('tenant-vfarm-01', PHONE, 'proj-vfarm-main');

      expect(result.allowed).toBe(false);
      expect(result.reason).not.toContain(PHONE);
      expect(result.reason).toContain(maskPhone(PHONE));

      const entries = auditSpy.mock.calls.map((c) => c[0] as any);
      const refusal = entries.find((e) => String(e?.reason ?? '').includes('no SMS consent record'));
      expect(refusal).toBeDefined();
      expect(String(refusal.reason)).not.toContain(PHONE);
    });
  });
});
