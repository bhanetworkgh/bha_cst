import { TurnChannel } from './types.js';

export interface MessageEnvelope {
  tenant_id: string;
  project_id: string;
  channel: TurnChannel;
  speaker_ref: string;
  text: string;
  media: string[];
  correlation_id: string;
  metadata?: Record<string, unknown>;
}

export interface EnvelopeResponse {
  reply_text: string;
  reply?: string;
  media_url?: string;
  correlation_id: string;
  channel: TurnChannel;
  tenant_id: string;
  project_id: string;
  speaker_ref: string;
  conversation_id?: string;
  status?: string;
  intent?: string;
  reason?: string;
  incident_id?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}
