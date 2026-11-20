import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Logger } from '../config/logger.js';

export type ExpectedMediaType = 'json' | 'form' | 'voice_webhook' | 'any';

export interface ContentTypePolicyRule {
  prefix: string;
  expected: ExpectedMediaType;
  allowEmptyBody?: boolean;
  description: string;
}

/**
 * Route-to-Content-Type Policy Matrix for CST (LOOP-1795035800169-NVLF).
 * Defines the authoritative expected media type for every route space.
 */
export const CONTENT_TYPE_POLICY: ContentTypePolicyRule[] = [
  // Allowlisted empty-body routes
  { prefix: '/api/v1/web/logout', expected: 'json', allowEmptyBody: true, description: 'Web session termination' },
  { prefix: '/api/v1/auth/logout', expected: 'json', allowEmptyBody: true, description: 'Admin session termination' },
  { prefix: '/logout', expected: 'json', allowEmptyBody: true, description: 'Generic session termination' },

  // Dedicated JSON Webhooks (evaluated before generic /webhooks)
  { prefix: '/webhooks/research-twin', expected: 'json', allowEmptyBody: false, description: 'Research Twin Callback Webhook' },
  { prefix: '/webhooks/elevenlabs', expected: 'json', allowEmptyBody: false, description: 'ElevenLabs Post-Call Webhook' },

  // Voice Webhooks (supports both Twilio Form and ElevenLabs / CloudEvents JSON)
  { prefix: '/webhooks/voice', expected: 'voice_webhook', allowEmptyBody: false, description: 'Voice Webhook Ingress (Form or JSON)' },

  // Twilio Form Webhooks
  { prefix: '/webhooks/twilio', expected: 'form', allowEmptyBody: false, description: 'Twilio SMS & Delivery Status Webhooks' },
  { prefix: '/webhooks', expected: 'form', allowEmptyBody: false, description: 'Twilio Webhooks Root (Form)' },
  { prefix: '/twilio', expected: 'form', allowEmptyBody: false, description: 'Twilio Alternate Path Webhooks' },

  // Core API & Admin Routes (Strict JSON)
  { prefix: '/api/v1', expected: 'json', allowEmptyBody: false, description: 'Core CST v1 JSON REST API' },
  { prefix: '/api', expected: 'json', allowEmptyBody: false, description: 'CST JSON API Surfaces' },
  { prefix: '/audio', expected: 'json', allowEmptyBody: false, description: 'Audio Synthesis Endpoint' },
  { prefix: '/voice', expected: 'json', allowEmptyBody: false, description: 'Programmatic Voice Endpoints' },
];

export interface JsonContentTypeOptions {
  /** Route paths or suffixes where empty-body POST/PUT/PATCH is allowed without Content-Type (e.g. logout) */
  allowEmptyBodyRoutes?: string[];
}

/**
 * Checks whether the incoming request carries a payload.
 */
export function hasRequestBody(req: Request): boolean {
  if (req.headers['transfer-encoding'] === 'chunked') {
    return true;
  }
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const parsed = parseInt(contentLength as string, 10);
    return !Number.isNaN(parsed) && parsed > 0;
  }
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') {
      return Object.keys(req.body).length > 0;
    }
    return String(req.body).length > 0;
  }
  return false;
}

/**
 * Parses Content-Type header into lowercased mediaType and optional charset.
 */
