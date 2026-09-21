import { ITenantAdapter } from '../types.js';
import { Project, ResourceScope, SpeakerRecord, SpeakerIdentity, UserRole, CabinetConfig } from '../../core/types.js';
import { Logger } from '../../config/logger.js';
import { getPermissionsForRole } from '../../identity/resolver.js';
import { VfarmLiveClient, VfarmHttpError, VfarmNetworkError, type FetchFn } from './live_client.js';
import type { ConfigResponse } from './schemas.js';

export interface VfarmAdapterConfig {
  // Live-mode options (populated from env when VFARM_BASE_URL is set)
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable fetch for testing; defaults to global fetch */
  fetchFn?: FetchFn;

  // Legacy / compatibility fields
  resolveEndpoint?: string;
  bharagWorkspaceKey?: string;
  mediaBaseUrl?: string;
  simulateDegraded?: boolean;
}

/**
 * Build a VfarmAdapterConfig from environment variables.
 * Returns undefined when VFARM_BASE_URL is not configured (local/mock mode).
 *
 * Environment variables used:
 *   VFARM_BASE_URL      – required for live mode
 *   VFARM_API_KEY       – credential for X-Farm-Key header (never logged)
 *   VFARM_TIMEOUT_MS    – optional request timeout (default 5000ms)
 */
export function buildVfarmAdapterConfigFromEnv(): VfarmAdapterConfig | undefined {
  const baseUrl = process.env.VFARM_BASE_URL;
  if (!baseUrl) {
    return undefined; // No live vFarm URL → local/mock mode
  }
  return {
    baseUrl,
    apiKey: process.env.VFARM_API_KEY ?? '',
    timeoutMs: process.env.VFARM_TIMEOUT_MS ? Number(process.env.VFARM_TIMEOUT_MS) : 5_000,
  };
}

export class VfarmTenantAdapter implements ITenantAdapter {
  readonly tenantId: string;
  private config: VfarmAdapterConfig;
  private liveClient: VfarmLiveClient | null = null;

  // In-memory data store for vFarm tenancy projection & mocking
  private projectsMap: Map<string, Project> = new Map();
  private resourceScopesMap: Map<string, ResourceScope[]> = new Map(); // projectId -> farms[]
  private speakersMap: Map<string, Map<string, SpeakerRecord>> = new Map(); // projectId -> (phone -> SpeakerRecord)
  private cabinetConfigMap: Map<string, CabinetConfig> = new Map();

