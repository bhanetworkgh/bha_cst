import { describe, it, expect, beforeEach } from 'vitest';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { validateSystemRegistry, classifyBharagKey } from '../../engine/src/systems/registry_validation.js';
import type { SystemConfig } from '../../engine/src/transport/twilio/types.js';
import type { Tenant, Project, ServiceNumberBinding } from '../../engine/src/core/types.js';

const tenant = (id: string): Tenant => ({ tenant_id: id, name: id, status: 'active', adapter_type: 'vfarm', created_at: '2026-01-01T00:00:00Z' });
const project = (id: string, t: string): Project => ({ project_id: id, tenant_id: t, name: id } as unknown as Project);
const binding = (phone: string, t: string, p: string): ServiceNumberBinding => ({
  phone_e164: phone, tenant_id: t, project_id: p, capability: 'sms_voice', status: 'bound', bound_at: '2026-01-01T00:00:00Z',
});
const sys = (over: Partial<SystemConfig> = {}): SystemConfig => ({
  system_id: 'system-a', organization_id: 'tenant-a', tenant_id: 'tenant-a', workspace_id: 'ws-a',
  name: 'A', status: 'active', phone_numbers: ['+15550001111'], onboarding_reply: 'hi',
  bharag_workspace_key: 'real-looking-key-123456', ...over,
});
const codes = (r: ReturnType<typeof validateSystemRegistry>) => r.issues.map((i) => i.code);

describe('KZE7 — system registry (pure validation)', () => {
  const base = () => ({
    systems: [sys()],
    tenants: [tenant('tenant-a')],
    projects: [project('proj-a', 'tenant-a')],
    bindings: [binding('+15550001111', 'tenant-a', 'proj-a')],
  });

  it('accepts a fully consistent registration (system, tenant, workspace, phone, key)', () => {
    const r = validateSystemRegistry(base());
    expect(r.ok).toBe(true);
    expect(r.systems[0]).toMatchObject({ system_id: 'system-a', tenant_id: 'tenant-a', workspace_id: 'ws-a' });
    expect(r.systems[0].bharag_workspace_key.status).toBe('configured');
  });

  it('never leaks the key or full phone numbers in the report', () => {
    const json = JSON.stringify(validateSystemRegistry(base()));
    expect(json).not.toContain('real-looking-key-123456');
    expect(json).not.toContain('+15550001111');
  });

  it('rejects a missing system id', () => {
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ system_id: '' })] }))).toContain('SYSTEM_ID_MISSING');
  });

  it('rejects missing tenant and unregistered tenant', () => {
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ tenant_id: '', organization_id: '' })] }))).toContain('TENANT_ID_MISSING');
    expect(codes(validateSystemRegistry({ ...base(), tenants: [] }))).toContain('TENANT_NOT_REGISTERED');
  });

  it('rejects missing workspace', () => {
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ workspace_id: '' })] }))).toContain('WORKSPACE_ID_MISSING');
  });

  it('rejects missing or placeholder BHARAG workspace key', () => {
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ bharag_workspace_key: undefined })] }))).toContain('BHARAG_KEY_MISSING');
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ bharag_workspace_key: 'your_bharag_workspace_key_here' })] }))).toContain('BHARAG_KEY_PLACEHOLDER');
    expect(classifyBharagKey('  ').status).toBe('missing');
  });

  it('rejects placeholder / non-E.164 / unbound numbers', () => {
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ phone_numbers: ['+1XXXXXXXXXX'] })] }))).toContain('PHONE_PLACEHOLDER');
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ phone_numbers: ['5550001111'] })] }))).toContain('PHONE_NOT_E164');
    expect(codes(validateSystemRegistry({ ...base(), bindings: [] }))).toContain('PHONE_NOT_BOUND');
    expect(codes(validateSystemRegistry({ ...base(), systems: [sys({ phone_numbers: [] })] }))).toContain('NO_PHONE_NUMBERS');
  });

  it('flags duplicate number mapping across systems', () => {
    const r = validateSystemRegistry({ ...base(), systems: [sys(), sys({ system_id: 'system-b', tenant_id: 'tenant-b', organization_id: 'tenant-b', workspace_id: 'ws-b' })], tenants: [tenant('tenant-a'), tenant('tenant-b')] });
    expect(codes(r)).toContain('PHONE_DUPLICATE_ACROSS_SYSTEMS');
    expect(r.ok).toBe(false);
  });

  it('flags cross-tenant: number bound to another tenant than the system claims', () => {
    const r = validateSystemRegistry({ ...base(), tenants: [tenant('tenant-a'), tenant('tenant-b')], projects: [project('proj-b', 'tenant-b')], bindings: [binding('+15550001111', 'tenant-b', 'proj-b')] });
    expect(codes(r)).toContain('PHONE_BOUND_TO_OTHER_TENANT');
  });

  it('flags cross-tenant project binding and cross-workspace sharing', () => {
    expect(codes(validateSystemRegistry({ ...base(), projects: [project('proj-a', 'tenant-other')] }))).toContain('BINDING_PROJECT_TENANT_MISMATCH');
    const r = validateSystemRegistry({
      ...base(),
      systems: [sys(), sys({ system_id: 'system-b', tenant_id: 'tenant-b', organization_id: 'tenant-b', phone_numbers: ['+15550002222'] })],
      tenants: [tenant('tenant-a'), tenant('tenant-b')],
      projects: [project('proj-a', 'tenant-a'), project('proj-b', 'tenant-b')],
      bindings: [binding('+15550001111', 'tenant-a', 'proj-a'), binding('+15550002222', 'tenant-b', 'proj-b')],
    });
    expect(codes(r)).toContain('WORKSPACE_SHARED_ACROSS_TENANTS');
  });

  it('supports multiple registered systems with distinct tenants/workspaces/numbers', () => {
    const r = validateSystemRegistry({
      systems: [sys(), sys({ system_id: 'system-b', tenant_id: 'tenant-b', organization_id: 'tenant-b', workspace_id: 'ws-b', phone_numbers: ['+15550002222'] })],
      tenants: [tenant('tenant-a'), tenant('tenant-b')],
      projects: [project('proj-a', 'tenant-a'), project('proj-b', 'tenant-b')],
      bindings: [binding('+15550001111', 'tenant-a', 'proj-a'), binding('+15550002222', 'tenant-b', 'proj-b')],
    });
    expect(r.ok).toBe(true);
    expect(r.systems).toHaveLength(2);
  });
});

