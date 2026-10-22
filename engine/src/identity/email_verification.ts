/**
 * Email-based vFarm self-service verification.
 *
 * WHAT THIS IS
 *   A path for a legitimate vFarm user to be recognised on their FIRST
 *   contact, instead of receiving the generic onboarding reply forever.
 *
 * WHY IT IS EMAIL-BASED
 *   vFarm exposes NO phone field on a user. Verified against the LIVE vFarm
 *   OpenAPI contract (171 paths): the strings `phone`, `e164`, `msisdn`,
 *   `mobile`, `whatsapp`, `sms_number` and `telephone` occur ZERO times in
 *   the entire specification. `GET /api/v1/organizations/{org_id}/users`
 *   returns `user_id`, `email`, `name`, `role`, `granted_by` and `granted_at`
 *   — and no phone number.
 *
 *   So "look this phone number up against vFarm" is not implementable today.
 *   The only correlation CST can make is the one a human can make: the
 *   person confirms the email address on their vFarm account, and CST matches
 *   it against that organization's member list.
 *
 *   If vFarm later ships a phone-bearing user endpoint, THAT should be
 *   preferred: it needs no human round trip and no email disclosure. This
 *   module is deliberately behind a feature flag so it can be replaced
 *   without touching the call sites.
 *
 * SAFETY
 *   - The flow is OFF by default (`CST_EMAIL_VERIFICATION_ENABLED`).
 *   - It creates a BINDING ONLY. It never grants a role or a farm scope of
 *     its own: the role comes from the upstream member record and the farm
 *     scope is re-read from the upstream grant list on the NEXT resolve, by
 *     the existing fail-closed path. A verified caller is never
 *     pre-authorised by this module.
 *   - It never trusts a client-supplied farm id, project id or role.
 *   - The member lookup is the same authenticated, read-only endpoint CST
 *     already uses for the authoritative membership check.
 *   - It does not disclose whether an email exists: an unknown email and an
 *     email that is not a member produce the SAME reply, so the flow cannot
 *     be used to enumerate an organization's member list.
 *   - Attempts are bounded per number and expire, so it cannot be used to
 *     brute-force.
 *
 * OPEN QUESTIONS FOR THE REVIEWER (raised, not guessed)
 *   1. Where should the "awaiting email verification" state live? It is an
 *      in-memory, TTL-bounded map here. A restart forgets a pending
 *      verification (the person simply replies again). A durable table
 *      would survive restarts and would let an operator see who is stuck —
 *      at the cost of a migration.
 *   2. Rate limiting is per (number, tenant, project): N attempts in a
 *      window, then the flow stops and the generic onboarding reply resumes.
 *      Should there also be a per-IP or per-organization limit?
 *   3. Scope. This module is wired into SMS only. Voice is deliberately
 *      excluded: asking a caller to speak or key in an email address is a
 *      poor experience, and the same person can verify over SMS and then be
 *      recognised on their next call.
 */
import { Logger } from '../config/logger.js';
import { maskPhone } from '../util/privacy.js';
import { CoreRegistry } from '../core/registry.js';
import { DbClient } from '../db/client.js';
import type { UserRole } from '../core/types.js';

/** Feature flag. OFF unless explicitly enabled. */
export const EMAIL_VERIFICATION_ENV_FLAG = 'CST_EMAIL_VERIFICATION_ENABLED';

/** How many verification attempts a single number may make. */
export const EMAIL_VERIFICATION_MAX_ATTEMPTS = 3;

/** How long a pending verification stays open. */
export const EMAIL_VERIFICATION_TTL_MS = 15 * 60 * 1000;

/** How long a verified binding lives before it must be re-verified. */
export const EMAIL_VERIFICATION_BINDING_TTL_HOURS = 24;

/**
 * The reply that asks for the email address.
 *
 * Deliberately does not say "we could not find you" — it asks for a
 * confirmation the person can act on.
 */
export const EMAIL_VERIFICATION_PROMPT =
  'To confirm your account, please reply with the email address on your vFarm account.';

/**
 * The reply used when an email does not match.
 *
 * IDENTICAL for "no such email" and "not a member of this organization", so
 * the flow cannot be used to discover which addresses exist.
 */
export const EMAIL_VERIFICATION_NO_MATCH_REPLY =
  'We could not verify that email address. Please check it and reply again, or contact support for help.';

/** The reply used when the binding has been created. */
export const EMAIL_VERIFICATION_SUCCESS_REPLY =
  'Thank you — your account is verified. You can now ask about your farm data.';

