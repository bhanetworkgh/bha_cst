export type FarmHealthStatus = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';

export type FarmHealthStaleness =
  | 'fresh'
  | 'stale'
  | 'unavailable_no_timestamp'
  | 'unavailable_no_threshold'
  | 'invalid_timestamp'
  | 'future_timestamp';

export interface FarmHealthInput {
  status?: unknown;
  health_score?: unknown;
}

export interface NormalizeFarmHealthOptions {
  /** The upstream request failed; this is distinct from a missing health value. */
  upstreamError?: boolean;
  /**
   * Optional contract-supplied source timestamp. The live vFarm contract does
   * not currently identify one, so production callers must not invent it.
   */
  sourceTimestamp?: string | null;
  /** Evaluation clock, injectable for deterministic contract tests. */
  nowMs?: number;
  /**
   * Explicit freshness budget supplied by an approved contract. No default is
   * assumed: the five-minute device-presence rule is not a farm-health rule.
   */
  maxAgeMs?: number;
}

export interface NormalizedFarmHealth {
  status: FarmHealthStatus;
  raw_status: string | null;
  health_score: number | null;
  staleness_evaluation: FarmHealthStaleness;
  reason:
    | 'upstream_healthy'
    | 'upstream_unhealthy'
    | 'missing_response'
    | 'missing_status'
    | 'malformed_status'
    | 'unrecognized_status'
    | 'upstream_error'
    | 'stale'
    | 'invalid_timestamp'
    | 'future_timestamp';
}

/** Only the two documented CST pass-through states are considered valid. */
export function mapFarmHealthStatus(raw: unknown): FarmHealthStatus {
  if (raw === 'healthy') return 'healthy';
  if (raw === 'unhealthy') return 'unhealthy';
  if (raw === null || raw === undefined) return 'unknown';
  return 'degraded';
}

/**
 * Normalize authoritative vFarm health without deriving it from API
 * reachability, device/relay state, health scores, or sensor readings.
 */
export function normalizeFarmHealth(
  upstream: FarmHealthInput | null | undefined,
  options: NormalizeFarmHealthOptions = {},
): NormalizedFarmHealth {
  const rawStatus = typeof upstream?.status === 'string' ? upstream.status : null;
  const healthScore = typeof upstream?.health_score === 'number' && Number.isFinite(upstream.health_score)
    ? upstream.health_score
    : null;

  let status: FarmHealthStatus;
  let reason: NormalizedFarmHealth['reason'];
  if (options.upstreamError) {
    status = 'degraded';
    reason = 'upstream_error';
  } else if (!upstream) {
    status = 'unknown';
    reason = 'missing_response';
  } else if (upstream.status === null || upstream.status === undefined) {
    status = 'unknown';
    reason = 'missing_status';
  } else if (typeof upstream.status !== 'string') {
    status = 'degraded';
    reason = 'malformed_status';
  } else {
    status = mapFarmHealthStatus(rawStatus);
    reason = status === 'healthy'
      ? 'upstream_healthy'
      : status === 'unhealthy'
        ? 'upstream_unhealthy'
        : 'unrecognized_status';
  }

  let staleness: FarmHealthStaleness = 'unavailable_no_timestamp';
  if (options.sourceTimestamp !== undefined && options.sourceTimestamp !== null) {
    const sourceMs = Date.parse(options.sourceTimestamp);
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(sourceMs)) {
      staleness = 'invalid_timestamp';
      status = 'degraded';
      reason = 'invalid_timestamp';
    } else if (sourceMs > nowMs) {
      staleness = 'future_timestamp';
      status = 'degraded';
      reason = 'future_timestamp';
    } else if (options.maxAgeMs === undefined) {
      staleness = 'unavailable_no_threshold';
    } else if (nowMs - sourceMs > options.maxAgeMs) {
      staleness = 'stale';
      status = 'degraded';
      reason = 'stale';
    } else {
      staleness = 'fresh';
    }
  }

  return {
    status,
    raw_status: rawStatus,
    health_score: healthScore,
    staleness_evaluation: staleness,
    reason,
  };
}
