/**
 * Item 6 — cst.turn status contract.
 *
 * The Engine Dashboard contract allows exactly five values:
 *   ok | refused | step_up_required | onboarding | error
 * Internal CoreEngine results are mapped explicitly; `completed`, `step_up` and
 * `failed` must never reach the dashboard verbatim.
 */
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TURN_STATUSES,
  REQUIRED_TURN_STATUSES,
  CstTurnStatusSchema,
  RequiredTurnStatusSchema,
  isRequiredTurnStatus,
  isAllowedTurnStatus,
  mapInternalStatusToContractStatus,
  ALLOWED_STATUSES,
  isAllowedStatus,
} from '../../engine/src/contracts/events.js';

describe('cst.turn required status set', () => {
  it('is exactly the five documented dashboard statuses', () => {
    expect(REQUIRED_TURN_STATUSES).toEqual([
      'ok',
      'refused',
      'step_up_required',
      'onboarding',
      'error',
    ]);
  });

  it('every required status is accepted by the schema and the type guard', () => {
    for (const status of REQUIRED_TURN_STATUSES) {
      expect(RequiredTurnStatusSchema.safeParse(status).success).toBe(true);
      expect(isRequiredTurnStatus(status)).toBe(true);
      expect(isAllowedStatus(status)).toBe(true);
      expect(CstTurnStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('internal lifecycle names are NOT part of the required contract', () => {
    for (const internal of ['completed', 'step_up', 'failed', 'received', 'processing', 'synthesized', 'dropped', 'timeout']) {
      expect(isRequiredTurnStatus(internal)).toBe(false);
    }
  });

  it('keeps the wide schema-level union backward compatible', () => {
    // Existing contract surface (and its tests) must not break.
    expect(ALLOWED_TURN_STATUSES).toContain('completed');
    expect(ALLOWED_TURN_STATUSES).toContain('step_up');
    expect(isAllowedTurnStatus('completed')).toBe(true);
    expect(isRequiredTurnStatus('completed')).toBe(false);
  });
});

describe('mapInternalStatusToContractStatus', () => {
  it('maps the documented internal outcomes', () => {
    expect(mapInternalStatusToContractStatus('completed')).toBe('ok');
    expect(mapInternalStatusToContractStatus('ok')).toBe('ok');
    expect(mapInternalStatusToContractStatus('refused')).toBe('refused');
    expect(mapInternalStatusToContractStatus('dropped')).toBe('refused');
    expect(mapInternalStatusToContractStatus('step_up')).toBe('step_up_required');
    expect(mapInternalStatusToContractStatus('step_up_required')).toBe('step_up_required');
    expect(mapInternalStatusToContractStatus('onboarding')).toBe('onboarding');
    expect(mapInternalStatusToContractStatus('failed')).toBe('error');
    expect(mapInternalStatusToContractStatus('timeout')).toBe('error');
    expect(mapInternalStatusToContractStatus('error')).toBe('error');
  });

  it('maps in-flight voice/transport stages onto a terminal dashboard status', () => {
    expect(mapInternalStatusToContractStatus('received')).toBe('ok');
    expect(mapInternalStatusToContractStatus('processing')).toBe('ok');
    expect(mapInternalStatusToContractStatus('synthesized')).toBe('ok');
  });

  it('is total — an unknown or missing status becomes error, never a pass-through', () => {
    expect(mapInternalStatusToContractStatus('something_new')).toBe('error');
    expect(mapInternalStatusToContractStatus('')).toBe('error');
    expect(mapInternalStatusToContractStatus(undefined)).toBe('error');
    expect(mapInternalStatusToContractStatus(null)).toBe('error');
  });

  it('never returns a value outside the required set', () => {
    const candidates = [
      'completed', 'refused', 'step_up', 'onboarding', 'failed', 'dropped',
      'timeout', 'received', 'processing', 'synthesized', 'delivered',
      'sent', 'queued', 'garbage', '', undefined, null,
    ];
    for (const c of candidates) {
      expect(REQUIRED_TURN_STATUSES).toContain(mapInternalStatusToContractStatus(c as any));
    }
  });
});

describe('dashboard publisher transport guarantees are unchanged', () => {
  it('aggregate ALLOWED_STATUSES contains both the required and legacy turn statuses', () => {
    expect(ALLOWED_STATUSES).toContain('ok');
    expect(ALLOWED_STATUSES).toContain('error');
    expect(ALLOWED_STATUSES).toContain('step_up_required');
    expect(ALLOWED_STATUSES).toContain('completed');
    expect(ALLOWED_STATUSES).toContain('delivered');
    expect(ALLOWED_STATUSES).toContain('active');
  });
});
