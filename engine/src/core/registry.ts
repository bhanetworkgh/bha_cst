import { maskPhone } from '../util/privacy.js';
import { Tenant, Project, ServiceNumberBinding, SpeakerIdentity, CapabilityType, matchesCapability } from './types.js';
import { ITenantAdapter } from '../adapters/types.js';
import { VfarmTenantAdapter, VfarmAdapterConfig } from '../adapters/vfarm/index.js';
import {
  buildDevFixtureProjects,
  DEV_FIXTURE_CANDIDATE_NUMBERS,
  DEV_FIXTURE_ONBOARDING_REPLY,
  DEV_FIXTURE_ORG_ID,
  DEV_FIXTURE_TENANT_ID,
  DEV_FIXTURE_TENANT_NAME,
  DEV_FIXTURE_VOICE_ID,
  DEV_FIXTURE_VOICE_MODEL_ID,
} from '../adapters/vfarm/dev_seed.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';
import { getEnv } from '../config/env.js';
import { isTestRunner } from '../config/runtime.js';

export interface SpeakerCacheEntry {
  identity: SpeakerIdentity;
  cachedAt: number;
  expiresAt: number;
}

/**
 * Build the vFarm adapter config from validated env vars. Returns `{}` (local
 * mode — no live upstream calls) whenever VFARM_BASE_URL is not configured,
 * so existing dev/test setups that never set it keep working unchanged.
 */
function buildVfarmAdapterConfigFromEnv(): VfarmAdapterConfig {
  // Never wire a live vFarm upstream from inside a test runner. Keyed off the
  // vitest signal rather than NODE_ENV, which the repo's `.env` overwrites with
  // 'development' (sourcing it used to make unit tests build a live adapter).
  // VFARM_LIVE_TEST=true is the explicit opt-in for a test that wants it.
  if (isTestRunner() && process.env.VFARM_LIVE_TEST !== 'true') {
    return {};
  }
  try {
    const env = getEnv();
    const baseUrl = env.VFARM_API_BASE_URL || process.env.VFARM_BASE_URL;
    if (!baseUrl) return {};
    return {
      baseUrl,
      apiKey: env.VFARM_API_FARM_KEY || process.env.VFARM_FARM_KEY || process.env.VFARM_API_KEY,
      apiToken: env.VFARM_API_JWT || process.env.VFARM_JWT || process.env.VFARM_API_TOKEN,
      timeoutMs: env.VFARM_API_TIMEOUT_MS || (process.env.VFARM_TIMEOUT_MS ? Number(process.env.VFARM_TIMEOUT_MS) : undefined),
      tenantOrgId: process.env.VFARM_TENANT_ORG_ID,
    };
  } catch {
    // Env not fully configured in this context (e.g. isolated unit test) —
    // fall back to process.env
    const baseUrl = process.env.VFARM_API_BASE_URL || process.env.VFARM_BASE_URL;
    if (!baseUrl) return {};
    return {
      baseUrl,
      apiKey: process.env.VFARM_API_FARM_KEY || process.env.VFARM_FARM_KEY || process.env.VFARM_API_KEY,
      apiToken: process.env.VFARM_API_JWT || process.env.VFARM_JWT || process.env.VFARM_API_TOKEN,
      timeoutMs: process.env.VFARM_API_TIMEOUT_MS
        ? Number(process.env.VFARM_API_TIMEOUT_MS)
        : (process.env.VFARM_TIMEOUT_MS ? Number(process.env.VFARM_TIMEOUT_MS) : undefined),
      tenantOrgId: process.env.VFARM_TENANT_ORG_ID,
    };
  }
}

export class CoreRegistry {
  private static tenants: Map<string, Tenant> = new Map();
  private static adapters: Map<string, ITenantAdapter> = new Map();
  private static projects: Map<string, Project> = new Map(); // projectId -> Project
  private static candidateNumbers: Set<string> = new Set();
  private static serviceNumberBindings: Map<string, ServiceNumberBinding> = new Map(); // phoneE164 -> ServiceNumberBinding
  private static speakerCache: Map<string, SpeakerCacheEntry> = new Map(); // `${tenantId}:${projectId}:${phone}` -> cache entry

