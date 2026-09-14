import { IntentRouter } from '../engine/src/router/index.js';
import { DbClient } from '../engine/src/db/client.js';
import { seedTestCustomers } from '../tests/helpers/seed_customers.js';

async function main() {
  DbClient.clearAll();
  seedTestCustomers();

  // Test 1: Real senior/test phone number asking dynamic status
  const seniorIdentity = {
    customer_ref: 'cust_vfarm_003_test_user',
    organization_id: 'tenant-vfarm-01',
    tenant_id: 'tenant-vfarm-01',
    system_id: 'system-vfarm-01',
    workspace_id: 'ws-vfarm-main',
    is_known_customer: true,
    role: 'owner' as const,
    permissions: ['read:telemetry', 'read:knowledge', 'read:media'],
    unit_context: { unit_id: 'unit_bay_01', farm_id: 'farm_austin_main', role: 'owner' },
  };

  const statusMsg = {
    message_id: 'SM_MANUAL_TEST_001',
    tenant_id: 'tenant-vfarm-01',
    from_e164: '+923082113844',
    to_e164: '+19715885823',
    body: 'What is the status of my vFarm?',
    media: [],
    received_at: new Date().toISOString(),
    correlation_id: 'corr_manual_001',
  };

  console.log('\n======================================================');
  console.log('1. Testing: "What is the status of my vFarm?"');
  console.log('======================================================');
  const outboundStatus = await IntentRouter.routeAndHandle(statusMsg, seniorIdentity);
  console.log('Intent Detected:', IntentRouter.detectIntent(statusMsg.body));
  console.log('Bot Response:\n', outboundStatus.body);

  // Test 2: Knowledge Query
  const knowledgeMsg = {
    message_id: 'SM_MANUAL_TEST_002',
    tenant_id: 'tenant-vfarm-01',
    from_e164: '+923082113844',
    to_e164: '+19715885823',
    body: 'How to clean the filter?',
    media: [],
    received_at: new Date().toISOString(),
    correlation_id: 'corr_manual_002',
  };

  console.log('\n======================================================');
  console.log('2. Testing: "How to clean the filter?"');
  console.log('======================================================');
  const outboundKnowledge = await IntentRouter.routeAndHandle(knowledgeMsg, seniorIdentity);
  console.log('Intent Detected:', IntentRouter.detectIntent(knowledgeMsg.body));
  console.log('Bot Response:\n', outboundKnowledge.body);
  console.log('======================================================\n');

  // Test 3: Unbound Caller asking status (must receive explicit refusal instead of default unit telemetry)
  const unboundIdentity = {
    customer_ref: 'cust_vfarm_unbound_user',
    organization_id: 'tenant-vfarm-01',
    tenant_id: 'tenant-vfarm-01',
    system_id: 'system-vfarm-01',
    workspace_id: 'ws-vfarm-main',
    is_known_customer: true,
    role: 'manager' as const,
    permissions: ['read:telemetry', 'read:knowledge'],
    unit_context: undefined,
  };

  const unboundStatusMsg = {
    message_id: 'SM_MANUAL_TEST_003',
    tenant_id: 'tenant-vfarm-01',
    from_e164: '+15557778888',
    to_e164: '+19715885823',
    body: 'What is the status of my unit?',
    media: [],
    received_at: new Date().toISOString(),
    correlation_id: 'corr_manual_003',
  };

  console.log('\n======================================================');
  console.log('3. Testing Unbound Caller Status Refusal: "What is the status of my unit?"');
  console.log('======================================================');
  const outboundUnbound = await IntentRouter.routeAndHandle(unboundStatusMsg, unboundIdentity);
  console.log('Intent Detected:', IntentRouter.detectIntent(unboundStatusMsg.body));
  console.log('Bot Response:\n', outboundUnbound.body);
  console.log('======================================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
