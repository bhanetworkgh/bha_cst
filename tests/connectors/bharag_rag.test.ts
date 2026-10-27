import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BharagRagConnector } from '../../engine/src/connectors/bharag_rag.js';
import { getEnv } from '../../engine/src/config/env.js';
import { Logger } from '../../engine/src/config/logger.js';

describe('BharagRagConnector Tests', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends POST request to BHARAG_CLUSTER_URL with contextualized query, workspaceKey, and x-api-key header', async () => {
    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      capturedUrl = url.toString();
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ answer: 'Cluster RAG Answer: Irrigation rules are site-specific [1] [2].' }),
      } as Response;
    });

    const env = getEnv();
    const result = await BharagRagConnector.askKnowledge('What are the irrigation rules across our sites?');

    expect(capturedUrl).toBe(env.BHARAG_CLUSTER_URL);
    expect(capturedOptions.method).toBe('POST');
    expect(capturedOptions.headers['Content-Type']).toBe('application/json');
    expect(capturedOptions.headers['x-api-key']).toBe(env.BHARAG_CLUSTER_KEY);
    expect(JSON.parse(capturedOptions.body)).toEqual({
      query: 'vFarm: What are the irrigation rules across our sites?',
      workspaceKey: env.BHARAG_WORKSPACE_KEY,
      workspace: 'vfarm',
    });
    // Verifies bracketed citations like [1] [2] are stripped for clean SMS delivery
    expect(result).toBe('Cluster RAG Answer: Irrigation rules are site-specific.');
  });

  it('does not double-prefix query when vFarm is already present in question', async () => {
    let capturedOptions: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string | URL | Request, options?: RequestInit) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ answer: 'vFarm optimal pH is 5.8-6.5.' }),
      } as Response;
    });

    await BharagRagConnector.askKnowledge('What is the recommended vFarm pH level?');
    expect(JSON.parse(capturedOptions.body).query).toBe('What is the recommended vFarm pH level?');
  });

  it('never attributes its static fallback knowledge to BHARAG when the cluster has no context', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({
          answer: "I don't have enough information to answer this question based on the available documents.",
          confidence: 0.25,
          has_context: false,
        }),
      } as Response;
    });

    const result = await BharagRagConnector.askKnowledge('How do I clean the filter?');
    // Degraded fallback: explicitly labelled as CST guidance, NOT BHARAG output.
    expect(result).not.toContain('BHARAG Knowledge:');
    expect(result).toContain('BHARAG knowledge base is unavailable');
    expect(result).toContain('not a verified answer');
  });

  it('uses the labelled static fallback when the cluster endpoint is unavailable and emits Logger.infra', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network connection timeout'));

    const result = await BharagRagConnector.askKnowledge('What are the irrigation rules across our sites?');
    expect(result).toContain('BHARAG knowledge base is unavailable');
    expect(result).toContain('vFarm support');

    expect(infraSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/BHARAG cluster knowledge API (error|timeout)/),
        commercial_impact: expect.stringContaining('Customer cannot receive verified knowledge answers'),
      })
    );
  });

  it('does not fabricate a site-specific procedure when the cluster is offline', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    // Regression: the old fallback asserted specific operating values
    // ("re-tighten to 5 Nm", "pH 5.8 - 6.5", "18h ON / 6h OFF") that were
    // presented as BHARAG knowledge but were invented in this file.
    const filter = await BharagRagConnector.askKnowledge('How do I clean the filter?');
    expect(filter).not.toContain('5 Nm');
    expect(filter).not.toContain('BHARAG Knowledge:');

    const ph = await BharagRagConnector.askKnowledge('What is the right pH balance?');
    expect(ph).not.toContain('5.8');
    expect(ph).not.toContain('BHARAG Knowledge:');

    const light = await BharagRagConnector.askKnowledge('What is the light cycle?');
    expect(light).not.toContain('18 hours');
    expect(light).not.toContain('BHARAG Knowledge:');
  });

  it('labels the generic (no-keyword) fallback as unverified too', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await BharagRagConnector.askKnowledge('Do you have a policy about compliance paperwork?');
    expect(result).toContain('BHARAG knowledge base is unavailable');
    expect(result).not.toContain('BHARAG Knowledge:');
  });

  it('includes workspaceKey and workspace in cluster API payload, but NOT farm_id/unit_id (KMG9)', async () => {
    let capturedOptions: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string | URL | Request, options?: RequestInit) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ answer: 'Cluster RAG Answer with unit context.' }),
      } as Response;
    });

    await BharagRagConnector.askKnowledge(
      'What are the optimal settings?',
      'ws_key_test_123',
      { farm_id: 'farm_austin_main', unit_id: 'unit_bay_04' }
    );

    // KMG9: farm_id and unit_id intentionally omitted — upstream must enforce
    // workspace isolation via workspaceKey. CST cannot assume these fields
    // filter results unless the BHARAG API contract explicitly confirms it.
    const payload = JSON.parse(capturedOptions.body);
    expect(payload).toEqual({
      query: 'vFarm: What are the optimal settings?',
      workspaceKey: 'ws_key_test_123',
      workspace: 'vfarm',
    });
    expect(payload).not.toHaveProperty('farm_id');
    expect(payload).not.toHaveProperty('unit_id');
  });

  it('logs structured request start and successful response with elapsed time', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    const infoSpy = vi.spyOn(Logger, 'info');
    let capturedOptions: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string | URL | Request, options?: RequestInit) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ answer: 'Help answer about cleaning filters.' }),
      } as Response;
    });

    await BharagRagConnector.askKnowledge('How do I clean the filter?');

    // Request start logged — never raw customer speech, only category
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Querying cluster knowledge using cluster endpoint'),
      expect.objectContaining({ query_category: 'filter_maintenance' })
    );
    // Successful answer logged — no raw query text
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Knowledge answer received'),
      expect.objectContaining({ answer_present: true, answer_length: expect.any(Number), query_category: 'filter_maintenance' })
    );
  });

  it('logs empty result from BHARAG and falls back safely', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    const infoSpy = vi.spyOn(Logger, 'info');

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: '', confidence: 0.1, has_context: false }),
      } as Response;
    });

    const result = await BharagRagConnector.askKnowledge('What is the meaning of life?');

    // Answer absent → insufficient → fallback
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Knowledge answer absent or insufficient'),
      expect.objectContaining({ answer_present: false, elapsedMs: expect.any(Number) })
    );
    expect(result).toContain('BHARAG knowledge base is unavailable');
    expect(result).not.toContain('BHARAG Knowledge:');
  });

  it('logs HTTP error status and falls back safely', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    const warnSpy = vi.spyOn(Logger, 'warn');

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
      } as Response;
    });

    const result = await BharagRagConnector.askKnowledge('What are the irrigation rules?');

    // HTTP error logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BHARAG Cluster API returned non-OK status: 503')
    );
    // Infra log with status
    expect(infraSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('BHARAG cluster knowledge API error: HTTP 503'),
        meta: expect.objectContaining({ status: 503 })
      })
    );
    expect(result).toContain('BHARAG knowledge base is unavailable');
  });

  it('logs timeout and falls back safely', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    const warnSpy = vi.spyOn(Logger, 'warn');

    globalThis.fetch = vi.fn().mockImplementation(() => {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error('fetch operation timed out')), 50);
      });
    });

    const result = await BharagRagConnector.askKnowledge('How do I calibrate the sensor?');

    // Timeout logged (message may say 'error' or 'timeout' depending on error classification)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/BHARAG Cluster API call (error|timeout):/),
      expect.objectContaining({ elapsedMs: expect.any(Number) })
    );
    expect(infraSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/BHARAG cluster knowledge API (error|timeout)/),
      })
    );
    expect(result).toContain('BHARAG knowledge base is unavailable');
  });

  it('logs malformed response (parse failure) and falls back safely', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => {
          throw new Error('Unexpected token in JSON');
        },
      } as Response;
    });

    const result = await BharagRagConnector.askKnowledge('What are the irrigation rules?');

    // Parse failure logged via infra
    expect(infraSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('BHARAG cluster knowledge API parse failure'),
        meta: expect.objectContaining({ parse_error: expect.stringContaining('Unexpected token in JSON') })
      })
    );
    expect(result).toContain('BHARAG knowledge base is unavailable');
  });

  it('does not log the raw x-api-key or cluster key value anywhere', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    const infoSpy = vi.spyOn(Logger, 'info');
    const warnSpy = vi.spyOn(Logger, 'warn');

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'Test answer' }),
      } as Response;
    });

    await BharagRagConnector.askKnowledge('test query', 'secret_workspace_key_12345');

    const allLogArgs = [
      ...infoSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...infraSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...warnSpy.mock.calls.map((c) => JSON.stringify(c)),
    ].join(' ');

    // Full key must never appear in logs
    expect(allLogArgs).not.toContain('secret_workspace_key_12345');
    // Only masked form may appear
    expect(allLogArgs).toContain('se***45');
  });

  it('masks short workspace keys so they cannot be reconstructed', async () => {
    const infoSpy = vi.spyOn(Logger, 'info');
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'Test answer' }),
      } as Response;
    });

    await BharagRagConnector.askKnowledge('test', 'abcd'); // 4 chars
    await BharagRagConnector.askKnowledge('test', 'abcde'); // 5 chars
    await BharagRagConnector.askKnowledge('test', 'abcdefgh'); // 8 chars

    const allLogArgs = infoSpy.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    // No partial key material may leak
    expect(allLogArgs).not.toContain('abcd');
    expect(allLogArgs).not.toContain('abcde');
    expect(allLogArgs).not.toContain('abcdefgh');
    expect(allLogArgs).toContain('***');
  });

  it('handles empty workspace key without logging raw value', async () => {
    const infoSpy = vi.spyOn(Logger, 'info');
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'Test answer' }),
      } as Response;
    });

    await BharagRagConnector.askKnowledge('test');

    const allLogArgs = infoSpy.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(allLogArgs).not.toContain('undefined');
  });

  it('never logs raw customer query text in any log call', async () => {
    const infoSpy = vi.spyOn(Logger, 'info');
    const infraSpy = vi.spyOn(Logger, 'infra');
    const warnSpy = vi.spyOn(Logger, 'warn');
    const sensitiveQuery = 'SSN: 123-45-6789, phone: +1-555-000-9999, credit card: 4111-1111-1111-1111';

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ answer: 'Help answer' }),
      } as Response;
    });

    await BharagRagConnector.askKnowledge(sensitiveQuery);

    const allLogArgs = [
      ...infoSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...infraSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...warnSpy.mock.calls.map((c) => JSON.stringify(c)),
    ].join(' ');

    // No part of the sensitive customer data may appear in logs
    expect(allLogArgs).not.toContain('123-45-6789');
    expect(allLogArgs).not.toContain('555-000-9999');
    expect(allLogArgs).not.toContain('4111-1111-1111-1111');
    expect(allLogArgs).not.toContain(sensitiveQuery);
    // Only query category should appear
    expect(allLogArgs).toContain('query_category');
  });

  it('does not log exception messages containing credentials', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to connect to https://bhaharag.internal:443 with token sk_live_abc123xyz'));

    const result = await BharagRagConnector.askKnowledge('test query');

    expect(result).toContain('BHARAG knowledge base is unavailable');

    const allLogArgs = infraSpy.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    // Full token must not appear in infra logs
    expect(allLogArgs).not.toContain('sk_live_abc123xyz');
    // The error message in meta is redacted via maskKey but error field could contain creds
    // Verify error.message containing token isn't directly logged as-is
    expect(allLogArgs).not.toContain('sk_live_abc123xyz');
  });
});