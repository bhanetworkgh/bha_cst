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

import { maskPhone, maskProviderSid } from '../util/privacy.js';
import { DbClient } from '../db/client.js';
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
      await this.recordOutcome(event, eventId, {
        status: 'missing_configuration',
        attempts: 0,
        error: 'MISSING_CONFIGURATION',
      });
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
        await this.recordOutcome(event, eventId, {
          status: 'failed',
          attempts: 0,
          error: `VALIDATION_FAILED: ${issues}`,
        });
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
      // The payload is logged in its MASKED form: a dry-run log line is a log
      // line, and a log line must not carry customer identifiers.
      Logger.info(
        `[CstDashboardPublisher] Dry-run payload: ${JSON.stringify(maskEventForStorage(event, { maskProviderSids: true }))}`,
      );
      await this.recordOutcome(event, eventId, { status: 'dry_run', attempts: 0 });
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

    const body = JSON.stringify(serializeForDashboard(event));
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
          await this.recordOutcome(event, eventId, {
            status: 'published',
            attempts: attempt,
            http_status: response.status,
          });
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
          await this.recordOutcome(event, eventId, {
            status: 'failed',
            attempts: attempt,
            http_status: response.status,
            error: `HTTP_${response.status}`,
          });
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

    await this.recordOutcome(event, eventId, {
      status: 'failed',
      attempts: this.maxRetries,
      http_status: lastStatus,
      error: lastError,
    });

    return {
      success: false,
      status: lastStatus,
      attempts: this.maxRetries,
      error: lastError,
      eventId,
    };
  }

  /**
   * Persist the durable outcome of a publish attempt.
   *
   * Fire-and-forget by design: recording the evidence must never delay or
   * fail the customer path, so every error here is swallowed after a log line.
   * The stored payload is the MASKED, TTL-bounded event so the row can be
   * replayed later without becoming an unbounded store of customer content.
   */
  private async recordOutcome(
    event: CstEventV1 | Record<string, unknown>,
    eventId: string,
    outcome: {
      status: 'published' | 'failed' | 'missing_configuration' | 'dry_run';
      attempts: number;
      http_status?: number;
      error?: string;
    }
  ): Promise<void> {
    try {
      const anyEvent = event as any;
      const data = anyEvent?.data || {};
      await DbClient.recordDashboardPublishOutcome({
        event_id: eventId,
        event_type: String(anyEvent?.type || 'unknown'),
        specversion: anyEvent?.specversion,
        turn_id: data.turn_id || anyEvent?.correlation_id,
        correlation_id: anyEvent?.correlation_id,
        tenant_id: anyEvent?.tenant_id,
        project_id: anyEvent?.project_id,
        status: outcome.status,
        http_status: outcome.http_status,
        attempts: outcome.attempts,
        error: outcome.error,
        payload: maskEventForStorage(event) as Record<string, unknown>,
      });
    } catch (err: any) {
      Logger.warn(
        `[CstDashboardPublisher] Could not record publish outcome for ${eventId}: ${err?.message}`,
      );
    }
  }
}


/**
 * Keys whose values are phone numbers and must be masked before the event is
 * stored for replay.
 */
const PHONE_KEYS = new Set([
  'from',
  'from_e164',
  'to',
  'to_e164',
  'phone',
  'phone_e164',
  'phone_number',
  'caller_number',
  'recipient',
  'recipient_number',
  'speaker_phone',
  'msisdn',
]);

/**
 * Keys whose values are provider message identifiers — a handle for exactly
 * one customer message. They are masked for LOG output only; the stored
 * replay payload keeps the real identifier, because the Dashboard needs it to
 * correlate the replayed event with the original message.
 */
const PROVIDER_SID_KEYS = new Set([
  'provider_sid',
  'provider_message_id',
  'message_sid',
  'sid',
]);

/**
 * Produce a replay-safe copy of an event: phone-number values are masked, and
 * the copy is bounded in size. The stored payload is evidence, not a
 * customer-content store.
 *
 * @param options.maskProviderSids - Also mask provider message identifiers.
 *   Used for LOG output, where a per-customer handle has no business being
 *   published. The stored replay payload keeps the real identifier.
 */
