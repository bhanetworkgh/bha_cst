/**
 * SMS Consent Spine — Service Layer
 *
 * Provides a single consent-aware API for:
 *   - Recording opt-ins (onboarding, admin)
 *   - Recording opt-outs (STOP, admin)
 *   - Querying consent state (opted_in | opted_out | not_consented)
 *   - Enforcing consent at the outbound SMS boundary
 *
 * CST identity (phone → vFarm member → farm authorization) and CST consent
 * (phone → SMS consent status) are deliberately separate:
 *
 *   phone → CST SMS consent      → opted_in / opted_out / not_consented  (this module)
 *   phone → vFarm person_id       → farm grants → farm authorization     (IdentityResolver + adapters)
 *
 * A phone can be a valid vFarm member (authorized) but not consented (SMS blocked).
 * A phone can be consented but unknown in vFarm (no farm data, but SMS may proceed
 *   for onboarding replies — which are always safe/generic).
 */

import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';
import { CONSENT_WORDING_VERSION, getConsentWording, STOP_KEYWORDS, isOptOutMessage, CONSENT_AFFIRMATIVE_KEYWORDS, isConsentResponse } from './wording.js';
import { randomUUID } from 'crypto';

export type ConsentStatus = 'opted_in' | 'opted_out' | 'not_consented';

