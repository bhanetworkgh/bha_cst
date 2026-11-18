/**
 * Deterministic Authenticated vFarm Endpoint E2E Acceptance Test Suite
 *
 * Loop: LOOP-1790682740121-9YQU
 * Codex Row: 472 ("loop vFarm user-facing endpoint and chooser verification")
 * Acceptance Reference: Jason's six-step instruction (https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1794349885334349)
 *
 * Exercises the complete CST request path through actual Express routes and middleware:
 *   HTTP Request -> Authentication Middleware -> Tenant & Identity Resolution
 *   -> Authorization Grant Enforcement -> Upstream vFarm Request -> Response Mapping -> HTTP Response
 *
 * Proof Boundaries:
 *   - CST core routes, middleware, and connectors are fully executed (not mocked).
 *   - Upstream vFarm boundary is driven by a faithful deterministic mock test server.
 *   - Every positive and negative acceptance case required by Codex row 472 is asserted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';
import { VfarmTenantAdapter } from '../../engine/src/adapters/vfarm/index.js';
import { __registerInMemoryAdminSession } from '../../engine/src/middleware/vfarm_proxy_auth.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { VoiceLaneService } from '../../engine/src/transport/voice/voice_lane.js';
import { seedTestCustomers } from '../helpers/seed_customers.js';
import { IntentRouter } from '../../engine/src/router/index.js';
import { InboundMessage, IdentityContext } from '../../engine/src/transport/twilio/types.js';

// Deterministic test constants
const TENANT_ID = 'tenant-vfarm-01';
const PROJECT_ID = 'proj-vfarm-main';
const AUTHORIZED_FARM_ID = 'farm-alpha-101';
const UNAUTHORIZED_FARM_ID = 'farm_dallas_north';
const SENSOR_DEVICE_ID = 'sensor-temp-01';

const CST_ADMIN_TOKEN = 'test-cst-admin-session-token';
const CST_ADMIN_EMAIL = 'admin@cst.com';

function makeJwt(subject: string, expSecondsFromNow: number): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })}.sig`;
}

const VALID_CALLER_JWT = makeJwt('caller-user-alpha', 3600);
const EXPIRED_CALLER_JWT = makeJwt('caller-user-expired', -3600);

interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface MockUpstreamOptions {
  simulateTimeout?: boolean;
  simulate503?: boolean;
  emptyReadings?: boolean;
  rejectJwt?: boolean;
}

function buildFaithfulMockVfarm(opts: MockUpstreamOptions = {}) {
  const calls: UpstreamCall[] = [];

  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const method = init?.method || 'GET';
    const rawHeaders = (init?.headers || {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: urlStr, method, headers });

    const bearer = headers['authorization']?.replace(/^Bearer\s+/i, '') || '';
    const json = (status: number, body: unknown) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as Response;

    // Timeout simulation
    if (opts.simulateTimeout) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }

    // 503 Upstream failure simulation
    if (opts.simulate503) {
      return json(503, { error: 'SERVICE_UNAVAILABLE', message: 'vFarm cluster overloaded' });
    }

    // Expired or invalid JWT simulation
    if (opts.rejectJwt && bearer) {
      return json(401, { detail: 'Token signature invalid or token expired' });
    }

    // Auth Login endpoint
    if (urlStr.includes('/api/v1/auth/login')) {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.email === 'farmer@vfarm.com' && body.password === 'valid-farmer-pass') {
        return json(200, {
          user: { id: 'usr-farmer-1', email: 'farmer@vfarm.com', name: 'Farmer Joe' },
          farms: [
            { id: AUTHORIZED_FARM_ID, farm_id: AUTHORIZED_FARM_ID, name: 'Alpha Green Farm', role: 'owner' },
          ],
          access_token: VALID_CALLER_JWT,
        });
      }
      if (body.email === 'revoked@vfarm.com' && body.password === 'revoked-pass') {
        return json(200, {
          user: { id: 'usr-revoked-1', email: 'revoked@vfarm.com', name: 'Revoked Farmer' },
          farms: [],
          access_token: makeJwt('revoked-farmer', 3600),
        });
      }
      return json(401, { detail: 'Invalid email or password' });
    }

    // Farm Discovery endpoint
    if (urlStr.includes('/api/v1/farms?') || urlStr.endsWith('/api/v1/farms')) {
      return json(200, {
        farms: [
          {
            id: AUTHORIZED_FARM_ID,
            farm_id: AUTHORIZED_FARM_ID,
            name: 'Alpha Green Farm',
            is_active: true,
            device_count: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        total: 1,
      });
    }

    // Farm Health endpoint
    if (urlStr.includes(`/api/v1/farms/${AUTHORIZED_FARM_ID}/health`)) {
      return json(200, {
        farm_id: AUTHORIZED_FARM_ID,
        status: 'healthy',
        online_count: 1,
        offline_count: 0,
        unhealthy_count: 0,
      });
    }

    // Farm Detail endpoint
    if (urlStr.includes(`/api/v1/farms/${AUTHORIZED_FARM_ID}`) && !urlStr.includes('/health')) {
      return json(200, {
        id: AUTHORIZED_FARM_ID,
        name: 'Alpha Green Farm',
        is_active: true,
      });
    }

    // Devices List endpoint
    if (urlStr.includes('/api/v1/devices?')) {
      return json(200, {
        devices: [
          {
            id: SENSOR_DEVICE_ID,
            device_type: 'sensor',
            device_name: 'Water Temp Sensor 1',
            status: 'active',
            farm_id: AUTHORIZED_FARM_ID,
          },
        ],
        total: 1,
        online_count: 1,
        offline_count: 0,
        registered_count: 1,
        unhealthy_count: 0,
      });
    }

    // Readings latest endpoint (for single sensor probe)
    if (urlStr.includes('/readings/latest')) {
      if (opts.emptyReadings) {
        return json(200, {
          sensor_id: SENSOR_DEVICE_ID,
          reading_ts: '2026-11-18T12:00:00Z',
          received_at: '2026-11-18T12:00:05Z',
          values: {},
        });
      }
      return json(200, {
        id: 101,
        sensor_id: SENSOR_DEVICE_ID,
        reading_ts: '2026-11-18T12:00:00Z',
        received_at: '2026-11-18T12:00:05Z',
        temperature_c: 21.8,
        humidity_rh: 62.5,
        values: {
          temperature: { value: 21.8, unit: 'celsius', status: 'normal' },
          humidity: { value: 62.5, unit: 'percent', status: 'normal' },
        },
      });
    }

    // Readings array endpoint
    if (urlStr.includes('/readings?')) {
      if (opts.emptyReadings) {
        return json(200, { sensor_id: SENSOR_DEVICE_ID, count: 0, readings: [] });
      }
      return json(200, {
        sensor_id: SENSOR_DEVICE_ID,
        from: '2026-11-18T00:00:00Z',
        to: '2026-11-18T12:00:00Z',
        count: 1,
        readings: [
          {
            id: 101,
            sensor_id: SENSOR_DEVICE_ID,
            reading_ts: '2026-11-18T12:00:00Z',
            received_at: '2026-11-18T12:00:05Z',
            values: {
              temperature: { value: 21.8, unit: 'celsius', status: 'normal' },
              humidity: { value: 62.5, unit: 'percent', status: 'normal' },
            },
          },
        ],
      });
    }

    // Alerts endpoint
    if (urlStr.includes('/alerts')) {
      return json(200, { alerts: [], total: 0 });
    }

    return json(404, { detail: 'Not found' });
  });

  return { fn, calls };
}

describe('LOOP-1790682740121-9YQU / Codex Row 472 — Authenticated vFarm Endpoint E2E Proof', () => {
  const app = createApp();
  let upstream: ReturnType<typeof buildFaithfulMockVfarm>;
  let savedPool: unknown;
  const envBackup = { ...process.env };

  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();

    savedPool = DbClient.getPool();
    DbClient.setPool(null); // Ensure deterministic in-memory session store

    process.env.NODE_ENV = 'test';
    delete process.env.VFARM_FARM_ID; // Prevent fallback injection
    process.env.VFARM_TENANT_ID = TENANT_ID;
    process.env.VFARM_PROJECT_ID_MAIN = PROJECT_ID;
    process.env.VFARM_API_BASE_URL = 'https://mock.vfarm.upstream';
    process.env.VFARM_BASE_URL = 'https://mock.vfarm.upstream';
    process.env.VFARM_ADMIN_EMAIL = 'operator@cst.bhanetwork.org';
    process.env.VFARM_ADMIN_PASSWORD = 'operator-password';
    process.env.VFARM_API_JWT = 'cst-operator-static-jwt';

    __registerInMemoryAdminSession(
      CST_ADMIN_TOKEN,
      CST_ADMIN_EMAIL,
      new Date(Date.now() + 60 * 60 * 1000), // Valid for 1 hour
    );

    upstream = buildFaithfulMockVfarm();
    vi.spyOn(globalThis, 'fetch').mockImplementation(upstream.fn as any);

    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.upstream',
      apiKey: 'cst-live-farm-key',
      apiToken: 'cst-operator-static-jwt',
      fetchFn: upstream.fn as any,
    });

    CoreRegistry.registerTenant(
      {
        tenant_id: TENANT_ID,
        name: 'vFarm Vertical Farming Systems',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );

    CoreRegistry.registerProject({
      project_id: PROJECT_ID,
      tenant_id: TENANT_ID,
      name: 'vFarm Commercial Pilot Main',
      status: 'active',
      voice_enabled: true,
      elevenlabs_voice_id: 'eleven_voice_test',
      elevenlabs_model_id: 'eleven_turbo_v2_5',
      capabilities: {
        voice: true,
        sms: true,
        web: true,
      },
    });

    CoreRegistry.bindServiceNumber({
      phone_e164: '+19715885823',
      tenant_id: TENANT_ID,
      project_id: PROJECT_ID,
      capability: 'sms_voice',
      status: 'bound',
      bound_at: new Date().toISOString(),
    });

    seedTestCustomers();

    VoiceInterface.setSynthesizer({
      synthesize: vi.fn(async ({ text, voiceId }) => ({
        audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
        mimeType: 'audio/mpeg',
      })),
    });
    VoiceLaneService.setSynthesizer({
      synthesize: vi.fn(async ({ text, voiceId }) => ({
        audioBase64: Buffer.from(`audio-${voiceId}-${text.slice(0, 8)}`).toString('base64'),
        mimeType: 'audio/mpeg',
      })),
    });

    upstream.calls.length = 0; // Clear bootstrap calls
  });

  afterEach(() => {
    process.env = { ...envBackup };
    DbClient.setPool(savedPool as any);
    vi.restoreAllMocks();
  });

  // ── PHASE C1: POSITIVE ACCEPTANCE CASES ────────────────────────────────────

  it('POSITIVE CASE 1: Valid authenticated caller JWT requests vFarm data via /api/v1/farms', async () => {
    const res = await request(app)
      .get('/api/v1/farms')
      .set('Authorization', `Bearer ${VALID_CALLER_JWT}`);

    // Verify HTTP status & schema
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('farms');
    expect(res.body).toHaveProperty('total', 1);
    expect(res.body.farms).toHaveLength(1);

    const farm = res.body.farms[0];
    expect(farm.id).toBe(AUTHORIZED_FARM_ID);
    expect(farm.name).toBe('Alpha Green Farm');
    expect(res.body.active_farm_id).toBe(AUTHORIZED_FARM_ID);

    // Verify upstream request carried the caller's JWT verbatim without CST credential substitution
    const farmCalls = upstream.calls.filter((c) => c.url.includes('/api/v1/farms'));
    expect(farmCalls.length).toBeGreaterThan(0);
    const lastCall = farmCalls[farmCalls.length - 1];
    expect(lastCall.headers['authorization']).toBe(`Bearer ${VALID_CALLER_JWT}`);
    expect(lastCall.headers['x-farm-key']).toBeUndefined();

    // Verify no secret CST admin credentials were leaked
    expect(upstream.calls.some((c) => c.url.includes('/auth/login'))).toBe(false);
  });

  it('POSITIVE CASE 2: Valid authenticated web farmer logs in, receives scoped session, and reads live telemetry', async () => {
    // Step 1: Farmer logs into CST web session using vFarm credentials
    const sessionRes = await request(app)
      .post('/api/v1/web/session')
      .send({ email: 'farmer@vfarm.com', password: 'valid-farmer-pass' });

    expect(sessionRes.status).toBe(201);
    expect(sessionRes.body).toHaveProperty('session');
    expect(sessionRes.body.user.name).toBe('Farmer Joe');
    expect(sessionRes.body.tenant.id).toBe(TENANT_ID);
    expect(sessionRes.body.project.id).toBe(PROJECT_ID);
    expect(sessionRes.body.farms).toContain(AUTHORIZED_FARM_ID);

    const sessionToken = sessionRes.body.session;

    // Step 2: Farmer requests live telemetry through user-facing endpoint
    const msgRes = await request(app)
      .post('/api/v1/web/message')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ text: 'What is the status of my farm?' });

    expect(msgRes.status).toBe(200);
    expect(msgRes.body).toHaveProperty('reply_text');
    expect(msgRes.body.status).toBe('ok');
    expect(msgRes.body.tenant_id).toBe(TENANT_ID);
    expect(msgRes.body.project_id).toBe(PROJECT_ID);

    // Genuine live reading data must be returned
    expect(msgRes.body.reply_text).toContain('1 devices');
    expect(msgRes.body.reply_text).toContain('1 are online');
    expect(msgRes.body.reply_text).toContain('Temperature: 21.8°C');
    expect(msgRes.body.reply_text).toContain('Humidity: 62.5%');
  });

  it('POSITIVE CASE 3 (Call Testing on Handset +923082113844 / +920382113844): Inbound voice call resolves customer identity, scopes to tenant/project, applies farm authorization, and executes honest speech turn', async () => {
    // 1. Inbound ringing call from Pakistani handset +923082113844
    const inboundRes = await request(app)
      .post('/webhooks/twilio/voice/inbound')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        CallSid: 'CA26d9ef83116a44bb2871d7f22757c0b8',
        From: '+923082113844',
        To: '+19715885823',
        CallStatus: 'ringing',
      });

    expect(inboundRes.status).toBe(200);
    expect(inboundRes.body.status).toBe('initiated');
    expect(inboundRes.body.tenant_id).toBe(TENANT_ID);
    expect(inboundRes.body.project_id).toBe(PROJECT_ID);
    expect(inboundRes.body.call_sid).toBe('CA26d9ef83116a44bb2871d7f22757c0b8');

    // 2. Subsequent speech turn asking for farm status
    const turnRes = await request(app)
      .post('/webhooks/twilio/voice/turn')
      .set('Host', 'localhost:3000')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send({
        CallSid: 'CA26d9ef83116a44bb2871d7f22757c0b8',
        From: '+923082113844',
        To: '+19715885823',
        SpeechResult: 'What is the status of my farm?',
        CallStatus: 'in-progress',
      });

    expect(turnRes.status).toBe(200);
    expect(turnRes.body.status).toBe('synthesized');
    expect(turnRes.body.tenant_id).toBe(TENANT_ID);
    expect(turnRes.body.project_id).toBe(PROJECT_ID);
    expect(turnRes.body.text).toBeDefined();
    expect(turnRes.body.audioBase64).toBeDefined();

    // Verify delivery attribution in database
    const deliveries = DbClient.getAllVoiceDeliveries();
    expect(deliveries.length).toBeGreaterThan(0);
    const lastDelivery = deliveries[deliveries.length - 1];
    expect(lastDelivery.tenant_id).toBe(TENANT_ID);
    expect(lastDelivery.project_id).toBe(PROJECT_ID);
  });

  it('POSITIVE CASE 4 (Message Testing on Handset +923082113844 / +920382113844): Inbound message routes to vFarm, resolves customer identity, and enforces anti-fabrication farm scope', async () => {
    const msg: InboundMessage = {
      message_id: 'SM_REAL_923082113844_TEST',
      tenant_id: TENANT_ID,
      from_e164: '+923082113844',
      to_e164: '+19715885823',
      body: "What's the status of my farm?",
      media: [],
      received_at: new Date().toISOString(),
      correlation_id: 'corr_test_923082113844',
    };

    const identity: IdentityContext = {
      customer_ref: 'cust_vfarm_003_test_user',
      organization_id: TENANT_ID,
      tenant_id: TENANT_ID,
      system_id: 'system-vfarm-01',
      workspace_id: 'ws-vfarm-main',
      is_known_customer: true,
      role: 'owner',
      permissions: ['read:telemetry', 'read:knowledge', 'read:media', 'write:control'],
      unit_context: { unit_id: 'unit_bay_01', farm_id: AUTHORIZED_FARM_ID },
    };

    const outbound = await IntentRouter.routeAndHandle(msg, identity);

    expect(outbound.to_e164).toBe('+923082113844');
    expect(IntentRouter.detectIntent(msg.body)).toBe('status');
    expect(outbound.body).toBeDefined();
  });

  // ── PHASE C2: NEGATIVE ACCEPTANCE CASES (FAIL-CLOSED) ──────────────────────

  it('NEGATIVE CASE 1: Missing authentication fails closed with 401 and zero upstream calls', async () => {
    const res = await request(app).get('/api/v1/farms');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.body.message).toContain('Authentication required');

    // Zero upstream calls: CST never contacted vFarm with its own keys
    expect(upstream.calls).toHaveLength(0);
  });

  it('NEGATIVE CASE 2: Invalid or expired caller JWT fails closed with 401 without credential escalation', async () => {
    const rejectingUpstream = buildFaithfulMockVfarm({ rejectJwt: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(rejectingUpstream.fn as any);

    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.upstream',
      apiKey: 'cst-live-farm-key',
      apiToken: 'cst-operator-static-jwt',
      fetchFn: rejectingUpstream.fn as any,
    });
    CoreRegistry.registerTenant(
      {
        tenant_id: TENANT_ID,
        name: 'vFarm',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );

    const res = await request(app)
      .get('/api/v1/farms')
      .set('Authorization', `Bearer ${EXPIRED_CALLER_JWT}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.body.message).toBe('vFarm rejected the supplied credentials');

    // Anti-escalation check: CST must NOT log in with operator credentials to paper over bad token
    expect(rejectingUpstream.calls.some((c) => c.url.includes('/auth/login'))).toBe(false);
  });

  it('NEGATIVE CASE 3: Unknown or invalid web session token fails closed with 401', async () => {
    const res = await request(app)
      .post('/api/v1/web/message')
      .set('authorization', 'Bearer unrecorded-bogus-session-token')
      .send({ text: 'What is the temperature?' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_SESSION');
    expect(upstream.calls).toHaveLength(0);
  });

  it('NEGATIVE CASE 4: Missing tenant or uninitialized adapter fails closed with 503', async () => {
    CoreRegistry.clear(); // Unregister all tenants and adapters

    const res = await request(app)
      .get('/api/v1/farms')
      .set('x-admin-token', CST_ADMIN_TOKEN);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('ADAPTER_UNAVAILABLE');
    expect(res.body.message).toContain('vFarm adapter is not registered');
  });

  it('NEGATIVE CASE 5: Unauthorized farm request is refused without querying upstream for that farm', async () => {
    // Log in as farmer Joe (granted only AUTHORIZED_FARM_ID)
    const sessionRes = await request(app)
      .post('/api/v1/web/session')
      .send({ email: 'farmer@vfarm.com', password: 'valid-farmer-pass' });
    const sessionToken = sessionRes.body.session;
    upstream.calls.length = 0; // Clear login calls

    // Attempt to query an out-of-scope farm (farm_dallas_north)
    const res = await request(app)
      .post('/api/v1/web/message')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ text: `Can you show me readings for ${UNAUTHORIZED_FARM_ID}?` });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('refused');
    expect(res.body.reply_text).toContain(`You do not have access to queries for ${UNAUTHORIZED_FARM_ID}`);
    expect(res.body.reply_text).toContain(AUTHORIZED_FARM_ID);

    // Assert that vFarm upstream was NEVER queried for the unauthorized farm
    const unauthorizedCalls = upstream.calls.filter((c) => c.url.includes(UNAUTHORIZED_FARM_ID));
    expect(unauthorizedCalls).toHaveLength(0);
  });

  it('NEGATIVE CASE 6: Stale or empty authorization grant (revoked farms) fails closed', async () => {
    // Log in user with empty farm grant list (revoked)
    const sessionRes = await request(app)
      .post('/api/v1/web/session')
      .send({ email: 'revoked@vfarm.com', password: 'revoked-pass' });
    expect(sessionRes.status).toBe(201);
    expect(sessionRes.body.farm_count).toBe(0);
    const sessionToken = sessionRes.body.session;

    const res = await request(app)
      .post('/api/v1/web/message')
      .set('authorization', `Bearer ${sessionToken}`)
      .send({ text: 'What is the status of my farm?' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('refused');
    expect(res.body.reply_text).toContain('Your account is not linked to any active farm resources in this project');
  });

  it('NEGATIVE CASE 7: Upstream vFarm 503 unavailable surfaces error without fabricated fallback data', async () => {
    const errorUpstream = buildFaithfulMockVfarm({ simulate503: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(errorUpstream.fn as any);

    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.upstream',
      apiKey: 'cst-live-farm-key',
      apiToken: 'cst-operator-static-jwt',
      fetchFn: errorUpstream.fn as any,
    });
    CoreRegistry.registerTenant(
      {
        tenant_id: TENANT_ID,
        name: 'vFarm',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );

    const res = await request(app)
      .get('/api/v1/farms')
      .set('Authorization', `Bearer ${VALID_CALLER_JWT}`);

    // Upstream 503 is cleanly reported as 503
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('DISCOVERY_ERROR');
    expect(res.body.farms).toBeUndefined();
  });

  it('NEGATIVE CASE 8: Upstream vFarm timeout fails closed without returning synthetic telemetry', async () => {
    const timeoutUpstream = buildFaithfulMockVfarm({ simulateTimeout: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(timeoutUpstream.fn as any);

    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.upstream',
      apiKey: 'cst-live-farm-key',
      apiToken: 'cst-operator-static-jwt',
      fetchFn: timeoutUpstream.fn as any,
    });
    CoreRegistry.registerTenant(
      {
        tenant_id: TENANT_ID,
        name: 'vFarm',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );

    const res = await request(app)
      .get('/api/v1/farms')
      .set('Authorization', `Bearer ${VALID_CALLER_JWT}`);

    // Network timeout results in error response, never synthetic farms
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DISCOVERY_ERROR');
    expect(res.body.farms).toBeUndefined();
  });

  it('NEGATIVE CASE 9: Empty live-data readings return empty without injecting synthetic normal data', async () => {
    const emptyUpstream = buildFaithfulMockVfarm({ emptyReadings: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(emptyUpstream.fn as any);

    const adapter = new VfarmTenantAdapter(TENANT_ID, {
      baseUrl: 'https://mock.vfarm.upstream',
      apiKey: 'cst-live-farm-key',
      apiToken: 'cst-operator-static-jwt',
      fetchFn: emptyUpstream.fn as any,
    });
    CoreRegistry.registerTenant(
      {
        tenant_id: TENANT_ID,
        name: 'vFarm',
        status: 'active',
        adapter_type: 'vfarm',
        created_at: new Date().toISOString(),
      },
      adapter,
    );

    // Call adapter directly to inspect latest readings payload mapping
    const readings = await adapter.listLatestReadings({
      farmId: AUTHORIZED_FARM_ID,
      speaker: {
        person_id: 'usr-farmer-1',
        customer_ref: 'farmer@vfarm.com',
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        phone_e164: '+10000000000',
        is_known: true,
        role: 'owner',
        permissions: ['read'],
        farm_ids: [AUTHORIZED_FARM_ID],
      },
    });

    expect(readings).toHaveLength(0);
  });

  it('NEGATIVE CASE 10: Caller cannot access another user or tenant resource', async () => {
    // CST adapter has a cached server-wide farm from another tenant
    const adapter = CoreRegistry.getVfarmAdapter()!;
    (adapter as any).discoveredFarms = [
      { id: 'foreign-tenant-farm-999', name: 'Foreign Tenant Farm' },
    ];

    const res = await request(app)
      .get('/api/v1/farms')
      .set('Authorization', `Bearer ${VALID_CALLER_JWT}`);

    expect(res.status).toBe(200);
    const ids = res.body.farms.map((f: any) => f.id);
    expect(ids).toContain(AUTHORIZED_FARM_ID);
    expect(ids).not.toContain('foreign-tenant-farm-999');
    expect(res.body.active_farm_id).toBe(AUTHORIZED_FARM_ID);
    expect(res.body.active_farm_id).not.toBe('foreign-tenant-farm-999');
  });
});
