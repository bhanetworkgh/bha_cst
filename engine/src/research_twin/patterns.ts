/**
 * Reusable Research Twin failure patterns and resolution catalog.
 *
 * Provides structured root-cause classifications, operational procedures,
 * and pattern search/retrieval capabilities for CST incident diagnosis.
 */

export interface ResearchPattern {
  pattern_id: string;
  category: string;
  title: string;
  symptoms: string[];
  root_cause: string;
  resolution_summary: string;
  code_references: string[];
  operational_procedure: string;
  runbook_reference: string;
  last_verified_at: string;
}

export const CANONICAL_RESEARCH_PATTERNS: ResearchPattern[] = [
  {
    pattern_id: 'PATT-WH-AUTH-001',
    category: 'webhook_auth_failure',
    title: 'ElevenLabs Webhook Signature Timestamp Drift or Secret Mismatch',
    symptoms: [
      'Invalid signature or missing secret header',
      'Timestamp drift exceeds tolerance',
      'HTTP 401 Unauthorized on /webhooks/elevenlabs/post-call',
    ],
    root_cause:
      'The inbound webhook signature timestamp is skewed >300s relative to server clock, or ELEVENLABS_WEBHOOK_SECRET differs between ElevenLabs portal and Render environment variables.',
    resolution_summary:
      'Verify host system time synchronization (NTP). Compare configured ELEVENLABS_WEBHOOK_SECRET against ElevenLabs Agent Webhook Settings in Bitwarden.',
    code_references: [
      'engine/src/interfaces/elevenlabs/service.ts:100-152',
      'engine/src/interfaces/elevenlabs/index.ts:14-27',
    ],
    operational_procedure:
      '1. Inspect GET /webhooks/elevenlabs/health for auth_failures metric count.\n2. Verify the webhook signing secret in Render Environment settings.\n3. Check Render server clock via Date.now().',
    runbook_reference: 'docs/reports/CST_ELEVENLABS_AUTH_VERIFICATION_EVIDENCE.md',
    last_verified_at: '2026-11-08T18:46:51.000Z',
  },
  {
    pattern_id: 'PATT-WH-VAL-001',
    category: 'payload_validation_failure',
    title: 'Missing Caller Identity or Schema Variation in Post-Call Webhook',
    symptoms: [
      'Payload failed ElevenLabs post-call validation',
      'CALLER_IDENTITY_MISSING',
      'HTTP 400 or HTTP 500 PROCESSING_FAILED',
    ],
    root_cause:
      'Inbound payload lacks caller_id, caller_phone, or phone_call metadata, violating the anti-fabrication boundary (SO8M / PR #35).',
    resolution_summary:
      'Ensure the ElevenLabs agent transmits caller identity in custom_variables (caller_phone) or Twilio phone_call metadata. CST fails closed rather than fabricating identity.',
    code_references: [
      'engine/src/interfaces/elevenlabs/service.ts:190-250',
      'engine/src/interfaces/elevenlabs/schemas.ts:10-41',
    ],
    operational_procedure:
      '1. Inspect inbound payload structure in webhook trace logs.\n2. Configure ElevenLabs agent prompt/flow to pass custom_variables.caller_phone from telephony ingress.',
    runbook_reference: 'docs/reports/CS_TWIN_V1_FIRST_SLICE_EVIDENCE.md',
    last_verified_at: '2026-11-08T18:46:51.000Z',
  },
  {
    pattern_id: 'PATT-DB-PERSIST-001',
    category: 'database_persistence_failure',
    title: 'PostgreSQL Pool Connection Timeout or Statement Deadlock',
    symptoms: [
      'connection timeout to postgres',
      'webhook database persistence failure',
      'Error: connect ECONNREFUSED ::1:5432 or 127.0.0.1:5432',
    ],
    root_cause:
      'DATABASE_URL fallback to localhost occurred in production, or external connection pool exceeded max connections without SSL verify-full mode.',
    resolution_summary:
      'Ensure DATABASE_URL is wired from Render managed PostgreSQL (bha-cst-postgres). Enforce 10s connection timeout and 15s statement timeout.',
    code_references: [
      'engine/src/db/client.ts:56-70',
      'engine/src/db/client.ts:2730-2765',
      'scripts/migrate.js:15-30',
    ],
    operational_procedure:
      '1. Check Render service dashboard environment variable DATABASE_URL.\n2. Verify pool active client count via DbClient.getPoolStatus().\n3. Restart web service srv-db8hepqvcj2c73adpus0 if connection leaked.',
    runbook_reference: 'docs/reports/CST_MIGRATION_LEDGER_RECONCILIATION.md',
    last_verified_at: '2026-11-08T18:46:51.000Z',
  },
  {
    pattern_id: 'PATT-SLACK-DELIV-001',
    category: 'slack_delivery_failure',
    title: 'Slack Block Kit Card Dispatch Failure or File Upload Refusal',
    symptoms: [
      'Slack delivery failed: HTTP 429',
      'CST Genie call log did not reach the customer service channel',
      'Slack rate limit encountered',
    ],
    root_cause:
      'Slack bot token lacks files:write permission, channel C0BD6D53HAM archived/restricted, or Slack Web API rate limiting tripped on rapid concurrent turns.',
    resolution_summary:
      'CallLogPoster falls back to posting transcript as thread text if file upload fails. ErrorRouter dispatches alerts to #bha-pipeline-errors.',
    code_references: [
      'engine/src/notifications/call_log.ts:320-380',
      'engine/src/notifications/error_router.ts:192-245',
    ],
    operational_procedure:
      '1. Verify SLACK_BOT_TOKEN installation in workspace.\n2. Ensure bot U0CF23JSUG4 is present in channel C0BD6D53HAM.\n3. Execute POST /api/v1/alerts/test with x-cst-api-key to verify delivery.',
    runbook_reference: 'docs/reports/CST_ELEVENLABS_AUTH_VERIFICATION_EVIDENCE.md',
    last_verified_at: '2026-11-08T18:46:51.000Z',
  },
  {
    pattern_id: 'PATT-TWILIO-ATTR-001',
    category: 'twilio_callback_failure',
    title: 'Twilio Telephony Callback Missing Service Number Binding',
    symptoms: [
      'Twilio callback SID missing tenant/project attribution',
      'unresolved_attributions in FailureDetector',
      'cst.delivery not published: tenancy unresolved',
    ],
    root_cause:
      'The receiving E.164 service number is not registered in service_number_bindings table in PostgreSQL.',
    resolution_summary:
      'Execute migration or seed query to bind the phone number to tenant_id and project_id. CST refuses to publish un-attributed delivery events.',
    code_references: [
      'engine/src/observability/voice_events.ts:35-80',
      'engine/src/db/client.ts:800-840',
    ],
    operational_procedure:
      '1. Query SELECT * FROM service_number_bindings WHERE service_number = :e164;\n2. Insert missing binding with capability_set = sms_voice.',
    runbook_reference: 'docs/contracts/cst-monitoring-engine-surfacing-contract.md',
    last_verified_at: '2026-11-08T18:46:51.000Z',
  },
  {
    pattern_id: 'PATT-SENSOR-STALE-001',
    category: 'sensor_telemetry_stale',
    title: 'vFarm Sensor Telemetry Stale (>24h) or Gateway Unreachable',
    symptoms: [
      'stale: true on canonical sensors',
      'telemetry_unavailable in connector state',
      'farm_health: degraded',
    ],
    root_cause:
      'Cabinet hardware sensor controller dropped offline or failed to transmit fresh readings to upstream vFarm PostgreSQL readings table.',
    resolution_summary:
      'CST normalizes stale telemetry honestly without fabricating readings. When staleness > 24h, an investigation card is qualified.',
    code_references: [
      'engine/src/adapters/vfarm/live_client.ts:40-110',
      'engine/src/adapters/vfarm/health.ts:15-60',
    ],
    operational_procedure:
      '1. Check vFarm device fleet status via GET /api/v1/devices.\n2. Query upstream readings table for device_id and last reading_ts.\n3. Dispatch on-site technician to inspect sensor gateway battery/Wi-Fi.',
    runbook_reference: 'docs/contracts/monitoring-research-twin-field-contract.md',
    last_verified_at: '2026-11-03T18:15:10.000Z',
  },
];

