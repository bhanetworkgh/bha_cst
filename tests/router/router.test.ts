import { describe, it, expect, beforeEach } from 'vitest';
import { IntentRouter } from '../../engine/src/router/index.js';
import { DbClient } from '../../engine/src/db/client.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

/**
 * IntentRouter Tests
 *
 * Connectors are imported and ready in engine/src/connectors/.
 * Their invocation blocks are commented out in router/index.ts until live endpoints are up.
 * These tests verify that:
 *  - Intent classification works as expected (status, knowledge, images, escalate, default)
 *  - The user's query body is echoed back directly
 *  - Unknown senders receive the tenant onboarding reply
 */
describe('IntentRouter & Intent Detection Tests', () => {
  beforeEach(() => {
    DbClient.clearAll();
    seedTestCustomers();
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

  it('detects status intent and echoes user query back', async () => {
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
    expect(outbound.body).toBe('Bay 4 status check');
    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
  });

  it('detects knowledge intent and echoes user query back', async () => {
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
    expect(outbound.body).toBe('How to clean filter?');
    expect(IntentRouter.detectIntent(msg.body)).toBe('knowledge');
  });

  it('detects image intent and echoes user query back (media_url undefined)', async () => {
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
    expect(outbound.body).toBe('Send photo of Bay 4');
    expect(outbound.media_url).toBeUndefined();
    expect(IntentRouter.detectIntent(msg.body)).toBe('images');
  });

  it('detects escalation intent and echoes user query back', async () => {
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
    expect(outbound.body).toBe('Pump alarm water leak emergency!');
    expect(IntentRouter.detectIntent(msg.body)).toBe('escalate');
  });

  it('routes unknown sender to system onboarding reply', async () => {
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

    const outbound = await IntentRouter.routeAndHandle(msg, unknownIdentity);
    expect(outbound.body).toContain('Welcome to vFarm Support!');
  });
});