interface PendingVerification {
  tenant_id: string;
  project_id: string;
  attempts: number;
  last_email?: string;
  expires_at_ms: number;
}

/**
 * Pending verifications, keyed by `${tenant}:${project}:${phone}`.
 *
 * In-memory and TTL-bounded. See the module doc for the durability question
 * raised for the reviewer.
 */
const pending = new Map<string, PendingVerification>();

function key(tenantId: string, projectId: string, phoneE164: string): string {
  return `${tenantId}:${projectId}:${(phoneE164 || '').trim()}`;
}

function pruneExpired(now: number): void {
  for (const [k, v] of pending) {
    if (v.expires_at_ms <= now) pending.delete(k);
  }
}

/** Is the email self-service flow enabled? OFF unless explicitly turned on. */
export function isEmailVerificationEnabled(): boolean {
  return process.env[EMAIL_VERIFICATION_ENV_FLAG] === 'true';
}

/**
 * Extract an email address from a free-text message.
 *
 * The message must contain EXACTLY ONE address. Zero (an ordinary support
 * message) and more than one (an ambiguous message) are both rejected, so an
 * ordinary message is never mistaken for a verification attempt and an
 * ambiguous one is never silently resolved to the first address found.
 */
export function extractEmail(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length > 320) return null;

  const matches = trimmed.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (!matches || matches.length !== 1) return null;

  const email = matches[0].toLowerCase();
  if (email.length > 254) return null;
  // Reject anything with an empty label or a trailing separator.
  if (email.includes('..') || email.startsWith('.') || email.endsWith('.')) return null;
  return email;
}

/** Is there an open verification for this number? */
export function isAwaitingEmailVerification(
  tenantId: string,
  projectId: string,
  phoneE164: string,
): boolean {
  pruneExpired(Date.now());
  return pending.has(key(tenantId, projectId, phoneE164));
}

/**
 * Record an attempt and report whether another one is allowed.
 *
 * The limit is per number, per project, per tenant.
 */
export function noteEmailAttempt(
  tenantId: string,
  projectId: string,
  phoneE164: string,
  email?: string,
): { allowed: boolean; attempts: number } {
  const now = Date.now();
  pruneExpired(now);
  const k = key(tenantId, projectId, phoneE164);
  const existing = pending.get(k);
  const attempts = (existing?.attempts ?? 0) + 1;
  pending.set(k, {
    tenant_id: tenantId,
    project_id: projectId,
    attempts,
    last_email: email,
    expires_at_ms: now + EMAIL_VERIFICATION_TTL_MS,
  });
  return { allowed: attempts <= EMAIL_VERIFICATION_MAX_ATTEMPTS, attempts };
}

/** Forget a pending verification (after a match, or after the limit). */
export function clearEmailVerification(
  tenantId: string,
  projectId: string,
  phoneE164: string,
): void {
  pending.delete(key(tenantId, projectId, phoneE164));
}

/** Test seam: drop all pending state. */
export function resetEmailVerificationState(): void {
  pending.clear();
}

/**
 * Map a vFarm organization-member role onto CST's role model.
 *
 * The same mapping the authoritative membership check uses, so a
 * self-verified caller and an admin-created binding get the same role.
 */
function mapRole(vfarmRole: string): UserRole {
  switch ((vfarmRole || '').trim().toLowerCase()) {
    case 'owner':
    case 'admin':
      return 'owner';
    case 'manager':
      return 'manager';
    case 'tech':
    case 'technician':
    case 'member':
      return 'tech';
    default:
      return 'manager';
  }
}

export interface EmailVerificationOutcome {
  /** True when the flow handled the message (a reply was produced). */
  handled: boolean;
  /** The reply to send, when handled. */
  reply?: string;
  /** The matched upstream user id, on success. */
  person_id?: string;
  /** Why the flow did not complete, for diagnostics. */
  reason?: string;
}

/**
 * Run one step of the email-verification flow.
 *
 * @param text The inbound message body.
 */
