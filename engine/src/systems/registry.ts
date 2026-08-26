import { SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';

// Initial seed systems - vFarm is System #1
const defaultSystems: SystemConfig[] = [
  {
    system_id: 'system-vfarm-01',
    tenant_id: 'tenant-vfarm-01',
    name: 'vFarm System #1',
    status: 'active',
    phone_numbers: ['+15550001111', '+18005558327'], // Seeded valid E.164 numbers
    messaging_service_sid: 'MG_VFARM_01_REF',       // Twilio Messaging Service SID ref (spec §2)
    onboarding_reply: 'Welcome to vFarm Support! We received your message. A specialist will assist you shortly.',
    resolve_endpoint_url: 'http://localhost:4000/api/v1/customers/resolve',
    bharag_workspace_key: 'workspace_vfarm_cst_key',
    media_base_url: 'https://media.bhavfarm.com',   // Media server base URL for signed URL fetches
    escalation_rules: [
      // When a fault or escalation intent is detected, file an incident in BHARAG incidents.v0
      // subsystem=CUSTOMER_TWIN and engine=VFARM are frozen by spec §3
      { trigger: 'escalate', subsystem: 'CUSTOMER_TWIN', engine: 'VFARM', priority: 'high' },
      { trigger: 'fault',    subsystem: 'CUSTOMER_TWIN', engine: 'VFARM', priority: 'critical' },
    ],
    routing_rules: [
      // Auto-answer status inquiries; escalate faults; all else queues for handler
      { intent: 'status',    action: 'auto_reply', canned_reply: 'We are checking your unit status. Please hold.' },
      { intent: 'knowledge', action: 'knowledge' },
      { intent: 'images',    action: 'images' },
      { intent: 'escalate',  action: 'escalate' },
      { intent: 'default',   action: 'queue' },
    ],
  },
  {
    system_id: 'system-tenant-b-02',
    tenant_id: 'tenant-b-02',
    name: 'Tenant B System',
    status: 'active',
    phone_numbers: ['+15559992222'],
    onboarding_reply: 'Welcome to Tenant B Support!',
  },
];


export class SystemsRegistry {
  private static systems: Map<string, SystemConfig> = new Map();
  private static numberToSystemMap: Map<string, SystemConfig> = new Map();

  static {
    // Seed initial systems
    for (const sys of defaultSystems) {
      this.registerSystem(sys);
    }
  }

  static registerSystem(config: SystemConfig): void {
    this.systems.set(config.system_id, config);
    for (const phone of config.phone_numbers) {
      const normalizedPhone = this.normalizePhone(phone);
      this.numberToSystemMap.set(normalizedPhone, config);
    }
  }

  static resolveSystemByPhoneNumber(phoneE164: string): SystemConfig | null {
    if (!phoneE164) return null;
    const normalized = this.normalizePhone(phoneE164);
    const system = this.numberToSystemMap.get(normalized);
    if (!system) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: null,
        actor: 'twilio_webhook',
        role: 'untrusted_ingress',
        entry_point: 'webhook',
        tool_or_route: 'resolveSystemByPhoneNumber',
        outcome: 'refused',
        reason: `Unknown receiving phone number ${phoneE164}`,
      });
      return null;
    }
    return system;
  }

  static getSystemById(systemId: string): SystemConfig | null {
    return this.systems.get(systemId) || null;
  }

  static getSystemByTenantId(tenantId: string): SystemConfig | null {
    for (const sys of this.systems.values()) {
      if (sys.tenant_id === tenantId) return sys;
    }
    return null;
  }

  static clear(): void {
    this.systems.clear();
    this.numberToSystemMap.clear();
  }

  static resetToDefault(): void {
    this.clear();
    for (const sys of defaultSystems) {
      this.registerSystem(sys);
    }
  }

  private static normalizePhone(phone: string): string {
    return phone.trim();
  }
}
