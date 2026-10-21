/**
 * vFarm health probe — operational mode and per-turn safety.
 *
 * The vFarm health probe is an ACTIVE liveness check: it makes a real,
 * bounded, read-only request upstream and reports the MEASURED latency.
 *
 * The per-request authorization path (the voice lane) must NOT use it. A
 * liveness probe on the customer's critical path turns an upstream hiccup
 * into a total voice outage, because a slow, rate-limited or
 * unrecognised-shape upstream response would refuse every turn.
 *
 * `getHealth(tenantId, { probe: false })` reports OPERATIONAL readiness with
 * no network access; the authoritative membership and farm-grant checks run
 * inside `resolveSpeaker()` and fail closed on their own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { VfarmApiError } from '../../engine/src/adapters/vfarm/http_client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';

const makeConfig = (overrides: Record<string, any> = {}) => ({
  baseUrl: 'https://vfarm.example.test',
  apiKey: 'test-farm-key',
  tenantId: 'tenant-vfarm-01',
  timeoutMs: 2000,
  ...overrides,
});

describe('vFarm health probe — operational mode (no upstream request)', () => {
  it('performs NO upstream request when the probe is skipped', async () => {
    const fetchFn = vi.fn();
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', makeConfig({ fetchFn } as any));

    const health = await adapter.getHealth('tenant-vfarm-01', { probe: false });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(['configured', 'healthy']).toContain(health.status);
  });

  it('reports the adapter as unavailable in production when no upstream is configured', async () => {
    // No baseUrl -> no live client -> identity resolution cannot run.
    // In production that is a fail-closed condition and must not be reported
    // as usable.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
        tenantId: 'tenant-vfarm-01',
      } as any);
      const health = await adapter.getHealth('tenant-vfarm-01', { probe: false });
      expect(health.status).toBe('unavailable');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('reports a simulated-degraded adapter as degraded without any request', async () => {
    const fetchFn = vi.fn();
    const adapter = new VfarmTenantAdapter(
      'tenant-vfarm-01',
      makeConfig({ fetchFn, simulateDegraded: true } as any),
    );

    const health = await adapter.getHealth('tenant-vfarm-01', { probe: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(health.status).toBe('degraded');
  });
});

describe('vFarm health probe — active probe', () => {
  it('reports the MEASURED latency of a successful tenant-scoped request', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'org-1',
        slug: 'test-org',
        name: 'Test Org',
        is_active: true,
      }),
    })) as any;
    const adapter = new VfarmTenantAdapter(
      'tenant-vfarm-01',
      makeConfig({ fetchFn, tenantOrgId: 'org-1' } as any),
    );

    const health = await adapter.getHealth('tenant-vfarm-01');
    expect(health.status).toBe('healthy');
    expect(typeof health.latency_ms).toBe('number');
    expect(health.latency_ms).toBeGreaterThanOrEqual(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('never reports "healthy" when the upstream rejects the credential', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    })) as any;
    const adapter = new VfarmTenantAdapter(
      'tenant-vfarm-01',
      makeConfig({ fetchFn, tenantOrgId: 'org-1' } as any),
    );

    const health = await adapter.getHealth('tenant-vfarm-01');
    expect(health.status).not.toBe('healthy');
    expect(health.status).toBe('unavailable');
  });

  it('does not leak the upstream response body or the credential', async () => {
    const secret = 'super-secret-farm-key';
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'upstream-internal-detail',
    })) as any;
    const adapter = new VfarmTenantAdapter(
      'tenant-vfarm-01',
      makeConfig({ fetchFn, apiKey: secret, tenantOrgId: 'org-1' } as any),
    );

    const health = await adapter.getHealth('tenant-vfarm-01');
    const serialised = JSON.stringify(health);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain('upstream-internal-detail');
  });

  it('does not throw when the upstream is unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const adapter = new VfarmTenantAdapter(
      'tenant-vfarm-01',
      makeConfig({ fetchFn, tenantOrgId: 'org-1' } as any),
    );

    const health = await adapter.getHealth('tenant-vfarm-01');
    expect(['degraded', 'unavailable']).toContain(health.status);
  });

  it('applies a strict probe timeout that is tighter than the general request budget', async () => {
    const signals: any[] = [];
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      signals.push(init?.signal);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener?.('abort', () => {
          const err: any = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as any;
    const adapter = new VfarmTenantAdapter(
      'tenant-vfarm-01',
      makeConfig({ fetchFn, tenantOrgId: 'org-1', timeoutMs: 120 } as any),
    );

    const started = Date.now();
    const health = await adapter.getHealth('tenant-vfarm-01');
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(['degraded', 'unavailable']).toContain(health.status);
    expect(signals.length).toBe(1);
  });

  it('does not mutate tenant state while probing', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'org-1',
        slug: 'test-org',
        name: 'Test Org',
        is_active: true,
      }),
    })) as any;
    const adapter = new VfarmTenantAdapter(
      'tenant-vfarm-01',
      makeConfig({ fetchFn, tenantOrgId: 'org-1' } as any),
    );

    const before = (adapter as any).projectsMap.size;
    await adapter.getHealth('tenant-vfarm-01');
    expect((adapter as any).projectsMap.size).toBe(before);
  });
});

describe('vFarm health probe — the voice lane must not probe per turn', () => {
  beforeEach(() => {
    CoreRegistry.resetToDefault();
  });

  it('the voice authorization gate asks for operational readiness, not a live probe', async () => {
    // `getAdapterHealthFailure` is a private static on VoiceInterface, so it
    // is exercised through the same seam the voice lane uses: the tenant
    // adapter's `getHealth`. The gate must call it with `probe: false` so no
    // upstream request is made on the customer's critical path.
    const adapter: any = CoreRegistry.getAdapter('tenant-vfarm-01');
    expect(adapter).toBeTruthy();

    const calls: any[] = [];
    const original = adapter.getHealth.bind(adapter);
    adapter.getHealth = async (tenantId: string, options?: any) => {
      calls.push(options);
      return original(tenantId, options);
    };

    const { VoiceInterface } = await import('../../engine/src/interfaces/voice/index.js');
    const failure = await (VoiceInterface as any).getAdapterHealthFailure('tenant-vfarm-01');

    expect(calls.length).toBeGreaterThan(0);
    for (const options of calls) {
      expect(options).toEqual({ probe: false });
    }
    // A healthy, live adapter must not refuse the turn.
    expect(failure).toBeNull();
  });
});
