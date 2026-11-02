/**
 * Research Twin configuration boundary.
 *
 * The supplied n8n URL is a candidate transport, not an approved Research
 * Twin API contract. This module reports a safe state only; it never sends a
 * request, guesses a payload, or accepts a callback before owner approval.
 */
export type ResearchTwinIntegrationState = 'unavailable' | 'blocked';

export interface ResearchTwinConfigStatus {
  state: ResearchTwinIntegrationState;
  operational: false;
  contract: 'unverified';
  endpoint_configured: boolean;
  service_api_key_configured: boolean;
  callback_signing_secret_configured: boolean;
  missing: string[];
  reason: string;
}

const REQUIRED = ['RT_ENDPOINT_URL', 'RT_SERVICE_API_KEY', 'RT_CALLBACK_SIGNING_SECRET'] as const;

/** Return configuration state without exposing secret values. */
export function getResearchTwinConfigStatus(env: NodeJS.ProcessEnv = process.env): ResearchTwinConfigStatus {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  const credentialsConfigured = missing.length === 0;

  return {
    state: credentialsConfigured ? 'blocked' : 'unavailable',
    operational: false,
    contract: 'unverified',
    endpoint_configured: Boolean(env.RT_ENDPOINT_URL?.trim()),
    service_api_key_configured: Boolean(env.RT_SERVICE_API_KEY?.trim()),
    callback_signing_secret_configured: Boolean(env.RT_CALLBACK_SIGNING_SECRET?.trim()),
    missing,
    reason: credentialsConfigured
      ? 'approved Research Twin API and callback contract is not verified'
      : 'required Research Twin configuration is missing',
  };
}
