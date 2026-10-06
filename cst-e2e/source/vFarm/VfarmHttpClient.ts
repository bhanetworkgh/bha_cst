import { Logger } from '../../config/logger.js';
// Shared with VfarmLiveClient so one unset VFARM_API_TIMEOUT_MS cannot produce
// two different abort deadlines for the same upstream. See the constant's docs.
import { VFARM_DEFAULT_TIMEOUT_MS } from './live_client.js';
import {
  orgMemberListSchema,
  farmUserListSchema,
  normalizeFarmGrants,
  inventoryItemSchema,
  unitConfigResponseSchema,
  configResponseSchema,
  CONFIG_HASH_RE,
  OrgMember,
  FarmUser,
  FarmGrant,
  InventoryItem,
  UnitConfigResponse,
  ConfigResponse,
} from './schemas.js';

/**
 * Categorized error thrown by VfarmHttpClient. `category` lets callers map
 * upstream failures onto CST's existing fail-closed/degraded conventions
 * without leaking raw upstream error bodies or headers to customers.
 */
export type VfarmErrorCategory =
  | 'auth'        // 401 / 403
  | 'not_found'   // 404
  | 'rate_limited'// 429
  | 'upstream'    // 4xx/5xx otherwise
  | 'network'     // fetch threw (DNS, connection reset, etc.)
  | 'timeout'     // request exceeded the configured timeout
  | 'invalid_response'; // non-JSON body or failed schema validation

export class VfarmApiError extends Error {
  readonly category: VfarmErrorCategory;
  readonly status?: number;

  constructor(category: VfarmErrorCategory, message: string, status?: number) {
    super(message);
    this.name = 'VfarmApiError';
    this.category = category;
    this.status = status;
  }
}

export interface VfarmHttpClientOptions {
  /** e.g. https://bhavfarm1.duckdns.org (dev) or https://api.vfarm.bhanetwork.org (prod). Never hardcoded. */
  baseUrl: string;
  /** Sent as `X-Farm-Key`. */
  apiKey?: string;
  /** Sent as `Authorization: Bearer <token>` when the selected endpoint requires bearer/JWT auth. */
  apiToken?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = VFARM_DEFAULT_TIMEOUT_MS;

/**
 * Small authenticated HTTP client for the verified vFarm REST endpoints.
 * Handles base URL, auth headers, timeout, status mapping, JSON parsing and
 * schema validation. Never logs secret header values.
 */
export class VfarmHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiToken?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: VfarmHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn || fetch;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) headers['X-Farm-Key'] = this.apiKey;
    if (this.apiToken) headers['Authorization'] = `Bearer ${this.apiToken}`;
    return headers;
  }

  /**
   * Perform a GET request against the vFarm API with a bounded timeout.
   * Never includes header values in thrown error messages or logs.
   */
  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.name === 'AbortError') {
        Logger.warn(`vFarm HTTP timeout after ${this.timeoutMs}ms: GET ${path}`);
        throw new VfarmApiError('timeout', `vFarm request timed out after ${this.timeoutMs}ms`);
      }
      Logger.warn(`vFarm HTTP network error: GET ${path} — ${err?.message || 'unknown error'}`);
      throw new VfarmApiError('network', 'vFarm request failed (network error)');
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const status = response.status;
      // Never log/expose response body — it may echo back auth headers or internal details.
      if (status === 401 || status === 403) {
        Logger.warn(`vFarm HTTP auth error ${status}: GET ${path}`);
        throw new VfarmApiError('auth', 'vFarm authentication/authorization failed', status);
      }
      if (status === 404) {
        throw new VfarmApiError('not_found', 'vFarm resource not found', status);
      }
      if (status === 429) {
        Logger.warn(`vFarm HTTP rate limited: GET ${path}`);
        throw new VfarmApiError('rate_limited', 'vFarm rate limit exceeded', status);
      }
      Logger.warn(`vFarm HTTP error ${status}: GET ${path}`);
      throw new VfarmApiError('upstream', `vFarm upstream error (${status})`, status);
    }

    try {
      return await response.json();
    } catch {
      throw new VfarmApiError('invalid_response', 'vFarm returned a non-JSON response');
    }
  }

  async listOrganizationMembers(orgId: string): Promise<OrgMember[]> {
    const raw = await this.get(`/api/v1/organizations/${encodeURIComponent(orgId)}/users`);
    const parsed = orgMemberListSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(`vFarm schema validation failed: organizations/${orgId}/users`);
      throw new VfarmApiError('invalid_response', 'vFarm organization-members response failed schema validation');
    }
    return parsed.data;
  }

  /**
   * Best-effort: the exact response shape for this endpoint was not fully
   * enumerated in the verified handoff. Only `user_id`/`role` are relied on;
   * anything else is passed through unvalidated.
   */
  async listFarmUsers(farmId: string): Promise<FarmUser[]> {
    const raw = await this.get(`/api/v1/farms/${encodeURIComponent(farmId)}/users`);
    const parsed = farmUserListSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(`vFarm schema validation failed: farms/${farmId}/users`);
      throw new VfarmApiError('invalid_response', 'vFarm farm-users response failed schema validation');
    }
    return parsed.data;
  }

  /**
   * Best-effort: same caveat as listFarmUsers — shape not fully verified.
   * Only `farm_id` is relied upon by callers.
   */
  async getUserFarmGrants(userId: string): Promise<FarmGrant[]> {
    const raw = await this.get(`/api/v1/users/${encodeURIComponent(userId)}/farm-grants`);
    try {
      return normalizeFarmGrants(raw);
    } catch {
      Logger.warn(`vFarm schema validation failed: users/${userId}/farm-grants`);
      throw new VfarmApiError('invalid_response', 'vFarm farm-grants response failed schema validation');
    }
  }

  async getInventoryItem(serialNumber: string): Promise<InventoryItem> {
    const raw = await this.get(`/api/v1/inventory/${encodeURIComponent(serialNumber)}`);
    const parsed = inventoryItemSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(`vFarm schema validation failed: inventory/${serialNumber}`);
      throw new VfarmApiError('invalid_response', 'vFarm inventory response failed schema validation');
    }
    return parsed.data;
  }

  async getUnitConfig(serialNumber: string): Promise<UnitConfigResponse> {
    const raw = await this.get(`/api/v1/inventory/${encodeURIComponent(serialNumber)}/config`);
    const parsed = unitConfigResponseSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(`vFarm schema validation failed: inventory/${serialNumber}/config`);
      throw new VfarmApiError('invalid_response', 'vFarm unit-config response failed schema validation');
    }
    return parsed.data;
  }

  async getConfig(configHash: string): Promise<ConfigResponse> {
    if (!CONFIG_HASH_RE.test(configHash)) {
      throw new VfarmApiError('invalid_response', 'config_hash failed local format validation');
    }
    const raw = await this.get(`/api/v1/configs/${encodeURIComponent(configHash)}`);
    const parsed = configResponseSchema.safeParse(raw);
    if (!parsed.success) {
      Logger.warn(`vFarm schema validation failed: configs/${configHash}`);
      throw new VfarmApiError('invalid_response', 'vFarm config-detail response failed schema validation');
    }
    return parsed.data;
  }
}
