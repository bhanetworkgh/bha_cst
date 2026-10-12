/**
 * SMS Consent Spine tests
 *
 * Verifies that consent is strictly separate from identity/authorization:
 * - Consent can be recorded and queried independently
 * - A vFarm member who opted out is blocked from SMS
 * - STOP keywords from any sender (even unknown) are honored
 * - Outbound enforcement blocks opted_out / not_consented
 * - Canonical wording version is stamped server-side (client can't fake it)
 * - Consent is tenant/project scoped
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordConsent,
  recordOptOut,
  getConsentStatus,
  canSendSms,
  handleInboundConsentMessage,
  handleInboundHelpMessage,
  handleInboundResubscribeMessage,
  isConsentPromptValid,
  getConsentPrompt,
  activateConsentViaPrompt,
} from '../../engine/src/consent/service.js';
import {
  CONSENT_WORDING_VERSION,
  CONSENT_WORDING_TEXT,
  getConsentWording,
  STOP_KEYWORDS,
  isOptOutMessage,
  HELP_KEYWORDS,
  isHelpMessage,
} from '../../engine/src/consent/wording.js';
import { DbClient } from '../../engine/src/db/client.js';

const TENANT_A = 'tenant-consent-test-a';
const TENANT_B = 'tenant-consent-test-b';
const PROJECT_A = 'proj-consent-test-a';
const PROJECT_B = 'proj-consent-test-b';

describe('Consent Wording (canonical version)', () => {
  it('defines the canonical wording version and text', () => {
    expect(CONSENT_WORDING_VERSION).toBe('cst_sms_consent_v1');
    expect(CONSENT_WORDING_TEXT).toContain('text messages');
    expect(CONSENT_WORDING_TEXT).toContain('Customer Service Twin');
    expect(CONSENT_WORDING_TEXT.length).toBeGreaterThan(50);
  });

  it('getConsentWording returns the same canonical version/text', () => {
    const w = getConsentWording();
    expect(w.version).toBe(CONSENT_WORDING_VERSION);
    expect(w.text).toBe(CONSENT_WORDING_TEXT);
  });

  it('exposes the canonical Twilio STOP keyword set', () => {
    expect(STOP_KEYWORDS.has('stop')).toBe(true);
    expect(STOP_KEYWORDS.has('stopall')).toBe(true);
    expect(STOP_KEYWORDS.has('unsubscribe')).toBe(true);
    expect(STOP_KEYWORDS.has('quit')).toBe(true);
    expect(STOP_KEYWORDS.has('end')).toBe(true);
    expect(STOP_KEYWORDS.has('cancel')).toBe(true);
    expect(STOP_KEYWORDS.size).toBe(6);
  });
});

describe('isOptOutMessage', () => {
  it('detects exact STOP keyword match', () => {
    expect(isOptOutMessage('stop')).toBe(true);
    expect(isOptOutMessage('STOP')).toBe(true);
    expect(isOptOutMessage('Cancel')).toBe(true);
    expect(isOptOutMessage('unsubscribe')).toBe(true);
  });

  it('detects STOP keyword with surrounding text', () => {
    expect(isOptOutMessage('please stop')).toBe(true);
    expect(isOptOutMessage('I want to unsubscribe from these messages')).toBe(true);
    expect(isOptOutMessage('QUIT')).toBe(true);
  });

  it('does not false-positive on normal text', () => {
    expect(isOptOutMessage('hello')).toBe(false);
    expect(isOptOutMessage('what is my farm status')).toBe(false);
    expect(isOptOutMessage('')).toBe(false);
    expect(isOptOutMessage('stopped')).toBe(false);
  });
});

describe('Consent Recording & Status', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  it('records consent with canonical wording version stamped server-side', async () => {
    const record = await recordConsent(TENANT_A, '+15551112222', {
      projectId: PROJECT_A,
      source: 'cst_onboarding',
    });

    expect(record.consent_status).toBe('opted_in');
    expect(record.wording_version).toBe(CONSENT_WORDING_VERSION);
    expect(record.wording_snapshot).toBe(CONSENT_WORDING_TEXT);
    expect(record.consent_status).toBe('opted_in');
    expect(record.consented_at).toBeTruthy();
    expect(record.opted_out_at).toBeNull();
    expect(record.source).toBe('cst_onboarding');
  });

  it('returns not_consented when no record exists', async () => {
    const { status, record } = await getConsentStatus(TENANT_A, '+15559998888');
    expect(status).toBe('not_consented');
    expect(record).toBeNull();
  });

  it('returns opted_in after recording consent', async () => {
    await recordConsent(TENANT_A, '+15551112222');
    const { status } = await getConsentStatus(TENANT_A, '+15551112222');
    expect(status).toBe('opted_in');
  });

  it('records opt-out and transitions status to opted_out', async () => {
    await recordConsent(TENANT_A, '+15551112222');
    await recordOptOut(TENANT_A, '+15551112222', { reason: 'test stop' });

    const { status, record } = await getConsentStatus(TENANT_A, '+15551112222');
    expect(status).toBe('opted_out');
    expect(record?.consent_status).toBe('opted_out');
    expect(record?.opted_out_at).toBeTruthy();
  });

  it('can record opt-out even when no prior consent exists (STOP from unknown caller)', async () => {
    const record = await recordOptOut(TENANT_A, '+15559998888');
    expect(record.consent_status).toBe('opted_out');
    expect(record.opted_out_at).toBeTruthy();

    const { status } = await getConsentStatus(TENANT_A, '+15559998888');
    expect(status).toBe('opted_out');
  });
});

describe('Tenant & Project Isolation', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  it('does not leak consent across tenants', async () => {
    await recordConsent(TENANT_A, '+15551112222', { projectId: PROJECT_A });

    const { status: statusA, record: recordA } = await getConsentStatus(
      TENANT_A, '+15551112222', PROJECT_A,
    );
    const { status: statusB, record: recordB } = await getConsentStatus(
      TENANT_B, '+15551112222', PROJECT_A,
    );

    expect(statusA).toBe('opted_in');
    expect(recordA).not.toBeNull();
    expect(statusB).toBe('not_consented');
    expect(recordB).toBeNull();
  });

  it('does not leak consent across projects within same tenant', async () => {
    await recordConsent(TENANT_A, '+15551112222', { projectId: PROJECT_A });

    const { status, record } = await getConsentStatus(TENANT_A, '+15551112222', PROJECT_B);
    expect(status).toBe('not_consented');
    expect(record).toBeNull();
  });
});

describe('canSendSms (outbound enforcement)', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  it('allows SMS for opted_in phone', async () => {
    await recordConsent(TENANT_A, '+15551112222');
    const result = await canSendSms(TENANT_A, '+15551112222');
    expect(result.allowed).toBe(true);
    expect(result.status).toBe('opted_in');
  });

  it('blocks SMS for opted_out phone', async () => {
    await recordConsent(TENANT_A, '+15551112222');
    await recordOptOut(TENANT_A, '+15551112222');

    const result = await canSendSms(TENANT_A, '+15551112222');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('opted_out');
    expect(result.reason).toContain('opted out');
  });

  it('blocks SMS for not_consented phone (no prior record)', async () => {
    const result = await canSendSms(TENANT_A, '+15559998888');
    expect(result.allowed).toBe(false);
    expect(result.status).toBe('not_consented');
    expect(result.reason).toContain('not consented');
  });

  it('allows SMS for opted_in phone scoped to one project even if opted_out on another', async () => {
    await recordConsent(TENANT_A, '+15551112222', { projectId: PROJECT_A });
    await recordOptOut(TENANT_A, '+15551112222', { projectId: PROJECT_B });

    const r1 = await canSendSms(TENANT_A, '+15551112222', PROJECT_A);
    const r2 = await canSendSms(TENANT_A, '+15551112222', PROJECT_B);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
  });
});

describe('handleInboundConsentMessage (STOP from inbound pipeline)', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  it('detects STOP and records opt-out, returns details', async () => {
    const result = await handleInboundConsentMessage(
      TENANT_A, '+15551112222', 'please stop', PROJECT_A, 'corr_stop_001',
    );

    expect(result).not.toBeNull();
    expect(result!.isOptOut).toBe(true);
    expect(result!.record).not.toBeNull();
    expect(result!.record!.consent_status).toBe('opted_out');
    expect(result!.reason).toContain('opted out');
  });

  it('returns null for non-STOP messages (passes through to Core Engine)', async () => {
    const result = await handleInboundConsentMessage(
      TENANT_A, '+15551112222', 'what is my farm status', PROJECT_A, 'corr_002',
    );
    expect(result).toBeNull();
  });

  it('records opt-out for unknown caller (no prior consent) via STOP', async () => {
    const result = await handleInboundConsentMessage(
      TENANT_A, '+15559998888', 'unsubscribe', undefined, 'corr_unknown_001',
    );

    expect(result).not.toBeNull();
    expect(result!.isOptOut).toBe(true);
    expect(result!.record!.consent_status).toBe('opted_out');
  });
});

describe('Audit Trail', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  it('records audit entries on consent grant and opt-out', async () => {
    await recordConsent(TENANT_A, '+15551112222', {
      projectId: PROJECT_A,
      source: 'test',
    });
    await recordOptOut(TENANT_A, '+15551112222', {
      projectId: PROJECT_A,
      source: 'test_stop',
    });

    const audit = await DbClient.getSmsConsentAuditForPhone(
      '+15551112222', TENANT_A, PROJECT_A,
    );

    expect(audit.length).toBe(2);
    expect(audit[0].action).toBe('consent_granted');
    expect(audit[1].action).toBe('consent_revoked');
    expect(audit[0].wording_version).toBe(CONSENT_WORDING_VERSION);
    expect(audit[1].wording_version).toBe(CONSENT_WORDING_VERSION);
  });
});

describe('HELP Keywords and Inbound Response', () => {
  it('detects HELP and INFO keywords', () => {
    expect(HELP_KEYWORDS.has('help')).toBe(true);
    expect(HELP_KEYWORDS.has('info')).toBe(true);
    expect(isHelpMessage('help')).toBe(true);
    expect(isHelpMessage('HELP')).toBe(true);
    expect(isHelpMessage('Info')).toBe(true);
    expect(isHelpMessage('i need help please')).toBe(true);
    expect(isHelpMessage('helpful')).toBe(false);
  });

  it('handleInboundHelpMessage returns canonical help wording', async () => {
    const res = await handleInboundHelpMessage(
      TENANT_A,
      '+15551112222',
      'help',
      PROJECT_A,
      'corr_help_001',
    );
    expect(res).not.toBeNull();
    expect(res!.isHelp).toBe(true);
    expect(res!.helpBody).toContain('Customer Service Twin for vFarm support');
    expect(res!.helpBody).toContain('support@bhanetwork.org');
    expect(res!.helpBody).toContain('STOP');
  });
});

describe('Re-subscribe and Prompt Evidence Lifecycle', () => {
  beforeEach(() => {
    DbClient.clearAll();
  });

  it('handleInboundResubscribeMessage only generates prompt if caller is opted_out', async () => {
    // When caller is not opted out, START returns null
    const noPrompt = await handleInboundResubscribeMessage(
      TENANT_A,
      '+15551112222',
      'START',
      PROJECT_A,
    );
    expect(noPrompt).toBeNull();

    // After caller opts out, START generates prompt and returns canonical wording
    await recordOptOut(TENANT_A, '+15551112222', { projectId: PROJECT_A });
    const promptRes = await handleInboundResubscribeMessage(
      TENANT_A,
      '+15551112222',
      'START',
      PROJECT_A,
      'corr_resub_001',
    );
    expect(promptRes).not.toBeNull();
    expect(promptRes!.isResubscribe).toBe(true);
    expect(promptRes!.promptBody).toContain(CONSENT_WORDING_TEXT);

    // Verify prompt validity
    const isValid = await isConsentPromptValid(
      '+15551112222',
      TENANT_A,
      PROJECT_A,
    );
    expect(isValid).toBe(true);

    // Affirmative activation
    const activePrompt = await getConsentPrompt(
      '+15551112222',
      TENANT_A,
      PROJECT_A,
    );
    expect(activePrompt).not.toBeNull();

    const activation = await activateConsentViaPrompt(
      activePrompt!.id,
      TENANT_A,
      '+15551112222',
      { projectId: PROJECT_A, source: 'resubscribe_yes' },
    );
    expect(activation.consent.consent_status).toBe('opted_in');
    expect(activation.consent.opted_out_at).toBeNull();

    const currentStatus = await getConsentStatus(
      TENANT_A,
      '+15551112222',
      PROJECT_A,
    );
    expect(currentStatus.status).toBe('opted_in');
    expect(currentStatus.record?.opted_out_at).toBeNull();
  });
});