export interface ConsentRecord {
  id: string;
  tenant_id: string;
  project_id: string | null;
  phone_e164: string;
  consent_status: ConsentStatus;
  consented_at: string | null;
  opted_out_at: string | null;
  wording_version: string;
  wording_snapshot: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ConsentAuditEntry {
  consent_id: string;
  tenant_id: string;
  project_id: string | null;
  phone_e164: string;
  action: string;
  previous_status: ConsentStatus | null;
  new_status: ConsentStatus;
  wording_version: string | null;
  wording_snapshot: string | null;
  source: string | null;
  actor: string;
  reason?: string;
  correlation_id: string | null;
}

const STOP_ACTOR = 'stop_keyword';
const TWILIO_ACTOR = 'twilio_webhook';
const CUSTOMER_ACTOR = 'customer';
const ADMIN_ACTOR = 'admin';

function cleanPhone(phoneE164: string): string {
  return (phoneE164 || '').trim();
}

function isValidE164(phoneE164: string): boolean {
  const p = cleanPhone(phoneE164);
  return p.startsWith('+') && p.length >= 8 && p.length <= 32;
}

/**
 * Record an explicit opt-in for a phone number.
 *
 * The canonical wording snapshot and version are stamped server-side from
 * `getConsentWording()` — the client cannot supply a fake wording_version.
 */
export async function recordConsent(
  tenantId: string,
  phoneE164: string,
  opts?: {
    projectId?: string;
    source?: string;
    correlationId?: string;
    actor?: string;
    explicitVersion?: string;
  }
): Promise<ConsentRecord> {
  const phone = cleanPhone(phoneE164);
  if (!phone || !isValidE164(phone)) {
    throw new Error(`Invalid phone number: ${phoneE164}`);
  }

  // Server-side determines the canonical wording. Ignore any client-supplied
  // version to prevent evidence tampering.
  const wording = getConsentWording();

  return DbClient.recordSmsConsent({
    tenant_id: tenantId,
    project_id: opts?.projectId || null,
    phone_e164: phone,
    consent_status: 'opted_in',
    consented_at: new Date().toISOString(),
    opted_out_at: null,
    wording_version: wording.version,
    wording_snapshot: wording.text,
    source: opts?.source || 'cst_onboarding',
    actor: opts?.actor || CUSTOMER_ACTOR,
    correlation_id: opts?.correlationId || null,
  });
}

/**
 * Record an opt-out (STOP) for a phone number.
 * Works even if no prior consent record exists — the phone is marked
 * opted_out so CST never sends SMS to it regardless of identity resolution.
 */
export async function recordOptOut(
  tenantId: string,
  phoneE164: string,
  opts?: {
    projectId?: string;
    source?: string;
    correlationId?: string;
    actor?: string;
    reason?: string;
  }
): Promise<ConsentRecord> {
  const phone = cleanPhone(phoneE164);
  if (!phone || !isValidE164(phone)) {
    throw new Error(`Invalid phone number: ${phoneE164}`);
  }

  const now = new Date().toISOString();
  const wording = getConsentWording();

  return DbClient.recordSmsOptOut({
    tenant_id: tenantId,
    project_id: opts?.projectId || null,
    phone_e164: phone,
    opted_out_at: now,
    wording_version: wording.version,
    wording_snapshot: wording.text,
    source: opts?.source || 'stop_keyword',
    actor: opts?.actor || STOP_ACTOR,
    correlation_id: opts?.correlationId || null,
    reason: opts?.reason || 'SMS STOP keyword received',
  });
}

/**
 * Look up the current consent state for a phone number within a tenant/project.
 * Returns 'not_consented' when no record exists.
 *
 * Never returns a result from another tenant or project.
 */
export async function getConsentStatus(
  tenantId: string,
  phoneE164: string,
  projectId?: string
): Promise<{ status: ConsentStatus; record: ConsentRecord | null }> {
  const phone = cleanPhone(phoneE164);
  if (!phone) {
    return { status: 'not_consented', record: null };
  }

  const record = await DbClient.lookupSmsConsent(phone, tenantId, projectId);
  const status: ConsentStatus = record ? (record.consent_status as ConsentStatus) : 'not_consented';
  return { status, record };
}

/**
 * Enforce consent at the outbound SMS boundary.
 * Returns true if the message MAY be sent (sender is opted_in),
 * false if it MUST be blocked (opted_out or not_consented).
 *
 * This is the single gating function called by the outbound queue.
 */
export async function canSendSms(
  tenantId: string,
  phoneE164: string,
  projectId?: string
): Promise<{ allowed: boolean; status: ConsentStatus; reason: string }> {
  const { status, record } = await getConsentStatus(tenantId, phoneE164, projectId);

  if (status === 'opted_out') {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'canSendSms',
      outcome: 'refused',
      reason: `Outbound SMS blocked: recipient ${phoneE164} has opted out (${record?.opted_out_at})`,
      correlation_id: record?.id,
      commercial_impact:
        'An outbound SMS was blocked because the recipient previously sent a STOP keyword. The customer will not receive this message.',
    });
    return {
      allowed: false,
      status: 'opted_out',
      reason: `Recipient ${phoneE164} has opted out of SMS.`,
    };
  }

  if (status === 'not_consented' && !record) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      actor: 'outbound_worker',
      role: 'transport_worker',
      entry_point: 'api',
      tool_or_route: 'canSendSms',
      outcome: 'refused',
      reason: `Outbound SMS blocked: recipient ${phoneE164} has no SMS consent record`,
      correlation_id: undefined,
      commercial_impact:
        'An outbound SMS was blocked because the recipient has not consented to SMS. The customer will not receive this message.',
    });
    return {
      allowed: false,
      status: 'not_consented',
      reason: `Recipient ${phoneE164} has not consented to SMS.`,
    };
  }

  return {
    allowed: true,
    status: 'opted_in',
    reason: '',
  };
}

/**
 * Handle an inbound message that may be a STOP / opt-out keyword.
 *
 * - Detects STOP keywords via `isOptOutMessage`
 * - Records opt-out (creates or updates the consent record)
 * - Returns audit-friendly details
 */
export async function handleInboundConsentMessage(
  tenantId: string,
  phoneE164: string,
  body: string,
  projectId?: string,
  correlationId?: string,
): Promise<{ isOptOut: boolean; record: ConsentRecord | null; reason: string } | null> {
  if (!isOptOutMessage(body)) {
    return null;
  }

  Logger.info(`STOP keyword received from ${phoneE164} in tenant ${tenantId}`, {
    tenant_id: tenantId,
    phone_e164: phoneE164,
    correlation_id: correlationId,
  });

  const record = await recordOptOut(tenantId, phoneE164, {
    projectId,
    correlationId,
    actor: TWILIO_ACTOR,
    reason: 'STOP keyword received via inbound SMS',
  });

  return {
    isOptOut: true,
    record,
    reason: 'Recipient opted out of SMS via STOP keyword',
  };
}

export { CONSENT_WORDING_VERSION, getConsentWording, STOP_KEYWORDS, isOptOutMessage, CONSENT_AFFIRMATIVE_KEYWORDS, isConsentResponse };
