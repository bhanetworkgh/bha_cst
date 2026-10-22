/**
 * Intent routing matrix + farm-response integrity.
 *
 * LANE SEPARATION (KMG9, and Jegan's three-lane proposal of 2026-10-22):
 *
 *   farm data  -> vFarm      (the caller's own farm, live state)
 *   knowledge  -> BHARAG     (manuals, procedures, general guidance)
 *   incident   -> BHARAG incidents.v0
 *
 * A live farm question must NEVER be answered from the documentation
 * cluster: BHARAG is not given a farm id (by design), so it cannot answer
 * one, and a documentation answer to "show me my farm data" is a
 * category error.
 *
 * The rules below are EXAMPLES, not an exhaustive list. The behaviour they
 * pin down is:
 *   - a POSSESSIVE scope ("my farm") + live-data language -> the vFarm lane;
 *   - a procedure / recommendation question -> the BHARAG lane, even when it
 *     mentions a farm;
 *   - an escalation keyword -> the incident lane, unchanged;
 *   - short tokens are matched on word boundaries, so "phone" and "because"
 *     no longer drag ordinary sentences into the vFarm lane;
 *   - an unknown or ungranted caller is still refused.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntentRouter } from '../../engine/src/router/index.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

const FARM = 'farm_austin_main';

const knownIdentity: IdentityContext = {
  customer_ref: 'cust_vfarm_001_john_doe',
  organization_id: 'tenant-vfarm-01',
  tenant_id: 'tenant-vfarm-01',
  system_id: 'system-vfarm-01',
  workspace_id: 'ws-vfarm-main',
  is_known_customer: true,
  role: 'manager',
  permissions: ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate'],
  // Farm bound, NO unit: the case vFarm cannot satisfy per-device.
  unit_context: { farm_id: FARM, role: 'manager' },
};

const unknownIdentity: IdentityContext = {
  customer_ref: 'opaque_unresolved_9999',
  organization_id: 'tenant-vfarm-01',
  tenant_id: 'tenant-vfarm-01',
  system_id: 'system-vfarm-01',
  workspace_id: 'ws-vfarm-main',
  is_known_customer: false,
  role: 'unknown',
  permissions: [],
};

const msg = (body: string): InboundMessage => ({
  message_id: 'SM_ROUTING_MATRIX_001',
  tenant_id: 'tenant-vfarm-01',
  from_e164: '+15551234567',
  to_e164: '+19715885823',
  body,
  media: [],
  received_at: new Date().toISOString(),
  correlation_id: 'corr_routing_matrix',
});

/** The upstream farm health + device list, as vFarm actually returns them. */
const FARM_HEALTH = {
  farm_id: 'farm_austin_main',
  farm_name: 'Austin Main',
  status: 'critical',
  device_count: 26,
  online_count: 19,
  offline_count: 6,
  unhealthy_count: 10,
};

const DEVICE_LIST = {
  devices: [{ id: 'relay_1', status: 'online' }],
  total: 26,
  online_count: 19,
  offline_count: 6,
  registered_count: 20,
  maintenance_count: 0,
  error_count: 0,
  unhealthy_count: 10,
};

