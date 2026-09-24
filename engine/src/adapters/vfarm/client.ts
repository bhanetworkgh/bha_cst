/**
 * Minimal reusable HTTP client for the verified vFarm Management API
 * (https://bhavfarm1.duckdns.org/openapi.json). Pure HTTP plumbing only —
 * no farm-scope authorization, no mapping, no persistence. That logic lives
 * in the vFarm tenant adapter, which is the only caller of this client.
 *
 * Auth (verified contract):
 *   Authorization: Bearer <JWT>   — org/user/farm management APIs
 *   X-Farm-Key: <key>             — farm/device ingestion-style APIs
 * Both headers are sent whenever the corresponding credential is configured;
 * which one a given endpoint actually requires is documented per-method below.
 */

export class VfarmApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'VfarmApiError';
    this.status = status;
  }
}

export interface VfarmApiClientConfig {
  /** Base URL only — e.g. https://bhavfarm1.duckdns.org (dev) or https://api.vfarm.bhanetwork.org (prod). Never hardcoded here. */
  baseUrl: string;
  /** Authorization: Bearer <jwt> */
  jwt?: string;
  /** X-Farm-Key: <farmKey> */
  farmKey?: string;
  timeoutMs?: number;
}

/** Narrow interface so tests can inject a fake without touching the network. */
export interface IVfarmApiClient {
  getOrgUsers(orgId: string): Promise<unknown>;
  getInventoryItem(serialNumber: string): Promise<unknown>;
  getInventoryConfig(serialNumber: string): Promise<unknown>;
  getConfigByHash(configHash: string): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 8000;

export class VfarmApiClient implements IVfarmApiClient {
  private readonly baseUrl: string;
  private readonly jwt?: string;
  private readonly farmKey?: string;
  private readonly timeoutMs: number;

  constructor(config: VfarmApiClientConfig) {
    if (!config.baseUrl) {
      throw new Error('VfarmApiClient requires a baseUrl');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.jwt = config.jwt;
    this.farmKey = config.farmKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.jwt) headers['Authorization'] = `Bearer ${this.jwt}`;
    if (this.farmKey) headers['X-Farm-Key'] = this.farmKey;
    return headers;
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch (err: any) {
      throw new VfarmApiError(`vFarm API request to ${path} failed: ${err?.message || 'network error'}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new VfarmApiError(`vFarm API ${path} returned HTTP ${response.status}`, response.status);
    }

    try {
      return await response.json();
    } catch {
      throw new VfarmApiError(`vFarm API ${path} returned a non-JSON / malformed response`);
    }
  }

  /** GET /api/v1/organizations/{org_id}/users — Authorization: Bearer <JWT> */
  async getOrgUsers(orgId: string): Promise<unknown> {
    return this.get(`/api/v1/organizations/${encodeURIComponent(orgId)}/users`);
  }

  /** GET /api/v1/inventory/{serial_number} — establishes farm_id / org_id / status */
  async getInventoryItem(serialNumber: string): Promise<unknown> {
    return this.get(`/api/v1/inventory/${encodeURIComponent(serialNumber)}`);
  }

  /** GET /api/v1/inventory/{serial_number}/config — current + history config pointers */
  async getInventoryConfig(serialNumber: string): Promise<unknown> {
    return this.get(`/api/v1/inventory/${encodeURIComponent(serialNumber)}/config`);
  }

  /** GET /api/v1/configs/{config_hash} — config_hash must already match ^[0-9a-f]{64}$ */
  async getConfigByHash(configHash: string): Promise<unknown> {
    return this.get(`/api/v1/configs/${encodeURIComponent(configHash)}`);
  }
}