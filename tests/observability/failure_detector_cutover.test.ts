import { describe, expect, it, beforeEach } from 'vitest';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { CutOverManager } from '../../engine/src/observability/cut_over.js';

describe('Failure Detection, Health Checks & Forward-Only Cut-Over (Deliverable F)', () => {
  beforeEach(() => {
    FailureDetector.reset();
    CutOverManager.reset();
  });

  describe('1. Failure Detection & Health Transitions', () => {
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
  });

  describe('2. Forward-Only Cut-Over Boundary Enforcement', () => {
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