export function parseContentType(header: string | undefined): { mediaType: string; charset?: string } | null {
  if (!header || !header.trim()) {
    return null;
  }
  const parts = header.split(';').map((s) => s.trim());
  const mediaType = parts[0].toLowerCase();
  let charset: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const [rawK, rawV] = parts[i].split('=');
    if (rawK && rawV) {
      const k = rawK.trim().toLowerCase();
      const v = rawV.trim().toLowerCase().replace(/^["']|["']$/g, '');
      if (k === 'charset') {
        charset = v;
      }
    }
  }

  return { mediaType, charset };
}

/**
 * Resolves the route-to-content-type policy for a given request path.
 */
export function resolveRoutePolicy(path: string): ContentTypePolicyRule {
  const normalizedPath = path.toLowerCase();
  for (const rule of CONTENT_TYPE_POLICY) {
    if (normalizedPath === rule.prefix || normalizedPath.startsWith(rule.prefix)) {
      return rule;
    }
  }
  // Default to JSON for any unspecified API or webhook mutation
  if (normalizedPath.startsWith('/api') || normalizedPath.startsWith('/webhook')) {
    return { prefix: path, expected: 'json', allowEmptyBody: false, description: 'Default API JSON policy' };
  }
  return { prefix: path, expected: 'any', allowEmptyBody: true, description: 'Unrestricted route' };
}

/**
 * Formats and sends a structured security rejection response.
 */
function rejectRequest(
  req: Request,
  res: Response,
  status: number,
  error: string,
  message: string,
  reason: string,
  details: Record<string, any> = {}
): void {
  const path = req.path || req.originalUrl || '';
  const correlationId =
    (req.headers['x-correlation-id'] as string) ||
    (req.headers['x-request-id'] as string) ||
    `cst_${randomUUID()}`;

  Logger.audit({
    timestamp: new Date().toISOString(),
    tenant_id: null,
    actor: 'anonymous',
    role: 'unknown',
    entry_point: 'api',
    tool_or_route: path,
    outcome: 'refused',
    reason,
    commercial_impact: details.commercial_impact || `Request rejected due to protocol violation (${error}) on ${path}`,
    correlation_id: correlationId,
    details: {
      service: 'cst',
      environment: process.env.NODE_ENV || 'development',
      component: 'content_type_validator',
      event_name: 'request_rejected',
      event_type: 'security_audit',
      route: path,
      method: req.method,
      http_status: status,
      error_code: error,
      failure_stage: 'pre_route_media_validation',
      classification: 'client_protocol_error',
      source_system: 'cst_gateway',
      ...details,
    },
  });

  res.setHeader('X-Correlation-ID', correlationId);
  res.status(status).json({
    error,
    message,
    correlation_id: correlationId,
  });
}

/**
 * Pre-Route Content-Type Validation Middleware (Global, executes BEFORE body parsers).
 * Lifecycle: Incoming Request → Pre-Route Content-Type Validation → Body Parsing → Auth → Route
 */
export function createPreRouteContentTypeValidator() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    // Only enforce on mutative HTTP methods
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return next();
    }

    const path = req.path || req.originalUrl || '';
    const policy = resolveRoutePolicy(path);

    // If route allows empty body and no body was provided, pass through
    const hasBody = hasRequestBody(req);
    if (policy.allowEmptyBody && !hasBody) {
      return next();
    }

    const rawContentType = req.headers['content-type'];
    const parsed = parseContentType(rawContentType);

    // 1. Missing Content-Type check
    if (!parsed) {
      // If endpoint requires body or isn't allowlisted for empty body, reject
      rejectRequest(
        req,
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        policy.expected === 'form'
          ? 'Content-Type must be application/x-www-form-urlencoded'
          : 'Content-Type must be application/json',
        'MISSING_CONTENT_TYPE',
        {
          commercial_impact: `Request rejected due to missing Content-Type header on ${policy.expected.toUpperCase()} endpoint`,
          expected_media_type: policy.expected,
          content_type: null,
        }
      );
      return;
    }

    const { mediaType, charset } = parsed;

    // 2. Charset validation: UTF-8 is required when charset is specified
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      rejectRequest(
        req,
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported charset "${charset}". Only UTF-8 is supported.`,
        'UNSUPPORTED_CHARSET',
        {
          commercial_impact: `Request rejected due to unsupported charset "${charset}"`,
          charset,
          content_type: rawContentType,
        }
      );
      return;
    }

    // 3. Media Type conformance per policy rule
    if (policy.expected === 'json') {
      const isJson = mediaType === 'application/json' || mediaType.endsWith('+json');
      if (!isJson) {
        rejectRequest(
          req,
          res,
          400,
          'UNSUPPORTED_MEDIA_TYPE',
          'Content-Type must be application/json',
          'UNSUPPORTED_CONTENT_TYPE',
          {
            commercial_impact: `Request rejected due to unsupported Content-Type "${rawContentType}" on JSON endpoint`,
            content_type: rawContentType,
            expected: 'application/json',
          }
        );
        return;
      }
    } else if (policy.expected === 'form') {
      const isForm = mediaType === 'application/x-www-form-urlencoded';
      if (!isForm) {
        rejectRequest(
          req,
          res,
          400,
          'UNSUPPORTED_MEDIA_TYPE',
          'Content-Type must be application/x-www-form-urlencoded',
          'UNSUPPORTED_CONTENT_TYPE',
          {
            commercial_impact: `Request rejected due to unsupported Content-Type "${rawContentType}" on Form endpoint`,
            content_type: rawContentType,
            expected: 'application/x-www-form-urlencoded',
          }
        );
        return;
      }
    } else if (policy.expected === 'voice_webhook') {
      // Voice webhooks accept either Twilio Form or ElevenLabs / EventStreams JSON
      const isAccepted =
        mediaType === 'application/x-www-form-urlencoded' ||
        mediaType === 'application/json' ||
        mediaType.endsWith('+json');
      if (!isAccepted) {
        rejectRequest(
          req,
          res,
          400,
          'UNSUPPORTED_MEDIA_TYPE',
          'Content-Type must be application/x-www-form-urlencoded or application/json',
          'UNSUPPORTED_CONTENT_TYPE',
          {
            commercial_impact: `Request rejected due to unsupported Content-Type "${rawContentType}" on Voice Webhook endpoint`,
            content_type: rawContentType,
            expected: 'application/x-www-form-urlencoded or application/json',
          }
        );
        return;
      }
    }

    next();
  };
}

/**
 * Route-level JSON Content-Type validation middleware.
 * Provided for backwards compatibility and fine-grained router mounting.
 */
export function validateJsonContentType(options: JsonContentTypeOptions = {}) {
  const allowEmptyBodyRoutes = options.allowEmptyBodyRoutes || ['/logout', '/api/v1/web/logout', '/api/v1/auth/logout'];

  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return next();
    }

    const path = req.path || req.originalUrl || '';
    const isAllowlisted = allowEmptyBodyRoutes.some((route) => path === route || path.endsWith(route));
    const hasBody = hasRequestBody(req);

    if (isAllowlisted && !hasBody) {
      return next();
    }

    const rawContentType = req.headers['content-type'];
    const parsed = parseContentType(rawContentType);

    if (!parsed) {
      rejectRequest(
        req,
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be application/json',
        'MISSING_CONTENT_TYPE',
        {
          commercial_impact: 'Request rejected due to missing Content-Type header on JSON endpoint',
          content_type: null,
        }
      );
      return;
    }

    const { mediaType, charset } = parsed;
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      rejectRequest(
        req,
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        `Unsupported charset "${charset}". Only UTF-8 is supported.`,
        'UNSUPPORTED_CHARSET',
        {
          commercial_impact: `Request rejected due to unsupported charset "${charset}"`,
          charset,
          content_type: rawContentType,
        }
      );
      return;
    }

    const isJson = mediaType === 'application/json' || mediaType.endsWith('+json');
    if (!isJson) {
      rejectRequest(
        req,
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be application/json',
        'UNSUPPORTED_CONTENT_TYPE',
        {
          commercial_impact: `Request rejected due to unsupported Content-Type "${rawContentType}" on JSON endpoint`,
          content_type: rawContentType,
        }
      );
      return;
    }

    next();
  };
}

/**
 * Route-level Form Content-Type validation middleware.
 */
export function validateFormContentType() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return next();
    }

    const rawContentType = req.headers['content-type'];
    const parsed = parseContentType(rawContentType);

    if (!parsed || parsed.mediaType !== 'application/x-www-form-urlencoded') {
      rejectRequest(
        req,
        res,
        400,
        'UNSUPPORTED_MEDIA_TYPE',
        'Content-Type must be application/x-www-form-urlencoded',
        'UNSUPPORTED_CONTENT_TYPE',
        {
          commercial_impact: `Request rejected due to unsupported Content-Type "${rawContentType}" on Form endpoint`,
          content_type: rawContentType,
        }
      );
      return;
    }

    next();
  };
}

/**
 * Express error-handling middleware that catches JSON parsing SyntaxError from body-parser
 * and returns a structured 400 MALFORMED_JSON error envelope with correlation ID.
 */
export function handleJsonSyntaxError(err: any, req: Request, res: Response, next: NextFunction): void {
  const anyErr = err as any;
  if (
    err instanceof SyntaxError &&
    ('status' in err || 'statusCode' in err) &&
    (anyErr.status === 400 || anyErr.statusCode === 400) &&
    'body' in err
  ) {
    const correlationId =
      (req.headers['x-correlation-id'] as string) ||
      (req.headers['x-request-id'] as string) ||
      `malformed_${randomUUID()}`;

    Logger.warn(`Malformed JSON payload rejected on ${req.path}: ${err.message}`, {
      service: 'cst',
      environment: process.env.NODE_ENV || 'development',
      component: 'content_type_validator',
      event_name: 'malformed_json_rejected',
      event_type: 'protocol_error',
      correlation_id: correlationId,
      path: req.path,
      method: req.method,
      http_status: 400,
      error_code: 'MALFORMED_JSON',
      failure_stage: 'body_parsing',
      classification: 'client_syntax_error',
      source_system: 'cst_gateway',
    });

    res.setHeader('X-Correlation-ID', correlationId);
    res.status(400).json({
      error: 'MALFORMED_JSON',
      message: 'Request body contains invalid JSON',
      correlation_id: correlationId,
    });
    return;
  }
  next(err);
}

/**
 * Express error-handling middleware that catches body-parser 413 entity too large errors
 * and returns a structured 413 PAYLOAD_TOO_LARGE error envelope with correlation ID.
 */
export function handlePayloadTooLargeError(err: any, req: Request, res: Response, next: NextFunction): void {
  const anyErr = err as any;
  if (
    anyErr &&
    (anyErr.type === 'entity.too.large' || anyErr.status === 413 || anyErr.statusCode === 413)
  ) {
    const correlationId =
      (req.headers['x-correlation-id'] as string) ||
      (req.headers['x-request-id'] as string) ||
      `oversized_${randomUUID()}`;

    Logger.warn(`Oversized payload rejected on ${req.path}: ${err.message}`, {
      service: 'cst',
      environment: process.env.NODE_ENV || 'development',
      component: 'content_type_validator',
      event_name: 'payload_too_large',
      event_type: 'protocol_error',
      correlation_id: correlationId,
      path: req.path,
      method: req.method,
      http_status: 413,
      error_code: 'PAYLOAD_TOO_LARGE',
      failure_stage: 'body_parsing',
      classification: 'client_payload_error',
      source_system: 'cst_gateway',
    });

    res.setHeader('X-Correlation-ID', correlationId);
    res.status(413).json({
      error: 'PAYLOAD_TOO_LARGE',
      message: 'Request entity exceeds maximum allowable size limit',
      correlation_id: correlationId,
    });
    return;
  }
  next(err);
}
