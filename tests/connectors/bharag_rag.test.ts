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
        message: expect.stringContaining('BHARAG cluster knowledge API error'),
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

