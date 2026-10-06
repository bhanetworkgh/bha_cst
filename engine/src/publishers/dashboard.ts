/**
 * CstDashboardPublisher
 *
 * Dispatches CST canonical events (cst.event.v1) to the external Engine Dashboard.
 *
 * Guarantees:
 *  1. Non-blocking & fire-and-forget: Never blocks the customer conversation response.
 *  2. Resilient retry: Retries on network failures, 408, 429, and 5xx.
 *  3. Fail-fast on 4xx: Stops immediately on non-retryable client errors (400, 401, 403, 404, etc.).
 *  4. 5-second default timeout per request attempt.
 *  5. Logs missing configuration warning once at boot without repeated spam.
 */

import { Logger } from '../config/logger.js';
import { CstEventV1, CST_EVENT_SPEC_VERSION, safeParseCstEventV1 } from '../contracts/events.js';

export interface DashboardPublisherOptions {
  dashboardUrl?: string;
  dashboardKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  backoffMultiplier?: number;
  /**
   * Dry-run mode (cst-e2e/DASHBOARD_FLOW.md §5). When true the publisher
   * validates the event against the cst.event.v1 contract and logs the
   * serialized payload locally, but makes NO remote HTTP request, so the
   * Dashboard persists nothing. Defaults to `DRY_RUN === 'true'`.
   */
  dryRun?: boolean;
  fetchFn?: typeof fetch;
}

export interface PublishResult {
  success: boolean;
  status?: number;
  attempts: number;
  error?: string;
  eventId?: string;
  /** True when the event was validated and logged locally without any
   *  remote request (dry-run mode). */
  dryRun?: boolean;
}

export class CstDashboardPublisher {
  private static hasLoggedMissingConfig = false;

