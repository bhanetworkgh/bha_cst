import { Logger } from '../config/logger.js';
import { maskPhone } from '../util/privacy.js';
import { randomUUID, createHash } from 'node:crypto';
import { currentRelayTrace, traceRelay } from '../observability/relay_trace.js';

export type ErrorClass = 'Twilio' | 'vFarm' | 'CST' | 'NS' | 'CS_HANDOFF';

export interface RawErrorEvent {
  service?: string;
  source?: string;
  error?: Error | unknown;
  message: string;
  severity?: 'CRITICAL' | 'ERROR' | 'WARN';
  tenant_id?: string | null;
  project_id?: string | null;
  correlation_id?: string;
  category?: string;
  route?: string;
  timestamp?: string;
  meta?: Record<string, unknown>;
}

export interface ClassifiedError {
  error_class: ErrorClass;
  canonical_owner: string;
  destination_channel: string;
  webhook_env_var: string;
  title: string;
  severity: 'CRITICAL' | 'ERROR' | 'WARN';
  correlation_id?: string;
  timestamp: string;
  payload: RawErrorEvent;
}

export interface DispatchResult {
  dispatched: boolean;
  error_class: ErrorClass;
  destination_channel: string;
  suppressed_as_duplicate?: boolean;
  status: 'sent' | 'suppressed' | 'deferred' | 'failed';
  error?: string;
}

export type SlackDispatchHandler = (
  classified: ClassifiedError,
  body: Record<string, unknown>
) => Promise<boolean> | boolean;

export class ErrorRouter {
  private static mockHandler: SlackDispatchHandler | null = null;
  private static recentAlerts = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 60_000;
  private static failedDeliveries: ClassifiedError[] = [];

  static setMockHandler(handler: SlackDispatchHandler | null): void {
    this.mockHandler = handler;
  }

  static reset(): void {
    this.mockHandler = null;
    this.recentAlerts.clear();
    this.failedDeliveries = [];
  }

  static getFailedDeliveries(): ClassifiedError[] {
    return [...this.failedDeliveries];
  }

