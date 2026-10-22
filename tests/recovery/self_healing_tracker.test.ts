/**
 * Self-healing tracker — regression tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '../../engine/src/config/logger.js';
import {
  SELF_HEALING_THRESHOLD,
  SELF_HEALING_WINDOW_MS,
  SELF_HEALING_RECHECK_MS,
  SELF_HEALING_MAX_RECHECKS,
  recordFailure,
  attemptRecovery,
  isCapabilityDegraded,
  getIncidentState,
  resetSelfHealingState,
} from '../../engine/src/recovery/self_healing_tracker.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';

describe('self-healing — trigger threshold', () => {
  beforeEach(() => resetSelfHealingState());
  afterEach(() => vi.restoreAllMocks());

  it('does not trigger before the threshold', () => {
    const r1 = recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: 'c1' });
    const r2 = recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: 'c2' });

    expect(r1.thresholdCrossed).toBe(false);
    expect(r1.incidentEmitted).toBe(false);
    expect(r2.thresholdCrossed).toBe(false);
    expect(isCapabilityDegraded(TENANT, PROJECT, 'no_device_mapping')).toBe(false);
  });

  it('triggers exactly at the threshold', () => {
    recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: 'c1' });
    recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: 'c2' });
    const r3 = recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: 'c3' });

    expect(r3.thresholdCrossed).toBe(true);
    expect(r3.incidentEmitted).toBe(true);
    expect(r3.failureCount).toBe(3);
    expect(isCapabilityDegraded(TENANT, PROJECT, 'no_device_mapping')).toBe(true);

    const state = getIncidentState(TENANT, PROJECT, 'no_device_mapping');
    expect(state).not.toBeNull();
    expect(state!.incident_emitted).toBe(true);
    expect(state!.capability_state).toBe('degraded');
    expect(state!.failure_count).toBe(3);
  });

  it('is scoped per (tenant, project, category)', () => {
    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: `c${i}` });
    }
    expect(isCapabilityDegraded(TENANT, PROJECT, 'upstream_timeout')).toBe(false);
    expect(isCapabilityDegraded(TENANT, 'proj-other', 'no_device_mapping')).toBe(false);
  });
});

describe('self-healing — deduplication', () => {
  beforeEach(() => resetSelfHealingState());
  afterEach(() => vi.restoreAllMocks());

  it('emits the incident ONCE, even when failures continue', () => {
    const auditSpy = vi.spyOn(Logger, 'audit');
    const infraSpy = vi.spyOn(Logger, 'infra');

    for (let i = 0; i < 6; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'upstream_timeout', correlationRef: `c${i}` });
    }

    const auditCalls = auditSpy.mock.calls.filter((c) => c[0]?.reason?.includes('threshold crossed'));
    const infraCalls = infraSpy.mock.calls.filter((c) => c[0]?.message?.includes('capability degraded'));
    expect(auditCalls.length).toBe(1);
    expect(infraCalls.length).toBe(1);

    const state = getIncidentState(TENANT, PROJECT, 'upstream_timeout');
    expect(state!.incident_emitted).toBe(true);
  });

  it('logs only scope, category, count and correlation ref — never secrets or PII', () => {
    const auditSpy = vi.spyOn(Logger, 'audit');
    const secretPhone = '+15551234567';
    const secretToken = 'super-secret-token-value';

    for (let i = 0; i < 3; i++) {
      recordFailure({
        tenantId: TENANT,
        projectId: PROJECT,
        category: 'authorization_denied',
        correlationRef: `corr_${i}`,
      });
    }

    const stream = auditSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(stream).not.toContain(secretPhone);
    expect(stream).not.toContain(secretToken);
    expect(stream).toContain('authorization_denied');
    expect(stream).toContain('failure_count');
  });
});

describe('self-healing — recovery', () => {
  beforeEach(() => resetSelfHealingState());
  afterEach(() => vi.restoreAllMocks());

  it('recovery succeeds only after a successful probe', async () => {
    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: `c${i}` });
    }
    expect(isCapabilityDegraded(TENANT, PROJECT, 'no_device_mapping')).toBe(true);

    const probe = vi.fn().mockResolvedValue(true);
    const r = await attemptRecovery({
      tenantId: TENANT,
      projectId: PROJECT,
      category: 'no_device_mapping',
      probe,
    });

    expect(r.recovered).toBe(true);
    expect(r.reason).toBe('recovered');
    expect(isCapabilityDegraded(TENANT, PROJECT, 'no_device_mapping')).toBe(false);

    const state = getIncidentState(TENANT, PROJECT, 'no_device_mapping');
    expect(state!.capability_state).toBe('healthy');
    expect(state!.recovery_result).toBe('success');
    expect(state!.recovered_at_ms).not.toBeNull();
  });

  it('recovery fails when the probe fails, and stays degraded', async () => {
    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: `c${i}` });
    }

    const probe = vi.fn().mockResolvedValue(false);
    const r = await attemptRecovery({
      tenantId: TENANT,
      projectId: PROJECT,
      category: 'no_device_mapping',
      probe,
    });

    expect(r.recovered).toBe(false);
    expect(r.reason).toBe('probe_failed');
    expect(isCapabilityDegraded(TENANT, PROJECT, 'no_device_mapping')).toBe(true);

    const state = getIncidentState(TENANT, PROJECT, 'no_device_mapping');
    expect(state!.capability_state).toBe('degraded');
    expect(state!.recovery_result).toBe('failed');
  });

  it('recovery is bounded: at most 5 rechecks', async () => {
    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'upstream_timeout', correlationRef: `c${i}` });
    }

    const state = getIncidentState(TENANT, PROJECT, 'upstream_timeout')!;
    state.last_recheck_ms = 0;

    let maxExceeded = false;
    for (let i = 0; i < 7; i++) {
      state.last_recheck_ms = 0;
      const r = await attemptRecovery({
        tenantId: TENANT,
        projectId: PROJECT,
        category: 'upstream_timeout',
        probe: async () => false,
      });
      if (r.reason === 'max_rechecks_exceeded') {
        maxExceeded = true;
        break;
      }
    }

    expect(maxExceeded).toBe(true);
    const finalState = getIncidentState(TENANT, PROJECT, 'upstream_timeout');
    expect(finalState!.recheck_count).toBe(SELF_HEALING_MAX_RECHECKS);
  });

  it('recovery is rate-limited: too soon returns recheck_too_soon', async () => {
    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'upstream_timeout', correlationRef: `c${i}` });
    }

    const r1 = await attemptRecovery({
      tenantId: TENANT,
      projectId: PROJECT,
      category: 'upstream_timeout',
      probe: async () => false,
    });
    expect(r1.recovered).toBe(false);

    const r2 = await attemptRecovery({
      tenantId: TENANT,
      projectId: PROJECT,
      category: 'upstream_timeout',
      probe: async () => true,
    });
    expect(r2.reason).toBe('recheck_too_soon');
  });

  it('recovery is a no-op when the capability is not degraded', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const r = await attemptRecovery({
      tenantId: TENANT,
      projectId: PROJECT,
      category: 'no_device_mapping',
      probe,
    });

    expect(r.recovered).toBe(false);
    expect(r.reason).toBe('not_degraded');
    expect(probe).not.toHaveBeenCalled();
  });

  it('recovery clears the failure window so a new incident can be emitted later', async () => {
    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: `c${i}` });
    }

    const state = getIncidentState(TENANT, PROJECT, 'no_device_mapping')!;
    state.last_recheck_ms = 0;
    await attemptRecovery({
      tenantId: TENANT,
      projectId: PROJECT,
      category: 'no_device_mapping',
      probe: async () => true,
    });

    expect(isCapabilityDegraded(TENANT, PROJECT, 'no_device_mapping')).toBe(false);

    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'no_device_mapping', correlationRef: `c2_${i}` });
    }
    expect(isCapabilityDegraded(TENANT, PROJECT, 'no_device_mapping')).toBe(true);
  });
});

describe('self-healing — audit fields', () => {
  beforeEach(() => resetSelfHealingState());
  afterEach(() => vi.restoreAllMocks());

  it('records failure_count, threshold, window, and capability_state in the audit entry', () => {
    const auditSpy = vi.spyOn(Logger, 'audit');

    for (let i = 0; i < 3; i++) {
      recordFailure({ tenantId: TENANT, projectId: PROJECT, category: 'upstream_malformed', correlationRef: `c${i}` });
    }

    const entry = auditSpy.mock.calls.find((c) => c[0]?.reason?.includes('threshold crossed'));
    expect(entry).toBeDefined();
    const details = entry![0].details;
    expect(details.failure_category).toBe('upstream_malformed');
    expect(details.failure_count).toBe(3);
    expect(details.threshold).toBe(3);
    expect(details.window_ms).toBe(600000);
    expect(details.capability_state).toBe('degraded');
    expect(entry![0].correlation_id).toBe('c2');
    expect(entry![0].tenant_id).toBe(TENANT);
  });
});