  private static readonly CACHE_TTL_MS = 60_000; // 60 seconds TTL

  static {
    if (isTestRunner()) {
      this.resetToDefault();
    }
  }

  /**
   * Seed the DEV/TEST FIXTURE tenancy state.
   *
   * This is a FALLBACK for the test-suite and the local demo. It is NOT the
   * production source of truth: production tenancy comes from the database
   * (`initFromDb()`) and, optionally, from live vFarm discovery
   * (`syncProjectsFromAdapter()`).
   *
   * `initFromDb()` only calls this when the database is completely empty AND
   * `NODE_ENV !== 'production'`, and the static initialiser calls it only in a
   * test runner. A production boot therefore never sees these literals.
   *
   * @see adapters/vfarm/dev_seed.ts for the fixture and why it is a fixture.
   */
  static resetToDefault(): void {

    this.clear();

    // Register Tenant #1 (vFarm)
    const vfarmTenant: Tenant = {
      tenant_id: DEV_FIXTURE_TENANT_ID,
      name: DEV_FIXTURE_TENANT_NAME,
      status: 'active',
      adapter_type: 'vfarm',
      created_at: new Date().toISOString(),
    };
    const vfarmAdapter = new VfarmTenantAdapter(vfarmTenant.tenant_id, buildVfarmAdapterConfigFromEnv());
    this.registerTenant(vfarmTenant, vfarmAdapter);

    // Register Default Projects pulled from vFarm.
    // tenant_org_id must be the real vFarm organization UUID, discovered from
    // GET /api/v1/organizations. The previous values ('org-vfarm-austin' /
    // 'org-vfarm-dallas') were CST placeholders that matched no vFarm org and
    // made vFarm answer HTTP 422, so the live membership cross-check could
    // never run (G19).
    const vfarmOrgId = process.env.VFARM_TENANT_ORG_ID || DEV_FIXTURE_ORG_ID;

    // Resolve voice pointer from env — never hardcode a placeholder
    const defaultVoiceId = process.env.VFARM_ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || DEV_FIXTURE_VOICE_ID;
    const defaultModelId = process.env.VFARM_ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL_ID || DEV_FIXTURE_VOICE_MODEL_ID;

    const [fixtureMain, fixtureDallas] = buildDevFixtureProjects(
      vfarmTenant.tenant_id,
      vfarmOrgId,
      process.env.VFARM_ONBOARDING_REPLY || DEV_FIXTURE_ONBOARDING_REPLY,
    );

    const mainProject: Project = {
      ...fixtureMain,
      capabilities: { sms: true, voice: true, web: true },
      elevenlabs_voice_id: defaultVoiceId,
      elevenlabs_model_id: defaultModelId,
      voice_enabled: true,
      synced_at: new Date().toISOString(),
    };

    // The secondary project is deliberately NOT voice-enabled.
    //
    // It has no ElevenLabs voice pointer and no voice service number, and the
    // only number ever associated with it is not owned by the Twilio account,
    // so it can serve neither transport from Twilio's side. Advertising
    // `voice: true` here would let the voice lane accept a call and then
    // fail at synthesis, which is exactly the silent "configured but broken"
    // state this reconciliation exists to remove.
    //
    // To enable its voice, an operator must (1) point a real, owned voice
    // pointer at it and (2) bind an owned service number with the 'voice' (or
    // 'sms_voice') capability. Until then the capability stays false and the
    // project gate refuses the channel.
    const dallasProject: Project = {
      ...fixtureDallas,
      capabilities: { sms: true, voice: false, web: true },
      voice_enabled: false,
      synced_at: new Date().toISOString(),
    };

    this.registerProject(mainProject);
    this.registerProject(dallasProject);

    // Sync candidate numbers — only numbers actually owned by the Twilio account
    this.addCandidateNumbers([...DEV_FIXTURE_CANDIDATE_NUMBERS]);

    // Bind the fixture number as sms_voice so it handles BOTH SMS and voice
    this.bindServiceNumber({
      phone_e164: DEV_FIXTURE_CANDIDATE_NUMBERS[0],
      tenant_id: vfarmTenant.tenant_id,
      project_id: mainProject.project_id,
      capability: 'sms_voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });
  }

  static clear(): void {
    this.tenants.clear();
    this.adapters.clear();
    this.projects.clear();
    this.candidateNumbers.clear();
    this.serviceNumberBindings.clear();
    this.speakerCache.clear();
  }

  /**
   * Bootstrap registry state from durable database tables.
   * CRITICAL: Restores projects and bindings without automatically
   * overwriting them with default bindings upon server startup/restart.
   */
  static async initFromDb(): Promise<void> {
    // 1. Load tenants from DB
    const dbTenants = await DbClient.getAllTenants();
    for (const t of dbTenants) {
      if (!this.tenants.has(t.tenant_id)) {
        let adapter: ITenantAdapter | undefined;
        if (t.tenant_id === 'tenant-vfarm-01' || t.adapter_type === 'vfarm') {
          const config: VfarmAdapterConfig = {
            ...buildVfarmAdapterConfigFromEnv(),
            ...(t.adapter_config as VfarmAdapterConfig | undefined),
          };
          adapter = new VfarmTenantAdapter(t.tenant_id, config);
        }
        this.tenants.set(t.tenant_id, t);
        if (adapter) {
          this.adapters.set(t.tenant_id, adapter);
        }
      }
    }

    // 2. Load projects from DB
    const dbProjects = await DbClient.getAllProjects();
    for (const p of dbProjects) {
      if (!p.elevenlabs_voice_id && p.project_id === 'proj-vfarm-main') {
        const configuredVoice = process.env.VFARM_ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || 'eleven_voice_jason_vfarm';
        if (configuredVoice) {
          p.elevenlabs_voice_id = configuredVoice;
          p.elevenlabs_model_id = process.env.VFARM_ELEVENLABS_MODEL_ID || process.env.ELEVENLABS_MODEL_ID || p.elevenlabs_model_id || 'eleven_turbo_v2_5';
          p.voice_enabled = true;
          try {
            await DbClient.saveProject(p);
          } catch (err: any) {
            Logger.warn(`CoreRegistry: Failed to backfill project voice pointer to DB: ${err.message}`);
          }
        }
      }
      this.projects.set(p.project_id, p);
      const adapter = this.adapters.get(p.tenant_id);
      if (adapter?.addProject) {
        adapter.addProject(p);
      }
    }

    // 3. Load service number bindings from DB
    const dbBindings = await DbClient.getAllServiceNumberBindings();
    if (dbBindings.length > 0) {
      this.serviceNumberBindings.clear();
      for (const b of dbBindings) {
        this.serviceNumberBindings.set(b.phone_e164, b);
        this.candidateNumbers.add(b.phone_e164);
      }
    } else if (this.serviceNumberBindings.size === 0 && this.projects.size === 0) {
      // In non-production test/dev mode, seed defaults if DB is completely empty; NEVER in production
      if (process.env.NODE_ENV !== 'production') {
        this.resetToDefault();
      }
    }

    // 4. Restore the admin-managed phone -> identity directory from the
    //    durable CST mapping.
    //
    // WHY THIS IS REQUIRED
    //   vFarm exposes NO phone field on a user (docs handoff §6), so the
    //   phone -> vFarm user_id binding is CST-owned and lives in the
    //   `customers` table. The tenant adapter's runtime directory is an
    //   IN-MEMORY map, and it was only ever written by an admin action
    //   (registerSpeaker / syncMembers). Nothing restored it at boot.
    //
    //   The consequence was severe and is exactly the reported symptom: the
    //   adapter's constructor re-seeds a DEMO directory on every process
    //   start, so after each restart the inbound caller number resolved
    //   against a fabricated person_id. The live organisation-membership
    //   check then correctly refused that fabricated id, the speaker was
    //   returned as `opaque_revoked` (an unknown caller), the engine saw
    //   zero farm scope, and the assistant answered with the generic
    //   specialist-escalation message instead of the caller's farm data.
    //
    //   On Render's free tier the service hibernates after 15 minutes idle,
    //   so this happened many times a day.
    //
    // WHAT THIS DOES NOT DO
    //   It does not grant, widen or infer any authorisation. The rows are
    //   only the ones an operator already created through the admin
    //   console. The live upstream verification (organisation membership,
    //   then the authoritative farm-grants list) still runs on every
    //   resolve, and a member removed upstream still resolves as
    //   `opaque_revoked` and a user with no grants still resolves with
    //   zero farm scope. Both fail closed, exactly as before.
    const dbCustomers = await DbClient.getAllCustomers();
    let hydrated = 0;

    // A phone is only ever bound WITHIN one project, so a conflicting mapping
    // is detected before anything is written: if the same phone resolves to two
    // different customer references in the SAME project, NEITHER is bound.
    // Silently picking one would let one customer impersonate another.
    const byProjectPhone = new Map<string, Set<string>>();
    for (const c of dbCustomers) {
      if (!c.project_id || !c.phone_e164 || !c.customer_ref) continue;
      const key = `${c.project_id}::${c.phone_e164.trim()}`;
      if (!byProjectPhone.has(key)) byProjectPhone.set(key, new Set());
      byProjectPhone.get(key)!.add(c.customer_ref);
    }

    for (const c of dbCustomers) {
      const adapter = this.adapters.get(c.tenant_id);
      if (!adapter?.registerSpeaker) continue;
      if (!c.customer_ref || !c.phone_e164) continue;
      if (!c.project_id) {
        Logger.warn(
          `CoreRegistry: skipping customer binding for ${maskPhone(c.phone_e164)} in tenant ${c.tenant_id} — the record has no project_id`,
        );
        continue;
      }

      // Tenant isolation: the project must belong to the record's tenant. A
      // record that names a project of another tenant is conflicting data and
      // is refused rather than bound.
      const project = this.projects.get(c.project_id);
      if (!project) {
        Logger.warn(
          `CoreRegistry: skipping customer binding for ${maskPhone(c.phone_e164)} — project ${c.project_id} does not exist`,
        );
        continue;
      }
      if (project.tenant_id !== c.tenant_id) {
        Logger.warn(
          `CoreRegistry: skipping customer binding for ${maskPhone(c.phone_e164)} — record tenant ${c.tenant_id} does not own project ${c.project_id} (tenant isolation)`,
        );
        continue;
      }

      // Conflicting mapping: the same phone bound to two references in one
      // project. Bind neither.
      const key = `${c.project_id}::${c.phone_e164.trim()}`;
      if ((byProjectPhone.get(key)?.size || 0) > 1) {
        Logger.warn(
          `CoreRegistry: skipping customer binding for ${maskPhone(c.phone_e164)} in project ${c.project_id} — conflicting customer references are bound to the same number`,
        );
        continue;
      }

      try {
        adapter.registerSpeaker(c.project_id, {
          person_id: c.customer_ref,
          phone_e164: c.phone_e164,
          role: (c.role || 'manager') as 'owner' | 'manager' | 'tech',
          farm_ids: Array.isArray(c.farm_ids) ? c.farm_ids.filter(Boolean) : [],
        });
        hydrated++;
      } catch (err: any) {
        Logger.warn(
          `CoreRegistry: could not restore speaker binding for tenant ${c.tenant_id}: ${err?.message}`,
        );
      }
    }
    if (hydrated > 0) {
      Logger.info(
        `CoreRegistry: restored ${hydrated} admin-managed phone->identity binding(s) from the durable customer records`,
      );
    }

  }


  // ── Tenant Registration ───────────────────────────────────────────────────

  static registerTenant(tenant: Tenant, adapter?: ITenantAdapter): void {
    this.tenants.set(tenant.tenant_id, tenant);
    if (adapter) {
      this.adapters.set(tenant.tenant_id, adapter);
    }
    if (typeof DbClient !== 'undefined' && DbClient?.saveTenant) {
      DbClient.saveTenant(tenant).catch((err) => {
        Logger.warn(`CoreRegistry: Failed to persist tenant ${tenant.tenant_id}: ${err.message}`);
      });
    }
  }

  static getTenant(tenantId: string): Tenant | null {
    return this.tenants.get(tenantId) || null;
  }

  static getAllTenants(): Tenant[] {
    return Array.from(this.tenants.values());
  }

  static getAdapter(tenantId: string): ITenantAdapter | null {
    return this.adapters.get(tenantId) || null;
  }

  static getVfarmAdapter(): VfarmTenantAdapter | null {
    const adapter = this.adapters.get('tenant-vfarm-01');
    return (adapter instanceof VfarmTenantAdapter) ? adapter : null;
  }

  // ── Project Management ────────────────────────────────────────────────────

  static registerProject(project: Project): void {
    this.projects.set(project.project_id, project);
    const adapter = this.adapters.get(project.tenant_id);
    if (adapter?.addProject) {
      adapter.addProject(project);
    }
    if (typeof DbClient !== 'undefined' && DbClient?.saveProject) {
      DbClient.saveProject(project).catch((err) => {
        Logger.warn(`CoreRegistry: Failed to persist project ${project.project_id}: ${err.message}`);
      });
    }
  }

  static getProject(projectId: string): Project | null {
    return this.projects.get(projectId) || null;
  }

  static getProjectsForTenant(tenantId: string): Project[] {
    return Array.from(this.projects.values()).filter((p) => p.tenant_id === tenantId);
  }

  static async syncProjectsFromAdapter(tenantId: string): Promise<Project[]> {
    const adapter = this.getAdapter(tenantId);
    if (!adapter) {
      throw new Error(`No adapter registered for tenant ${tenantId}`);
    }
    const pulledProjects = await adapter.pullProjects(tenantId);
    const now = new Date().toISOString();
    for (const proj of pulledProjects) {
      proj.synced_at = now;
      this.registerProject(proj);
    }
    return pulledProjects;
  }

  // ── Candidate Numbers & Explicit Service Number Binding ──────────────────

  static addCandidateNumbers(phones: string[]): void {
    for (const phone of phones) {
      this.candidateNumbers.add(phone.trim());
    }
  }

  static getCandidateNumbers(): string[] {
    return Array.from(this.candidateNumbers);
  }

  /**
   * Bind service number strictly to (tenant_id, project_id, capability).
   * R-NUM-S3: One service number MUST NOT bind to two projects. Collision -> refuse bind.
   */
  static bindServiceNumber(binding: ServiceNumberBinding): void {
    const phone = binding.phone_e164.trim();
    const existing = this.serviceNumberBindings.get(phone);

    if (existing) {
      if (existing.tenant_id !== binding.tenant_id || existing.project_id !== binding.project_id) {
        const errorMsg = `Collision detected: service number ${phone} is already bound to tenant "${existing.tenant_id}", project "${existing.project_id}". Cannot bind to tenant "${binding.tenant_id}", project "${binding.project_id}".`;
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: binding.tenant_id,
          actor: 'admin_api',
          role: 'admin',
          entry_point: 'api',
          tool_or_route: 'CoreRegistry.bindServiceNumber',
          outcome: 'refused',
          reason: errorMsg,
        });
        throw new Error(errorMsg);
      }
    }

    // Verify project exists and belongs to tenant
    const project = this.getProject(binding.project_id);
    if (!project) {
      throw new Error(`Project "${binding.project_id}" not found.`);
    }
    if (project.tenant_id !== binding.tenant_id) {
      throw new Error(`Project "${binding.project_id}" does not belong to tenant "${binding.tenant_id}".`);
    }

    const fullBinding: ServiceNumberBinding = {
      ...binding,
      phone_e164: phone,
      status: 'bound',
      bound_at: binding.bound_at || new Date().toISOString(),
    };

    this.serviceNumberBindings.set(phone, fullBinding);
    this.candidateNumbers.add(phone);

    if (typeof DbClient !== 'undefined' && DbClient?.saveServiceNumberBinding) {
      DbClient.saveServiceNumberBinding(fullBinding).catch((err) => {
        Logger.warn(`CoreRegistry: Failed to persist binding for ${phone}: ${err.message}`);
      });
    }

    Logger.info(`Bound service number ${phone} -> tenant: ${binding.tenant_id}, project: ${binding.project_id}, capability: ${binding.capability}`);
  }