/**
 * Search the canonical pattern repository by category or keyword query.
 */
export function findPatterns(options: { query?: string; category?: string } = {}): ResearchPattern[] {
  const { query, category } = options;
  const q = (query || '').toLowerCase().trim();
  const cat = (category || '').toLowerCase().trim();

  return CANONICAL_RESEARCH_PATTERNS.filter((p) => {
    if (cat && p.category.toLowerCase() !== cat) {
      return false;
    }
    if (!q) return true;
    return (
      p.pattern_id.toLowerCase().includes(q) ||
      p.title.toLowerCase().includes(q) ||
      p.root_cause.toLowerCase().includes(q) ||
      p.resolution_summary.toLowerCase().includes(q) ||
      p.symptoms.some((s) => s.toLowerCase().includes(q))
    );
  });
}

/**
 * Look up a specific pattern by failure category and optional error message.
 */
export function lookupPatternByCategory(category: string, errorMessage?: string): ResearchPattern | undefined {
  const cat = category.toLowerCase().trim();
  const matches = CANONICAL_RESEARCH_PATTERNS.filter((p) => p.category.toLowerCase() === cat);
  if (matches.length === 0) return undefined;
  if (!errorMessage) return matches[0];

  const err = errorMessage.toLowerCase();
  const bestMatch = matches.find((p) => p.symptoms.some((s) => err.includes(s.toLowerCase())));
  return bestMatch || matches[0];
}

/**
 * Format a pattern into a concise markdown resolution note.
 */
export function formatPatternResolution(pattern: ResearchPattern): string {
  return [
    `**Pattern:** [${pattern.pattern_id}] ${pattern.title}`,
    `**Root Cause:** ${pattern.root_cause}`,
    `**Resolution:** ${pattern.resolution_summary}`,
    `**Runbook:** ${pattern.runbook_reference}`,
  ].join('\n');
}

