/**
 * SMS Consent Spine — Service Layer
 *
 * Provides a single consent-aware API for:
 *   - Recording opt-ins (onboarding, admin)
 *   - Recording opt-outs (STOP, admin)
 *   - Querying consent state (opted_in | opted_out | not_consented)
 *   - Enforcing consent at the outbound SMS boundary
 *
 * CST identity (phone -> vFarm member -> farm authorization) and CST consent
 * (phone -> SMS consent status) are deliberately separate:
 *
 *   phone -> CST SMS consent      -> opted_in / opted_out / not_consented  (this module)
 *   phone -> vFarm person_id       -> farm grants -> farm authorization     (IdentityResolver + adapters)
 *
 * A phone can be a valid vFarm member (authorized) but not consented (SMS blocked).
 * A phone can be consented but unknown in vFarm (no farm data, but SMS may proceed
 *   for onboarding replies -- which are always safe/generic).
 */

import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';
import { CONSENT_WORDING_VERSION, getConsentWording, STOP_KEYWORDS, isOptOutMessage, CONSENT_AFFIRMATIVE_KEYWORDS, isConsentResponse, isResubscribeRequest, CONSENT_RESUBSCRIBE_KEYWORDS } from './wording.js';
import { randomUUID } from 'crypto';

export type ConsentStatus = 'opted_in' | 'opted_out' | 'not_consented';

/**
 * A consent prompt is the canonical wording sent to a phone number before
 * explicit YES/I AGREE consent can be recorded. Prompts expire after a fixed
 * window so stale prompts cannot grant consent later.
 */
export const CONSENT_PROMPT_TTL_SECONDS = 24 * 60 * 60;

export type PromptType = 'onboarding' | 'resubscribe';

export interface ConsentPrompt {
  id: string;
  consent_id: string | null;
  phone_e164: string;
  tenant_id: string;
  project_id: string | null;
  prompt_type: PromptType;
  wording_version: string;
  wording_snapshot: string;
  sent_at: string;
  expires_at: string;
}

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
 * `getConsentWording()` -- the client cannot supply a fake wording_version.
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
 * Works even if no prior consent record exists -- the phone is marked
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

export { CONSENT_WORDING_VERSION, getConsentWording, STOP_KEYWORDS, isOptOutMessage, CONSENT_AFFIRMATIVE_KEYWORDS, isConsentResponse, CONSENT_RESUBSCRIBE_KEYWORDS, isResubscribeRequest };

export async function getConsentPrompt(
  phoneE164: string,
  tenantId: string,
  projectId?: string
): Promise<ConsentPrompt | null> {
  const cleanPhone = (phoneE164 || '').trim();
  if (!cleanPhone) return null;

  const memKey = DbClient.consentPromptStoreKey(tenantId, cleanPhone, projectId || undefined);
  const memPrompt = DbClient.smsConsentPromptsStore.get(memKey);
  if (memPrompt) return memPrompt;

  const pool = DbClient.getPool();
  if (pool) {
    try {
      const res = await pool.query(
        `SELECT id, consent_id, phone_e164, tenant_id, project_id, prompt_type,
                wording_version, wording_snapshot, sent_at, expires_at
         FROM sms_consent_prompts
         WHERE phone_e164 = $1 AND tenant_id = $2 AND (project_id = $3 OR ($3 IS NULL AND project_id IS NULL))
           AND expires_at > NOW()
         ORDER BY sent_at DESC
         LIMIT 1`,
        [cleanPhone, tenantId, projectId || null]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        const prompt: ConsentPrompt = {
          id: row.id,
          consent_id: row.consent_id,
          phone_e164: row.phone_e164,
          tenant_id: row.tenant_id,
          project_id: row.project_id,
          prompt_type: row.prompt_type,
          wording_version: row.wording_version,
          wording_snapshot: row.wording_snapshot,
          sent_at: row.sent_at,
          expires_at: row.expires_at,
        };
        DbClient.smsConsentPromptsStore.set(memKey, prompt);
        return prompt;
      }
    } catch (err: any) {
      Logger.error(`DbClient.getConsentPrompt Postgres Error: ${err.message}`);
    }
  }

  return null;
}

