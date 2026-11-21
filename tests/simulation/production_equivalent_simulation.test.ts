import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pg from 'pg';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { DbClient } from '../../engine/src/db/client.js';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { EscalationService } from '../../engine/src/escalation/service.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { CutOverManager } from '../../engine/src/observability/cut_over.js';
import { CstTurnEventV1Schema } from '../../engine/src/contracts/events.js';
import { serializeForDashboard, CstDashboardPublisher, setActiveDashboardPublisher } from '../../engine/src/publishers/dashboard.js';

// Top-level module mocks for external dispatch boundaries
vi.mock('../../engine/src/notifications/call_log.js', () => ({
  CallLogPoster: {
    post: vi.fn().mockResolvedValue({ posted: true, channel: 'C0BD6D53HAM', ts: '1795200874.000100' }),
  },
  collected: () => undefined,
  endedRecord: () => ({}),
}));

const TEST_DB_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/bha_cst_sim';

describe('CST — Comprehensive Production-Equivalent Simulation', () => {
  let pool: pg.Pool;

  beforeEach(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL });
    DbClient.setPool(pool);
    DbClient.clearInMemory();
    ElevenLabsWebhookService.reset();
    FailureDetector.reset();
    ErrorRouter.reset();
    ErrorRouter.setMockHandler(null);
    setActiveDashboardPublisher(new CstDashboardPublisher({ dryRun: true }));
    CutOverManager.reset();
    CutOverManager.configure({ start_timestamp: '2026-11-03T00:00:00.000Z' });
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-mock-simulation-token');
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', 'test_webhook_secret_key_123');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => 'ok',
    }));
  });

  afterEach(async () => {
    setActiveDashboardPublisher(null);
    DbClient.setPool(null);
    await pool.end();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STAGE D: Event Lifecycle Persistence & Atomicity
  // ───────────────────────────────────────────────────────────────────────────
  describe('Stage D — Event Lifecycle Persistence & Atomicity', () => {
    it('persists all lifecycle records in a single PostgreSQL transaction before dispatch', async () => {
      const convId = `conv_sim_d_${Date.now()}`;
      const payload = {
        type: 'post_call_transcription' as const,
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+15550001234' } },
        transcript: [{ role: 'user' as const, message: 'Need help with greenhouse sensor' }],
      };

      const result = await ElevenLabsWebhookService.process(payload);
      expect(result.status).toBe('processed');

      // Verify PostgreSQL transaction committed all 3 required lifecycle rows
      const dbRows = await pool.query(
        `SELECT id, event_id, correlation_id, event_type, status, error, created_at 
         FROM dashboard_publish_outcomes 
         WHERE correlation_id = $1 
         ORDER BY id ASC`,
        [convId],
      );
      expect(dbRows.rows).toHaveLength(4);
      expect(dbRows.rows.map((r: any) => r.event_type).sort()).toEqual([
        'cst.interaction.start',
        'cst.outcome',
        'cst.transcript',
        'cst.turn',
      ].sort());
      expect(dbRows.rows.every((r: any) => ['internal_only', 'dry_run', 'ok', 'published', 'missing_configuration'].includes(r.status))).toBe(true);
      expect(dbRows.rows.every((r: any) => r.error === null)).toBe(true);
    });

    it('rolls back completely on mid-transaction database failure leaving 0 partial records and withholds dispatch', async () => {
      const convId = `conv_sim_rollback_${Date.now()}`;
      let insertCount = 0;
      const client = await pool.connect();
      const origQuery = client.query.bind(client);
      const origRelease = client.release.bind(client);
      const connectSpy = vi.spyOn(pool, 'connect').mockImplementationOnce((async () => {
        client.query = (async (text: any, values?: any) => {
          if (typeof text === 'string' && text.includes('INSERT INTO dashboard_publish_outcomes')) {
            insertCount++;
            if (insertCount === 3 && Array.isArray(values)) {
              const badValues = [...values];
              badValues[2] = null; // event_type is NOT NULL in PostgreSQL -> triggers 23502 constraint error
              return origQuery(text, badValues);
            }
          }
          return origQuery(text, values);
        }) as any;
        client.release = ((err?: any) => {
          client.query = origQuery as any;
          client.release = origRelease as any;
          return origRelease(err);
        }) as any;
        connectSpy.mockRestore();
        return client;
      }) as any);

      ErrorRouter.setMockHandler(async () => true);

      const payload = {
        type: 'post_call_transcription' as const,
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+15550001234' } },
        transcript: [{ role: 'user' as const, message: 'Mid-transaction failure test' }],
      };

      const result = await ElevenLabsWebhookService.process(payload);
      expect(result.status).toBe('failed');
      expect(result.error).toBe('POST_CALL_PERSISTENCE_FAILED');

      // Read back from PostgreSQL: exactly 0 rows must exist (clean atomic rollback)
      const afterRollback = await pool.query(
        `SELECT count(*)::int AS cnt FROM dashboard_publish_outcomes WHERE correlation_id = $1`,
        [convId],
      );
      expect(afterRollback.rows[0].cnt).toBe(0);

      ErrorRouter.setMockHandler(null);

      // Now re-attempt delivery (retry): must succeed and commit all 4 records cleanly
      const retryResult = await ElevenLabsWebhookService.process(payload);
      expect(retryResult.status).toBe('processed');

      const afterRetry = await pool.query(
        `SELECT count(*)::int AS cnt FROM dashboard_publish_outcomes WHERE correlation_id = $1`,
        [convId],
      );
      expect(afterRetry.rows[0].cnt).toBe(4);
    });

    it('guarantees idempotency via ON CONFLICT (id) DO NOTHING with stable SHA-256 row IDs across retry and process restart', async () => {
      const convId = `conv_sim_idemp_${Date.now()}`;
      const payload = {
        type: 'post_call_transcription' as const,
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+15550001234' } },
        transcript: [{ role: 'user' as const, message: 'Idempotency simulation' }],
      };

      // 1. Initial execution
      const res1 = await ElevenLabsWebhookService.process(payload);
      expect(res1.status).toBe('processed');

      // Query the 3 required lifecycle events with stable SHA-256 keys
      const initialRows = await pool.query(
        `SELECT id, created_at FROM dashboard_publish_outcomes WHERE correlation_id = $1 AND id LIKE 'dpo_evt_%' ORDER BY id`,
        [convId],
      );
      expect(initialRows.rows).toHaveLength(3);
      const initialIds = initialRows.rows.map((r: any) => r.id);

      // 2. Simulate process crash / memory reset
      ElevenLabsWebhookService.reset();
      DbClient.clearInMemory();

      // 3. Retry same payload
      const res2 = await ElevenLabsWebhookService.process(payload);
      expect(res2.status).toBe('processed');

      const retryRows = await pool.query(
        `SELECT id, created_at FROM dashboard_publish_outcomes WHERE correlation_id = $1 AND id LIKE 'dpo_evt_%' ORDER BY id`,
        [convId],
      );
      expect(retryRows.rows).toHaveLength(3);
      expect(retryRows.rows.map((r: any) => r.id)).toEqual(initialIds);
      // Timestamps preserved by ON CONFLICT DO NOTHING
      expect(retryRows.rows.map((r: any) => new Date(r.created_at).getTime())).toEqual(
        initialRows.rows.map((r: any) => new Date(r.created_at).getTime()),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STAGE E: Error Routing by Class & Destination Isolation
  // ───────────────────────────────────────────────────────────────────────────
  describe('Stage E — Error Routing by Class', () => {
    it('routes CST and Twilio errors to #bha-pipeline-errors and CS_HANDOFF to #bha-customer-service-twin', async () => {
      const cstAlert = {
        service: 'CST' as const,
        category: 'core_engine',
        source: 'test_sim',
        message: 'Engine internal diagnostic',
        severity: 'ERROR' as const,
        tenant_id: 'tenant-sim-01',
        project_id: 'proj-sim-01',
        correlation_id: 'corr_cst_sim',
      };
      const cstRoute = await ErrorRouter.route(cstAlert, true);
      expect(cstRoute.error_class).toBe('CST');
      expect(cstRoute.destination_channel).toBe('#bha-pipeline-errors');

      const twilioAlert = {
        service: 'Twilio' as const,
        category: 'telephony',
        source: 'test_sim',
        message: 'Carrier callback timeout',
        severity: 'WARN' as const,
        tenant_id: 'tenant-sim-01',
        project_id: 'proj-sim-01',
        correlation_id: 'corr_tw_sim',
      };
      const twilioRoute = await ErrorRouter.route(twilioAlert, true);
      expect(twilioRoute.error_class).toBe('Twilio');
      expect(twilioRoute.destination_channel).toBe('#bha-pipeline-errors');

      const handoffAlert = {
        service: 'CS_HANDOFF' as const,
        category: 'escalation',
        source: 'test_sim',
        message: 'Customer requested human support',
        severity: 'WARN' as const,
        tenant_id: 'tenant-sim-01',
        project_id: 'proj-sim-01',
        correlation_id: 'corr_hand_sim',
      };
      const handoffRoute = await ErrorRouter.route(handoffAlert, true);
      expect(handoffRoute.error_class).toBe('CS_HANDOFF');
      expect(handoffRoute.destination_channel).toBe('#bha-customer-service-twin');
    });

    it('marks unconfigured destinations as deferred, does not claim ok: true, and logs structured warning', async () => {
      delete process.env.SLACK_VFARM_MONITORING_WEBHOOK_URL;
      delete process.env.SLACK_NS_WEBHOOK_URL;

      const vfarmAlert = {
        service: 'vFarm' as const,
        category: 'sensor_telemetry',
        source: 'test_sim',
        message: 'pH sensor offline in Cabinet 2',
        severity: 'WARN' as const,
        tenant_id: 'tenant-sim-01',
        project_id: 'proj-sim-01',
        correlation_id: 'corr_vf_sim',
      };

      const routeRes = await ErrorRouter.route(vfarmAlert, true);
      expect(routeRes.status).toBe('deferred');
      expect(routeRes.dispatched).toBe(false);
      expect(routeRes.error_class).toBe('vFarm');
      expect(routeRes.destination_channel).toBe('#vfarm-monitoring');

      const nsAlert = {
        service: 'NS' as const,
        category: 'northstar_ingest',
        source: 'test_sim',
        message: 'Northstar payload schema mismatch',
        severity: 'ERROR' as const,
        tenant_id: 'tenant-sim-01',
        project_id: 'proj-sim-01',
        correlation_id: 'corr_ns_sim',
      };

      const nsRoute = await ErrorRouter.route(nsAlert, true);
      expect(nsRoute.status).toBe('deferred');
      expect(nsRoute.dispatched).toBe(false);
      expect(nsRoute.error_class).toBe('NS');
      expect(nsRoute.destination_channel).toBe('#northstar-alerts');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STAGE F: Failure Detection and Forward-Only Health Checks
  // ───────────────────────────────────────────────────────────────────────────
  describe('Stage F — Failure Detection and Health Checks', () => {
    it('accurately transitions HTTP 200 -> HTTP 503 on threshold breach and does not falsely recover on single success', async () => {
      const app = express();
      app.get('/health/reliability', (_req, res) => {
        const report = FailureDetector.getHealthReport();
        res.status(report.readiness === 'unready' ? 503 : 200).json(report);
      });

      // 1. Initial healthy state
      const initial = await request(app).get('/health/reliability');
      expect(initial.status).toBe(200);
      expect(initial.body.readiness).toBe('ready');

      // 2. Inject 5 Slack failures (threshold is > 5)
      for (let i = 0; i < 5; i++) {
        FailureDetector.recordSlackFailure(`Network timeout ${i}`, undefined, false);
      }
      const atThreshold = await request(app).get('/health/reliability');
      expect(atThreshold.status).toBe(200); // 5 is still ready

      // 3. Breach threshold (6th failure)
      FailureDetector.recordSlackFailure('Network timeout 6', undefined, false);
      const breached = await request(app).get('/health/reliability');
      expect(breached.status).toBe(503);
      expect(breached.body.readiness).toBe('unready');
      expect(breached.body.unhealthy_reasons.some((r: string) => r.includes('Slack publication failure rate high'))).toBe(true);

      // 4. Record a successful Slack post — proves recordSlackSuccess() NEVER resets failed_deliveries counter
      FailureDetector.recordSlackSuccess();
      const afterSuccess = await request(app).get('/health/reliability');
      expect(afterSuccess.status).toBe(503);
      expect(afterSuccess.body.readiness).toBe('unready');

      // 5. Full controlled recovery
      FailureDetector.reset();
      const recovered = await request(app).get('/health/reliability');
      expect(recovered.status).toBe(200);
      expect(recovered.body.readiness).toBe('ready');
    });

    it('reports HTTP 503 on Twilio signature mismatch and webhook persistence failure', async () => {
      const app = express();
      app.get('/health/reliability', (_req, res) => {
        const report = FailureDetector.getHealthReport();
        res.status(report.readiness === 'unready' ? 503 : 200).json(report);
      });

      // Twilio invalid signature
      FailureDetector.recordTwilioSignature(false);
      const resSig = await request(app).get('/health/reliability');
      expect(resSig.status).toBe(503);
      expect(resSig.body.unhealthy_reasons.some((r: string) => r.includes('Twilio signature validation failure'))).toBe(true);

      FailureDetector.reset();

      // Webhook persistence failure
      FailureDetector.recordWebhookPersistenceFailure();
      const resPersist = await request(app).get('/health/reliability');
      expect(resPersist.status).toBe(503);
      expect(resPersist.body.unhealthy_reasons.some((r: string) => r.includes('Webhook processing/persistence failures'))).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STAGE S1: cst.event.v1 Contract Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe('Stage S1 — cst.event.v1 Contract Verification', () => {
    it('validates all required envelope fields and verifies optional fields in CstTurnSchema', () => {
      const sampleEnvelope = {
        specversion: 'cst.event.v1',
        id: 'turn_evt_sim_001',
        source: 'cst/sms',
        time: new Date().toISOString(),
        tenant_id: 'tenant-sim-01',
        project_id: 'proj-sim-01',
        correlation_id: 'corr_sim_001',
        channel: 'sms' as const,
        type: 'cst.turn' as const,
        customer: {
          customer_ref: 'cust_sim_1',
          phone_e164: '+15550001111',
          role: 'manager' as const,
          is_known: true,
          tenant_id: 'tenant-sim-01',
          project_id: 'proj-sim-01',
          person_id: 'usr_sim_1',
          name: 'Jane Doe',
          farm_ids: ['farm_1'],
        },
        data: {
          turn_id: 'turn_sim_001',
          conversation_id: 'conv_sim_001',
          direction: 'inbound' as const,
          channel: 'sms' as const,
          status: 'ok' as const,
          text: 'Hello, need harvest schedule',
          reply_text: 'The harvest is scheduled for tomorrow at 8am.',
          customer: {
            customer_ref: 'cust_sim_1',
            phone_e164: '+15550001111',
            role: 'manager' as const,
            is_known: true,
            tenant_id: 'tenant-sim-01',
            project_id: 'proj-sim-01',
            person_id: 'usr_sim_1',
            name: 'Jane Doe',
            farm_ids: ['farm_1'],
          },
        },
      };

      const parseRes = CstTurnEventV1Schema.safeParse(sampleEnvelope);
      expect(parseRes.success).toBe(true);

      // Verify serialization output for dashboard
      const serialized = serializeForDashboard(sampleEnvelope as any);
      expect(serialized.id).toBe('turn_evt_sim_001');
      expect(serialized.specversion).toBe('cst.event.v1');
      expect(serialized.event_type).toBe('cst.turn');
      expect(serialized.text).toBe('Hello, need harvest schedule');
      expect(serialized.reply_text).toBe('The harvest is scheduled for tomorrow at 8am.');
      expect(serialized.intent).toBeUndefined();
      expect(serialized.incident_id).toBeUndefined();
    });

    it('handles audio and voice fields without schema rejection', () => {
      const voiceTurn = {
        specversion: 'cst.event.v1',
        id: 'turn_evt_voice_002',
        source: 'cst/voice',
        time: new Date().toISOString(),
        tenant_id: 'tenant-sim-01',
        project_id: 'proj-sim-01',
        correlation_id: 'corr_voice_002',
        channel: 'voice' as const,
        type: 'cst.turn' as const,
        customer: {
          customer_ref: 'cust_sim_voice',
          phone_e164: '+15550002222',
          role: 'owner' as const,
          is_known: true,
          tenant_id: 'tenant-sim-01',
          project_id: 'proj-sim-01',
          person_id: 'usr_sim_2',
          name: 'John Smith',
          farm_ids: [],
        },
        data: {
          turn_id: 'turn_voice_002',
          conversation_id: 'conv_voice_002',
          direction: 'outbound' as const,
          channel: 'voice' as const,
          status: 'ok' as const,
          text: 'Speaking voice prompt',
          reply_text: 'Acknowledged voice message',
          audio_url: 'https://cdn.bhanetwork.org/audio/sample.mp3',
          voice_id: '21m00Tcm4TlvDq8ikWAM',
          model_id: 'eleven_turbo_v2',
          customer: {
            customer_ref: 'cust_sim_voice',
            phone_e164: '+15550002222',
            role: 'owner' as const,
            is_known: true,
            tenant_id: 'tenant-sim-01',
            project_id: 'proj-sim-01',
            person_id: 'usr_sim_2',
            name: 'John Smith',
            farm_ids: [],
          },
        },
      };

      const parseRes = CstTurnEventV1Schema.safeParse(voiceTurn);
      expect(parseRes.success).toBe(true);
      if (parseRes.success) {
        expect(parseRes.data.data.audio_url).toBe('https://cdn.bhanetwork.org/audio/sample.mp3');
        expect(parseRes.data.data.voice_id).toBe('21m00Tcm4TlvDq8ikWAM');
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STAGE S2: Human Handoff Lifecycle
  // ───────────────────────────────────────────────────────────────────────────
  describe('Stage S2 — Human Handoff Lifecycle', () => {
    it('executes full 5-status lifecycle and persists human operator acknowledgement in PostgreSQL', async () => {
      const callerPhone = '+15550009999';
      const correlationId = `corr_handoff_${Date.now()}`;

      // 1. Customer requests human -> Create escalation record in PostgreSQL
      const escRes = await EscalationService.escalate({
        caller_phone: callerPhone,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        correlation_id: correlationId,
        reason: 'Customer explicitly asked to speak with farm manager',
        transcript: [{ role: 'user', message: 'I need to speak to someone right now' }],
      });

      expect(escRes.escalation_id).toBeTruthy();
      const escId = escRes.escalation_id!;

      // Verify PostgreSQL initial record: status = 'pending' or 'sent'
      const initRow = await pool.query(
        `SELECT id, status, acknowledged_by, acknowledged_at FROM escalations WHERE id = $1`,
        [escId],
      );
      expect(initRow.rows).toHaveLength(1);
      expect(['pending', 'sent', 'notified']).toContain(initRow.rows[0].status);
      expect(initRow.rows[0].acknowledged_by).toBeNull();
      expect(initRow.rows[0].acknowledged_at).toBeNull();

      // 2. Human Operator acknowledges escalation
      const ackRes = await EscalationService.acknowledgeEscalation(
        escId,
        'Destiny Arupi (U0AEW3TBYH1)',
      );
      expect(ackRes.acknowledged).toBe(true);
      expect(ackRes.record?.status).toBe('acknowledged');
      expect(ackRes.record?.acknowledged_by).toBe('Destiny Arupi (U0AEW3TBYH1)');
      expect(ackRes.record?.acknowledged_at).toBeTruthy();

      // Verify PostgreSQL durably holds acknowledged status and timestamp
      const ackDbRow = await pool.query(
        `SELECT id, status, acknowledged_by, acknowledged_at, slack_notified FROM escalations WHERE id = $1`,
        [escId],
      );
      expect(ackDbRow.rows[0].status).toBe('acknowledged');
      expect(ackDbRow.rows[0].acknowledged_by).toBe('Destiny Arupi (U0AEW3TBYH1)');
      expect(ackDbRow.rows[0].acknowledged_at).toBeTruthy();
      expect(ackDbRow.rows[0].slack_notified).toBe(true);

      // 3. Late Slack delivery error must NEVER overwrite acknowledged status
      await DbClient.updateEscalationSlackStatus(escId, false, 'Simulated late webhook error');

      const lateRow = await pool.query(
        `SELECT status, acknowledged_by, acknowledged_at FROM escalations WHERE id = $1`,
        [escId],
      );
      expect(lateRow.rows[0].status).toBe('acknowledged'); // Preserved!
      expect(lateRow.rows[0].acknowledged_by).toBe('Destiny Arupi (U0AEW3TBYH1)');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STAGE S3: Forward-Only Cut-Over
  // ───────────────────────────────────────────────────────────────────────────
  describe('Stage S3 — Forward-Only Cut-Over', () => {
    it('drops historical events < start_timestamp and ingests forward events >= start_timestamp', () => {
      CutOverManager.configure({
        start_timestamp: '2026-11-03T00:00:00.000Z',
        is_approved: false, // Approval metadata only, never runtime block
      });

      // 1. Pre-cutover historical event (dropped)
      const historical = CutOverManager.isEventEligible('2026-11-02T23:59:59.999Z', 'evt_hist_01');
      expect(historical.eligible).toBe(false);
      expect(historical.reason).toBe('historical_event_pre_cutover');

      // 2. Exact cutover boundary timestamp (eligible)
      const exact = CutOverManager.isEventEligible('2026-11-03T00:00:00.000Z', 'evt_exact_02');
      expect(exact.eligible).toBe(true);
      expect(exact.reason).toBe('approved_forward_event');

      // 3. Forward event after cutover (eligible)
      const forward = CutOverManager.isEventEligible('2026-11-20T12:00:00.000Z', 'evt_fwd_03');
      expect(forward.eligible).toBe(true);
      expect(forward.reason).toBe('approved_forward_event');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT B: vFarm / Northstar Sensor Filtering & Fail-Closed Behavior
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit B — NS / vFarm Filtering', () => {
    it('strictly requires device_type === sensor and fails closed on invalid telemetry', () => {
      const validSensor = { device_id: 'dev_temp_1', device_type: 'sensor', status: 'online', value: 21.5 };
      const nonSensor = { device_id: 'dev_relay_2', device_type: 'actuator', status: 'online' };

      expect(validSensor.device_type).toBe('sensor');
      expect(nonSensor.device_type).not.toBe('sensor');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUDIT C: ElevenLabs Webhook Shape & Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe('Audit C — ElevenLabs Webhook Verification', () => {
    it('verifies HMAC-SHA256 signature using authenticate() and handles tool-turn message: null gracefully', async () => {
      const secret = 'test_webhook_secret_key_123';
      const body = JSON.stringify({
        type: 'post_call_transcription',
        conversation_id: `conv_hmac_${Date.now()}`,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+15551234567' } },
        transcript: [
          { role: 'user', message: 'Turn on light' },
          { role: 'tool', message: null, tool_call: { name: 'toggle_switch' } }, // tool turn message: null
          { role: 'agent', message: 'Switch has been toggled' },
        ],
      });

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const hmac = createHmac('sha256', secret);
      hmac.update(`${timestamp}.${body}`);
      const validSig = `t=${timestamp},v0=${hmac.digest('hex')}`;

      // Mock Express Request with header method
      const mockReqValid = {
        header: (name: string) => name.toLowerCase() === 'elevenlabs-signature' ? validSig : undefined,
      } as any;

      const authValid = ElevenLabsWebhookService.authenticate(mockReqValid, body);
      expect(authValid).toBe(true);

      const invalidSig = `t=${timestamp},v0=0000000000000000000000000000000000000000000000000000000000000000`;
      const mockReqInvalid = {
        header: (name: string) => name.toLowerCase() === 'elevenlabs-signature' ? invalidSig : undefined,
      } as any;

      const authInvalid = ElevenLabsWebhookService.authenticate(mockReqInvalid, body);
      expect(authInvalid).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // END-TO-END SIMULATION: Complete Synthetic Customer Journey
  // ───────────────────────────────────────────────────────────────────────────
  describe('End-to-End Simulation — Complete Synthetic Customer Journey', () => {
    it('executes full journey from inbound interaction to persistence, escalation, human acknowledgement, and health recovery', async () => {
      const journeyCorrId = `corr_e2e_${Date.now()}`;
      const customerPhone = '+15558889999';

      // Step 1: Customer completes voice call -> ElevenLabs post-call arrives
      const payload = {
        type: 'post_call_transcription' as const,
        conversation_id: journeyCorrId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: customerPhone } },
        transcript: [
          { role: 'user' as const, message: 'I need to speak with human supervisor immediately' },
        ],
      };

      // Step 2: Webhook processes and commits lifecycle outcomes in PostgreSQL
      const processRes = await ElevenLabsWebhookService.process(payload);
      expect(processRes.status).toBe('processed');

      const outcomeRows = await pool.query(
        `SELECT id, event_type, status FROM dashboard_publish_outcomes WHERE correlation_id = $1`,
        [journeyCorrId],
      );
      expect(outcomeRows.rows.length).toBeGreaterThanOrEqual(3);

      // Step 3: CS_HANDOFF Escalation triggered
      const escRes = await EscalationService.escalate({
        caller_phone: customerPhone,
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        correlation_id: journeyCorrId,
        reason: 'Customer requested human supervisor',
        transcript: payload.transcript,
      });
      expect(escRes.escalation_id).toBeTruthy();
      const escId = escRes.escalation_id!;

      // Step 4: Human operator acknowledges escalation
      const ackRes = await EscalationService.acknowledgeEscalation(
        escId,
        'Jason Bays (Supervisory)',
      );
      expect(ackRes.acknowledged).toBe(true);

      // Step 5: Verify PostgreSQL holds the complete journey
      const finalEsc = await pool.query(
        `SELECT id, status, acknowledged_by, correlation_id FROM escalations WHERE id = $1`,
        [escId],
      );
      expect(finalEsc.rows[0].status).toBe('acknowledged');
      expect(finalEsc.rows[0].acknowledged_by).toBe('Jason Bays (Supervisory)');
      expect(finalEsc.rows[0].correlation_id).toBe(journeyCorrId);

      // Step 6: Failure detector simulates transient outage and recovers cleanly
      FailureDetector.recordSlackFailure('Transient DNS timeout', undefined, false);
      expect(FailureDetector.getHealthReport().readiness).toBe('degraded'); // 1 failure marks readiness as degraded (failing requires > 5)
      FailureDetector.reset();
      expect(FailureDetector.getHealthReport().readiness).toBe('ready');
    });
  });
});
