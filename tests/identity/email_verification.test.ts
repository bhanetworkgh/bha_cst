/**
 * Email-based vFarm self-service verification — regression tests.
 *
 * vFarm exposes NO phone field on a user (verified against the LIVE OpenAPI
 * contract: `phone`, `e164`, `msisdn`, `mobile`, `whatsapp`, `sms_number` and
 * `telephone` occur ZERO times in the specification). So "look this number
 * up against vFarm" is not implementable, and the only correlation CST can
 * make is the one a person can make: they confirm the email address on
 * their vFarm account.
 *
 * The flow is FEATURE-FLAGGED AND OFF BY DEFAULT. These tests cover:
 *   - the flag;
 *   - email extraction;
 *   - the attempt limit;
 *   - a match creating a binding with the UPSTREAM role and NO farm scope;
 *   - a non-match producing a reply that does not disclose whether the
 *     address exists;
 *   - an unreadable upstream NOT counting as an attempt and NOT rejecting
 *     the address.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  EMAIL_VERIFICATION_ENV_FLAG,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_NO_MATCH_REPLY,
  EMAIL_VERIFICATION_PROMPT,
  clearEmailVerification,
  extractEmail,
  handleEmailVerificationAttempt,
  isAwaitingEmailVerification,
  isEmailVerificationEnabled,
  noteEmailAttempt,
  resetEmailVerificationState,
} from '../../engine/src/identity/email_verification.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';
const PHONE = '+15551234567';
const ORG = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';

const MEMBER = {
  user_id: 'debf555c-b37d-4e92-bb15-597e169f1b38',
  email: 'Farmer@vfarm.test',
  name: 'Farmer',
  role: 'admin',
  granted_by: null,
  granted_at: '2026-01-01T00:00:00Z',
};

/** Install an adapter whose org-member lookup returns `members` (or throws). */
function installAdapter(opts: { members?: any[]; throwOnLookup?: Error } = {}) {
  const adapter: any = {
    _getProjectOrgId: () => ORG,
    findOrgMemberByEmail: vi.fn(async (_org: string, email: string) => {
      if (opts.throwOnLookup) throw opts.throwOnLookup;
      const needle = email.trim().toLowerCase();
      const found = (opts.members ?? [MEMBER]).find(
        (m) => (m.email || '').trim().toLowerCase() === needle,
      );
      return found ? { user_id: found.user_id, role: found.role, name: found.name } : null;
    }),
    registerSpeaker: vi.fn(),
  };
  CoreRegistry.registerTenant(
    { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
    adapter,
  );
  return adapter;
}

describe('email verification — feature flag', () => {
  beforeEach(() => {
    delete process.env[EMAIL_VERIFICATION_ENV_FLAG];
    resetEmailVerificationState();
  });
  afterEach(() => {
    delete process.env[EMAIL_VERIFICATION_ENV_FLAG];
    vi.restoreAllMocks();
  });

  it('is OFF by default', () => {
    expect(isEmailVerificationEnabled()).toBe(false);
  });

  it('is ON only when explicitly enabled', () => {
    process.env[EMAIL_VERIFICATION_ENV_FLAG] = 'true';
    expect(isEmailVerificationEnabled()).toBe(true);
    process.env[EMAIL_VERIFICATION_ENV_FLAG] = 'false';
    expect(isEmailVerificationEnabled()).toBe(false);
  });

  it('does nothing at all when the flag is off', async () => {
    const adapter = installAdapter();
    const outcome = await handleEmailVerificationAttempt({
      tenantId: TENANT,
      projectId: PROJECT,
      phoneE164: PHONE,
      text: 'farmer@vfarm.test',
    });
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe('feature_disabled');
    expect(adapter.findOrgMemberByEmail).not.toHaveBeenCalled();
  });
});

describe('email verification — email extraction', () => {
  it('accepts a bare address', () => {
    expect(extractEmail('farmer@vfarm.test')).toBe('farmer@vfarm.test');
    expect(extractEmail('  Farmer@vfarm.test  ')).toBe('farmer@vfarm.test');
  });

  it('accepts a short salutation around the address', () => {
    expect(extractEmail('hi, farmer@vfarm.test')).toBe('farmer@vfarm.test');
    expect(extractEmail('my email is farmer@vfarm.test')).toBe('farmer@vfarm.test');
  });

  it('rejects ordinary messages', () => {
    expect(extractEmail('what is the weather')).toBeNull();
    expect(extractEmail('')).toBeNull();
    expect(extractEmail('farmer at vfarm dot test')).toBeNull();
  });

  it('rejects a message that merely mentions several addresses', () => {
    // Ambiguous input must not be treated as a verification attempt.
    expect(extractEmail('a@b.test and c@d.test')).toBeNull();
  });
});

describe('email verification — attempt limit', () => {
  beforeEach(() => {
    process.env[EMAIL_VERIFICATION_ENV_FLAG] = 'true';
    resetEmailVerificationState();
  });
  afterEach(() => {
    delete process.env[EMAIL_VERIFICATION_ENV_FLAG];
    vi.restoreAllMocks();
  });

  it('bounds the attempts for one number', () => {
    for (let i = 0; i < EMAIL_VERIFICATION_MAX_ATTEMPTS; i++) {
      const { allowed } = noteEmailAttempt(TENANT, PROJECT, PHONE);
      expect(allowed).toBe(true);
    }
    const { allowed } = noteEmailAttempt(TENANT, PROJECT, PHONE);
    expect(allowed).toBe(false);
  });

  it('tracks the attempts per number, not globally', () => {
    noteEmailAttempt(TENANT, PROJECT, PHONE);
    const other = noteEmailAttempt(TENANT, PROJECT, '+15550000000');
    expect(other.allowed).toBe(true);
    expect(other.attempts).toBe(1);
  });

  it('reports an open verification and clears it on request', () => {
    expect(isAwaitingEmailVerification(TENANT, PROJECT, PHONE)).toBe(false);
    noteEmailAttempt(TENANT, PROJECT, PHONE);
    expect(isAwaitingEmailVerification(TENANT, PROJECT, PHONE)).toBe(true);
    clearEmailVerification(TENANT, PROJECT, PHONE);
    expect(isAwaitingEmailVerification(TENANT, PROJECT, PHONE)).toBe(false);
  });
});

describe('email verification — the flow', () => {
  beforeEach(() => {
    process.env[EMAIL_VERIFICATION_ENV_FLAG] = 'true';
    resetEmailVerificationState();
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });
  afterEach(() => {
    delete process.env[EMAIL_VERIFICATION_ENV_FLAG];
    vi.restoreAllMocks();
  });

  it('asks for the email address when the caller has not sent one', async () => {
    installAdapter();
    const outcome = await handleEmailVerificationAttempt({
      tenantId: TENANT,
      projectId: PROJECT,
      phoneE164: PHONE,
      text: 'hello, is anyone there?',
    });

    expect(outcome.handled).toBe(true);
    expect(outcome.reply).toBe(EMAIL_VERIFICATION_PROMPT);
  });

  it('creates the binding on a match, with the UPSTREAM role and NO farm scope', async () => {
    const adapter = installAdapter();

    const outcome = await handleEmailVerificationAttempt({
      tenantId: TENANT,
      projectId: PROJECT,
      phoneE164: PHONE,
      text: 'farmer@vfarm.test',
    });

    expect(outcome.handled).toBe(true);
    expect(outcome.person_id).toBe(MEMBER.user_id);

    // The binding is persisted with the upstream user id and the role the
    // upstream member record carries (admin -> owner).
    const stored = await DbClient.getAllCustomers(TENANT, PROJECT);
    expect(stored).toHaveLength(1);
    expect(stored[0].customer_ref).toBe(MEMBER.user_id);
    expect(stored[0].role).toBe('owner');
    expect(stored[0].phone_e164).toBe(PHONE);

    // NO farm scope is granted by this flow — the upstream grant list is the
    // authority and is re-read by the normal resolve path.
    expect(stored[0].farm_ids ?? []).toEqual([]);

    // The runtime directory is updated and the resolve cache invalidated, so
    // the caller is recognised on their NEXT message.
    expect(adapter.registerSpeaker).toHaveBeenCalledTimes(1);
    const registered = adapter.registerSpeaker.mock.calls[0][1];
    expect(registered.person_id).toBe(MEMBER.user_id);
    expect(registered.role).toBe('owner');
    expect(registered.farm_ids).toEqual([]);
  });

  it('matches the email case-insensitively', async () => {
    installAdapter({ members: [MEMBER] });
    const outcome = await handleEmailVerificationAttempt({
      tenantId: TENANT,
      projectId: PROJECT,
      phoneE164: PHONE,
      text: 'FARMER@VFARM.TEST',
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.person_id).toBe(MEMBER.user_id);
  });

  it('does not disclose whether an address exists', async () => {
    installAdapter({ members: [MEMBER] });

    const unknown = await handleEmailVerificationAttempt({
      tenantId: TENANT,
      projectId: PROJECT,
      phoneE164: PHONE,
      text: 'nobody@vfarm.test',
    });

    // The reply is the same for "no such address" and "not a member": it
    // cannot be used to enumerate the organization's member list.
    expect(unknown.handled).toBe(true);
    expect(unknown.reply).toBe(EMAIL_VERIFICATION_NO_MATCH_REPLY);
    expect(unknown.reply).not.toContain('not found');
    expect(unknown.reply).not.toContain('no such');
    expect(unknown.person_id).toBeUndefined();
  });

  it('does not count an unreadable upstream as a failed attempt', async () => {
    installAdapter({ throwOnLookup: new Error('upstream 503') });

    const outcome = await handleEmailVerificationAttempt({
      tenantId: TENANT,
      projectId: PROJECT,
      phoneE164: PHONE,
      text: 'farmer@vfarm.test',
    });

    // The upstream being unavailable is not the customer's fault and must not
    // tell them their address was rejected.
    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe('upstream_unavailable');
    expect(isAwaitingEmailVerification(TENANT, PROJECT, PHONE)).toBe(false);
  });

  it('falls back when the project has no vFarm organization', async () => {
    const adapter: any = {
      _getProjectOrgId: () => null,
      findOrgMemberByEmail: vi.fn(),
      registerSpeaker: vi.fn(),
    };
    CoreRegistry.registerTenant(
      { tenant_id: TENANT, name: 'vFarm', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    const outcome = await handleEmailVerificationAttempt({
      tenantId: TENANT,
      projectId: PROJECT,
      phoneE164: PHONE,
      text: 'farmer@vfarm.test',
    });

    expect(outcome.handled).toBe(false);
    expect(outcome.reason).toBe('no_tenant_org_id');
    expect(adapter.findOrgMemberByEmail).not.toHaveBeenCalled();
  });

  it('stops offering the flow after the attempt limit', async () => {
    installAdapter({ members: [] });

    let last: any;
    for (let i = 0; i <= EMAIL_VERIFICATION_MAX_ATTEMPTS; i++) {
      last = await handleEmailVerificationAttempt({
        tenantId: TENANT,
        projectId: PROJECT,
        phoneE164: PHONE,
        text: 'nobody@vfarm.test',
      });
    }

    // The last attempt exhausts the allowance and the flow hands back to the
    // standard onboarding path.
    expect(last.handled).toBe(false);
    expect(last.reason).toBe('attempt_limit_reached');
    expect(isAwaitingEmailVerification(TENANT, PROJECT, PHONE)).toBe(false);
  });
});
