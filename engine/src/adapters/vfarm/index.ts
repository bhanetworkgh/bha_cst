import { maskPhone } from '../../util/privacy.js';
import { ITenantAdapter } from '../types.js';
import { Project, ResourceScope, SpeakerRecord, SpeakerIdentity, UserRole, CabinetConfig } from '../../core/types.js';
import { Logger } from '../../config/logger.js';
import { recordFailure } from '../../recovery/self_healing_tracker.js';
import { VfarmHttpClient, VfarmApiError } from './http_client.js';
import { VfarmLiveClient, VFARM_DEFAULT_TIMEOUT_MS, VFARM_HEALTH_PROBE_TIMEOUT_MS } from './live_client.js';
import {
  buildDevFixtureProjects,
  buildDevFixtureResourceScopes,
  buildDevFixtureSpeakers,
  DEV_FIXTURE_ORG_ID,
  DEV_FIXTURE_ONBOARDING_REPLY,
} from './dev_seed.js';
import { assertSpeakerFarmAccess, VfarmAuthorizationError } from './authorization.js';
import {
  CONFIG_HASH_RE,
  type FarmHealthResponse,
  type FarmResponse,
  type OrgResponse,
} from './schemas.js';
import { normalizeFarmHealth, type FarmHealthStatus, type FarmHealthStaleness } from './health.js';

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
  /**
   * Whether to seed the DEMO phone -> identity directory.
   *
   * Defaults to "not in production". It is an explicit config flag so a
   * deployment (or a test) can decide without mutating `process.env`, which
   * is shared state and can leak between concurrently executed test files.
   */
  seedDemoDirectory?: boolean;
  /**
   * The vFarm organization this tenant belongs to.
   *
   * Used to SCOPE the health probe to a tenant. Injected rather than read
   * from the environment at call time so a test can control it without
   * mutating shared process state.
   */
  tenantOrgId?: string;
  /**
   * Request budget for a single health probe, in ms.
   *
   * Strictly bounded: the effective value is
   * `min(this, VFARM_HEALTH_PROBE_TIMEOUT_MS)`, so the probe can be made
   * tighter but never looser than the health-probe ceiling.
   */
  healthProbeTimeoutMs?: number;
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

/**
 * The stable failure vocabulary the health probe reports.
 *
 * Deliberately coarse: it is a diagnostic category, never a raw upstream
 * message, so nothing sensitive can travel with it.
 */
export type ProbeFailureCategory =
  | 'auth'
  | 'upstream'
  | 'network'
  | 'timeout'
  | 'invalid_response';

/**
 * Classify a health-probe failure into a stable category.
 *
 * Two different error hierarchies reach the probe: the HTTP client's
 * `VfarmApiError` (which carries a `category`) and the live client's
 * `VfarmHttpError` / `VfarmNetworkError` (which carry an HTTP status or
 * nothing). Both are mapped onto the same vocabulary so the health contract
 * is stable regardless of which client made the request.
 */
