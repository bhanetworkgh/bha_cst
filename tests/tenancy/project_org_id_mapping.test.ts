/**
 * Regression tests for the `tenant_org_id` project-mapping fix.
 *
 * Bug (see docs/2026-09-17-cst-work-summary.md audit, item #1):
 *   VfarmTenantAdapter._getProjectOrgId() only ever read from the adapter's
 *   own private `projectsMap`, which was populated exclusively by
 *   initDefaultData()'s two hardcoded projects (Austin/Dallas). Neither
 *   CoreRegistry.registerProject() nor CoreRegistry.initFromDb() pushed
 *   DB-loaded projects (with a real tenant_org_id) into the adapter, so
 *   any project beyond the two defaults could never be org-id-resolved
 *   by the adapter (e.g. for its live pullSpeakers() org-members lookup).
 *
 * Fix: ITenantAdapter gained an optional `addProject(project)` method
 * (already implemented on VfarmTenantAdapter); CoreRegistry.registerProject()
 * and CoreRegistry.initFromDb() now call `adapter.addProject(project)` for
 * the project's owning tenant so the adapter's in-memory projection always
 * reflects the latest registry/DB state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { Project, Tenant } from '../../engine/src/core/types.js';

// Exercise the private lookup the way `pullSpeakers`/live-mode code does,
// without relying on a live HTTP client. `_getProjectOrgId` is private on
// the class, so we reach it via a narrow cast rather than changing its
// visibility (no API surface should change beyond the new addProject hook).
function getProjectOrgId(adapter: VfarmTenantAdapter, projectId: string): string | null {
    return (adapter as unknown as { _getProjectOrgId(id: string): string | null })._getProjectOrgId(projectId);
}

describe('tenant_org_id project mapping (CoreRegistry -> VfarmTenantAdapter)', () => {
    beforeEach(() => {
        DbClient.clearAll();
        DbClient.resetDurableStores();
        CoreRegistry.clear();
        CoreRegistry.resetToDefault();
    });

    it('reflects the two hardcoded default projects out of the box (baseline, unchanged behavior)', () => {
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
        expect(getProjectOrgId(adapter, 'proj-vfarm-main')).toBe('org-vfarm-austin');
        expect(getProjectOrgId(adapter, 'proj-vfarm-dallas')).toBe('org-vfarm-dallas');
    });

    it('registerProject() pushes a brand-new project + tenant_org_id into the adapter (was previously invisible)', () => {
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;

        // Before the fix: the adapter has never heard of this project.
        expect(getProjectOrgId(adapter, 'proj-vfarm-houston')).toBeNull();

        const houston: Project = {
            project_id: 'proj-vfarm-houston',
            tenant_id: 'tenant-vfarm-01',
            name: 'vFarm Houston Site',
            status: 'active',
            tenant_org_id: 'org-vfarm-houston',
            capabilities: { sms: true },
            speaker_policy: 'allowlist',
        };
        CoreRegistry.registerProject(houston);

        // After the fix: adapter._getProjectOrgId reflects the registry state.
        expect(getProjectOrgId(adapter, 'proj-vfarm-houston')).toBe('org-vfarm-houston');
        // Registry itself remains the source of truth as before.
        expect(CoreRegistry.getProject('proj-vfarm-houston')?.tenant_org_id).toBe('org-vfarm-houston');
    });

    it('registerProject() propagates an updated tenant_org_id for an already-known project', () => {
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
        expect(getProjectOrgId(adapter, 'proj-vfarm-main')).toBe('org-vfarm-austin');

        const updated: Project = {
            ...(CoreRegistry.getProject('proj-vfarm-main') as Project),
            tenant_org_id: 'org-vfarm-austin-v2',
        };
        CoreRegistry.registerProject(updated);

        expect(getProjectOrgId(adapter, 'proj-vfarm-main')).toBe('org-vfarm-austin-v2');
    });

    it('does not affect projects belonging to a different tenant (no cross-tenant leakage)', () => {
        // A non-vFarm tenant/adapter has no addProject method — registerProject
        // must not throw and must not touch the vFarm adapter's map.
        const otherTenant: Tenant = {
            tenant_id: 'tenant-other-01',
            name: 'Other Co',
            status: 'active',
            adapter_type: 'custom',
            created_at: new Date().toISOString(),
        };
        CoreRegistry.registerTenant(otherTenant); // no adapter passed

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
        // Simulate a project that was created/updated in a prior process and
        // persisted to the DB, but is unknown to a freshly booted registry/adapter.
        const dbOnlyProject: Project = {
            project_id: 'proj-vfarm-phoenix',
            tenant_id: 'tenant-vfarm-01',
            name: 'vFarm Phoenix Site',
            status: 'active',
            tenant_org_id: 'org-vfarm-phoenix',
            capabilities: { sms: true },
            speaker_policy: 'allowlist',
        };
        await DbClient.saveProject(dbOnlyProject);

        // Fresh boot: clear in-memory registry state (as a new process would
        // start), then rehydrate strictly from the DB via initFromDb().
        CoreRegistry.clear();
        await CoreRegistry.initFromDb();

        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
        expect(adapter).toBeTruthy();
        expect(CoreRegistry.getProject('proj-vfarm-phoenix')?.tenant_org_id).toBe('org-vfarm-phoenix');
        // This is the actual bug: previously this returned null because
        // initFromDb() never called adapter.addProject().
        expect(getProjectOrgId(adapter, 'proj-vfarm-phoenix')).toBe('org-vfarm-phoenix');
    });

    it('adapter.pullProjects() is unaffected (still returns the adapter local set, not touched by this fix)', async () => {
        const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
        const projects = await adapter.pullProjects('tenant-vfarm-01');
        const ids = projects.map((p) => p.project_id);
        expect(ids).toContain('proj-vfarm-main');
        expect(ids).toContain('proj-vfarm-dallas');
    });
});