  /**
   * Classify an incoming error event deterministically into exactly one error class.
   */
  static classify(event: RawErrorEvent): ClassifiedError {
    const service = (event.service || '').toUpperCase();
    const source = (event.source || '').toLowerCase();
    const category = (event.category || '').toLowerCase();
    const route = (event.route || '').toLowerCase();
    const message = (event.message || '').toLowerCase();
    const errStr = String(event.error instanceof Error ? event.error.message : event.error || '').toLowerCase();

    const timestamp = event.timestamp || new Date().toISOString();
    const severity = event.severity || 'ERROR';

    // 1. Customer Service Handoff / Escalation -> CS Bot Channel
    if (
      category === 'escalation' ||
      category === 'cs_handoff' ||
      service === 'CS_HANDOFF' ||
      route.includes('/escalation') ||
      message.includes('human assistance') ||
      message.includes('customer escalation')
    ) {
      return {
        error_class: 'CS_HANDOFF',
        canonical_owner: 'Ahad / Customer Service Lead',
        destination_channel: '#bha-customer-service-twin',
        webhook_env_var: 'SLACK_CS_WEBHOOK_URL',
        title: 'Customer Service Handoff',
        severity: severity === 'CRITICAL' ? 'WARN' : severity, // Never route CRITICAL engine alert to CS channel
        correlation_id: event.correlation_id,
        timestamp,
        payload: event,
      };
    }

    // 2. Twilio Transport & Webhook Errors -> CST/Twilio Ops
    if (
      service === 'TWILIO' ||
      source.includes('twilio') ||
      route.includes('/webhooks/twilio') ||
      category.includes('twilio') ||
      message.includes('twilio') ||
      errStr.includes('twilio') ||
      errStr.includes('x-twilio-signature')
    ) {
      return {
        error_class: 'Twilio',
        canonical_owner: 'CST / Twilio Infrastructure Lead',
        destination_channel: '#cst-ops',
        webhook_env_var: 'SLACK_TWILIO_OPS_WEBHOOK_URL',
        title: 'Twilio Telephony Alert',
        severity,
        correlation_id: event.correlation_id,
        timestamp,
        payload: event,
      };
    }

    // 3. vFarm Telemetry, Sensors, and Upstream Errors -> Monitoring Twin
    if (
      service === 'VFARM' ||
      source.includes('vfarm') ||
      category === 'no_reading' ||
      category === 'sensor_timeout' ||
      category === 'invalid_request' ||
      route.includes('/vfarm') ||
      message.includes('vfarm') ||
      errStr.includes('vfarm') ||
      errStr.includes('sensor') ||
      errStr.includes('422 unprocessable')
    ) {
      return {
        error_class: 'vFarm',
        canonical_owner: 'Jegan / Monitoring Twin Owner',
        destination_channel: '#vfarm-monitoring',
        webhook_env_var: 'SLACK_VFARM_MONITORING_WEBHOOK_URL',
        title: 'vFarm Telemetry Alert',
        severity,
        correlation_id: event.correlation_id,
        timestamp,
        payload: event,
      };
    }

    // 4. North Star / Platform Engine Monitoring -> North Star
    if (
      service === 'NORTH_STAR' ||
      service === 'NS' ||
      source.includes('northstar') ||
      source.includes('north_star') ||
      category.includes('north_star')
    ) {
      return {
        error_class: 'NS',
        canonical_owner: 'North Star Platform Owner',
        destination_channel: '#northstar-alerts',
        webhook_env_var: 'SLACK_NS_WEBHOOK_URL',
        title: 'North Star Engine Alert',
        severity,
        correlation_id: event.correlation_id,
        timestamp,
        payload: event,
      };
    }

    // 5. CST Application Errors -> CST Operations
    return {
      error_class: 'CST',
      canonical_owner: 'Ahad / CST Application Engineer',
      destination_channel: '#cst-ops',
      webhook_env_var: 'SLACK_CST_OPS_WEBHOOK_URL',
      title: 'CST Application Alert',
      severity,
      correlation_id: event.correlation_id,
      timestamp,
      payload: event,
    };
  }

