import type { SystemConfig } from '../transport/twilio/types.js';
import type { Tenant, Project, ServiceNumberBinding } from '../core/types.js';

/**
 * Pure, side-effect-free validation of a set of registered systems against the
 * authoritative CST tenancy state (tenants, projects, service number bindings).
 *
 * It never returns or logs a secret: the BHARAG workspace key is reported only
 * as `configured` / `placeholder` / `missing`, with a masked form.
 */

export type RegistryIssueCode =
  | 'SYSTEM_ID_MISSING'
  | 'TENANT_ID_MISSING'
  | 'WORKSPACE_ID_MISSING'
  | 'WORKSPACE_DERIVED_FROM_TENANT'
  | 'TENANT_NOT_REGISTERED'
  | 'NO_PHONE_NUMBERS'
  | 'PHONE_NOT_E164'
  | 'PHONE_PLACEHOLDER'
  | 'PHONE_DUPLICATE_ACROSS_SYSTEMS'
  | 'PHONE_NOT_BOUND'
  | 'PHONE_BOUND_TO_OTHER_TENANT'
  | 'BINDING_PROJECT_TENANT_MISMATCH'
  | 'BINDING_WITHOUT_SYSTEM'
  | 'WORKSPACE_SHARED_ACROSS_TENANTS'
  | 'BHARAG_KEY_MISSING'
  | 'BHARAG_KEY_PLACEHOLDER'
  | 'SYSTEM_ID_DUPLICATE';

export interface RegistryIssue {
  severity: 'error' | 'warning';
  code: RegistryIssueCode;
  system_id?: string;
  message: string;
}

export interface BharagKeyStatus {
  status: 'configured' | 'placeholder' | 'missing';
  masked?: string;
}

export interface SystemRegistrationSummary {
  system_id: string;
  tenant_id: string;
  workspace_id: string;
  phone_numbers_masked: string[];
  bharag_workspace_key: BharagKeyStatus;
}

export interface RegistryValidationReport {
  ok: boolean;
  systems: SystemRegistrationSummary[];
  issues: RegistryIssue[];
}

const E164 = /^\+[1-9]\d{6,14}$/;

/** Values shipped in `.env.example` that must never be treated as real config. */
const PLACEHOLDER_KEY = /^(your_|replace_|changeme|xxx|<)/i;
const PLACEHOLDER_PHONE = /X{3,}/i;

