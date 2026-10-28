import { ITenantAdapter } from '../types.js';
import { Project, ResourceScope, SpeakerRecord, SpeakerIdentity, UserRole, CabinetConfig } from '../../core/types.js';
import { Logger } from '../../config/logger.js';
import { VfarmHttpClient, VfarmApiError } from './http_client.js';
import { VfarmLiveClient } from './live_client.js';
import { assertSpeakerFarmAccess, VfarmAuthorizationError } from './authorization.js';
import { CONFIG_HASH_RE, type FarmResponse, type OrgResponse } from './schemas.js';

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
    // Resolve the admin JWT BEFORE building either client: both need it (the
    // org-members endpoint rejects X-Farm-Key auth), and reading it after the
    // clients were constructed would hand them an undefined token.
    this.adminJwt = config.apiToken || process.env.VFARM_API_JWT || process.env.VFARM_JWT || null;
    this.httpClient = this.buildHttpClient(config);
    this.liveClient = this.buildLiveClient(config);
    this.activeFarmId = process.env.VFARM_FARM_ID || null;
    this.initDefaultData();
  }

  private buildHttpClient(config: VfarmAdapterConfig): VfarmHttpClient | null {
    if (!config.baseUrl) return null;
    return new VfarmHttpClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      apiToken: this.adminJwt || config.apiToken,
      timeoutMs: config.timeoutMs,
      fetchFn: config.fetchFn,
    });
  }

  private buildLiveClient(config: VfarmAdapterConfig): VfarmLiveClient | null {
    if (!config.baseUrl) return null;
    return new VfarmLiveClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      // The org-members endpoint rejects X-Farm-Key auth, so the admin JWT has
      // to reach the live client too — not just the http client.
      apiToken: this.adminJwt || undefined,
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

  /**
   * The bearer token to use for the next upstream call, WITHOUT acquiring one.
   *
   * Synchronous by design so callers that only inspect state keep working. Code
   * that is about to make a live request must call `ensureAdminToken()` first —
   * that is the method that prefers a freshly acquired credential over the
   * static env token.
   */
  public getAdminJwt(): string | null {
    return this.adminJwt || process.env.VFARM_API_JWT || process.env.VFARM_JWT || null;
  }

  /**
   * True when the adapter can obtain a token on its own, i.e. it does not have
   * to rely on an operator pasting a long-lived JWT into the environment.
   *
   * vFarm exposes `POST /api/v1/auth/login` but NO refresh endpoint, so
   * "acquire on its own" necessarily means "log in with credentials again".
   */
  public static hasAdminCredentials(): boolean {
    return Boolean(process.env.VFARM_ADMIN_EMAIL && process.env.VFARM_ADMIN_PASSWORD);
  }

  /**
   * Return a usable admin token, acquiring or refreshing it when needed.
   *
   * Precedence:
   *   1. A cached token that is not expired.
   *   2. `POST /api/v1/auth/login` with VFARM_ADMIN_EMAIL / VFARM_ADMIN_PASSWORD.
   *   3. The static `VFARM_API_JWT` / `VFARM_JWT`, only as a last resort.
   *
   * Step 2 is what removes the operational dependency on a hand-maintained
   * 7-day JWT: the adapter re-authenticates itself instead of requiring someone
   * to paste a new token into `.env` every week. Step 3 is kept so an
   * environment with no admin credentials at all still works, and so the
   * upstream's own 401 remains the authority when a token really is rejected.
   *
   * Never throws: on failure it falls back and lets the upstream decide.
   */
  public async ensureAdminToken(): Promise<string | null> {
    const current = this.getAdminJwt();

    // Already usable.
    if (current && !VfarmTenantAdapter.jwtIsExpired(current)) {
      return current;
    }

    if (current) {
      Logger.warn('VfarmTenantAdapter: stored admin JWT is expired — re-authenticating');
    }

    // Credentials beat a static token, including a non-expired one, only when we
    // actually have to re-authenticate; a valid token is not worth re-logging for.
    const fresh = await this.tryRelogin();
    if (fresh) return fresh;

    return current;
  }

  public async authenticateAdmin(email: string, password: string): Promise<string> {
    if (!this.liveClient) {
      throw new Error('vFarm live client not configured');
    }
    const res = await this.liveClient.login(email, password);
    this.adminJwt = res.token;
    // Keep the live client's bearer token in step with the refreshed JWT.
    this.liveClient.setApiToken(res.token);
    return res.token;
  }

  /**
   * Returns true when a JWT string is already expired (clock-based check).
   * Does NOT validate the signature — that is the upstream server's job.
   * Returns false for any non-JWT / unparseable value so callers can still
   * attempt the request and let the server decide.
   */
  private static jwtIsExpired(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (typeof payload.exp !== 'number') return false;
      // Add a 30-second clock-skew buffer so we refresh slightly before expiry.
      return Date.now() / 1000 >= payload.exp - 30;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to re-authenticate using VFARM_ADMIN_EMAIL / VFARM_ADMIN_PASSWORD
   * from the environment. Returns the new token on success, null on failure or
   * when credentials are not configured.
   */
  private async tryRelogin(): Promise<string | null> {
    const email = process.env.VFARM_ADMIN_EMAIL;
    const password = process.env.VFARM_ADMIN_PASSWORD;
    if (!email || !password || !this.liveClient) return null;
    try {
      const res = await this.liveClient.login(email, password);
      if (res.token) {
        this.adminJwt = res.token;
        this.liveClient.setApiToken(res.token);
        Logger.info('VfarmTenantAdapter: JWT refreshed via auto-relogin');
        return res.token;
      }
    } catch (err: any) {
      Logger.warn(`VfarmTenantAdapter: auto-relogin failed — ${err.message}`);
    }
    return null;
  }

  public async discoverFarms(jwt?: string): Promise<FarmResponse[]> {
    if (!this.liveClient) return [];

    // A caller-supplied JWT is that caller's own credential and nothing else.
    // It is used verbatim: never re-authenticated with VFARM_ADMIN_* and never
    // replaced by a CST-owned token, so an expired caller JWT surfaces as an
    // upstream 401/403 instead of silently escalating to CST's farm scope.
    if (jwt) {
      const list = await this.liveClient.listFarms(jwt);
      this.recordDiscoveredFarms(list.farms || []);
      return this.discoveredFarms;
    }

    // CST-owned credential path (Admin Panel / no caller JWT): resolve a token,
    // acquiring a fresh one when the stored token is expired.
    let token = (await this.ensureAdminToken()) || undefined;
    if (token && VfarmTenantAdapter.jwtIsExpired(token)) {
      Logger.warn('VfarmTenantAdapter: stored JWT is expired — attempting auto-relogin before farm discovery');
      const fresh = await this.tryRelogin();
      token = fresh || token; // fall back to expired token so the upstream can still give us a clear 401
    }

    let list;
    try {
      list = await this.liveClient.listFarms(token);
    } catch (err: any) {
      // On an upstream 401, try re-logging-in once and retry.
      const status = (err as any)?.status ?? (err as any)?.statusCode;
      if (status === 401 || status === 403) {
        Logger.warn(`VfarmTenantAdapter: listFarms got ${status} — attempting one-shot re-auth`);
        const fresh = await this.tryRelogin();
        if (fresh) {
          list = await this.liveClient.listFarms(fresh);
        } else {
          throw err; // no credentials — propagate original error
        }
      } else {
        throw err;
      }
    }

    this.recordDiscoveredFarms(list.farms || []);
    return this.discoveredFarms;
  }

  /** Update the discovered-farm projection. Never called with a caller's
   * partial view in place of CST's own — discovery results are cached so
   * farm-scope checks have something to compare against. */
  private recordDiscoveredFarms(farms: FarmResponse[]): void {
    this.discoveredFarms = farms;
    if (!this.activeFarmId && this.discoveredFarms.length > 0) {
      const first = this.discoveredFarms[0];
      this.activeFarmId = (first as any).farm_id || first.id || null;
    }
  }

  public async issueFarmToken(farmId: string, jwt?: string, name?: string): Promise<string> {
    if (!this.liveClient) {
      throw new Error('vFarm live client not configured');
    }
    const token = jwt || (await this.ensureAdminToken());
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
    const adminToken = await this.ensureAdminToken();
    const farmListPromise = this.liveClient.listFarms(adminToken || undefined)
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
    // tenant_org_id must be the real vFarm organization UUID, not a CST
    // placeholder. vFarm answers HTTP 422 for placeholder ids, so a placeholder
    // here silently disables the live membership cross-check in pullSpeakers()
    // and resolveSpeaker() (G19). Discovered from GET /api/v1/organizations.
    const vfarmOrgId = process.env.VFARM_TENANT_ORG_ID || '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';

    // Project 1: Main vFarm Org (Austin)
    const proj1: Project = {
      project_id: 'proj-vfarm-main',
      tenant_id: this.tenantId,
      name: 'vFarm Austin HQ',
      status: 'active',
      tenant_org_id: vfarmOrgId,
      capabilities: { sms: true, voice: true },
      speaker_policy: 'allowlist',
      onboarding_reply: process.env.VFARM_ONBOARDING_REPLY,
    };

    // Project 2: Secondary vFarm Org (Dallas)
    const proj2: Project = {
      project_id: 'proj-vfarm-dallas',
      tenant_id: this.tenantId,
      name: 'vFarm Dallas Operations',
      status: 'active',
      tenant_org_id: vfarmOrgId,
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

  /**
   * Stable CST project id for a vFarm organization.
   * `projects.tenant_org_id` holds the REAL vFarm organization UUID (vFarm org
   * ids are UUIDs and it answers 422 for CST placeholders), so a project must
   * keep pointing at the same CST id across syncs. We therefore key on the
   * organization id itself, and reuse the existing CST project_id when one is
   * already mapped to that org so renames upstream never orphan the project.
   */
  private projectIdForOrg(orgId: string, orgName: string): string {
    for (const proj of this.projectsMap.values()) {
      if (proj.tenant_org_id === orgId) return proj.project_id;
    }
    const slug = (orgName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    return `proj-vfarm-${slug || 'org'}`;
  }

  /**
   * Real vFarm organization -> CST project synchronization.
   *
   * Uses only endpoints already present in the verified vFarm OpenAPI contract
   * (`GET /api/v1/organizations`, `VfarmLiveClient.listOrganizations`). No
   * endpoint is invented. In local mode (no baseUrl configured) there is nothing
   * to pull and the CST/admin-configured projects are returned unchanged.
   *
   * vFarm organizations are the authoritative tenancy boundary: `tenant_org_id`
   * is set from the real org UUID on every synced project, and the org's
   * name/is_active drive the CST project name/status.
   */
  async pullProjects(tenantId: string): Promise<Project[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];

    if (!this.liveClient) {
      // Local/dev mode: no upstream to sync from. CST/admin-configured projects
      // remain the projection (pre-existing behavior, no live calls).
      return Array.from(this.projectsMap.values());
    }

    let organizations: OrgResponse[];
    try {
      const list = await this.liveClient.listOrganizations((await this.ensureAdminToken()) || undefined);
      organizations = list.organizations || [];
    } catch (err: any) {
      // Fail closed: an org list we could not read must never be replaced with
      // an empty projection (that would drop every tenant_org_id mapping).
      Logger.warn(`vFarm pullProjects: organization sync unavailable for tenant ${tenantId}: ${err?.message}`);
      throw err;
    }

    const now = new Date().toISOString();
    const synced: Project[] = [];
    for (const org of organizations) {
      const orgId = (org.id || '').trim();
      if (!orgId) continue;

      const projectId = this.projectIdForOrg(orgId, org.name || org.slug || '');
      const existing = this.projectsMap.get(projectId);

      const project: Project = {
        ...(existing || {}),
        project_id: projectId,
        tenant_id: this.tenantId,
        // Authoritative vFarm organization id — never a CST placeholder.
        tenant_org_id: orgId,
        name: org.name || existing?.name || projectId,
        status: org.is_active === false ? 'suspended' : 'active',
        capabilities: existing?.capabilities ?? { sms: true, voice: true },
        speaker_policy: existing?.speaker_policy ?? 'allowlist',
        onboarding_reply: existing?.onboarding_reply,
        elevenlabs_voice_id: existing?.elevenlabs_voice_id,
        elevenlabs_model_id: existing?.elevenlabs_model_id,
        voice_enabled: existing?.voice_enabled,
        synced_at: now,
      };

      this.projectsMap.set(projectId, project);
      synced.push(project);
    }

    Logger.info(
      `vFarm pullProjects: synced ${synced.length} vFarm organization(s) -> CST projects for tenant ${tenantId}`
    );
    return synced;
  }

  /**
   * Real vFarm farm -> CST project resource-scope synchronization.
   *
   * Uses `GET /api/v1/farms?org_id={org_id}` (`VfarmLiveClient.listOrgFarms`) —
   * an endpoint already present in the verified contract. The project's
   * `tenant_org_id` supplies the authoritative organization filter; nothing is
   * inferred from CST-side project naming.
   *
   * Farm scopes are only replaced on a successful read. If the call fails the
   * previously-known scopes are kept (they remain advisory metadata) and the
   * caller is warned — farm *authorization* never relies on this projection,
   * it always comes from the live per-user grant lookup in resolveSpeaker().
   */
  async pullResourceScopes(tenantId: string, projectId: string): Promise<ResourceScope[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];

    const project = this.projectsMap.get(projectId);

    if (!this.liveClient || !project?.tenant_org_id) {
      return this.resourceScopesMap.get(projectId) || [];
    }

    let farms: FarmResponse[];
    try {
      const list = await this.liveClient.listOrgFarms(
        project.tenant_org_id,
        (await this.ensureAdminToken()) || undefined
      );
      farms = list.farms || [];
    } catch (err: any) {
      Logger.warn(
        `vFarm pullResourceScopes: farm sync unavailable for project ${projectId} (org ${project.tenant_org_id}): ${err?.message}`
      );
      return this.resourceScopesMap.get(projectId) || [];
    }

    const scopes: ResourceScope[] = farms
      .map((f) => ({
        id: (f.id || '').trim(),
        name: f.name || undefined,
        type: 'farm',
        metadata: {
          ...(f.code ? { code: f.code } : {}),
          ...(f.is_active !== undefined ? { is_active: f.is_active } : {}),
          org_id: project.tenant_org_id,
        },
      }))
      .filter((s) => s.id.length > 0);

    if (scopes.length > 0) {
      this.resourceScopesMap.set(projectId, scopes);
    }

    Logger.info(
      `vFarm pullResourceScopes: synced ${scopes.length} farm scope(s) for project ${projectId} (org ${project.tenant_org_id})`
    );
    return scopes;
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
        // Authoritative grant list wins outright, including when it is empty:
        // an empty list upstream means "no farms", which is different from "we
        // could not ask".
        farmIds = grants.map((g) => g.farm_id).filter(Boolean);
      } catch (err: any) {
        // Fail closed: the grant lookup is the authority on farm scope. When it
        // is unavailable we must NOT reuse the stale locally-recorded farm_ids
        // as authorization (they may have been revoked upstream).
        Logger.warn(`vFarm pullSpeakers: farm-grants check unavailable for ${speaker.person_id}, dropping farm scope (fail closed): ${err?.message}`);
        farmIds = [];
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
          // Authoritative grant list wins outright, including when empty.
          farmIds = grants.map((g) => g.farm_id).filter(Boolean);
        } catch (err: any) {
          // Farm-grants IS the authority on farm scope (docs handoff §8). When
          // it is unavailable we fail CLOSED for farm-specific data rather than
          // reusing the stale locally-recorded farm_ids, which may already have
          // been revoked upstream. Identity itself stays resolved (org
          // membership was verified above) — only the farm scope is empty, so
          // CoreEngine's farm-scope gate refuses status/images with zero farm
          // data instead of leaking another farm's telemetry.
          Logger.warn(`vFarm resolveSpeaker: farm-grants check unavailable for ${speaker.person_id}; failing closed with zero farm scope: ${err?.message}`);
          Logger.infra({
            message: `vFarm farm-grant lookup unavailable for ${speaker.person_id} (project ${params.projectId})`,
            commercial_impact:
              'Farm-specific answers (status, images) are refused for this caller until the grant lookup recovers. Non-farm knowledge answers still work.',
            meta: {
              tenant_id: params.tenantId,
              project_id: params.projectId,
              person_id: speaker.person_id,
              error: err?.message,
            },
          });
          farmIds = [];
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
        // farm_id is vFarm-authoritative (first entry of the live grant list).
        // unit_id is deliberately ABSENT: vFarm exposes no unit identifier on
        // the org member / farm-grant records this path reads, so any value
        // here would be invented. It used to be hardcoded to 'unit_bay_04',
        // which core/engine.ts forwarded to vFarm and BHARAG as though it were
        // real — producing answers about a unit that does not exist. Consumers
        // already treat a missing unit as unbound.
        ...(farmIds[0] ? { farm_id: farmIds[0] } : {}),
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
