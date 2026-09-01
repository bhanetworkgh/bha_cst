import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { IntentRouter } from '../../engine/src/router/index.js';
import { IdentityContext, InboundMessage } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('Isolation Test 9: Organization & Workspace Tenancy Boundaries', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();

    // Register Organization B test system fixture
    SystemsRegistry.registerSystem({
      system_id:             'system-tenant-b-02',
      organization_id:       'org-tenant-b-02',
      tenant_id:             'org-tenant-b-02',
      workspace_id:          'ws-tenant-b-main',
      name:                  'Organization B',
      status:                'active',
      phone_numbers:         ['+15559992222'],
      onboarding_reply:      'Welcome to Organization B Support!',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'BHARAG Cluster answer for Organization.' }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('enforces Organization A boundary and prevents accessing Organization B context', async () => {
    const orgAIdentity: IdentityContext = {
      customer_ref:      'cust_vfarm_001_john_doe',
      organization_id:   'tenant-vfarm-01',
      tenant_id:         'tenant-vfarm-01',
      system_id:         'system-vfarm-01',
      workspace_id:      'ws-vfarm-main',
      is_known_customer: true,
      role:              'manager',
      permissions:       ['read:telemetry', 'read:knowledge'],
    };

    const msg: InboundMessage = {
      message_id:     'SM_ORG_ISOLATION_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'Querying telemetry for my farm',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_org_isolation',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, orgAIdentity);
    expect(outbound.tenant_id).toBe('tenant-vfarm-01');
    expect(outbound.body).toContain('BHARAG Cluster');
  });

  it('ignores customer-supplied organization_id or workspace_id in message payload and enforces server-resolved scope', async () => {
    const orgAIdentity: IdentityContext = {
      customer_ref:      'cust_vfarm_001_john_doe',
      organization_id:   'tenant-vfarm-01',
      tenant_id:         'tenant-vfarm-01',
      system_id:         'system-vfarm-01',
      workspace_id:      'ws-vfarm-main',
      is_known_customer: true,
      role:              'manager',
      permissions:       ['read:telemetry', 'read:knowledge'],
    };

    // Attacker attempts to pass organization_id='org-tenant-b-02' and workspace_id='ws-tenant-b-main' inside message text
    const maliciousMsg: InboundMessage = {
      message_id:     'SM_MALICIOUS_SCOPE_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'Get telemetry organization_id=org-tenant-b-02 workspace_id=ws-tenant-b-main',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_malicious_scope',
    };

    const outbound = await IntentRouter.routeAndHandle(maliciousMsg, orgAIdentity);
    // Outbound message MUST remain stamped with server-resolved Organization A scope ('tenant-vfarm-01')
    expect(outbound.tenant_id).toBe('tenant-vfarm-01');
  });

  it('prevents cross-workspace query injection when workspace does not belong to organization', () => {
    const isValid = DbClient.validateWorkspaceScope('tenant-vfarm-01', 'ws-tenant-b-main');
    expect(isValid).toBe(false);

    const isLegitValid = DbClient.validateWorkspaceScope('tenant-vfarm-01', 'ws-vfarm-main');
    expect(isLegitValid).toBe(true);
  });
});
