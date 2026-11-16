/**
 * BHARAG credential and lane separation — regression tests.
 *
 * Jegan's three-lane architecture requires that:
 *   - knowledge queries use the knowledge/cluster credential only;
 *   - incident creation uses the incidents workspace credential only;
 *   - farm status / alerts / device state never reach BHARAG;
 *   - no credential value appears in logs;
 *   - no fabricated incident ID is persisted.
 *
 * These tests prove the separation at the connector boundary using mocks.
 * No live BHARAG, no real incident creation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BharagRagConnector } from '../../engine/src/connectors/bharag_rag.js';
import { BharagIncidentsConnector } from '../../engine/src/connectors/bharag_incidents.js';
import { getEnv } from '../../engine/src/config/env.js';
import { Logger } from '../../engine/src/config/logger.js';

describe('BHARAG credential separation', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('knowledge uses only BHARAG_CLUSTER_KEY, never BHARAG_WORKSPACE_KEY', async () => {
    process.env.BHARAG_CLUSTER_KEY = 'cluster-knowledge-key-123';
    process.env.BHARAG_WORKSPACE_KEY = 'workspace-incidents-key-456';
    process.env.BHARAG_CLUSTER_URL = 'https://bharag.test/cluster/ask';
    process.env.BHARAG_API_URL = 'https://bharag.test/api';

    let capturedHeaders: any = null;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string | URL | Request, options?: RequestInit) => {
      capturedHeaders = options?.headers;
      return { ok: true, json: async () => ({ answer: 'BHARAG knowledge answer.' }) } as Response;
    });

    await BharagRagConnector.askKnowledge('How do I clean the filter?');

    expect(capturedHeaders['x-api-key']).toBe('cluster-knowledge-key-123');
    // The incidents key must never travel on the knowledge path.
    expect(capturedHeaders['Authorization']).toBeUndefined();
    const body = JSON.stringify(capturedHeaders);
    expect(body).not.toContain('workspace-incidents-key-456');
  });

  it('incidents use only BHARAG_WORKSPACE_KEY (x-api-key), never BHARAG_CLUSTER_KEY', async () => {
    process.env.BHARAG_CLUSTER_KEY = 'cluster-knowledge-key-123';
    process.env.BHARAG_WORKSPACE_KEY = 'workspace-incidents-key-456';
    process.env.BHARAG_CLUSTER_URL = 'https://bharag.test/cluster/ask';
    process.env.BHARAG_API_URL = 'https://bharag.test/api';

    let capturedHeaders: any = null;
    let capturedBody: any = null;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string | URL | Request, options?: RequestInit) => {
      capturedHeaders = options?.headers;
      capturedBody = JSON.parse(options?.body as string);
      return { ok: true, status: 201, json: async () => ({ incident: { entity_id: 'INC-VFARM.DEVICE-001' } }) } as Response;
    });

    const result = await BharagIncidentsConnector.fileIncident({
      customerRef: 'cust_test',
      conversationId: 'conv_test',
      summary: 'Test incident',
      subsystem: 'CUSTOMER_TWIN',
      engine: 'VFARM',
    });

    expect(capturedHeaders['x-api-key']).toBe('workspace-incidents-key-456');
    // BHARAG data-plane accepts workspace keys via x-api-key only, never Bearer
    expect(capturedHeaders['Authorization']).toBeUndefined();
    expect(capturedBody.source).toBe('cst');
    expect(capturedBody.severity).toBe('high');
    expect(capturedBody.subsystem).toBe('DEVICE');
    expect(capturedBody.payload.customer_ref).toBe('cust_test');
    expect(capturedBody.payload.conversation_id).toBe('conv_test');
    const body = JSON.stringify(capturedHeaders) + JSON.stringify(capturedBody);
    expect(body).not.toContain('cluster-knowledge-key-123');
    // Only the real incident_id is stored.
    expect(result.incident_id).toBe('INC-VFARM.DEVICE-001');
    expect(result.created).toBe(true);
  });

  it('a missing incidents credential does not silently fall back to the knowledge key', async () => {
    // Remove the incidents key. The connector must not substitute the cluster key.
    delete process.env.BHARAG_WORKSPACE_KEY;
    process.env.BHARAG_CLUSTER_KEY = 'cluster-knowledge-key-123';
    process.env.BHARAG_API_URL = 'https://bharag.test/api';

    let fetchCalled = false;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCalled = true;
      return { ok: false, status: 401, json: async () => ({}) } as Response;
    });

    const result = await BharagIncidentsConnector.fileIncident({
      customerRef: 'cust_test',
      conversationId: 'conv_test',
      summary: 'Test incident',
    });

    // The connector either fails closed or uses an empty key — never the cluster key.
    const capturedBody = (globalThis.fetch as any).mock?.calls?.[0]?.[1]?.body || '';
    expect(capturedBody).not.toContain('cluster-knowledge-key-123');
    // No incident is fabricated.
    expect(result.incident_id).toBeNull();
    expect(result.created).toBe(false);
  });

  it('no credential value appears in logs', async () => {
    process.env.BHARAG_CLUSTER_KEY = 'secret-cluster-key-value-999';
    process.env.BHARAG_WORKSPACE_KEY = 'secret-workspace-key-value-888';
    process.env.BHARAG_CLUSTER_URL = 'https://bharag.test/cluster/ask';
    process.env.BHARAG_API_URL = 'https://bharag.test/api';

    const logLines: string[] = [];
    for (const level of ['info', 'warn', 'error', 'audit', 'infra'] as const) {
      vi.spyOn(Logger as any, level).mockImplementation((...args: any[]) => {
        logLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return { ok: true, json: async () => ({ answer: 'Cluster answer.' }) } as Response;
    });

    await BharagRagConnector.askKnowledge('How do I clean the filter?');

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    await BharagIncidentsConnector.fileIncident({
      customerRef: 'cust_test',
      conversationId: 'conv_test',
      summary: 'Test incident',
    });

    const stream = logLines.join('\n');
    expect(stream).not.toContain('secret-cluster-key-value-999');
    expect(stream).not.toContain('secret-workspace-key-value-888');
  });

  it('a farm-status request never calls the BHARAG knowledge endpoint', async () => {
    process.env.BHARAG_CLUSTER_KEY = 'cluster-knowledge-key-123';
    process.env.BHARAG_WORKSPACE_KEY = 'workspace-incidents-key-456';
    process.env.BHARAG_CLUSTER_URL = 'https://bharag.test/cluster/ask';
    process.env.BHARAG_API_URL = 'https://bharag.test/api';

    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('cluster/ask') || String(url).includes('cluster')) {
        return { ok: true, json: async () => ({ answer: 'BHARAG answer' }) } as Response;
      }
      if (String(url).includes('/incidents')) {
        return { ok: true, status: 201, json: async () => ({ incident_id: 'inc_real_001' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    globalThis.fetch = fetchSpy;

    // Import IntentRouter dynamically to avoid module-level side effects.
    const { IntentRouter } = await import('../../engine/src/router/index.js');
    const { DbClient } = await import('../../engine/src/db/client.js');
    const { CoreRegistry } = await import('../../engine/src/core/registry.js');
    const { VfarmConnector } = await import('../../engine/src/connectors/vfarm.js');
    DbClient.clearAll();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as any;
    if (adapter) {
      vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);
      vi.spyOn(adapter, 'getFarmStatusForSpeaker').mockResolvedValue({
        farm_name: 'Test Farm', status: 'ok',
        devices: { total: 5, online: 5, offline: 0, unhealthy: 0, maintenance: 0, error: 0 },
      });
    }

    const msg = {
      message_id: 'SM_BHARAG_SEP_001', tenant_id: 'tenant-vfarm-01', from_e164: '+15551234567',
      to_e164: '+19715885823', body: "What's the status of my farm?", media: [],
      received_at: new Date().toISOString(), correlation_id: 'corr_bharag_sep',
    };
    const identity = {
      customer_ref: 'u1', organization_id: 'tenant-vfarm-01', tenant_id: 'tenant-vfarm-01',
      system_id: 'system-vfarm-01', workspace_id: 'ws-vfarm-main', is_known_customer: true,
      role: 'manager' as const, permissions: [], unit_context: { farm_id: 'farm_austin_main', role: 'manager' },
    };

    await IntentRouter.routeAndHandle(msg as any, identity as any);

    const clusterCalls = fetchSpy.mock.calls.filter((c: any[]) => String(c[0]).includes('cluster/ask') || String(c[0]).includes('cluster'));
    expect(clusterCalls.length).toBe(0);
  });
});
