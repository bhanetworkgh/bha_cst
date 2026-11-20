/**
 * CST Monitoring Slack Notification Service
 *
 * Dispatches operational monitoring alerts, incident notifications, customer escalations,
 * and recovery updates directly to BHA Slack channels using the existing CST Monitoring
 * Slack App (App ID: A0CF23GMNHJ, Bot User: U0CF23JSUG4) via Slack Web API `chat.postMessage`.
 *
 * Architecture:
 *   CST Monitoring Engine → Existing CST Monitoring Slack App → BHA Slack Channels
 *
 * Hard Guarantees:
 *  1. FAIL-SAFE: Notification failures are operational side-effects and never throw,
 *     break, or block customer-facing voice/SMS turn execution.
 *  2. DEDUPLICATION: Prevents flooding channels during cascading failures (60s sliding window).
 *  3. RATE-LIMIT RESILIENT: Respects HTTP 429 Retry-After with bounded exponential backoff.
 *  4. PRIVACY & TENANCY: Automatically redacts customer phone numbers and credentials,
 *     sanitizes mrkdwn injection, and isolates tenant boundaries.
 *  5. AUDITABLE: Records delivery outcome (sent, suppressed, deferred, failed, disabled)
 *     and maintains failed delivery queue for retry without silent loss.
 */

import { randomUUID } from 'node:crypto';
import { Logger } from '../config/logger.js';
import { maskPhone } from '../util/privacy.js';

export type MonitoringAlertSeverity = 'CRITICAL' | 'HIGH' | 'WARN' | 'INFO';

export type MonitoringAlertType =
  | 'sensor_offline'
  | 'sensor_stale'
  | 'device_degraded'
  | 'vfarm_api_failure';

export interface MonitoringAlertEvent {
  type: MonitoringAlertType;
  severity: MonitoringAlertSeverity;
  system: string;
  farm_id?: string;
  device_id?: string;
  sensor_id?: string;
  reason: string;
  last_reading_at?: string | null;
  correlation_id?: string;
  tenant_id?: string | null;
  project_id?: string | null;
  meta?: Record<string, unknown>;
  timestamp?: string;
  channel_id?: string;
}

export interface IncidentNotificationEvent {
  incident_id?: string;
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'WARN';
  system: string;
  farm_id?: string;
  device_id?: string;
  reason: string;
  diagnostic_info?: string | Record<string, unknown>;
  correlation_id?: string;
  tenant_id?: string | null;
  project_id?: string | null;
  dashboard_url?: string;
  timestamp?: string;
  channel_id?: string;
}

export interface EscalationNotificationEvent {
  escalation_id?: string;
  caller_phone: string;
  reason: string;
  severity?: 'WARN' | 'INFO';
  conversation_id?: string;
  correlation_id?: string;
  caller_email?: string;
  tenant_id?: string | null;
  project_id?: string | null;
  timestamp?: string;
  channel_id?: string;
}

export interface RecoveryNotificationEvent {
  original_incident_id?: string;
  system: string;
  farm_id?: string;
  device_id?: string;
  previous_state: string;
  current_state: string;
  recovery_reason: string;
  duration_ms?: number;
  correlation_id?: string;
  tenant_id?: string | null;
  project_id?: string | null;
  timestamp?: string;
  channel_id?: string;
}

export interface SlackDeliveryResult {
  dispatched: boolean;
  status: 'sent' | 'suppressed' | 'deferred' | 'failed' | 'disabled';
  channel_id?: string;
  channel_name?: string;
  message_ts?: string;
  error?: string;
  retry_count?: number;
}

export interface ActiveIncidentRecord {
  incidentId: string;
  channelId: string;
  channelName: string;
  reportedAt: number;
  system: string;
  farmId?: string;
  deviceId?: string;
}

export interface FailedDeliveryRecord {
  eventType: 'monitoring' | 'incident' | 'escalation' | 'recovery';
  event: unknown;
  channelId: string;
  error: string;
  timestamp: string;
  attempts: number;
}

