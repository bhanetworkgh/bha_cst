/**
 * 018M — Alert Audit Log Writer
 *
 * Writes immutable audit records for every outbound alert/notification sent
 * through the CST transport pipeline. Enforces three hard constraints:
 *
 *  1. WRITE-TIME SECRET MASKING: Sensitive fields are stripped from the payload
 *     before any data is persisted. masked_at is set to record when stripping occurred.
 *     Do NOT rely on read-time masking (which can be bypassed by direct DB access).
 *
 *  2. SIZE CAP: Rendered body is truncated to ALERT_AUDIT_MAX_BYTES (65536 bytes)
 *     if oversized. The truncated flag is set to true so consumers know the stored
 *     body is not the full original.
 *
 *  3. TTL/RETENTION: expires_at is set to created_at + ALERT_AUDIT_TTL_DAYS (90)
 *     by default. Rows with expires_at <= NOW() are eligible for pruning.
 */

import { randomUUID } from 'crypto';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';

/** Maximum bytes for stored rendered_body (64 KiB). */
export const ALERT_AUDIT_MAX_BYTES = 65_536;

/** Default retention window in days. */
export const ALERT_AUDIT_TTL_DAYS = 90;

/**
 * Sensitive field names (lowercase) that must never be persisted in alert audit rows.
 * Checked against all top-level keys in the params and payload objects.
 */
const SECRET_FIELD_NAMES = new Set([
  'authorization',
  'token',
  'api_key',
  'apikey',
  'x-api-key',
  'secret',
  'password',
  'webhook_url',
  'bearer',
  'workspacekey',
  'workspace_key',
  'clusterkey',
  'cluster_key',
  'auth_token',
  'access_token',
]);

/**
 * An alert audit row ready for insertion.
 * Produced by AlertAuditLog.write() after masking and size-capping.
 */
export interface AlertAuditRow {
  id: string;
  outbound_message_id: string;
  tenant_id: string;
  organization_id?: string;
  rendered_body: string;
  truncated: boolean;
  template_id?: string;
  version?: string;
  params?: Record<string, unknown>;
  masked_at: string | null;
  expires_at: string;
  created_at: string;
}

/**
 * Optional template metadata attached at alert write time.
 */
export interface AlertTemplateMeta {
  /** Template identifier (e.g. 'sms_alert_v1'). */
  template_id?: string;
  /** Template version string (e.g. '1.3.0'). */
  version?: string;
  /** Template render parameters. Sensitive keys are stripped before persist. */
  params?: Record<string, unknown>;
}

/**
 * Recursively strip secret keys from a plain object. Returns a new object.
 * Only top-level keys are checked; nested objects are recursed into.
 */
function stripSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELD_NAMES.has(k.toLowerCase())) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = stripSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class AlertAuditLog {
  /**
   * Write an immutable alert audit record for an outbound message.
   *
   * @param outboundMessageId - The `messages_out.id` this audit record references.
   * @param tenantId - Tenant boundary (organization_id).
   * @param renderedBody - The full rendered body as sent to the customer.
   * @param meta - Optional template metadata (`template_id`, `version`, `params`).
   * @param organizationId - Optional top-level org ID (defaults to tenantId).
   * @param ttlDays - Optional retention override in days (defaults to ALERT_AUDIT_TTL_DAYS).
   *
   * This method is fire-and-forget from the caller's perspective: all errors are
   * swallowed and logged. A failure to write an audit row must never block message delivery.
   */
  static async write(
    outboundMessageId: string,
    tenantId: string,
    renderedBody: string,
    meta?: AlertTemplateMeta,
    organizationId?: string,
    ttlDays?: number
  ): Promise<void> {
    try {
      const now = new Date();
      const ttl = ttlDays ?? ALERT_AUDIT_TTL_DAYS;
      const expiresAt = new Date(now.getTime() + ttl * 24 * 60 * 60 * 1_000);

      // ── 1. Write-time secret masking ─────────────────────────────────────
      let strippedParams: Record<string, unknown> | undefined;
      let secretsFound = false;

      if (meta?.params) {
        strippedParams = stripSecrets(meta.params);
        // Check if any key was removed (detect whether masking fired)
        secretsFound = Object.keys(meta.params).length !== Object.keys(strippedParams).length;
      }

      const maskedAt = secretsFound ? now.toISOString() : null;

      // ── 2. Size cap enforcement ───────────────────────────────────────────
      const bodyBytes = Buffer.byteLength(renderedBody, 'utf8');
      let finalBody = renderedBody;
      let truncated = false;

      if (bodyBytes > ALERT_AUDIT_MAX_BYTES) {
        // Truncate to exactly ALERT_AUDIT_MAX_BYTES bytes (UTF-8 safe)
        finalBody = Buffer.from(renderedBody, 'utf8')
          .subarray(0, ALERT_AUDIT_MAX_BYTES)
          .toString('utf8')
          // Drop any incomplete trailing multi-byte sequence by trimming to last valid char
          .replace(/[\uFFFD\uD800-\uDFFF]$/, '');
        truncated = true;
        Logger.warn(`AlertAuditLog: rendered body truncated from ${bodyBytes} to ${ALERT_AUDIT_MAX_BYTES} bytes for outbound_message_id=${outboundMessageId}`);
      }

      // ── 3. Construct audit row ────────────────────────────────────────────
      const row: AlertAuditRow = {
        id:                   randomUUID(),
        outbound_message_id:  outboundMessageId,
        tenant_id:            tenantId,
        organization_id:      organizationId || tenantId,
        rendered_body:        finalBody,
        truncated,
        template_id:          meta?.template_id,
        version:              meta?.version,
        params:               strippedParams,
        masked_at:            maskedAt,
        expires_at:           expiresAt.toISOString(),
        created_at:           now.toISOString(),
      };

      // ── 4. Persist ────────────────────────────────────────────────────────
      await DbClient.writeAlertAuditRow(row);

      Logger.info(`AlertAuditLog: wrote audit row ${row.id} for outbound=${outboundMessageId} (truncated=${truncated}, masked=${maskedAt !== null})`);
    } catch (err: any) {
      // Never block message delivery for audit failures
      Logger.error(`AlertAuditLog.write failed for outbound_message_id=${outboundMessageId}: ${err.message}`);
    }
  }
}
