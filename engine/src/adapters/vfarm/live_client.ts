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
  CONFIG_HASH_PATTERN,
  type OrgMemberResponse,
  type GrantedFarmRow,
  type InventoryResponse,
  type UnitConfigResponse,
  type ConfigResponse,
} from './schemas.js';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface VfarmLiveClientConfig {
  /** Production/staging base URL, e.g. https://api.vfarm.bhanetwork.org */
  baseUrl: string;
  /** Value for the X-Farm-Key header. Never logged. */
  apiKey: string;
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
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(config: VfarmLiveClientConfig) {
    // Strip trailing slash for consistent URL construction
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.fetchFn = config.fetchFn ?? fetch;
  }

  // ── Internal request helper ───────────────────────────────────────────────

  private async request<T>(path: string, parseSchema: { parse: (data: unknown) => T }): Promise<T> {
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
