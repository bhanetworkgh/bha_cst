import { Logger } from '../config/logger.js';
import {
  type ProvisionalResearchTwinTransport,
  type ResearchTwinInvestigationRequest,
  ResearchTwinTransportError,
} from './lifecycle.js';
import {
  ResearchTwinOutboundPayloadSchema,
  ResearchTwinSuccessResponseSchema,
  type ResearchTwinOutboundPayload,
} from './schemas.js';
import { classifyResearchTwinError, ResearchTwinHttpError } from './errors.js';

export interface ResearchTwinClientOptions {
  endpointUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Concrete HTTP transport client for Research Twin integrations.
 *
 * Implements ProvisionalResearchTwinTransport to dispatch investigations
 * to the upstream RT_ENDPOINT_URL using the RT_SERVICE_API_KEY.
 */
export class ResearchTwinClient implements ProvisionalResearchTwinTransport {
  private readonly endpointUrl?: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: ResearchTwinClientOptions = {}) {
    this.endpointUrl = (options.endpointUrl ?? process.env.RT_ENDPOINT_URL)?.trim();
    this.apiKey = (options.apiKey ?? process.env.RT_SERVICE_API_KEY)?.trim();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Dispatch an investigation request to Research Twin.
   */
  async createInvestigation(
    request: ResearchTwinInvestigationRequest,
  ): Promise<{ investigation_id: string }> {
    // 1. Validate outbound payload against canonical schema
    let outboundPayload: ResearchTwinOutboundPayload;
    try {
      outboundPayload = ResearchTwinOutboundPayloadSchema.parse(request);
    } catch (validationErr: any) {
      Logger.error('Research Twin outbound payload schema validation failed', {
        error: validationErr.message,
        issues: validationErr.issues,
      });
      throw new ResearchTwinTransportError('invalid_payload', false);
    }

    // 2. Validate endpoint URL
    if (!this.endpointUrl) {
      Logger.warn('Research Twin transport rejected: RT_ENDPOINT_URL is not configured');
      throw new ResearchTwinTransportError('endpoint_not_configured', false);
    }

    // 3. Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Correlation-ID': outboundPayload.correlation_id,
      'X-Tenant-ID': outboundPayload.tenant_id,
      'User-Agent': 'bha-cst/1.0.0',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      headers['X-Service-Key'] = this.apiKey;
    }

    // 4. Send HTTP request with timeout
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(this.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(outboundPayload),
        signal: controller.signal,
      });
    } catch (networkErr: any) {
      clearTimeout(timeoutHandle);
      if (networkErr.name === 'AbortError' || networkErr.code === 20) {
        throw new ResearchTwinHttpError(
          504,
          'network_timeout',
          true,
          `Request to Research Twin timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new ResearchTwinHttpError(
        502,
        'connection_error',
        true,
        `Network connection to Research Twin failed: ${networkErr.message}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    // 5. Read response body
    let rawText = '';
    let parsedBody: unknown = null;
    try {
      rawText = await response.text();
      if (rawText.trim().length > 0) {
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          parsedBody = rawText;
        }
      }
    } catch (readErr: any) {
      Logger.warn('Failed to read response body from Research Twin', { error: readErr.message });
    }

    // 6. Handle HTTP errors
    if (!response.ok) {
      const errorInfo = classifyResearchTwinError(response.status, parsedBody, response.headers);
      Logger.warn(
        `Research Twin HTTP request failed: ${response.status} [${errorInfo.code}]: ${errorInfo.message}`,
        {
          status: response.status,
          code: errorInfo.code,
          retryable: errorInfo.retryable,
          retryAfterMs: errorInfo.retryAfterMs,
        },
      );

      throw new ResearchTwinHttpError(
        response.status,
        errorInfo.code,
        errorInfo.retryable,
        errorInfo.message,
        parsedBody,
        errorInfo.details,
        errorInfo.retryAfterMs,
      );
    }

    // 7. Parse and validate success response schema
    const parseResult = ResearchTwinSuccessResponseSchema.safeParse(parsedBody);
    if (!parseResult.success) {
      Logger.error('Research Twin returned 2xx but payload lacked valid investigation_id', {
        parsedBody,
        issues: parseResult.error.issues,
      });
      throw new ResearchTwinHttpError(
        response.status,
        'invalid_creation_response',
        false,
        'Research Twin 2xx response did not contain a valid investigation_id',
        parsedBody,
      );
    }

    return {
      investigation_id: parseResult.data.investigation_id,
    };
  }
}

