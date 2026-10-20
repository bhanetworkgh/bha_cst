export type CapabilityType = 'sms' | 'voice' | 'sms_voice' | 'web' | 'whatsapp' | 'email';

/**
 * Check if a binding's capability matches the requested capability.
 * Supports the combined 'sms_voice' capability that matches both 'sms' and 'voice'.
 */
export function matchesCapability(bindingCapability: CapabilityType | string, requested: CapabilityType): boolean {
  if (bindingCapability === requested) return true;
  if (bindingCapability === 'sms_voice' && (requested === 'sms' || requested === 'voice')) return true;
  return false;
}

/**
 * The channel a single turn is on.
 *
 * `CapabilityType` includes the combined 'sms_voice', which describes a service
 * number BINDING that serves both transports. A turn is always on exactly one
 * transport, so the combined capability never appears as a turn channel. This
 * type tracks `CapabilityType` automatically, so widening the capability set
 * cannot silently widen the turn channel.
 */
export type TurnChannel = Exclude<CapabilityType, 'sms_voice'>;

export type SpeakerPolicy = 'allowlist' | 'all_project_members';

export type UserRole = 'owner' | 'manager' | 'tech' | 'unknown';

export interface Tenant {
  tenant_id: string;
  name: string;
  status: 'active' | 'suspended';
  adapter_type: string;
  adapter_config?: Record<string, unknown>;
  created_at: string;
}

export interface Project {
  project_id: string;
  tenant_id: string;
  name: string;
  status: 'active' | 'suspended';
  tenant_org_id?: string;
  capabilities: Partial<Record<CapabilityType, boolean>>;
  speaker_policy: SpeakerPolicy;
  onboarding_reply?: string;
  elevenlabs_voice_id?: string;
  elevenlabs_model_id?: string;
  voice_enabled?: boolean;
  synced_at?: string;
}

export interface ServiceNumberBinding {
  phone_e164: string;
  tenant_id: string;
  project_id: string;
  capability: CapabilityType;
  status: 'bound' | 'candidate';
  bound_at?: string;
  sid?: string;
}

export interface ResourceScope {
  id: string;
  name?: string;
  type: string; // e.g. 'farm'
  metadata?: Record<string, unknown>;
}

export interface SpeakerRecord {
  person_id: string;
  phone_e164: string;
  role: 'owner' | 'manager' | 'tech';
  farm_ids: string[];
  name?: string;
}

export interface CabinetConfig {
  serial: string;
  farm_id: string;
  config_hash: string;
  cad_revision: string;
  status: 'ok' | 'unavailable';
  source: 'lm7w';
  updated_at?: string;
  summary?: string;
}

export interface SpeakerIdentity {
  person_id: string;
  customer_ref: string;
  tenant_id: string;
  project_id: string;
  phone_e164: string;
  is_known: boolean;
  role: UserRole;
  permissions: string[];
  farm_ids: string[];
  unit_context?: Record<string, unknown>;
}
