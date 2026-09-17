import { CapabilityType } from './types.js';

export interface MessageEnvelope {
  tenant_id: string;
  project_id: string;
  channel: CapabilityType;
  speaker_ref: string;
  text: string;
  media: string[];
  correlation_id: string;
  metadata?: Record<string, unknown>;
}

export interface EnvelopeResponse {
  reply_text: string;
  media_url?: string;
  correlation_id: string;
  channel: CapabilityType;
  tenant_id: string;
  project_id: string;
  speaker_ref: string;
  conversation_id?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}
