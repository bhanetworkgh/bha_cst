/**
 * Regression tests for the admin farm-grant management endpoints.
 *
 * Farm access is AUTHORITATIVE upstream: vFarm owns farm membership, so a
 * grant is made through `POST /api/v1/farms/grants` and CST stores nothing of
 * its own. These endpoints expose that mechanism in the admin Farm Grants
 * console so an operator does not have to call the vFarm API by hand.
 *
 * The contract was taken from the DEPLOYED vFarm OpenAPI
 * (`GET /openapi.json`):
 *   POST   /api/v1/farms/grants  -> BulkGrantRequest  { user_id, role_id, farm_ids }
 *   DELETE /api/v1/farms/grants  -> BulkRevokeRequest { user_id, farm_ids }
 *   role_id is `^(operator|viewer)$` — there is NO farm-level `owner` role.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

const USER_ID = 'debf555c-b37d-4e92-bb15-597e169f1b38';
const FARM_ID = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';

describe('Admin farm-grant management (authoritative upstream grants)', () => {
  const app = createApp();
  const grant = vi.fn();
  const revoke = vi.fn();

  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    vi.restoreAllMocks();
    grant.mockReset();
    revoke.mockReset();
    grant.mockResolvedValue({ grants: [{ farm_id: FARM_ID, role: 'operator' }], total: 1 });
    revoke.mockResolvedValue({ grants: [], total: 0 });

    // A mock live client: the transport to vFarm is the ONLY thing stubbed, so
    // the route's own validation and wiring are exercised for real.
    const mockLiveClient = {
      grantUserFarmRoles: grant,
      revokeUserFarmRoles: revoke,
    };
    const adapter = new VfarmTenantAdapter('tenant-vfarm-01');
    (adapter as any).getLiveClient = () => mockLiveClient;
    // The admin token is acquired from env; stub it so the test never performs
    // a real upstream login.
    (adapter as any).ensureAdminToken = vi.fn(async () => 'jwt_test_token');
    CoreRegistry.registerTenant(
      {
        tenant_id: 'tenant-vfarm-01',
        name: 'vFarm Vertical',
        adapter_type: 'vfarm',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
      },
      adapter
    );
  });

  it('grants a farm role through the upstream vFarm API', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/vfarm/users/${USER_ID}/farm-grants`)
      .send({ role_id: 'operator', farm_ids: [FARM_ID] });

    expect(res.status).toBe(201);
    expect(grant).toHaveBeenCalledWith(USER_ID, 'operator', [FARM_ID], 'jwt_test_token');
    expect(res.body.farm_ids).toEqual([FARM_ID]);
  });

  it('rejects a farm-level owner role — there is no such upstream role', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/vfarm/users/${USER_ID}/farm-grants`)
      .send({ role_id: 'owner', farm_ids: [FARM_ID] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
    expect(res.body.message).toMatch(/operator|viewer/);
    // Never forwarded upstream.
    expect(grant).not.toHaveBeenCalled();
  });

  it('rejects an empty farm list', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/vfarm/users/${USER_ID}/farm-grants`)
      .send({ role_id: 'operator', farm_ids: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
    expect(grant).not.toHaveBeenCalled();
  });

  it('rejects a request with no user id', async () => {
    const res = await request(app)
      .post('/api/v1/admin/vfarm/users//farm-grants')
      .send({ role_id: 'operator', farm_ids: [FARM_ID] });

    expect([400, 404]).toContain(res.status);
    expect(grant).not.toHaveBeenCalled();
  });

  it('revokes farm access through the upstream vFarm API', async () => {
    const res = await request(app)
      .delete(`/api/v1/admin/vfarm/users/${USER_ID}/farm-grants`)
      .send({ farm_ids: [FARM_ID] });

    expect(res.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(USER_ID, [FARM_ID], 'jwt_test_token');
  });

  it('never echoes the upstream credential in the response', async () => {
    const res = await request(app)
      .post(`/api/v1/admin/vfarm/users/${USER_ID}/farm-grants`)
      .send({ role_id: 'viewer', farm_ids: [FARM_ID] });

    expect(res.status).toBe(201);
    const body = JSON.stringify(res.body || {});
    expect(body).not.toContain('jwt_test_token');
    expect(body).not.toContain('Bearer');
  });
});
