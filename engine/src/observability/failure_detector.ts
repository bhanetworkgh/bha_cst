import { Logger } from '../config/logger.js';

export interface WebhookMetrics {
  total_received: number;
  authenticated_success: number;
  auth_failures: number;
  validation_failures: number;
  processing_failures: number;
  persistence_failures: number;
  duplicate_deliveries: number;
  last_successful_timestamp: string | null;
  pending_retries: number;
}

export interface SlackDeliveryMetrics {
  total_attempts: number;
  successful_deliveries: number;
  failed_deliveries: number;
  rate_limit_hits: number;
  deferred_deliveries: number;
  pending_retries: number;
  last_successful_timestamp: string | null;
}

export interface TwilioCallbackMetrics {
  total_callbacks: number;
  signature_valid: number;
  signature_invalid: number;
  unmatched_sids: number;
  unresolved_attributions: number;
  invalid_transitions: number;
  duplicate_callbacks: number;
  delivered_count: number;
  failed_delivery_count: number;
  last_callback_timestamp: string | null;
}

export interface FailureDetectorReport {
  liveness: 'healthy' | 'unhealthy';
  readiness: 'ready' | 'degraded' | 'unready';
  timestamp: string;
  subsystems: {
    elevenlabs_webhook: {
      status: 'healthy' | 'degraded' | 'failing';
      metrics: WebhookMetrics;
    };
    slack_notifications: {
      status: 'healthy' | 'degraded' | 'failing';
      metrics: SlackDeliveryMetrics;
    };
    twilio_callbacks: {
      status: 'healthy' | 'degraded' | 'failing';
      metrics: TwilioCallbackMetrics;
    };
  };
  unhealthy_reasons: string[];
}

export class FailureDetector {
  private static webhookMetrics: WebhookMetrics = {
    total_received: 0,
    authenticated_success: 0,
    auth_failures: 0,
    validation_failures: 0,
    processing_failures: 0,
    persistence_failures: 0,
    duplicate_deliveries: 0,
    last_successful_timestamp: null,
    pending_retries: 0,
  };

  private static slackMetrics: SlackDeliveryMetrics = {
    total_attempts: 0,
    successful_deliveries: 0,
    failed_deliveries: 0,
    rate_limit_hits: 0,
    deferred_deliveries: 0,
    pending_retries: 0,
    last_successful_timestamp: null,
  };

  private static twilioMetrics: TwilioCallbackMetrics = {
    total_callbacks: 0,
    signature_valid: 0,
    signature_invalid: 0,
    unmatched_sids: 0,
    unresolved_attributions: 0,
    invalid_transitions: 0,
    duplicate_callbacks: 0,
    delivered_count: 0,
    failed_delivery_count: 0,
    last_callback_timestamp: null,
  };

  static reset(): void {
    this.webhookMetrics = {
      total_received: 0,
      authenticated_success: 0,
      auth_failures: 0,
      validation_failures: 0,
      processing_failures: 0,
      persistence_failures: 0,
      duplicate_deliveries: 0,
      last_successful_timestamp: null,
      pending_retries: 0,
    };
    this.slackMetrics = {
      total_attempts: 0,
      successful_deliveries: 0,
      failed_deliveries: 0,
      rate_limit_hits: 0,
      deferred_deliveries: 0,
      pending_retries: 0,
      last_successful_timestamp: null,
    };
    this.twilioMetrics = {
      total_callbacks: 0,
      signature_valid: 0,
      signature_invalid: 0,
      unmatched_sids: 0,
      unresolved_attributions: 0,
      invalid_transitions: 0,
      duplicate_callbacks: 0,
      delivered_count: 0,
      failed_delivery_count: 0,
      last_callback_timestamp: null,
    };
  }

  // ── Webhook recordings ─────────────────────────────────────────────────────

  static recordWebhookReceived(): void {
    this.webhookMetrics.total_received++;
  }

  static recordWebhookAuthSuccess(): void {
    this.webhookMetrics.authenticated_success++;
  }

  static recordWebhookAuthFailure(reason?: string): void {
    this.webhookMetrics.auth_failures++;
    Logger.warn(`FailureDetector: webhook authentication failed`, { reason });
  }

  static recordWebhookValidationFailure(details?: unknown): void {
    this.webhookMetrics.validation_failures++;
    Logger.warn(`FailureDetector: webhook payload validation failed`, { details });
  }

  static recordWebhookProcessingSuccess(): void {
    this.webhookMetrics.last_successful_timestamp = new Date().toISOString();
  }

  static recordWebhookProcessingFailure(error?: string): void {
    this.webhookMetrics.processing_failures++;
    this.webhookMetrics.pending_retries++;
    Logger.error(`FailureDetector: webhook processing failure: ${error}`);
  }

  static recordWebhookPersistenceFailure(error?: string, notify = true): void {
    this.webhookMetrics.persistence_failures++;
    Logger.error(`FailureDetector: webhook database persistence failure: ${error}`, undefined, notify);
  }

  static recordWebhookDuplicate(): void {
    this.webhookMetrics.duplicate_deliveries++;
  }

  // ── Slack delivery recordings ──────────────────────────────────────────────

  static recordSlackAttempt(): void {
    this.slackMetrics.total_attempts++;
  }

  static recordSlackSuccess(): void {
    this.slackMetrics.successful_deliveries++;
    this.slackMetrics.last_successful_timestamp = new Date().toISOString();
    if (this.slackMetrics.pending_retries > 0) {
      this.slackMetrics.pending_retries--;
    }
  }

