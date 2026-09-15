/**
 * Slack Error Alert Notification Service
 *
 * Dispatches structured, actionable error alerts to a designated Slack channel via Incoming Webhook.
 * Configured via the SLACK_WEBHOOK_URL environment variable.
 *
 * Hard Guarantees:
 *  1. FAIL-SAFE: Notification attempts never throw or break calling application flow.
 *  2. DEDUPLICATION / RATE-LIMITING: Prevents flooding the Slack channel during error bursts.
 *  3. RICH FORMATTING: Structured Slack Block Kit with severity badges, tenant/correlation IDs,
 *     and expandable error context.
 */

export type SlackAlertSeverity = 'CRITICAL' | 'ERROR' | 'WARN';

export interface SlackAlertPayload {
  title: string;
  message: string;
  severity?: SlackAlertSeverity;
  service?: string;
  tenant_id?: string | null;
  correlation_id?: string;
  error?: Error | unknown;
  meta?: Record<string, unknown>;
  timestamp?: string;
}

export type SlackMockHandler = (payload: SlackAlertPayload, rawSlackBody: Record<string, unknown>) => void | Promise<void>;

export class SlackNotifier {
  private static mockHandler: SlackMockHandler | null = null;
  private static recentAlerts: Map<string, number> = new Map();
  private static readonly DEDUP_WINDOW_MS = 60_000; // 1 minute deduplication

  /**
   * Set a mock handler for testing or intercepting Slack alerts.
   */
  static setMockHandler(handler: SlackMockHandler | null): void {
    this.mockHandler = handler;
  }

  /**
   * Reset mock handler and deduplication state.
   */
  static reset(): void {
    this.mockHandler = null;
    this.recentAlerts.clear();
  }

  /**
   * Dispatches an error alert to the configured Slack webhook channel.
   *
   * @param payload - Structured alert information.
   * @returns boolean - true if an alert was dispatched (or mocked), false if skipped/throttled.
   */
  static async sendErrorAlert(payload: SlackAlertPayload): Promise<boolean> {
    try {
      const severity = payload.severity || 'ERROR';
      const service = payload.service || 'CUSTOMER_TWIN';
      const timestamp = payload.timestamp || new Date().toISOString();

      // Deduplication check: prevent Slack channel flooding during cascading failures
      const dedupKey = `${severity}:${payload.title}:${payload.message}`;
      const now = Date.now();
      const lastSent = this.recentAlerts.get(dedupKey);
      if (lastSent && now - lastSent < this.DEDUP_WINDOW_MS) {
        return false; // Suppressed as duplicate within deduplication window
      }
      this.recentAlerts.set(dedupKey, now);

      // Clean up stale entries in dedup cache
      if (this.recentAlerts.size > 200) {
        for (const [key, time] of this.recentAlerts.entries()) {
          if (now - time > this.DEDUP_WINDOW_MS) {
            this.recentAlerts.delete(key);
          }
        }
      }

      // Build Slack Block Kit & Attachment payload
      const color = severity === 'CRITICAL' ? '#E01E5A' : severity === 'ERROR' ? '#D00000' : '#ECB22E';
      const emoji = severity === 'CRITICAL' ? ':rotating_light:' : severity === 'ERROR' ? ':x:' : ':warning:';

      const fields: Array<{ title: string; value: string; short: boolean }> = [
        { title: 'Severity', value: `${emoji} ${severity}`, short: true },
        { title: 'Service', value: service, short: true },
        { title: 'Environment', value: process.env.NODE_ENV || 'production', short: true },
        { title: 'Timestamp', value: timestamp, short: true },
      ];

      if (payload.tenant_id) {
        fields.push({ title: 'Tenant ID', value: payload.tenant_id, short: true });
      }
      if (payload.correlation_id) {
        fields.push({ title: 'Correlation ID', value: payload.correlation_id, short: true });
      }

      let errorDetails = '';
      if (payload.error) {
        if (payload.error instanceof Error) {
          errorDetails = payload.error.stack || payload.error.message;
        } else if (typeof payload.error === 'object') {
          errorDetails = JSON.stringify(payload.error, null, 2);
        } else {
          errorDetails = String(payload.error);
        }
      }

      if (payload.meta && Object.keys(payload.meta).length > 0) {
        const metaStr = JSON.stringify(payload.meta, null, 2);
        errorDetails = errorDetails ? `${errorDetails}\n\nMeta:\n${metaStr}` : `Meta:\n${metaStr}`;
      }

      const attachmentText = errorDetails
        ? `${payload.message}\n\`\`\`${errorDetails.slice(0, 2000)}\`\`\``
        : payload.message;

      const slackBody: Record<string, unknown> = {
        text: `${emoji} [${severity}] ${payload.title}: ${payload.message}`,
        attachments: [
          {
            color,
            title: payload.title,
            text: attachmentText,
            fields,
            ts: Math.floor(now / 1000),
            ...(errorDetails ? { footer: 'Error Trace & Context' } : {}),
          },
        ],
      };

      // Mock handler support (for tests and verification)
      if (this.mockHandler) {
        await this.mockHandler(payload, slackBody);
        return true;
      }

      const webhookUrl = process.env.SLACK_WEBHOOK_URL;
      if (!webhookUrl) {
        // No Slack webhook configured; return false cleanly without noise
        return false;
      }

      // Execute HTTP POST to Slack Incoming Webhook
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackBody),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown');
        console.error(`SlackNotifier: Webhook returned HTTP ${response.status}: ${errText}`);
        return false;
      }

      return true;
    } catch (err: any) {
      // Fail-safe guarantee: Never allow alerting failures to bubble up or crash operations
      console.error(`SlackNotifier: Failed to dispatch Slack error alert: ${err.message}`);
      return false;
    }
  }
}