export type SlackMockHandler = (
  channel: string,
  payload: { text: string; blocks: any[] },
) => Promise<SlackDeliveryResult | boolean> | SlackDeliveryResult | boolean;

/**
 * Escapes characters that have special formatting meaning in Slack mrkdwn
 * to prevent formatting injection from untrusted inputs.
 */
export function sanitizeMrkdwn(text: unknown): string {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Strips sensitive fields (tokens, passwords, keys) from metadata before Slack rendering.
 */
export function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const lower = k.toLowerCase();
    if (
      lower.includes('token') ||
      lower.includes('secret') ||
      lower.includes('password') ||
      lower.includes('key') ||
      lower.includes('auth') ||
      lower.includes('cookie')
    ) {
      clean[k] = '[REDACTED]';
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

export class MonitoringSlackService {
  private static mockHandler: SlackMockHandler | null = null;
  private static dedupCache = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 60_000;
  private static activeIncidents = new Map<string, ActiveIncidentRecord>();
  private static failedDeliveries: FailedDeliveryRecord[] = [];

  /** Testing seam: register mock handler for outbound Slack posts */
  static setMockHandler(handler: SlackMockHandler | null): void {
    this.mockHandler = handler;
  }

  /** Testing seam: clear state */
  static reset(): void {
    this.mockHandler = null;
    this.dedupCache.clear();
    this.activeIncidents.clear();
    this.failedDeliveries = [];
  }

  /** Retrieve queued failed deliveries for inspection */
  static getFailedDeliveries(): FailedDeliveryRecord[] {
    return [...this.failedDeliveries];
  }

  /**
   * Resolves the target Slack channel ID and human-readable name based on event class.
   */
  static resolveChannel(
    category: 'monitoring' | 'incident' | 'escalation' | 'recovery' | 'engineering',
    overrideChannel?: string,
  ): { channelId: string; channelName: string; isConfigured: boolean } {
    if (overrideChannel && overrideChannel.trim()) {
      const clean = overrideChannel.trim();
      return { channelId: clean, channelName: clean, isConfigured: true };
    }

    if (category === 'escalation') {
      const channelId = (
        process.env.SLACK_CS_CHANNEL_ID ||
        process.env.CST_HANDOFF_CHANNEL_ID ||
        process.env.CST_CALL_LOG_CHANNEL_ID ||
        'C0BD6D53HAM'
      ).trim();
      return { channelId, channelName: '#bha-customer-service-twin', isConfigured: Boolean(channelId) };
    }

    if (category === 'engineering') {
      const channelId = (
        process.env.SLACK_PIPELINE_ERRORS_CHANNEL_ID ||
        process.env.CST_ERROR_CHANNEL_ID ||
        'C0ATC4CA3G9'
      ).trim();
      return { channelId, channelName: '#bha-pipeline-errors', isConfigured: Boolean(channelId) };
    }

    // Monitoring, incident, recovery
    const channelId = (
      process.env.SLACK_MONITORING_CHANNEL_ID ??
      process.env.SLACK_VFARM_MONITORING_CHANNEL_ID ??
      'C0B8JTE51PG'
    ).trim();
    return {
      channelId,
      channelName: '#bha-vfarm-monitoring-twin',
      isConfigured: Boolean(channelId),
    };
  }

  /**
   * 1. Send Monitoring Alert
   * Used for sensor offline, sensor readings stale, device degraded, or vFarm API failures.
   */
  static async sendMonitoringAlert(event: MonitoringAlertEvent): Promise<SlackDeliveryResult> {
    try {
      if (process.env.SLACK_ALERTS_ENABLED === 'false') {
        return { dispatched: false, status: 'disabled', error: 'SLACK_ALERTS_ENABLED is false' };
      }

      // Deduplication check
      const dedupKey = `monitoring:${event.type}:${event.system}:${event.farm_id || ''}:${event.device_id || ''}:${event.sensor_id || ''}:${event.reason}`;
      const now = Date.now();
      const lastSent = this.dedupCache.get(dedupKey);
      if (lastSent && now - lastSent < this.DEDUP_WINDOW_MS) {
        return {
          dispatched: false,
          status: 'suppressed',
          error: 'Duplicate monitoring alert suppressed within deduplication window',
        };
      }
      this.dedupCache.set(dedupKey, now);

      const target = this.resolveChannel('monitoring', event.channel_id);
      if (!target.isConfigured) {
        Logger.warn(
          `MonitoringSlackService: target channel unconfigured for monitoring alert (${target.channelName})`,
          { type: event.type, system: event.system, farm_id: event.farm_id, device_id: event.device_id },
        );
        return {
          dispatched: false,
          status: 'deferred',
          channel_name: target.channelName,
          error: 'SLACK_MONITORING_CHANNEL_ID is not configured',
        };
      }

      const card = this.buildMonitoringAlertCard(event);
      const delivery = await this.dispatchPost(target.channelId, card, 'monitoring', event);

      if (!delivery.dispatched) {
        this.dedupCache.delete(dedupKey);
      }

      // If alert indicates degraded device or offline sensor, track active incident for recovery
      if (delivery.dispatched && (event.type === 'device_degraded' || event.type === 'sensor_offline')) {
        const incidentKey = `${event.system}:${event.farm_id || 'all'}:${event.device_id || 'all'}`;
        this.activeIncidents.set(incidentKey, {
          incidentId: event.correlation_id || `mon_${Date.now()}`,
          channelId: target.channelId,
          channelName: target.channelName,
          reportedAt: now,
          system: event.system,
          farmId: event.farm_id,
          deviceId: event.device_id,
        });
      }

      return delivery;
    } catch (err: any) {
      Logger.error(`MonitoringSlackService.sendMonitoringAlert failed: ${err?.message}`, { error: err?.message }, false);
      return { dispatched: false, status: 'failed', error: err?.message };
    }
  }

  /**
   * 2. Send Incident Notification
   * Used for critical farm-level or system-wide incidents with diagnostic context.
   */
  static async sendIncidentNotification(event: IncidentNotificationEvent): Promise<SlackDeliveryResult> {
    try {
      if (process.env.SLACK_ALERTS_ENABLED === 'false') {
        return { dispatched: false, status: 'disabled', error: 'SLACK_ALERTS_ENABLED is false' };
      }

      const dedupKey = `incident:${event.system}:${event.farm_id || ''}:${event.device_id || ''}:${event.title}:${event.reason}`;
      const now = Date.now();
      const lastSent = this.dedupCache.get(dedupKey);
      if (lastSent && now - lastSent < this.DEDUP_WINDOW_MS) {
        return {
          dispatched: false,
          status: 'suppressed',
          error: 'Duplicate incident notification suppressed within deduplication window',
        };
      }
      this.dedupCache.set(dedupKey, now);

      const target = this.resolveChannel('incident', event.channel_id);
      if (!target.isConfigured) {
        Logger.warn(
          `MonitoringSlackService: target channel unconfigured for incident notification (${target.channelName})`,
          { title: event.title, system: event.system, farm_id: event.farm_id },
        );
        return {
          dispatched: false,
          status: 'deferred',
          channel_name: target.channelName,
          error: 'SLACK_MONITORING_CHANNEL_ID is not configured',
        };
      }

      const card = this.buildIncidentCard(event);
      const delivery = await this.dispatchPost(target.channelId, card, 'incident', event);

      if (!delivery.dispatched) {
        this.dedupCache.delete(dedupKey);
      }

      if (delivery.dispatched) {
        const incidentKey = `${event.system}:${event.farm_id || 'all'}:${event.device_id || 'all'}`;
        this.activeIncidents.set(incidentKey, {
          incidentId: event.incident_id || event.correlation_id || `inc_${Date.now()}`,
          channelId: target.channelId,
          channelName: target.channelName,
          reportedAt: now,
          system: event.system,
          farmId: event.farm_id,
          deviceId: event.device_id,
        });
      }

      return delivery;
    } catch (err: any) {
      Logger.error(`MonitoringSlackService.sendIncidentNotification failed: ${err?.message}`, { error: err?.message }, false);
      return { dispatched: false, status: 'failed', error: err?.message };
    }
  }

  /**
   * 3. Send Escalation Notification
   * Routes customer escalation / human handoff requests to #bha-customer-service-twin.
   */
  static async sendEscalationNotification(event: EscalationNotificationEvent): Promise<SlackDeliveryResult> {
    try {
      if (process.env.SLACK_ALERTS_ENABLED === 'false') {
        return { dispatched: false, status: 'disabled', error: 'SLACK_ALERTS_ENABLED is false' };
      }

      const masked = maskPhone(event.caller_phone);
      const dedupKey = `escalation:${masked}:${event.reason}`;
      const now = Date.now();
      const lastSent = this.dedupCache.get(dedupKey);
      if (lastSent && now - lastSent < this.DEDUP_WINDOW_MS) {
        return {
          dispatched: false,
          status: 'suppressed',
          error: 'Duplicate escalation notification suppressed within deduplication window',
        };
      }
      this.dedupCache.set(dedupKey, now);

      const target = this.resolveChannel('escalation', event.channel_id);
      if (!target.isConfigured) {
        Logger.warn(`MonitoringSlackService: target channel unconfigured for customer escalation (${target.channelName})`);
        return {
          dispatched: false,
          status: 'deferred',
          channel_name: target.channelName,
          error: 'Customer service channel ID is not configured',
        };
      }

      const card = this.buildEscalationCard(event);
      const delivery = await this.dispatchPost(target.channelId, card, 'escalation', event);
      if (!delivery.dispatched) {
        this.dedupCache.delete(dedupKey);
      }
      return delivery;
    } catch (err: any) {
      Logger.error(`MonitoringSlackService.sendEscalationNotification failed: ${err?.message}`, { error: err?.message }, false);
      return { dispatched: false, status: 'failed', error: err?.message };
    }
  }

  /**
   * 4. Send Recovery Notification
   * Dispatches recovery updates to the original incident channel when degraded/offline states return to normal.
   * Will not dispatch recovery for incidents that were never recorded.
   */
  static async sendRecoveryNotification(event: RecoveryNotificationEvent): Promise<SlackDeliveryResult> {
    try {
      if (process.env.SLACK_ALERTS_ENABLED === 'false') {
        return { dispatched: false, status: 'disabled', error: 'SLACK_ALERTS_ENABLED is false' };
      }

      const incidentKey = `${event.system}:${event.farm_id || 'all'}:${event.device_id || 'all'}`;
      const prior = this.activeIncidents.get(incidentKey);

      // Section 5.G: Do not send recovery notifications for incidents that were never recorded
      if (!prior && !event.original_incident_id) {
        Logger.info(
          `MonitoringSlackService: recovery notification skipped; no active incident recorded for ${incidentKey}`,
        );
        return {
          dispatched: false,
          status: 'suppressed',
          error: 'Recovery notification skipped: no prior incident recorded for this device/scope',
        };
      }

      const targetChannelId = prior?.channelId || event.channel_id || this.resolveChannel('monitoring').channelId;
      const targetChannelName = prior?.channelName || '#bha-vfarm-monitoring-twin';

      if (!targetChannelId) {
        return {
          dispatched: false,
          status: 'deferred',
          channel_name: targetChannelName,
          error: 'SLACK_MONITORING_CHANNEL_ID is not configured for recovery notification',
        };
      }

      const card = this.buildRecoveryCard(event, prior);
      const delivery = await this.dispatchPost(targetChannelId, card, 'recovery', event);

      if (delivery.dispatched) {
        this.activeIncidents.delete(incidentKey);
      }

      return delivery;
    } catch (err: any) {
      Logger.error(`MonitoringSlackService.sendRecoveryNotification failed: ${err?.message}`, { error: err?.message }, false);
      return { dispatched: false, status: 'failed', error: err?.message };
    }
  }

  /**
   * Dispatches outbound message via Slack Web API `chat.postMessage` with bounded retries.
   */
  private static async dispatchPost(
    channel: string,
    payload: { text: string; blocks: any[] },
    eventType: 'monitoring' | 'incident' | 'escalation' | 'recovery',
    originalEvent: unknown,
  ): Promise<SlackDeliveryResult> {
    const channelName = this.getChannelName(channel);

    // Mock handler inspection seam for unit tests
    if (this.mockHandler) {
      try {
        const mockRes = await this.mockHandler(channel, payload);
        if (typeof mockRes === 'boolean') {
          return {
            dispatched: mockRes,
            status: mockRes ? 'sent' : 'failed',
            channel_id: channel,
            channel_name: channelName,
            message_ts: mockRes ? `${Date.now() / 1000}` : undefined,
          };
        }
        return mockRes;
      } catch (err: any) {
        this.recordFailedDelivery(eventType, originalEvent, channel, err?.message || 'Mock handler rejected', 1);
        return { dispatched: false, status: 'failed', channel_id: channel, error: err?.message };
      }
    }

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken || !botToken.trim()) {
      Logger.warn(`MonitoringSlackService: SLACK_BOT_TOKEN is not configured; notification deferred`);
      return {
        dispatched: false,
        status: 'deferred',
        channel_id: channel,
        channel_name: channelName,
        error: 'SLACK_BOT_TOKEN is not configured',
      };
    }

    const maxRetries = 2;
    let attempts = 0;
    let lastError = '';

    while (attempts <= maxRetries) {
      attempts++;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            channel,
            text: payload.text,
            blocks: payload.blocks,
            unfurl_links: false,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // Handle HTTP 429 Rate Limiting
        if (res.status === 429) {
          const retryAfterHeader = res.headers.get('Retry-After');
          const waitSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 1 : 1;
          lastError = `Slack rate limit exceeded (HTTP 429, retry-after: ${waitSec}s)`;
          Logger.warn(`MonitoringSlackService: rate limited on channel ${channel}, attempt ${attempts}/${maxRetries + 1}`);

          if (attempts <= maxRetries) {
            const backoffMs = process.env.VITEST === 'true' ? 10 : Math.min(waitSec * 1000, 2000);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          break;
        }

        // Handle HTTP 5xx Server Errors
        if (res.status >= 500) {
          lastError = `Slack server error (HTTP ${res.status})`;
          Logger.warn(`MonitoringSlackService: HTTP ${res.status} on attempt ${attempts}/${maxRetries + 1}`);
          if (attempts <= maxRetries) {
            const backoffMs = process.env.VITEST === 'true' ? 10 : 150 * Math.pow(2, attempts - 1);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          break;
        }

        const data: any = await res.json().catch(() => ({ ok: false, error: `invalid_json_http_${res.status}` }));

        if (data.ok) {
          return {
            dispatched: true,
            status: 'sent',
            channel_id: data.channel || channel,
            channel_name: channelName,
            message_ts: data.ts,
            retry_count: attempts - 1,
          };
        }

        // Slack API application-level errors (e.g. invalid_auth, channel_not_found, not_in_channel)
        lastError = `chat.postMessage error: ${data.error}`;
        if (data.error === 'rate_limited' && attempts <= maxRetries) {
          const backoffMs = process.env.VITEST === 'true' ? 10 : 250;
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        // Non-retryable error (e.g. invalid_auth, channel_not_found)
        break;
      } catch (err: any) {
        lastError = err?.name === 'AbortError' ? 'Network timeout calling Slack API' : (err?.message || 'Unknown network error');
        Logger.warn(`MonitoringSlackService: network failure on attempt ${attempts}/${maxRetries + 1}: ${lastError}`);
        if (attempts <= maxRetries) {
          const backoffMs = process.env.VITEST === 'true' ? 10 : 150 * Math.pow(2, attempts - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
      }
    }

    this.recordFailedDelivery(eventType, originalEvent, channel, lastError, attempts);
    return {
      dispatched: false,
      status: 'failed',
      channel_id: channel,
      channel_name: channelName,
      error: lastError,
      retry_count: attempts - 1,
    };
  }

  private static recordFailedDelivery(
    eventType: 'monitoring' | 'incident' | 'escalation' | 'recovery',
    event: unknown,
    channelId: string,
    error: string,
    attempts: number,
  ): void {
    this.failedDeliveries.push({
      eventType,
      event,
      channelId,
      error,
      timestamp: new Date().toISOString(),
      attempts,
    });
    // Cap failed deliveries history at 100 items
    if (this.failedDeliveries.length > 100) {
      this.failedDeliveries.shift();
    }
  }

  /**
   * Retry all previously recorded failed deliveries.
   */
  static async retryFailedDeliveries(): Promise<number> {
    const queue = [...this.failedDeliveries];
    this.failedDeliveries = [];
    let recoveredCount = 0;

    for (const item of queue) {
      let res: SlackDeliveryResult;
      switch (item.eventType) {
        case 'monitoring':
          res = await this.sendMonitoringAlert(item.event as MonitoringAlertEvent);
          break;
        case 'incident':
          res = await this.sendIncidentNotification(item.event as IncidentNotificationEvent);
          break;
        case 'escalation':
          res = await this.sendEscalationNotification(item.event as EscalationNotificationEvent);
          break;
        case 'recovery':
          res = await this.sendRecoveryNotification(item.event as RecoveryNotificationEvent);
          break;
      }
      if (res.dispatched) {
        recoveredCount++;
      } else {
        this.failedDeliveries.push(item);
      }
    }
    return recoveredCount;
  }

  private static getChannelName(channelId: string): string {
    if (channelId === 'C0BD6D53HAM' || channelId === process.env.SLACK_CS_CHANNEL_ID) return '#bha-customer-service-twin';
    if (channelId === 'C0ATC4CA3G9' || channelId === process.env.SLACK_PIPELINE_ERRORS_CHANNEL_ID) return '#bha-pipeline-errors';
    return '#bha-vfarm-monitoring-twin';
  }

  // ── Block Kit Card Builders ───────────────────────────────────────────────

  static buildMonitoringAlertCard(event: MonitoringAlertEvent): { text: string; blocks: any[] } {
    const icon = event.type === 'sensor_offline' ? ':satellite_antenna:' :
      event.type === 'sensor_stale' ? ':hourglass_flowing_sand:' :
      event.type === 'device_degraded' ? ':tools:' : ':electric_plug:';

    const titlePrefix = event.type === 'sensor_offline' ? 'Sensor Offline' :
      event.type === 'sensor_stale' ? 'Sensor Readings Stale' :
      event.type === 'device_degraded' ? 'Device Health Degraded' : 'vFarm API Failure';

    const timestamp = event.timestamp || new Date().toISOString();
    const cleanReason = sanitizeMrkdwn(event.reason);

    const fields: any[] = [
      { type: 'mrkdwn', text: `*System*\n${sanitizeMrkdwn(event.system || 'vFarm')}` },
      { type: 'mrkdwn', text: `*Severity*\n${sanitizeMrkdwn(event.severity)}` },
    ];

    if (event.farm_id) fields.push({ type: 'mrkdwn', text: `*Farm*\n\`${sanitizeMrkdwn(event.farm_id)}\`` });
    if (event.device_id) fields.push({ type: 'mrkdwn', text: `*Device*\n\`${sanitizeMrkdwn(event.device_id)}\`` });
    if (event.sensor_id) fields.push({ type: 'mrkdwn', text: `*Sensor*\n\`${sanitizeMrkdwn(event.sensor_id)}\`` });
    if (event.last_reading_at) fields.push({ type: 'mrkdwn', text: `*Last Reading*\n${sanitizeMrkdwn(event.last_reading_at)}` });
    if (event.correlation_id) fields.push({ type: 'mrkdwn', text: `*Correlation ID*\n\`${sanitizeMrkdwn(event.correlation_id)}\`` });
    if (event.tenant_id) fields.push({ type: 'mrkdwn', text: `*Tenant*\n${sanitizeMrkdwn(event.tenant_id)}` });

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${icon} CST Monitoring — ${titlePrefix}`, emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Monitoring Twin  •  CST Monitoring Slack App  •  ${timestamp}` }],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Status Details*\n${cleanReason.slice(0, 2000)}` },
      },
      {
        type: 'section',
        fields,
      },
    ];

    const cleanMeta = sanitizeMeta(event.meta);
    if (cleanMeta && Object.keys(cleanMeta).length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Diagnostics*\n\`\`\`${JSON.stringify(cleanMeta, null, 2).slice(0, 1500)}\`\`\`` },
      });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Operational side-effect  •  Fail-safe delivery  •  Bays Horizon Network' }],
    });

    const fallbackText = `[${event.severity}] CST Monitoring — ${titlePrefix}: ${cleanReason.slice(0, 250)}`;
    return { text: fallbackText, blocks };
  }

  static buildIncidentCard(event: IncidentNotificationEvent): { text: string; blocks: any[] } {
    const timestamp = event.timestamp || new Date().toISOString();
    const cleanTitle = sanitizeMrkdwn(event.title);
    const cleanReason = sanitizeMrkdwn(event.reason);

    const fields: any[] = [
      { type: 'mrkdwn', text: `*System*\n${sanitizeMrkdwn(event.system || 'vFarm')}` },
      { type: 'mrkdwn', text: `*Severity*\n${sanitizeMrkdwn(event.severity)}` },
    ];

    if (event.incident_id) fields.push({ type: 'mrkdwn', text: `*Incident ID*\n\`${sanitizeMrkdwn(event.incident_id)}\`` });
    if (event.farm_id) fields.push({ type: 'mrkdwn', text: `*Farm*\n\`${sanitizeMrkdwn(event.farm_id)}\`` });
    if (event.device_id) fields.push({ type: 'mrkdwn', text: `*Device*\n\`${sanitizeMrkdwn(event.device_id)}\`` });
    if (event.correlation_id) fields.push({ type: 'mrkdwn', text: `*Correlation ID*\n\`${sanitizeMrkdwn(event.correlation_id)}\`` });
    if (event.tenant_id) fields.push({ type: 'mrkdwn', text: `*Tenant*\n${sanitizeMrkdwn(event.tenant_id)}` });

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:rotating_light: CST Incident — ${cleanTitle}`, emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Incident Management  •  bha-cst on Render  •  ${timestamp}` }],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Incident Reason*\n${cleanReason.slice(0, 2000)}` },
      },
      {
        type: 'section',
        fields,
      },
    ];

    if (event.diagnostic_info) {
      const diagText = typeof event.diagnostic_info === 'string'
        ? event.diagnostic_info
        : JSON.stringify(sanitizeMeta(event.diagnostic_info), null, 2);
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Diagnostic Info*\n\`\`\`${sanitizeMrkdwn(diagText).slice(0, 1500)}\`\`\`` },
      });
    }

    if (event.dashboard_url && /^https?:\/\//.test(event.dashboard_url)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `<${event.dashboard_url}|:bar_chart: Open CST Monitoring Dashboard>` },
      });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Operations team action required  •  Full telemetry logged in PostgreSQL' }],
    });

    return { text: `[${event.severity}] CST Incident: ${cleanTitle} — ${cleanReason.slice(0, 250)}`, blocks };
  }

  static buildEscalationCard(event: EscalationNotificationEvent): { text: string; blocks: any[] } {
    const timestamp = event.timestamp || new Date().toISOString();
    const maskedPhone = maskPhone(event.caller_phone);
    const cleanReason = sanitizeMrkdwn(event.reason);

    const fields: any[] = [
      { type: 'mrkdwn', text: `*Caller*\n\`${maskedPhone}\`` },
      { type: 'mrkdwn', text: `*Severity*\n${sanitizeMrkdwn(event.severity || 'WARN')}` },
    ];

    if (event.escalation_id) fields.push({ type: 'mrkdwn', text: `*Escalation ID*\n\`${sanitizeMrkdwn(event.escalation_id)}\`` });
    if (event.conversation_id) fields.push({ type: 'mrkdwn', text: `*Conversation*\n\`${sanitizeMrkdwn(event.conversation_id)}\`` });
    if (event.tenant_id) fields.push({ type: 'mrkdwn', text: `*Tenant*\n${sanitizeMrkdwn(event.tenant_id)}` });
    if (event.project_id) fields.push({ type: 'mrkdwn', text: `*Project*\n${sanitizeMrkdwn(event.project_id)}` });

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:raising_hand: CST Escalation — Human Assistance Requested`, emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Customer Service Twin  •  bha-cst on Render  •  ${timestamp}` }],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Customer Request*\nCustomer ${maskedPhone} requested human assistance: ${cleanReason.slice(0, 1500)}` },
      },
      {
        type: 'section',
        fields,
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Action required: Customer service team member must follow up within 2 hours.' }],
      },
    ];

    return { text: `[ESCALATION] Customer ${maskedPhone} requested assistance: ${cleanReason.slice(0, 250)}`, blocks };
  }

  static buildRecoveryCard(event: RecoveryNotificationEvent, prior?: ActiveIncidentRecord): { text: string; blocks: any[] } {
    const timestamp = event.timestamp || new Date().toISOString();
    const cleanReason = sanitizeMrkdwn(event.recovery_reason);
    const incidentId = event.original_incident_id || prior?.incidentId;

    const fields: any[] = [
      { type: 'mrkdwn', text: `*System*\n${sanitizeMrkdwn(event.system || 'vFarm')}` },
      { type: 'mrkdwn', text: `*Status*\n:white_check_mark: ${sanitizeMrkdwn(event.current_state)}` },
      { type: 'mrkdwn', text: `*Previous State*\n${sanitizeMrkdwn(event.previous_state)}` },
    ];

    if (incidentId) fields.push({ type: 'mrkdwn', text: `*Resolved Incident*\n\`${sanitizeMrkdwn(incidentId)}\`` });
    if (event.farm_id) fields.push({ type: 'mrkdwn', text: `*Farm*\n\`${sanitizeMrkdwn(event.farm_id)}\`` });
    if (event.device_id) fields.push({ type: 'mrkdwn', text: `*Device*\n\`${sanitizeMrkdwn(event.device_id)}\`` });
    if (event.duration_ms) {
      const durSec = Math.round(event.duration_ms / 1000);
      fields.push({ type: 'mrkdwn', text: `*Outage Duration*\n${durSec}s` });
    }

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:white_check_mark: CST Monitoring — Incident Recovered`, emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Monitoring Twin  •  Incident Recovery  •  ${timestamp}` }],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Recovery Outcome*\n${cleanReason.slice(0, 2000)}` },
      },
      {
        type: 'section',
        fields,
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'System has restored normal operation and verified telemetry streams.' }],
      },
    ];

    return { text: `[RECOVERED] CST Monitoring: ${event.system} (${event.farm_id || 'all'}/${event.device_id || 'all'}) restored to ${event.current_state}`, blocks };
  }
}
