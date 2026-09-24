import { Tenant, Project, ServiceNumberBinding, SpeakerIdentity, CapabilityType } from './types.js';
import { ITenantAdapter } from '../adapters/types.js';
import { VfarmTenantAdapter } from '../adapters/vfarm/index.js';
import { Logger } from '../config/logger.js';
import { DbClient } from '../db/client.js';
import type { VfarmAdapterConfig } from '../adapters/vfarm/index.js';

/**
 * Read vFarm adapter configuration from environment variables.
 * Inlined here (not imported from adapter) to avoid circular ESM initialisation.
 * Returns undefined when VFARM_BASE_URL is not set → local/mock mode preserved.
 */
function _buildVfarmConfigFromEnv(): VfarmAdapterConfig | undefined {
  const baseUrl = process.env.VFARM_BASE_URL;
  if (!baseUrl) return undefined;
  return {
    baseUrl,
    apiKey: process.env.VFARM_API_KEY ?? '',
    timeoutMs: process.env.VFARM_TIMEOUT_MS ? Number(process.env.VFARM_TIMEOUT_MS) : 5_000,
  };
}

export interface SpeakerCacheEntry {
  identity: SpeakerIdentity;
  cachedAt: number;
  expiresAt: number;
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
    if (process.env.NODE_ENV === 'test') {
      this.resetToDefault();
    }
  }

  static resetToDefault(): void {

    this.clear();

    // Register Tenant #1 (vFarm)
    const vfarmTenant: Tenant = {
      tenant_id: 'tenant-vfarm-01',
      name: 'vFarm Global',
      status: 'active',
      adapter_type: 'vfarm',
      created_at: new Date().toISOString(),
    };
    const vfarmEnvConfig = _buildVfarmConfigFromEnv();
    const vfarmAdapter = new VfarmTenantAdapter(vfarmTenant.tenant_id, vfarmEnvConfig ?? {});
    this.registerTenant(vfarmTenant, vfarmAdapter);

    // Register Default Projects pulled from vFarm
    const mainProject: Project = {
      project_id: 'proj-vfarm-main',
      tenant_id: 'tenant-vfarm-01',
      name: 'vFarm Austin HQ',
      status: 'active',
      tenant_org_id: 'org-vfarm-austin',
      capabilities: { sms: true, voice: true, web: true },
      speaker_policy: 'allowlist',
      onboarding_reply: process.env.VFARM_ONBOARDING_REPLY || 'Welcome to vFarm Support! We received your message. A specialist will assist you shortly.',
      elevenlabs_voice_id: 'eleven_voice_jason_vfarm',
      elevenlabs_model_id: 'eleven_turbo_v2_5',
      voice_enabled: true,
      synced_at: new Date().toISOString(),
    };

    const dallasProject: Project = {
      project_id: 'proj-vfarm-dallas',
      tenant_id: 'tenant-vfarm-01',
      name: 'vFarm Dallas Operations',
      status: 'active',
      tenant_org_id: 'org-vfarm-dallas',
      capabilities: { sms: true, voice: true, web: true },
      speaker_policy: 'allowlist',
      onboarding_reply: 'Welcome to vFarm Dallas Support! Contact your site manager for access.',
      voice_enabled: true,
      synced_at: new Date().toISOString(),
    };

    this.registerProject(mainProject);
    this.registerProject(dallasProject);

    // Sync candidate numbers
    this.addCandidateNumbers(['+19715885823', '+19715885824', '+19715885825']);

    // Bind default service numbers (R-NUM-S2)
    this.bindServiceNumber({
      phone_e164: '+19715885823',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      capability: 'sms',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    this.bindServiceNumber({
      phone_e164: '+19715885824',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-dallas',
      capability: 'sms',
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
    // Resolve live adapter config once from env (shared across all vFarm tenants)
    const vfarmEnvConfig = _buildVfarmConfigFromEnv();

    // 1. Load tenants from DB
    const dbTenants = await DbClient.getAllTenants();
    for (const t of dbTenants) {
      if (!this.tenants.has(t.tenant_id)) {
        let adapter: ITenantAdapter | undefined;
        if (t.adapter_type === 'vfarm') {
          // Prefer env-supplied live config when VFARM_BASE_URL is set;
          // fall back to adapter_config stored in DB for per-tenant overrides;
          // last resort: empty config (local/mock mode).
          const adapterConfig = vfarmEnvConfig ?? (t.adapter_config as Record<string, unknown> | undefined) ?? {};
          adapter = new VfarmTenantAdapter(t.tenant_id, adapterConfig);
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
      this.projects.set(p.project_id, p);
      // Push into the owning tenant's adapter (e.g. VfarmTenantAdapter.projectsMap)
      // so adapter-internal lookups like _getProjectOrgId() see the DB-loaded
      // tenant_org_id instead of only the adapter's hardcoded defaults.
      // Do NOT go through registerProject() here — these records already
      // came from the DB, so re-persisting them is unnecessary.
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

  // ── Project Management ────────────────────────────────────────────────────

  static registerProject(project: Project): void {
    this.projects.set(project.project_id, project);
    if (typeof DbClient !== 'undefined' && DbClient?.saveProject) {
      DbClient.saveProject(project).catch((err) => {
        Logger.warn(`CoreRegistry: Failed to persist project ${project.project_id}: ${err.message}`);
      });
    }
    // Keep the tenant adapter's own in-memory project projection (e.g.
    // vFarm's projectsMap, which backs _getProjectOrgId) in sync so
    // fields like tenant_org_id set here are visible to the adapter
    // instead of only the registry.
    const adapter = this.adapters.get(project.tenant_id);
    if (adapter?.addProject) {
      adapter.addProject(project);
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
    // Best-effort speaker warmup: populate the adapter's speakersMap from
    // CST's existing phone→person_id bindings so the first inbound message
    // does not require a cold adapter lookup.
    await this.warmupSpeakers(tenantId).catch((err) => {
      Logger.warn(`CoreRegistry.syncProjectsFromAdapter: speaker warmup failed for tenant ${tenantId}: ${err.message}`);
    });
    return pulledProjects;
  }

  /**
   * Warm the adapter's in-memory speaker binding map for every project
   * belonging to `tenantId`.
   *
   * Architecture note: vFarm does NOT expose phone_e164 in any API response.
   * The phone ↔ person_id mapping is owned exclusively by CST (stored in the
   * adapter's speakersMap / persisted in the customers table). This method
   * pulls those locally-held bindings back into the adapter's hot map so that
   * speaker resolution on the first inbound call is served from memory rather
   * than hitting the DB.
   *
   * Warm-up does NOT invent phone numbers from vFarm; it only re-loads
   * bindings that CST already owns.
   * Failures are logged per-project and do NOT abort warmup of other projects.
   * Tenant/project isolation is preserved: only the owning adapter is called.
   */
  static async warmupSpeakers(tenantId: string): Promise<void> {
    const adapter = this.getAdapter(tenantId);
    if (!adapter) {
      Logger.warn(`CoreRegistry.warmupSpeakers: no adapter for tenant ${tenantId}`);
      return;
    }
    const projects = this.getProjectsForTenant(tenantId);
    if (projects.length === 0) {
      Logger.warn(`CoreRegistry.warmupSpeakers: no projects found for tenant ${tenantId}`);
      return;
    }
    let warmedCount = 0;
    for (const project of projects) {
      if (project.tenant_id !== tenantId) continue; // Extra isolation guard
      try {
        const speakers = await adapter.pullSpeakers(tenantId, project.project_id);
        Logger.info(
          `CoreRegistry.warmupSpeakers: warmed ${speakers.length} speakers ` +
          `for tenant=${tenantId} project=${project.project_id}`,
        );
        warmedCount += speakers.length;
      } catch (err: any) {
        Logger.warn(
          `CoreRegistry.warmupSpeakers: pullSpeakers failed for ` +
          `tenant=${tenantId} project=${project.project_id}: ${err.message}`,
        );
      }
    }
    Logger.info(`CoreRegistry.warmupSpeakers: total ${warmedCount} speaker bindings warmed for tenant=${tenantId}`);
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