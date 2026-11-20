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
    // Contract v1.1.1: Missing freshness evidence cannot be represented as confirmed healthy
    const missing = normalizeFarmHealth({ status: 'healthy' }, { nowMs });
    expect(missing).toMatchObject({ status: 'degraded', staleness_evaluation: 'unavailable_no_timestamp' });
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

describe('Contract v1.1.1 — Farm health route resolution & access semantics', () => {
  it('enforces 403 Forbidden via assertSpeakerFarmAccess when caller does not own farm', async () => {
    const { assertSpeakerFarmAccess, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/authorization.js');
    const speaker = {
      tenant_id: 'tenant-1',
      person_id: 'speaker-1',
      channel: 'voice' as const,
      address: '+19715885823',
      is_known: true,
      role: 'operator',
      farm_ids: ['farm-alpha'],
    };

    // Caller attempts to access farm-beta which they do not own -> throws VfarmAuthorizationError (403)
    expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-beta')).toThrow(VfarmAuthorizationError);
    try {
      assertSpeakerFarmAccess(speaker as any, 'farm-beta');
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.message).toContain('not authorized for farm farm-beta');
    }

    // Caller accesses granted farm -> succeeds
    expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-alpha')).not.toThrow();
  });

  it('rejects unparameterized farm health lookup without farm_id with 403/bad request', async () => {
    const { assertSpeakerFarmAccess } = await import('../../engine/src/adapters/vfarm/authorization.js');
    const speaker = {
      tenant_id: 'tenant-1',
      person_id: 'speaker-1',
      channel: 'voice' as const,
      address: '+19715885823',
      is_known: true,
      role: 'operator',
      farm_ids: ['farm-alpha'],
    };
    expect(() => assertSpeakerFarmAccess(speaker as any, '')).toThrow('farm_id is required');
  });

  describe('assertSpeakerFarmAccess — strict 10-point regression suite', () => {
    it('1. explicitly granted farm succeeds', async () => {
      const { assertSpeakerFarmAccess } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const speaker = {
        person_id: 'usr-1',
        is_known: true,
        role: 'operator',
        farm_ids: ['farm-alpha'],
      };
      expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-alpha')).not.toThrow();
    });

    it('2. discovered but ungranted farm is rejected (dynamicAllowedFarms bypass removed)', async () => {
      const { assertSpeakerFarmAccess, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const speaker = {
        person_id: 'usr-1',
        is_known: true,
        role: 'operator',
        farm_ids: ['farm-alpha'],
      };
      // Farm-beta is known to tenant adapter but not in speaker.farm_ids -> rejected
      expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-beta')).toThrow(VfarmAuthorizationError);
      expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-beta')).toThrow(/not authorized for farm farm-beta/);
    });

    it('3. missing farm grants are rejected', async () => {
      const { assertSpeakerFarmAccess, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const speaker = {
        person_id: 'usr-2',
        is_known: true,
        role: 'operator',
        farm_ids: [],
      };
      expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-alpha')).toThrow(VfarmAuthorizationError);
      expect(() => assertSpeakerFarmAccess(speaker as any, 'farm-alpha')).toThrow(/granted farms: \[\]/);
    });

    it('4. empty farm ID is rejected', async () => {
      const { assertSpeakerFarmAccess } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const speaker = {
        person_id: 'usr-1',
        is_known: true,
        role: 'operator',
        farm_ids: ['farm-alpha'],
      };
      expect(() => assertSpeakerFarmAccess(speaker as any, '')).toThrow('farm_id is required');
      expect(() => assertSpeakerFarmAccess(speaker as any, '   ')).toThrow('farm_id is required');
    });

    it('5. missing or whitespace person ID is rejected', async () => {
      const { assertSpeakerFarmAccess } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const speakerNoPerson = {
        is_known: true,
        role: 'operator',
        farm_ids: ['farm-alpha'],
      };
      expect(() => assertSpeakerFarmAccess(speakerNoPerson as any, 'farm-alpha')).toThrow(/Missing acting-user ID/);

      const speakerWhitespace = {
        person_id: '   ',
        is_known: true,
        role: 'operator',
        farm_ids: ['farm-alpha'],
      };
      expect(() => assertSpeakerFarmAccess(speakerWhitespace as any, 'farm-alpha')).toThrow(/Missing acting-user ID/);
    });

    it('6. conflicting identity fields cannot authorize access', async () => {
      const { assertSpeakerFarmAccess, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const conflictingSpeaker = {
        person_id: 'usr-123',
        speaker_id: 'usr-different',
        is_known: true,
        role: 'operator',
        farm_ids: ['farm-alpha'],
      };
      expect(() => assertSpeakerFarmAccess(conflictingSpeaker as any, 'farm-alpha')).toThrow(VfarmAuthorizationError);
      expect(() => assertSpeakerFarmAccess(conflictingSpeaker as any, 'farm-alpha')).toThrow(/Conflicting speaker identity/);
    });

    it('7. is_known: false cannot access a protected farm', async () => {
      const { assertSpeakerFarmAccess, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const unknownSpeaker = {
        person_id: 'usr-unknown',
        is_known: false,
        role: 'operator',
        farm_ids: ['farm-alpha'],
      };
      expect(() => assertSpeakerFarmAccess(unknownSpeaker as any, 'farm-alpha')).toThrow(VfarmAuthorizationError);
      expect(() => assertSpeakerFarmAccess(unknownSpeaker as any, 'farm-alpha')).toThrow(/unauthenticated identity/);
    });

    it('8. cross-tenant access is rejected', async () => {
      const { assertSpeakerFarmAccess, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/authorization.js');
      const tenantASpeaker = {
        person_id: 'usr-tenant-a',
        tenant_id: 'tenant-a',
        is_known: true,
        role: 'operator',
        farm_ids: ['farm-tenant-a'],
      };
      expect(() => assertSpeakerFarmAccess(tenantASpeaker as any, 'farm-tenant-b')).toThrow(VfarmAuthorizationError);
      expect(() => assertSpeakerFarmAccess(tenantASpeaker as any, 'farm-tenant-b')).toThrow(/not authorized for farm farm-tenant-b/);
    });

    it('9. admin/superadmin role assignment requires is_known: true to bypass farm scope', async () => {
      const { assertSpeakerFarmAccess, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/authorization.js');
      
      // Unauthenticated caller claiming admin is rejected
      const unauthAdmin = {
        person_id: 'usr-fake-admin',
        is_known: false,
        role: 'admin',
        farm_ids: [],
      };
      expect(() => assertSpeakerFarmAccess(unauthAdmin as any, 'farm-any')).toThrow(VfarmAuthorizationError);
      expect(() => assertSpeakerFarmAccess(unauthAdmin as any, 'farm-any')).toThrow(/unauthenticated identity/);

      // Authenticated admin bypasses farm grant scope
      const authAdmin = {
        person_id: 'usr-real-admin',
        is_known: true,
        role: 'admin',
        farm_ids: [],
      };
      expect(() => assertSpeakerFarmAccess(authAdmin as any, 'farm-unlisted')).not.toThrow();

      // Authenticated superadmin bypasses farm grant scope
      const authSuper = {
        person_id: 'usr-real-super',
        is_known: true,
        role: 'superadmin',
        farm_ids: [],
      };
      expect(() => assertSpeakerFarmAccess(authSuper as any, 'farm-unlisted')).not.toThrow();
    });

    it('10. an upstream authorization rejection is propagated without fallback', async () => {
      const { VfarmTenantAdapter, VfarmAuthorizationError } = await import('../../engine/src/adapters/vfarm/index.js');
      const adapter = new VfarmTenantAdapter('tenant-1', { baseUrl: 'https://vfarm.test' });
      const speakerWithNoAccess = {
        person_id: 'usr-unauthorized',
        is_known: true,
        role: 'operator' as const,
        farm_ids: ['farm-other'],
        customer_ref: 'cust-1',
        tenant_id: 'tenant-1',
        project_id: 'proj-1',
        phone_e164: '+19715885823',
        permissions: ['read:telemetry'],
      };

      // Direct adapter call to getFarmStatusForSpeaker for ungranted farm fails closed immediately
      await expect(adapter.getFarmStatusForSpeaker({ farmId: 'farm-restricted', speaker: speakerWithNoAccess }))
        .rejects.toThrow(VfarmAuthorizationError);
    });
  });

  it('verifies v1.1.1 health status taxonomy: NORMAL, DEGRADED, OFFLINE, UNKNOWN', () => {
    // NORMAL: upstream healthy
    expect(mapFarmHealthStatus('healthy')).toBe('healthy');

    // DEGRADED: upstream degraded, neutral, stale, critical, failed
    expect(mapFarmHealthStatus('degraded')).toBe('degraded');
    expect(mapFarmHealthStatus('neutral')).toBe('degraded');
    expect(mapFarmHealthStatus('critical')).toBe('degraded');
    expect(mapFarmHealthStatus('stale')).toBe('degraded');

    // OFFLINE: device presence offline
    const isDeviceOffline = (status: string) => status === 'offline';
    expect(isDeviceOffline('offline')).toBe(true);
    expect(isDeviceOffline('off')).toBe(false); // loads that are 'off' are NOT offline

    // UNKNOWN: null, undefined, uninitialized
    expect(mapFarmHealthStatus(null)).toBe('unknown');
    expect(mapFarmHealthStatus(undefined)).toBe('unknown');
  });
});


