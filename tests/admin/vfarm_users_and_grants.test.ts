import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

describe('Admin vFarm Users & Authoritative Farm Grants (Tab 10 API)', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });

  it('GET /api/v1/admin/vfarm/users returns 400 when org_id is missing', async () => {
    const mockLiveClient = {
      listOrganizationMembers: vi.fn().mockResolvedValue([]),
    };
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01');
    (adapter as any).getLiveClient = () => mockLiveClient;
    CoreRegistry.registerTenant(
      { tenant_id: 'tenant-vfarm-01', name: 'vFarm Vertical', adapter_type: 'vfarm', status: 'active', created_at: '2026-01-01T00:00:00Z' },
      adapter
    );

    const res = await request(app).get('/api/v1/admin/vfarm/users');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
  });

  it('GET /api/v1/admin/vfarm/users?org_id=org-vfarm-main returns live members enriched with farm grants and CST speakers', async () => {
    const mockLiveClient = {
      listOrganizationMembers: vi.fn().mockResolvedValue([
        {
          user_id: 'usr_vfarm_001',
          email: 'jason@verticalfarms.com',
          name: 'Jason V',
          role: 'owner',
          granted_at: '2026-01-15T08:00:00Z',
        },
        {
          user_id: 'usr_vfarm_002',
          email: 'sarah@verticalfarms.com',
          name: 'Sarah M',
          role: 'technician',
          granted_at: '2026-02-10T10:00:00Z',
        },
      ]),
      getUserFarmGrants: vi.fn().mockImplementation(async (userId: string) => {
        if (userId === 'usr_vfarm_001') {
          return [
            {
              farm_id: 'farm_austin_main',
              farm_name: 'Austin Main Facility',
              role: 'owner',
              status: 'active',
              granted_at: '2026-01-15T08:00:00Z',
            },
          ];
        }
        return [];
      }),
    };

    const adapter = new VfarmTenantAdapter('tenant-vfarm-01');
    (adapter as any).getLiveClient = () => mockLiveClient;
    (adapter as any).ensureAdminToken = vi.fn().mockResolvedValue('mock-jwt-token');
    CoreRegistry.registerTenant(
      { tenant_id: 'tenant-vfarm-01', name: 'vFarm Vertical', adapter_type: 'vfarm', status: 'active', created_at: '2026-01-01T00:00:00Z' },
      adapter
    );

    // Register a local speaker in CST
    DbClient.seedCustomer({
      phone_e164: '+923082113844',
      customer_ref: 'usr_vfarm_001',
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      role: 'owner',
      farm_ids: ['farm_austin_main'],
      speaker_cache_expires_at: new Date(Date.now() + 60000).toISOString(),
    });

    const res = await request(app).get('/api/v1/admin/vfarm/users?org_id=org-vfarm-main');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.count).toBe(2);

    const user1 = res.body.customers.find((c: any) => c.user_id === 'usr_vfarm_001');
    expect(user1).toBeDefined();
    expect(user1.cst_registered).toBe(true);
    expect(user1.cst_phone_e164).toBe('+923082113844');
    expect(user1.farm_grants_count).toBe(1);
    expect(user1.vfarm_farm_ids).toContain('farm_austin_main');

    const user2 = res.body.customers.find((c: any) => c.user_id === 'usr_vfarm_002');
    expect(user2).toBeDefined();
    expect(user2.cst_registered).toBe(false);
    expect(user2.farm_grants_count).toBe(0);
  });

  it('GET /api/v1/admin/vfarm/users/:userId/farm-grants returns authoritative grants', async () => {
    const mockLiveClient = {
      getUserFarmGrants: vi.fn().mockResolvedValue([
        {
          farm_id: 'farm_austin_main',
          farm_name: 'Austin Main Facility',
          role: 'owner',
          status: 'active',
          granted_at: '2026-01-15T08:00:00Z',
        },
        {
          farm_id: 'farm_dallas_north',
          farm_name: 'Dallas North Facility',
          role: 'operator',
          status: 'active',
          granted_at: '2026-03-01T12:00:00Z',
        },
      ]),
    };

    const adapter = new VfarmTenantAdapter('tenant-vfarm-01');
    (adapter as any).getLiveClient = () => mockLiveClient;
    (adapter as any).ensureAdminToken = vi.fn().mockResolvedValue('mock-jwt-token');
    CoreRegistry.registerTenant(
      { tenant_id: 'tenant-vfarm-01', name: 'vFarm Vertical', adapter_type: 'vfarm', status: 'active', created_at: '2026-01-01T00:00:00Z' },
      adapter
    );

    const res = await request(app).get('/api/v1/admin/vfarm/users/usr_vfarm_001/farm-grants');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.user_id).toBe('usr_vfarm_001');
    expect(res.body.count).toBe(2);
    expect(res.body.grants[0].farm_id).toBe('farm_austin_main');
    expect(res.body.grants[1].farm_id).toBe('farm_dallas_north');
  });

  it('GET /api/v1/admin/vfarm/users/:userId/farm-grants returns 503 if live client is unavailable', async () => {
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01');
    (adapter as any).getLiveClient = () => null;
    CoreRegistry.registerTenant(
      { tenant_id: 'tenant-vfarm-01', name: 'vFarm Vertical', adapter_type: 'vfarm', status: 'active', created_at: '2026-01-01T00:00:00Z' },
      adapter
    );

    const res = await request(app).get('/api/v1/admin/vfarm/users/usr_vfarm_001/farm-grants');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('NO_LIVE_CLIENT');
  });
});