  static unbindServiceNumber(phoneE164: string): boolean {
    const deleted = this.serviceNumberBindings.delete(phoneE164.trim());
    if (deleted) {
      if (typeof DbClient !== 'undefined' && DbClient?.removeServiceNumberBinding) {
        DbClient.removeServiceNumberBinding(phoneE164.trim()).catch((err) => {
          Logger.warn(`CoreRegistry: Failed to remove persisted binding for ${phoneE164}: ${err.message}`);
        });
      }
    }
    return deleted;
  }


  static resolveServiceNumber(phoneE164: string): ServiceNumberBinding | null {
    if (!phoneE164) return null;
    return this.serviceNumberBindings.get(phoneE164.trim()) || null;
  }

  static getAllBindings(): ServiceNumberBinding[] {
    return Array.from(this.serviceNumberBindings.values());
  }

  /**
   * Resolve the authoritative SENDING service number for a project.
   *
   * Chain (the only supported one for outbound SMS):
   *   OutboundMessage.project_id -> service_number_binding -> phone_e164
   *
   * There is deliberately no "first phone of the tenant's system" or
   * VFARM_PHONE_NUMBERS fallback: a number that is not explicitly bound to this
   * tenant+project is not authorized to originate this project's traffic.
   */
  static resolveProjectServiceNumber(
    tenantId: string,
    projectId: string | undefined,
    capability: CapabilityType = 'sms'
  ): ServiceNumberBinding | null {
    if (!tenantId || !projectId) return null;
    for (const binding of this.serviceNumberBindings.values()) {
      if (
        binding.tenant_id === tenantId &&
        binding.project_id === projectId &&
        matchesCapability(binding.capability, capability) &&
        binding.status === 'bound'
      ) {
        return binding;
      }
    }
    return null;
  }

