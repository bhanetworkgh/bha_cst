import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import type { SpeakerIdentity } from '../../engine/src/core/types.js';
import { DbClient } from '../../engine/src/db/client.js';

const FARM_ID = 'farm-health-surface';
const speaker = {
  person_id: 'user-1',
  customer_ref: 'user-1',
  tenant_id: 'tenant-vfarm-01',
  project_id: 'proj-vfarm-main',
  phone_e164: '+15550000000',
  is_known: true,
  role: 'manager',
  permissions: [],
  farm_ids: [FARM_ID],
} as SpeakerIdentity;

function registerAdapter(health: () => Promise<any>) {
  const adapter = new VfarmTenantAdapter('tenant-vfarm-01', {
    baseUrl: 'https://mock.vfarm.test',
    apiKey: 'not-a-real-credential',
  });
  (adapter as any).getDiscoveredFarmIds = () => [FARM_ID];
  (adapter as any).liveClient = {
    getFarmHealth: vi.fn(health),
    listAllDevices: vi.fn().mockResolvedValue({
      devices: [],
      total: 0,
      online_count: 0,
      offline_count: 0,
      unhealthy_count: 0,
      fleet_counts: { total: 0, on: 0, off: 0, online: 0, unhealthy: 0, offline: 0 },
    }),
    listLatestReadings: vi.fn().mockResolvedValue([]),
    listOpenAlerts: vi.fn().mockResolvedValue({ alerts: [], total: 0 }),
  };
  CoreRegistry.registerTenant({
    tenant_id: 'tenant-vfarm-01',
    name: 'vFarm',
    status: 'active',
    adapter_type: 'vfarm',
    created_at: new Date().toISOString(),
  }, adapter);
  return adapter;
}

async function renderFarmHealth(health: () => Promise<any>) {
  const adapter = registerAdapter(health);
  const status = await adapter.getFarmStatusForSpeaker({ farmId: FARM_ID, speaker });
  const rendered = await VfarmConnector.getUnitStatus(
    'user-1',
    { farm_id: FARM_ID },
    undefined,
    'status',
    speaker,
  );
  return { status, rendered };
}

describe('vFarm health normalization reaches text/voice output', () => {
  beforeEach(() => {
    CoreRegistry.clear();
    DbClient.clearAll();
  });

  it.each([
    ['healthy', 'HEALTHY'],
    ['unhealthy', 'UNHEALTHY'],
    ['critical', 'DEGRADED'],
    [undefined, 'UNKNOWN'],
  ])('normalizes %s and renders %s without using the health score', async (raw, expected) => {
    const { status, rendered } = await renderFarmHealth(async () => ({
      status: raw,
      health_score: 99,
    }));
    expect(status?.status.toUpperCase()).toBe(expected);
    expect(status?.health_score).toBe(99);
    expect(rendered.text).toContain(`vFarm farm health: ${expected}.`);
    expect(rendered.text).not.toContain('vFarm farm health: CRITICAL.');
    expect(rendered.telemetry?.status).toBe(
      raw === 'healthy' ? 'normal' : raw === 'unhealthy' ? 'fault' : 'telemetry_unavailable',
    );
  });

  it('renders a failed health request as degraded when device inventory remains available', async () => {
    const { status, rendered } = await renderFarmHealth(async () => {
      throw new Error('upstream 503');
    });
    expect(status?.status).toBe('degraded');
    expect(status?.raw_status).toBeNull();
    expect(rendered.text).toContain('vFarm farm health: DEGRADED.');
    expect(rendered.text).not.toContain('vFarm farm health: HEALTHY.');
    expect(rendered.telemetry?.status).toBe('telemetry_unavailable');
  });

  it('returns no reading in local/no-client mode instead of fabricated telemetry', async () => {
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01', { seedDemoDirectory: false });
    (adapter as any).getDiscoveredFarmIds = () => [FARM_ID];
    const reading = await adapter.getLatestDeviceReading({
      farmId: FARM_ID,
      deviceId: 'rack1_soil',
      speaker,
    });
    expect(reading).toBeNull();
  });
});
