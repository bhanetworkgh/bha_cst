/**
 * Regression tests for the `tenant_org_id` project-mapping fix.
 *
 * Verifies:
 *   1. CoreRegistry.registerProject() pushes newly registered and updated projects
 *      into the owning tenant's adapter via adapter.addProject().
 *   2. CoreRegistry.initFromDb() pushes DB-loaded projects into the adapter on boot.
 *   3. VfarmTenantAdapter._getProjectOrgId() reflects the authoritative tenant_org_id
 *      from the adapter's in-memory projects projection.
 *   4. Projects belonging to other tenants do not leak into the vFarm adapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { Project, Tenant } from '../../engine/src/core/types.js';

function getProjectOrgId(adapter: VfarmTenantAdapter, projectId: string): string | null {
  return adapter._getProjectOrgId(projectId);
}

describe('tenant_org_id project mapping (CoreRegistry -> VfarmTenantAdapter)', () => {
  const defaultOrgId = process.env.VFARM_TENANT_ORG_ID || '122d8fb6-f4d3-42e9-b0d6-f2f80a6c276d';

  beforeEach(() => {
    DbClient.clearAll();
    DbClient.resetDurableStores();
    CoreRegistry.clear();
    CoreRegistry.resetToDefault();
  });

  it('reflects the default projects out of the box with real org UUID', () => {
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    expect(getProjectOrgId(adapter, 'proj-vfarm-main')).toBe(defaultOrgId);
    expect(getProjectOrgId(adapter, 'proj-vfarm-dallas')).toBe(defaultOrgId);
  });

  it('registerProject() pushes a brand-new project + tenant_org_id into the adapter', () => {
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;

    // Before registration: the adapter has not heard of this project.
    expect(getProjectOrgId(adapter, 'proj-vfarm-houston')).toBeNull();

    const houstonOrgId = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
    const houston: Project = {
      project_id: 'proj-vfarm-houston',
      tenant_id: 'tenant-vfarm-01',
      name: 'vFarm Houston Site',
      status: 'active',
      tenant_org_id: houstonOrgId,
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    };
    CoreRegistry.registerProject(houston);

    // After registration: adapter._getProjectOrgId reflects the registry state.
    expect(getProjectOrgId(adapter, 'proj-vfarm-houston')).toBe(houstonOrgId);
    expect(CoreRegistry.getProject('proj-vfarm-houston')?.tenant_org_id).toBe(houstonOrgId);
  });

  it('registerProject() propagates an updated tenant_org_id for an already-known project', () => {
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    expect(getProjectOrgId(adapter, 'proj-vfarm-main')).toBe(defaultOrgId);

    const updatedOrgId = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const updated: Project = {
      ...(CoreRegistry.getProject('proj-vfarm-main') as Project),
      tenant_org_id: updatedOrgId,
    };
    CoreRegistry.registerProject(updated);

    expect(getProjectOrgId(adapter, 'proj-vfarm-main')).toBe(updatedOrgId);
  });

  it('does not affect projects belonging to a different tenant (no cross-tenant leakage)', () => {
    const otherTenant: Tenant = {
      tenant_id: 'tenant-other-01',
      name: 'Other Co',
      status: 'active',
      adapter_type: 'custom',
      created_at: new Date().toISOString(),
    };
    CoreRegistry.registerTenant(otherTenant);

    const otherProject: Project = {
      project_id: 'proj-other-01',
      tenant_id: 'tenant-other-01',
      name: 'Other Project',
      status: 'active',
      tenant_org_id: 'org-other-01',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    };
    expect(() => CoreRegistry.registerProject(otherProject)).not.toThrow();

    const vfarmAdapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    expect(getProjectOrgId(vfarmAdapter, 'proj-other-01')).toBeNull();
  });

  it('initFromDb() loads a persisted project with tenant_org_id from the DB into the adapter on boot', async () => {
    const phoenixOrgId = '66666666-5555-4444-3333-222222222222';
    const dbOnlyProject: Project = {
      project_id: 'proj-vfarm-phoenix',
      tenant_id: 'tenant-vfarm-01',
      name: 'vFarm Phoenix Site',
      status: 'active',
      tenant_org_id: phoenixOrgId,
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    };
    await DbClient.saveProject(dbOnlyProject);

    CoreRegistry.clear();
    await CoreRegistry.initFromDb();

    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    expect(adapter).toBeTruthy();
    expect(CoreRegistry.getProject('proj-vfarm-phoenix')?.tenant_org_id).toBe(phoenixOrgId);
    expect(getProjectOrgId(adapter, 'proj-vfarm-phoenix')).toBe(phoenixOrgId);
  });

  it('adapter.pullProjects() is unaffected and returns registered projects', async () => {
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    const projects = await adapter.pullProjects('tenant-vfarm-01');
    const ids = projects.map((p) => p.project_id);
    expect(ids).toContain('proj-vfarm-main');
    expect(ids).toContain('proj-vfarm-dallas');
  });
});