  private readonly dashboardUrl?: string;
  private readonly dashboardKey?: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly dryRun: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options: DashboardPublisherOptions = {}) {
    this.dashboardUrl = options.dashboardUrl ?? process.env.ENGINE_DASHBOARD_URL;
    this.dashboardKey = options.dashboardKey ?? process.env.ENGINE_DASHBOARD_KEY;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 100;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.dryRun = options.dryRun ?? process.env.DRY_RUN === 'true';
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * True when the publisher is in dry-run mode: events are validated and
   * logged locally but never sent to the remote Dashboard (no production
   * records are written). See cst-e2e/DASHBOARD_FLOW.md §5.
   */
  public isDryRun(): boolean {
    return this.dryRun;
  }

  /**
   * Check configuration at boot time and log a warning once if missing.
   */
  public static checkBootConfig(): boolean {
    const url = process.env.ENGINE_DASHBOARD_URL;
    const key = process.env.ENGINE_DASHBOARD_KEY;
    return this.logMissingConfigOnce(url, key);
  }

  /**
   * Log missing configuration once across the application lifecycle.
   */
  public static logMissingConfigOnce(url?: string, key?: string): boolean {
    if (url && key) {
      return true;
    }

    if (!this.hasLoggedMissingConfig) {
      this.hasLoggedMissingConfig = true;
      const missing: string[] = [];
      if (!url) missing.push('ENGINE_DASHBOARD_URL');
      if (!key) missing.push('ENGINE_DASHBOARD_KEY');
      Logger.warn(
        `[CstDashboardPublisher] Missing configuration: ${missing.join(', ')}. Dashboard event publishing is disabled.`
      );
    }
    return false;
  }

  /**
   * Reset config logging state (primarily for test environments).
   */
  public static resetConfigLogging(): void {
    this.hasLoggedMissingConfig = false;
  }

  /**
   * Determines if the publisher is currently configured with URL and API key.
   */
  public isConfigured(): boolean {
    return Boolean(this.dashboardUrl && this.dashboardKey);
  }

  /**
   * Fire-and-forget dispatch: schedules background delivery immediately
   * without blocking or returning a promise to await. Guarantees customer flow
   * is never blocked or delayed.
   */
  public publishFireAndForget(event: CstEventV1 | Record<string, unknown>): void {
    setImmediate(() => {
      this.publish(event).catch((err: any) => {
        Logger.warn(
          `[CstDashboardPublisher] Unexpected error in fire-and-forget publisher: ${err?.message ?? String(err)}`
        );
      });
    });
  }

  /**
   * Publishes an event independently with timeout and retry handling.
   * Never throws exceptions; returns a structured result.
   */
  public async publish(
    event: CstEventV1 | Record<string, unknown>,
    options?: { fireAndForget?: boolean }
  ): Promise<PublishResult> {
    if (options?.fireAndForget) {
      this.publishFireAndForget(event);
      return { success: true, attempts: 0 };
    }

    const eventId = (event as any)?.id || (event as any)?.correlation_id || 'unknown';

    if (!this.isConfigured()) {
      CstDashboardPublisher.logMissingConfigOnce(this.dashboardUrl, this.dashboardKey);
      return {
        success: false,
        attempts: 0,
        error: 'MISSING_CONFIGURATION',
        eventId,
      };
    }

    // Dry-run (DASHBOARD_FLOW.md §5): validate the event against the
    // cst.event.v1 contract and log the serialized payload locally, but
    // make NO remote HTTP request, so the Dashboard writes no production
    // record. A structurally invalid event is reported as a validation
    // failure rather than silently accepted — dry-run must not become a
    // way to ship malformed events.
    if (this.dryRun) {
      const parsed = safeParseCstEventV1(event);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        Logger.warn(
          `[CstDashboardPublisher] Dry-run validation failed for event ${eventId}: ${issues}`
        );
        return {
          success: false,
          attempts: 0,
          error: 'VALIDATION_FAILED',
          eventId,
          dryRun: true,
        };
      }
      Logger.info(
        `[CstDashboardPublisher] Dry-run: event ${eventId} (${(event as any).type}) validated against cst.event.v1; no remote request made.`
      );
      Logger.info(`[CstDashboardPublisher] Dry-run payload: ${JSON.stringify(event)}`);
      return {
        success: true,
        attempts: 0,
        eventId,
        dryRun: true,
      };
    }

    return this.sendWithRetry(event, eventId);
  }

  /**
   * Internal retry loop for network/408/429/5xx, failing fast on non-retryable 4xx.
   */
  private async sendWithRetry(
    event: CstEventV1 | Record<string, unknown>,
    eventId: string
  ): Promise<PublishResult> {
    const url = this.dashboardUrl!;
    const key = this.dashboardKey!;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${key}`,
      'x-dashboard-key': key,
      'x-cst-specversion': CST_EVENT_SPEC_VERSION,
    };

    const body = JSON.stringify(event);
    let delayMs = this.initialRetryDelayMs;
    let lastError = 'UNKNOWN_ERROR';
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        lastStatus = response.status;

        // 2xx Success
        if (response.ok) {
          return {
            success: true,
            status: response.status,
            attempts: attempt,
            eventId,
          };
        }

        // Retryable status codes: 408 (Timeout), 429 (Rate Limit), 5xx (Server Error)
        const isRetryable =
          response.status === 408 ||
          response.status === 429 ||
          (response.status >= 500 && response.status <= 599);

        // Non-retryable 4xx (400, 401, 403, 404, 422, etc.)
        if (!isRetryable && response.status >= 400 && response.status < 500) {
          const errText = await response.text().catch(() => '');
          Logger.warn(
            `[CstDashboardPublisher] Dashboard rejected event ${eventId} with HTTP ${response.status} (non-retryable): ${errText.slice(0, 200)}`
          );
          return {
            success: false,
            status: response.status,
            attempts: attempt,
            error: `HTTP_${response.status}`,
            eventId,
          };
        }

        // Retryable HTTP response
        lastError = `HTTP_${response.status}`;
        Logger.warn(
          `[CstDashboardPublisher] Attempt ${attempt}/${this.maxRetries} failed with retryable status HTTP ${response.status} for event ${eventId}`
        );
      } catch (err: any) {
        clearTimeout(timeoutId);
        const isTimeout = err?.name === 'AbortError';
        lastError = isTimeout ? 'TIMEOUT_5S' : (err?.message || 'NETWORK_ERROR');

        Logger.warn(
          `[CstDashboardPublisher] Attempt ${attempt}/${this.maxRetries} error for event ${eventId}: ${lastError}`
        );
      }

      // If attempts remain, wait with exponential backoff before retrying
      if (attempt < this.maxRetries) {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        delayMs *= this.backoffMultiplier;
      }
    }

    Logger.warn(
      `[CstDashboardPublisher] Exhausted all ${this.maxRetries} attempts for event ${eventId}. Final error: ${lastError}`
    );

    return {
      success: false,
      status: lastStatus,
      attempts: this.maxRetries,
      error: lastError,
      eventId,
    };
  }
}

/**
 * Default singleton instance configured from environment variables.
 */
export const dashboardPublisher = new CstDashboardPublisher();

/**
 * Process-wide publisher override.
 *
 * `dashboardPublisher` is constructed at module load, so it captures the
 * environment exactly once. Anything that needs to aim CST at a different
 * ingestion endpoint (a local verification sink, a test double) goes through
 * here rather than reaching into the singleton's private config — otherwise the
 * cst.turn path and the cst.delivery path would disagree about where events go.
 */
let activePublisher: CstDashboardPublisher | null = null;

export function setActiveDashboardPublisher(publisher: CstDashboardPublisher | null): void {
  activePublisher = publisher;
}

/** The publisher every CST event path must use. */
export function getDashboardPublisher(): CstDashboardPublisher {
  return activePublisher ?? dashboardPublisher;
}
