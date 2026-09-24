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
  BulkGrantResponseSchema,
  InventoryResponseSchema,
  UnitConfigResponseSchema,
  ConfigResponseSchema,
  FarmResponseSchema,
  FarmListResponseSchema,
  LoginResponseSchema,
  TokenCreatedResponseSchema,
  TokenResponseSchema,
  FarmHealthResponseSchema,
  DeviceListResponseSchema,
  LatestReadingResponseSchema,
  ReadingsListResponseSchema,
  StatsResponseSchema,
  CONFIG_HASH_PATTERN,
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
  type LatestReadingResponse,
  type ReadingsListResponse,
  type StatsResponse,
} from './schemas.js';

export const VFARM_DEFAULT_BASE_URL = 'https://bhavfarm1.duckdns.org';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface VfarmLiveClientConfig {
  /** Production/staging base URL, e.g. https://api.vfarm.bhanetwork.org */
  baseUrl: string;
  /** Value for the X-Farm-Key header. Optional when initializing for auth/discovery before key issuance. */
  apiKey?: string;
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
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(config: VfarmLiveClientConfig) {
    if (config.apiKey !== undefined && !config.apiKey.trim()) {
      throw new Error('Configuration error: VFARM_FARM_KEY is required for VfarmLiveClient');
    }
    // Strip trailing slash for consistent URL construction
    this.baseUrl = config.baseUrl ? config.baseUrl.replace(/\/$/, '') : VFARM_DEFAULT_BASE_URL;
    this.apiKey = (config.apiKey || '').trim();
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.fetchFn = config.fetchFn ?? fetch;
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

  private async request<T>(path: string, parseSchema: { parse: (data: unknown) => T }): Promise<T> {
    if (!this.apiKey) {
      throw new Error('Configuration error: X-Farm-Key is required for farm-scoped requests');
    }
    const url = `${this.baseUrl}${path}`;
    // Note: Authorization header carrying apiKey is intentionally not logged
    const headers: Record<string, string> = {
      'X-Farm-Key': this.apiKey,
      'Accept': 'application/json',
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

  // ── Organization members ──────────────────────────────────────────────────

  /**
   * GET /api/v1/organizations/{org_id}/users
   * Returns user_id, email, name, role, granted_by, granted_at.
   * Does NOT return phone/phone_e164/mobile.
   */
  async getOrgMembers(orgId: string): Promise<OrgMemberResponse[]> {
    const path = `/api/v1/organizations/${encodeURIComponent(orgId)}/users`;
    const schema = { parse: (d: unknown) => {
      if (!Array.isArray(d)) throw new Error('Expected array from org members endpoint');
      return d.map((item) => OrgMemberResponseSchema.parse(item));
    }};
    return this.request(path, schema);
  }

  /**
   * GET /api/v1/users/{user_id}/farm-grants
   * Returns the list of farm_id grants for a given user.
   */
  async getUserFarmGrants(userId: string): Promise<GrantedFarmRow[]> {
    const path = `/api/v1/users/${encodeURIComponent(userId)}/farm-grants`;
    const parsed = await this.request(path, BulkGrantResponseSchema);
    return parsed.grants;
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
}
