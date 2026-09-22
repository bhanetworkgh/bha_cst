import { Project, ResourceScope, SpeakerRecord, SpeakerIdentity, CabinetConfig } from '../core/types.js';

export interface ITenantAdapter {
  readonly tenantId: string;
  /**
   * Push a project's current record (including tenant_org_id) into the
   * adapter's own in-memory projection, so adapter-internal lookups
   * (e.g. vFarm's org-id lookup for a project) reflect the latest
   * DB/registry state rather than only the adapter's hardcoded defaults.
   * Optional: adapters that have no per-project in-memory state can omit it.
   */
  addProject?(project: Project): void;
  pullProjects(tenantId: string): Promise<Project[]>;
  pullResourceScopes(tenantId: string, projectId: string): Promise<ResourceScope[]>;
  pullSpeakers(tenantId: string, projectId: string): Promise<SpeakerRecord[]>;
  pullCandidateNumbers?(tenantId: string): Promise<string[]>;
  syncMembers?(tenantId: string, projectId: string, members: SpeakerRecord[]): Promise<SpeakerRecord[]>;
  resolveSpeaker(params: {
    tenantId: string;
    projectId: string;
    phoneE164: string;
  }): Promise<SpeakerIdentity>;
  resolveCabinetConfig?(params: {
    tenantId: string;
    projectId: string;
    farmId: string;
    serial: string;
    speaker: SpeakerIdentity;
  }): Promise<CabinetConfig | null>;
  getHealth?(tenantId: string): Promise<{
    status: 'healthy' | 'degraded' | 'down';
    latency_ms?: number;
    details?: Record<string, unknown>;
  }>;
}