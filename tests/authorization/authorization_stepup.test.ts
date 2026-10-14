import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntentRouter } from '../../engine/src/router/index.js';
import { DbClient } from '../../engine/src/db/client.js';
import { StepUpAuthService } from '../../engine/src/identity/stepup.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('Authorization & Step-Up Authentication Seam Tests', () => {
  beforeEach(() => {
    DbClient.clearAll();
    seedTestCustomers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'BHARAG Knowledge response.' }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const knownOwnerIdentity: IdentityContext = {
    customer_ref:      'cust_vfarm_003_test_user',
    organization_id:   'tenant-vfarm-01',
    tenant_id:         'tenant-vfarm-01',
    system_id:         'system-vfarm-01',
    workspace_id:      'ws-vfarm-main',
    is_known_customer: true,
    role:              'owner',
    permissions:       ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate', 'write:settings'],
  };

  const knownManagerIdentity: IdentityContext = {
    customer_ref:      'cust_vfarm_001_john_doe',
    organization_id:   'tenant-vfarm-01',
    tenant_id:         'tenant-vfarm-01',
    system_id:         'system-vfarm-01',
    workspace_id:      'ws-vfarm-main',
    is_known_customer: true,
    role:              'manager',
    permissions:       ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate'],
    unit_context:      { unit_id: 'unit_bay_04', farm_id: 'farm_austin_main' },
  };

  const knownTechIdentity: IdentityContext = {
    customer_ref:      'cust_vfarm_002_alice_smith',
    organization_id:   'tenant-vfarm-01',
    tenant_id:         'tenant-vfarm-01',
    system_id:         'system-vfarm-01',
    workspace_id:      'ws-vfarm-main',
    is_known_customer: true,
    role:              'tech',
    permissions:       ['read:telemetry', 'read:knowledge', 'read:media', 'write:escalate'],
    unit_context:      { unit_id: 'unit_bay_12', farm_id: 'farm_austin_main' },
  };

  const unknownIdentity: IdentityContext = {
    customer_ref:      'opaque_unresolved_9999',
    organization_id:   'tenant-vfarm-01',
    tenant_id:         'tenant-vfarm-01',
    system_id:         'system-vfarm-01',
    workspace_id:      'ws-vfarm-main',
    is_known_customer: false,
    role:              'unknown',
    permissions:       [],
  };

  it('allows read operation for known user with permitted role — farm telemetry goes through vFarm (KMG9)', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_READ_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'What is the current temperature in Bay 4?',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_read_test',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownManagerIdentity);
    // KMG9: "temperature" + "Bay" = status keywords -> routes to vFarm path
    // No live client in test runner -> telemetry_unavailable, NO BHARAG
    expect(outbound.body).toContain('Telemetry currently unavailable');
    expect(outbound.body).not.toContain('BHARAG Knowledge');
    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
  });

  it('refuses equipment control attempt from tech role due to role boundary', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_TECH_CONTROL_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15558887777',
      to_e164:        '+19715885823',
      body:           'Turn off pump in Bay 12',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_tech_control',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownTechIdentity);
    expect(outbound.body).toContain("Role 'tech' is not authorized");
  });

  it('refuses user management attempt via SMS for all roles', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_USER_MGMT_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+923082113844',
      to_e164:        '+19715885823',
      body:           'Grant role owner to +15559990000',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_user_mgmt',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownOwnerIdentity);
    expect(outbound.body).toContain('restricted to the Organization Admin Panel');
  });

  it('rejects sensitive write operation without step-up authentication even for owner role', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_WRITE_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+923082113844',
      to_e164:        '+19715885823',
      body:           'Emergency pump off override setpoint',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_write_test',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownOwnerIdentity);
    expect(outbound.body).toContain('step-up verification');
  });

  it('allows sensitive write operation when step-up verification token is provided', () => {
    const isSensitive = StepUpAuthService.isSensitiveAction('Emergency pump off override setpoint');
    expect(isSensitive).toBe(true);

    const stepUpRefused = StepUpAuthService.verifyStepUp(knownManagerIdentity);
    expect(stepUpRefused.verified).toBe(false);

    const stepUpVerified = StepUpAuthService.verifyStepUp(knownManagerIdentity, 'VERIFIED_STEP_UP');
    expect(stepUpVerified.verified).toBe(true);
  });

  it('returns safe onboarding reply when unknown user attempts an account or device action', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_UNKNOWN_ACTION_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15559990000',
      to_e164:        '+19715885823',
      body:           'Turn off pump in Bay 4',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_unknown_action',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, unknownIdentity);
    expect(outbound.body).toContain('Welcome to vFarm Support');
    expect(outbound.body).not.toContain('BHARAG Knowledge');
  });
});