export interface InboundMessage {
  message_id: string; // Twilio MessageSid
  tenant_id: string;
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
  from_e164?: string; // The system Twilio number that sent this message
  to_e164: string;
  body: string;
  media_url?: string;
  correlation_id: string;
  status?: 'pending' | 'sent' | 'failed' | 'refused';
  created_at?: string;
}

export interface IdentityContext {
  customer_ref: string;
  tenant_id: string;
  system_id: string;
  is_known_customer: boolean;
  unit_context?: Record<string, unknown>;
}

/**
 * Per-intent routing rule. Determines whether an intent auto-answers,
 * escalates, or is handled by a canned reply. Quiet hours are also expressed here.
 */
export interface RoutingRule {
  intent: string;            // e.g. 'status' | 'knowledge' | 'images' | 'escalate' | 'default'
  action: 'auto_reply' | 'escalate' | 'knowledge' | 'images' | 'queue';
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
  tenant_id: string;
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
