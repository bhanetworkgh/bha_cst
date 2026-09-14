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

  it('falls back to domain knowledge when cluster returns uninformative lack-of-context response', async () => {
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
    // Triggers domain fallback knowledge instead of forwarding unhelpful message
    expect(result).toContain('BHARAG Knowledge: To clean the vFarm nutrient filter');
  });

  it('uses domain knowledge fallback when cluster endpoint is unavailable and emits Logger.infra', async () => {
    const infraSpy = vi.spyOn(Logger, 'infra');
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network connection timeout'));

    const result = await BharagRagConnector.askKnowledge('What are the irrigation rules across our sites?');
    expect(result).toContain('BHARAG Knowledge: Irrigation rules vary by crop type');

    expect(infraSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('BHARAG cluster knowledge API error'),
        commercial_impact: expect.stringContaining('Customer cannot receive verified knowledge answers'),
      })
    );
  });

  it('uses domain knowledge fallback for filter cleaning questions when cluster is offline', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await BharagRagConnector.askKnowledge('How do I clean the filter?');
    expect(result).toContain('BHARAG Knowledge: To clean the vFarm nutrient filter');
  });

  it('includes workspaceKey, farm_id, and unit_id in cluster API payload when provided', async () => {
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

    expect(JSON.parse(capturedOptions.body)).toEqual({
      query: 'vFarm: What are the optimal settings?',
      workspaceKey: 'ws_key_test_123',
      workspace: 'vfarm',
      farm_id: 'farm_austin_main',
      unit_id: 'unit_bay_04',
    });
  });
});

