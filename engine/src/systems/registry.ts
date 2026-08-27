import { SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';
import { getEnv } from '../config/env.js';

/**
 * Build system list purely from validated env vars.
 * getEnv() throws a descriptive error if ANY required field is missing —
 * no hardcoded fallbacks, no silent defaults for secrets.
 *
 * To add a second system: add SYSTEM2_* vars to .env, call getEnv() for those
 * vars, and append another entry to the returned array.
 */
function buildDefaultSystems(): SystemConfig[] {
  const env = getEnv(); // Throws if any required env var is absent

  const vfarmPhones = env.VFARM_PHONE_NUMBERS
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  return [
    {
      system_id:             env.VFARM_SYSTEM_ID,
      tenant_id:             env.VFARM_TENANT_ID,
      name:                  env.VFARM_SYSTEM_NAME,
      status:                'active',
      phone_numbers:         vfarmPhones,
      messaging_service_sid: env.TWILIO_MESSAGING_SERVICE_SID,

      // All customer-facing text comes from .env — zero strings in code
      onboarding_reply:      env.VFARM_ONBOARDING_REPLY,

      // External API seams — all URLs and keys from .env
      resolve_endpoint_url:  env.VFARM_RESOLVE_ENDPOINT,
      bharag_workspace_key:  env.BHARAG_WORKSPACE_KEY,
      media_base_url:        env.MEDIA_SERVER_URL,

      // Escalation rules: trigger keywords -> BHARAG incidents.v0
      escalation_rules: [
        { trigger: 'escalate', subsystem: 'CUSTOMER_TWIN', engine: 'VFARM', priority: 'high' },
        { trigger: 'fault',    subsystem: 'CUSTOMER_TWIN', engine: 'VFARM', priority: 'critical' },
      ],

      // Routing rules: intent -> connector action for IntentRouter
      routing_rules: [
        { intent: 'status',    action: 'status'    },
        { intent: 'knowledge', action: 'knowledge' },
        { intent: 'images',    action: 'images'    },
        { intent: 'escalate',  action: 'escalate'  },
        { intent: 'default',   action: 'default'   },
      ],
    },
    // ── To register a new system: add SYSTEM2_* vars to .env and add an entry here ──
  ];
}



export class SystemsRegistry {
  private static systems: Map<string, SystemConfig> = new Map();
  private static numberToSystemMap: Map<string, SystemConfig> = new Map();

  static {
    for (const sys of buildDefaultSystems()) {
      this.registerSystem(sys);
    }
  }

  static registerSystem(config: SystemConfig): void {
    this.systems.set(config.system_id, config);
    for (const phone of config.phone_numbers) {
      this.numberToSystemMap.set(phone.trim(), config);
    }
  }

  static resolveSystemByPhoneNumber(phoneE164: string): SystemConfig | null {
    if (!phoneE164) return null;
    const system = this.numberToSystemMap.get(phoneE164.trim());
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
    for (const sys of buildDefaultSystems()) {
      this.registerSystem(sys);
    }
  }
}
