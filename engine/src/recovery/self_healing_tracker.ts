/**
 * Self-healing tracker for the P0 person → farm → device data path.
 *
 * RULE (proposed default, not an existing production rule)
 * ─────────────────────────────────────────────────────────
 * Trigger: the same person → farm → device resolution failure occurs at least
 * 3 times within 10 minutes, scoped by (tenant, project, failure category).
 * (A stable, non-PII failure category — e.g. "no_farm_grant", "upstream_timeout",
 * "no_device_mapping" — never a phone number or customer identifier.)
 *
 * Action: emit a deduplicated operational incident/alert, mark the affected
 * capability as degraded, and stop claiming live device data is available for
 * the affected scope.
 *
 * Safe behaviour: preserve authorization boundaries; do not fabricate data,
 * silently switch to knowledge answers, or retry indefinitely.
 *
 * Recovery: perform a bounded recheck after the upstream mapping is repaired;
 * restore the capability only after successful authorized resolution and
 * telemetry retrieval.
 *
 * Audit: record timestamps, failure category, correlation reference, retry
 * count, incident state, and recovery result — without logging secrets or
 * unnecessary personal data.
 *
 * WHY A NEW MODULE AND NOT A SCHEDULER
 * ─────────────────────────────────────
 * The repository already has:
 *   - `Logger.audit` / `Logger.infra` for structured, redacted diagnostics.
 *   - A 5-minute worker heartbeat (`server.ts`) that reports queue depth.
 *   - `Logger.warn`/`Logger.error` for degraded states.
 * No new scheduler, timer, or infrastructure service is introduced here.
 * This module is a STATE TRACKER that the existing call sites invoke; it
 * emits through the existing Logger. It does not poll, sleep, or schedule.
 */
import { Logger } from '../config/logger.js';

/** How many failures in the window before the tracker triggers. */
export const SELF_HEALING_THRESHOLD = 3;

/** Sliding window for counting failures, in milliseconds. */
export const SELF_HEALING_WINDOW_MS = 10 * 60 * 1000;

/** How long a degraded capability stays degraded before a recheck is allowed. */
export const SELF_HEALING_RECHECK_MS = 60 * 1000;

/** Maximum number of rechecks before giving up on auto-recovery. */
export const SELF_HEALING_MAX_RECHECKS = 5;

export type FailureCategory =
  | 'no_farm_grant'
  | 'no_device_mapping'
  | 'upstream_timeout'
  | 'upstream_unavailable'
  | 'upstream_malformed'
  | 'authorization_denied'
  | 'unknown';

export type CapabilityState = 'healthy' | 'degraded' | 'recovering';

export interface IncidentState {
  tenant_id: string;
  project_id: string;
  category: FailureCategory;
  first_failure_ms: number;
  last_failure_ms: number;
  failure_count: number;
  incident_emitted: boolean;
  incident_emitted_at_ms: number | null;
  capability_state: CapabilityState;
  recheck_count: number;
  last_recheck_ms: number | null;
  recovered_at_ms: number | null;
  recovery_result: 'not_attempted' | 'success' | 'failed';
}

function scopeKey(tenantId: string, projectId: string, category: FailureCategory): string {
  return `${tenantId}:${projectId}:${category}`;
}

/**
 * In-memory state. Keyed by (tenant, project, category).
 *
 * This is deliberately in-memory: a restart resets the failure counts, which
 * is the safe default — a transient outage should not persist as a
 * "degraded" capability across a restart. The degraded state is re-derived
 * from fresh evidence after restart.
 */
const incidents = new Map<string, IncidentState>();

/** Timestamps of recent failures, per scope. */
const recentFailures = new Map<string, number[]>();

/** Test seam: drop all state. */
export function resetSelfHealingState(): void {
  incidents.clear();
  recentFailures.clear();
}

/** Read-only view of the current incident state for a scope. */
export function getIncidentState(
  tenantId: string,
  projectId: string,
  category: FailureCategory,
): IncidentState | null {
  return incidents.get(scopeKey(tenantId, projectId, category)) ?? null;
}

/** Read-only: is the capability currently degraded for this scope? */
export function isCapabilityDegraded(
  tenantId: string,
  projectId: string,
  category: FailureCategory,
): boolean {
  const state = incidents.get(scopeKey(tenantId, projectId, category));
  return state?.capability_state === 'degraded' || state?.capability_state === 'recovering';
}

/**
 * Record a failure. Returns whether the threshold was crossed THIS call
 * (i.e. whether a new incident was emitted).
 */