/**
 * Record a consent prompt (onboarding or resubscribe).
 * Overwrites any previous active prompt for the same phone/tenant/project.
 */
export async function recordConsentPrompt(
  phoneE164: string,
  tenantId: string,
  promptType: PromptType,
  opts?: {
    projectId?: string;
    correlationId?: string;
    actor?: string;
  }
): Promise<ConsentPrompt> {
  const cleanPhone = (phoneE164 || '').trim();
  if (!cleanPhone) throw new Error(`Invalid phone number: ${phoneE164}`);

  const wording = getConsentWording();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CONSENT_PROMPT_TTL_SECONDS * 1000).toISOString();

  const projId = opts?.projectId || null;
  const memKey = DbClient.consentPromptStoreKey(tenantId, cleanPhone, projId || undefined);

  const prompt: ConsentPrompt = {
    id: `prompt_${randomUUID()}`, // match DB's pattern but explicit for consistency
    consent_id: null,
    phone_e164: cleanPhone,
    tenant_id: tenantId,
    project_id: projId,
    prompt_type: promptType,
    wording_version: wording.version,
    wording_snapshot: wording.text,
    sent_at: now,
    expires_at: expiresAt,
  };

  DbClient.smsConsentPromptsStore.set(memKey, prompt);

  const pool = DbClient.getPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO sms_consent_prompts
           (id, phone_e164, tenant_id, project_id, prompt_type,
            wording_version, wording_snapshot, sent_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, COALESCE(project_id, ''), phone_e164)
         DO UPDATE SET
           prompt_type      = EXCLUDED.prompt_type,
           wording_version  = EXCLUDED.wording_version,
           wording_snapshot = EXCLUDED.wording_snapshot,
           sent_at          = EXCLUDED.sent_at,
           expires_at       = EXCLUDED.expires_at`,
        [
          prompt.id,
          prompt.phone_e164,
          prompt.tenant_id,
          projId,
          prompt.prompt_type,
          prompt.wording_version,
          prompt.wording_snapshot,
          prompt.sent_at,
          prompt.expires_at,
        ]
      );
    } catch (err: any) {
      Logger.error(`DbClient.recordConsentPrompt Postgres Error: ${err.message}`);
    }
  }

  return prompt;
}

/**
 * Activate a consent prompt by linking it to a consent record (when YES/I AGREE received).
 * Returns the activated prompt (with consent_id) and the consent record.
 */
export async function activateConsentViaPrompt(
  promptId: string,
  tenantId: string,
  phoneE164: string,
  opts: {
    projectId?: string;
    source?: string;
    correlationId?: string;
    actor?: string;
  } = {}
): Promise<{ prompt: ConsentPrompt; consent: ConsentRecord }> {
  const cleanPhone = (phoneE164 || '').trim();
  if (!cleanPhone) throw new Error(`Invalid phone number: ${phoneE164}`);

  // Get the prompt from in-memory store (fast path) or look up in DB
  const memKey = DbClient.consentPromptStoreKey(tenantId, cleanPhone, opts.projectId || undefined);
  let prompt = DbClient.smsConsentPromptsStore.get(memKey);

  if (!prompt) {
    const pool = DbClient.getPool();
    if (!pool) throw new Error('Database pool unavailable');
    try {
      const res = await pool.query(
        `SELECT id, phone_e164, tenant_id, project_id, prompt_type,
                wording_version, wording_snapshot, sent_at, expires_at
         FROM sms_consent_prompts
         WHERE id = $1 AND tenant_id = $2
           AND (project_id = $3 OR ($3 IS NULL AND project_id IS NULL))
           AND expires_at > NOW()`,
        [promptId, tenantId, opts.projectId || null]
      );
      if (res.rows.length === 0) throw new Error('Prompt not found or expired');
      const row = res.rows[0];
      prompt = {
        id: row.id,
        consent_id: null,
        phone_e164: row.phone_e164,
        tenant_id: row.tenant_id,
        project_id: row.project_id,
        prompt_type: row.prompt_type,
        wording_version: row.wording_version,
        wording_snapshot: row.wording_snapshot,
        sent_at: row.sent_at,
        expires_at: row.expires_at,
      };
      DbClient.smsConsentPromptsStore.set(memKey, prompt);
    } catch (err: any) {
      Logger.error(`DbClient.getConsentPrompt for activation Postgres Error: ${err.message}`);
      throw err;
    }
  }

  if (prompt.consent_id) throw new Error('Prompt already activated');

  // Create the consent record using recordConsent
  const consent = await recordConsent(tenantId, cleanPhone, {
    projectId: opts.projectId,
    source: opts.source || 'prompt_activation',
    correlationId: opts.correlationId,
    actor: opts.actor || 'customer',
    explicitVersion: prompt.wording_version,
  });

  // Link prompt to consent (in-memory)
  prompt.consent_id = consent.id;
  DbClient.smsConsentPromptsStore.set(memKey, prompt);

  // Link prompt to consent (Postgres)
  const pool = DbClient.getPool();
  if (pool) {
    try {
      await pool.query(
        `UPDATE sms_consent_prompts
           SET consent_id = $1
         WHERE id = $2
           AND tenant_id = $3
           AND (project_id = $4 OR ($4 IS NULL AND project_id IS NULL))`,
        [consent.id, promptId, tenantId, opts.projectId || null]
      );
    } catch (err: any) {
      Logger.error(`DbClient.activatePrompt Postgres Error: ${err.message}`);
    }
  }

  return { prompt, consent };
}

/**
 * Check if a consent prompt is still valid (not expired).
 * Should be called before accepting an affirmative response.
 */
export async function isConsentPromptValid(
  phoneE164: string,
  tenantId: string,
  projectId?: string
): Promise<boolean> {
  const prompt = await getConsentPrompt(phoneE164, tenantId, projectId);
  if (!prompt) return false;
  const now = new Date().toISOString();
  return prompt.expires_at > now && prompt.consent_id === null;
}

/**
 * Handle an inbound message that may be a STOP / opt-out keyword.
 *
 * - Detects STOP keywords via `isOptOutMessage`
 * - Records opt-out (creates or updates the consent record)
 * - Returns data needed to send confirmation reply
 */
export async function handleInboundConsentMessage(
  tenantId: string,
  phoneE164: string,
  body: string,
  projectId?: string,
  correlationId?: string,
): Promise<{ isOptOut: boolean; record: ConsentRecord | null; reason: string; confirmationBody: string | null } | null> {
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
    confirmationBody: 'You have been unsubscribed. Reply START to re-subscribe. Msg&data rates may apply.',
  };
}

/**
 * Handle an inbound message that may be a re-subscription request (START).
 *
 * - Detects START keywords via `isResubscribeRequest`
 * - Records resubscribe prompt (creates/updates active prompt)
 * - Returns data needed to send consent prompt reply
 */
export async function handleInboundResubscribeMessage(
  tenantId: string,
  phoneE164: string,
  body: string,
  projectId?: string,
  correlationId?: string,
): Promise<{ isResubscribe: boolean; prompt: ConsentPrompt | null; reason: string; promptBody: string | null } | null> {
  if (!isResubscribeRequest(body)) {
    return null;
  }

  const { status } = await getConsentStatus(tenantId, phoneE164, projectId);
  if (status !== 'opted_out') {
    return null; // Let the Core Engine handle non-STOP cases; START from other states is invalid
  }

  Logger.info(`START keyword received from ${phoneE164} in tenant ${tenantId} (re-subscribe request)`, {
    tenant_id: tenantId,
    phone_e164: phoneE164,
    correlation_id: correlationId,
  });

  const prompt = await recordConsentPrompt(phoneE164, tenantId, 'resubscribe', {
    projectId,
    correlationId,
    actor: 'customer',
  });

  // The promptBody is the canonical consent wording (what we ask them to agree to)
  const wording = getConsentWording();
  const promptBody = `${wording.text}\n\nReply STOP at any time to opt out.`;

  return {
    isResubscribe: true,
    prompt,
    reason: 'Customer requested re-subscription via START keyword',
    promptBody: promptBody,
  };
}