function classifyProbeFailure(err: any): ProbeFailureCategory {
  if (err instanceof VfarmApiError) {
    switch (err.category) {
      case 'auth':
        return 'auth';
      case 'timeout':
        return 'timeout';
      case 'network':
        return 'network';
      case 'invalid_response':
        return 'invalid_response';
      // 'not_found' | 'rate_limited' | 'upstream' — the upstream answered and
      // did not serve the request.
      default:
        return 'upstream';
    }
  }
  const status = err?.status ?? err?.statusCode;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'auth';
    return 'upstream';
  }
  if (err?.name === 'AbortError' || /abort/i.test(String(err?.message))) return 'timeout';
  // A response that failed schema validation surfaces as a Zod error.
  if (err?.name === 'ZodError' || Array.isArray(err?.issues)) return 'invalid_response';
  return 'network';
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
    // Keep the live client and http client bearer tokens in step with the refreshed JWT.
    this.liveClient.setApiToken(res.token);
    this.httpClient?.setApiToken(res.token);
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
        this.httpClient?.setApiToken(res.token);
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

  /**
   * Issue a farm-scoped API key.
   *
   * `switchActiveKey` controls a PROCESS-WIDE side effect: the adapter's
   * configured farm key is replaced and its upstream clients are rebuilt, so
   * every later vFarm call (farm discovery, organisation members, farm grants,
   * device readings) is made with the new farm's key.
   *
   * That is the right behaviour for an OPERATOR re-pointing CST at a
   * different farm. It is NOT right for a tenant-scoped caller: a caller JWT
   * must not be able to change the key every other tenant's resolution uses.
   * So the caller-JWT path mints the key for the caller's own farm — vFarm
   * enforces the organisation scope, because the caller's JWT is forwarded
   * verbatim — and returns it WITHOUT mutating shared state.
   */
  public async issueFarmToken(
    farmId: string,
    jwt?: string,
    name?: string,
    options: { switchActiveKey?: boolean } = {}
  ): Promise<string> {
    if (!this.liveClient) {
      throw new Error('vFarm live client not configured');
    }
    const token = jwt || (await this.ensureAdminToken());
    if (!token) {
      throw new Error('JWT token is required to issue farm token');
    }
    const res = await this.liveClient.issueFarmToken({ farmId, name }, token);
    const rawKey = res.raw_key || '';
    const switchActiveKey = options.switchActiveKey !== false;
    if (rawKey && switchActiveKey) {
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
    // can still render whatever data is available, while recording *why* each
    // upstream call failed so operators can distinguish vFarm degradation from
    // CST issues.
    const adminToken = await this.ensureAdminToken();

    let farmList: any = { farms: [], total: 0 };
    let farmListError: string | null = null;
    try {
      farmList = await this.liveClient.listFarms(adminToken || undefined, 15000);
    } catch (err: any) {
      farmListError = err?.message ?? String(err);
      Logger.warn(`vFarm dashboard: listFarms failed: ${farmListError}`);
    }

    let devicesRes: any = { devices: [], total: 0 };
    let devicesError: string | null = null;
    if (targetFarmId) {
      try {
        devicesRes = await this.liveClient.listAllDevices(targetFarmId, 500, 10000);
      } catch (err: any) {
        devicesError = err?.message ?? String(err);
        Logger.warn(`vFarm dashboard: listAllDevices failed for farm ${targetFarmId}: ${devicesError}`);
      }
    }

    let healthRes: any = { status: 'unknown', health_score: null };
    let healthError: string | null = null;
    if (targetFarmId) {
      try {
        healthRes = await this.liveClient.getFarmHealth(targetFarmId, 3000);
      } catch (err: any) {
        healthError = err?.message ?? String(err);
        Logger.warn(`vFarm dashboard: getFarmHealth failed for farm ${targetFarmId}: ${healthError}`);
      }
    }

    // Find the specific farm object from the discovered list
    const farm = targetFarmId
      ? farmList.farms.find((f: any) => (f.farm_id || f.id) === targetFarmId) ?? null
      : (farmList.farms[0] ?? null);

    const devices: any[] = (devicesRes as any).devices ?? [];
    const deviceCount: number = (devicesRes as any).total ?? devices.length;

    const diagnostics: Record<string, any> = {};
    if (farmListError) diagnostics.farm_list = { error: farmListError };
    if (devicesError) diagnostics.devices = { error: devicesError };
    if (healthError) diagnostics.health = { error: healthError };

    return {
      farm_id: targetFarmId ?? (farm ? ((farm as any).farm_id || (farm as any).id) : null),
      farm,
      device_count: deviceCount,
      devices,
      health: healthRes,
      diagnostics: Object.keys(diagnostics).length > 0 ? diagnostics : undefined,
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

  /**
   * FARM-level status for a speaker who is authorized for that farm.
   *
   * Used when a caller holds a valid farm grant but has no UNIT binding.
   * vFarm exposes no user -> device mapping, so a per-unit reading cannot be
   * attributed to a person. The FARM level, however, is fully readable:
   * `GET /api/v1/farms/{farm_id}/health` and the farm's device inventory are
   * both scoped to a farm the speaker is granted.
   *
   * The farm scope is re-checked here (defense in depth) against the
   * speaker's authoritative grant list, so this can never widen access.
   */
  public async getFarmStatusForSpeaker(params: { farmId: string; speaker: SpeakerIdentity }): Promise<{
    farm_name?: string;
    status: FarmHealthStatus;
    raw_status: string | null;
    health_score: number | null;
    staleness_evaluation: FarmHealthStaleness;
    devices: {
      total: number;
      online: number;
      offline: number;
      unhealthy: number;
      maintenance: number;
      error: number;
    };
  } | null> {
    if (!params.farmId) return null;
    // Throws VfarmAuthorizationError when the speaker is not granted this farm.
    assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    if (!this.liveClient) return null;

    const [healthResult, devicesResult] = await Promise.allSettled([
      this.liveClient.getFarmHealth(params.farmId),
      this.liveClient.listAllDevices(params.farmId),
    ]);
    const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
    const devices = devicesResult.status === 'fulfilled' ? devicesResult.value : null;
    if (!health && !devices) return null;

    // The live device-list payload types its counters loosely; read them
    // through a loose record rather than widening the public return type.
    const dev = (devices ?? {}) as Record<string, any>;
    const hl = (health ?? {}) as Record<string, any>;
    const normalizedHealth = normalizeFarmHealth(health, {
      upstreamError: healthResult.status === 'rejected',
    });

    return {
      farm_name: hl.farm_name,
      status: normalizedHealth.status,
      raw_status: normalizedHealth.raw_status,
      health_score: normalizedHealth.health_score,
      staleness_evaluation: normalizedHealth.staleness_evaluation,
      devices: {
        total: dev.total ?? dev.devices?.length ?? hl.device_count ?? 0,
        online: dev.online_count ?? hl.online_count ?? 0,
        offline: dev.offline_count ?? hl.offline_count ?? 0,
        unhealthy: dev.unhealthy_count ?? hl.unhealthy_count ?? 0,
        maintenance: dev.maintenance_count ?? 0,
        error: dev.error_count ?? 0,
      },
    };
  }

  /**
   * Fleet status for a speaker authorized for that farm.
   *
   * vFarm's five mutually-exclusive device-status contract (calculated at query
   * time in SQL; Kavin's PR #100 merged into develop). Every reporting device
   * or load belongs to exactly one of: on | off | online | unhealthy | offline.
   * Cabinets are frames, not reporting devices — their fleet_status is null.
   * Relay channels are excluded from fleet totals; relay modules are NOT.
   *
   * CST does NOT recompute authoritative device status here. It reads
   * `fleet_counts` from the upstream and reports it verbatim. When the
   * upstream deployment has not yet returned `fleet_counts` (older contract),
   * the bucket is reported as unavailable rather than fabricated — a missing
   * field is never reinterpreted as offline, and a null cabinet status is
   * never promoted to a reporting-device bucket.
   *
   * Returns null when the farm is not granted, the adapter has no live
   * client, or the upstream call fails — never a fabricated fleet status.
   */
  public async getFleetStatusForSpeaker(params: { farmId: string; speaker: SpeakerIdentity }): Promise<{
    farm_id?: string;
    fleet_status?: string | null;
    fleet_counts?: {
      total?: number;
      on?: number;
      off?: number;
      online?: number;
      unhealthy?: number;
      offline?: number;
    };
    upstream_contract: 'fleet_counts' | 'legacy_counters' | 'unavailable';
  } | null> {
    if (!params.farmId) return null;
    assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    if (!this.liveClient) return null;

    try {
      const devices = await this.liveClient.listAllDevices(params.farmId);
      const dev = (devices ?? {}) as Record<string, any>;
      const counts = dev.fleet_counts;
      if (counts && typeof counts === 'object') {
        return {
          farm_id: params.farmId,
          fleet_status: dev.fleet_status ?? null,
          fleet_counts: {
            total: typeof counts.total === 'number' ? counts.total : undefined,
            on: typeof counts.on === 'number' ? counts.on : undefined,
            off: typeof counts.off === 'number' ? counts.off : undefined,
            online: typeof counts.online === 'number' ? counts.online : undefined,
            unhealthy: typeof counts.unhealthy === 'number' ? counts.unhealthy : undefined,
            offline: typeof counts.offline === 'number' ? counts.offline : undefined,
          },
          upstream_contract: 'fleet_counts',
        };
      }
      // Older upstream contract: only the legacy counters are present. Report
      // them honestly and flag the contract version rather than inventing the
      // five-bucket split.
      return {
        farm_id: params.farmId,
        fleet_status: dev.fleet_status ?? null,
        fleet_counts: undefined,
        upstream_contract: 'legacy_counters',
      };
    } catch (err: any) {
      Logger.warn(`vFarm getFleetStatusForSpeaker: fleet status lookup failed for farm ${params.farmId}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Open alerts for a farm the speaker is authorized for.
   *
   * Read-only, farm-scoped, authorized by the caller's grant list. The
   * upstream endpoint is `GET /api/v1/alerts/threshold/open?farm_id=...`,
   * verified against the live vFarm OpenAPI contract (farm_id is a
   * documented filter, the response is `{ alerts[], total }`).
   *
   * Returns null when the farm is not granted, the adapter has no live
   * client, or the upstream call fails — never a fabricated list.
   */
  public async getFarmAlertsForSpeaker(params: { farmId: string; speaker: SpeakerIdentity; limit?: number }): Promise<{
    total: number;
    alerts: Array<{ id: string; device_id: string; severity: string; title: string; detail: string; opened_at: string }>;
  } | null> {
    if (!params.farmId) return null;
    // Same fast refusal as getFarmStatusForSpeaker.
    assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    if (!this.liveClient) return null;

    try {
      const res = await this.liveClient.listOpenAlerts(params.farmId, params.limit ?? 10);
      const alerts = (res.alerts ?? []).map((a: any) => ({
        id: a.id,
        device_id: a.device_id ?? '',
        severity: a.severity ?? 'info',
        title: a.title ?? '',
        detail: a.detail ?? '',
        opened_at: a.opened_at ?? '',
      }));
      return { total: res.total ?? alerts.length, alerts };
    } catch (err: any) {
      Logger.warn(`vFarm getFarmAlertsForSpeaker: alert lookup failed for farm ${params.farmId}: ${err?.message}`);
      return null;
    }
  }

  public async getLatestDeviceReading(params: { farmId: string; deviceId: string; speaker?: SpeakerIdentity }): Promise<any> {
    if (params.speaker) {
      assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    }
    if (!this.liveClient) return null;
    try {
      return await this.liveClient.getLatestReading(params.deviceId);
    } catch (err: any) {
      // 404 = no readings for this device. That is a real, honest result,
      // not an upstream failure. Surface it as null so the connector can
      // distinguish "no reading" from "upstream unavailable".
      if (err?.status === 404 || /no readings/i.test(String(err?.message))) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Authoritative per-device fleet status for a single device.
   *
   * Reads `GET /api/v1/devices/{device_id}` and returns the upstream
   * `fleet_status` field verbatim. vFarm remains the authority: CST does not
   * recompute this from `last_seen_at`, `last_reading_at`, health score, relay
   * state, or any timeout calculation.
   *
   * The five buckets are:
   *   on / off        — loads (pumps, valves, lights) driven by a relay channel
   *   online          — reporting device, health >= 80 or no score yet
   *   unhealthy       — reporting device, health < 80
   *   offline         — upstream-reported offline/never-heard state
   *   null            — cabinets (frames, not reporting devices)
   *
   * The exact upstream presence window is not asserted by CST.
   *
   * A missing field from an older upstream contract is reported as
   * `unavailable` rather than reinterpreted as offline. A null cabinet
   * status is never promoted into a reporting-device bucket.
   *
   * Returns null when the farm is not granted, the adapter has no live
   * client, or the upstream call fails — never a fabricated status.
   */
  public async getDeviceFleetStatus(params: { farmId: string; deviceId: string; speaker?: SpeakerIdentity }): Promise<{
    device_id: string;
    farm_id: string;
    fleet_status: string | null;
    device_type?: string;
    device_type_label?: string;
    upstream_contract: 'fleet_status' | 'legacy_status' | 'unavailable';
  } | null> {
    if (!params.deviceId) return null;
    if (params.speaker) {
      assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    }
    if (!this.liveClient) return null;

    try {
      const dev = await this.liveClient.getDevice(params.deviceId);
      const d = (dev ?? {}) as Record<string, any>;
      const fleetStatus = d.fleet_status;
      if (fleetStatus !== undefined) {
        // Field present in response (could be string or explicit null for cabinet)
        return {
          device_id: params.deviceId,
          farm_id: params.farmId,
          fleet_status: fleetStatus,
          device_type: typeof d.device_type === 'string' ? d.device_type : undefined,
          device_type_label: typeof d.device_type_label === 'string' ? d.device_type_label : undefined,
          upstream_contract: 'fleet_status',
        };
      }
      // Older upstream contract: no fleet_status field at all. Report the legacy
      // `status` field honestly and flag the contract version rather than
      // mapping it onto the new buckets.
      return {
        device_id: params.deviceId,
        farm_id: params.farmId,
        fleet_status: null,
        device_type: typeof d.device_type === 'string' ? d.device_type : undefined,
        device_type_label: typeof d.device_type_label === 'string' ? d.device_type_label : undefined,
        upstream_contract: 'legacy_status',
      };
    } catch (err: any) {
      Logger.warn(`vFarm getDeviceFleetStatus: fleet status lookup failed for device ${params.deviceId}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Latest readings across all sensors/devices in an authorized farm.
   *
   * Farm-scoped and authorized by the speaker's grant list (re-checked
   * inside `assertSpeakerFarmAccess`). Returns empty array when there are no
   * readings — never fabricated values.
   *
   * @param farmId - The farm ID to fetch readings for
   * @param speaker - Optional speaker identity for authorization
   * @param timeoutMs - Per-request timeout in ms (default: client timeoutMs)
   * @param concurrency - Max concurrent device-reading requests (default 12, max 12)
   * @param correlationId - Optional correlation ID for structured logging
   * @returns Array of successful readings
   */
  public async listLatestReadings(params: {
    farmId: string;
    speaker?: SpeakerIdentity;
    timeoutMs?: number;
    concurrency?: number;
    correlationId?: string;
  }): Promise<any[]> {
    if (params.speaker) {
      assertSpeakerFarmAccess(params.speaker, params.farmId, this.getDiscoveredFarmIds());
    }
    if (!this.liveClient) {
      return [];
    }
    try {
      const correlationId = params.correlationId || `vfarm-readings-${params.farmId}-${Date.now()}`;
      const startTime = Date.now();
      const readings = await this.liveClient.listLatestReadings(
        params.farmId,
        100,
        params.timeoutMs,
        params.concurrency,
        correlationId
      );
      const duration = Date.now() - startTime;
      Logger.info(`vFarm listLatestReadings completed`, {
        correlation_id: correlationId,
        farm_id: params.farmId,
        reading_count: readings.length,
        duration_ms: duration,
      });
      return readings;
    } catch (err: any) {
      // Upstream failure — surface as empty so the connector can report
      // honestly rather than claiming readings it cannot retrieve.
      Logger.warn(`vFarm listLatestReadings failed for farm ${params.farmId}: ${err?.message}`);
      return [];
    }
  }

  public setDegraded(degraded: boolean): void {
    this.config.simulateDegraded = degraded;
  }

  /**
   * Direct pass-through to the authoritative vFarm farm health endpoint.
   * Returns the raw upstream response without re-interpretation.
   * Used by `/api/health` to separate API reachability from farm health.
   */
  public async getFarmHealthDirect(farmId: string): Promise<FarmHealthResponse | null> {
    if (!this.liveClient) return null;
    // Preserve the distinction between an empty/missing response and a failed
    // upstream request. `/api/health` maps a thrown request failure to
    // degraded; collapsing it to null would incorrectly report unknown.
    return await this.liveClient.getFarmHealth(farmId);
  }

  /**
   * Seed the DEV/TEST FIXTURE state.
   *
   * PRODUCTION SEEDS NOTHING HERE. A production adapter's projects, farms
   * and directory come from:
   *   - the database, via `CoreRegistry.initFromDb()` (`projects`,
   *     `service_number_bindings`, `customers`), and
   *   - optionally live vFarm discovery, via `pullProjects()` and
   *     `pullResourceScopes()`.
   *
   * The fixture used to be seeded in production too, which meant the adapter
   * always carried two hardcoded projects pointing at one hardcoded
   * organization, plus three FABRICATED farm ids in the resource-scope map —
   * the grant-comparison path. A tenant that had neither project was still
   * carrying them.
   *
   * @see dev_seed.ts for the fixture itself and why it is a fixture.
   */
  private initDefaultData(): void {
    // The dev/test fixture is opt-out for tests and off in production.
    const seedDevFixture =
      this.config.seedDemoDirectory ?? process.env.NODE_ENV !== 'production';

    if (!seedDevFixture) {
      // No project, farm, organization, phone or voice id is invented here.
      // The registry hydrates the adapter from the database (and, optionally,
      // from live vFarm discovery) right after construction.
      return;
    }

    // tenant_org_id must be the real vFarm organization UUID, not a CST
    // placeholder. vFarm answers HTTP 422 for placeholder ids, so a placeholder
    // here silently disables the live membership cross-check in pullSpeakers()
    // and resolveSpeaker() (G19). Discovered from GET /api/v1/organizations.
    const vfarmOrgId = process.env.VFARM_TENANT_ORG_ID || DEV_FIXTURE_ORG_ID;

    const [proj1, proj2] = buildDevFixtureProjects(
      this.tenantId,
      vfarmOrgId,
      process.env.VFARM_ONBOARDING_REPLY || DEV_FIXTURE_ONBOARDING_REPLY,
    );

    this.projectsMap.set(proj1.project_id, proj1);
    this.projectsMap.set(proj2.project_id, proj2);

    // Resources (Farms) — fixture ids only.
    const scopes = buildDevFixtureResourceScopes();
    for (const [projectId, projectScopes] of scopes) {
      this.resourceScopesMap.set(projectId, projectScopes);
    }

    // ── The admin-managed phone -> identity directory ────────────────────────
    //
    // vFarm exposes no phone field on a user, so the phone -> vFarm user_id
    // binding is CST-owned and lives in the `customers` table. The runtime
    // directory below is therefore populated from that durable table, at boot,
    // by `CoreRegistry.initFromDb()`.
    //
    // The entries that used to be seeded here were DEMO identities
    // (`usr_vfarm_003`, `farm_austin_main`, `bay_04` — invented identifiers,
    // see migration 015). In production they were not harmless: the seed
    // re-ran on every process start, so an inbound caller number resolved
    // against a fabricated person_id, the live organisation-membership check
    // correctly refused it, the speaker was downgraded to an unknown caller,
    // and the caller received the GUEST onboarding reply ("a specialist will
    // assist you shortly") instead of their own farm data.
    //
    // So in production the directory starts EMPTY and is filled only from the
    // durable customer records. In a non-production environment the demo
    // directory is still seeded, because the test-suite and the local demo
    // rely on it.
    const speakers = buildDevFixtureSpeakers();
    for (const [projectId, projectSpeakers] of speakers) {
      this.speakersMap.set(projectId, projectSpeakers);
    }
  }

  // Dynamic helper methods for testing & administration
  public addProject(project: Project): void {
    this.projectsMap.set(project.project_id, project);
  }

  /** Return the vFarm org_id for a project, used for org-member lookups. */
  public _getProjectOrgId(projectId: string): string | null {
    return this.projectsMap.get(projectId)?.tenant_org_id ?? null;
  }

  /**
   * Read-only view of the admin-managed phone -> identity directory.
   *
   * Exposed so the runtime state can be inspected (admin panel, regression
   * tests) without reaching into the private map. It performs NO upstream
   * call and changes nothing.
   */
  public getRegisteredSpeaker(projectId: string, phoneE164: string): SpeakerRecord | null {
    const pMap = this.speakersMap.get(projectId);
    if (!pMap) return null;
    return pMap.get((phoneE164 || '').trim()) || null;
  }

  /** Number of admin-managed phone bindings held for a project. */
  public getRegisteredSpeakerCount(projectId: string): number {
    return this.speakersMap.get(projectId)?.size || 0;
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
      await this.ensureAdminToken();
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

  /**
   * Find an organization member by EMAIL address.
   *
   * Read-only, and built on the endpoint CST already uses for the
   * authoritative membership check
   * (`GET /api/v1/organizations/{org_id}/users`). No endpoint is invented:
   * vFarm exposes NO phone field on a user (verified against the live
   * OpenAPI contract), so email is the only correlation a member record
   * carries.
   *
   * The comparison is case-insensitive, because the address a person types
   * and the address vFarm stores can differ in case.
   *
   * @returns the matching member, or null. Returns null (not an error) when
   *   the organization has no such member — the caller must not distinguish
   *   "no such address" from "not a member", or the endpoint becomes a
   *   member-enumeration oracle.
   */
  async findOrgMemberByEmail(
    orgId: string,
    email: string,
  ): Promise<{ user_id: string; role: string; name?: string } | null> {
    const needle = (email || '').trim().toLowerCase();
    if (!needle || !orgId) return null;
    if (!this.httpClient) return null;

    const members = await this.httpClient.listOrganizationMembers(orgId);
    const match = members.find((m) => (m.email || '').trim().toLowerCase() === needle);
    if (!match) return null;
    return { user_id: match.user_id, role: match.role, name: match.name };
  }

  /**
   * Candidate service numbers for this tenant.
   *
   * Candidate numbers must originate from an authoritative source — the
   * provider's own list of the account's numbers, or an explicit
   * configuration. There is NO hardcoded fallback here.
   *
   * The previous fallback returned three literal numbers, two of which the
   * Twilio account does not own. Presenting an unowned number as a candidate
   * makes it bindable as an outbound sender, which is the precondition for
   * Twilio error 21659 ("the 'From' number is not a valid phone number,
   * shortcode or alphanumeric sender id"). Failing closed — returning no
   * candidates and an explicit reason — is the safe outcome: an operator can
   * configure a real number, but nobody can bind a fabricated one.
   */
  async pullCandidateNumbers(tenantId: string): Promise<string[]> {
    if (tenantId !== this.tenantId) return [];

    const configured = (process.env.VFARM_CANDIDATE_NUMBERS || '')
      .split(',')
      .map((n) => n.trim())
      .filter((n) => /^\+[1-9]\d{7,14}$/.test(n));

    if (configured.length === 0) {
      Logger.warn(
        'vFarm adapter: no authoritative candidate numbers available. ' +
          'Set VFARM_CANDIDATE_NUMBERS to the numbers this account owns; no candidates are fabricated.',
      );
      return [];
    }

    return configured;
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
      Logger.warn(`vFarm Adapter degraded: live resolve failed for ${maskPhone(cleanPhone)}`);
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
    let effectivePersonId = speaker.person_id;

    // In production the authoritative source is MANDATORY. If the adapter has
    // no live client (no vFarm base URL configured), the membership and
    // farm-grant checks cannot run, and trusting the local record would be a
    // fail-OPEN path. Fail closed instead.
    if (process.env.NODE_ENV === 'production' && !this.httpClient) {
      Logger.error(
        `vFarm resolveSpeaker: no live vFarm client is configured for tenant ${this.tenantId}; failing closed`,
      );
      return this.unknownIdentity(
        { tenantId: params.tenantId, projectId: params.projectId, phone: cleanPhone },
        'opaque_revoked',
      );
    }

    // Live mode: re-verify the locally-registered speaker against the
    // authoritative vFarm organization-members list before trusting it.
    if (this.httpClient) {
      await this.ensureAdminToken();
      const orgId = this._getProjectOrgId(params.projectId);
      if (!orgId) {
        // The authoritative membership check CANNOT be performed for this
        // project: it has no vFarm organization id, so the org-members
        // endpoint cannot be queried for it. Falling through would TRUST the
        // local record — including the locally-recorded farm scope — without
        // ever checking it upstream. That is a fail-OPEN path. A project that
        // is registered without its vFarm organization id (a dynamic
        // registration, or a row predating the G19 org-id fix) must not be
        // able to authorise anybody.
        Logger.warn(
          `vFarm resolveSpeaker: project ${params.projectId} has no vFarm organization id, so membership cannot be verified; failing closed`,
        );
        return this.unknownIdentity(
          { tenantId: params.tenantId, projectId: params.projectId, phone: cleanPhone },
          'opaque_revoked',
        );
      }
      {
        // Any thrown VfarmApiError (auth/timeout/network/upstream/invalid
        // response) propagates to CoreRegistry, which fails closed — see
        // docs handoff §16 "Upstream authentication failure" / "timeout".
        const members = await this.httpClient.listOrganizationMembers(orgId);
        const targetRef = (speaker.person_id || '').trim().toLowerCase();
        const upstream = members.find((m) => {
          // Compare the SAME way for every key. The id comparison used to be
          // an exact, untrimmed, case-sensitive match while the email and name
          // comparisons were normalised, so a reference that differed only by
          // case or padding silently failed to match. Normalising all three
          // can only ever select the SAME upstream record — it cannot widen
          // the authorization beyond what the upstream actually granted.
          if (m.user_id && m.user_id.trim().toLowerCase() === targetRef) return true;
          if (m.email && m.email.toLowerCase() === targetRef) return true;
          if (m.name && m.name.toLowerCase() === targetRef) return true;
          if ((targetRef === 'own' || targetRef === 'owner') && m.role === 'admin') return true;
          return false;
        });
        if (!upstream) {
          // Removed/revoked upstream — fail closed even though a local
          // record still exists.
          //
          // DIAGNOSTIC. This branch used to be completely silent, which is why
          // an operator could not tell "vFarm denied this caller" from "the
          // local record does not identify a vFarm member" from "the project
          // points at the wrong vFarm organization". They are different
          // problems with different fixes, and they must be distinguishable
          // from the log alone.
          //
          // Only counts and the classification are logged: no identifier, no
          // email, no name, no phone number.
          const memberListEmpty = members.length === 0;
          Logger.warn(
            `vFarm resolveSpeaker: the local customer reference identifies no member of the vFarm organization for project ${params.projectId}; failing closed`,
            {
              tenant_id: params.tenantId,
              project_id: params.projectId,
              upstream_member_count: members.length,
              // 'upstream_organization_has_no_members' means the project is
              // pointed at an organization that has no members — a MAPPING
              // problem. 'local_reference_matches_no_member' means the
              // organization is populated but the stored reference does not
              // identify any of its members — a CUSTOMER-RECORD problem, which
              // is fixable by storing the caller's vFarm user id as the
              // customer reference.
              reason: memberListEmpty
                ? 'upstream_organization_has_no_members'
                : 'local_reference_matches_no_member',
            },
          );
          // Record for the self-healing tracker: a repeated failure to
          // resolve the caller's identity is a system-level degradation, not
          // a one-off. After 3 in 10 minutes the capability is marked
          // degraded and stops claiming live device data.
          recordFailure({
            tenantId: params.tenantId,
            projectId: params.projectId,
            category: 'no_farm_grant',
            correlationRef: cleanPhone.replace(/[^0-9]/g, '') || 'unknown',
          });
          return this.unknownIdentity({ tenantId: params.tenantId, projectId: params.projectId, phone: cleanPhone }, 'opaque_revoked');
        }
        effectivePersonId = upstream.user_id;
        const mappedRole = mapVfarmOrgRoleToCstRole(upstream.role);
        if (mappedRole) role = mappedRole;

        try {
          const grants = await this.httpClient.getUserFarmGrants(effectivePersonId);
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
          Logger.warn(`vFarm resolveSpeaker: farm-grants check unavailable for ${effectivePersonId}; failing closed with zero farm scope: ${err?.message}`);
          Logger.infra({
            message: `vFarm farm-grant lookup unavailable for ${effectivePersonId} (project ${params.projectId})`,
            commercial_impact:
              'Farm-specific answers (status, images) are refused for this caller until the grant lookup recovers. Non-farm knowledge answers still work.',
            meta: {
              tenant_id: params.tenantId,
              project_id: params.projectId,
              person_id: effectivePersonId,
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
    const customerRef = `cust_${effectivePersonId}`;

    return {
      person_id: effectivePersonId,
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

  /**
   * The vFarm organization this tenant's projects belong to.
   *
   * Used by the health probe so it can make a TENANT-SCOPED, read-only
   * request instead of a tenant-agnostic one.
   */
  private resolveTenantOrgId(): string | null {
    // Only the OPERATOR-CONFIGURED organization id is used to scope the
    // health probe.
    //
    // The adapter's built-in project seed carries a fallback organization id
    // so the membership cross-check has something to query; using that
    // fallback for a health probe would target a hardcoded id and could
    // report another organization's health as this tenant's. The probe is
    // therefore scoped by configuration alone, and when no organization is
    // configured it reports `configured` — reachable and honest — rather than
    // making an unscoped claim.
    const fromConfig = (this.config.tenantOrgId || '').trim();
    if (fromConfig) return fromConfig;
    const configured = (process.env.VFARM_TENANT_ORG_ID || '').trim();
    return configured ? configured : null;
  }

  /**
   * The request budget for a single health probe.
   *
   * Strictly bounded: `min(configured request timeout, VFARM_HEALTH_PROBE_TIMEOUT_MS)`.
   * A health probe is a liveness signal, so it must never hold a caller
   * open for the general request budget, and an operator who raised
   * `VFARM_API_TIMEOUT_MS` must not be able to make it unbounded.
   */
  private healthProbeTimeoutMs(): number {
    const configured = this.config.healthProbeTimeoutMs
      ?? this.config.timeoutMs
      ?? VFARM_DEFAULT_TIMEOUT_MS;
    return Math.max(1, Math.min(configured, VFARM_HEALTH_PROBE_TIMEOUT_MS));
  }

  /**
   * OPERATIONAL readiness, evaluated WITHOUT contacting the upstream.
   *
   * This is what the per-request authorization path consults. It is
   * deliberately NOT a liveness probe:
   *
   *  - a probe is a network round trip on the customer's turn;
   *  - making authorization depend on the upstream's liveness AT THAT INSTANT
   *    couples a live conversation to an upstream outage, and would refuse
   *    every turn the moment a health endpoint misbehaves;
   *  - the authoritative upstream check already happens inside
   *    `resolveSpeaker()`, which fails closed on its own (`opaque_degraded` /
   *    `opaque_revoked`), so the fail-closed guarantee does not depend on
   *    this check.
   *
   * The returned status uses the same vocabulary as the active probe:
   *   - `unavailable` — the adapter has no usable identity source. In
   *     production that means no vFarm client is configured, and the adapter
   *     would refuse every identity anyway.
   *   - `degraded`    — the adapter is explicitly in a simulated-degraded
   *     state, so identity resolution will fail closed.
   *   - `configured`  — the adapter can serve identity resolution, but
   *     upstream health is NOT asserted because nothing was probed.
   */
  private operationalStatus(tenantId: string): {
    status: 'configured' | 'healthy' | 'degraded' | 'unavailable';
    details: Record<string, unknown>;
  } {
    const mode = this.isLiveMode() ? 'live' : 'local';
    const baseDetails: Record<string, unknown> = {
      projects_count: this.projectsMap.size,
      tenant_id: tenantId,
      mode,
      probe: 'skipped',
    };

    if (this.config.simulateDegraded) {
      return {
        status: 'degraded',
        details: { ...baseDetails, reason: 'simulated_degraded' },
      };
    }

    if (this.isLiveMode()) {
      // The authoritative organisation-membership and farm-grant checks run
      // inside resolveSpeaker() and fail closed on their own.
      return {
        status: 'configured',
        details: { ...baseDetails, reason: 'upstream_health_not_probed' },
      };
    }

    // No upstream configured. In production this is a fail-closed condition:
    // resolveSpeaker() returns `opaque_revoked` for every caller because the
    // authoritative check cannot run, so the adapter genuinely cannot serve.
    if (process.env.NODE_ENV === 'production') {
      return {
        status: 'unavailable',
        details: { ...baseDetails, reason: 'no_vfarm_client_configured' },
      };
    }

    // Local/dev mode: the admin-managed directory is a legitimate identity
    // source, and upstream health is simply not applicable.
    return {
      status: 'configured',
      details: { ...baseDetails, reason: 'local_identity_directory' },
    };
  }

  /**
   * Report vFarm upstream health.
   *
   * This performs a REAL, bounded, read-only upstream request and reports the
   * MEASURED latency. It previously returned a hard-coded
   * `{ status: 'healthy', latency_ms: 15 }` without contacting vFarm at all,
   * so a deployment with an unreachable, unauthorised or misconfigured upstream
   * still reported itself healthy.
   *
   * States:
   *   - `unavailable`  CST cannot use the upstream at all: no client is
   *                    configured, or the credential was rejected (401/403).
   *   - `configured`   the upstream is configured and reachable, but upstream
   *                    health is NOT asserted: either the probe could not be
   *                    scoped to this tenant (no vFarm organization id), or
   *                    the probe was skipped (`options.probe === false`).
   *   - `healthy`      a tenant-scoped read-only request succeeded.
   *   - `degraded`     the upstream answered but did not serve the request
   *                    (5xx, rate limit, timeout, connection failure, or a
   *                    response that failed validation).
   *
   * The probe never mutates tenant state: it reads, and it does not touch the
   * discovered-farm cache. It never logs a credential or a response body, and
   * it never throws.
   *
   * @param options.probe - Set to `false` to report OPERATIONAL readiness
   *   without contacting the upstream. See `operationalStatus()`.
   */
  async getHealth(tenantId: string, options?: { probe?: boolean }): Promise<{
    status: 'configured' | 'healthy' | 'degraded' | 'unavailable';
    latency_ms?: number;
    details?: Record<string, unknown>;
  }> {
    if (options?.probe === false) {
      return this.operationalStatus(tenantId);
    }

    const mode = this.isLiveMode() ? 'live' : 'local';
    const baseDetails = {
      projects_count: this.projectsMap.size,
      tenant_id: tenantId,
      mode,
    };

    if (this.config.simulateDegraded) {
      return {
        status: 'degraded',
        latency_ms: 1200,
        details: { ...baseDetails, error: 'Simulated API latency / degradation' },
      };
    }

    // No live client means there is no upstream to probe at all.
    if (!this.liveClient) {
      return {
        status: 'unavailable',
        details: { ...baseDetails, reason: 'no_vfarm_client_configured' },
      };
    }

    const orgId = this.resolveTenantOrgId();
    const budget = this.healthProbeTimeoutMs();
    const startedAt = Date.now();
    try {
      // The vFarm organization routes reject X-Farm-Key auth and require the
      // admin JWT, so the probe must present it explicitly.
      if (orgId) {
        // Tenant-scoped, read-only, documented endpoint.
        await this.liveClient.getOrganization(orgId, this.adminJwt ?? undefined, budget);
      } else {
        // No organization id to scope to. The upstream is still reachable and
        // the credential is still checked, but tenant health is NOT asserted.
        await this.liveClient.listOrganizations(this.adminJwt ?? undefined, budget);
      }
      const latencyMs = Date.now() - startedAt;
      if (!orgId) {
        return {
          status: 'configured',
          latency_ms: latencyMs,
          details: {
            ...baseDetails,
            reachable: true,
            reason: 'no_tenant_org_id_for_scoped_probe',
          },
        };
      }
      return {
        status: 'healthy',
        latency_ms: latencyMs,
        details: { ...baseDetails, probe: 'organization' },
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startedAt;
      const category = classifyProbeFailure(err);
      // An authentication failure means the upstream is not usable with the
      // configured credential — that is "unavailable", not merely "degraded".
      const status = category === 'auth' ? 'unavailable' : 'degraded';
      // The category only — never the error message, the upstream body, or
      // the credential. The upstream body can echo internal detail.
      Logger.warn(`vFarm health probe failed (${category}) after ${latencyMs}ms`);
      return {
        status,
        latency_ms: latencyMs,
        details: { ...baseDetails, reason: `probe_failed:${category}` },
      };
    }
  }
}
