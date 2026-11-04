import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createApp } from '../../engine/src/app.js';
import {
  VoiceEventCaptureService,
  SUPPORTED_TWILIO_CALL_STATUSES,
  type CustomerServiceSlackNotification,
} from '../../engine/src/observability/voice_events.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('Voice Observability & Event Capture (PBT5 / LOOP-1793729831162-PBT5)', () => {
  const app = createApp();
  const testSecret = 'test_voice_observability_secret_98765';

  function computeElevenLabsSignature(payload: unknown, secret = testSecret): string {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return createHmac('sha256', secret).update(raw).digest('hex');
  }

  beforeEach(() => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = testSecret;
    process.env.CST_API_KEY = testSecret;
    VoiceEventCaptureService.reset();
    FailureDetector.reset();
    DbClient.clearInMemory();
  });

  afterEach(() => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    delete process.env.CST_API_KEY;
  });

  // ==========================================================================
  // 1. Inbound Call Event Capture
  // ==========================================================================
  describe('1. Inbound Call Event Capture', () => {
    it('1.1 Processes a valid inbound call event, normalizes to cst.interaction.start, persists, and publishes to Slack', async () => {
      let dispatchedNotification: CustomerServiceSlackNotification | null = null;
      VoiceEventCaptureService.setMockSlackHandler((notif) => {
        dispatchedNotification = notif;
        return true;
      });

      const callSid = 'CA_live_inbound_test_001';
      const payload = {
        CallSid: callSid,
        From: '+923082113844',
        To: '+19715885823', // bound service number
        CallStatus: 'ringing',
        Direction: 'inbound',
        agent_id: 'agent_vfarm_cs_v1',
        conversation_id: 'conv_el_12345',
      };

      const sig = computeElevenLabsSignature(payload);
      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('elevenlabs-signature', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.call_sid).toBe(callSid);
      expect(res.body.tenant_id).toBe('tenant-vfarm-01');
      expect(res.body.project_id).toBe('proj-vfarm-main');
      expect(res.body.unresolved_attribution).toBe(false);
      expect(res.body.slack_delivered).toBe(true);

      // Verify durable persistence in database / in-memory store
      const recordedEvents = VoiceEventCaptureService.getRecordedEvents();
      expect(recordedEvents.length).toBe(1);
      const startEvt = recordedEvents[0];
      expect(startEvt.type).toBe('cst.interaction.start');
      expect(startEvt.correlation_id).toBe(callSid);
      expect(startEvt.channel).toBe('voice');
      expect(startEvt.tenant_id).toBe('tenant-vfarm-01');
      expect(startEvt.customer.is_known).toBe(true);

      // Verify Slack notification targeted #bha-customer-service-twin (C0BD6D53HAM)
      expect(dispatchedNotification).not.toBeNull();
      expect(dispatchedNotification!.channel).toBe('#bha-customer-service-twin');
      expect(dispatchedNotification!.channel_id).toBe('C0BD6D53HAM');
      expect(dispatchedNotification!.event_type).toBe('inbound_call');
      expect(dispatchedNotification!.call_sid).toBe(callSid);
    });

    it('1.2 Handles missing optional fields gracefully', async () => {
      const callSid = 'CA_inbound_minimal_002';
      const payload = {
        CallSid: callSid,
        To: '+19715885823',
      };

      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.call_sid).toBe(callSid);
    });

    it('1.3 Rejects request missing required identifiers (no CallSid, call_id, or conversation_id)', async () => {
      const payload = {
        From: '+923082113844',
        To: '+19715885823',
      };

      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toContain('Either CallSid, call_id, or conversation_id must be provided');
    });

    it('1.4 Rejects request with invalid authentication', async () => {
      const payload = {
        CallSid: 'CA_unauth_test',
        To: '+19715885823',
      };

      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('elevenlabs-signature', 'invalid_signature_hex_1234')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHORIZED');
    });

    it('1.5 Rejects malformed payload', async () => {
      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send('not a valid json or form');

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });

    it('1.6 Handles unresolved tenant/project attribution with diagnostic state preserved', async () => {
      const callSid = 'CA_unresolved_did_003';
      const payload = {
        CallSid: callSid,
        From: '+923082113844',
        To: '+19998887777', // unbound receiving number
      };

      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.unresolved_attribution).toBe(true);
      expect(res.body.tenant_id).toBe('unresolved');
      expect(res.body.project_id).toBe('unresolved');

      // Verify event preserved with unresolved attribution
      const recorded = VoiceEventCaptureService.getRecordedEvents();
      expect(recorded.length).toBe(1);
      expect(recorded[0].data.metadata?.unresolved_attribution).toBe(true);
    });

    it('1.7 Idempotently ignores duplicate inbound call without duplicating events', async () => {
      const callSid = 'CA_dup_inbound_004';
      const payload = {
        CallSid: callSid,
        To: '+19715885823',
      };

      const res1 = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send(payload);
      expect(res1.body.status).toBe('processed');

      const res2 = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send(payload);
      expect(res2.body.status).toBe('already_processed');

      // Total events recorded must remain 1
      expect(VoiceEventCaptureService.getRecordedEvents().length).toBe(1);
    });

    it('1.8 Rejects client-supplied cross-tenant overrides (anti-tamper rule R-NUM-S4)', async () => {
      const callSid = 'CA_tamper_attempt_005';
      const payload = {
        CallSid: callSid,
        To: '+19715885823', // bound to tenant-vfarm-01
        tenant_id: 'tenant-malicious-override',
      };

      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('refused');
      expect(res.body.error).toContain('TENANT_SCOPE_VIOLATION');
    });

    it('1.9 Safely handles database persistence failure without unhandled crash', async () => {
      vi.spyOn(DbClient, 'recordDashboardPublishOutcome').mockRejectedValueOnce(
        new Error('PostgreSQL connection terminated unexpectedly')
      );

      const payload = {
        CallSid: 'CA_db_fail_006',
        To: '+19715885823',
      };

      const res = await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toContain('Database persistence failed');
    });
  });

  // ==========================================================================
  // 2. Status Callback Capture
  // ==========================================================================
  describe('2. Status Callback Capture', () => {
    it('2.1 Processes a valid completed status callback, correlates to inbound CallSid, and produces cst.delivery + cst.outcome', async () => {
      let dispatchedNotification: CustomerServiceSlackNotification | null = null;
      VoiceEventCaptureService.setMockSlackHandler((notif) => {
        dispatchedNotification = notif;
        return true;
      });

      const callSid = 'CA_status_complete_010';
      const payload = {
        CallSid: callSid,
        From: '+923082113844',
        To: '+19715885823',
        CallStatus: 'completed',
        CallDuration: '54',
        SequenceNumber: '3',
      };

      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.call_sid).toBe(callSid);
      expect(res.body.call_status).toBe('completed');
      expect(res.body.delivery_status).toBe('delivered');
      expect(res.body.event_ids.length).toBe(2); // cst.delivery + cst.outcome

      const recorded = VoiceEventCaptureService.getRecordedEvents();
      expect(recorded.length).toBe(2);
      expect(recorded.some((e) => e.type === 'cst.delivery')).toBe(true);
      expect(recorded.some((e) => e.type === 'cst.outcome')).toBe(true);

      // Verify Slack notification
      expect(dispatchedNotification).not.toBeNull();
      expect(dispatchedNotification!.call_status).toBe('completed');
      expect(dispatchedNotification!.duration_secs).toBe(54);
      expect(dispatchedNotification!.channel_id).toBe('C0BD6D53HAM');
    });

    it('2.2 Handles each supported status from the provider contract', async () => {
      for (const status of SUPPORTED_TWILIO_CALL_STATUSES) {
        VoiceEventCaptureService.reset();
        const callSid = `CA_status_${status}_test`;
        const payload = {
          CallSid: callSid,
          To: '+19715885823',
          CallStatus: status,
        };

        const res = await request(app)
          .post('/webhooks/voice/status')
          .set('x-test-bypass-signature', 'true')
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('processed');
        expect(res.body.call_status).toBe(status);
      }
    });

    it('2.3 Rejects unknown status and does NOT classify as successful or delivered', async () => {
      const callSid = 'CA_unknown_status_012';
      const payload = {
        CallSid: callSid,
        To: '+19715885823',
        CallStatus: 'alien_status_xyz',
      };

      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(422);
      expect(res.body.status).toBe('unsupported_status');
      expect(res.body.error).toContain('Unsupported call status');

      // No events recorded for unsupported status
      expect(VoiceEventCaptureService.getRecordedEvents().length).toBe(0);
    });

    it('2.4 Rejects status callback with missing CallSid', async () => {
      const payload = {
        To: '+19715885823',
        CallStatus: 'completed',
      };

      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
      expect(res.body.error).toContain('CallSid');
    });

    it('2.5 Idempotently handles duplicate status callback', async () => {
      const callSid = 'CA_dup_status_013';
      const payload = {
        CallSid: callSid,
        To: '+19715885823',
        CallStatus: 'in-progress',
        SequenceNumber: '1',
      };

      const res1 = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(payload);
      expect(res1.body.status).toBe('processed');

      const res2 = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(payload);
      expect(res2.body.status).toBe('already_processed');
    });

    it('2.6 Out-of-order callback handling: prevents late-arriving ringing/in-progress from regressing completed state', async () => {
      const callSid = 'CA_ooo_test_014';

      // 1. Terminal 'completed' callback arrives first
      const completeRes = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send({
          CallSid: callSid,
          To: '+19715885823',
          CallStatus: 'completed',
          SequenceNumber: '2',
        });
      expect(completeRes.body.out_of_order).toBe(false);

      // Verify delivery record in DbClient is 'sent' (terminal completion)
      const deliveryRecord = DbClient.getAllVoiceDeliveries().find((d) => d.correlation_id === callSid);
      expect(deliveryRecord?.status).toBe('sent');

      // 2. Delayed 'ringing' callback arrives AFTER 'completed'
      const ringingRes = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send({
          CallSid: callSid,
          To: '+19715885823',
          CallStatus: 'ringing',
          SequenceNumber: '1',
        });

      expect(ringingRes.body.status).toBe('processed');
      expect(ringingRes.body.out_of_order).toBe(true);

      // The delivery status in DbClient must NOT have regressed to 'synthesized' or 'sending'!
      const preservedRecord = DbClient.getAllVoiceDeliveries().find((d) => d.correlation_id === callSid);
      expect(preservedRecord?.status).toBe('sent');
    });

    it('2.7 Preserves error callback code and message (ErrorCode & ErrorMessage)', async () => {
      let dispatchedNotification: CustomerServiceSlackNotification | null = null;
      VoiceEventCaptureService.setMockSlackHandler((notif) => {
        dispatchedNotification = notif;
        return true;
      });

      const callSid = 'CA_error_carrier_015';
      const payload = {
        CallSid: callSid,
        To: '+19715885823',
        CallStatus: 'failed',
        ErrorCode: '31400',
        ErrorMessage: 'Carrier network unreachable',
      };

      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.call_status).toBe('failed');
      expect(res.body.delivery_status).toBe('failed');

      // Check delivery record has error details
      const delivery = DbClient.getAllVoiceDeliveries().find((d) => d.correlation_id === callSid);
      expect(delivery?.error_code).toBe('31400');
      expect(delivery?.error_message).toBe('Carrier network unreachable');

      // Check Slack notification carried error details
      expect(dispatchedNotification?.error_code).toBe('31400');
      expect(dispatchedNotification?.error_message).toBe('Carrier network unreachable');
    });

    it('2.8 Rejects status callback with invalid authentication', async () => {
      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('authorization', 'Bearer completely_bogus_token')
        .send({
          CallSid: 'CA_unauth_status',
          CallStatus: 'completed',
        });

      expect(res.status).toBe(401);
    });
  });

  // ==========================================================================
  // 3. Publishing and Reliability
  // ==========================================================================
  describe('3. Publishing, Retries & Reliability', () => {
    it('3.1 Persists event durably when Slack publication fails and queues for retry', async () => {
      VoiceEventCaptureService.setMockSlackHandler(() => {
        throw new Error('Slack API rate limit / 500 error');
      });

      const callSid = 'CA_slack_fail_020';
      const payload = {
        CallSid: callSid,
        To: '+19715885823',
        CallStatus: 'completed',
      };

      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(payload);

      // Webhook should still succeed because event was durably persisted
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.slack_delivered).toBe(false);

      // Event is safely recorded in durable storage
      expect(VoiceEventCaptureService.getRecordedEvents().length).toBeGreaterThan(0);
      // Failed delivery is queued for retry
      expect(VoiceEventCaptureService.getFailedSlackDeliveries().length).toBe(1);
    });

    it('3.2 Retries queued failed Slack deliveries without duplicating durable events', async () => {
      // First attempt fails
      VoiceEventCaptureService.setMockSlackHandler(() => false);

      await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send({
          CallSid: 'CA_retry_test_021',
          To: '+19715885823',
          CallStatus: 'completed',
        });

      expect(VoiceEventCaptureService.getFailedSlackDeliveries().length).toBe(1);
      const initialEventsCount = VoiceEventCaptureService.getRecordedEvents().length;

      // Second attempt succeeds
      VoiceEventCaptureService.setMockSlackHandler(() => true);
      const retriedCount = await VoiceEventCaptureService.retryFailedSlackDeliveries();

      expect(retriedCount).toBe(1);
      expect(VoiceEventCaptureService.getFailedSlackDeliveries().length).toBe(0);
      // No duplicate events were inserted during retry
      expect(VoiceEventCaptureService.getRecordedEvents().length).toBe(initialEventsCount);
    });

    it('3.3 Ensures caller phone numbers are masked in Slack notifications (privacy check)', async () => {
      let dispatchedNotification: CustomerServiceSlackNotification | null = null;
      VoiceEventCaptureService.setMockSlackHandler((notif) => {
        dispatchedNotification = notif;
        return true;
      });

      const rawCallerNumber = '+923082113844';
      await request(app)
        .post('/webhooks/voice/inbound')
        .set('x-test-bypass-signature', 'true')
        .send({
          CallSid: 'CA_privacy_test_022',
          From: rawCallerNumber,
          To: '+19715885823',
        });

      expect(dispatchedNotification).not.toBeNull();
      // Raw phone number must NEVER appear unmasked
      expect(dispatchedNotification!.text).not.toContain(rawCallerNumber);
      expect(dispatchedNotification!.text).toContain('+9230****3844');
    });
  });

  describe('4. Twilio Event Streams CloudEvents & Test Probe Support', () => {
    it('4.1 Acknowledges Twilio Event Streams test probe with HTTP 200 OK', async () => {
      const testEventPayload = [
        {
          specversion: '1.0',
          type: 'com.twilio.eventstreams.test-event',
          source: 'Sink',
          id: 'AC11111111111111111111111111111111',
          data: { test_id: 'probe_test_001' },
        },
      ];

      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(testEventPayload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.message).toContain('Twilio Event Streams test sink verified');
    });

    it('4.2 Processes Twilio Event Streams CloudEvents array of voice events', async () => {
      const cloudEventsPayload = [
        {
          specversion: '1.0',
          type: 'com.twilio.voice.insights.call-summary.complete',
          source: '/v1/Voice/CA_eventstream_001/Summary',
          id: 'EV_001',
          time: new Date().toISOString(),
          data: {
            call_sid: 'CA_eventstream_001',
            call_state: 'completed',
            from: { caller: '+923082113844' },
            to: { callee: '+19715885823' },
            duration: 65,
          },
        },
      ];

      const res = await request(app)
        .post('/webhooks/voice/status')
        .set('x-test-bypass-signature', 'true')
        .send(cloudEventsPayload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.processed_events).toBe(1);
      expect(res.body.results[0].call_sid).toBe('CA_eventstream_001');
      expect(res.body.results[0].call_status).toBe('completed');
    });
  });
});