  static recordSlackFailure(error?: string): void {
    this.slackMetrics.failed_deliveries++;
    this.slackMetrics.pending_retries++;
    Logger.error(`FailureDetector: Slack delivery failed: ${error}`);
  }

  static recordSlackRateLimit(): void {
    this.slackMetrics.rate_limit_hits++;
    this.slackMetrics.pending_retries++;
    Logger.warn(`FailureDetector: Slack rate limit encountered`);
  }

  static recordSlackDeferred(channel: string): void {
    this.slackMetrics.deferred_deliveries++;
    Logger.info(`FailureDetector: Slack delivery deferred (unconfigured channel or URL: ${channel})`);
  }

  // ── Twilio callback recordings ─────────────────────────────────────────────

  static recordTwilioCallback(): void {
    this.twilioMetrics.total_callbacks++;
    this.twilioMetrics.last_callback_timestamp = new Date().toISOString();
  }

  static recordTwilioSignature(valid: boolean): void {
    if (valid) {
      this.twilioMetrics.signature_valid++;
    } else {
      this.twilioMetrics.signature_invalid++;
      Logger.warn(`FailureDetector: Twilio signature validation failed`);
    }
  }

  static recordTwilioUnmatchedSid(sid: string): void {
    this.twilioMetrics.unmatched_sids++;
    Logger.warn(`FailureDetector: Twilio callback SID ${sid} not found in database records`);
  }

  static recordTwilioUnresolvedAttribution(sid: string): void {
    this.twilioMetrics.unresolved_attributions++;
    Logger.warn(`FailureDetector: Twilio callback SID ${sid} missing tenant/project attribution`);
  }

  static recordTwilioInvalidTransition(sid: string, fromState: string, toState: string): void {
    this.twilioMetrics.invalid_transitions++;
    Logger.warn(`FailureDetector: Twilio callback SID ${sid} invalid state transition from ${fromState} to ${toState}`);
  }

  static recordTwilioDeliveryStatus(status: string): void {
    if (status === 'delivered') {
      this.twilioMetrics.delivered_count++;
    } else if (['failed', 'undelivered'].includes(status)) {
      this.twilioMetrics.failed_delivery_count++;
    }
  }

  // ── Overall Health Report ──────────────────────────────────────────────────

  static getHealthReport(): FailureDetectorReport {
    const unhealthyReasons: string[] = [];

    // Evaluate Webhooks
    let webhookStatus: 'healthy' | 'degraded' | 'failing' = 'healthy';
    if (this.webhookMetrics.persistence_failures > 0 || this.webhookMetrics.processing_failures > 5) {
      webhookStatus = 'failing';
      unhealthyReasons.push(`Webhook processing/persistence failures (${this.webhookMetrics.persistence_failures} persistence, ${this.webhookMetrics.processing_failures} processing)`);
    } else if (this.webhookMetrics.auth_failures > 0 || this.webhookMetrics.validation_failures > 0) {
      webhookStatus = 'degraded';
      unhealthyReasons.push(`Webhook auth or validation errors detected (${this.webhookMetrics.auth_failures} auth, ${this.webhookMetrics.validation_failures} validation)`);
    }

    // Evaluate Slack
    let slackStatus: 'healthy' | 'degraded' | 'failing' = 'healthy';
    if (this.slackMetrics.failed_deliveries > 5) {
      slackStatus = 'failing';
      unhealthyReasons.push(`Slack publication failure rate high (${this.slackMetrics.failed_deliveries} failures)`);
    } else if (this.slackMetrics.failed_deliveries > 0 || this.slackMetrics.rate_limit_hits > 0) {
      slackStatus = 'degraded';
      unhealthyReasons.push(`Slack warnings: ${this.slackMetrics.failed_deliveries} failed, ${this.slackMetrics.rate_limit_hits} rate limited`);
    }

    // Evaluate Twilio
    let twilioStatus: 'healthy' | 'degraded' | 'failing' = 'healthy';
    if (this.twilioMetrics.signature_invalid > 0) {
      twilioStatus = 'failing';
      unhealthyReasons.push(`Twilio signature validation failure (${this.twilioMetrics.signature_invalid})`);
    } else if (this.twilioMetrics.unmatched_sids > 0 || this.twilioMetrics.unresolved_attributions > 0) {
      twilioStatus = 'degraded';
      unhealthyReasons.push(`Twilio attribution gaps (${this.twilioMetrics.unmatched_sids} unmatched SIDs, ${this.twilioMetrics.unresolved_attributions} unresolved attributions)`);
    }

    const readiness: 'ready' | 'degraded' | 'unready' =
      webhookStatus === 'failing' || twilioStatus === 'failing' || slackStatus === 'failing'
        ? 'unready'
        : (webhookStatus === 'degraded' || slackStatus === 'degraded' || twilioStatus === 'degraded')
          ? 'degraded'
          : 'ready';

    return {
      liveness: 'healthy',
      readiness,
      timestamp: new Date().toISOString(),
      subsystems: {
        elevenlabs_webhook: {
          status: webhookStatus,
          metrics: { ...this.webhookMetrics },
        },
        slack_notifications: {
          status: slackStatus,
          metrics: { ...this.slackMetrics },
        },
        twilio_callbacks: {
          status: twilioStatus,
          metrics: { ...this.twilioMetrics },
        },
      },
      unhealthy_reasons: unhealthyReasons,
    };
  }
}

