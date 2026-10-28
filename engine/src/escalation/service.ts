/**
 * Human escalation service.
 *
 * When a caller requests a person:
 *   1. Explains that the team will follow up by email within two hours
 *   2. Collects the caller's preferred email if not already available
 *   3. Creates a durable escalation record (persisted via DbClient)
 *   4. Notifies the designated team Slack channel (via SlackNotifier)
 *   5. Tracks notification success/failure
 *   6. Never claims notification succeeded unless Slack confirms acceptance
 *
 * All Slack alerts contain only non-sensitive context: tenant ID, project ID,
 * correlation ID, caller phone (masked), and reason. No message bodies, no
 * credentials, no customer data beyond what's needed for routing.
 */
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';
import { maskPhone } from '../util/privacy.js';
import { SlackNotifier } from '../notifications/slack.js';
import type {
  EscalationRequest,
  EscalationResult,
  EscalationRecord,
} from './types.js';

/**
 * The Slack channel for human escalations. Configured via env var.
 * Never hardcoded — different deployments may route to different channels.
 */
function getEscalationSlackChannel(): string | undefined {
  return process.env.SLACK_ESCALATION_CHANNEL || process.env.SLACK_WEBHOOK_CHANNEL;
}

/**
 * Maximum age for escalation records (for TTL/cleanup guidance).
 * Escalations older than 30 days are eligible for archival.
 */
export const ESCALATION_TTL_DAYS = 30;

export class EscalationService {
  /**
   * Escalate a caller to a human team member.
   *
   * Steps:
   *   1. Capture the caller's email (if not already known)
   *   2. Persist the escalation record durably
   *   3. Send Slack notification with redacted context
   *   4. Track notification success/failure
   *   5. Return a result the caller can be told truthfully
   *
   * @param req - The escalation request
   * @returns EscalationResult with durable outcome
   */
  static async escalate(req: EscalationRequest): Promise<EscalationResult> {
    const { caller_phone, tenant_id, project_id, correlation_id, reason, transcript } = req;
    const callerEmail = req.caller_email;

    // ── 1. Persist the escalation record durably ──────────────────────────
    // We write first so that even if Slack fails, the escalation is not lost.
    // The caller can be told their request was recorded regardless of Slack
    // outcome.
    let escalationId: string | null = null;
    try {
      escalationId = await DbClient.createEscalationRecord({
        caller_phone,
        tenant_id,
        project_id,
        conversation_id: req.conversation_id,
        correlation_id,
        caller_email: callerEmail,
        reason,
        transcript,
        status: 'pending',
      });
      Logger.info(`EscalationService: created escalation record ${escalationId} for caller ${maskPhone(caller_phone)}`);
    } catch (err: any) {
      Logger.error(`EscalationService: failed to persist escalation record: ${err.message}`);
      return {
        created: false,
        slack_notified: false,
        email_captured: Boolean(callerEmail),
        caller_email: callerEmail,
        status_message:
          'I was unable to record your escalation request. Please try again or contact support directly.',
        error: err.message,
      };
    }

    // ── 2. Send Slack notification ───────────────────────────────────────
    let slackNotified = false;
    let slackError: string | undefined;

    try {
      const slackPayload = {
        title: 'Human Escalation Requested',
        message: `Caller ${maskPhone(caller_phone)} requested human assistance.`,
        severity: 'WARN' as const,
        service: 'CUSTOMER_TWIN',
        tenant_id,
        correlation_id,
        meta: {
          project_id,
          caller_phone_masked: maskPhone(caller_phone),
          reason: reason || 'unspecified',
          conversation_id: req.conversation_id,
          caller_email: callerEmail ? 'provided' : 'not_provided',
          escalation_id: escalationId,
          // Transcript summary only — never full message bodies
          transcript_length: transcript?.length ?? 0,
        },
      };

      slackNotified = await SlackNotifier.sendErrorAlert(slackPayload);

      if (slackNotified) {
        Logger.info(`EscalationService: Slack notification sent for escalation ${escalationId}`);
      } else {
        // Slack not configured (no webhook URL) — the escalation record exists,
        // notification simply hasn't been sent yet. This is not an escalation
        // failure; the record remains 'pending' until a notification succeeds.
        Logger.warn(`EscalationService: Slack not configured for escalation ${escalationId}; notification deferred`);
      }
    } catch (err: any) {
      slackError = err.message;
      Logger.error(`EscalationService: Slack notification failed for escalation ${escalationId}: ${err.message}`, { errorStack: err.stack?.split('\n').slice(0, 3) });
    }

    // ── 3. Record Slack outcome on the escalation record ─────────────────
    try {
      await DbClient.updateEscalationSlackStatus(escalationId, slackNotified, slackError);
    } catch (err: any) {
      // Non-fatal: the escalation record exists, Slack attempt was made
      Logger.warn(`EscalationService: failed to update Slack status on escalation ${escalationId}: ${err.message}`);
    }

    // ── 4. Build the caller-facing result ────────────────────────────────
    // Never claim notification succeeded unless Slack confirmed acceptance.
    // If Slack is not configured (slackNotified === false, no error), the
    // escalation remains 'pending' — the record exists, notification simply
    // hasn't been sent yet.
    const statusMessage = slackNotified
      ? 'Thank you. Our team has been notified and will follow up by email within two hours.'
      : 'Your request has been recorded. Our team will follow up by email within two hours.';

    return {
      created: true,
      escalation_id: escalationId,
      slack_notified: slackNotified,
      email_captured: Boolean(callerEmail),
      caller_email: callerEmail,
      status_message: statusMessage,
      ...(slackError ? { error: slackError } : {}),
    };
  }

  /**
   * Capture or confirm the caller's email address for escalation follow-up.
   * Called when the caller provides their email during the escalation flow.
   */
  static async captureEmail(
    escalationId: string,
    callerPhone: string,
    email: string,
  ): Promise<{ updated: boolean; error?: string }> {
    // Basic email format validation (no secrets, no PII beyond the email itself)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { updated: false, error: 'Invalid email address' };
    }

    try {
      await DbClient.updateEscalationEmail(escalationId, email);
      Logger.info(`EscalationService: email captured for escalation ${escalationId}`);
      return { updated: true };
    } catch (err: any) {
      Logger.error(`EscalationService: failed to capture email for escalation ${escalationId}: ${err.message}`);
      return { updated: false, error: err.message };
    }
  }

  /**
   * Get an escalation record by ID (for admin/review purposes).
   */
  static async getEscalation(escalationId: string): Promise<EscalationRecord | null> {
    return DbClient.getEscalationRecord(escalationId);
  }
}
