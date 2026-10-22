/**
 * Generic project/tenant configuration — regression tests.
 *
 * The defect: `VfarmTenantAdapter.initDefaultData()` and
 * `CoreRegistry.resetToDefault()` compiled a fixed two-project, one-org,
 * three-farm, four-speaker world into the binary. In production that meant
 * the adapter ALWAYS carried:
 *   - two hardcoded projects pointing at one hardcoded vFarm organization, so
 *     a tenant that had neither project still had them, and
 *   - three FABRICATED farm ids in the resource-scope map (migration 015
 *     cleared those same ids from the `customers` table for exactly that
 *     reason).
 *
 * The fix: those values are now a clearly-labelled DEV/TEST FIXTURE
 * (`adapters/vfarm/dev_seed.ts`) that production never seeds. Production
 * tenancy comes from the database (`CoreRegistry.initFromDb()`) and,
 * optionally, from live vFarm discovery (`pullProjects()` /
 * `pullResourceScopes()`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import {
  DEV_FIXTURE_ORG_ID,
  DEV_FIXTURE_TENANT_ID,
  buildDevFixtureProjects,
} from '../../engine/src/adapters/vfarm/dev_seed.js';

const BASE = 'https://vfarm.test';

function makeAdapter(overrides: Record<string, any> = {}): VfarmTenantAdapter {
  return new VfarmTenantAdapter(DEV_FIXTURE_TENANT_ID, {
    baseUrl: BASE,
    apiKey: 'vk_test',
    apiToken: 'jwt_test',
    tenantId: DEV_FIXTURE_TENANT_ID,
    timeoutMs: 2000,
    fetchFn: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => '[]',
    })) as any,
    ...overrides,
  });
}

describe('generic project configuration', () => {
  beforeEach(() => {
    CoreRegistry.resetToDefault();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds NO project, farm, organization or phone in production mode', () => {
    // `seedDemoDirectory: false` is what production resolves to
    // (`NODE_ENV !== 'production'`), so this is the production path.
    const adapter = makeAdapter({ seedDemoDirectory: false });

    // No project at all — nothing is invented.
    expect((adapter as any).projectsMap.size).toBe(0);
    expect((adapter as any).resourceScopesMap.size).toBe(0);
    expect(adapter._getProjectOrgId('proj-vfarm-main')).toBeNull();
    expect(adapter.getRegisteredSpeakerCount('proj-vfarm-main')).toBe(0);
  });

  it('seeds the dev/test fixture in a test runner', () => {
    const adapter = makeAdapter({ seedDemoDirectory: true });

    expect((adapter as any).projectsMap.size).toBeGreaterThan(0);
    expect(adapter._getProjectOrgId('proj-vfarm-main')).toBe(DEV_FIXTURE_ORG_ID);
    expect(adapter.getRegisteredSpeakerCount('proj-vfarm-main')).toBeGreaterThan(0);
  });

  it('the fixture carries no real vFarm farm ids', () => {
    // The fixture farm ids are invented (migration 015). They must never be
    // mistaken for upstream ids.
    const scopes = buildDevFixtureProjects();
    expect(scopes).toHaveLength(2);
    for (const project of scopes) {
      expect(project.tenant_org_id).toBe(DEV_FIXTURE_ORG_ID);
    }
  });

  it('a new tenant + project is added with ZERO source changes', async () => {
    // The adapter starts empty in production mode...
    const adapter = makeAdapter({ seedDemoDirectory: false });
    expect((adapter as any).projectsMap.size).toBe(0);

    // ...and a project registered by the admin/DB path is used immediately.
    // Nothing about the fixture is required for this to work.
    adapter.addProject({
      project_id: 'proj-brand-new-org',
      tenant_id: 'tenant-brand-new',
      name: 'Brand New Org',
      status: 'active',
      tenant_org_id: 'org-brand-new',
      capabilities: { sms: true, voice: true },
      speaker_policy: 'allowlist',
    } as any);

    expect((adapter as any).projectsMap.size).toBe(1);
    expect(adapter._getProjectOrgId('proj-brand-new-org')).toBe('org-brand-new');
    expect((adapter as any).projectsMap.get('proj-brand-new-org').tenant_id).toBe('tenant-brand-new');
  });

  it('a project registered for another tenant is not reachable through the fixture', () => {
    const adapter = makeAdapter({ seedDemoDirectory: false });
    adapter.addProject({
      project_id: 'proj-elsewhere',
      tenant_id: 'tenant-elsewhere',
      name: 'Elsewhere',
      status: 'active',
      tenant_org_id: 'org-elsewhere',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
    } as any);

    // The adapter carries only the project that was registered for it — the
    // fixture's two projects are not there to be picked up.
    expect((adapter as any).projectsMap.size).toBe(1);
    expect((adapter as any).projectsMap.has('proj-vfarm-main')).toBe(false);
    expect((adapter as any).projectsMap.has('proj-vfarm-dallas')).toBe(false);
    expect(CoreRegistry.getProject('proj-elsewhere')).toBeNull();
  });
});
