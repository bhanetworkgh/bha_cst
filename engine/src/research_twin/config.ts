/**
 * Research Twin configuration boundary.
 *
 * The supplied n8n URL is a candidate transport, which operates in:
 * - 'unavailable': Required environment variables are missing.
 * - 'blocked': Credentials exist but the contract/approval is not verified.
 * - 'operational': Credentials exist and contract approval/integration is enabled.
 */
export type ResearchTwinIntegrationState = 'unavailable' | 'blocked' | 'operational';

export interface ResearchTwinConfigStatus {
  state: ResearchTwinIntegrationState;
  operational: boolean;
  contract: 'unverified' | 'verified';
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
  const isEnabled = env.RT_CONTRACT_VERIFIED === 'true' || env.RT_INTEGRATION_ENABLED === 'true';

  if (!credentialsConfigured) {
    return {
      state: 'unavailable',
      operational: false,
      contract: 'unverified',
      endpoint_configured: Boolean(env.RT_ENDPOINT_URL?.trim()),
      service_api_key_configured: Boolean(env.RT_SERVICE_API_KEY?.trim()),
      callback_signing_secret_configured: Boolean(env.RT_CALLBACK_SIGNING_SECRET?.trim()),
      missing,
      reason: 'required Research Twin configuration is missing',
    };
  }

  if (isEnabled) {
    return {
      state: 'operational',
      operational: true,
      contract: 'verified',
      endpoint_configured: true,
      service_api_key_configured: true,
      callback_signing_secret_configured: true,
      missing: [],
      reason: 'approved Research Twin API and callback contract is verified',
    };
  }

  return {
    state: 'blocked',
    operational: false,
    contract: 'unverified',
    endpoint_configured: true,
    service_api_key_configured: true,
    callback_signing_secret_configured: true,
    missing: [],
    reason: 'approved Research Twin API and callback contract is not verified',
  };
}

/** Check if Research Twin is currently operational for investigation dispatch. */
export function isResearchTwinOperational(env: NodeJS.ProcessEnv = process.env): boolean {
  return getResearchTwinConfigStatus(env).operational;
}
