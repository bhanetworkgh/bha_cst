/**
 * VfarmLiveClient — thin HTTP wrapper around the live vFarm API.
 *
 * Authentication: X-Farm-Key header (per live OpenAPI contract).
 * Base URL is always read from config, never hardcoded.
 * No credentials are logged.
 *
 * Cabinet data (serial, config_hash, config detail) is returned transiently
 * and must NEVER be persisted by CST.
 */
import { Logger } from '../../config/logger.js';
import {
  OrgMemberResponseSchema,
  normalizeFarmGrants,
  InventoryResponseSchema,
  UnitConfigResponseSchema,
  ConfigResponseSchema,
  FarmResponseSchema,
  FarmListResponseSchema,
  LoginResponseSchema,
  TokenCreatedResponseSchema,
  FarmHealthResponseSchema,
  DeviceListResponseSchema,
  LatestReadingResponseSchema,
  ReadingsListResponseSchema,
  StatsResponseSchema,
  CONFIG_HASH_PATTERN,
  // New OpenAPI-aligned schemas
  healthResponseSchema,
  orgListResponseSchema,
  orgResponseSchema,
  layoutResponseSchema,
  zoneResponseSchema,
  deviceResponseSchema,
  deviceRollupResponseSchema,
  openAlertListResponseSchema,
  placeCountListResponseSchema,
  alertHistoryListResponseSchema,
  imageAnalysisSchema,
  type OrgMemberResponse,
  type GrantedFarmRow,
  type InventoryResponse,
  type UnitConfigResponse,
  type ConfigResponse,
  type FarmResponse,
  type FarmListResponse,
  type LoginResponse,
  type TokenCreatedResponse,
  type TokenResponse,
  type FarmHealthResponse,
  type DeviceListResponse,
  type DeviceResponse,
  type DeviceRollupResponse,
  type LatestReadingResponse,
  type ReadingsListResponse,
  type StatsResponse,
  type HealthResponse,
  type OrgListResponse,
  type OrgResponse,
  type LayoutResponse,
  type ZoneResponse,
  type OpenAlertListResponse,
  type PlaceCountListResponse,
  type AlertHistoryListResponse,
  type ImageAnalysis,
} from './schemas.js';

export const VFARM_DEFAULT_BASE_URL = 'https://vfarm.bhanetwork.org';

/**
 * Single default request budget for BOTH vFarm HTTP clients.
 *
 * These two clients used to carry divergent defaults (VfarmHttpClient 8000ms,
 * VfarmLiveClient 5000ms) while `VfarmTenantAdapter` fed the same, frequently
 * unset, `config.timeoutMs` into both. With `VFARM_API_TIMEOUT_MS` unset — which
 * is the current state of `.env` — the same upstream call could therefore abort
 * at 8s on one path and 5s on the other.
 *
 * 5000ms is kept because it is the value already shipped on the live client and
 * because it is the *tighter* bound: the retry paths multiply this number
 * (see the worst-case arithmetic in docs), so lowering the ceiling lowers the
 * worst case rather than inflating it. Measured live latency is p50 ~235ms /
 * max ~984ms, so this leaves roughly 5x headroom over observed real calls.
 * Operators with a slow upstream should set VFARM_API_TIMEOUT_MS explicitly and
 * confirm the multiplied retry budget still fits their own request timeout.
 */
export const VFARM_DEFAULT_TIMEOUT_MS = 5000;

/**
 * Per-endpoint override for GET /api/v1/system/stats, which scans the whole
 * platform and measured 13.8-39.0s live on 2026-10-05 — far beyond
 * VFARM_DEFAULT_TIMEOUT_MS. See getSystemStats() for the measurements and for
 * why a long budget here does not weaken the hot-path default.
 */
export const VFARM_SYSTEM_STATS_TIMEOUT_MS = 60000;

/**
 * Strict upper bound for the vFarm HEALTH PROBE.
 *
 * The probe is a liveness/readiness signal, not a data path. It runs on the
 * admin/health surfaces, so it must never hold a request open for the general
 * request budget. The effective probe timeout is
 * `min(configured timeout, VFARM_HEALTH_PROBE_TIMEOUT_MS)`, so an operator
 * who lowered `VFARM_API_TIMEOUT_MS` still gets the tighter bound, and an
 * operator who raised it does not accidentally make the probe unbounded.
 */
