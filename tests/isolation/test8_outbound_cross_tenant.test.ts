import { describe, it, expect, beforeEach } from 'vitest';
import { DbClient } from '../../engine/src/db/client.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';
import {
  processOutboundQueue,
  setCrossTenantRule,
  clearCrossTenantRules,
} from '../../engine/src/transport/twilio/outbound.js';
import { TwilioClientWrapper } from '../../engine/src/transport/twilio/client.js';

import { seedTestCustomers } from '../helpers/seed_customers.js';

describe('Isolation Test 8: Outbound Cross-Tenant Prevention', () => {
  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    clearCrossTenantRules();
    seedTestCustomers();

    // Register a minimal Tenant B fixture for cross-tenant isolation tests.
    // This replaces the old hardcoded Tenant B entry that was removed from the default registry.
    SystemsRegistry.registerSystem({
      system_id:       'system-tenant-b-02',
      organization_id: 'tenant-b-02',
      tenant_id:       'tenant-b-02',
      workspace_id:    'ws-tenant-b-main',
      name:            'Tenant B (Test Fixture)',
      status:          'active',
      phone_numbers:   ['+15559992222'],
      onboarding_reply: 'Welcome to Tenant B Support!',
    });
  });

  it('refuses outbound send to a number registered to another tenant', async () => {
    let sendCount = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      sendCount++;
      return { sid: 'SM_SHOULD_NOT_BE_CALLED', status: 'failed' };
    });

    // Destination phone is +15559992222 which belongs to Tenant B
    const tenantBPhone = '+15559992222';

    // Tenant A attempts to queue an outbound message to Tenant B's number
    const maliciousOutbound = await DbClient.saveOutboundMessage({
      tenant_id: 'tenant-vfarm-01', // Tenant A (vFarm)
      to_e164: tenantBPhone, // Belongs to Tenant B
      body: 'Cross tenant leak attempt',
      correlation_id: 'corr_test_8_cross_tenant',
    });

    // Run outbound worker queue processor
    await processOutboundQueue();

    // 1. Worker MUST refuse send and NOT call Twilio API
    expect(sendCount).toBe(0);

    // 2. Status of outbound queue message must be marked 'refused'
    const updatedMsgs = await DbClient.getPendingOutboundMessages();
    expect(updatedMsgs.length).toBe(0); // No longer pending
  });

  it('refuses outbound send to explicit cross-tenant customer number', async () => {
    let sendCount = 0;
    TwilioClientWrapper.setMockHandler(async () => {
      sendCount++;
      return { sid: 'SM_FAIL', status: 'failed' };
    });

    const targetCustomerPhone = '+15554443333';
    // Set rule that targetCustomerPhone belongs to Tenant B
    setCrossTenantRule(targetCustomerPhone, 'tenant-b-02');

    // Tenant A attempts to send to Tenant B's customer
    await DbClient.saveOutboundMessage({
      tenant_id: 'tenant-vfarm-01', // Tenant A
      to_e164: targetCustomerPhone,
      body: 'Unauthorized tenant cross message',
      correlation_id: 'corr_test_8_explicit',
    });

    await processOutboundQueue();

    expect(sendCount).toBe(0);
  });
});