  // ── Speaker Identity Resolution & Projection Cache ───────────────────────

  static async resolveSpeaker(params: {
    tenantId: string;
    projectId: string;
    phoneE164: string;
  }): Promise<SpeakerIdentity> {
    const cleanPhone = (params.phoneE164 || '').trim();
    const cacheKey = `${params.tenantId}:${params.projectId}:${cleanPhone}`;
    const now = Date.now();

    // 1. Check in-memory short TTL cache
    const cached = this.speakerCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return cached.identity;
    }

    // 2. Fetch via Tenant Adapter
    const adapter = this.getAdapter(params.tenantId);
    if (!adapter) {
      Logger.warn(`No adapter for tenant ${params.tenantId}; returning unknown speaker`);
      const safeRef = `opaque_unresolved_${cleanPhone.replace(/[^0-9]/g, '')}`;
      return {
        person_id: safeRef,
        customer_ref: safeRef,
        tenant_id: params.tenantId,
        project_id: params.projectId,
        phone_e164: cleanPhone,
        is_known: false,
        role: 'unknown',
        permissions: [],
        farm_ids: [],
      };
    }

    try {
      const resolved = await adapter.resolveSpeaker({
        tenantId: params.tenantId,
        projectId: params.projectId,
        phoneE164: cleanPhone,
      });

      // Populate short TTL cache
      this.speakerCache.set(cacheKey, {
        identity: resolved,
        cachedAt: now,
        expiresAt: now + this.CACHE_TTL_MS,
      });

      return resolved;
    } catch (err: any) {
      // Degraded / timeout state (R-ID-8): Fail closed. Zero farm data, honest unavailable.
      Logger.warn(`Speaker resolve failed for tenant ${params.tenantId} (degraded): ${err.message}`);
      const safeRef = `opaque_degraded_${cleanPhone.replace(/[^0-9]/g, '')}`;
      return {
        person_id: safeRef,
        customer_ref: safeRef,
        tenant_id: params.tenantId,
        project_id: params.projectId,
        phone_e164: cleanPhone,
        is_known: false,
        role: 'unknown',
        permissions: [],
        farm_ids: [],
        resolution_state: 'degraded',
      };
    }
  }

  static invalidateSpeakerCache(tenantId?: string, projectId?: string, phoneE164?: string): void {
    if (!tenantId) {
      this.speakerCache.clear();
      return;
    }
    if (phoneE164 && projectId) {
      this.speakerCache.delete(`${tenantId}:${projectId}:${phoneE164.trim()}`);
      return;
    }
    for (const key of Array.from(this.speakerCache.keys())) {
      if (key.startsWith(`${tenantId}:`)) {
        this.speakerCache.delete(key);
      }
    }
  }
}