  constructor(tenantId = 'tenant-vfarm-01', config: VfarmAdapterConfig = {}) {
    this.tenantId = tenantId;
    this.config = config;

    // Instantiate live client when base URL is configured
    if (config.baseUrl) {
      this.liveClient = new VfarmLiveClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey ?? '',
        timeoutMs: config.timeoutMs,
        fetchFn: config.fetchFn,
      });
    }

    this.initDefaultData();
  }

  public setDegraded(degraded: boolean): void {
    this.config.simulateDegraded = degraded;
  }

  private initDefaultData(): void {
    // Project 1: Main vFarm Org (Austin)
    const proj1: Project = {
      project_id: 'proj-vfarm-main',
      tenant_id: this.tenantId,
      name: 'vFarm Austin HQ',
      status: 'active',
      tenant_org_id: 'org-vfarm-austin',
      capabilities: { sms: true, voice: true },
      speaker_policy: 'allowlist',
      onboarding_reply: process.env.VFARM_ONBOARDING_REPLY || 'Welcome to vFarm Support! We received your message. A specialist will assist you shortly.',
    };

    // Project 2: Secondary vFarm Org (Dallas)
    const proj2: Project = {
      project_id: 'proj-vfarm-dallas',
      tenant_id: this.tenantId,
      name: 'vFarm Dallas Operations',
      status: 'active',
      tenant_org_id: 'org-vfarm-dallas',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
      onboarding_reply: 'Welcome to vFarm Dallas Support! Contact your site manager for access.',
    };

    this.projectsMap.set(proj1.project_id, proj1);
    this.projectsMap.set(proj2.project_id, proj2);

    // Resources (Farms)
    this.resourceScopesMap.set(proj1.project_id, [
      { id: 'farm_austin_main', name: 'Austin Main Facility', type: 'farm' },
      { id: 'farm_austin_east', name: 'Austin East Greenhouses', type: 'farm' },
    ]);

    this.resourceScopesMap.set(proj2.project_id, [
      { id: 'farm_dallas_north', name: 'Dallas North Facility', type: 'farm' },
    ]);

    // Speakers for Project 1 (Austin)
    const p1Speakers = new Map<string, SpeakerRecord>();
    p1Speakers.set('+923082113844', {
      person_id: 'usr_vfarm_003',
      phone_e164: '+923082113844',
      role: 'owner',
      farm_ids: ['farm_austin_main'],
      name: 'Test Owner',
    });
    p1Speakers.set('+15551234567', {
      person_id: 'usr_vfarm_001',
      phone_e164: '+15551234567',
      role: 'manager',
      farm_ids: ['farm_austin_main'],
      name: 'John Doe',
    });
    p1Speakers.set('+15558887777', {
      person_id: 'usr_vfarm_002',
      phone_e164: '+15558887777',
      role: 'tech',
      farm_ids: ['farm_austin_main'],
      name: 'Alice Smith',
    });
    this.speakersMap.set(proj1.project_id, p1Speakers);

    // Speakers for Project 2 (Dallas)
    const p2Speakers = new Map<string, SpeakerRecord>();
    p2Speakers.set('+15559990000', {
      person_id: 'usr_vfarm_dallas_001',
      phone_e164: '+15559990000',
      role: 'owner',
      farm_ids: ['farm_dallas_north'],
      name: 'Dallas Owner',
    });
    this.speakersMap.set(proj2.project_id, p2Speakers);
  }

  // Dynamic helper methods for testing & administration
  public addProject(project: Project): void {
    this.projectsMap.set(project.project_id, project);
  }

  public registerSpeaker(projectId: string, speaker: SpeakerRecord): void {
    let pMap = this.speakersMap.get(projectId);
    if (!pMap) {
      pMap = new Map();
      this.speakersMap.set(projectId, pMap);
    }
    if (!speaker.phone_e164 || !this.isValidE164(speaker.phone_e164)) {
      throw new Error('Speaker phone_e164 is required and must be valid E.164');
    }
    pMap.set(speaker.phone_e164.trim(), { ...speaker, phone_e164: speaker.phone_e164.trim() });
  }

  public registerCabinetConfig(config: CabinetConfig): void {
    this.cabinetConfigMap.set(`${config.farm_id}:${config.serial}`, { ...config });
  }

  public removeSpeaker(projectId: string, phoneE164: string): boolean {
    const pMap = this.speakersMap.get(projectId);
    if (!pMap) return false;
    return pMap.delete(phoneE164.trim());
  }

  public isValidE164(phone: string): boolean {
    const candidate = (phone || '').trim();
    return /^\+[1-9]\d{1,14}$/.test(candidate);
  }

  async syncMembers(tenantId: string, projectId: string, members: SpeakerRecord[]): Promise<SpeakerRecord[]> {
    if (tenantId !== this.tenantId) {
      throw new Error(`Tenant ${tenantId} is not managed by this vFarm adapter`);
    }
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }

    const next = new Map<string, SpeakerRecord>();
    for (const member of members) {
      if (!member?.person_id) {
        throw new Error('Member person_id is required');
      }
      if (!member.phone_e164) {
        throw new Error(`Member ${member.person_id} has missing phone_e164`);
      }
      if (!this.isValidE164(member.phone_e164)) {
        throw new Error(`Member ${member.person_id} has invalid phone_e164: ${member.phone_e164}`);
      }
      const clean = {
        ...member,
        phone_e164: member.phone_e164.trim(),
        farm_ids: Array.isArray(member.farm_ids) ? member.farm_ids.filter(Boolean) : [],
      };
      next.set(clean.phone_e164, clean);
    }

    this.speakersMap.set(projectId, next);
    return Array.from(next.values());
  }

  async pullProjects(tenantId: string): Promise<Project[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    return Array.from(this.projectsMap.values());
  }

  async pullResourceScopes(tenantId: string, projectId: string): Promise<ResourceScope[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    return this.resourceScopesMap.get(projectId) || [];
  }

  async pullSpeakers(tenantId: string, projectId: string): Promise<SpeakerRecord[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    const pMap = this.speakersMap.get(projectId);
    return pMap ? Array.from(pMap.values()) : [];
  }

  async pullCandidateNumbers(tenantId: string): Promise<string[]> {
    if (tenantId !== this.tenantId) return [];
    return ['+19715885823', '+19715885824', '+19715885825'];
  }

  async resolveSpeaker(params: {
    tenantId: string;
    projectId: string;
    phoneE164: string;
  }): Promise<SpeakerIdentity> {
    const cleanPhone = (params.phoneE164 || '').trim();

    if (this.config.simulateDegraded) {
      Logger.warn(`vFarm Adapter degraded: live resolve failed for ${cleanPhone}`);
      throw new Error('vFarm Adapter API unavailable');
    }

    if (!cleanPhone || !this.isValidE164(cleanPhone)) {
      const safeRef = `opaque_invalid_${(cleanPhone || 'unknown').replace(/[^0-9]/g, '')}`;
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

    const pMap = this.speakersMap.get(params.projectId);
    const speaker = pMap?.get(cleanPhone);

    if (speaker) {
      const role: UserRole = speaker.role || 'manager';
      const permissions = getPermissionsForRole(role);
      const customerRef = `cust_${speaker.person_id}`;

      return {
        person_id: speaker.person_id,
        customer_ref: customerRef,
        tenant_id: params.tenantId,
        project_id: params.projectId,
        phone_e164: cleanPhone,
        is_known: true,
        role,
        permissions,
        farm_ids: [...speaker.farm_ids],
        unit_context: {
          farm_id: speaker.farm_ids[0],
          unit_id: 'unit_bay_04',
          role,
        },
      };
    }

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

  /**
   * Resolve cabinet config via the authoritative vFarm authorization chain:
   *
   *   Speaker identity
   *     → speaker.farm_ids (local CST binding)
   *     → GET /api/v1/inventory/{serial_number} → authoritative inventory.farm_id
   *     → verify inventory.farm_id ∈ speaker.farm_ids
   *     → GET /api/v1/inventory/{serial_number}/config → current.config_hash
   *     → GET /api/v1/configs/{config_hash}
   *     → return transient CabinetConfig (never persisted)
   *
   * When no live client is configured, falls back to in-memory cabinetConfigMap.
   *
   * NEVER authorized by: client-supplied farmId, org_id alone, serial alone, config_hash alone.
   */
  async resolveCabinetConfig(params: {
    tenantId: string;
    projectId: string;
    farmId: string;
    serial: string;
    speaker: SpeakerIdentity;
  }): Promise<CabinetConfig | null> {
    if (this.config.simulateDegraded) {
      throw new Error('LM7W cabinet config unavailable (degraded state)');
    }

    if (!params?.serial || !params?.farmId) {
      return null;
    }

    // Speaker must be a known, identified member
    if (!params.speaker?.is_known) {
      return null;
    }

    // ── Live vFarm path ──────────────────────────────────────────────────────
    if (this.liveClient) {
      return this._resolveCabinetLive(params);
    }

    // ── Local / in-memory path (dev & test) ──────────────────────────────────
    // Speaker must be authorized for the requested farm
    if (!params.speaker.farm_ids?.includes(params.farmId)) {
      return null;
    }

    const key = `${params.tenantId}:${params.projectId}:${params.farmId}:${params.serial}`;
    const config = this.cabinetConfigMap.get(key);
    if (!config) {
      return null;
    }

    return {
      ...config,
      farm_id: params.farmId,
      serial: params.serial,
      source: 'lm7w',
    };
  }

  /**
   * Live cabinet resolution via vFarm API.
   * Uses authoritative inventory.farm_id for authorization (never client-supplied farmId).
   * All returned data is transient — callers must not persist it.
   */
  private async _resolveCabinetLive(params: {
    tenantId: string;
    projectId: string;
    farmId: string;  // client-supplied hint (not used for authorization)
    serial: string;
    speaker: SpeakerIdentity;
  }): Promise<CabinetConfig | null> {
    const { serial, speaker } = params;

    // Step 1: Get authoritative inventory record
    let inventory;
    try {
      inventory = await this.liveClient!.getInventory(serial);
    } catch (err) {
      if (err instanceof VfarmHttpError && err.status === 404) {
        Logger.warn(`vFarm: inventory not found for serial=${serial}`);
        return null;
      }
      if (err instanceof VfarmHttpError && (err.status === 401 || err.status === 403)) {
        Logger.warn(`vFarm: auth error (${err.status}) fetching inventory for serial=${serial}`);
        return null;
      }
      // Network / 5xx: fail closed
      Logger.warn(`vFarm: inventory lookup failed for serial=${serial}: ${(err as Error).message}`);
      return null;
    }

    // Step 2: Verify authoritative farm_id ∈ speaker.farm_ids
    const authoritativeFarmId = inventory.farm_id;
    if (!authoritativeFarmId) {
      Logger.warn(`vFarm: serial=${serial} has no farm_id (unallocated) — denying access`);
      return null;
    }
    if (!speaker.farm_ids.includes(authoritativeFarmId)) {
      Logger.warn(`vFarm: serial=${serial} farm=${authoritativeFarmId} not in speaker.farm_ids=[${speaker.farm_ids.join(',')}] — denying access`);
      return null;
    }

    // Step 3: Get current unit config
    let unitConfig;
    try {
      unitConfig = await this.liveClient!.getUnitConfig(serial);
    } catch (err) {
      if (err instanceof VfarmHttpError && err.status === 404) {
        Logger.warn(`vFarm: unit config not found for serial=${serial}`);
        return null;
      }
      if (err instanceof VfarmHttpError && (err.status === 401 || err.status === 403)) {
        Logger.warn(`vFarm: auth error (${err.status}) fetching unit config for serial=${serial}`);
        return null;
      }
      Logger.warn(`vFarm: unit config lookup failed for serial=${serial}: ${(err as Error).message}`);
      return null;
    }

    const configHash = unitConfig.current?.config_hash;
    if (!configHash) {
      Logger.warn(`vFarm: no current config_hash for serial=${serial}`);
      return null;
    }

    // Step 4: Get full config detail
    let configDetail: ConfigResponse;
    try {
      configDetail = await this.liveClient!.getConfig(configHash);
    } catch (err) {
      if (err instanceof VfarmHttpError && err.status === 404) {
        Logger.warn(`vFarm: config detail not found for config_hash=${configHash}`);
        return null;
      }
      if (err instanceof VfarmHttpError && (err.status === 401 || err.status === 403)) {
        Logger.warn(`vFarm: auth error (${err.status}) fetching config hash=${configHash}`);
        return null;
      }
      Logger.warn(`vFarm: config detail lookup failed for hash=${configHash}: ${(err as Error).message}`);
      return null;
    }

    // Return transient config — NEVER persist this in CST
    return {
      serial,
      farm_id: authoritativeFarmId,
      config_hash: configDetail.config_hash,
      cad_revision: configDetail.cad_revision ?? '',
      status: 'ok',
      source: 'lm7w',
      updated_at: unitConfig.current.effective_at,
      summary: `${configDetail.name} v${configDetail.spec_version} (${configDetail.parts.length} parts)`,
    };
  }

  async getHealth(tenantId: string): Promise<{
    status: 'healthy' | 'degraded' | 'down';
    latency_ms?: number;
    details?: Record<string, unknown>;
  }> {
    if (this.config.simulateDegraded) {
      return { status: 'degraded', latency_ms: 1200, details: { error: 'Simulated API latency / degradation' } };
    }
    return {
      status: 'healthy',
      latency_ms: 15,
      details: {
        projects_count: this.projectsMap.size,
        tenant_id: tenantId,
        live_mode: this.liveClient !== null,
      },
    };
  }
}
