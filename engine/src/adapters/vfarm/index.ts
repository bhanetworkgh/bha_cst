import { ITenantAdapter } from '../types.js';
import { Project, ResourceScope, SpeakerRecord, SpeakerIdentity, UserRole, CabinetConfig } from '../../core/types.js';
import { Logger } from '../../config/logger.js';
import { VfarmHttpClient, VfarmApiError } from './http_client.js';
import { VfarmLiveClient } from './live_client.js';
import { assertSpeakerFarmAccess, VfarmAuthorizationError } from './authorization.js';
import { CONFIG_HASH_RE, type FarmResponse } from './schemas.js';

export { VfarmAuthorizationError, assertSpeakerFarmAccess } from './authorization.js';

export interface VfarmAdapterConfig {
  /** vFarm REST base URL (e.g. https://bhavfarm1.duckdns.org). When absent, the
   * adapter runs in local mode: tenancy/speaker data comes only from the
   * admin-managed directory (registerSpeaker/syncMembers/registerCabinetConfig)
   * with no live upstream calls — this is the pre-existing dev/test behavior. */
  baseUrl?: string;
  apiKey?: string;
  apiToken?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  simulateDegraded?: boolean;
}

/** Maps a vFarm organization-member `role` string onto CST's role model.
 * Only mappings that were explicitly agreed are applied; anything else keeps
 * whatever role CST's local admin-managed directory already recorded for that
 * speaker rather than guessing at an upstream role's meaning. */
function mapVfarmOrgRoleToCstRole(vfarmRole: string): Exclude<UserRole, 'unknown'> | null {
  const normalized = (vfarmRole || '').trim().toLowerCase();
  switch (normalized) {
    case 'owner':
    case 'admin':
      return 'owner';
    case 'manager':
      return 'manager';
    case 'tech':
    case 'technician':
    case 'member':
      return 'tech';
    default:
      return null;
  }
}

export class VfarmTenantAdapter implements ITenantAdapter {
  readonly tenantId: string;
  private config: VfarmAdapterConfig;
  private httpClient: VfarmHttpClient | null;
  private liveClient: VfarmLiveClient | null = null;
  private activeFarmId: string | null = null;
  private adminJwt: string | null = null;
  private discoveredFarms: FarmResponse[] = [];

  // In-memory tenancy projection & CST-owned admin-managed speaker/cabinet
  // directory. This is NOT a mock of the vFarm API — it is the same
  // admin-managed layer the platform has always used to bind a phone number
  // to a known account (vFarm exposes no phone field to automate this; see
  // docs handoff §6). When a real baseUrl/apiKey is configured, entries here
  // are cross-checked/refreshed against the live vFarm API rather than
  // trusted blindly.
  private projectsMap: Map<string, Project> = new Map();
  private resourceScopesMap: Map<string, ResourceScope[]> = new Map(); // projectId -> farms[]
  private speakersMap: Map<string, Map<string, SpeakerRecord>> = new Map(); // projectId -> (phone -> SpeakerRecord)
  private cabinetConfigMap: Map<string, CabinetConfig> = new Map();

  constructor(tenantId = 'tenant-vfarm-01', config: VfarmAdapterConfig = {}) {
    this.tenantId = tenantId;
    this.config = config;
    this.httpClient = this.buildHttpClient(config);
    this.liveClient = this.buildLiveClient(config);
    this.activeFarmId = process.env.VFARM_FARM_ID || null;
    this.adminJwt = config.apiToken || process.env.VFARM_API_JWT || process.env.VFARM_JWT || null;
    this.initDefaultData();
  }