export function maskEventForStorage(
  event: unknown,
  options?: { maskProviderSids?: boolean },
): Record<string, unknown> {
  const MAX_DEPTH = 8;
  const MAX_STRING = 2000;

  const walk = (value: any, depth: number, keyHint?: string): any => {
    if (depth > MAX_DEPTH) return '[depth-limited]';
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'string') {
      let masked = value;
      if (keyHint && PHONE_KEYS.has(keyHint.toLowerCase())) {
        masked = maskPhone(value);
      } else if (options?.maskProviderSids && keyHint && PROVIDER_SID_KEYS.has(keyHint.toLowerCase())) {
        masked = maskProviderSid(value);
      }
      return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…[truncated]` : masked;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      return value.slice(0, 200).map((item) => walk(item, depth + 1));
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value).slice(0, 200)) {
        out[k] = walk(v, depth + 1, k);
      }
      return out;
    }
    return null;
  };

  return walk(event, 0) as Record<string, unknown>;
}

/**
 * Serializes a CstEventV1 envelope into the flat JSON shape the Engine
 * Dashboard ingestion API expects.
 *
 * The CST event contract stores the discriminator (`type`) at the top
 * level and its payload under `data`, with `customer` as a nested object.
 * The Dashboard API expects `event_type` at the top level and flattens
 * the data/customer fields inline so they are directly indexable.
 *
 * Verified against the live Dashboard at https://dashboard.bhanetwork.org.
 */
export function serializeForDashboard(event: CstEventV1 | Record<string, unknown>): Record<string, unknown> {
  if (!event || typeof event !== 'object' || !('type' in event) || typeof (event as any).type !== 'string') {
    return event as Record<string, unknown>;
  }

  const { type, data, customer, ...envelope } = event as CstEventV1;
  const result: Record<string, unknown> = {
    ...envelope,
    event_type: type,
  };

  if (data && typeof data === 'object') {
    Object.assign(result, data);
    const totalMs = (data as any)?.duration?.total_ms;
    if (totalMs !== undefined) {
      if (type === 'cst.turn') {
        (result as any).latency_ms = totalMs;
      } else if (type === 'cst.delivery') {
        (result as any).delivery_latency_ms = totalMs;
      }
    }
  }

  if (customer && typeof customer === 'object') {
    (result as any).customer_ref = (customer as any).customer_ref;
    (result as any).phone_e164 = (customer as any).phone_e164;
    (result as any).role = (customer as any).role;
    if ((customer as any).farm_ids) (result as any).farm_ids = (customer as any).farm_ids;
    if ((customer as any).person_id) (result as any).person_id = (customer as any).person_id;
    (result as any).customer = customer;
  }

  return result;
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

/**
 * Replay Dashboard events that were recorded but never ingested.
 *
 * The publisher is fire-and-forget, so a failed publish used to be lost once
 * the log rotated. With the durable outcome table there is a dead-letter view
 * (`DbClient.getUnpublishedDashboardOutcomes`) and this function re-sends
 * those events.
 *
 * Operationally read-only with respect to the customer path: it only reads the
 * dead-letter rows and re-issues the Dashboard HTTP request. A replayed event
 * is marked so it is not replayed twice.
 *
 * @param publisher - The publisher instance to use (defaults to the shared one).
 * @param limit - Maximum events to replay in this pass.
 * @returns Per-event replay results.
 */
export async function replayUnpublishedDashboardEvents(
  publisher: CstDashboardPublisher,
  limit = 50
): Promise<
  Array<{ event_id: string; success: boolean; status?: number; error?: string }>
> {
  const outcomes = await DbClient.getUnpublishedDashboardOutcomes(limit);
  const results: Array<{
    event_id: string;
    success: boolean;
    status?: number;
    error?: string;
  }> = [];

  for (const outcome of outcomes) {
    if (!outcome.payload) {
      // Nothing to replay from — record the attempt so it stops resurfacing.
      await DbClient.markDashboardOutcomeReplayed(outcome.id!);
      results.push({
        event_id: outcome.event_id,
        success: false,
        error: 'NO_PAYLOAD',
      });
      continue;
    }

    try {
      const result = await publisher.publish(outcome.payload);
      if (result.success) {
        await DbClient.markDashboardOutcomeReplayed(outcome.id!);
      }
      results.push({
        event_id: outcome.event_id,
        success: result.success,
        status: result.status,
        error: result.error,
      });
    } catch (err: any) {
      results.push({
        event_id: outcome.event_id,
        success: false,
        error: err?.message || 'REPLAY_ERROR',
      });
    }
  }

  return results;
}
