import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { CutOverManager } from '../../engine/src/observability/cut_over.js';

describe('Failure Detection, Health Checks & Forward-Only Cut-Over (Deliverable F)', () => {
  const app = createApp();
  beforeEach(() => {
    FailureDetector.reset();
    CutOverManager.reset();
  });

  describe('1. Failure Detection & Health Transitions', () => {
    it('keeps readiness unready when Slack escalates from degraded to failing', () => {
      for (let i=0;i<6;i++) FailureDetector.recordSlackFailure('synthetic failure');
      const report=FailureDetector.getHealthReport();
      expect(report.subsystems.slack_notifications.status).toBe('failing');
      expect(report.readiness).toBe('unready');
    });
    it('reports healthy readiness when no failures exist', () => {
      const report = FailureDetector.getHealthReport();
      expect(report.liveness).toBe('healthy');
      expect(report.readiness).toBe('ready');
      expect(report.unhealthy_reasons).toHaveLength(0);
    });

    it('transitions to degraded when webhook auth or validation failures occur', () => {
      FailureDetector.recordWebhookReceived();
      FailureDetector.recordWebhookAuthFailure('Invalid signature');

      const report = FailureDetector.getHealthReport();
      expect(report.readiness).toBe('degraded');
      expect(report.subsystems.elevenlabs_webhook.status).toBe('degraded');
      expect(report.subsystems.elevenlabs_webhook.metrics.auth_failures).toBe(1);
      expect(report.unhealthy_reasons.some((r) => r.includes('Webhook auth'))).toBe(true);
    });

    it('transitions to unready/failing when persistence or fatal webhook errors occur', () => {
      FailureDetector.recordWebhookPersistenceFailure('DB connection closed');

      const report = FailureDetector.getHealthReport();
      expect(report.readiness).toBe('unready');
      expect(report.subsystems.elevenlabs_webhook.status).toBe('failing');
      expect(report.subsystems.elevenlabs_webhook.metrics.persistence_failures).toBe(1);
    });

    it('tracks Slack delivery failures and rate limiting accurately', () => {
      FailureDetector.recordSlackAttempt();
      FailureDetector.recordSlackFailure('HTTP 500');
      FailureDetector.recordSlackRateLimit();

      const report = FailureDetector.getHealthReport();
      expect(report.subsystems.slack_notifications.metrics.failed_deliveries).toBe(1);
      expect(report.subsystems.slack_notifications.metrics.rate_limit_hits).toBe(1);
      expect(report.subsystems.slack_notifications.metrics.pending_retries).toBe(2);
      expect(report.subsystems.slack_notifications.status).toBe('degraded');

      // Now successful retry reduces pending retries
      FailureDetector.recordSlackSuccess();
      const updated = FailureDetector.getHealthReport();
      expect(updated.subsystems.slack_notifications.metrics.pending_retries).toBe(1);
    });

    it('tracks Twilio signature failures, unmatched SIDs, and delivery transitions', () => {
      FailureDetector.recordTwilioCallback();
      FailureDetector.recordTwilioSignature(false);
      FailureDetector.recordTwilioUnmatchedSid('CA_unknown_999');
      FailureDetector.recordTwilioDeliveryStatus('failed');

      const report = FailureDetector.getHealthReport();
      expect(report.subsystems.twilio_callbacks.metrics.signature_invalid).toBe(1);
      expect(report.subsystems.twilio_callbacks.metrics.unmatched_sids).toBe(1);
      expect(report.subsystems.twilio_callbacks.metrics.failed_delivery_count).toBe(1);
      expect(report.readiness).toBe('unready'); // Signature invalid is high severity
    });

    it('returns HTTP 200 on /health/reliability and /webhooks/elevenlabs/health when healthy, and HTTP 503 when Slack, Webhook, or Twilio fails', async () => {
      // 1. Healthy baseline -> HTTP 200
      FailureDetector.recordSlackAttempt();
      FailureDetector.recordSlackSuccess();
      const healthyRel = await request(app).get('/health/reliability');
      expect(healthyRel.status).toBe(200);
      expect(healthyRel.body.readiness).toBe('ready');
      expect(healthyRel.body.subsystems.slack_notifications.status).toBe('healthy');

      // 2. Repeated Slack failures (>5) -> HTTP 503 on both /health/reliability and /webhooks/elevenlabs/health
      for (let i = 0; i < 6; i++) {
        FailureDetector.recordSlackFailure(`Slack HTTP 500 failure #${i + 1}`);
      }
      const failingSlackRel = await request(app).get('/health/reliability');
      expect(failingSlackRel.status).toBe(503);
      expect(failingSlackRel.body.readiness).toBe('unready');
      expect(failingSlackRel.body.subsystems.slack_notifications.status).toBe('failing');
      expect(failingSlackRel.body.subsystems.slack_notifications.metrics.failed_deliveries).toBe(6);

      const failingWhHealth = await request(app).get('/webhooks/elevenlabs/health');
      expect(failingWhHealth.status).toBe(503);
      expect(failingWhHealth.body.overall_readiness).toBe('unready');

      // 3. Ensure a subsequent Slack success does NOT reset failed_deliveries or falsely mask the failure
      FailureDetector.recordSlackSuccess();
      const afterOneSuccess = FailureDetector.getHealthReport();
      expect(afterOneSuccess.subsystems.slack_notifications.metrics.failed_deliveries).toBe(6);
      expect(afterOneSuccess.subsystems.slack_notifications.status).toBe('failing');
      expect(afterOneSuccess.readiness).toBe('unready');

      // 4. Reset and verify Twilio signature failure triggers HTTP 503 on /health/reliability
      FailureDetector.reset();
      FailureDetector.recordTwilioSignature(false);
      const twilioFailRel = await request(app).get('/health/reliability');
      expect(twilioFailRel.status).toBe(503);
      expect(twilioFailRel.body.subsystems.twilio_callbacks.status).toBe('failing');

      // 5. Reset and verify Webhook persistence failure triggers HTTP 503 on /health/reliability
      FailureDetector.reset();
      FailureDetector.recordWebhookPersistenceFailure('Postgres connection refused');
      const whFailRel = await request(app).get('/health/reliability');
      expect(whFailRel.status).toBe(503);
      expect(whFailRel.body.subsystems.elevenlabs_webhook.status).toBe('failing');
    });
  });

  describe('2. Forward-Only Cut-Over Boundary Enforcement', () => {
    it('allows events exactly AT the boundary timestamp (>= start_timestamp) and confirms CST_CUTOVER_APPROVED does not block runtime ingestion', () => {
      const boundaryIso = '2026-11-03T00:00:00.000Z';
      CutOverManager.configure({
        start_timestamp: boundaryIso,
        is_approved: false,
      });

      const cfg = CutOverManager.getConfig();
      expect(cfg.is_approved).toBe(false);
      expect(cfg.timezone).toBe('UTC');
      expect(cfg.start_timestamp).toBe(boundaryIso);

      // Before boundary -> dropped
      const before = CutOverManager.isEventEligible('2026-11-02T23:59:59.999Z', 'evt_before_boundary');
      expect(before.eligible).toBe(false);
      expect(before.reason).toBe('historical_event_pre_cutover');

      // Exactly AT boundary -> eligible even when is_approved is false
      const atBoundary = CutOverManager.isEventEligible(boundaryIso, 'evt_at_boundary');
      expect(atBoundary.eligible).toBe(true);
      expect(atBoundary.reason).toBe('approved_forward_event');

      // After boundary -> eligible even when is_approved is false
      const after = CutOverManager.isEventEligible('2026-11-03T00:00:01.000Z', 'evt_after_boundary');
      expect(after.eligible).toBe(true);
      expect(after.reason).toBe('approved_forward_event');
    });
    it('ignores pre-cutover historical events to prevent replay', () => {
      CutOverManager.configure({
        start_timestamp: '2026-11-03T12:00:00.000Z',
        boundary_event_id: 'evt_boundary_100',
      });

      // Event from 2026-11-02 (before cut-over)
      const historicalTime = '2026-11-02T10:00:00.000Z';
      const check1 = CutOverManager.isEventEligible(historicalTime, 'evt_old_001');
      expect(check1.eligible).toBe(false);
      expect(check1.reason).toBe('historical_event_pre_cutover');

      // Boundary event ID (boundary duplicate)
      const check2 = CutOverManager.isEventEligible('2026-11-03T14:00:00.000Z', 'evt_boundary_100');
      expect(check2.eligible).toBe(false);
      expect(check2.reason).toBe('boundary_event_duplicate');

      // Forward event after cutover
      const forwardTime = '2026-11-03T13:00:00.000Z';
      const check3 = CutOverManager.isEventEligible(forwardTime, 'evt_new_001');
      expect(check3.eligible).toBe(true);
      expect(check3.reason).toBe('approved_forward_event');

      // Verify ignored events audit trail
      const ignored = CutOverManager.getIgnoredEvents();
      expect(ignored).toHaveLength(2);
      expect(ignored[0].event_id).toBe('evt_old_001');
      expect(ignored[1].event_id).toBe('evt_boundary_100');
    });

    it('handles numeric epoch timestamps in seconds', () => {
      CutOverManager.configure({
        start_timestamp: '2026-11-03T00:00:00.000Z',
      });

      const cutOverSecs = Math.floor(new Date('2026-11-03T00:00:00.000Z').getTime() / 1000);
      const preCutoverSecs = cutOverSecs - 3600;
      const postCutoverSecs = cutOverSecs + 3600;

      const preCheck = CutOverManager.isEventEligible(preCutoverSecs, 'evt_epoch_pre');
      expect(preCheck.eligible).toBe(false);

      const postCheck = CutOverManager.isEventEligible(postCutoverSecs, 'evt_epoch_post');
      expect(postCheck.eligible).toBe(true);
    });
  });
});

