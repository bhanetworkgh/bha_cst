/**
 * Admin speaker sync — the two deactivation outcomes.
 *
 * `POST /api/v1/admin/speakers/sync` reconciles CST's customer projection
 * against the live vFarm organization member list. A row that the upstream
 * no longer contains has to leave the Admin Panel, but there are TWO very
 * different reasons for that, and they must not be treated the same way:
 *
 *   (a) The stored reference IS a vFarm identifier and the user is no longer
 *       a member. The upstream really revoked them, so the binding is stale
 *       and the row is REMOVED.
 *
 *   (b) The stored reference is not a vFarm identifier at all — a phone
 *       number stored where the vFarm user id belongs. Such a row was never
 *       an upstream member, so it cannot have been "revoked", and vFarm
 *       cannot supply the mapping because it exposes no phone field on a
 *       user. Removing the row destroys the only record of which customer
 *       the number belongs. It is DEACTIVATED, not deleted, and reported
 *       separately so the operator can repair it.
 *
 * Case (b) is the production incident: a caller with a complete customer
 * record (owner role, two farm scopes) was refused farm data because the
 * stored reference could not match any upstream member.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';

const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_ID = 'proj-vfarm-main';
const ORG_ID = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';

function jsonResponse(status: number, body: unknown): any {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function member(user_id: string, name: string, role: string) {
  return {
    user_id,
    email: `${user_id}@vfarm.test`,
    name,
    role,
    granted_by: null,
    granted_at: '2026-01-01T00:00:00Z',
  };
}

function makeLiveAdapter(state: { members: any[]; grantsByUser: Record<string, string[]> }) {
  const mockFetch = vi.fn(async (url: string) => {
    if (url.includes(`/organizations/${ORG_ID}/users`)) {
      return jsonResponse(200, state.members);
    }
    const grantMatch = url.match(/\/users\/([^/]+)\/farm-grants/);
    if (grantMatch) {
      const farms = state.grantsByUser[decodeURIComponent(grantMatch[1])] || [];
      return jsonResponse(200, farms.map((farm_id) => ({ farm_id })));
    }
    throw new Error(`Unmocked URL in test: ${url}`);
  });

  return new VfarmTenantAdapter(TENANT_ID, {
    baseUrl: 'https://vfarm.test',
    apiKey: 'test-key',
    fetchFn: mockFetch as any,
  });
}

describe('admin speakers/sync — deactivation outcomes', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });

  it('REMOVES a row whose vFarm user was genuinely revoked upstream', async () => {
    const adapter = makeLiveAdapter({ members: [member('usr_vfarm_003', 'Owner', 'owner')], grantsByUser: {} });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT_ID, name: 'vFarm Global', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    // A row whose reference IS a vFarm user id.
    await request(app)
      .post('/api/v1/admin/speakers')
      .send({
        phone_e164: '+15550000001',
        customer_ref: 'usr_vfarm_001',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        role: 'manager',
        farm_ids: ['farm_austin_main'],
      });

    const sync = await request(app)
      .post('/api/v1/admin/speakers/sync')
      .send({ tenant_id: TENANT_ID, project_id: PROJECT_ID });

    expect(sync.status).toBe(200);
    expect(sync.body.pruned_count).toBe(1);
    expect(sync.body.pruned).toContain('usr_vfarm_001');
    expect(sync.body.deactivated_count).toBe(0);

    // And the row is gone.
    const remaining = await DbClient.getAllCustomers(TENANT_ID, PROJECT_ID);
    expect(remaining.find((c: any) => c.customer_ref === 'usr_vfarm_001')).toBeUndefined();
  });

  it('PRESERVES a row whose reference is a phone number rather than a vFarm user id', async () => {
    const adapter = makeLiveAdapter({ members: [member('usr_vfarm_003', 'Owner', 'owner')], grantsByUser: {} });
    CoreRegistry.registerTenant(
      { tenant_id: TENANT_ID, name: 'vFarm Global', status: 'active', adapter_type: 'vfarm' } as any,
      adapter,
    );

    // The production shape: a complete customer record whose customer_ref is
    // the phone number instead of the vFarm user id.
    await request(app)
      .post('/api/v1/admin/speakers')
      .send({
        phone_e164: '+15550000002',
        customer_ref: '+15550000002',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        role: 'owner',
        farm_ids: ['farm_austin_main', 'farm_austin_east'],
      });

    const sync = await request(app)
      .post('/api/v1/admin/speakers/sync')
      .send({ tenant_id: TENANT_ID, project_id: PROJECT_ID });

    expect(sync.status).toBe(200);
    // It was NOT pruned as "revoked" — it was deactivated and reported.
    expect(sync.body.pruned_count).toBe(0);
    expect(sync.body.deactivated_count).toBe(1);
    expect(sync.body.deactivated).toContain('+15550000002');

    // The row SURVIVES, so the operator still has the record to repair.
    const remaining = await DbClient.getAllCustomers(TENANT_ID, PROJECT_ID);
    const row = remaining.find((c: any) => c.customer_ref === '+15550000002');
    expect(row).toBeDefined();
    expect(row.phone_e164).toBe('+15550000002');
    // And it is deactivated, so it is no longer served as an active binding.
    const expiresAt = row.speaker_cache_expires_at ? new Date(row.speaker_cache_expires_at).getTime() : null;
    expect(expiresAt).not.toBeNull();
    expect(expiresAt!).toBeLessThan(Date.now());
  });
});
