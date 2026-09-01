import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntentRouter } from '../../engine/src/router/index.js';
import { DbClient } from '../../engine/src/db/client.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

/**
 * IntentRouter Tests
 *
 * All intents route through the BHARAG RAG Knowledge Connector as the sole
 * information source for the system.
 */
describe('IntentRouter & Intent Detection Tests', () => {
  beforeEach(() => {
    DbClient.clearAll();
    seedTestCustomers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'BHARAG Knowledge response for query.' }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const knownIdentity: IdentityContext = {
    customer_ref: 'cust_vfarm_001_john_doe',
    tenant_id: 'tenant-vfarm-01',
    system_id: 'system-vfarm-01',
    is_known_customer: true,
    unit_context: { unit_id: 'unit_bay_04', farm_id: 'farm_austin_main' },
  };

  const unknownIdentity: IdentityContext = {
    customer_ref: 'opaque_unresolved_9999',
    tenant_id: 'tenant-vfarm-01',
    system_id: 'system-vfarm-01',
    is_known_customer: false,
  };

  it('detects status intent and returns BHARAG knowledge response', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_STATUS_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'Bay 4 status check',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_status_test',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);
    expect(outbound.body).toContain('BHARAG Knowledge');
    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
  });

  it('detects knowledge intent and returns BHARAG knowledge response', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_RAG_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'How to clean filter?',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_rag_test',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);
    expect(outbound.body).toContain('BHARAG Knowledge');
    expect(IntentRouter.detectIntent(msg.body)).toBe('knowledge');
  });

  it('detects image intent and returns BHARAG knowledge response', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_IMAGE_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'Send photo of Bay 4',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_image_test',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);
    expect(outbound.body).toContain('BHARAG Knowledge');
    expect(IntentRouter.detectIntent(msg.body)).toBe('images');
  });

  it('detects escalation intent and returns BHARAG knowledge response', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_FAULT_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'Pump alarm water leak emergency!',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_fault_test',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);
    expect(outbound.body).toContain('BHARAG Knowledge');
    expect(IntentRouter.detectIntent(msg.body)).toBe('escalate');
  });

  it('resolves +923082113844 as a known customer (cust_vfarm_003_test_user) and routes to BHARAG RAG', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_REAL_NUMBER_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+923082113844',
      to_e164:        '+19715885823',
      body:           'How to clean the filter on Bay 1?',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_real_number_test',
    };

    const identity: IdentityContext = {
      customer_ref:      'cust_vfarm_003_test_user',
      tenant_id:         'tenant-vfarm-01',
      system_id:         'system-vfarm-01',
      is_known_customer: true,
      unit_context:      { unit_id: 'unit_bay_01', farm_id: 'farm_austin_main' },
    };

    const outbound = await IntentRouter.routeAndHandle(msg, identity);

    expect(outbound.body).toContain('BHARAG Knowledge');
    expect(outbound.to_e164).toBe('+923082113844');
    expect(['knowledge', 'status']).toContain(IntentRouter.detectIntent(msg.body));
  });

  it('routes new (unregistered) sender through connectors just like a known customer', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_UNKNOWN_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15559998888',
      to_e164:        '+19715885823',
      body:           'Hello',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_unknown_test',
    };

    // unknownIdentity.is_known_customer is false, but the router no longer
    // gates connectors on that flag — all contacts get RAG responses.
    const outbound = await IntentRouter.routeAndHandle(msg, unknownIdentity);
    // Should receive a real connector response, not an onboarding wall
    expect(outbound.body).toContain('BHARAG Knowledge');
    expect(outbound.to_e164).toBe(msg.from_e164);
  });
});