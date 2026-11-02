import { describe, expect, it } from 'vitest';
import { getResearchTwinConfigStatus } from '../../engine/src/research_twin/config.js';

describe('Research Twin configuration boundary', () => {
  it('reports unavailable without exposing secret values', () => {
    const result = getResearchTwinConfigStatus({ NODE_ENV: 'production' });
    expect(result.state).toBe('unavailable');
    expect(result.operational).toBe(false);
    expect(result.contract).toBe('unverified');
    expect(result.missing).toEqual([
      'RT_ENDPOINT_URL',
      'RT_SERVICE_API_KEY',
      'RT_CALLBACK_SIGNING_SECRET',
    ]);
    expect(JSON.stringify(result)).not.toContain('redacted-test-secret');
  });

  it('keeps candidate credentials blocked until the contract is approved', () => {
    const result = getResearchTwinConfigStatus({
      RT_ENDPOINT_URL: 'https://candidate.example.test/webhook/research-twin',
      RT_SERVICE_API_KEY: 'redacted-test-key',
      RT_CALLBACK_SIGNING_SECRET: 'redacted-test-secret',
    });
    expect(result.state).toBe('blocked');
    expect(result.operational).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.reason).toContain('contract is not verified');
  });
});
