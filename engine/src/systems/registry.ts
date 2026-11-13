import { SystemConfig } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';
import { getEnv } from '../config/env.js';
import { DbClient } from '../db/client.js';
import { CoreRegistry } from '../core/registry.js';
import { validateSystemRegistry, type RegistryValidationReport } from './registry_validation.js';

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
  // `workspace_id` is DEPRECATED: the project is the security boundary now
  // (`service_number_binding.project_id`). There is deliberately no hardcoded
  // legacy workspace constant — a platform-wide value stamped onto every
  // tenant's transcripts and audit rows blurred project boundaries. Configure a
  // workspace id explicitly with VFARM_WORKSPACE_ID if a legacy consumer needs
  // one; otherwise it tracks the tenant.
  const workspaceId = process.env.VFARM_WORKSPACE_ID || orgId;

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



/**
 * @deprecated NON-IDENTITY CONFIGURATION ONLY.
 *
 * `SystemsRegistry` is a *configuration* registry (system display name,
 * onboarding copy, BHARAG workspace key, ElevenLabs voice-clone pointer). It is
 * NOT a tenancy or identity authority. The authoritative chains are:
 *
 *   Twilio To   -> service_number_binding -> tenant/project/capability
 *   Twilio From -> vFarm tenant adapter   -> person / role / farm_ids
 *
 * Historically this registry also answered "which tenant owns this number?",
 * which created a second, static identity system alongside `CoreRegistry`. Any
 * still-mounted call site that used it for identity has been migrated to
 * `CoreRegistry` (see `transport/voice/voice_lane.ts`,
 * `transport/twilio/outbound.ts`); what remains is presentation/config lookup
 * plus one DENY-only cross-tenant guard in `validateOutboundTenancyScope`,
 * which can only refuse a send and can never grant access.
 *
 * Kept in place (not deleted) because it is still the source for the voice-lane
 * presentation config and for the seeded `systems` row; deleting it would
 * redesign unrelated components.
 */
export class SystemsRegistry {
  private static systems: Map<string, SystemConfig> = new Map();
  private static numberToSystemMap: Map<string, SystemConfig> = new Map();
  /**
   * Every `INSERT INTO systems` this registry has issued, in order.
   *
   * `conversations.system_id` and `voice_deliveries.system_id` both carry
   * `REFERENCES systems(system_id)`, and `systems` is populated by no migration
   * and no seed — only here, at runtime. The insert used to be fire-and-forget
   * with nothing awaiting it, so on a fresh database the first inbound webhook
   * could reach `conversations` before its FK parent existed. `server.ts` awaits
   * `whenPersisted()` before listening, which closes that window without changing
   * `registerSystem`'s synchronous signature.
   */
  private static pendingWrites: Promise<unknown>[] = [];

  /** Resolves once every `systems` row this registry has written is committed. */
  static async whenPersisted(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const batch = this.pendingWrites;
      this.pendingWrites = [];
      await Promise.allSettled(batch);
    }
  }

  static {
    for (const sys of buildDefaultSystems()) {
      this.registerSystem(sys);
    }
  }

  static registerSystem(config: SystemConfig): void {
    // Fail closed: a registration that lacks an identifier is refused outright.
    // No identifier is ever fabricated here (the old 'ws-default-main'
    // workspace fallback let an unmapped system silently join a shared scope).
    const orgId = (config.organization_id || config.tenant_id || '').trim();
    const wsId = (config.workspace_id || '').trim();
    if (!config.system_id || !config.system_id.trim()) {
      throw new Error('SystemsRegistry: refusing to register a system without a system_id');
    }
    if (!orgId) {
      throw new Error(`SystemsRegistry: system ${config.system_id} has no tenant_id/organization_id`);
    }
    if (!wsId) {
      throw new Error(`SystemsRegistry: system ${config.system_id} has no workspace_id`);
    }
    // One service number can belong to exactly one system.
    for (const phone of config.phone_numbers || []) {
      const owner = this.numberToSystemMap.get(phone.trim());
      if (owner && owner.system_id !== config.system_id) {
        throw new Error(
          `SystemsRegistry: service number is already registered to system ${owner.system_id}; refusing duplicate mapping for system ${config.system_id}`,
        );
      }
    }
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
      const write = pool.query(query, [
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
      ]);
      this.pendingWrites.push(
        write.catch((err) => Logger.error(`SystemsRegistry Postgres Error: ${err.message}`)),
      );
    }
  }

  /**
   * Resolve a phone number to the system (tenant) that owns it.
   *
   * Two callers use this, with opposite meanings for a "not found" result:
   *
   *   1. A POSITIVE resolution — "which system does this INBOUND number
   *      belong to?" A miss here is a real deployment fault and is reported.
   *   2. A NEGATIVE cross-tenant probe — "is this OUTBOUND destination a
   *      number registered to ANOTHER tenant's system?" A miss here is the
   *      NORMAL case: a customer's own phone is not a CST system number.
   *
   * Reporting both as a WARN-level tripwire made an ordinary outbound reply
   * to a customer look like a routing failure ("Unknown receiving phone
   * number <customer>") and wrote a spurious refusal entry into the
   * SECURITY_LEDGER. The negative probe therefore passes `required: false`,
   * which suppresses the warning while keeping the identical fail-closed
   * behaviour: the result is still null, and the cross-tenant check still
   * runs.
   */
  static resolveSystemByPhoneNumber(
    phoneE164: string,
    options: { required?: boolean } = {}
  ): SystemConfig | null {
    const required = options.required !== false;
    if (!phoneE164) return null;
    const system = this.numberToSystemMap.get(phoneE164.trim());
    if (!system) {
      if (required) {
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
      }
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

  /**
   * Validate the registered systems against CoreRegistry (tenants, projects,
   * service number bindings). Safe to expose: secrets are masked/classified.
   */
  static validateConfiguration(): RegistryValidationReport {
    const derived: string[] = [];
    for (const sys of this.systems.values()) {
      if (sys.system_id === process.env.VFARM_SYSTEM_ID && !process.env.VFARM_WORKSPACE_ID) {
        derived.push(sys.system_id);
      }
    }
    return validateSystemRegistry({
      systems: Array.from(this.systems.values()),
      tenants: CoreRegistry.getAllTenants(),
      projects: CoreRegistry.getAllTenants().flatMap((t) => CoreRegistry.getProjectsForTenant(t.tenant_id)),
      bindings: CoreRegistry.getAllBindings(),
      derivedWorkspaceSystemIds: derived,
    });
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
