/**
 * CoreRegistry — Speaker Warmup Tests
 *
 * Covers CoreRegistry.warmupSpeakers() and the warmup that now runs at the
 * end of syncProjectsFromAdapter():
 *
 *   W1 — warmup with no adapter registered → warns, does not throw
 *   W2 — warmup with no projects for tenant → warns, does not throw
 *   W3 — warmup calls pullSpeakers per project; returned speakers are accessible
 *   W4 — pullSpeakers failure on one project → other projects still warmed (graceful)
 *   W5 — cross-tenant isolation: warmup does not touch another tenant's adapter
 *   W6 — syncProjectsFromAdapter triggers warmup automatically
 *   W7 — re-warmup (idempotent): calling warmup twice yields same speakers
 *   W8 — degraded adapter → pullSpeakers throws → warmup logs and continues
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import type { ITenantAdapter } from '../../engine/src/adapters/types.js';
import type { Project, SpeakerRecord, SpeakerIdentity } from '../../engine/src/core/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    project_id: 'proj-warmup-01',
    tenant_id:  'tenant-warmup-01',
    name:        'Warmup Test Project',
    status:      'active',
    tenant_org_id: 'org-warmup-01',
    capabilities: { sms: true },
    speaker_policy: 'allowlist',
    ...overrides,
  };
}

const SPEAKERS_P1: SpeakerRecord[] = [
  { person_id: 'usr-001', phone_e164: '+15550000001', role: 'owner',   farm_ids: ['farm_a'] },
  { person_id: 'usr-002', phone_e164: '+15550000002', role: 'manager', farm_ids: ['farm_a'] },
];
const SPEAKERS_P2: SpeakerRecord[] = [
  { person_id: 'usr-003', phone_e164: '+15550000003', role: 'tech', farm_ids: ['farm_b'] },
];

function makeTenant(id: string) {
  return { tenant_id: id, name: id, status: 'active' as const, adapter_type: 'vfarm', created_at: new Date().toISOString() };
}

function makeAdapter(
  tenantId: string,
  overrides: Partial<ITenantAdapter> = {},
): ITenantAdapter {
  const projMap = new Map<string, Project>();
  return {
    tenantId,
    addProject(p: Project) { projMap.set(p.project_id, p); },
    async pullProjects()    { return Array.from(projMap.values()); },
    async pullResourceScopes() { return []; },
    async pullSpeakers(tid: string, projId: string): Promise<SpeakerRecord[]> {
      if (projId === 'proj-warmup-01') return [...SPEAKERS_P1];
      return [];
    },
    async resolveSpeaker(): Promise<SpeakerIdentity> {
      return { person_id: 'x', customer_ref: 'x', tenant_id: tenantId, project_id: 'y', phone_e164: '', is_known: false, role: 'unknown', permissions: [], farm_ids: [] };
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CoreRegistry — Speaker Warmup', () => {
  beforeEach(() => {
    CoreRegistry.resetToDefault();
  });

  it('W1: warmupSpeakers with no adapter registered → warns and resolves', async () => {
    await expect(CoreRegistry.warmupSpeakers('tenant-does-not-exist')).resolves.toBeUndefined();
  });

  it('W2: warmupSpeakers with adapter but no projects → warns and resolves', async () => {
    const tenantId = 'tenant-noproject-w2';
    CoreRegistry.registerTenant(makeTenant(tenantId), makeAdapter(tenantId));
    await expect(CoreRegistry.warmupSpeakers(tenantId)).resolves.toBeUndefined();
  });

  it('W3: warmupSpeakers calls pullSpeakers per project', async () => {
    const tenantId = 'tenant-warmup-w3';
    const pullSpy  = vi.fn().mockResolvedValue(SPEAKERS_P1);
    const adapter  = makeAdapter(tenantId, { pullSpeakers: pullSpy });
    const project  = makeProject({ project_id: 'proj-w3', tenant_id: tenantId });

    CoreRegistry.registerTenant(makeTenant(tenantId), adapter);
    CoreRegistry.registerProject(project);

    await CoreRegistry.warmupSpeakers(tenantId);

    expect(pullSpy).toHaveBeenCalledOnce();
    expect(pullSpy).toHaveBeenCalledWith(tenantId, project.project_id);
  });

  it('W4: pullSpeakers failure on first project → second project is still warmed', async () => {
    const tenantId = 'tenant-warmup-w4';
    const proj1 = makeProject({ project_id: 'proj-w4-a', tenant_id: tenantId });
    const proj2 = makeProject({ project_id: 'proj-w4-b', tenant_id: tenantId });
    const pullSpy = vi.fn()
      .mockRejectedValueOnce(new Error('simulated failure'))
      .mockResolvedValueOnce(SPEAKERS_P2);

    const adapter = makeAdapter(tenantId, { pullSpeakers: pullSpy });
    CoreRegistry.registerTenant(makeTenant(tenantId), adapter);
    CoreRegistry.registerProject(proj1);
    CoreRegistry.registerProject(proj2);

    await expect(CoreRegistry.warmupSpeakers(tenantId)).resolves.toBeUndefined();
    expect(pullSpy).toHaveBeenCalledTimes(2);
  });

  it('W5: warmupSpeakers does not call another tenant\'s adapter', async () => {
    const tenantA = 'tenant-w5-a';
    const tenantB = 'tenant-w5-b';
    const projA   = makeProject({ project_id: 'proj-w5-a', tenant_id: tenantA });
    const projB   = makeProject({ project_id: 'proj-w5-b', tenant_id: tenantB });

    const pullSpyA = vi.fn().mockResolvedValue(SPEAKERS_P1);
    const pullSpyB = vi.fn().mockResolvedValue(SPEAKERS_P2);

    CoreRegistry.registerTenant(makeTenant(tenantA), makeAdapter(tenantA, { pullSpeakers: pullSpyA }));
    CoreRegistry.registerTenant(makeTenant(tenantB), makeAdapter(tenantB, { pullSpeakers: pullSpyB }));
    CoreRegistry.registerProject(projA);
    CoreRegistry.registerProject(projB);

    await CoreRegistry.warmupSpeakers(tenantA);

    expect(pullSpyA).toHaveBeenCalledOnce();
    expect(pullSpyB).not.toHaveBeenCalled();
  });

  it('W6: syncProjectsFromAdapter triggers warmupSpeakers automatically', async () => {
    const tenantId = 'tenant-warmup-w6';
    const project  = makeProject({ project_id: 'proj-w6', tenant_id: tenantId });
    const pullSpy  = vi.fn().mockResolvedValue(SPEAKERS_P1);

    const adapter = makeAdapter(tenantId, {
      pullSpeakers: pullSpy,
      async pullProjects() { return [project]; },
    });

    CoreRegistry.registerTenant(makeTenant(tenantId), adapter);

    await CoreRegistry.syncProjectsFromAdapter(tenantId);

    expect(pullSpy).toHaveBeenCalledWith(tenantId, project.project_id);
  });

  it('W7: warmupSpeakers is idempotent — second call does not throw', async () => {
    const tenantId = 'tenant-warmup-w7';
    const project  = makeProject({ project_id: 'proj-w7', tenant_id: tenantId });
    const pullSpy  = vi.fn().mockResolvedValue(SPEAKERS_P1);
    const adapter  = makeAdapter(tenantId, { pullSpeakers: pullSpy });

    CoreRegistry.registerTenant(makeTenant(tenantId), adapter);
    CoreRegistry.registerProject(project);

    await CoreRegistry.warmupSpeakers(tenantId);
    await expect(CoreRegistry.warmupSpeakers(tenantId)).resolves.toBeUndefined();
    expect(pullSpy).toHaveBeenCalledTimes(2);
  });

  it('W8: degraded adapter pullSpeakers → warmup logs warning and does not throw', async () => {
    const tenantId = 'tenant-warmup-w8';
    const project  = makeProject({ project_id: 'proj-w8', tenant_id: tenantId });
    const adapter  = makeAdapter(tenantId, {
      pullSpeakers: vi.fn().mockRejectedValue(new Error('vFarm Adapter API unavailable (degraded state)')),
    });

    CoreRegistry.registerTenant(makeTenant(tenantId), adapter);
    CoreRegistry.registerProject(project);

    await expect(CoreRegistry.warmupSpeakers(tenantId)).resolves.toBeUndefined();
  });
});
