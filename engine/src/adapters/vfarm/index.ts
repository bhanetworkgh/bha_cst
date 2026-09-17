import { ITenantAdapter } from '../types.js';
import { Project, ResourceScope, SpeakerRecord, SpeakerIdentity, UserRole, CabinetConfig } from '../../core/types.js';
import { Logger } from '../../config/logger.js';
import { getPermissionsForRole } from '../../identity/resolver.js';

export interface VfarmAdapterConfig {
  resolveEndpoint?: string;
  apiKey?: string;
  bharagWorkspaceKey?: string;
  mediaBaseUrl?: string;
  simulateDegraded?: boolean;
}

export class VfarmTenantAdapter implements ITenantAdapter {
  readonly tenantId: string;
  private config: VfarmAdapterConfig;

  // In-memory data store for vFarm tenancy projection & mocking
  private projectsMap: Map<string, Project> = new Map();
  private resourceScopesMap: Map<string, ResourceScope[]> = new Map(); // projectId -> farms[]
  private speakersMap: Map<string, Map<string, SpeakerRecord>> = new Map(); // projectId -> (phone -> SpeakerRecord)
  private cabinetConfigMap: Map<string, CabinetConfig> = new Map();

  constructor(tenantId = 'tenant-vfarm-01', config: VfarmAdapterConfig = {}) {
    this.tenantId = tenantId;
    this.config = config;
    this.initDefaultData();
  }

  public setDegraded(degraded: boolean): void {
    this.config.simulateDegraded = degraded;
  }

  private initDefaultData(): void {
    // Project 1: Main vFarm Org (Austin)
    const proj1: Project = {
      project_id: 'proj-vfarm-main',
      tenant_id: this.tenantId,
      name: 'vFarm Austin HQ',
      status: 'active',
      tenant_org_id: 'org-vfarm-austin',
      capabilities: { sms: true, voice: true },
      speaker_policy: 'allowlist',
      onboarding_reply: process.env.VFARM_ONBOARDING_REPLY || 'Welcome to vFarm Support! We received your message. A specialist will assist you shortly.',
    };

    // Project 2: Secondary vFarm Org (Dallas)
    const proj2: Project = {
      project_id: 'proj-vfarm-dallas',
      tenant_id: this.tenantId,
      name: 'vFarm Dallas Operations',
      status: 'active',
      tenant_org_id: 'org-vfarm-dallas',
      capabilities: { sms: true },
      speaker_policy: 'allowlist',
      onboarding_reply: 'Welcome to vFarm Dallas Support! Contact your site manager for access.',
    };

    this.projectsMap.set(proj1.project_id, proj1);
    this.projectsMap.set(proj2.project_id, proj2);

    // Resources (Farms)
    this.resourceScopesMap.set(proj1.project_id, [
      { id: 'farm_austin_main', name: 'Austin Main Facility', type: 'farm' },
      { id: 'farm_austin_east', name: 'Austin East Greenhouses', type: 'farm' },
    ]);

    this.resourceScopesMap.set(proj2.project_id, [
      { id: 'farm_dallas_north', name: 'Dallas North Facility', type: 'farm' },
    ]);

    // Speakers for Project 1 (Austin)
    const p1Speakers = new Map<string, SpeakerRecord>();
    p1Speakers.set('+923082113844', {
      person_id: 'usr_vfarm_003',
      phone_e164: '+923082113844',
      role: 'owner',
      farm_ids: ['farm_austin_main'],
      name: 'Test Owner',
    });
    p1Speakers.set('+15551234567', {
      person_id: 'usr_vfarm_001',
      phone_e164: '+15551234567',
      role: 'manager',
      farm_ids: ['farm_austin_main'],
      name: 'John Doe',
    });
    p1Speakers.set('+15558887777', {
      person_id: 'usr_vfarm_002',
      phone_e164: '+15558887777',
      role: 'tech',
      farm_ids: ['farm_austin_main'],
      name: 'Alice Smith',
    });
    this.speakersMap.set(proj1.project_id, p1Speakers);

    // Speakers for Project 2 (Dallas)
    const p2Speakers = new Map<string, SpeakerRecord>();
    p2Speakers.set('+15559990000', {
      person_id: 'usr_vfarm_dallas_001',
      phone_e164: '+15559990000',
      role: 'owner',
      farm_ids: ['farm_dallas_north'],
      name: 'Dallas Owner',
    });
    this.speakersMap.set(proj2.project_id, p2Speakers);
  }

  // Dynamic helper methods for testing & administration
  public addProject(project: Project): void {
    this.projectsMap.set(project.project_id, project);
  }

  public registerSpeaker(projectId: string, speaker: SpeakerRecord): void {
    let pMap = this.speakersMap.get(projectId);
    if (!pMap) {
      pMap = new Map();
      this.speakersMap.set(projectId, pMap);
    }
    if (!speaker.phone_e164 || !this.isValidE164(speaker.phone_e164)) {
      throw new Error('Speaker phone_e164 is required and must be valid E.164');
    }
    pMap.set(speaker.phone_e164.trim(), { ...speaker, phone_e164: speaker.phone_e164.trim() });
  }

  public registerCabinetConfig(config: CabinetConfig): void {
    this.cabinetConfigMap.set(`${config.farm_id}:${config.serial}`, { ...config });
  }

  public removeSpeaker(projectId: string, phoneE164: string): boolean {
    const pMap = this.speakersMap.get(projectId);
    if (!pMap) return false;
    return pMap.delete(phoneE164.trim());
  }

