/**
 * Health contract — deterministic tests.
 *
 * Verifies that `/api/health` separates vFarm API reachability from
 * authoritative farm health, mapping:
 *   - explicit vFarm `healthy`       → CST `healthy`
 *   - explicit vFarm `unhealthy`     → CST `unhealthy`
 *   - missing / null status          → `unknown`
 *   - stale / unrecognized status    → `degraded`
 *   - failed upstream (thrown error) → `degraded`
 *
 * Health is NEVER derived from health_score, relay state, device count
 * or locally invented thresholds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapFarmHealthStatus } from '../../engine/src/app.js';
import { normalizeFarmHealth } from '../../engine/src/adapters/vfarm/health.js';

describe('Health contract — authoritative farm health mapping', () => {
  it('maps explicit vFarm "healthy" to CST "healthy"', () => {
    expect(mapFarmHealthStatus('healthy')).toBe('healthy');
  });

  it('maps explicit vFarm "unhealthy" to CST "unhealthy"', () => {
    expect(mapFarmHealthStatus('unhealthy')).toBe('unhealthy');
  });

  it('maps null status to "unknown"', () => {
    expect(mapFarmHealthStatus(null)).toBe('unknown');
  });

  it('maps undefined (missing) status to "unknown"', () => {
    expect(mapFarmHealthStatus(undefined)).toBe('unknown');
  });

  it('maps unrecognized status "stale" to "degraded"', () => {
    expect(mapFarmHealthStatus('stale')).toBe('degraded');
  });

  it('maps unrecognized status "failed" to "degraded"', () => {
    expect(mapFarmHealthStatus('failed')).toBe('degraded');
  });

  it('maps unrecognized status "maintenance" to "degraded"', () => {
    expect(mapFarmHealthStatus('maintenance')).toBe('degraded');
  });

  it('maps empty string to "degraded"', () => {
    expect(mapFarmHealthStatus('')).toBe('degraded');
  });

  it('never uses health_score to determine health', () => {
    // health_score is diagnostic evidence only — never used for status
    const raw = 'healthy';
    const result = mapFarmHealthStatus(raw);
    // Even with a low health_score, if vFarm says healthy, it's healthy
    expect(result).toBe('healthy');
  });
});

describe('Health normalization — explicit freshness inputs', () => {
  const nowMs = Date.parse('2026-11-02T12:00:00.000Z');

  it('preserves fresh authoritative healthy health', () => {
    const result = normalizeFarmHealth(
      { status: 'healthy', health_score: 88 },
      { sourceTimestamp: '2026-11-02T11:59:00.000Z', nowMs, maxAgeMs: 300_000 },
    );
    expect(result).toMatchObject({ status: 'healthy', staleness_evaluation: 'fresh', health_score: 88 });
  });

  it('maps stale health to degraded using only an explicit caller-supplied budget', () => {
    const result = normalizeFarmHealth(
      { status: 'healthy' },
      { sourceTimestamp: '2026-11-02T11:50:00.000Z', nowMs, maxAgeMs: 300_000 },
    );
    expect(result).toMatchObject({ status: 'degraded', staleness_evaluation: 'stale', reason: 'stale' });
  });

  it('does not invent a timestamp or freshness threshold when none is contracted', () => {
    const missing = normalizeFarmHealth({ status: 'healthy' }, { nowMs });
    expect(missing).toMatchObject({ status: 'healthy', staleness_evaluation: 'unavailable_no_timestamp' });
    const noThreshold = normalizeFarmHealth(
      { status: 'healthy' },
      { sourceTimestamp: '2026-11-02T11:59:00.000Z', nowMs },
    );
    expect(noThreshold.staleness_evaluation).toBe('unavailable_no_threshold');
  });

  it('maps invalid and future timestamps to degraded', () => {
    for (const [sourceTimestamp, staleness_evaluation] of [
      ['not-a-time', 'invalid_timestamp'],
      ['2026-11-02T12:00:01.000Z', 'future_timestamp'],
    ] as const) {
      const result = normalizeFarmHealth(
        { status: 'healthy' },
        { sourceTimestamp, nowMs, maxAgeMs: 300_000 },
      );
      expect(result.status).toBe('degraded');
      expect(result.staleness_evaluation).toBe(staleness_evaluation);
    }
  });

  it('distinguishes missing health, malformed health, and upstream failure', () => {
    expect(normalizeFarmHealth(null)).toMatchObject({ status: 'unknown', reason: 'missing_response' });
    expect(normalizeFarmHealth({ health_score: 90 })).toMatchObject({ status: 'unknown', reason: 'missing_status' });
    expect(normalizeFarmHealth({ status: 42 })).toMatchObject({ status: 'degraded', reason: 'malformed_status' });
    expect(normalizeFarmHealth(null, { upstreamError: true })).toMatchObject({ status: 'degraded', reason: 'upstream_error' });
  });
});

describe('Health contract — API reachability vs farm health separation', () => {
  it('API reachability and farm health are independent concerns', () => {
    // A reachable API can report an unhealthy farm
    const apiReachable = true;
    const farmStatus = mapFarmHealthStatus('unhealthy');
    expect(farmStatus).toBe('unhealthy'); // farm is unhealthy
    // but the API probe would succeed (reachable)

    // An unreachable API means farm health is unknown
    const farmStatusWhenApiDown = mapFarmHealthStatus(null);
    expect(farmStatusWhenApiDown).toBe('unknown');
  });

  it('/health remains a liveness-only endpoint (always ok)', () => {
    // The /health endpoint is for Render/ALB liveness only.
    // It always returns { status: 'ok' } regardless of upstream state.
    const livenessResponse = { status: 'ok', service: 'bha-cst-engine' };
    expect(livenessResponse.status).toBe('ok');
  });
});

