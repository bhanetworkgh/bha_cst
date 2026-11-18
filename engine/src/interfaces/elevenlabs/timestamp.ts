/**
 * ElevenLabs call timestamp normalization and provenance tracking.
 *
 * Implements strict semantics for call-start and lifecycle timestamps:
 * 1. Prefers the actual provider call-start timestamp (start_time_unix_secs).
 * 2. Uses only documented fallback fields (event_timestamp or receipt time) when call-start is missing/invalid.
 * 3. Never silently substitutes receipt time or event generation time without explicit provenance metadata.
 * 4. Preserves original provider values, selected source, and unavailability status.
 * 5. Guarantees ISO-8601 UTC representation (ending in Z).
 */

export type TimestampSource =
  | 'provider_call_start'
  | 'fallback_provider_event'
  | 'fallback_receipt_time';

export interface CallStartTimestampResolution {
  /** Resolved ISO-8601 UTC timestamp (e.g. 2026-11-04T18:34:37.000Z) */
  iso: string;
  /** Unix epoch seconds */
  unix_secs: number;
  /** Exact source identifying where the timestamp originated */
  source: TimestampSource;
  /** True when provider call-start was absent or invalid, requiring a fallback */
  is_fallback: boolean;
  /** True when the actual call-start time was unavailable from provider */
  start_time_unavailable: boolean;
  /** Explicitly marks timestamp as unverified when not directly from provider call-start */
  timestamp_unverified: boolean;
  /** Original raw provider start time value, if supplied */
  raw_provider_start_time: unknown;
  /** Original raw provider event timestamp value, if supplied */
  raw_provider_event_timestamp: unknown;
}

const MIN_VALID_EPOCH_SECS = 946684800; // 2000-01-01T00:00:00Z
const MAX_VALID_EPOCH_SECS = 253402300799; // 9999-12-31T23:59:59Z

/**
 * Validates whether a value is a semantically valid unix epoch timestamp in seconds.
 */
export function isValidUnixSeconds(val: unknown): val is number {
  if (typeof val !== 'number') return false;
  if (!Number.isFinite(val) || Number.isNaN(val)) return false;
  return val >= MIN_VALID_EPOCH_SECS && val <= MAX_VALID_EPOCH_SECS;
}

/**
 * Normalizes a number that may be in milliseconds (e.g. > 1e11) to seconds.
 */
function normalizeToSeconds(val: number): number {
  return val > 1e11 ? Math.floor(val / 1000) : Math.floor(val);
}

/**
 * Resolve the interaction start timestamp from an ElevenLabs post-call payload with strict provenance.
 */
export function resolveCallStartTimestamp(
  payload: {
    start_time_unix_secs?: unknown;
    event_timestamp?: unknown;
    data?: {
      start_time_unix_secs?: unknown;
    };
  },
  receiptDate: Date = new Date()
): CallStartTimestampResolution {
  const rawStart = payload.data?.start_time_unix_secs ?? payload.start_time_unix_secs;
  const rawEvent = payload.event_timestamp;

  // 1. Attempt provider call-start timestamp
  if (typeof rawStart === 'number') {
    const startSecs = normalizeToSeconds(rawStart);
    if (isValidUnixSeconds(startSecs)) {
      return {
        iso: new Date(startSecs * 1000).toISOString(),
        unix_secs: startSecs,
        source: 'provider_call_start',
        is_fallback: false,
        start_time_unavailable: false,
        timestamp_unverified: false,
        raw_provider_start_time: rawStart,
        raw_provider_event_timestamp: rawEvent,
      };
    }
  }

  // 2. Fallback to provider event generation timestamp if present and valid
  if (typeof rawEvent === 'number') {
    const eventSecs = normalizeToSeconds(rawEvent);
    if (isValidUnixSeconds(eventSecs)) {
      return {
        iso: new Date(eventSecs * 1000).toISOString(),
        unix_secs: eventSecs,
        source: 'fallback_provider_event',
        is_fallback: true,
        start_time_unavailable: true,
        timestamp_unverified: true,
        raw_provider_start_time: rawStart,
        raw_provider_event_timestamp: rawEvent,
      };
    }
  }

  // 3. Fallback to webhook receipt time
  const receiptSecs = Math.floor(receiptDate.getTime() / 1000);
  return {
    iso: receiptDate.toISOString(),
    unix_secs: receiptSecs,
    source: 'fallback_receipt_time',
    is_fallback: true,
    start_time_unavailable: true,
    timestamp_unverified: true,
    raw_provider_start_time: rawStart,
    raw_provider_event_timestamp: rawEvent,
  };
}

