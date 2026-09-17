import { Project, ResourceScope, SpeakerRecord, SpeakerIdentity, CabinetConfig } from '../core/types.js';

export interface ITenantAdapter {
  readonly tenantId: string;
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