  public isValidE164(phone: string): boolean {
    const candidate = (phone || '').trim();
    return /^\+[1-9]\d{1,14}$/.test(candidate);
  }

  async syncMembers(tenantId: string, projectId: string, members: SpeakerRecord[]): Promise<SpeakerRecord[]> {
    if (tenantId !== this.tenantId) {
      throw new Error(`Tenant ${tenantId} is not managed by this vFarm adapter`);
    }
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }

    const next = new Map<string, SpeakerRecord>();
    for (const member of members) {
      if (!member?.person_id) {
        throw new Error('Member person_id is required');
      }
      if (!member.phone_e164) {
        throw new Error(`Member ${member.person_id} has missing phone_e164`);
      }
      if (!this.isValidE164(member.phone_e164)) {
        throw new Error(`Member ${member.person_id} has invalid phone_e164: ${member.phone_e164}`);
      }
      const clean = {
        ...member,
        phone_e164: member.phone_e164.trim(),
        farm_ids: Array.isArray(member.farm_ids) ? member.farm_ids.filter(Boolean) : [],
      };
      next.set(clean.phone_e164, clean);
    }

    this.speakersMap.set(projectId, next);
    return Array.from(next.values());
  }

  async pullProjects(tenantId: string): Promise<Project[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    return Array.from(this.projectsMap.values());
  }

  async pullResourceScopes(tenantId: string, projectId: string): Promise<ResourceScope[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    return this.resourceScopesMap.get(projectId) || [];
  }

  async pullSpeakers(tenantId: string, projectId: string): Promise<SpeakerRecord[]> {
    if (this.config.simulateDegraded) {
      throw new Error('vFarm Adapter API unavailable (degraded state)');
    }
    if (tenantId !== this.tenantId) return [];
    const pMap = this.speakersMap.get(projectId);
    return pMap ? Array.from(pMap.values()) : [];
  }

  async pullCandidateNumbers(tenantId: string): Promise<string[]> {
    if (tenantId !== this.tenantId) return [];
    return ['+19715885823', '+19715885824', '+19715885825'];
  }

  async resolveSpeaker(params: {
    tenantId: string;
    projectId: string;
    phoneE164: string;
  }): Promise<SpeakerIdentity> {
    const cleanPhone = (params.phoneE164 || '').trim();

    if (this.config.simulateDegraded) {
      Logger.warn(`vFarm Adapter degraded: live resolve failed for ${cleanPhone}`);
      throw new Error('vFarm Adapter API unavailable');
    }

    if (!cleanPhone || !this.isValidE164(cleanPhone)) {
      const safeRef = `opaque_invalid_${(cleanPhone || 'unknown').replace(/[^0-9]/g, '')}`;
      return {
        person_id: safeRef,
        customer_ref: safeRef,
        tenant_id: params.tenantId,
        project_id: params.projectId,
        phone_e164: cleanPhone,
        is_known: false,
        role: 'unknown',
        permissions: [],
        farm_ids: [],
      };
    }

    const pMap = this.speakersMap.get(params.projectId);
    const speaker = pMap?.get(cleanPhone);

    if (speaker) {
      const role: UserRole = speaker.role || 'manager';
      const permissions = getPermissionsForRole(role);
      const customerRef = `cust_${speaker.person_id}`;

      return {
        person_id: speaker.person_id,
        customer_ref: customerRef,
        tenant_id: params.tenantId,
        project_id: params.projectId,
        phone_e164: cleanPhone,
        is_known: true,
        role,
        permissions,
        farm_ids: [...speaker.farm_ids],
        unit_context: {
          farm_id: speaker.farm_ids[0],
          unit_id: 'unit_bay_04',
          role,
        },
      };
    }

    const safeRef = `opaque_unresolved_${cleanPhone.replace(/[^0-9]/g, '')}`;
    return {
      person_id: safeRef,
      customer_ref: safeRef,
      tenant_id: params.tenantId,
      project_id: params.projectId,
      phone_e164: cleanPhone,
      is_known: false,
      role: 'unknown',
      permissions: [],
      farm_ids: [],
    };
  }

  async resolveCabinetConfig(params: {
    tenantId: string;
    projectId: string;
    farmId: string;
    serial: string;
    speaker: SpeakerIdentity;
  }): Promise<CabinetConfig | null> {
    if (this.config.simulateDegraded) {
      throw new Error('LM7W cabinet config unavailable (degraded state)');
    }

    if (!params?.serial || !params?.farmId) {
      return null;
    }

    if (!params.speaker?.is_known || !params.speaker?.farm_ids?.includes(params.farmId)) {
      return null;
    }

    const key = `${params.tenantId}:${params.projectId}:${params.farmId}:${params.serial}`;
    const config = this.cabinetConfigMap.get(key);
    if (!config) {
      return null;
    }

    return {
      ...config,
      farm_id: params.farmId,
      serial: params.serial,
      source: 'lm7w',
    };
  }

  async getHealth(tenantId: string): Promise<{
    status: 'healthy' | 'degraded' | 'down';
    latency_ms?: number;
    details?: Record<string, unknown>;
  }> {
    if (this.config.simulateDegraded) {
      return { status: 'degraded', latency_ms: 1200, details: { error: 'Simulated API latency / degradation' } };
    }
    return {
      status: 'healthy',
      latency_ms: 15,
      details: {
        projects_count: this.projectsMap.size,
        tenant_id: tenantId,
      },
    };
  }
}
