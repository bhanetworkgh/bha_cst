/**
 * Human escalation types.
 *
 * When a caller requests a person (escalation), CST:
 *   1. Explains the team will follow up by email within two hours
 *   2. Collects the caller's preferred email if not already available
 *   3. Creates a durable escalation record
 *   4. Notifies the designated team Slack channel with transcript + context
 *   5. Tracks notification success/failure
 *   6. Never claims notification succeeded unless confirmed
 */
export interface EscalationRequest {
  /** The caller's phone number (E.164). */
  caller_phone: string;
  /** The tenant ID (from service_number_binding). */
  tenant_id: string;
  /** The project ID. */
  project_id: string;
  /** The conversation ID (for transcript linkage). */
  conversation_id?: string;
  /** The correlation ID (call SID or request ID). */
  correlation_id: string;
  /** The caller's email, if already known. */
  caller_email?: string;
  /** The reason for escalation (caller's stated reason). */
  reason?: string;
  /** The transcript so far, if available. */
  transcript?: string[];
}

export interface EscalationResult {
  /** Whether the escalation record was durably created. */
  created: boolean;
  /** The escalation record ID (if created). */
  escalation_id?: string;
  /** Whether Slack notification was successfully dispatched. */
  slack_notified: boolean;
  /** Whether email was captured (or already known). */
  email_captured: boolean;
  /** The email address captured (if any). */
  caller_email?: string;
  /** Human-readable status for the caller. */
  status_message: string;
  /** Any error details (redacted — no secrets). */
  error?: string;
}

export interface EscalationRecord {
  id: string;
  caller_phone: string;
  tenant_id: string;
  project_id: string;
  conversation_id?: string;
  correlation_id: string;
  caller_email?: string;
  reason?: string;
  transcript?: string[];
  slack_notified: boolean;
  slack_notified_at?: string;
  slack_error?: string;
  created_at: string;
  status: 'pending' | 'notified' | 'failed';
}