describe('KZE7 — SystemsRegistry / CoreRegistry runtime resolution', () => {
  beforeEach(() => {
    CoreRegistry.resetToDefault();
    SystemsRegistry.resetToDefault();
  });

  it('resolves the vFarm system, tenant, workspace and service number from one entry', () => {
    const binding = CoreRegistry.getAllBindings()[0];
    const system = SystemsRegistry.resolveSystemByPhoneNumber(binding.phone_e164)!;
    expect(system).not.toBeNull();
    expect(system.system_id).toBe(process.env.VFARM_SYSTEM_ID);
    expect(system.tenant_id).toBe(binding.tenant_id);
    expect(system.workspace_id).toBeTruthy();
    expect(SystemsRegistry.getSystemById(system.system_id)).toBe(system);
    expect(SystemsRegistry.getSystemByTenantId(system.tenant_id)).toBe(system);
  });

  it('fails closed on an unknown phone number', () => {
    expect(SystemsRegistry.resolveSystemByPhoneNumber('+15559990000')).toBeNull();
    expect(CoreRegistry.resolveServiceNumber('+15559990000')).toBeNull();
    expect(SystemsRegistry.resolveSystemByPhoneNumber('')).toBeNull();
  });

  it('refuses to register without system id, tenant or workspace (no fabricated workspace)', () => {
    expect(() => SystemsRegistry.registerSystem(sys({ system_id: '' }))).toThrow(/system_id/);
    expect(() => SystemsRegistry.registerSystem(sys({ tenant_id: '', organization_id: '' }))).toThrow(/tenant/);
    expect(() => SystemsRegistry.registerSystem(sys({ workspace_id: '' }))).toThrow(/workspace_id/);
    expect(SystemsRegistry.getSystemById('system-a')).toBeNull();
  });

  it('refuses a duplicate service-number mapping across systems and keeps the original owner', () => {
    const original = SystemsRegistry.getSystemById(process.env.VFARM_SYSTEM_ID!)!;
    const phone = original.phone_numbers[0];
    expect(() => SystemsRegistry.registerSystem(sys({ system_id: 'system-evil', tenant_id: 'tenant-evil', organization_id: 'tenant-evil', workspace_id: 'ws-evil', phone_numbers: [phone] }))).toThrow(/already registered/);
    expect(SystemsRegistry.resolveSystemByPhoneNumber(phone)!.system_id).toBe(original.system_id);
    expect(SystemsRegistry.getSystemById('system-evil')).toBeNull();
  });

  it('keeps tenants/workspaces isolated across two registered systems', () => {
    SystemsRegistry.registerSystem(sys({ system_id: 'system-b', tenant_id: 'tenant-b', organization_id: 'tenant-b', workspace_id: 'ws-b', phone_numbers: ['+15550002222'] }));
    const b = SystemsRegistry.resolveSystemByPhoneNumber('+15550002222')!;
    const vfarm = SystemsRegistry.getSystemById(process.env.VFARM_SYSTEM_ID!)!;
    expect(b.tenant_id).toBe('tenant-b');
    expect(b.workspace_id).toBe('ws-b');
    expect(vfarm.tenant_id).not.toBe(b.tenant_id);
    expect(vfarm.workspace_id).not.toBe(b.workspace_id);
    expect(SystemsRegistry.getSystemByTenantId('tenant-b')!.system_id).toBe('system-b');
  });

  it('validateConfiguration reports a missing binding for an unbound registered number', () => {
    SystemsRegistry.registerSystem(sys({ system_id: 'system-b', tenant_id: 'tenant-b', organization_id: 'tenant-b', workspace_id: 'ws-b', phone_numbers: ['+15550002222'] }));
    const report = SystemsRegistry.validateConfiguration();
    const c = report.issues.map((i) => i.code);
    expect(c).toContain('TENANT_NOT_REGISTERED');
    expect(c).toContain('PHONE_NOT_BOUND');
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain('+15550002222');
  });
});
