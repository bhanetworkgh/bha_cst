import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IntentRouter } from '../../engine/src/router/index.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmConnector } from '../../engine/src/connectors/vfarm.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';

/**
 * IntentRouter Tests
 *
 * Status intents route through VfarmConnector preserving caller unit_context (farm_id, unit_id),
 * knowledge through BharagRagConnector, images through MediaServerConnector, and escalations
 * through BharagIncidentsConnector.
 * KMG9: Farm-specific requests never fall back to BHARAG cluster.
 */
describe('IntentRouter & Intent Detection Tests', () => {
  beforeEach(() => {
    DbClient.clearAll();
    seedTestCustomers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      // BHARAG incidents endpoint returns a real incident_id — a response with
      // no id is a genuine creation failure (see the degraded-escalation test
      // below), never a licence to invent one.
      if (String(url).includes('/incidents')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ incident_id: 'inc_real_001', status: 'open' }),
        } as Response;
      }
      // BHARAG cluster knowledge — should NOT be called for farm-specific requests (KMG9)
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

  it('detects status intent, passes unit_context to VfarmConnector, and does NOT call BHARAG cluster when live vFarm client available', async () => {
    // Set up a live vFarm adapter that returns a reading
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);
    vi.spyOn(adapter, 'getLatestDeviceReading').mockResolvedValue({
      sensor_id: 'unit_bay_04',
      reading_ts: '2024-01-15T10:00:00Z',
      temperature_c: 21.5,
      humidity_rh: 60,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

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
    // KMG9: BHARAG cluster must NOT be called for farm-specific telemetry
    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask') || String(call[0]).includes('cluster')
    );
    expect(clusterCalls.length).toBe(0);
    expect(outbound.body).toContain('Status: NORMAL');
    expect(outbound.body).toContain('Temperature: 21.5°C');
  });

  it('enforces multi-tenancy security: rejects message text attempt to override farm_id or unit_id', async () => {
    // Set up a live vFarm adapter
    const adapter = CoreRegistry.getAdapter('tenant-vfarm-01') as VfarmTenantAdapter;
    vi.spyOn(adapter, 'hasLiveClient').mockReturnValue(true);
    vi.spyOn(adapter, 'getLatestDeviceReading').mockResolvedValue({
      sensor_id: 'unit_bay_04',
      reading_ts: '2024-01-15T10:00:00Z',
      temperature_c: 21.5,
      humidity_rh: 60,
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');

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

    const outbound = await IntentRouter.routeAndHandle(maliciousMsg, knownIdentity);

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
    // KMG9: BHARAG cluster must NOT be called
    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask') || String(call[0]).includes('cluster')
    );
    expect(clusterCalls.length).toBe(0);
    expect(outbound.body).toContain('Status: NORMAL');
  });

  it('provides explicit telemetry_unavailable degraded fallback when telemetry endpoints are unreachable', async () => {
    // No live vFarm client (default in test runner) - should return telemetry_unavailable without BHARAG fallback
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

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

    // KMG9: Must NOT call BHARAG cluster
    const clusterCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('/api/v1/cluster/ask') || String(call[0]).includes('cluster')
    );
    expect(clusterCalls.length).toBe(0);
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

  it('tells the customer honestly when a BHARAG incident could not be created', async () => {
    // Incident creation returns 200 but no incident_id — i.e. no ticket exists.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/incidents')) {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ answer: 'BHARAG Knowledge response for query.' }),
      } as Response;
    });

    const msg: InboundMessage = {
      message_id:     'SM_FAULT_TEST_NO_TICKET',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+15551234567',
      to_e164:        '+19715885823',
      body:           'Pump alarm water leak emergency!',
      media:          [],
      received_at:    new Date().toISOString(),
      correlation_id: 'corr_fault_no_ticket',
    };

    const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);

    // No fabricated incident id reaches the customer or the conversation record.
    expect(outbound.body).not.toContain('inc_vfarm_');
    expect(outbound.body).toContain('could not open a support ticket');
    const conv = DbClient.getAllConversations().find((c: any) => c.conversation_id === outbound.id);
    expect(conv?.incident_id ?? null).toBeNull();
  });

  it('resolves +923082113844 as a known customer and routes to vFarm for farm-specific live-state query', async () => {
    const msg: InboundMessage = {
      message_id:     'SM_REAL_NUMBER_TEST_001',
      tenant_id:      'tenant-vfarm-01',
      from_e164:      '+923082113844',
      to_e164:        '+19715885823',
      body:           "What's the status of my farm?",
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

    // KMG9: a farm-status question routes to the vFarm path -> vFarm path
    // No live client in test runner -> telemetry_unavailable, NO BHARAG
    expect(outbound.body).toContain('Telemetry currently unavailable');
    expect(outbound.to_e164).toBe('+923082113844');
    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
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
    expect(outbound.body).toContain('vFarm Support');
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

  // ═══════════════════════════════════════════════════════════════════
  // Units intent routing → vFarm only, never BHARAG
  // ═══════════════════════════════════════════════════════════════════
  describe('Units intent routing', () => {
    it('detectIntent classifies "Can you share the units?" as status (vFarm lane)', async () => {
      expect(IntentRouter.detectIntent("Can you share the units?")).toBe('status');
    });

    it('detectIntent classifies "show me unit readings" as status (vFarm lane)', async () => {
      expect(IntentRouter.detectIntent('show me unit readings')).toBe('status');
    });

    it('detectIntent classifies "what are my unit values?" as status (vFarm lane)', async () => {
      expect(IntentRouter.detectIntent('what are my unit values?')).toBe('status');
    });

    it('routes "Can you share the units?" to vFarm connector, NOT BHARAG cluster', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const msg: InboundMessage = {
        message_id:     'SM_UNITS_TEST_001',
        tenant_id:      'tenant-vfarm-01',
        from_e164:      '+15551234567',
        to_e164:        '+19715885823',
        body:           'Can you share the units?',
        media:          [],
        received_at:    new Date().toISOString(),
        correlation_id: 'corr_units_test',
      };

      const outbound = await IntentRouter.routeAndHandle(msg, knownIdentity);

      // Intent is status → calls VfarmConnector.getUnitStatus
      expect(IntentRouter.detectIntent(msg.body)).toBe('status');
      // KMG9: must NOT call BHARAG cluster
      const clusterCalls = fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes('/api/v1/cluster/ask') || String(call[0]).includes('cluster')
      );
      expect(clusterCalls.length).toBe(0);
      // Response mentions farm-level telemetry (since no unit_id is bound)
      expect(outbound.body).toContain('vFarm Unit');
    });

    it('does not route general knowledge questions to vFarm when units word appears in non-live context', async () => {
      // "how do I clean the units?" — knowledge marker overrides live-state word
      expect(IntentRouter.detectIntent('how do I clean the units?')).toBe('knowledge');
    });
  });
});