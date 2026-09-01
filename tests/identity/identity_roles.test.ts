import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityResolver } from '../../engine/src/identity/resolver.js';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('Identity Resolution & Role Assignment Tests', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();
  });

  const vfarmConfig = SystemsRegistry.getSystemByTenantId('tenant-vfarm-01')!;

  it('resolves known user (+15551234567) with correct customer_ref and manager role', async () => {
    const identity = await IdentityResolver.resolveSenderIdentity('+15551234567', vfarmConfig);

    expect(identity.is_known_customer).toBe(true);
    expect(identity.customer_ref).toBe('cust_vfarm_001_john_doe');
    expect(identity.organization_id).toBe('tenant-vfarm-01');
    expect(identity.tenant_id).toBe('tenant-vfarm-01');
    expect(identity.workspace_id).toBe('ws-vfarm-main');
    expect(identity.role).toBe('manager');
    expect(identity.permissions).toContain('read:telemetry');
    expect(identity.permissions).toContain('write:control');
  });

  it('resolves known user (+923082113844) with owner role', async () => {
    const identity = await IdentityResolver.resolveSenderIdentity('+923082113844', vfarmConfig);

    expect(identity.is_known_customer).toBe(true);
    expect(identity.customer_ref).toBe('cust_vfarm_003_test_user');
    expect(identity.role).toBe('owner');
    expect(identity.permissions).toContain('write:settings');
  });

  it('resolves known user (+15558887777) with tech role', async () => {
    const identity = await IdentityResolver.resolveSenderIdentity('+15558887777', vfarmConfig);

    expect(identity.is_known_customer).toBe(true);
    expect(identity.customer_ref).toBe('cust_vfarm_002_alice_smith');
    expect(identity.role).toBe('tech');
    expect(identity.permissions).toContain('write:escalate');
    expect(identity.permissions).not.toContain('write:settings');
  });

  it('returns is_known_customer: false for unknown sender (+15559990000) without auto-registering in DB', async () => {
    const unknownPhone = '+15559990000';
    const identity = await IdentityResolver.resolveSenderIdentity(unknownPhone, vfarmConfig);

    expect(identity.is_known_customer).toBe(false);
    expect(identity.role).toBe('unknown');
    expect(identity.permissions).toEqual([]);

    // Check DB customer count was NOT mutated
    const dbCustomer = DbClient.lookupCustomerByPhone(unknownPhone, 'tenant-vfarm-01');
    expect(dbCustomer).toBeNull();
  });

  it('treats a partial phone match as an unknown user', async () => {
    // Known phone is +15551234567; pass partial phone +15551234
    const partialPhone = '+15551234';
    const identity = await IdentityResolver.resolveSenderIdentity(partialPhone, vfarmConfig);

    expect(identity.is_known_customer).toBe(false);
    expect(identity.role).toBe('unknown');
    expect(identity.customer_ref).toMatch(/^opaque_unresolved_/);
  });

  it('supports multiple user numbers associated with the same system with different roles', async () => {
    DbClient.seedCustomer({
      tenant_id:    'tenant-vfarm-01',
      phone_e164:   '+15553331111',
      customer_ref: 'cust_vfarm_004_owner_user',
      role:         'owner',
    });

    DbClient.seedCustomer({
      tenant_id:    'tenant-vfarm-01',
      phone_e164:   '+15553332222',
      customer_ref: 'cust_vfarm_005_tech_user',
      role:         'tech',
    });

    const identityOwner = await IdentityResolver.resolveSenderIdentity('+15553331111', vfarmConfig);
    const identityTech  = await IdentityResolver.resolveSenderIdentity('+15553332222', vfarmConfig);

    expect(identityOwner.role).toBe('owner');
    expect(identityTech.role).toBe('tech');
    expect(identityOwner.tenant_id).toBe(identityTech.tenant_id);
  });
});
