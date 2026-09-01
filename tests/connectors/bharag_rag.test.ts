import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BharagRagConnector } from '../../engine/src/connectors/bharag_rag.js';
import { getEnv } from '../../engine/src/config/env.js';

describe('BharagRagConnector Tests', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends POST request to BHARAG_CLUSTER_URL with { query: question } and x-api-key header', async () => {
    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, options?: RequestInit) => {
      capturedUrl = url.toString();
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ answer: 'Cluster RAG Answer: Irrigation rules are site-specific.' }),
      } as Response;
    });

    const env = getEnv();
    const result = await BharagRagConnector.askKnowledge('What are the irrigation rules across our sites?');

    expect(capturedUrl).toBe(env.BHARAG_CLUSTER_URL);
    expect(capturedOptions.method).toBe('POST');
    expect(capturedOptions.headers['Content-Type']).toBe('application/json');
    expect(capturedOptions.headers['x-api-key']).toBe(env.BHARAG_CLUSTER_KEY);
    expect(JSON.parse(capturedOptions.body)).toEqual({
      query: 'What are the irrigation rules across our sites?',
    });
    expect(result).toBe('Cluster RAG Answer: Irrigation rules are site-specific.');
  });

  it('uses domain knowledge fallback when cluster endpoint is unavailable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await BharagRagConnector.askKnowledge('What are the irrigation rules across our sites?');
    expect(result).toContain('BHARAG Knowledge: Irrigation rules vary by crop type');
  });

  it('uses domain knowledge fallback for filter cleaning questions when cluster is offline', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await BharagRagConnector.askKnowledge('How do I clean the filter?');
    expect(result).toContain('BHARAG Knowledge: To clean the vFarm nutrient filter');
  });
});