  private buildHttpClient(config: VfarmAdapterConfig): VfarmHttpClient | null {
    if (!config.baseUrl) return null;
    return new VfarmHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      apiToken: config.apiToken,
      timeoutMs: config.timeoutMs,
      fetchFn: config.fetchFn,
    });
  }

  private buildLiveClient(config: VfarmAdapterConfig): VfarmLiveClient | null {
    if (!config.baseUrl) return null;
    return new VfarmLiveClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      fetchFn: config.fetchFn as any,
    });
  }

  /** True when the adapter is wired to the real vFarm REST API. */
  public isLiveMode(): boolean {
    return this.httpClient !== null || this.liveClient !== null;
  }

  public getLiveClient(): VfarmLiveClient | null {
    return this.liveClient;
  }

  public hasLiveClient(): boolean {
    return this.liveClient !== null;
  }

  public getActiveFarmId(): string | null {
    const first = this.discoveredFarms[0];
    const firstId = first ? ((first as any).farm_id || first.id) : null;
    return this.activeFarmId || process.env.VFARM_FARM_ID || firstId || null;
  }

  public getDiscoveredFarmIds(): string[] {
    return this.discoveredFarms.map((f: any) => String(f.farm_id || f.id || ''));
  }

  public getAdminJwt(): string | null {
    return this.adminJwt || process.env.VFARM_API_JWT || process.env.VFARM_JWT || null;
  }

  public async authenticateAdmin(email: string, password: string): Promise<string> {
    if (!this.liveClient) {
      throw new Error('vFarm live client not configured');
    }
    const res = await this.liveClient.login(email, password);
    this.adminJwt = res.token;
    return res.token;
  }

  public async discoverFarms(jwt?: string): Promise<FarmResponse[]> {
    const token = jwt || this.getAdminJwt() || undefined;
    if (this.liveClient) {
      const list = await this.liveClient.listFarms(token);
      this.discoveredFarms = list.farms || [];
      if (!this.activeFarmId && this.discoveredFarms.length > 0) {
        const first = this.discoveredFarms[0];
        this.activeFarmId = (first as any).farm_id || first.id || null;
      }
      return this.discoveredFarms;
    }
    return [];
  }

  public async issueFarmToken(farmId: string, jwt?: string, name?: string): Promise<string> {
    if (!this.liveClient) {
      throw new Error('vFarm live client not configured');
    }
    const token = jwt || this.getAdminJwt();
    if (!token) {
      throw new Error('JWT token is required to issue farm token');
    }
    const res = await this.liveClient.issueFarmToken({ farmId, name }, token);
    const rawKey = res.raw_key || '';
    if (rawKey) {
      this.config.apiKey = rawKey;
      this.liveClient = this.buildLiveClient(this.config);
      this.httpClient = this.buildHttpClient(this.config);
    }
    return rawKey;
  }

  public async switchActiveFarm(farmId: string): Promise<{ farmId: string }> {
    this.activeFarmId = farmId;
    return { farmId };
  }

  public async getDashboardData(farmId?: string): Promise<any> {
    const targetFarmId = farmId || this.getActiveFarmId();
    if (!this.liveClient) {
      return {
        farm_id: targetFarmId || 'local-mock',
        farm: null,
        device_count: 0,
        devices: [],
        health: { status: 'local', health_score: null },
        mode: 'local',
      };
    }

    // Fetch farm info, devices, and health in parallel for a composite view.
    // We never pass errors up raw — instead we degrade gracefully so the UI
    // can still render whatever data is available.
    const farmListPromise = this.liveClient.listFarms(this.getAdminJwt() || undefined)
      .catch(() => ({ farms: [] as import('./schemas.js').FarmResponse[], total: 0 }));

    const devicesPromise = targetFarmId
      ? this.liveClient.listAllDevices(targetFarmId).catch(() => ({ devices: [], total: 0 }))
      : Promise.resolve({ devices: [], total: 0 });

    const healthPromise = targetFarmId
      ? this.liveClient.getFarmHealth(targetFarmId).catch(() => ({ status: 'unknown', health_score: null }))
      : Promise.resolve({ status: 'unknown', health_score: null });

    const [farmList, devicesRes, healthRes] = await Promise.all([
      farmListPromise,
      devicesPromise,
      healthPromise,
    ]);

    // Find the specific farm object from the discovered list
    const farm = targetFarmId
      ? farmList.farms.find((f: any) => (f.farm_id || f.id) === targetFarmId) ?? null
      : (farmList.farms[0] ?? null);

    const devices: any[] = (devicesRes as any).devices ?? [];
    const deviceCount: number = (devicesRes as any).total ?? devices.length;

    return {
      farm_id: targetFarmId ?? (farm ? ((farm as any).farm_id || (farm as any).id) : null),
      farm,
      device_count: deviceCount,
      devices,
      health: healthRes,
    };
  }

  public async listFarmDevices(params: { farmId: string; speaker?: SpeakerIdentity }): Promise<{ total: number; devices: any[] }> {
    if (params.speaker) {
      assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    }
    if (!this.liveClient) {
      return { total: 0, devices: [] };
    }
    const res = await this.liveClient.listAllDevices(params.farmId);
    return {
      total: res.total ?? res.devices?.length ?? 0,
      devices: res.devices ?? [],
    };
  }

  public async getLatestDeviceReading(params: { farmId: string; deviceId: string; speaker?: SpeakerIdentity }): Promise<any> {
    if (params.speaker) {
      assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    }
    if (!this.liveClient) {
      return {
        sensor_id: params.deviceId,
        reading_ts: new Date().toISOString(),
        temperature_c: 22.5,
        humidity_rh: 65,
      };
    }
    return await this.liveClient.getLatestReading(params.deviceId);
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

    // Speakers for Project 1 (Austin) — admin-managed phone directory (dev/demo defaults).
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
    // NOTE: the verified vFarm OpenAPI contract exposes no "list organizations"
    // endpoint, so CST projects (which map 1:1 to vFarm orgs via
    // `tenant_org_id`) remain CST/admin-configured rather than pulled live.
    return Array.from(this.projectsMap.values());
  }

  async pullResourceScopes(tenantId: string, projectId: string): Promise<ResourceScope[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    // NOTE: no verified "list farms for an org" endpoint exists upstream, so
    // farm resource scopes remain CST/admin-configured. Farm *authorization*
    // for a specific cabinet is still checked live against the authoritative
    // vFarm inventory record — see resolveCabinetConfig.
    return this.resourceScopesMap.get(projectId) || [];
  }

  /**
   * Pull the project's admin-managed speaker directory. In live mode, entries
   * are cross-checked against the verified vFarm organization-members
   * endpoint: a locally-registered speaker whose `person_id` (vFarm user_id)
   * no longer appears there is dropped (revoked upstream). Role/farm_ids are
   * refreshed from vFarm where a mapping is available; otherwise the local
   * admin-recorded value is kept as-is (never fabricated).
   */
  async pullSpeakers(tenantId: string, projectId: string): Promise<SpeakerRecord[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    const pMap = this.speakersMap.get(projectId);
    const localSpeakers = pMap ? Array.from(pMap.values()) : [];

    if (!this.httpClient || localSpeakers.length === 0) {
      return localSpeakers;
    }

    const project = this.projectsMap.get(projectId);
    const orgId = project?.tenant_org_id;
    if (!orgId) {
      Logger.warn(`vFarm pullSpeakers: project ${projectId} has no tenant_org_id configured; skipping live cross-check`);
      return localSpeakers;
    }

    let orgMembers;
    try {
      orgMembers = await this.httpClient.listOrganizationMembers(orgId);
    } catch (err: any) {
      Logger.warn(`vFarm pullSpeakers: live org-members check failed for org ${orgId}, returning last-known local directory: ${err?.message}`);
      return localSpeakers;
    }

    const byUserId = new Map(orgMembers.map((m) => [m.user_id, m]));
    const result: SpeakerRecord[] = [];
    for (const speaker of localSpeakers) {
      const upstream = byUserId.get(speaker.person_id);
      if (!upstream) {
        // No longer a member of the vFarm org — revoked upstream.
        continue;
      }
      const mappedRole = mapVfarmOrgRoleToCstRole(upstream.role);
      let farmIds = speaker.farm_ids;
      try {
        const grants = await this.httpClient.getUserFarmGrants(speaker.person_id);
        const grantedFarmIds = grants.map((g) => g.farm_id).filter(Boolean);
        if (grantedFarmIds.length > 0) {
          farmIds = grantedFarmIds;
        }
      } catch (err: any) {
        Logger.warn(`vFarm pullSpeakers: farm-grants check unavailable for ${speaker.person_id}, keeping locally-recorded farm scope: ${err?.message}`);
      }
      result.push({
        ...speaker,
        role: mappedRole || speaker.role,
        farm_ids: farmIds,
        name: upstream.name || speaker.name,
      });
    }
    return result;
  }

  async pullCandidateNumbers(tenantId: string): Promise<string[]> {
    if (tenantId !== this.tenantId) return [];
    return ['+19715885823', '+19715885824', '+19715885825'];
  }

  private unknownIdentity(params: { tenantId: string; projectId: string; phone: string }, prefix: string): SpeakerIdentity {
    const safeRef = `${prefix}_${(params.phone || 'unknown').replace(/[^0-9]/g, '')}`;
    return {
      person_id: safeRef,
      customer_ref: safeRef,
      tenant_id: params.tenantId,
      project_id: params.projectId,
      phone_e164: params.phone,
      is_known: false,
      role: 'unknown',
      permissions: [],
      farm_ids: [],
    };
  }

  /**
   * Resolve (tenant_id, project_id, phone_e164) to a speaker identity.
   *
   * The verified vFarm organization-members endpoint exposes no phone field
   * (docs handoff §6), so there is no way to automatically map an arbitrary
   * inbound phone number to a vFarm identity. CST's admin-managed directory
   * (registerSpeaker/syncMembers) remains the authoritative phone→person_id
   * binding, exactly as before this integration. What changes in live mode:
   * a locally-known speaker is re-verified against the live vFarm API before
   * being trusted, so a revocation upstream (or an upstream outage) is
   * reflected immediately as fail-closed rather than trusting a stale local
   * record indefinitely.
   */
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
      return this.unknownIdentity({ tenantId: params.tenantId, projectId: params.projectId, phone: cleanPhone }, 'opaque_invalid');
    }

    const pMap = this.speakersMap.get(params.projectId);
    const speaker = pMap?.get(cleanPhone);

    if (!speaker) {
      return this.unknownIdentity({ tenantId: params.tenantId, projectId: params.projectId, phone: cleanPhone }, 'opaque_unresolved');
    }

    let role: UserRole = speaker.role || 'manager';
    let farmIds = [...speaker.farm_ids];

    // Live mode: re-verify the locally-registered speaker against the
    // authoritative vFarm organization-members list before trusting it.
    if (this.httpClient) {
      const project = this.projectsMap.get(params.projectId);
      const orgId = project?.tenant_org_id;
      if (orgId) {
        // Any thrown VfarmApiError (auth/timeout/network/upstream/invalid
        // response) propagates to CoreRegistry, which fails closed — see
        // docs handoff §16 "Upstream authentication failure" / "timeout".
        const members = await this.httpClient.listOrganizationMembers(orgId);
        const upstream = members.find((m) => m.user_id === speaker.person_id);
        if (!upstream) {
          // Removed/revoked upstream — fail closed even though a local
          // record still exists.
          return this.unknownIdentity({ tenantId: params.tenantId, projectId: params.projectId, phone: cleanPhone }, 'opaque_revoked');
        }
        const mappedRole = mapVfarmOrgRoleToCstRole(upstream.role);
        if (mappedRole) role = mappedRole;

        try {
          const grants = await this.httpClient.getUserFarmGrants(speaker.person_id);
          const grantedFarmIds = grants.map((g) => g.farm_id).filter(Boolean);
          if (grantedFarmIds.length > 0) farmIds = grantedFarmIds;
        } catch (err: any) {
          // Farm-grants endpoint schema/availability is best-effort (docs
          // handoff §8) — keep the last known-good farm scope rather than
          // failing the whole resolution over this one unverified endpoint.
          Logger.warn(`vFarm resolveSpeaker: farm-grants check unavailable for ${speaker.person_id}: ${err?.message}`);
        }
      }
    }

    // Dynamic import (rather than a static top-level one) deliberately avoids
    // a module-load-time circular dependency: identity/resolver.js pulls in
    // db/client.js, which pulls in core/registry.js, which itself imports
    // this file. A static import here only ever caused problems for callers
    // that import this adapter module directly (e.g. unit tests) before
    // core/registry.js has been loaded; resolving it lazily, at call time,
    // sidesteps that without changing behavior.
    const { getPermissionsForRole } = await import('../../identity/resolver.js');
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
      farm_ids: farmIds,
      unit_context: {
        farm_id: farmIds[0],
        unit_id: 'unit_bay_04',
        role,
      },
    };
  }

  /**
   * Cabinet/LM7W authorization + configuration retrieval flow (docs handoff §12).
   *
   * Security ordering is mandatory: the caller-supplied `farmId` is NEVER
   * trusted for authorization. The authoritative farm association is read
   * from vFarm's inventory record for the serial number, and the speaker's
   * farm scope must contain THAT farm before any configuration is fetched or
   * returned. Nothing here is persisted by CST (transient only).
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

    if (!params?.serial || !params?.speaker?.is_known) {
      return null;
    }

    if (this.httpClient) {
      return this.resolveCabinetConfigLive(params);
    }

    // Local/dev mode: existing pre-registered fixture lookup, gated on the
    // caller-supplied farmId being in the speaker's authorized scope (this
    // was the pre-integration behavior, kept for local/dev/test use).
    if (!params.farmId || !params.speaker.farm_ids?.includes(params.farmId)) {
      return null;
    }
    const key = `${params.farmId}:${params.serial}`;
    const config = this.cabinetConfigMap.get(key);
    if (!config) return null;
    return { ...config, farm_id: params.farmId, serial: params.serial, source: 'lm7w' };
  }

  private async resolveCabinetConfigLive(params: {
    tenantId: string;
    projectId: string;
    farmId: string;
    serial: string;
    speaker: SpeakerIdentity;
  }): Promise<CabinetConfig | null> {
    const client = this.httpClient!;

    let inventory;
    try {
      inventory = await client.getInventoryItem(params.serial);
    } catch (err: any) {
      if (err instanceof VfarmApiError && err.category === 'not_found') {
        return null;
      }
      throw err;
    }

    // farm_id is load-bearing (docs handoff §9): missing/null/empty fails closed.
    const authoritativeFarmId = (inventory.farm_id || '').trim();
    if (!authoritativeFarmId) {
      Logger.warn(`vFarm cabinet lookup: inventory ${params.serial} has no authoritative farm_id — fail closed`);
      return null;
    }

    // Never allow a client-supplied farm ID to bypass authorization: the
    // authoritative farm_id from inventory must itself be in the speaker's
    // granted scope, regardless of what farmId the caller asked for.
    if (!params.speaker.farm_ids?.includes(authoritativeFarmId)) {
      Logger.warn(`vFarm cabinet lookup: speaker not authorized for authoritative farm ${authoritativeFarmId} (serial=${params.serial})`);
      return null;
    }

    let unitConfig;
    try {
      unitConfig = await client.getUnitConfig(params.serial);
    } catch (err: any) {
      if (err instanceof VfarmApiError && err.category === 'not_found') {
        return null;
      }
      throw err;
    }

    const configHash = unitConfig.current.config_hash;
    if (!CONFIG_HASH_RE.test(configHash)) {
      Logger.warn(`vFarm cabinet lookup: invalid config_hash format for serial ${params.serial}`);
      return null;
    }

    let configDetail;
    try {
      configDetail = await client.getConfig(configHash);
    } catch (err: any) {
      if (err instanceof VfarmApiError && err.category === 'not_found') {
        return null;
      }
      throw err;
    }

    return {
      serial: params.serial,
      farm_id: authoritativeFarmId,
      config_hash: configDetail.config_hash,
      cad_revision: configDetail.cad_revision || '',
      status: 'ok',
      source: 'lm7w',
      updated_at: unitConfig.current.effective_at,
      summary: `${configDetail.name} (${configDetail.spec_version})`,
    };
  }

  async getHealth(tenantId: string): Promise<{
    status: 'healthy' | 'degraded' | 'down';
    latency_ms?: number;
    details?: Record<string, unknown>;
  }> {
    if (this.config.simulateDegraded) {
      return { status: 'degraded', latency_ms: 1200, details: { error: 'Simulated API latency / degradation', mode: this.isLiveMode() ? 'live' : 'local' } };
    }
    return {
      status: 'healthy',
      latency_ms: 15,
      details: {
        projects_count: this.projectsMap.size,
        tenant_id: tenantId,
        mode: this.isLiveMode() ? 'live' : 'local',
      },
    };
  }
}
