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
  /**
   * Optional write-through hooks into the adapter's own in-memory speaker
   * directory. Runtime identity resolution (CoreRegistry.resolveSpeaker) reads
   * the adapter directory, so admin-projected speakers must be mirrored here
   * for the Admin Panel and the runtime to describe the same user. Optional:
   * adapters with no in-memory directory can omit them.
   */
  registerSpeaker?(projectId: string, speaker: SpeakerRecord): void;
  removeSpeaker?(projectId: string, phoneE164: string): boolean;
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
  /**
   * Upstream health for this tenant.
   *
   * `healthy` means a tenant-scoped, read-only upstream request SUCCEEDED and
   * the reported latency was measured — never that credentials merely exist.
   * `configured` means the upstream is configured and reachable but upstream
   * health is NOT asserted (the probe could not be scoped to this tenant, or
   * the probe was skipped). `degraded` means the upstream answered with an
   * error. `unavailable` means the upstream could not be reached or could not
   * authenticate.
   *
   * `options.probe === false` returns the adapter's OPERATIONAL readiness
   * WITHOUT contacting the upstream. The per-request authorization path uses
   * that mode: a liveness probe is a network round trip, and making
   * authorization depend on the upstream's liveness at that instant would
   * couple a customer's turn to an unrelated upstream outage. The actual
   * identity resolution performs its own authoritative upstream check and
   * fails closed on its own, so nothing is weakened by not probing here.
   */
  getHealth?(tenantId: string, options?: { probe?: boolean }): Promise<{
    status: 'configured' | 'healthy' | 'degraded' | 'unavailable';
    latency_ms?: number;
    details?: Record<string, unknown>;
  }>;
}