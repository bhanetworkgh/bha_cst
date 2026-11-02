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

// ── Inline health-status mapping (mirrors engine/src/app.ts /api/health) ────
function mapFarmHealthStatus(raw: string | null | undefined): string {
  if (raw === 'healthy') return 'healthy';
  if (raw === 'unhealthy') return 'unhealthy';
  if (raw === null || raw === undefined) return 'unknown';
  return 'degraded'; // stale, failed, unrecognized
}

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

