/**
 * Item 1 — vFarm organization -> CST project and farm -> resource scope sync.
 *
 * Both `pullProjects()` and `pullResourceScopes()` are adapter-contract methods
 * that previously returned static CST fixtures with a comment claiming no
 * upstream endpoint existed. They now perform real synchronization using only
 * endpoints already present in the verified vFarm client/OpenAPI contract:
 *
 *   GET /api/v1/organizations                -> VfarmLiveClient.listOrganizations
 *   GET /api/v1/farms?org_id={org_id}        -> VfarmLiveClient.listOrgFarms
 *
 * No endpoint is invented here; these tests assert the adapter calls exactly
 * those two methods.
 */
import { describe, it, expect, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { VfarmLiveClient } from '../../engine/src/adapters/vfarm/live_client.js';

const TENANT_ID = 'tenant-vfarm-01';
const REAL_ORG_ID = '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';
const OTHER_ORG_ID = 'a4c0b1e2-0000-4000-8000-000000000001';

function makeAdapter() {
  return new VfarmTenantAdapter(TENANT_ID, {
    baseUrl: 'https://vfarm.test',
    apiKey: 'vk',
    apiToken: 'jwt-token',
  });
}

describe('pullProjects() — real vFarm organization -> CST project synchronization', () => {
  it('maps each vFarm organization to a CST project carrying the real org UUID', async () => {
    const adapter = makeAdapter();
    const listOrganizations = vi
      .spyOn(adapter.getLiveClient() as VfarmLiveClient, 'listOrganizations')
      .mockResolvedValue({
        organizations: [
          { id: REAL_ORG_ID, slug: 'default', name: 'vFarm Global', is_active: true },
          { id: OTHER_ORG_ID, slug: 'second', name: 'Second Site', is_active: false },
        ],
        total: 2,
      } as any);

    const projects = await adapter.pullProjects(TENANT_ID);

    expect(listOrganizations).toHaveBeenCalledTimes(1);
    expect(projects).toHaveLength(2);

    const main = projects.find((p) => p.tenant_org_id === REAL_ORG_ID)!;
    const second = projects.find((p) => p.tenant_org_id === OTHER_ORG_ID)!;

    expect(main).toBeDefined();
    expect(second).toBeDefined();

    // tenant_org_id is the authoritative vFarm org id — never a placeholder.
    expect(main.tenant_org_id).toBe(REAL_ORG_ID);
    expect(main.name).toBe('vFarm Global');
    expect(main.status).toBe('active');
    expect(main.tenant_id).toBe(TENANT_ID);
    expect(main.synced_at).toBeTruthy();

    // An inactive upstream org suspends the CST project (fail closed).
    expect(second.status).toBe('suspended');

    // No CST placeholder may survive the sync.
    for (const p of projects) {
      expect(p.tenant_org_id).not.toBe('org-vfarm-austin');
      expect(p.tenant_org_id).not.toBe('org-vfarm-dallas');
      expect(p.tenant_org_id).not.toBe('org-vfarm-main');
    }
  });

  it('keeps the existing CST project_id for an org so renames do not orphan the project', async () => {
    const adapter = makeAdapter();
    const listOrganizations = vi
      .spyOn(adapter.getLiveClient() as VfarmLiveClient, 'listOrganizations')
      .mockResolvedValue({
        organizations: [{ id: REAL_ORG_ID, slug: 'default', name: 'vFarm Global', is_active: true }],
        total: 1,
      } as any);

    const before = (await adapter.pullProjects(TENANT_ID)).find(
      (p) => p.tenant_org_id === REAL_ORG_ID
    );
    expect(before).toBeDefined();

    listOrganizations.mockResolvedValue({
      organizations: [{ id: REAL_ORG_ID, slug: 'default', name: 'vFarm Renamed Ltd', is_active: true }],
      total: 1,
    } as any);

    const after = await adapter.pullProjects(TENANT_ID);
    const renamed = after.find((p) => p.tenant_org_id === REAL_ORG_ID)!;

    expect(renamed.project_id).toBe(before!.project_id);
    expect(renamed.name).toBe('vFarm Renamed Ltd');
  });

  it('fails closed (throws) instead of replacing every mapping with an empty projection', async () => {
    const adapter = makeAdapter();
    vi.spyOn(adapter.getLiveClient() as VfarmLiveClient, 'listOrganizations').mockRejectedValue(
      new Error('upstream 503')
    );

    await expect(adapter.pullProjects(TENANT_ID)).rejects.toThrow('upstream 503');
  });

  it('returns the CST-configured projection in local mode (no live calls)', async () => {
    const adapter = new VfarmTenantAdapter(TENANT_ID, {});
    expect(adapter.hasLiveClient()).toBe(false);
    const projects = await adapter.pullProjects(TENANT_ID);
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.every((p) => p.tenant_org_id === REAL_ORG_ID)).toBe(true);
  });

  it('returns nothing for a tenant it does not manage', async () => {
    const adapter = makeAdapter();
    expect(await adapter.pullProjects('tenant-not-mine')).toEqual([]);
  });
});