export function recordFailure(input: {
  tenantId: string;
  projectId: string;
  category: FailureCategory;
  correlationRef: string;
}): { thresholdCrossed: boolean; failureCount: number; incidentEmitted: boolean } {
  const now = Date.now();
  const key = scopeKey(input.tenantId, input.projectId, input.category);

  // Prune failures outside the window.
  const window = recentFailures.get(key) ?? [];
  const pruned = window.filter((ts) => now - ts < SELF_HEALING_WINDOW_MS);
  pruned.push(now);
  recentFailures.set(key, pruned);

  const failureCount = pruned.length;
  const thresholdCrossed = failureCount >= SELF_HEALING_THRESHOLD;

  // Update or create the incident state.
  let state = incidents.get(key);
  if (!state) {
    state = {
      tenant_id: input.tenantId,
      project_id: input.projectId,
      category: input.category,
      first_failure_ms: now,
      last_failure_ms: now,
      failure_count: failureCount,
      incident_emitted: false,
      incident_emitted_at_ms: null,
      capability_state: 'healthy',
      recheck_count: 0,
      last_recheck_ms: null,
      recovered_at_ms: null,
      recovery_result: 'not_attempted',
    };
    incidents.set(key, state);
  }

  state.last_failure_ms = now;
  state.failure_count = failureCount;

  let incidentEmitted = false;

  if (thresholdCrossed && !state.incident_emitted) {
    // Deduplicated: emit exactly once per (tenant, project, category) until
    // recovery. A second threshold crossing within the window does not
    // produce a second incident.
    state.incident_emitted = true;
    state.incident_emitted_at_ms = now;
    state.capability_state = 'degraded';
    incidentEmitted = true;

    // Structured, redacted audit entry. No secrets, no phone numbers, no
    // customer identifiers — only the scope, the category, the count, and a
    // correlation reference.
    Logger.audit({
      timestamp: new Date(now).toISOString(),
      tenant_id: input.tenantId,
      actor: 'self_healing_tracker',
      role: 'system',
      entry_point: 'api',
      tool_or_route: 'self_healing_tracker.recordFailure',
      outcome: 'error',
      reason: `Repeat failure threshold crossed: ${input.category} occurred ${failureCount} times in ${SELF_HEALING_WINDOW_MS / 60000} minutes for tenant ${input.tenantId} project ${input.projectId}`,
      correlation_id: input.correlationRef,
      details: {
        failure_category: input.category,
        failure_count: failureCount,
        threshold: SELF_HEALING_THRESHOLD,
        window_ms: SELF_HEALING_WINDOW_MS,
        capability_state: 'degraded',
      },
    });

    Logger.infra({
      message: `Self-healing: capability degraded for tenant ${input.tenantId} project ${input.projectId} (${input.category})`,
      commercial_impact:
        'Live device data is no longer claimed for this scope. The capability will be rechecked after the upstream mapping is repaired.',
      meta: {
        tenant_id: input.tenantId,
        project_id: input.projectId,
        failure_category: input.category,
        failure_count: failureCount,
      },
    });
  }

  return { thresholdCrossed, failureCount, incidentEmitted };
}

/**
 * Attempt a bounded recheck. Returns true only if the upstream now succeeds.
 *
 * The caller (the vFarm connector or the voice lane) supplies a `probe`
 * function that performs the actual upstream check. This module never
 * contacts upstream itself — it only tracks state and enforces the bound.
 */
export async function attemptRecovery(input: {
  tenantId: string;
  projectId: string;
  category: FailureCategory;
  probe: () => Promise<boolean>;
}): Promise<{ recovered: boolean; recheckCount: number; reason: string }> {
  const now = Date.now();
  const key = scopeKey(input.tenantId, input.projectId, input.category);
  const state = incidents.get(key);

  if (!state || state.capability_state !== 'degraded') {
    return { recovered: false, recheckCount: state?.recheck_count ?? 0, reason: 'not_degraded' };
  }

  if (state.recheck_count >= SELF_HEALING_MAX_RECHECKS) {
    return { recovered: false, recheckCount: state.recheck_count, reason: 'max_rechecks_exceeded' };
  }

  if (state.last_recheck_ms !== null && now - state.last_recheck_ms < SELF_HEALING_RECHECK_MS) {
    return { recovered: false, recheckCount: state.recheck_count, reason: 'recheck_too_soon' };
  }

  state.capability_state = 'recovering';
  state.recheck_count++;
  state.last_recheck_ms = now;

  let recovered = false;
  try {
    recovered = await input.probe();
  } catch (err: any) {
    recovered = false;
    Logger.warn(`Self-healing recheck failed for tenant ${input.tenantId} project ${input.projectId}: ${err?.message}`);
  }

  if (recovered) {
    state.capability_state = 'healthy';
    state.recovered_at_ms = now;
    state.recovery_result = 'success';
    // Reset the incident flag so a new incident can be emitted if the
    // failure recurs later. Clear the failure window too.
    state.incident_emitted = false;
    state.incident_emitted_at_ms = null;
    recentFailures.delete(key);

    Logger.audit({
      timestamp: new Date(now).toISOString(),
      tenant_id: input.tenantId,
      actor: 'self_healing_tracker',
      role: 'system',
      entry_point: 'api',
      tool_or_route: 'self_healing_tracker.attemptRecovery',
      outcome: 'ok',
      reason: `Self-healing recovery succeeded for tenant ${input.tenantId} project ${input.projectId} (${input.category}) after ${state.recheck_count} recheck(s)`,
      correlation_id: `${input.tenantId}:${input.projectId}:${input.category}`,
      details: {
        failure_category: input.category,
        recheck_count: state.recheck_count,
        capability_state: 'healthy',
      },
    });
  } else {
    state.capability_state = 'degraded';
    state.recovery_result = 'failed';

    Logger.warn(
      `Self-healing recheck did not recover tenant ${input.tenantId} project ${input.projectId} (${input.category}) — attempt ${state.recheck_count} of ${SELF_HEALING_MAX_RECHECKS}`,
    );
  }

  return {
    recovered,
    recheckCount: state.recheck_count,
    reason: recovered ? 'recovered' : 'probe_failed',
  };
}
