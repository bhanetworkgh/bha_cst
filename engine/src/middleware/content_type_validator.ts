import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Logger } from '../config/logger.js';

export interface JsonContentTypeOptions {
  /** Route paths or suffixes where empty-body POST/PUT/PATCH is allowed without Content-Type (e.g. logout) */
  allowEmptyBodyRoutes?: string[];
}

/**
 * Checks whether the incoming request has a body payload.
 */
function hasRequestBody(req: Request): boolean {
  if (req.headers['transfer-encoding'] === 'chunked') {
    return true;
  }
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    const parsed = parseInt(contentLength as string, 10);
    return !Number.isNaN(parsed) && parsed > 0;
  }
  return false;
}

/**
 * Validates that incoming mutation requests (POST, PUT, PATCH) to JSON endpoints
 * declare an acceptable JSON Content-Type (application/json or compatible media type).
 *
 * Requests with missing or unsupported Content-Type headers are rejected with 415 (Unsupported Media Type)
 * and recorded in the security audit ledger.
 */
export function validateJsonContentType(options: JsonContentTypeOptions = {}) {
  const allowEmptyBodyRoutes = options.allowEmptyBodyRoutes || ['/logout', '/api/v1/web/logout'];

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only enforce on mutation methods
    const method = req.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return next();
    }

    const path = req.path || req.originalUrl || '';
    const isAllowlisted = allowEmptyBodyRoutes.some((route) => path === route || path.endsWith(route));
    const hasBody = hasRequestBody(req);

    // If endpoint allows empty body and no body was provided, permit through
    if (isAllowlisted && !hasBody) {
      return next();
    }

    const contentType = req.headers['content-type'];
    const correlationId =
      (req.headers['x-correlation-id'] as string) ||
      (req.headers['x-request-id'] as string) ||
      `cst_${randomUUID()}`;

    // 1. Missing Content-Type
    if (!contentType || !contentType.trim()) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: null,
        actor: 'anonymous',
        role: 'unknown',
        entry_point: 'api',
        tool_or_route: path,
        outcome: 'refused',
        reason: 'MISSING_CONTENT_TYPE',
        commercial_impact: 'Request rejected due to missing Content-Type header on JSON endpoint',
        correlation_id: correlationId,
        details: {
          service: 'cst',
          environment: process.env.NODE_ENV || 'development',
          component: 'content_type_validator',
          event_name: 'request_rejected',
          event_type: 'security_audit',
          route: path,
          method: req.method,
          http_status: 400,
          error_code: 'UNSUPPORTED_MEDIA_TYPE',
          failure_stage: 'pre_route_media_validation',
          classification: 'client_protocol_error',
          source_system: 'cst_gateway',
        },
      });

      res.setHeader('X-Correlation-ID', correlationId);
      res.status(400).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be application/json',
        correlation_id: correlationId,
      });
      return;
    }

    // 2. Check JSON media type compatibility
    const isJson =
      req.is('application/json') ||
      req.is('json') ||
      contentType.toLowerCase().includes('application/json') ||
      contentType.toLowerCase().includes('+json');

    if (!isJson) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: null,
        actor: 'anonymous',
        role: 'unknown',
        entry_point: 'api',
        tool_or_route: path,
        outcome: 'refused',
        reason: 'UNSUPPORTED_CONTENT_TYPE',
        commercial_impact: `Request rejected due to unsupported Content-Type "${contentType}" on JSON endpoint`,
        correlation_id: correlationId,
        details: {
          service: 'cst',
          environment: process.env.NODE_ENV || 'development',
          component: 'content_type_validator',
          event_name: 'request_rejected',
          event_type: 'security_audit',
          route: path,
          method: req.method,
          http_status: 400,
          error_code: 'UNSUPPORTED_MEDIA_TYPE',
          failure_stage: 'pre_route_media_validation',
          classification: 'client_protocol_error',
          source_system: 'cst_gateway',
          content_type: contentType,
        },
      });

      res.setHeader('X-Correlation-ID', correlationId);
      res.status(400).json({
        error: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be application/json',
        correlation_id: correlationId,
      });
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