export function maskSecret(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function maskNumber(phone: string): string {
  if (phone.length <= 6) return '***';
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

export function classifyBharagKey(key: string | undefined | null): BharagKeyStatus {
  const k = (key || '').trim();
  if (!k) return { status: 'missing' };
  if (PLACEHOLDER_KEY.test(k)) return { status: 'placeholder', masked: maskSecret(k) };
  return { status: 'configured', masked: maskSecret(k) };
}

export interface RegistryValidationInput {
  systems: SystemConfig[];
  tenants: Tenant[];
  projects: Project[];
  bindings: ServiceNumberBinding[];
  /** Systems whose workspace id is derived from the tenant rather than configured. */
  derivedWorkspaceSystemIds?: string[];
}

export function validateSystemRegistry(input: RegistryValidationInput): RegistryValidationReport {
  const issues: RegistryIssue[] = [];
  const add = (i: RegistryIssue) => issues.push(i);
  const tenantIds = new Set(input.tenants.map((t) => t.tenant_id));
  const projectById = new Map(input.projects.map((p) => [p.project_id, p]));
  const bindingByPhone = new Map(input.bindings.map((b) => [b.phone_e164.trim(), b]));
  const phoneOwners = new Map<string, Set<string>>();
  const workspaceTenants = new Map<string, Set<string>>();
  const seenSystemIds = new Set<string>();
  const summaries: SystemRegistrationSummary[] = [];

  for (const sys of input.systems) {
    const sid = (sys.system_id || '').trim();
    const tid = (sys.tenant_id || sys.organization_id || '').trim();
    const wid = (sys.workspace_id || '').trim();

    if (!sid) add({ severity: 'error', code: 'SYSTEM_ID_MISSING', message: 'A registered system has no system_id' });
    else if (seenSystemIds.has(sid)) add({ severity: 'error', code: 'SYSTEM_ID_DUPLICATE', system_id: sid, message: `system_id ${sid} is registered more than once` });
    seenSystemIds.add(sid);

    if (!tid) add({ severity: 'error', code: 'TENANT_ID_MISSING', system_id: sid, message: 'System has no tenant_id' });
    else if (!tenantIds.has(tid)) add({ severity: 'error', code: 'TENANT_NOT_REGISTERED', system_id: sid, message: `Tenant ${tid} is not registered in CoreRegistry` });

    if (!wid) add({ severity: 'error', code: 'WORKSPACE_ID_MISSING', system_id: sid, message: 'System has no workspace_id' });
    else {
      if (!workspaceTenants.has(wid)) workspaceTenants.set(wid, new Set());
      workspaceTenants.get(wid)!.add(tid);
    }
    if (input.derivedWorkspaceSystemIds?.includes(sid)) {
      add({ severity: 'warning', code: 'WORKSPACE_DERIVED_FROM_TENANT', system_id: sid, message: 'workspace_id is derived from the tenant (VFARM_WORKSPACE_ID unset); the project is the real boundary' });
    }

    const key = classifyBharagKey(sys.bharag_workspace_key);
    if (key.status === 'missing') add({ severity: 'error', code: 'BHARAG_KEY_MISSING', system_id: sid, message: 'BHARAG workspace key is not configured' });
    if (key.status === 'placeholder') add({ severity: 'error', code: 'BHARAG_KEY_PLACEHOLDER', system_id: sid, message: 'BHARAG workspace key is a placeholder value' });

    const phones = (sys.phone_numbers || []).map((p) => p.trim()).filter(Boolean);
    if (phones.length === 0) add({ severity: 'error', code: 'NO_PHONE_NUMBERS', system_id: sid, message: 'System has no service phone numbers' });

    for (const phone of phones) {
      if (PLACEHOLDER_PHONE.test(phone)) {
        add({ severity: 'error', code: 'PHONE_PLACEHOLDER', system_id: sid, message: 'A service number is a placeholder value' });
        continue;
      }
      if (!E164.test(phone)) {
        add({ severity: 'error', code: 'PHONE_NOT_E164', system_id: sid, message: `Service number ${maskNumber(phone)} is not E.164` });
      }
      if (!phoneOwners.has(phone)) phoneOwners.set(phone, new Set());
      phoneOwners.get(phone)!.add(sid);

      const binding = bindingByPhone.get(phone);
      if (!binding) {
        add({ severity: 'error', code: 'PHONE_NOT_BOUND', system_id: sid, message: `Service number ${maskNumber(phone)} has no service_number_binding (inbound routing will refuse it)` });
      } else if (binding.tenant_id !== tid) {
        add({ severity: 'error', code: 'PHONE_BOUND_TO_OTHER_TENANT', system_id: sid, message: `Service number ${maskNumber(phone)} is bound to tenant ${binding.tenant_id}, system claims ${tid}` });
      }
    }

    summaries.push({
      system_id: sid,
      tenant_id: tid,
      workspace_id: wid,
      phone_numbers_masked: phones.map(maskNumber),
      bharag_workspace_key: key,
    });
  }

  for (const [phone, owners] of phoneOwners) {
    if (owners.size > 1) {
      add({ severity: 'error', code: 'PHONE_DUPLICATE_ACROSS_SYSTEMS', message: `Service number ${maskNumber(phone)} is claimed by systems: ${[...owners].join(', ')}` });
    }
  }
  for (const [wid, tenants] of workspaceTenants) {
    if (tenants.size > 1) {
      add({ severity: 'error', code: 'WORKSPACE_SHARED_ACROSS_TENANTS', message: `workspace_id ${wid} is shared by tenants: ${[...tenants].join(', ')}` });
    }
  }

  const registeredPhones = new Set<string>(phoneOwners.keys());
  for (const b of input.bindings) {
    const project = projectById.get(b.project_id);
    if (!project || project.tenant_id !== b.tenant_id) {
      add({ severity: 'error', code: 'BINDING_PROJECT_TENANT_MISMATCH', message: `Binding ${maskNumber(b.phone_e164)} references project ${b.project_id} that does not belong to tenant ${b.tenant_id}` });
    }
    if (!registeredPhones.has(b.phone_e164.trim())) {
      add({ severity: 'warning', code: 'BINDING_WITHOUT_SYSTEM', message: `Binding ${maskNumber(b.phone_e164)} (tenant ${b.tenant_id}) has no system registration; voice ingress will refuse it` });
    }
  }

  return {
    ok: !issues.some((i) => i.severity === 'error'),
    systems: summaries,
    issues,
  };
}

