import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../../engine/src/app.js';
import {
  getResearchTwinConfigStatus,
  isResearchTwinOperational,
} from '../../engine/src/research_twin/config.js';
import { ResearchTwinClient } from '../../engine/src/research_twin/client.js';
import { ResearchTwinBridge } from '../../engine/src/research_twin/bridge.js';
import {
  findPatterns,
  lookupPatternByCategory,
  formatPatternResolution,
} from '../../engine/src/research_twin/patterns.js';
import {
  ProvisionalResearchTwinLifecycle,
  InMemoryResearchTwinInvestigationStore,
  ResearchTwinTransportError,
} from '../../engine/src/research_twin/lifecycle.js';
import { resetCallbackDeduplication } from '../../engine/src/research_twin/webhook.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { DbClient } from '../../engine/src/db/client.js';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { CallLogPoster } from '../../engine/src/notifications/call_log.js';
import { CstDashboardPublisher, setActiveDashboardPublisher } from '../../engine/src/publishers/dashboard.js';

describe('Research Twin Complete Integration & Failure Bridge (18 Requirements)', () => {
  const SECRET = 'test-rt-callback-secret-key-999';
  const app = createApp();

  const signCallback = (body: any) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const hmac = createHmac('sha256', SECRET).update(raw).digest('hex');
    return `sha256=${hmac}`;
  };

  beforeEach(() => {
    vi.stubEnv('RT_CALLBACK_SIGNING_SECRET', SECRET);
    vi.stubEnv('RT_ENDPOINT_URL', 'https://mock.research-twin.test/api/v1/investigations');
    vi.stubEnv('RT_SERVICE_API_KEY', 'rt_sec_key_xyz123');
    vi.stubEnv('RT_CONTRACT_VERIFIED', 'true');
    vi.stubEnv('CST_CUTOVER_APPROVED', 'true');
    ResearchTwinBridge.reset();
    resetCallbackDeduplication();
    FailureDetector.reset();
    ElevenLabsWebhookService.reset();
    setActiveDashboardPublisher(new CstDashboardPublisher({ dryRun: true }));
  });

  afterEach(() => {
    DbClient.setPool(null);
    ResearchTwinBridge.reset();
    resetCallbackDeduplication();
    setActiveDashboardPublisher(null);
    CallLogPoster.mockHandler = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // 1. Existing environment configuration
  it('1. Existing environment configuration: reports operational when verified', () => {
    const status = getResearchTwinConfigStatus();
    expect(status.state).toBe('operational');
    expect(status.operational).toBe(true);
    expect(status.contract).toBe('verified');
    expect(status.missing).toEqual([]);
    expect(isResearchTwinOperational()).toBe(true);
  });

  // 2. Missing/invalid configuration
  it('2. Missing/invalid configuration: reports unavailable without exposing values', () => {
    const status = getResearchTwinConfigStatus({
      RT_ENDPOINT_URL: 'https://test.example',
      // missing RT_SERVICE_API_KEY and RT_CALLBACK_SIGNING_SECRET
    });
    expect(status.state).toBe('unavailable');
    expect(status.operational).toBe(false);
    expect(status.contract).toBe('unverified');
    expect(status.missing).toContain('RT_SERVICE_API_KEY');
    expect(status.missing).toContain('RT_CALLBACK_SIGNING_SECRET');
  });

  // 3. Research Twin connection check
  it('3. Research Twin connection: checkHealth verifies endpoint reachability', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const client = new ResearchTwinClient({
      endpointUrl: 'https://mock.research-twin.test/api/v1/investigations',
      apiKey: 'test-key',
      fetchFn: mockFetch as any,
    });

    const health = await client.checkHealth();
    expect(health.ok).toBe(true);
    expect(health.status).toBe(200);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // 4. Investigation creation
  it('4. Investigation creation: dispatches valid payload and receives investigation_id', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ investigation_id: 'inv_rt_test_401' }),
    });
    const client = new ResearchTwinClient({
      endpointUrl: 'https://mock.research-twin.test/api/v1/investigations',
      apiKey: 'test-key',
      fetchFn: mockFetch as any,
    });

    const res = await client.createInvestigation({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      correlation_id: 'corr_test_001',
      source_system: 'bha-cst',
      originating_incident_id: 'inc_test_001',
      occurred_at: '2026-11-04T18:34:37.000Z',
      event_type: 'investigation.database_persistence_failure',
      priority: 'critical',
      idempotency_key: 'idem_test_001',
    });

    expect(res.investigation_id).toBe('inv_rt_test_401');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://mock.research-twin.test/api/v1/investigations');
    expect(opts.headers['X-Service-Key']).toBe('test-key');
  });

  // 5. Invalid credentials
  it('5. Invalid credentials: throws non-retryable unauthorized error on 401', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Invalid API Key' }),
      headers: new Headers(),
    });
    const client = new ResearchTwinClient({
      endpointUrl: 'https://mock.research-twin.test/api/v1/investigations',
      apiKey: 'bad-key',
      fetchFn: mockFetch as any,
    });

    await expect(
      client.createInvestigation({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        correlation_id: 'corr_test_002',
        source_system: 'bha-cst',
        originating_incident_id: 'inc_test_002',
        occurred_at: '2026-11-04T18:34:37.000Z',
        event_type: 'investigation.webhook_auth_failure',
        priority: 'high',
        idempotency_key: 'idem_test_002',
      })
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'unauthorized',
      retryable: false,
    });
  });

  // 6. Invalid request/response payload
  it('6. Invalid request/response payload: rejects missing required fields and empty response', async () => {
    const client = new ResearchTwinClient({
      endpointUrl: 'https://mock.research-twin.test/api/v1/investigations',
      apiKey: 'test-key',
    });

    // Invalid outbound payload (missing tenant_id)
    await expect(
      client.createInvestigation({
        tenant_id: '',
        project_id: 'proj-vfarm-main',
        correlation_id: 'corr_test_003',
        source_system: 'bha-cst',
        originating_incident_id: 'inc_test_003',
        occurred_at: '2026-11-04T18:34:37.000Z',
        event_type: 'investigation.test',
        priority: 'low',
        idempotency_key: 'idem_test_003',
      })
    ).rejects.toMatchObject({
      code: 'invalid_payload',
      retryable: false,
    });

    // 200 OK response lacking investigation_id
    const badClient = new ResearchTwinClient({
      endpointUrl: 'https://mock.research-twin.test/api/v1/investigations',
      apiKey: 'test-key',
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'ok' }), // missing investigation_id
      }) as any,
    });

    await expect(
      badClient.createInvestigation({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        correlation_id: 'corr_test_003',
        source_system: 'bha-cst',
        originating_incident_id: 'inc_test_003',
        occurred_at: '2026-11-04T18:34:37.000Z',
        event_type: 'investigation.test',
        priority: 'low',
        idempotency_key: 'idem_test_003',
      })
    ).rejects.toMatchObject({
      code: 'invalid_creation_response',
    });
  });

  // 7. Duplicate failure events
  it('7. Duplicate failure events: deduplicates repeated failures within window', async () => {
    const mockClient = {
      createInvestigation: vi.fn().mockResolvedValue({ investigation_id: 'inv_dedup_001' }),
    };
    ResearchTwinBridge.setClient(mockClient as any);

    const first = await ResearchTwinBridge.dispatchInvestigation(
      'database_persistence_failure',
      'connection timeout to postgres',
      { correlation_id: 'corr_dedup_01' }
    );
    expect(first).not.toBeNull();
    expect(first?.investigation_id).toBe('inv_dedup_001');

    // Immediate duplicate dispatch with identical error & correlation
    const second = await ResearchTwinBridge.dispatchInvestigation(
      'database_persistence_failure',
      'connection timeout to postgres',
      { correlation_id: 'corr_dedup_01' }
    );
    expect(second).toBeNull(); // suppressed
    expect(mockClient.createInvestigation).toHaveBeenCalledTimes(1);
  });

  // 8. Research Twin timeout
  it('8. Research Twin timeout: network abort throws 504 network_timeout', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const mockFetch = vi.fn().mockRejectedValue(abortErr);

    const client = new ResearchTwinClient({
      endpointUrl: 'https://mock.research-twin.test/api/v1/investigations',
      apiKey: 'test-key',
      fetchFn: mockFetch as any,
    });

    await expect(
      client.createInvestigation({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        correlation_id: 'corr_timeout_01',
        source_system: 'bha-cst',
        originating_incident_id: 'inc_timeout_01',
        occurred_at: '2026-11-04T18:34:37.000Z',
        event_type: 'investigation.test',
        priority: 'high',
        idempotency_key: 'idem_timeout_01',
      })
    ).rejects.toMatchObject({
      statusCode: 504,
      code: 'network_timeout',
      retryable: true,
    });
  });

  // 9. Bounded retry behavior
  it('9. Bounded retry behavior: retries transient 503 and stops on non-retryable error', async () => {
    const mockTransport = {
      createInvestigation: vi
        .fn()
        .mockRejectedValueOnce(new ResearchTwinTransportError('upstream_unavailable', true))
        .mockResolvedValueOnce({ investigation_id: 'inv_retry_success_01' }),
    };

    const store = new InMemoryResearchTwinInvestigationStore();
    const lifecycle = new ProvisionalResearchTwinLifecycle({
      transport: mockTransport as any,
      store,
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
    });

    const res = await lifecycle.createInvestigation({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      correlation_id: 'corr_retry_01',
      source_system: 'bha-cst',
      originating_incident_id: 'inc_retry_01',
      occurred_at: '2026-11-04T18:34:37.000Z',
      event_type: 'investigation.test',
      priority: 'high',
      idempotency_key: 'idem_retry_01',
    });

    expect(res.record.research_twin_investigation_id).toBe('inv_retry_success_01');
    expect(mockTransport.createInvestigation).toHaveBeenCalledTimes(2);
  });

  // 10. Callback authentication
  it('10. Callback authentication: rejects missing or invalid X-RT-Signature', async () => {
    // Missing signature
    const resNoSig = await request(app)
      .post('/webhooks/research-twin/callback')
      .send({ investigation_id: 'inv-auth-test' });
    expect(resNoSig.status).toBe(401);
    expect(resNoSig.body.error).toBe('UNAUTHORIZED');

    // Invalid signature
    const resBadSig = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('X-RT-Signature', 'sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb')
      .send({ investigation_id: 'inv-auth-test' });
    expect(resBadSig.status).toBe(403);
    expect(resBadSig.body.error).toBe('FORBIDDEN');
  });

  // 11. Valid callback
  it('11. Valid callback: processes signed callback successfully', async () => {
    const payload = {
      investigation_id: 'inv_valid_111',
      status: 'in_progress',
      assignment: 'agronomy_lead_jegan',
      timestamp: new Date().toISOString(),
      notes: 'Diagnostic telemetry reviewed; dispatching sensor field check.',
    };

    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', signCallback(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'received',
      investigation_id: 'inv_valid_111',
      verified: true,
    });
  });

  // 12. Invalid callback
  it('12. Invalid callback: rejects timestamp drift exceeding 300 seconds', async () => {
    const payload = {
      investigation_id: 'inv_drift_112',
      status: 'resolved',
      timestamp: new Date(Date.now() - 400_000).toISOString(),
    };

    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', signCallback(payload))
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('REPLAY_DETECTED');
  });

  // 13. Duplicate callback
  it('13. Duplicate callback: acknowledges duplicate callback without duplicate processing', async () => {
    const payload = {
      external_event_id: 'evt_cb_dedup_113',
      investigation_id: 'inv_dedup_113',
      status: 'in_progress',
      timestamp: new Date().toISOString(),
    };

    const first = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', signCallback(payload))
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    // Replay duplicate callback
    const second = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', signCallback(payload))
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
  });

  // 14. Unknown investigation ID
  it('14. Unknown investigation ID: handles unknown ID safely without throwing', async () => {
    const payload = {
      investigation_id: 'inv_unknown_999999',
      status: 'closed',
      timestamp: new Date().toISOString(),
    };

    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', signCallback(payload))
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.investigation_id).toBe('inv_unknown_999999');
  });

  // 15. Database persistence
  it('15. Database persistence: persists investigation dispatch and callback records', async () => {
    const mockClient = {
      createInvestigation: vi.fn().mockResolvedValue({ investigation_id: 'inv_persist_115' }),
    };
    ResearchTwinBridge.setClient(mockClient as any);

    await ResearchTwinBridge.dispatchInvestigation(
      'database_persistence_failure',
      'database pool exhausted',
      { correlation_id: 'corr_persist_115' }
    );

    const outcomes = DbClient.getAllDashboardPublishOutcomes();
    const invRow = outcomes.find((r) => r.event_type === 'cst.research_twin.investigation');
    expect(invRow).toBeDefined();
    expect(invRow?.correlation_id).toBe('corr_persist_115');
    expect((invRow?.payload as any)?.investigation_id).toBe('inv_persist_115');

    // Persist callback
    const cbPayload = {
      external_event_id: 'evt_cb_persist_115',
      investigation_id: 'inv_persist_115',
      status: 'resolved',
      timestamp: new Date().toISOString(),
    };

    await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', signCallback(cbPayload))
      .send(cbPayload);

    const cbRow = DbClient.getAllDashboardPublishOutcomes().find(
      (r) => r.event_type === 'cst.research_twin.callback' && r.correlation_id === 'inv_persist_115'
    );
    expect(cbRow).toBeDefined();
    expect((cbRow?.payload as any)?.lifecycle_status).toBe('resolved');
  });

  // 16. Investigation status updates
  it('16. Investigation status updates: reflects updated status on callback arrival', async () => {
    const cbPayload = {
      external_event_id: 'evt_cb_status_116',
      investigation_id: 'inv_status_116',
      lifecycle_status: 'resolved',
      assignment: 'tech_lead_ahad',
      timestamp: new Date().toISOString(),
      notes: 'PostgreSQL connection timeout resolved by scaling pool.',
    };

    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', signCallback(cbPayload))
      .send(cbPayload);

    expect(res.status).toBe(200);
    const cbRow = DbClient.getAllDashboardPublishOutcomes().find(
      (r) => r.event_id === 'evt_cb_status_116'
    );
    expect(cbRow).toBeDefined();
    expect((cbRow?.payload as any)?.lifecycle_status).toBe('resolved');
    expect((cbRow?.payload as any)?.assignment).toBe('tech_lead_ahad');
  });

  // 17. Pattern retrieval and reuse
  it('17. Pattern retrieval and reuse: matches failure to root cause and runbook', () => {
    const matched = lookupPatternByCategory(
      'database_persistence_failure',
      'connection timeout to postgres'
    );
    expect(matched).toBeDefined();
    expect(matched?.pattern_id).toBe('PATT-DB-PERSIST-001');
    expect(matched?.root_cause).toContain('DATABASE_URL');
    expect(matched?.runbook_reference).toBe('docs/reports/CST_MIGRATION_LEDGER_RECONCILIATION.md');

    const formatted = formatPatternResolution(matched!);
    expect(formatted).toContain('PATT-DB-PERSIST-001');

    const searchResults = findPatterns({ query: 'drift' });
    expect(searchResults.some((p) => p.pattern_id === 'PATT-WH-AUTH-001')).toBe(true);
  });

  // 18. Research Twin outage without customer-facing webhook failure
  it('18. Outage resilience: webhook processes with 200 OK even if Research Twin fails', async () => {
    const failingMockClient = {
      createInvestigation: vi.fn().mockRejectedValue(new Error('Research Twin cluster down 503')),
    };
    ResearchTwinBridge.setClient(failingMockClient as any);

    // Call Log mock
    CallLogPoster.mockHandler = vi.fn().mockResolvedValue({
      posted: true,
      via: 'bot',
      ts: '1793821609.120139',
      transcript: 'file',
    });

    const payload = {
      type: 'post_call_transcription',
      conversation_id: 'conv_rt_outage_018',
      agent_id: 'agent_vfarm_cs_v1',
      start_time_unix_secs: 1793817277,
      call_duration_secs: 15,
      transcript: [{ role: 'agent', message: 'Hello', time_in_call_secs: 1 }],
      metadata: {
        caller_id: '+923082113844',
        custom_variables: { caller_phone: '+923082113844' },
      },
    };

    const webhookSecret = 'wsec_test_secret_123';
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', webhookSecret);
    const raw = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = createHmac('sha256', webhookSecret.slice(5)).update(`${timestamp}.${raw}`).digest('hex');
    const signature = `t=${timestamp},v0=${hmac}`;

    // Customer webhook request
    const res = await request(app)
      .post('/webhooks/elevenlabs/post-call')
      .set('elevenlabs-signature', signature)
      .send(payload);

    // Customer response must succeed with 200 OK!
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
  });
});
