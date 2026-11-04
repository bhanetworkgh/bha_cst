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
  calculated_at?: unknown;
}

export interface NormalizeFarmHealthOptions {
  /** The upstream request failed; this is distinct from a missing health value. */
  upstreamError?: boolean;
  /**
   * Optional contract-supplied source timestamp. When omitted, candidate timestamp
   * is resolved from upstream.calculated_at.
   */
  sourceTimestamp?: string | null;
  /** Evaluation clock, injectable for deterministic contract tests. */
  nowMs?: number;
  /**
   * Explicit freshness budget supplied by an approved contract.
   * Defaults to 3,600,000ms (1 hour) per Contract v1.1.1 (Section 5).
   */
  maxAgeMs?: number;
}

export interface NormalizedFarmHealth {
  status: FarmHealthStatus;
  raw_status: string | null;
  health_score: number | null;
  calculated_at: string | null;
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

  // Resolve source timestamp from options or upstream.calculated_at
  const candidateTimestamp = options.sourceTimestamp !== undefined
    ? options.sourceTimestamp
    : (typeof (upstream as any)?.calculated_at === 'string' ? (upstream as any).calculated_at : null);

  let staleness: FarmHealthStaleness = 'unavailable_no_timestamp';
  if (candidateTimestamp !== undefined && candidateTimestamp !== null) {
    const sourceMs = Date.parse(candidateTimestamp);
    const nowMs = options.nowMs ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? 3_600_000; // 1 hour per Contract v1.1.1
    if (!Number.isFinite(sourceMs)) {
      staleness = 'invalid_timestamp';
      status = 'degraded';
      reason = 'invalid_timestamp';
    } else if (sourceMs > nowMs) {
      staleness = 'future_timestamp';
      status = 'degraded';
      reason = 'future_timestamp';
    } else if (options.maxAgeMs === undefined && options.sourceTimestamp !== undefined) {
      staleness = 'unavailable_no_threshold';
    } else if (nowMs - sourceMs > maxAgeMs) {
      staleness = 'stale';
      status = 'degraded';
      reason = 'stale';
    } else {
      staleness = 'fresh';
    }
  } else {
    // Missing freshness evidence: per Contract v1.1.1 (Section 4.1), missing or null
    // calculated_at triggers staleness_evaluation: "unavailable_no_timestamp" and cannot
    // be represented as confirmed healthy.
    staleness = 'unavailable_no_timestamp';
    if (status === 'healthy') {
      status = 'degraded';
      reason = 'unrecognized_status';
    }
  }

  return {
    status,
    raw_status: rawStatus,
    health_score: healthScore,
    calculated_at: candidateTimestamp ?? null,
    staleness_evaluation: staleness,
    reason,
  };
}
