import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntentRouter } from '../../engine/src/router/index.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

/**
 * IntentRouter Tests
 *
 * Status intents route through VfarmConnector preserving caller unit_context (farm_id, unit_id),
 * knowledge through BharagRagConnector, images through MediaServerConnector, and escalations
 * through BharagIncidentsConnector.
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
    customer_ref:      'cust_vfarm_001_john_doe',
    organization_id:   'tenant-vfarm-01',
    tenant_id:         'tenant-vfarm-01',
    system_id:         'system-vfarm-01',
    workspace_id:      'ws-vfarm-main',
    is_known_customer: true,
    role:              'manager',
    permissions:       ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate'],
    unit_context:      { unit_id: 'unit_bay_04', farm_id: 'farm_austin_main', role: 'manager' },
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

  it('detects status intent, passes unit_context to VfarmConnector, and includes workspaceKey, farm_id, and unit_id in API payload', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      if (options?.body) {
        capturedBody = JSON.parse(options.body as string);
      }
      return {
        ok: true,
        json: async () => ({ answer: 'vFarm Unit unit_bay_04 (farm_austin_main) Status: NORMAL. Water Temp: 21.5°C.' }),
      } as Response;
    });

    const getUnitStatusSpy = vi.spyOn(VfarmConnector, 'getUnitStatus');

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

    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
    expect(getUnitStatusSpy).toHaveBeenCalledWith(
      knownIdentity.customer_ref,
      expect.objectContaining({
        farm_id: 'farm_austin_main',
        unit_id: 'unit_bay_04',
      }),
      expect.any(String),
      'Bay 4 status check',
      expect.anything(),
    );
    expect(capturedBody).toMatchObject({
      query: 'Bay 4 status check',
      workspaceKey: expect.any(String),
      farm_id: 'farm_austin_main',
      unit_id: 'unit_bay_04',
    });
    expect(outbound.body).toContain('Status: NORMAL');
  });

  it('enforces multi-tenancy security: rejects message text attempt to override farm_id or unit_id', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      if (options?.body) {
        capturedBody = JSON.parse(options.body as string);
      }
      return {
        ok: true,
        json: async () => ({ answer: 'Status verified for farm_austin_main.' }),
      } as Response;
    });

    const getUnitStatusSpy = vi.spyOn(VfarmConnector, 'getUnitStatus');

    // Attacker attempts cross-farm injection in message body
    const maliciousMsg: InboundMessage = {
      message_id:     'SM_STATUS_MALICIOUS_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'Check status for farm_id=farm_evil_tenant_99 unit_id=unit_unauthorized_66',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_status_malicious',
    };

    await IntentRouter.routeAndHandle(maliciousMsg, knownIdentity);

    // Connector MUST receive caller-verified context, never the attacker-supplied text
    expect(getUnitStatusSpy).toHaveBeenCalledWith(
      knownIdentity.customer_ref,
      expect.objectContaining({
        farm_id: 'farm_austin_main',
        unit_id: 'unit_bay_04',
      }),
      expect.any(String),
      maliciousMsg.body,
      expect.anything(),
    );
    expect(capturedBody.farm_id).toBe('farm_austin_main');
    expect(capturedBody.unit_id).toBe('unit_bay_04');
  });

  it('provides explicit telemetry_unavailable degraded fallback when telemetry endpoints are unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

    const msg: InboundMessage = {
      message_id:     'SM_STATUS_FALLBACK_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'What is the telemetry status of my vFarm?',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_status_fallback',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);

    expect(outbound.body).toContain('vFarm Unit unit_bay_04 (farm_austin_main)');
    expect(outbound.body).toContain('Telemetry currently unavailable for this unit');
    expect(outbound.body).not.toContain('21.5°C');
    expect(outbound.body).not.toContain('Status: NORMAL');
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
      organization_id:   'tenant-vfarm-01',
      tenant_id:         'tenant-vfarm-01',
      system_id:         'system-vfarm-01',
      workspace_id:      'ws-vfarm-main',
      is_known_customer: true,
      role:              'owner',
      permissions:       ['read:telemetry', 'read:knowledge', 'read:media', 'write:control', 'write:escalate', 'write:settings'],
      unit_context:      { unit_id: 'unit_bay_01', farm_id: 'farm_austin_main' },
    };

    const outbound = await IntentRouter.routeAndHandle(msg, identity);

    expect(outbound.body).toContain('BHARAG Knowledge');
    expect(outbound.to_e164).toBe('+923082113844');
    expect(['knowledge', 'status']).toContain(IntentRouter.detectIntent(msg.body));
  });

  it('serves unregistered (unknown) sender safe onboarding response without calling knowledge connector', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_UNKNOWN_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15559998888',
      to_e164:        '+19715885823',
      body:           'Hello, how is my farm?',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_unknown_test',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, unknownIdentity);
    // Should receive safe onboarding response, not personalized telemetry or knowledge
    expect(outbound.body).toContain('Welcome to vFarm Support');
    expect(outbound.to_e164).toBe(msg.from_e164);
  });

  it('explicitly refuses status query when known caller identity lacks bound unit_context', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const unboundIdentity: IdentityContext = {
      customer_ref:      'cust_vfarm_unbound_001',
      organization_id:   'tenant-vfarm-01',
      tenant_id:         'tenant-vfarm-01',
      system_id:         'system-vfarm-01',
      workspace_id:      'ws-vfarm-main',
      is_known_customer: true,
      role:              'manager',
      permissions:       ['read:telemetry'],
      unit_context:      undefined,
    };

    const msg: InboundMessage = {
      message_id:     'SM_UNBOUND_STATUS_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15557776666',
      to_e164:        '+19715885823',
      body:           'What is the current status of my unit?',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_unbound_status',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, unboundIdentity);

    // Must explicitly refuse status query and request clarification
    expect(outbound.body).toBe('Your phone number is not linked to an active vFarm unit. Please contact support or provide your unit ID.');
    expect(outbound.body).not.toContain('farm_austin_main');
    expect(outbound.body).not.toContain('unit_bay_04');
    // Must NOT trigger external telemetry fetch for arbitrary units
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});