describe('intent routing — farm-scoped live state vs. general knowledge', () => {
  beforeEach(() => {
    DbClient.clearAll();
    seedTestCustomers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/incidents')) {
        return { ok: true, status: 201, json: async () => ({ incident_id: 'inc_real_001', status: 'open' }) } as Response;
      }
      return { ok: true, json: async () => ({ answer: 'BHARAG knowledge answer.' }) } as Response;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const clusterCalls = () =>
    (globalThis.fetch as any).mock.calls.filter((c: any[]) => String(c[0]).includes('cluster'));

  describe('the required routing matrix', () => {
    it('routes every farm-scoped live-state question to the vFarm lane', () => {
      const farmLane = [
        "What's the status of my farm?",
        'Show me my farm data.',
        'What alerts are open for my farm?',
        'How is my farm doing?',
        'What is the latest status of my farm.',
        'Give me the status of my farm devices.',
      ];
      for (const q of farmLane) {
        expect(IntentRouter.detectIntent(q), q).toBe('status');
      }
    });

    it('routes general procedure and agronomy questions to the BHARAG lane', () => {
      const knowledgeLane = [
        'How do I clean the filter?',
        'What pH is recommended for tomatoes?',
        'How do I calibrate the sensor?',
        'How do I replace the filter on my farm?',
        'What is the recommended pH for my farm?',
      ];
      for (const q of knowledgeLane) {
        expect(IntentRouter.detectIntent(q), q).toBe('knowledge');
      }
    });

    it('keeps the incident lane for fault reports', () => {
      expect(IntentRouter.detectIntent('There is a leak under rack 1')).toBe('escalate');
      expect(IntentRouter.detectIntent('the pump is broken')).toBe('escalate');
    });

    it('does not let short tokens drag ordinary sentences into the vFarm lane', () => {
      // 'ph' is inside "phone"/"because"; 'ec' is inside "because"/"each".
      expect(IntentRouter.detectIntent('because each phone is different')).not.toBe('status');
      expect(IntentRouter.detectIntent('secure each spec in the graph')).not.toBe('status');
    });

    it('does not route every sentence containing "farm" to vFarm', () => {
      expect(IntentRouter.detectIntent('how do I grow tomatoes on my farm')).toBe('knowledge');
      expect(IntentRouter.detectIntent('what equipment does my farm use')).toBe('knowledge');
    });
  });

  describe('lane separation at the dispatcher', () => {
    it('"Show me my farm data" reaches vFarm and NEVER calls the BHARAG cluster', async () => {
      const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
      vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);
      vi.spyOn(adapter, 'getFarmStatusForSpeaker').mockResolvedValue({
        farm_name: 'Austin Main',
        status: 'critical',
        devices: { total: 26, online: 19, offline: 6, unhealthy: 10, maintenance: 0, error: 0 },
      });

      const vfarmSpy = vi.spyOn(VfarmConnector, 'getUnitStatus');

      const out = await IntentRouter.routeAndHandle(msg('Show me my farm data'), knownIdentity);

      expect(vfarmSpy).toHaveBeenCalled();
      expect(clusterCalls().length).toBe(0);
      expect(out.body).toContain('Austin Main');
    });

    it('"How do I clean the filter?" still goes to the BHARAG knowledge lane', async () => {
      const vfarmSpy = vi.spyOn(VfarmConnector, 'getUnitStatus');

      await IntentRouter.routeAndHandle(msg('How do I clean the filter?'), knownIdentity);

      expect(vfarmSpy).not.toHaveBeenCalled();
      expect(clusterCalls().length).toBeGreaterThan(0);
    });

    it('an unknown caller asking for farm status gets no farm read', async () => {
      const vfarmSpy = vi.spyOn(VfarmConnector, 'getUnitStatus');

      await IntentRouter.routeAndHandle(msg("What's the status of my farm?"), unknownIdentity);

      // The unknown-caller gate answers before any connector is reached.
      expect(vfarmSpy).not.toHaveBeenCalled();
      expect(clusterCalls().length).toBe(0);
    });
  });
});