describe('pullResourceScopes() — real vFarm farm -> CST resource scope synchronization', () => {
  it('projects the org-scoped vFarm farm list into CST resource scopes', async () => {
    const adapter = makeAdapter();
    const listOrgFarms = vi
      .spyOn(adapter.getLiveClient() as VfarmLiveClient, 'listOrgFarms')
      .mockResolvedValue({
        farms: [
          { id: 'farm-live-001', name: 'Test 001', code: 'VF-01', org_id: REAL_ORG_ID, is_active: true },
          { id: 'farm-live-002', name: 'v-farm', org_id: REAL_ORG_ID, is_active: true },
        ],
        total: 2,
      } as any);

    const scopes = await adapter.pullResourceScopes(TENANT_ID, 'proj-vfarm-main');

    expect(listOrgFarms).toHaveBeenCalledTimes(1);
    // The organization filter comes from the project's authoritative tenant_org_id.
    expect(listOrgFarms.mock.calls[0][0]).toBe(REAL_ORG_ID);

    expect(scopes.map((s) => s.id)).toEqual(['farm-live-001', 'farm-live-002']);
    expect(scopes[0].type).toBe('farm');
    expect(scopes[0].name).toBe('Test 001');
    expect(scopes[0].metadata).toMatchObject({ code: 'VF-01', org_id: REAL_ORG_ID });
  });

  it('a second sync reflects upstream farm changes (no stale static fixture list)', async () => {
    const adapter = makeAdapter();
    const client = adapter.getLiveClient() as VfarmLiveClient;

    vi.spyOn(client, 'listOrgFarms').mockResolvedValueOnce({
      farms: [{ id: 'farm-old', name: 'Old Farm', org_id: REAL_ORG_ID }],
      total: 1,
    } as any);
    expect((await adapter.pullResourceScopes(TENANT_ID, 'proj-vfarm-main')).map((s) => s.id)).toEqual([
      'farm-old',
    ]);

    vi.spyOn(client, 'listOrgFarms').mockResolvedValueOnce({
      farms: [{ id: 'farm-new', name: 'New Farm', org_id: REAL_ORG_ID }],
      total: 1,
    } as any);
    expect((await adapter.pullResourceScopes(TENANT_ID, 'proj-vfarm-main')).map((s) => s.id)).toEqual([
      'farm-new',
    ]);
  });

  it('keeps the last known scopes when the farm read fails (authorization never depends on them)', async () => {
    const adapter = makeAdapter();
    const client = adapter.getLiveClient() as VfarmLiveClient;

    vi.spyOn(client, 'listOrgFarms').mockResolvedValueOnce({
      farms: [{ id: 'farm-keep', name: 'Keep Me', org_id: REAL_ORG_ID }],
      total: 1,
    } as any);
    await adapter.pullResourceScopes(TENANT_ID, 'proj-vfarm-main');

    vi.spyOn(client, 'listOrgFarms').mockRejectedValueOnce(new Error('vFarm timeout'));
    const scopes = await adapter.pullResourceScopes(TENANT_ID, 'proj-vfarm-main');
    expect(scopes.map((s) => s.id)).toEqual(['farm-keep']);
  });

  it('does not call upstream for a project with no tenant_org_id', async () => {
    const adapter = makeAdapter();
    adapter.addProject({
      project_id: 'proj-no-org',
      tenant_id: TENANT_ID,
      name: 'No org mapping',
      status: 'active',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    });
    const listOrgFarms = vi.spyOn(adapter.getLiveClient() as VfarmLiveClient, 'listOrgFarms');

    expect(await adapter.pullResourceScopes(TENANT_ID, 'proj-no-org')).toEqual([]);
    expect(listOrgFarms).not.toHaveBeenCalled();
  });

  it('returns nothing for a tenant it does not manage', async () => {
    const adapter = makeAdapter();
    expect(await adapter.pullResourceScopes('tenant-not-mine', 'proj-vfarm-main')).toEqual([]);
  });
});
