export interface InboundMessage {
  message_id: string; // Twilio MessageSid
  tenant_id: string;
  project_id?: string;
  from_e164: string;
  to_e164: string;
  body: string;
  media: string[];
  received_at: string;
  correlation_id: string;
}

export interface OutboundMessage {
  id?: string;
  tenant_id: string;
  project_id?: string;
  from_e164?: string; // The system Twilio number that sent this message
  to_e164: string;
  body: string;
  media_url?: string;
  correlation_id: string;
  turn_id?: string;   // The cst.turn.turn_id this outbound is the reply to
  provider_sid?: string;
  /**
   * Delivery state of the outbound message.
   *
   * `outcome_unknown` is NOT a delivery outcome — it records that CST
   * dispatched the message to the provider but never obtained a response, so
   * it cannot be established whether Twilio created the message. A message in
   * this state is deliberately NOT re-dispatched automatically (a blind retry
   * could deliver a second copy to the customer) and does NOT publish a
   * `cst.delivery` event (there is no delivery status to report). It is
   * preserved, visible in the queue-depth heartbeat, and reconcilable by an
   * operator. See the reconciliation procedure in the operations runbook.
   */
  status?: 'pending' | 'queued' | 'sending' | 'sent' | 'failed' | 'refused' | 'delivered' | 'undelivered' | 'outcome_unknown';
  retry_count?: number;
  max_retries?: number;
  next_retry_at?: string;
  error_message?: string;
  segments?: number;
  created_at?: string;
  updated_at?: string;
  /**
   * When true, the outbound queue's SMS-consent gate is bypassed.
   * Only safe onboarding/reply messages use this — never operational SMS.
   * Rationale: the safe generic onboarding reply is how CST collects consent;
   * blocking it would create a deadlock (can't message to ask to message).
   */
  consent_exempt?: boolean;
}

export interface IdentityContext {
  customer_ref: string;
  organization_id: string; // Top-level tenant security boundary
  tenant_id: string;       // Alias for organization_id
  system_id: string;
  project_id?: string;     // Project security boundary
  workspace_id: string;    // Workspace / Project scope
  is_known_customer: boolean;
  role: 'owner' | 'manager' | 'tech' | 'unknown';
  permissions: string[];
  unit_context?: Record<string, unknown>;
}

/**
 * Per-intent routing rule. Determines whether an intent auto-answers,
 * escalates, or is handled by a canned reply. Quiet hours are also expressed here.
 */
export interface RoutingRule {
  intent: string;            // e.g. 'status' | 'knowledge' | 'images' | 'escalate' | 'default'
  action: 'status' | 'auto_reply' | 'escalate' | 'knowledge' | 'images' | 'queue' | 'default';
  canned_reply?: string;     // Static reply text if action is 'auto_reply'
  quiet_hours?: {
    start: string;           // HH:MM in system local time
    end: string;             // HH:MM in system local time
    timezone: string;        // IANA tz, e.g. 'America/Chicago'
  };
}

/**
 * Escalation rules define when and how to file an incident in BHARAG incidents.v0.
 * CST files the incident via the system's BHARAG workspace key.
 */
export interface EscalationRule {
  trigger: string;           // Intent or keyword pattern
  subsystem: string;         // Always 'CUSTOMER_TWIN' per spec §3
  engine: string;            // e.g. 'VFARM' per spec §3
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export interface SystemConfig {
  system_id: string;
  organization_id: string;   // Organization (tenant boundary)
  tenant_id: string;         // Alias for organization_id
  workspace_id: string;      // Primary workspace / project
  name: string;
  status: 'active' | 'suspended';
  phone_numbers: string[];           // E.164 numbers assigned to this system
  messaging_service_sid?: string;    // Twilio Messaging Service SID ref (spec §2)
  onboarding_reply: string;
  resolve_endpoint_url?: string;     // Identity resolve endpoint (e.g. vFarm GET /api/v1/customers/resolve)
  bharag_workspace_key?: string;     // CST workspace key for BHARAG ask + incidents.v0
  media_base_url?: string;           // Media server base URL for signed URL fetches
  escalation_rules?: EscalationRule[]; // When/how to file incidents in BHARAG incidents.v0 (spec §2)
  routing_rules?: RoutingRule[];       // Per-intent routing config: auto-answer, escalate, quiet hours (spec §2)
  elevenlabs_voice_id?: string;        // ElevenLabs voice clone pointer (Jason's account)
  elevenlabs_model_id?: string;        // Fast synthesis model (e.g. eleven_turbo_v2_5)
  voice_enabled?: boolean;             // Whether voice lane is enabled for this system
}

export interface TwilioWebhookPayload {
  MessageSid?: string;
  SmsSid?: string;
  AccountSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string;
  [key: `MediaUrl${number}`]: string;
  [key: `MediaContentType${number}`]: string;
  [key: string]: unknown;
}