describe('farm response integrity', () => {
  beforeEach(() => {
    DbClient.clearAll();
    seedTestCustomers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/health')) return { ok: true, status: 200, json: async () => FARM_HEALTH } as Response;
      if (String(url).includes('/devices')) return { ok: true, status: 200, json: async () => DEVICE_LIST } as Response;
      return { ok: true, json: async () => ({}) } as Response;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not present overlapping counters as if they were independent categories', async () => {
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    // Provide a live client whose methods return the upstream contract data,
    // so the REAL getFarmStatusForSpeaker runs against it.
    (adapter as any).liveClient = {
      getFarmHealth: async () => FARM_HEALTH,
      listAllDevices: async () => DEVICE_LIST,
      listOpenAlerts: async () => ({ alerts: [], total: 0 }),
      ensureAdminToken: async () => 'tok',
    };
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);

    const res = await VfarmConnector.getUnitStatus(
      'cust_vfarm_001_john_doe',
      { farm_id: FARM, unit_id: undefined, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      {
        customer_ref: 'u1', organization_id: 'tenant-vfarm-01', tenant_id: 'tenant-vfarm-01',
        system_id: 'system-vfarm-01', workspace_id: 'ws-vfarm-main', is_known_customer: true,
        role: 'manager', permissions: [], unit_context: { farm_id: FARM, role: 'manager' },
      } as any,
    );

    // The farm NAME is the one upstream reported, not a guess.
    expect(res.text).toContain('Austin Main');
    // The status is upstream's own verdict, upper-cased, never inferred.
    expect(res.text).toContain('CRITICAL');
    // The counters are upstream's.
    expect(res.text).toContain('26 devices');
    expect(res.text).toContain('19 online');
    expect(res.text).toContain('6 offline');
    // 19 + 6 = 25 of 26 — the remainder is named as its own bucket rather
    // than folded into online or offline.
    expect(res.text).toContain('1 with an unknown status');
    // "unhealthy" OVERLAPS the online/offline split upstream, so it is
    // phrased as a flag on devices already counted, never as a fourth
    // disjoint category. 19 + 6 + 10 would be 35 of 26.
    expect(res.text).toContain('Of those, 10 are flagged unhealthy.');
    expect(res.text).not.toMatch(/19 online, 6 offline, 10 unhealthy/);
  });

  it('a farm with zero devices is described honestly and invents nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/health')) {
        return { ok: true, status: 200, json: async () => ({
          farm_id: FARM, farm_name: 'Empty Farm', status: 'neutral', device_count: 0,
          online_count: 0, offline_count: 0, unhealthy_count: 0,
        }) } as Response;
      }
      if (String(url).includes('/devices')) {
        return { ok: true, status: 200, json: async () => ({ devices: [], total: 0, online_count: 0, offline_count: 0, unhealthy_count: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    (adapter as any).liveClient = {
      getFarmHealth: async () => ({ farm_id: FARM, farm_name: 'Empty Farm', status: 'neutral', device_count: 0, online_count: 0, offline_count: 0, unhealthy_count: 0 }),
      listAllDevices: async () => ({ devices: [], total: 0, online_count: 0, offline_count: 0, unhealthy_count: 0 }),
      listOpenAlerts: async () => ({ alerts: [], total: 0 }),
      ensureAdminToken: async () => 'tok',
    };
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);

    const res = await VfarmConnector.getUnitStatus(
      'cust_u1',
      { farm_id: FARM, unit_id: undefined, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      {
        customer_ref: 'u1', organization_id: 'tenant-vfarm-01', tenant_id: 'tenant-vfarm-01',
        system_id: 'system-vfarm-01', workspace_id: 'ws-vfarm-main', is_known_customer: true,
        role: 'manager', permissions: [], unit_context: { farm_id: FARM, role: 'manager' },
      } as any,
    );

    expect(res.text).toContain('Empty Farm');
    expect(res.text).toContain('0 devices');
    // No temperature, no humidity, no reading is invented.
    expect(res.text).not.toMatch(/°C|humidity|temperature/i);
    expect(res.text).not.toMatch(/\d+(\.\d+)?\s*(C|°)/);
  });

  it('an upstream failure never produces a plausible but fabricated reading, and never falls back to BHARAG', async () => {
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    (adapter as any).liveClient = {
      getFarmHealth: async () => { throw new Error('upstream 503'); },
      listAllDevices: async () => { throw new Error('upstream 503'); },
      listOpenAlerts: async () => { throw new Error('upstream 503'); },
      ensureAdminToken: async () => 'tok',
    };
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);

    const res = await VfarmConnector.getUnitStatus(
      'cust_u1',
      { farm_id: FARM, unit_id: undefined, role: 'manager', granted_farms: [FARM] } as any,
      undefined,
      'status',
      {
        customer_ref: 'u1', organization_id: 'tenant-vfarm-01', tenant_id: 'tenant-vfarm-01',
        system_id: 'system-vfarm-01', workspace_id: 'ws-vfarm-main', is_known_customer: true,
        role: 'manager', permissions: [], unit_context: { farm_id: FARM, role: 'manager' },
      } as any,
    );

    // No fabricated numbers, and no BHARAG substitution.
    expect(res.text).not.toMatch(/\d+(\.\d+)?\s*(C|°)/);
    expect(res.text).not.toContain('BHARAG');
    expect(res.telemetry?.status).toBe('telemetry_unavailable');
  });
});
