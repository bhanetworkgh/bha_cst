import { SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';
import { getEnv } from '../config/env.js';
import { DbClient } from '../db/client.js';

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

  const orgId = env.VFARM_TENANT_ID || 'tenant-vfarm-01';
  const workspaceId = 'ws-vfarm-main';

  return [
    {
      system_id:             env.VFARM_SYSTEM_ID,
      organization_id:       orgId,
      tenant_id:             orgId,
      workspace_id:          workspaceId,
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

      // ── Voice Clone Pointer (Jason's ElevenLabs account) ───────────────────
      // CST only stores the pointer, never the clone itself.
      elevenlabs_voice_id:   env.VFARM_ELEVENLABS_VOICE_ID || env.ELEVENLABS_VOICE_ID,
      elevenlabs_model_id:   env.ELEVENLABS_MODEL_ID,
      voice_enabled:         Boolean(env.VFARM_ELEVENLABS_VOICE_ID || env.ELEVENLABS_VOICE_ID),
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
    const orgId = config.organization_id || config.tenant_id;
    const wsId = config.workspace_id || 'ws-default-main';
    const normalizedConfig: SystemConfig = {
      ...config,
      organization_id: orgId,
      tenant_id: orgId,
      workspace_id: wsId,
    };

    this.systems.set(normalizedConfig.system_id, normalizedConfig);
    for (const phone of normalizedConfig.phone_numbers) {
      this.numberToSystemMap.set(phone.trim(), normalizedConfig);
    }

    const pool = DbClient.getPool();
    if (pool) {
      const query = `
        INSERT INTO systems (
          system_id, tenant_id, organization_id, workspace_id, name, status,
          phone_numbers, onboarding_reply, resolve_endpoint_url, bharag_workspace_key,
          messaging_service_sid, media_base_url, escalation_rules, routing_rules,
          elevenlabs_voice_id, elevenlabs_model_id, voice_enabled
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (system_id) DO UPDATE SET
          elevenlabs_voice_id = EXCLUDED.elevenlabs_voice_id,
          elevenlabs_model_id = EXCLUDED.elevenlabs_model_id,
          voice_enabled       = EXCLUDED.voice_enabled
      `;
      pool.query(query, [
        normalizedConfig.system_id,
        normalizedConfig.tenant_id,
        normalizedConfig.organization_id,
        normalizedConfig.workspace_id,
        normalizedConfig.name,
        normalizedConfig.status || 'active',
        JSON.stringify(normalizedConfig.phone_numbers || []),
        normalizedConfig.onboarding_reply,
        normalizedConfig.resolve_endpoint_url || null,
        normalizedConfig.bharag_workspace_key || null,
        normalizedConfig.messaging_service_sid || null,
        normalizedConfig.media_base_url || null,
        JSON.stringify(normalizedConfig.escalation_rules || []),
        JSON.stringify(normalizedConfig.routing_rules || []),
        normalizedConfig.elevenlabs_voice_id || null,
        normalizedConfig.elevenlabs_model_id || null,
        normalizedConfig.voice_enabled ?? false,
      ]).catch((err) => Logger.error(`SystemsRegistry Postgres Error: ${err.message}`));
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
      if (sys.tenant_id === tenantId || sys.organization_id === tenantId) return sys;
    }
    return null;
  }

  static getSystemByOrganizationId(organizationId: string): SystemConfig | null {
    for (const sys of this.systems.values()) {
      if (sys.organization_id === organizationId) return sys;
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