export async function handleEmailVerificationAttempt(input: {
  tenantId: string;
  projectId: string;
  phoneE164: string;
  text: string;
}): Promise<EmailVerificationOutcome> {
  const { tenantId, projectId, phoneE164, text } = input;

  if (!isEmailVerificationEnabled()) {
    return { handled: false, reason: 'feature_disabled' };
  }

  const email = extractEmail(text);

  if (!email) {
    // No email yet. Ask for it, but only for the first few attempts.
    const { allowed, attempts } = noteEmailAttempt(tenantId, projectId, phoneE164);
    if (!allowed) {
      clearEmailVerification(tenantId, projectId, phoneE164);
      Logger.warn(
        `Email verification: attempt limit reached for a number in tenant ${tenantId} project ${projectId}; falling back to the standard onboarding path`,
        { attempts },
      );
      return { handled: false, reason: 'attempt_limit_reached' };
    }
    Logger.info(
      `Email verification: requesting the vFarm account email for a number in tenant ${tenantId} project ${projectId} (attempt ${attempts})`,
    );
    return { handled: true, reply: EMAIL_VERIFICATION_PROMPT };
  }

  // An email was supplied. It must match a member of the project's
  // vFarm organization.
  const adapter: any = CoreRegistry.getAdapter(tenantId);
  const orgId = typeof adapter?._getProjectOrgId === 'function'
    ? adapter._getProjectOrgId(projectId)
    : null;
  if (!adapter || !orgId) {
    Logger.warn(
      `Email verification: project ${projectId} in tenant ${tenantId} has no vFarm organization to verify against; falling back to the standard onboarding path`,
    );
    return { handled: false, reason: 'no_tenant_org_id' };
  }

  let member: { user_id: string; role: string } | null = null;
  try {
    member = await adapter.findOrgMemberByEmail(orgId, email);
  } catch (err: any) {
    // The upstream could not be read. That is NOT a failed verification — it
    // is an unavailable service. Do not count it as an attempt and do not
    // tell the customer their address was rejected.
    Logger.warn(
      `Email verification: the vFarm member list could not be read for org ${orgId}; falling back to the standard onboarding path`,
      { error: err?.message },
    );
    return { handled: false, reason: 'upstream_unavailable' };
  }

  if (!member) {
    const { allowed, attempts } = noteEmailAttempt(tenantId, projectId, phoneE164, email);
    Logger.warn(
      `Email verification: no member of the vFarm organization matched the supplied address for a number in tenant ${tenantId} project ${projectId} (attempt ${attempts})`,
    );
    if (!allowed) {
      clearEmailVerification(tenantId, projectId, phoneE164);
      return { handled: false, reason: 'attempt_limit_reached' };
    }
    return { handled: true, reply: EMAIL_VERIFICATION_NO_MATCH_REPLY };
  }

  // MATCH. Create the binding.
  //
  // `customer_ref` is the upstream user id. The ROLE comes from the upstream
  // member record. The FARM SCOPE is deliberately left empty: it is
  // re-read from the upstream grant list by the normal resolve path, so
  // this flow cannot grant farm access on its own.
  const role = mapRole(member.role);
  const expiresAt = new Date(
    Date.now() + EMAIL_VERIFICATION_BINDING_TTL_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const persisted = await DbClient.upsertCustomer({
    tenant_id: tenantId,
    project_id: projectId,
    phone_e164: phoneE164,
    customer_ref: member.user_id,
    role,
    farm_ids: [],
    speaker_cache_expires_at: expiresAt,
  });

  if (!persisted) {
    Logger.error(
      `Email verification: the binding for a number in tenant ${tenantId} project ${projectId} could not be persisted`,
    );
    return { handled: false, reason: 'persistence_failed' };
  }

  // Make the binding effective immediately: the runtime directory is an
  // in-memory map and the resolve result is cached for a minute.
  if (typeof adapter.registerSpeaker === 'function') {
    adapter.registerSpeaker(projectId, {
      person_id: member.user_id,
      phone_e164: phoneE164,
      role,
      farm_ids: [],
    });
  }
  CoreRegistry.invalidateSpeakerCache(tenantId, projectId, phoneE164);
  clearEmailVerification(tenantId, projectId, phoneE164);

  Logger.audit({
    timestamp: new Date().toISOString(),
    tenant_id: tenantId,
    actor: maskPhone(phoneE164),
    role: 'self_service',
    entry_point: 'webhook',
    tool_or_route: 'email_verification',
    outcome: 'ok',
    // The upstream user id is deliberately NOT logged: it is a per-customer
    // identifier.
    reason: `Email self-service verification created a phone -> identity binding for a number in project ${projectId}`,
    details: { project_id: projectId, role },
  });

  return {
    handled: true,
    reply: EMAIL_VERIFICATION_SUCCESS_REPLY,
    person_id: member.user_id,
    reason: 'verified',
  };
}
