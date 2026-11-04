import { ResearchTwinTransportError } from './lifecycle.js';
import { ResearchTwinErrorResponseSchema, type ResearchTwinErrorResponse } from './schemas.js';

export interface ClassifiedErrorInfo {
  code: string;
  retryable: boolean;
  message: string;
  details?: unknown;
  retryAfterMs?: number;
}

/**
 * Enhanced error class for Research Twin HTTP communications.
 * Extends ResearchTwinTransportError to guarantee 100% compatibility with
 * ProvisionalResearchTwinLifecycle's retry and state machine boundaries.
 */
export class ResearchTwinHttpError extends ResearchTwinTransportError {
  public readonly statusCode: number;
  public readonly responseBody: unknown;
  public readonly details?: unknown;
  public readonly retryAfterMs?: number;

  constructor(
    statusCode: number,
    code: string,
    retryable: boolean,
    message: string,
    responseBody?: unknown,
    details?: unknown,
    retryAfterMs?: number,
  ) {
    super(code, retryable);
    this.name = 'ResearchTwinHttpError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
    this.message = `Research Twin HTTP ${statusCode} [${code}]: ${message}`;
  }
}

/**
 * Parse Retry-After header value into milliseconds.
 * Supports decimal seconds (e.g. "30") or HTTP-Date (RFC 7231).
 */
export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue || typeof headerValue !== 'string') return undefined;
  const trimmed = headerValue.trim();
  const seconds = parseFloat(trimmed);
  if (!isNaN(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

/**
 * Inspect status code, raw body, and headers from Research Twin to produce
 * a deterministic classification of the failure.
 */
export function classifyResearchTwinError(
  statusCode: number,
  rawBody: unknown,
  headers?: Record<string, string | string[] | undefined> | Headers,
): ClassifiedErrorInfo {
  let parsedError: ResearchTwinErrorResponse | null = null;
  if (typeof rawBody === 'object' && rawBody !== null) {
    const safeParsed = ResearchTwinErrorResponseSchema.safeParse(rawBody);
    if (safeParsed.success) {
      parsedError = safeParsed.data;
    }
  }

  // Extract human-readable error text
  const messageFromPayload =
    parsedError?.message ||
    parsedError?.errorMessage ||
    parsedError?.detail ||
    (typeof parsedError?.error === 'string' ? parsedError.error : undefined) ||
    (typeof rawBody === 'string' && rawBody.trim().length > 0 ? rawBody.trim() : undefined) ||
    'Unknown upstream Research Twin error';

  const detailsFromPayload = parsedError?.details ?? parsedError?.detail;

  // Extract Retry-After header if present
  let retryAfterHeader: string | null = null;
  if (headers) {
    if (typeof (headers as Headers).get === 'function') {
      retryAfterHeader = (headers as Headers).get('retry-after');
    } else {
      const rawHeader = (headers as Record<string, string | string[] | undefined>)['retry-after'];
      retryAfterHeader = Array.isArray(rawHeader) ? rawHeader[0] : (rawHeader ?? null);
    }
  }

  let retryAfterMs = parseRetryAfter(retryAfterHeader);
  if (retryAfterMs === undefined && typeof parsedError?.retry_after_seconds === 'number') {
    retryAfterMs = Math.round(parsedError.retry_after_seconds * 1000);
  }

  // 1. Explicit retryable flag from Research Twin error payload takes precedence if given
  let retryable = parsedError?.retryable;

  let code: string;

  switch (statusCode) {
    case 400:
      code = 'invalid_payload';
      retryable = retryable ?? false;
      break;
    case 401:
      code = 'unauthorized';
      retryable = retryable ?? false;
      break;
    case 403:
      code = 'forbidden';
      retryable = retryable ?? false;
      break;
    case 404:
      code = 'endpoint_not_found';
      retryable = retryable ?? false;
      break;
    case 409:
      code = 'duplicate_conflict';
      retryable = retryable ?? false;
      break;
    case 422:
      code = 'unprocessable_entity';
      retryable = retryable ?? false;
      break;
    case 429:
      code = 'rate_limited';
      retryable = retryable ?? true;
      break;
    case 500:
      code = 'upstream_internal_error';
      retryable = retryable ?? true;
      break;
    case 502:
      code = 'upstream_unavailable';
      retryable = retryable ?? true;
      break;
    case 503:
      code = 'upstream_unavailable';
      retryable = retryable ?? true;
      break;
    case 504:
      code = 'upstream_timeout';
      retryable = retryable ?? true;
      break;
    default:
      if (statusCode >= 400 && statusCode < 500) {
        code = 'client_error';
        retryable = retryable ?? false;
      } else if (statusCode >= 500) {
        code = 'server_error';
        retryable = retryable ?? true;
      } else {
        code = 'unexpected_http_status';
        retryable = retryable ?? false;
      }
      break;
  }

  // If payload provided custom error code, preserve it when helpful
  if (parsedError?.errorCode) {
    code = parsedError.errorCode;
  } else if (typeof parsedError?.code === 'string' && isNaN(Number(parsedError.code))) {
    code = parsedError.code;
  }

  return {
    code,
    retryable,
    message: messageFromPayload,
    details: detailsFromPayload,
    retryAfterMs,
  };
}