export const VFARM_HEALTH_PROBE_TIMEOUT_MS = 3000;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface VfarmLiveClientConfig {
  /** Production/staging base URL, e.g. https://api.vfarm.bhanetwork.org */
  baseUrl: string;
  /** Value for the X-Farm-Key header. Optional when initializing for auth/discovery before key issuance. */
  apiKey?: string;
  /**
   * Bearer JWT used for endpoints that reject X-Farm-Key auth (e.g. the
   * organization-members endpoint). Optional; settable later via setApiToken.
   */
  apiToken?: string;
  /** Request timeout in ms (default 5000) */
  timeoutMs?: number;
  /** Overrideable fetch function for testing */
  fetchFn?: FetchFn;
}

export class VfarmHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VfarmHttpError';
  }
}

export class VfarmNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VfarmNetworkError';
  }
}

export class VfarmLiveClient {
  private readonly baseUrl: string;
  private apiKey: string;
  private apiToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(config: VfarmLiveClientConfig) {
    if (config.apiKey !== undefined && !config.apiKey.trim()) {
      throw new Error('Configuration error: VFARM_FARM_KEY is required for VfarmLiveClient');
    }
    // Strip trailing slash for consistent URL construction
    this.baseUrl = config.baseUrl ? config.baseUrl.replace(/\/$/, '') : VFARM_DEFAULT_BASE_URL;
    this.apiKey = (config.apiKey || '').trim();
    this.apiToken = (config.apiToken || '').trim();
    this.timeoutMs = config.timeoutMs ?? VFARM_DEFAULT_TIMEOUT_MS;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Bearer token used for endpoints that do NOT accept X-Farm-Key auth.
   * The organization-members endpoint is one of them: with only X-Farm-Key it
   * answers 401 "Missing authentication", so callers must send a JWT.
   */
  public setApiToken(apiToken: string): void {
    this.apiToken = (apiToken || '').trim();
  }

  public getApiToken(): string {
    return this.apiToken;
  }

  /**
   * Headers for endpoints that require bearer auth. Sends the Bearer token
   * (preferred) alongside X-Farm-Key, mirroring listFarms(): vFarm accepts
   * both, and some endpoints reject the farm key on its own.
   */
  private authHeaders(explicitToken?: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = (explicitToken || this.apiToken || '').trim();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (this.apiKey) {
      headers['X-Farm-Key'] = this.apiKey;
    }
    return headers;
  }

  public setApiKey(apiKey: string): void {
    this.apiKey = (apiKey || '').trim();
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  // ── Dynamic Auth, Discovery & Key Issuance ────────────────────────────────

  /**
   * Step 1: Authenticate admin user against POST /api/v1/auth/login.
   * Returns JWT access token for subsequent management operations.
   */
  async login(email: string, password: string): Promise<LoginResponse & { token: string }> {
    const url = `${this.baseUrl}/api/v1/auth/login`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ email, password }),
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new VfarmNetworkError(`Login network error: ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VfarmHttpError(res.status, `Login failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    const parsed = LoginResponseSchema.parse(data);
    const token = parsed.access_token || parsed.token || '';
    return { ...parsed, token };
  }

  /**
   * Step 2: Dynamic Farm Discovery via GET /api/v1/farms.
   * Supports Bearer JWT token or current X-Farm-Key authentication.
   */
  async listFarms(token?: string): Promise<FarmListResponse> {
    const url = `${this.baseUrl}/api/v1/farms?limit=1000`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    } else if (this.apiKey) {
      headers['X-Farm-Key'] = this.apiKey;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers, signal: controller.signal });
    } catch (err: any) {
      throw new VfarmNetworkError(`List farms network error: ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VfarmHttpError(res.status, `List farms failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return FarmListResponseSchema.parse(data);
  }

  /**
   * Step 3: On-demand Farm Key Issuance via POST /api/v1/tokens.
   * Requests a new raw_key for the given farm using Bearer JWT auth.
   */
  async issueFarmToken(
    params: { farmId: string; name?: string; expiresAt?: string | null },
    token: string,
  ): Promise<TokenCreatedResponse> {
    const url = `${this.baseUrl}/api/v1/tokens`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.trim()}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          farm_id: params.farmId,
          name: params.name || 'cst-admin-session',
          expires_at: params.expiresAt ?? null,
        }),
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new VfarmNetworkError(`Issue token network error: ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VfarmHttpError(res.status, `Issue token failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return TokenCreatedResponseSchema.parse(data);
  }

  // ── Internal request helper ───────────────────────────────────────────────

  private async request<T>(
    path: string,
    parseSchema: { parse: (data: unknown) => T },
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    if (!this.apiKey && !(extraHeaders && extraHeaders['Authorization'])) {
      throw new Error('Configuration error: X-Farm-Key is required for farm-scoped requests');
    }
    const url = `${this.baseUrl}${path}`;
    // Note: Authorization header carrying apiKey is intentionally not logged
    //
    // The bearer token is sent alongside X-Farm-Key (never instead of it), and
    // only when the caller did not already supply an explicit Authorization
    // header. Without this, every `request()`-based call — getFarm, getFarmHealth,
    // listAllDevices, listFarmZones, getFarmLayout, the readings/alerts helpers —
    // was limited to the single farm the API key is bound to; the live service
    // answers 403 "API key not valid for this farm" for any other, even though
    // the same request succeeds with a bearer JWT. This mirrors authHeaders(),
    // which already sends both, and an explicit caller token still wins.
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...(this.apiKey ? { 'X-Farm-Key': this.apiKey } : {}),
      ...(this.apiToken && !extraHeaders?.['Authorization']
        ? { 'Authorization': `Bearer ${this.apiToken}` }
        : {}),
      ...(extraHeaders || {}),
    };

    let res: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchFn(url, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      const msg = err?.name === 'AbortError'
        ? `vFarm request timed out after ${this.timeoutMs}ms: ${path}`
        : `vFarm network error: ${err?.message ?? String(err)}`;
      Logger.warn(msg);
      throw new VfarmNetworkError(msg);
    }

    if (!res.ok) {
      const msg = `vFarm HTTP ${res.status} from ${path}`;
      Logger.warn(msg);
      throw new VfarmHttpError(res.status, msg);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new VfarmNetworkError(`vFarm returned non-JSON body from ${path}`);
    }

    return parseSchema.parse(body);
  }

  // ── Farm role grants (authoritative farm access) ──────────────────────────

  /**
   * POST /api/v1/farms/grants
   * Grants a user a farm role. This is the AUTHORITATIVE way to give someone
   * farm access: vFarm owns farm membership, so the grant must be made
   * upstream, not in CST.
   *
   * Request body (verified against the deployed OpenAPI, `BulkGrantRequest`):
   *   { user_id: string, role_id: 'operator' | 'viewer', farm_ids: string[] }
   *
   * There is no farm-level `owner` role — `owner` is CST's mapping of the
   * ORGANISATION role `admin`.
   */
  async grantUserFarmRoles(
    userId: string,
    roleId: 'operator' | 'viewer',
    farmIds: string[],
    token?: string
  ): Promise<{ grants: unknown[]; total: number }> {
    const path = '/api/v1/farms/grants';
    return this.writeRequest(
      path,
      'POST',
      { user_id: userId, role_id: roleId, farm_ids: farmIds },
      this.authHeaders(token)
    );
  }

  /**
   * DELETE /api/v1/farms/grants
   * Revokes a user's access to the given farms.
   *
   * Request body (verified against the deployed OpenAPI, `BulkRevokeRequest`):
   *   { user_id: string, farm_ids: string[] }
   */
  async revokeUserFarmRoles(
    userId: string,
    farmIds: string[],
    token?: string
  ): Promise<{ grants: unknown[]; total: number }> {
    const path = '/api/v1/farms/grants';
    return this.writeRequest(
      path,
      'DELETE',
      { user_id: userId, farm_ids: farmIds },
      this.authHeaders(token)
    );
  }

  /**
   * Perform a write request against the vFarm API with a JSON body.
   *
   * Mirrors `request()` — same auth rules, same timeout, same error mapping —
   * but sends a verb and a body. The auth token is never logged.
   */
  private async writeRequest<T>(
    path: string,
    method: 'POST' | 'DELETE' | 'PATCH' | 'PUT',
    body: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    if (!this.apiKey && !(extraHeaders && extraHeaders['Authorization'])) {
      throw new Error('Configuration error: X-Farm-Key is required for farm-scoped requests');
    }
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'X-Farm-Key': this.apiKey } : {}),
      ...(this.apiToken && !extraHeaders?.['Authorization']
        ? { 'Authorization': `Bearer ${this.apiToken}` }
        : {}),
      ...(extraHeaders || {}),
    };

    let res: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchFn(url, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      const msg = err?.name === 'AbortError'
        ? `vFarm request timed out after ${this.timeoutMs}ms: ${method} ${path}`
        : `vFarm network error: ${err?.message ?? String(err)}`;
      Logger.warn(msg);
      throw new VfarmNetworkError(msg);
    }

    if (!res.ok) {
      const msg = `vFarm HTTP ${res.status} from ${method} ${path}`;
      Logger.warn(msg);
      throw new VfarmHttpError(res.status, msg);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      // A write may legitimately answer with no body.
      parsed = {};
    }
    return parsed as T;
  }

  // ── Organization members ──────────────────────────────────────────────────

  /**
   * GET /api/v1/organizations/{org_id}/users
   * Returns user_id, email, name, role, granted_by, granted_at.
   * Does NOT return phone/phone_e164/mobile.
   *
   * Requires bearer auth: with only X-Farm-Key vFarm answers 401.
   */
  async getOrgMembers(orgId: string, token?: string): Promise<OrgMemberResponse[]> {
    const path = `/api/v1/organizations/${encodeURIComponent(orgId)}/users`;
    const schema = { parse: (d: unknown) => {
      if (!Array.isArray(d)) throw new Error('Expected array from org members endpoint');
      return d.map((item) => OrgMemberResponseSchema.parse(item));
    }};
    return this.request(path, schema, this.authHeaders(token));
  }

  /**
   * GET /api/v1/users/{user_id}/farm-grants
   * Returns the list of farm_id grants for a given user.
   * Also bearer-authenticated; treated as best-effort by callers.
   */
  async getUserFarmGrants(userId: string, token?: string): Promise<GrantedFarmRow[]> {
    const path = `/api/v1/users/${encodeURIComponent(userId)}/farm-grants`;
    const raw = await this.request(path, { parse: (d: unknown) => d }, this.authHeaders(token));
    return normalizeFarmGrants(raw);
  }

  // ── Inventory (cabinet) ──────────────────────────────────────────────────

  /**
   * GET /api/v1/inventory/{serial_number}
   * Returns the authoritative inventory record including farm_id.
   * farm_id is the ONLY field used for authorization; never trust client-supplied farm_id.
   */
  async getInventory(serialNumber: string): Promise<InventoryResponse> {
    const path = `/api/v1/inventory/${encodeURIComponent(serialNumber)}`;
    return this.request(path, InventoryResponseSchema);
  }

  /**
   * GET /api/v1/inventory/{serial_number}/config
   * Returns serial_number, current (config_hash, name, spec_version, cad_revision, effective_at),
   * and history array.
   */
  async getUnitConfig(serialNumber: string): Promise<UnitConfigResponse> {
    const path = `/api/v1/inventory/${encodeURIComponent(serialNumber)}/config`;
    return this.request(path, UnitConfigResponseSchema);
  }

  /**
   * LM7W unit config — optional; returns null when disabled or upstream contract fails.
   */
  async tryGetUnitConfig(serialNumber: string): Promise<UnitConfigResponse | null> {
    if (process.env.VFARM_LM7W_CONFIG_ENABLED === 'false') {
      return null;
    }
    try {
      return await this.getUnitConfig(serialNumber);
    } catch (err) {
      Logger.warn(
        `vFarm: inventory config unavailable for serial=${serialNumber}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ── Farms & telemetry (live IoT read API) ─────────────────────────────────

  async getFarm(farmId: string): Promise<FarmResponse> {
    const path = `/api/v1/farms/${encodeURIComponent(farmId)}`;
    return this.request(path, FarmResponseSchema);
  }

  async getFarmHealth(farmId: string): Promise<FarmHealthResponse> {
    const path = `/api/v1/farms/${encodeURIComponent(farmId)}/health`;
    return this.request(path, FarmHealthResponseSchema);
  }

  async listDevices(farmId: string): Promise<DeviceListResponse> {
    const path = `/api/v1/devices?farm_id=${encodeURIComponent(farmId)}`;
    return this.request(path, DeviceListResponseSchema);
  }

  async getLatestReading(sensorId: string): Promise<LatestReadingResponse> {
    const path = `/api/v1/readings/latest?sensor_id=${encodeURIComponent(sensorId)}`;
    return this.request(path, LatestReadingResponseSchema);
  }

  async getReadings(sensorId: string, limit = 100): Promise<ReadingsListResponse> {
    const path =
      `/api/v1/readings?sensor_id=${encodeURIComponent(sensorId)}&limit=${encodeURIComponent(String(limit))}`;
    return this.request(path, ReadingsListResponseSchema);
  }

  async getReadingStats(sensorId: string, window = '24h'): Promise<StatsResponse> {
    const path =
      `/api/v1/readings/stats?sensor_id=${encodeURIComponent(sensorId)}&window=${encodeURIComponent(window)}`;
    return this.request(path, StatsResponseSchema);
  }

  /**
   * GET /api/v1/configs/{config_hash}
   * Returns the full config detail including parts BOM.
   * config_hash must match ^[0-9a-f]{64}$.
   */
  async getConfig(configHash: string): Promise<ConfigResponse> {
    if (!CONFIG_HASH_PATTERN.test(configHash)) {
      throw new Error(`Invalid config_hash format: ${configHash}`);
    }
    const path = `/api/v1/configs/${encodeURIComponent(configHash)}`;
    return this.request(path, ConfigResponseSchema);
  }

  // ── Dashboard & System ──────────────────────────────────────────────────

  /**
   * GET /api/v1/dashboard/summary
   * Returns a cross-farm summary object. Schema is inline ({}) in OpenAPI —
   * we passthrough all fields.
   */
  async getDashboardSummary(farmId?: string): Promise<Record<string, unknown>> {
    const qs = farmId ? `?farm_id=${encodeURIComponent(farmId)}` : '';
    return this.requestPassthrough(`/api/v1/dashboard/summary${qs}`);
  }

  /**
   * GET /api/v1/system/stats
   * Returns platform-wide stats. Schema inline ({}) — passthrough.
   *
   * Needs its own request budget. This endpoint scans every reading in the
   * platform, and measured live against bhavfarm1.duckdns.org on 2026-10-05 it
   * took 13.8s with a bearer token and 39.0s with only the farm key, versus
   * 234-777ms for /dashboard/summary on the same deployment. At the shared
   * VFARM_DEFAULT_TIMEOUT_MS of 5000 it therefore failed on every attempt,
   * every time — the 235ms p50 / 984ms max that justified the 5s default were
   * measured on other endpoints and never covered this one.
   *
   * The budget is deliberately long rather than tuned to the median: it is
   * called only from the admin panel's read-only live section
   * (admin/routes.ts:1011), never on the SMS hot path, so it does not feed the
   * retry multiplication that the tight default exists to bound. An operator who
   * needs a different ceiling should raise VFARM_API_TIMEOUT_MS, which still
   * wins for every other endpoint.
   */
  async getSystemStats(): Promise<Record<string, unknown>> {
    return this.requestPassthrough('/api/v1/system/stats', VFARM_SYSTEM_STATS_TIMEOUT_MS);
  }

  /**
   * GET /api/v1/health
   * Returns { status, db, version }.
   */
  async getApiHealth(): Promise<HealthResponse> {
    return this.request('/api/v1/health', healthResponseSchema);
  }

  // ── Organizations ───────────────────────────────────────────────────────

  /**
   * GET /api/v1/organizations
   * Returns OrgListResponse { organizations[], total }.
   * Requires Bearer JWT (org routes use JWT, not X-Farm-Key).
   */
  async listOrganizations(jwt?: string, timeoutMs?: number): Promise<OrgListResponse> {
    const url = `${this.baseUrl}/api/v1/organizations?limit=100`;
    return this.requestWithJwt(url, orgListResponseSchema, jwt, timeoutMs);
  }

  /**
   * GET /api/v1/organizations/{org_id}
   */
  async getOrganization(orgId: string, jwt?: string, timeoutMs?: number): Promise<OrgResponse> {
    const url = `${this.baseUrl}/api/v1/organizations/${encodeURIComponent(orgId)}`;
    return this.requestWithJwt(url, orgResponseSchema, jwt, timeoutMs);
  }

  /**
   * GET /api/v1/farms?org_id={org_id}
   * Returns farms scoped to a specific organization.
   */
  async listOrgFarms(orgId: string, jwt?: string): Promise<FarmListResponse> {
    const url = `${this.baseUrl}/api/v1/farms?org_id=${encodeURIComponent(orgId)}&limit=1000`;
    return this.requestWithJwt(url, FarmListResponseSchema, jwt);
  }

  // ── Farm Hierarchy ───────────────────────────────────────────────────────

  /**
   * GET /api/v1/farms/{farm_id}/layout
   * Returns full physical farm layout: zones → locations → sublocations.
   */
  async getFarmLayout(farmId: string): Promise<LayoutResponse> {
    return this.request(
      `/api/v1/farms/${encodeURIComponent(farmId)}/layout`,
      layoutResponseSchema,
    );
  }

  /**
   * GET /api/v1/farms/{farm_id}/zones
   */
  async listFarmZones(farmId: string): Promise<ZoneResponse[]> {
    const schema = {
      parse: (d: unknown) => {
        if (!Array.isArray(d)) throw new Error('Expected array from zones endpoint');
        return d.map((item) => zoneResponseSchema.parse(item));
      },
    };
    return this.request(
      `/api/v1/farms/${encodeURIComponent(farmId)}/zones`,
      schema,
    );
  }

  // ── Devices (extended) ───────────────────────────────────────────────────

  /**
   * GET /api/v1/devices?farm_id={farm_id}&limit=500
   * All devices for a farm — full DeviceListResponse.
   */
  async listAllDevices(farmId: string, limit = 500): Promise<DeviceListResponse> {
    return this.request(
      `/api/v1/devices?farm_id=${encodeURIComponent(farmId)}&limit=${limit}`,
      DeviceListResponseSchema,
    );
  }

  /**
   * GET /api/v1/devices/offline?farm_id={farm_id}
   */
  async listOfflineDevices(farmId: string): Promise<DeviceListResponse> {
    return this.request(
      `/api/v1/devices/offline?farm_id=${encodeURIComponent(farmId)}`,
      DeviceListResponseSchema,
    );
  }

  /**
   * GET /api/v1/devices/unhealthy?farm_id={farm_id}
   */
  async listUnhealthyDevices(farmId: string): Promise<DeviceListResponse> {
    return this.request(
      `/api/v1/devices/unhealthy?farm_id=${encodeURIComponent(farmId)}`,
      DeviceListResponseSchema,
    );
  }

  /**
   * GET /api/v1/devices/{device_id}
   */
  async getDevice(deviceId: string): Promise<DeviceResponse> {
    return this.request(
      `/api/v1/devices/${encodeURIComponent(deviceId)}`,
      deviceResponseSchema,
    );
  }

  /**
   * GET /api/v1/devices/{device_id}/rollup
   */
  async getDeviceRollup(deviceId: string): Promise<DeviceRollupResponse> {
    return this.request(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/rollup`,
      deviceRollupResponseSchema,
    );
  }

  // ── Readings (extended) ──────────────────────────────────────────────────

  /**
   * GET /api/v1/readings/latest?sensor_id={device_id}
   * Latest readings across all sensors in a farm.
   *
   * The vFarm API requires `sensor_id` (not `farm_id`) for the readings/latest
   * endpoint. We first list devices for the farm, then fetch the latest reading
   * for each device in parallel (bounded concurrency to avoid overwhelming
   * the upstream).
   *
   * Per-sensor failure classification:
   * - 404 → `no_reading` (legitimate; sensor exists but has no readings)
   * - 401/403 → `unauthorized` (needs token refresh)
   * - 422 → `invalid_request` (caller bug)
   * - 5xx → `upstream_error`
   * - timeout → `timeout`
   * - network error → `upstream_error`
   *
   * Successful readings are returned in the result array. Failures are logged
   * with appropriate severity but do not block other sensors from returning
   * their readings.
   */
  async listLatestReadings(farmId: string, limit = 100, timeoutMs?: number): Promise<LatestReadingResponse[]> {
    const perDeviceTimeout = timeoutMs ?? this.timeoutMs;
    // 1. List devices for the farm
    const deviceList = await this.listAllDevices(farmId, limit);
    const devices = (deviceList as any)?.devices ?? [];
    if (!Array.isArray(devices) || devices.length === 0) {
      return [];
    }

    // 2. Fetch latest reading for each device (bounded concurrency: 5 at a time)
    const CONCURRENCY = 5;
    const results: LatestReadingResponse[] = [];
    for (let i = 0; i < devices.length; i += CONCURRENCY) {
      const batch = devices.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (dev: any) => {
          const sensorId = dev.id;
          if (!sensorId) return null;
          try {
            // Use a per-device client with the requested timeout
            const client = new VfarmLiveClient({
              baseUrl: this.baseUrl,
              apiKey: this.apiKey,
              apiToken: this.apiToken,
              timeoutMs: perDeviceTimeout,
              fetchFn: this.fetchFn,
            });
            return await client.getLatestReading(sensorId);
          } catch (err: any) {
            // Classify the per-sensor failure for observability.
            const status = err?.status;
            if (status === 404) {
              Logger.info(
                `vFarm per-sensor: sensor ${sensorId} returned no readings (404)`,
                { sensor_id: sensorId, farm_id: farmId, category: 'no_reading' },
              );
            } else if (status === 401 || status === 403) {
              Logger.warn(
                `vFarm per-sensor: sensor ${sensorId} unauthorized (auth/token issue)`,
                { sensor_id: sensorId, farm_id: farmId, category: 'unauthorized', http_status: status },
              );
            } else if (status === 422) {
              Logger.error(
                `vFarm per-sensor: sensor ${sensorId} returned 422 (invalid request)`,
                { sensor_id: sensorId, farm_id: farmId, category: 'invalid_request', http_status: status },
              );
            } else if (status !== undefined && status >= 500) {
              Logger.warn(
                `vFarm per-sensor: sensor ${sensorId} upstream error (${status})`,
                { sensor_id: sensorId, farm_id: farmId, category: 'upstream_error', http_status: status },
              );
            } else if (err?.name === 'VfarmNetworkError' && /timed out/i.test(err?.message || '')) {
              Logger.warn(
                `vFarm per-sensor: sensor ${sensorId} timed out after ${perDeviceTimeout}ms`,
                { sensor_id: sensorId, farm_id: farmId, category: 'timeout' },
              );
            } else {
              // Network error, unexpected status, or non-JSON body
              Logger.warn(
                `vFarm per-sensor: sensor ${sensorId} failed (${err?.name || 'error'})`,
                { sensor_id: sensorId, farm_id: farmId, category: 'upstream_error' },
              );
            }
            // No readings for this sensor — skip (return null)
            return null;
          }
        }),
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled' && r.value) {
          results.push(r.value);
        }
      }
    }
    return results;
  }

  // ── Alerts ───────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/alerts/threshold/counts?farm_id={farm_id}
   * PlaceCountListResponse { counts[] }.
   */
  async getAlertCounts(farmId: string): Promise<PlaceCountListResponse> {
    return this.request(
      `/api/v1/alerts/threshold/counts?farm_id=${encodeURIComponent(farmId)}`,
      placeCountListResponseSchema,
    );
  }

  /**
   * GET /api/v1/alerts/threshold/open?farm_id={farm_id}
   * OpenAlertListResponse { alerts[], total }.
   */
  async listOpenAlerts(farmId: string, limit = 100): Promise<OpenAlertListResponse> {
    return this.request(
      `/api/v1/alerts/threshold/open?farm_id=${encodeURIComponent(farmId)}&limit=${limit}`,
      openAlertListResponseSchema,
    );
  }

  /**
   * GET /api/v1/alerts/history?farm_id={farm_id}
   * AlertHistoryListResponse { alerts[], total }.
   */
  async listAlertHistory(farmId: string, limit = 50): Promise<AlertHistoryListResponse> {
    return this.request(
      `/api/v1/alerts/history?farm_id=${encodeURIComponent(farmId)}&limit=${limit}`,
      alertHistoryListResponseSchema,
    );
  }

  // ── Vision ───────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/vision/images/latest?farm_id={farm_id}
   * Returns the latest ImageAnalysis for the farm.
   */
  async getLatestVisionImage(farmId: string): Promise<ImageAnalysis> {
    return this.request(
      `/api/v1/vision/images/latest?farm_id=${encodeURIComponent(farmId)}`,
      imageAnalysisSchema,
    );
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  /**
   * Like request() but skips Zod parsing — used for inline-schema ({}) endpoints
   * where the response shape is not enumerated in the OpenAPI spec.
   *
   * Sends the same two credentials as request(). It previously sent only
   * X-Farm-Key, so getDashboardSummary() and getSystemStats() — the only two
   * callers — had no bearer fallback and would fail 403 "API key not valid for
   * this farm" against any farm the key is not bound to, even though the same
   * request succeeds with a bearer JWT. They also do not require a farm key:
   * neither endpoint is farm-scoped, so demanding one rejected a bearer-only
   * configuration outright.
   */
  private async requestPassthrough(
    path: string,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    if (!this.apiKey && !this.apiToken) {
      throw new Error(
        'Configuration error: X-Farm-Key or a bearer token is required for vFarm requests',
      );
    }
    const budget = timeoutMs ?? this.timeoutMs;
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...(this.apiKey ? { 'X-Farm-Key': this.apiKey } : {}),
      ...(this.apiToken ? { 'Authorization': `Bearer ${this.apiToken}` } : {}),
    };
    let res: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), budget);
      try {
        res = await this.fetchFn(url, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      const msg = err?.name === 'AbortError'
        ? `vFarm request timed out after ${budget}ms: ${path}`
        : `vFarm network error: ${err?.message ?? String(err)}`;
      Logger.warn(msg);
      throw new VfarmNetworkError(msg);
    }
    if (!res.ok) {
      const msg = `vFarm HTTP ${res.status} from ${path}`;
      Logger.warn(msg);
      throw new VfarmHttpError(res.status, msg);
    }
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new VfarmNetworkError(`vFarm returned non-JSON body from ${path}`);
    }
  }

  /**
   * Make a request with Bearer JWT instead of X-Farm-Key.
   * Used for org-scoped endpoints that require JWT auth.
   *
   * `timeoutMs` overrides the client-wide request budget for a single call.
   * It is used by the health probe, which must stay strictly bounded.
   *
   * The upstream response BODY is never included in the thrown error: an
   * upstream error body can echo back internal detail or credential material,
   * and a health probe must not be able to leak it into a log line.
   */
  private async requestWithJwt<T>(
    url: string,
    parseSchema: { parse: (data: unknown) => T },
    jwt?: string,
    timeoutMs?: number,
  ): Promise<T> {
    const token = jwt || '';
    const budget = timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (this.apiKey) {
      headers['X-Farm-Key'] = this.apiKey;
    }
    let res: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), budget);
      try {
        res = await this.fetchFn(url, { headers, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err: any) {
      throw new VfarmNetworkError(`vFarm network error: ${err?.message ?? String(err)}`);
    }
    if (!res.ok) {
      throw new VfarmHttpError(res.status, `vFarm HTTP ${res.status} from ${url}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new VfarmNetworkError(`vFarm returned non-JSON body from ${url}`);
    }
    return parseSchema.parse(body);
  }
}
