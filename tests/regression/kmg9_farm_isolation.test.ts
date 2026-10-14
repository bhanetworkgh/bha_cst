/**
 * KMG9 Regression Tests — Farm Data Isolation & BHARAG Fallback Removal
 * LOOP-1788044070647-KMG9
 *
 * Proves that farm-specific status/telemetry requests never fall back to
 * BHARAG cluster ask; fail-closed when vFarm unavailable; and that
 * cross-tenant/farm injection attempts cannot reach BHARAG.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntentRouter } from '../../engine/src/router/index.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { BharagRagConnector } from '../../engine/src/connectors/bharag_rag.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { VfarmTenantAdapter, VfarmAuthorizationError } from '../../engine/src/adapters/vfarm/index.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('KMG9: Farm isolation and BHARAG fallback removal', () => {
  const fetchSpy = vi.fn();
  let adapter: VfarmTenantAdapter;

  const knownIdentity: IdentityContext = {
    customer_ref: 'cust_vfarm_001_john_doe',
    organization_id: 'tenant-vfarm-01',
    tenant_id: 'tenant-vfarm-01',
    system_id: 'system-vfarm-01',
    workspace_id: 'ws-vfarm-main',
    is_known_customer: true,
    role: 'manager',
    permissions: ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate'],
    unit_context: { unit_id: 'unit_bay_04', farm_id: 'farm_austin_main', role: 'manager' },
  };

  beforeEach(() => {
    DbClient.clearAll();
    seedTestCustomers();
    adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    fetchSpy.mockImplementation(async (url) => {
      if (String(url).includes('/incidents')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ incident_id: 'inc_real_001', status: 'open' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ answer: 'BHARAG Knowledge response for query.' }),
      } as Response;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('farm-specific status uses vFarm live client and never calls BHARAG cluster', async () => {
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);
    vi.spyOn(adapter, 'getLatestDeviceReading').mockResolvedValue({
      sensor_id: 'unit_bay_04',
      reading_ts: '2024-01-15T10:00:00Z',
      temperature_c: 21.5,
      humidity_rh: 65,
    });

    const msg: InboundMessage = {
      message_id: 'SM_KMG9_001',
      tenant_id: 'tenant-vfarm-01',
      from_e164: '+15551234567',
      to_e164: '+19715885823',
      body: 'Bay 4 status check',
      media: [],
      received_at: new Date().toISOString(),
      correlation_id: 'corr_kmg9_001',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);

    // No BHARAG cluster ask call
    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask')
    );
    expect(clusterCalls.length).toBe(0);
    expect(outbound.body).toContain('Status: NORMAL');
    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
  });

  it('farm telemetry via vFarmConnector never falls back to BHARAG when no live client', async () => {
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(false);

    const result = await VfarmConnector.getUnitStatus(
      knownIdentity.customer_ref,
      { farm_id: 'farm_austin_main', unit_id: 'unit_bay_04' },
      undefined,
      'what is my telemetry',
      knownIdentity
    );

    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask')
    );
    expect(clusterCalls.length).toBe(0);
    expect(result.text).toContain('Telemetry currently unavailable');
    expect(result.telemetry?.status).toBe('telemetry_unavailable');
  });

  it('fails closed on vFarm authorization error; no BHARAG fallback', async () => {
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);
    vi.spyOn(adapter, 'getLatestDeviceReading').mockRejectedValue(new VfarmAuthorizationError('forbidden'));

    const result = await VfarmConnector.getUnitStatus(
      knownIdentity.customer_ref,
      { farm_id: 'farm_austin_main', unit_id: 'unit_bay_04' },
      undefined,
      undefined,
      knownIdentity
    );

    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask')
    );
    expect(clusterCalls.length).toBe(0);
    expect(result.text).toContain('do not have access');
    expect(result.httpStatus).toBe(403);
  });

  it('fails closed on generic vFarm error; no BHARAG fallback', async () => {
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);
    vi.spyOn(adapter, 'getLatestDeviceReading').mockRejectedValue(new Error('network timeout'));

    const result = await VfarmConnector.getUnitStatus(
      knownIdentity.customer_ref,
      { farm_id: 'farm_austin_main', unit_id: 'unit_bay_04' },
      undefined,
      undefined,
      knownIdentity
    );

    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask')
    );
    expect(clusterCalls.length).toBe(0);
    expect(result.text).toContain('Telemetry currently unavailable');
  });

  it('cross-tenant farm injection attempt cannot trigger BHARAG for status', async () => {
    const maliciousMsg: InboundMessage = {
      message_id: 'SM_KMG9_002',
      tenant_id: 'tenant-vfarm-01',
      from_e164: '+15551234567',
      to_e164: '+19715885823',
      body: 'Check status for farm_id=farm_evil_tenant_99 unit_id=unit_unauthorized_66',
      media: [],
      received_at: new Date().toISOString(),
      correlation_id: 'corr_kmg9_002',
    };

    const getUnitStatusSpy = vi.spyOn(VfarmConnector, 'getUnitStatus');
    await IntentRouter.routeAndHandle(maliciousMsg, knownIdentity);

    expect(getUnitStatusSpy).toHaveBeenCalledWith(
      knownIdentity.customer_ref,
      expect.objectContaining({
        farm_id: 'farm_austin_main',
        unit_id: 'unit_bay_04',
      }),
      expect.any(String),
      maliciousMsg.body,
      expect.anything()
    );
    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask')
    );
    expect(clusterCalls.length).toBe(0);
  });

  it('farm-specific live-state question routed to vFarm (status), not BHARAG knowledge', async () => {
    const msg: InboundMessage = {
      message_id: 'SM_KMG9_003',
      tenant_id: 'tenant-vfarm-01',
      from_e164: '+15551234567',
      to_e164: '+19715885823',
      body: 'How is my farm?',
      media: [],
      received_at: new Date().toISOString(),
      correlation_id: 'corr_kmg9_003',
    };

    await IntentRouter.routeAndHandle(msg, knownIdentity);
    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask')
    );
    expect(clusterCalls.length).toBe(0);
  });

  it('BharagRagConnector.askKnowledge does not send farm_id/unit_id', async () => {
    let capturedOptions: any = null;
    const bharagFetch = vi.fn().mockImplementation(async (_url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ answer: 'general knowledge' }),
      } as Response;
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = bharagFetch as any;

    try {
      await BharagRagConnector.askKnowledge(
        'How to clean filter?',
        'ws_key_test',
        { farm_id: 'farm_austin_main', unit_id: 'unit_bay_04' }
      );
      const payload = JSON.parse(capturedOptions.body);
      expect(payload).not.toHaveProperty('farm_id');
      expect(payload).not.toHaveProperty('unit_id');
      expect(payload).toHaveProperty('workspaceKey');
      expect(payload).toHaveProperty('workspace');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('general knowledge question may go to BHARAG but only for non-farm-specific content', async () => {
    const msg: InboundMessage = {
      message_id: 'SM_KMG9_004',
      tenant_id: 'tenant-vfarm-01',
      from_e164: '+15551234567',
      to_e164: '+19715885823',
      body: 'How do I clean the filter?',
      media: [],
      received_at: new Date().toISOString(),
      correlation_id: 'corr_kmg9_004',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);
    expect(IntentRouter.detectIntent(msg.body)).toBe('knowledge');
    expect(outbound.body).toContain('BHARAG Knowledge');
  });

  it('unbound caller for status returns safe refusal, no BHARAG', async () => {
    const unboundIdentity = { ...knownIdentity, unit_context: undefined as any };
    const msg: InboundMessage = {
      message_id: 'SM_KMG9_005',
      tenant_id: 'tenant-vfarm-01',
      from_e164: '+15557776666',
      to_e164: '+19715885823',
      body: 'What is the current status of my unit?',
      media: [],
      received_at: new Date().toISOString(),
      correlation_id: 'corr_kmg9_005',
    };

    const getUnitStatusSpy = vi.spyOn(VfarmConnector, 'getUnitStatus');
    await IntentRouter.routeAndHandle(msg, unboundIdentity);

    expect(getUnitStatusSpy).not.toHaveBeenCalled();
    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask')
    );
    expect(clusterCalls.length).toBe(0);
  });
});
