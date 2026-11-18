import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../../engine/src/app.js';
import { ElevenLabsWebhookService } from '../../engine/src/interfaces/elevenlabs/service.js';
import { resolveCallStartTimestamp, isValidUnixSeconds } from '../../engine/src/interfaces/elevenlabs/timestamp.js';
import { CallLogPoster } from '../../engine/src/notifications/call_log.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CstDashboardPublisher, setActiveDashboardPublisher } from '../../engine/src/publishers/dashboard.js';
import { CstEventV1 } from '../../engine/src/contracts/events.js';

describe('PBT5 Task 2 Timestamp Semantics & Persistence Regressions', () => {
  const testSecret = 'wsec_pbt5_test_secret_abc123';
  let app: ReturnType<typeof createApp>;
  let callLogMock: ReturnType<typeof vi.fn>;

  const sign = (body: any, timestamp = Math.floor(Date.now() / 1000)) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const hmac = createHmac('sha256', testSecret.slice(5)).update(`${timestamp}.${raw}`).digest('hex');
    return `t=${timestamp},v0=${hmac}`;
  };

  beforeEach(() => {
    app = createApp();
    vi.stubEnv('ELEVENLABS_WEBHOOK_SECRET', testSecret);
    vi.stubEnv('CST_CUTOVER_APPROVED', 'true');
    vi.stubEnv('CST_RELAY_TRACE', 'true');
    ElevenLabsWebhookService.reset();
    callLogMock = vi.fn().mockResolvedValue({ posted: true, via: 'bot', ts: '1793821609.120139', transcript: 'file' });
    CallLogPoster.mockHandler = callLogMock;
    setActiveDashboardPublisher(new CstDashboardPublisher({ dryRun: true }));
  });

  afterEach(() => {
    DbClient.setPool(null);
    setActiveDashboardPublisher(null);
    ErrorRouter.reset();
    CallLogPoster.mockHandler = null;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // Task 2: Timestamp Semantics Unit Tests
  // =========================================================================
  describe('Task 2: Timestamp Semantics Unit Tests', () => {
    it('1. Valid provider call-start timestamp', () => {
      const fixedStartSecs = 1793817277; // 2026-11-04T18:34:37.000Z
      const res = resolveCallStartTimestamp({
        start_time_unix_secs: fixedStartSecs,
        event_timestamp: fixedStartSecs + 78,
      });

      expect(res.unix_secs).toBe(1793817277);
      expect(res.iso).toBe('2026-11-04T18:34:37.000Z');
      expect(res.source).toBe('provider_call_start');
      expect(res.is_fallback).toBe(false);
      expect(res.start_time_unavailable).toBe(false);
      expect(res.raw_provider_start_time).toBe(fixedStartSecs);
      expect(res.raw_provider_event_timestamp).toBe(fixedStartSecs + 78);
    });

    it('2. Missing call-start timestamp uses documented receipt fallback with explicit flag', () => {
      const fixedReceipt = new Date('2026-11-04T19:00:00.000Z');
      const res = resolveCallStartTimestamp(
        { start_time_unix_secs: undefined, event_timestamp: undefined },
        fixedReceipt
      );

      expect(res.unix_secs).toBe(Math.floor(fixedReceipt.getTime() / 1000));
      expect(res.iso).toBe('2026-11-04T19:00:00.000Z');
      expect(res.source).toBe('fallback_receipt_time');
      expect(res.is_fallback).toBe(true);
      expect(res.start_time_unavailable).toBe(true);
      expect(res.raw_provider_start_time).toBeUndefined();
    });

    it('3. Provider event timestamp present but call-start timestamp absent', () => {
      const eventSecs = 1793817355; // 2026-11-04T18:35:55.000Z
      const res = resolveCallStartTimestamp({
        start_time_unix_secs: undefined,
        event_timestamp: eventSecs,
      });

      expect(res.unix_secs).toBe(eventSecs);
      expect(res.iso).toBe('2026-11-04T18:35:55.000Z');
      expect(res.source).toBe('fallback_provider_event');
      expect(res.is_fallback).toBe(true);
      expect(res.start_time_unavailable).toBe(true);
      expect(res.raw_provider_start_time).toBeUndefined();
      expect(res.raw_provider_event_timestamp).toBe(eventSecs);
    });

    it('4. Invalid timestamp values (NaN, negative, zero, non-number string, out-of-bounds)', () => {
      expect(isValidUnixSeconds(NaN)).toBe(false);
      expect(isValidUnixSeconds(-100)).toBe(false);
      expect(isValidUnixSeconds(0)).toBe(false);
      expect(isValidUnixSeconds('1793817277')).toBe(false);
      expect(isValidUnixSeconds(null)).toBe(false);
      expect(isValidUnixSeconds(100)).toBe(false); // below MIN_VALID_EPOCH_SECS (year 2000)

      // Test resolver with invalid start time falling back to event_timestamp
      const eventSecs = 1793817355;
      const resWithBadStart = resolveCallStartTimestamp({
        start_time_unix_secs: -999,
        event_timestamp: eventSecs,
      });
      expect(resWithBadStart.source).toBe('fallback_provider_event');
      expect(resWithBadStart.is_fallback).toBe(true);
      expect(resWithBadStart.start_time_unavailable).toBe(true);
    });

    it('5. Timestamp conversion to ISO 8601 UTC preserves exact UTC representation with Z suffix', () => {
      const epochSecs = 1793817277;
      const res = resolveCallStartTimestamp({ start_time_unix_secs: epochSecs });
      expect(res.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(res.iso).toBe('2026-11-04T18:34:37.000Z');
    });

    it('6. Consistency between original provider payload, cst.interaction.start, and persisted record', async () => {
      const fixedStartSecs = 1793817277;
      const payload = {
        type: 'post_call_transcription',
        conversation_id: 'conv_pbt5_consistency_001',
        agent_id: 'agent_vfarm_cs_v1',
        start_time_unix_secs: fixedStartSecs,
        event_timestamp: fixedStartSecs + 78,
        call_duration_secs: 78,
        transcript: [
          { role: 'user', message: 'Hello', time_in_call_secs: 6 },
          { role: 'agent', message: 'Hi there', time_in_call_secs: 9 },
        ],
        metadata: {
          caller_id: '+923082113844',
          custom_variables: {
            tenant_id: 'tenant-vfarm-01',
            project_id: 'proj-vfarm-main',
            caller_phone: '+923082113844',
          },
        },
      };

      const res = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.turn_event_id).toBeDefined();

      const persisted = ElevenLabsWebhookService.getPersistedEvents();
      const startEvt = persisted.find((e) => e.type === 'cst.interaction.start') as any;
      expect(startEvt).toBeDefined();
      expect(startEvt.time).toBe('2026-11-04T18:34:37.000Z');
      expect(startEvt.data.started_at).toBe('2026-11-04T18:34:37.000Z');
      expect(startEvt.data.metadata.start_time_source).toBe('provider_call_start');
      expect(startEvt.data.metadata.start_time_is_fallback).toBe(false);
      expect(startEvt.data.metadata.start_time_unavailable).toBe(false);
      expect(startEvt.data.metadata.provider_start_time_unix_secs).toBe(fixedStartSecs);
      expect(startEvt.data.metadata.provider_event_timestamp).toBe(fixedStartSecs + 78);

      // Verify transcript message timestamps use relative time offset from call start
      const trscEvt = persisted.find((e) => e.type === 'cst.transcript') as any;
      expect(trscEvt).toBeDefined();
      expect(trscEvt.data.messages[0].timestamp).toBe('2026-11-04T18:34:43.000Z'); // 1793817277 + 6
      expect(trscEvt.data.messages[1].timestamp).toBe('2026-11-04T18:34:46.000Z'); // 1793817277 + 9
    });
  });

  // =========================================================================
  // Section 5: Persistence & Reliability Regression Tests
  // =========================================================================
  describe('Section 5: Persistence & Reliability Regressions', () => {
    it('Processes complete call with separate interaction.start, transcript, and outcome records', async () => {
      const payload = {
        type: 'post_call_transcription',
        conversation_id: 'conv_complete_call_101',
        agent_id: 'agent_vfarm_cs_v1',
        start_time_unix_secs: 1793817277,
        call_duration_secs: 50,
        transcript: [
          { role: 'user', message: 'I need help with my rack', time_in_call_secs: 2 },
          { role: 'agent', message: 'I can help with that', time_in_call_secs: 5 },
        ],
        metadata: {
          caller_id: '+15184787950',
          phone_call: { call_sid: 'CA_test_complete_101' },
          custom_variables: {
            tenant_id: 'tenant-vfarm-01',
            project_id: 'proj-vfarm-main',
            caller_phone: '+15184787950',
          },
        },
      };

      const res = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.events_count).toBe(3);
      expect(res.body.turn_event_id).toBeDefined();
      expect(res.body.turn_event_id).toMatch(/^turn_evt_/);

      const events = ElevenLabsWebhookService.getPersistedEvents();
      const types = events.map((e) => e.type);
      expect(types).toContain('cst.interaction.start');
      expect(types).toContain('cst.transcript');
      expect(types).toContain('cst.outcome');
    });

    it('Processes empty transcript safely without crashing or dropping start/outcome events', async () => {
      const payload = {
        type: 'post_call_transcription',
        conversation_id: 'conv_empty_trsc_102',
        agent_id: 'agent_vfarm_cs_v1',
        start_time_unix_secs: 1793817277,
        call_duration_secs: 11,
        transcript: [],
        metadata: {
          caller_id: '+923082113844',
          custom_variables: {
            tenant_id: 'tenant-vfarm-01',
            project_id: 'proj-vfarm-main',
            caller_phone: '+923082113844',
          },
        },
      };

      const res = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      const events = ElevenLabsWebhookService.getPersistedEvents();
      const trsc = events.find((e) => e.type === 'cst.transcript') as any;
      expect(trsc).toBeDefined();
      expect(trsc.data.messages).toEqual([]);
    });

    it('Duplicate webhook deliveries are idempotent and do not create duplicate events', async () => {
      const payload = {
        type: 'post_call_transcription',
        conversation_id: 'conv_duplicate_103',
        agent_id: 'agent_vfarm_cs_v1',
        start_time_unix_secs: 1793817277,
        call_duration_secs: 20,
        transcript: [{ role: 'agent', message: 'Hello', time_in_call_secs: 1 }],
        metadata: {
          caller_id: '+923082113844',
          custom_variables: { caller_phone: '+923082113844' },
        },
      };

      const first = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      expect(first.status).toBe(200);
      expect(first.body.status).toBe('processed');
      const countAfterFirst = ElevenLabsWebhookService.getPersistedEvents().length;

      // Duplicate delivery
      const second = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      expect(second.status).toBe(200);
      expect(second.body.status).toBe('already_processed');
      expect(second.body.events_count).toBe(0);
      expect(ElevenLabsWebhookService.getPersistedEvents().length).toBe(countAfterFirst);
    });

    it('Handles database failure gracefully without breaking customer response', async () => {
      const mockPool = {
        query: vi.fn().mockRejectedValue(new Error('connection timeout to postgres')),
      };
      DbClient.setPool(mockPool as any);

      const payload = {
        type: 'post_call_transcription',
        conversation_id: 'conv_db_fail_104',
        agent_id: 'agent_vfarm_cs_v1',
        start_time_unix_secs: 1793817277,
        call_duration_secs: 15,
        transcript: [{ role: 'user', message: 'Hi', time_in_call_secs: 2 }],
        metadata: {
          caller_id: '+923082113844',
          custom_variables: { caller_phone: '+923082113844' },
        },
      };

      const res = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      // Webhook should process with status 200, logging DB failure via FailureDetector
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(ElevenLabsWebhookService.getPersistedEvents().length).toBe(3);
    });

    it('Rejects request with missing or invalid caller identity (anti-fabrication)', async () => {
      const payload = {
        type: 'post_call_transcription',
        conversation_id: 'conv_no_caller_105',
        agent_id: 'agent_vfarm_cs_v1',
        start_time_unix_secs: 1793817277,
        call_duration_secs: 10,
        transcript: [{ role: 'agent', message: 'Hello', time_in_call_secs: 1 }],
        metadata: {}, // no caller_id, no caller_phone, no phone_call
      };

      const res = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('PROCESSING_FAILED');
      expect(res.body.message).toBe('CALLER_IDENTITY_MISSING');
    });

    it('Correctly isolates and attributes tenant and project from custom variables', async () => {
      const payload = {
        type: 'post_call_transcription',
        conversation_id: 'conv_tenant_iso_106',
        agent_id: 'agent_vfarm_cs_v1',
        start_time_unix_secs: 1793817277,
        call_duration_secs: 15,
        transcript: [{ role: 'agent', message: 'Hello', time_in_call_secs: 1 }],
        metadata: {
          caller_id: '+923082113844',
          custom_variables: {
            tenant_id: 'tenant-custom-farm-99',
            project_id: 'proj-custom-rack-02',
            caller_phone: '+923082113844',
          },
        },
      };

      const res = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('elevenlabs-signature', sign(payload))
        .send(payload);

      expect(res.status).toBe(200);
      const events = ElevenLabsWebhookService.getPersistedEvents();
      for (const evt of events) {
        expect(evt.tenant_id).toBe('tenant-custom-farm-99');
        expect(evt.project_id).toBe('proj-custom-rack-02');
      }
    });
  });
});