  /**
   * Route and dispatch the error event to its single canonical destination.
   */
  static async route(event: RawErrorEvent, bypassDedup: boolean = false): Promise<DispatchResult> {
    const classified = this.classify(event);

    // Hard constraint: Critical engine alerts must NEVER route to #bha-customer-service-twin
    if (classified.destination_channel === '#bha-customer-service-twin' && event.severity === 'CRITICAL') {
      Logger.warn(`Routing safety intervention: Critical engine alert suppressed from Customer Service channel`);
      return {
        dispatched: false,
        error_class: classified.error_class,
        destination_channel: classified.destination_channel,
        status: 'suppressed',
        error: 'CRITICAL engine alerts cannot be routed to #bha-customer-service-twin',
      };
    }

    // Deduplication check
    const dedupKey = `${classified.error_class}:${classified.destination_channel}:${event.message}`;
    const now = Date.now();
    if (!bypassDedup) {
      const lastSent = this.recentAlerts.get(dedupKey);
      if (lastSent && now - lastSent < this.DEDUP_WINDOW_MS) {
        return {
          dispatched: false,
          error_class: classified.error_class,
          destination_channel: classified.destination_channel,
          suppressed_as_duplicate: true,
          status: 'suppressed',
        };
      }
    }
    this.recentAlerts.set(dedupKey, now);

    const slackBody = {
      channel: classified.destination_channel,
      text: `[${classified.severity}] ${classified.title}: ${event.message}`,
      owner: classified.canonical_owner,
      correlation_id: classified.correlation_id,
      timestamp: classified.timestamp,
      meta: event.meta,
    };

    if (this.mockHandler) {
      try {
        const ok = await this.mockHandler(classified, slackBody);
        if (!ok) {
          this.recentAlerts.delete(dedupKey);
          this.failedDeliveries.push(classified);
        }
        return {
          dispatched: Boolean(ok),
          error_class: classified.error_class,
          destination_channel: classified.destination_channel,
          status: ok ? 'sent' : 'failed',
        };
      } catch (err: any) {
        this.recentAlerts.delete(dedupKey);
        this.failedDeliveries.push(classified);
        return {
          dispatched: false,
          error_class: classified.error_class,
          destination_channel: classified.destination_channel,
          status: 'failed',
          error: err?.message,
        };
      }
    }

    // Resolve webhook URL: target env var first, fall back to SLACK_CUSTOMER_SERVICE_WEBHOOK_URL, SLACK_ERROR_WEBHOOK_URL or SLACK_WEBHOOK_URL
    let targetUrl = process.env[classified.webhook_env_var] ||
      process.env.SLACK_CUSTOMER_SERVICE_WEBHOOK_URL ||
      process.env.SLACK_CS_WEBHOOK_URL ||
      process.env.SLACK_ERROR_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL;

    if (targetUrl && targetUrl.startsWith('http://')) {
      targetUrl = 'https://' + targetUrl.slice(7);
    }

    if (!targetUrl) {
      traceRelay('slack_dispatch_deferred', { destination_channel: classified.destination_channel });
      return {
        dispatched: false,
        error_class: classified.error_class,
        destination_channel: classified.destination_channel,
        status: 'deferred',
        error: `Webhook URL unconfigured for ${classified.destination_channel} (${classified.webhook_env_var})`,
      };
    }

    // Observation-only marker, after existing routing/dedup decisions. The
    // incoming webhook returns no message ts; the read-only receipt tool joins
    // this exact marker to Slack history without changing this delivery path.
    const trace = currentRelayTrace();
    const dispatchId = trace ? `dispatch_${randomUUID()}` : undefined;
    if (dispatchId) slackBody.text += `\n[PBT5 trace: ${dispatchId}]`;
    const traceFields = trace ? {
      dispatch_id: dispatchId,
      destination_channel: classified.destination_channel,
      committed_rows: [...trace.committed_rows],
      slack_text_sha256: createHash('sha256').update(slackBody.text).digest('hex'),
    } : {};
    traceRelay('slack_dispatch_attempt', traceFields);

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackBody),
      });
      traceRelay('slack_dispatch_result', {
        ...traceFields,
        http_status: response.status,
        http_ok: response.ok,
        // Transport success is not yet an exact-message receipt.
        slack_message_id: null,
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        this.failedDeliveries.push(classified);
        return {
          dispatched: false,
          error_class: classified.error_class,
          destination_channel: classified.destination_channel,
          status: 'failed',
          error: `HTTP ${response.status}: ${errText}`,
        };
      }

      return {
        dispatched: true,
        error_class: classified.error_class,
        destination_channel: classified.destination_channel,
        status: 'sent',
      };
    } catch (err: any) {
      traceRelay('slack_dispatch_result', { ...traceFields, http_ok: false, http_status: null, slack_message_id: null });
      this.failedDeliveries.push(classified);
      return {
        dispatched: false,
        error_class: classified.error_class,
        destination_channel: classified.destination_channel,
        status: 'failed',
        error: err?.message,
      };
    }
  }

  /**
   * Retry failed deliveries.
   */
  static async retryFailedDeliveries(): Promise<number> {
    const queue = [...this.failedDeliveries];
    this.failedDeliveries = [];
    let successCount = 0;
    for (const item of queue) {
      const res = await this.route(item.payload, true);
      if (res.dispatched) {
        successCount++;
      } else {
        this.failedDeliveries.push(item);
      }
    }
    return successCount;
  }
}
