/**
 * Test helper: seed known customer records into DbClient.
 *
 * Since customer data now lives in the `customers` DB table (not env),
 * tests must call this after `DbClient.clearAll()` to simulate a seeded DB.
 *
 * This mirrors db/seeds/001_vfarm_customers.sql for the in-memory store.
 */
import { DbClient } from '../../engine/src/db/client.js';

export function seedTestCustomers(): void {
  DbClient.seedCustomer({
    organization_id: 'tenant-vfarm-01',
    tenant_id:       'tenant-vfarm-01',
    workspace_id:    'ws-vfarm-main',
    phone_e164:      '+923082113844',
    customer_ref:    'cust_vfarm_003_test_user',
    role:            'owner',
    unit_id:         'unit_bay_01',
    farm_id:         'farm_austin_main',
  });
  DbClient.seedCustomer({
    organization_id: 'tenant-vfarm-01',
    tenant_id:       'tenant-vfarm-01',
    workspace_id:    'ws-vfarm-main',
    phone_e164:      '+15551234567',
    customer_ref:    'cust_vfarm_001_john_doe',
    role:            'manager',
    unit_id:         'unit_bay_04',
    farm_id:         'farm_austin_main',
  });
  DbClient.seedCustomer({
    organization_id: 'tenant-vfarm-01',
    tenant_id:       'tenant-vfarm-01',
    workspace_id:    'ws-vfarm-main',
    phone_e164:      '+15558887777',
    customer_ref:    'cust_vfarm_002_alice_smith',
    role:            'tech',
    unit_id:         'unit_bay_12',
    farm_id:         'farm_austin_main',
  });
}
