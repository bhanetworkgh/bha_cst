/**
 * vFarm health-probe regression tests.
 *
 * The defect: `getHealth()` returned a hard-coded
 * `{ status: 'healthy', latency_ms: 15 }` WITHOUT contacting vFarm, so a
 * deployment with an unreachable, unauthorised or misconfigured upstream still
 * reported itself healthy — and the reported latency was a literal, not a
 * measurement.
 *
 * These tests pin the corrected behaviour:
 *   - a real, bounded, read-only upstream request is made;
 *   - the reported latency is measured;
 *   - `configured` / `healthy` / `degraded` / `unavailable` are distinguished;
 *   - the upstream is never reported healthy merely because credentials exist;
 *   - the probe never mutates tenant state and never throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

const ORG_ID = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';
const PROJECT_ID = 'proj-vfarm-main';
const TENANT_ID = 'tenant-vfarm-01';

function jsonResponse(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** The organisation record shape the live client validates against. */
const ORG_BODY = {
  id: ORG_ID,
  slug: 'default',
  name: 'Default',
  description: null,
  is_active: true,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
};

function makeAdapter(fetchFn: any, extra: Record<string, any> = {}) {
  return new VfarmTenantAdapter(TENANT_ID, {
    baseUrl: 'https://vfarm.test',
    apiKey: 'vk_test',
    apiToken: 'jwt_test',
    timeoutMs: 2000,
    fetchFn: fetchFn as any,
    seedDemoDirectory: false,
    tenantOrgId: ORG_ID,
    ...extra,
  });
}

describe('vFarm health probe', () => {
  let adapter: VfarmTenantAdapter | null = null;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    adapter = null;
    vi.restoreAllMocks();
  });

  // ── Success ───────────────────────────────────────────────────────────────

  it('reports healthy with a MEASURED latency after a successful upstream read', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(ORG_BODY));
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'vFarm Main',
      status: 'active',
      tenant_org_id: ORG_ID,
      capabilities: { sms: true, voice: true, web: true },
      speaker_policy: 'allowlist',
      onboarding_reply: 'hi',
      voice_enabled: true,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);

    expect(health.status).toBe('healthy');
    // The latency is measured, not the old hard-coded 15.
    expect(typeof health.latency_ms).toBe('number');
    expect(health.latency_ms).toBeGreaterThanOrEqual(0);
    expect(health.details?.probe).toBe('organization');
    expect(health.details?.mode).toBe('live');
    // A real upstream request was made, to the tenant's own organization.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchFn.mock.calls[0][0]);
    expect(calledUrl).toContain('/api/v1/organizations/');
    expect(calledUrl).toContain(ORG_ID);
  });

  it('does not report healthy when no organization is configured to scope the probe to', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ organizations: [], total: 0 }));
    adapter = makeAdapter(fetchFn, { tenantOrgId: '' });

    const health = await adapter.getHealth(TENANT_ID);

    // Reachable and authenticated, but tenant health is NOT asserted.
    expect(health.status).toBe('configured');
    expect(health.details?.reachable).toBe(true);
    expect(health.details?.reason).toBe('no_tenant_org_id_for_scoped_probe');
  });

  // ── Failure modes ─────────────────────────────────────────────────────────

  it('reports unavailable when the credential is rejected (401)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ detail: 'unauthorized' }, 401));
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);

    expect(health.status).toBe('unavailable');
    expect(String(health.details?.reason)).toContain('auth');
  });

  it('reports unavailable when the credential is forbidden (403)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ detail: 'forbidden' }, 403));
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);
    expect(health.status).toBe('unavailable');
  });

  it('reports degraded on an upstream 5xx', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ detail: 'boom' }, 503));
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);
    expect(health.status).toBe('degraded');
    expect(String(health.details?.reason)).toContain('probe_failed');
  });

  it('reports degraded on a network failure and never throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);
    expect(health.status).toBe('degraded');
    expect(health.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded on a timeout', async () => {
    const fetchFn = vi.fn(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener?.('abort', () => {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );
    adapter = makeAdapter(fetchFn, { timeoutMs: 50 });
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);
    expect(['degraded', 'unavailable']).toContain(health.status);
    expect(String(health.details?.reason)).toMatch(/probe_failed/);
  });

  it('reports degraded when the upstream returns a response that fails validation', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ nonsense: true }));
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);
    expect(health.status).toBe('degraded');
    expect(String(health.details?.reason)).toContain('invalid_response');
  });

  it('reports unavailable when no upstream is configured at all', async () => {
    adapter = new VfarmTenantAdapter(TENANT_ID, { seedDemoDirectory: false });
    const fetchFn = vi.fn();

    const health = await adapter.getHealth(TENANT_ID);

    expect(health.status).toBe('unavailable');
    expect(health.details?.reason).toBe('no_vfarm_client_configured');
    expect(health.details?.mode).toBe('local');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // ── Safety properties ────────────────────────────────────────────────────

  it('never mutates tenant state while probing', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(ORG_BODY));
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const before = adapter.getDiscoveredFarmIds().length;
    await adapter.getHealth(TENANT_ID);

    // A health probe is a READ. It must not populate or alter the
    // discovered-farm cache.
    expect(adapter.getDiscoveredFarmIds().length).toBe(before);
  });

  it('never reports healthy merely because credentials are present', async () => {
    // Credentials are configured, but the upstream refuses the request.
    const fetchFn = vi.fn(async () => jsonResponse({ detail: 'unauthorized' }, 401));
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);
    expect(health.status).not.toBe('healthy');
  });

  it('does not leak the credential or the upstream body in the health result', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ detail: 'unauthorized', secret_hint: 'vk_test_value' }, 401)
    );
    adapter = makeAdapter(fetchFn);
    adapter.addProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'p',
      status: 'active',
      tenant_org_id: ORG_ID,
    } as any);

    const health = await adapter.getHealth(TENANT_ID);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain('vk_test_value');
    expect(serialized).not.toContain('jwt_test');
  });
});
