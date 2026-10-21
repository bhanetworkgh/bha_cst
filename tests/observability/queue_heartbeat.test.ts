/**
 * Outbound queue heartbeat — regression tests.
 *
 * The heartbeat is the only periodic signal that the outbound worker is
 * alive, and the only place an operator sees the shape of the queue. Two
 * defects were found in production on 2026-10-21:
 *
 *   - the `outcome_unknown` state was COMPUTED by the queue-depth query but
 *     NOT reported in the heartbeat, so the one state that requires operator
 *     reconciliation was invisible;
 *   - the heartbeat payload was assembled inline in the server bootstrap,
 *     which is not importable by a test (it binds a port on import), so
 *     neither property could be asserted.
 *
 * The payload builder is therefore a small, importable module and its
 * contract is asserted here.
 */
import { describe, it, expect } from 'vitest';
import {
  buildQueueHeartbeatPayload,
  type OutboundQueueDepth,
} from '../../engine/src/observability/queue_heartbeat.js';

const depth = (over: Partial<OutboundQueueDepth> = {}): OutboundQueueDepth => ({
  pending: 0,
  queued: 0,
  sending: 0,
  failed: 0,
  outcome_unknown: 0,
  ...over,
});

describe('outbound queue heartbeat payload', () => {
  it('reports every state, including outcome_unknown', () => {
    const payload = buildQueueHeartbeatPayload(depth({ outcome_unknown: 2 }));
    // The state that needs a human must be visible.
    expect(payload.outcome_unknown).toBe(2);
    expect(Object.keys(payload).sort()).toEqual(
      ['failed', 'outcome_unknown', 'pending', 'queued', 'sending'].sort(),
    );
  });

  it('carries aggregate counts only — no customer content', () => {
    const payload = buildQueueHeartbeatPayload(depth({ pending: 3, queued: 1, sending: 0, failed: 4, outcome_unknown: 1 }));
    const serialised = JSON.stringify(payload);
    // Counts and state names only.
    expect(serialised).not.toContain('@');
    expect(serialised).not.toContain('+1');
    for (const value of Object.values(payload)) {
      expect(typeof value).toBe('number');
    }
  });

  it('is stable for a healthy, empty queue', () => {
    expect(buildQueueHeartbeatPayload(depth())).toEqual({
      pending: 0,
      queued: 0,
      sending: 0,
      failed: 0,
      outcome_unknown: 0,
    });
  });

  it('always emits every state key, even if a count is missing', () => {
    // A missing key would be dropped by JSON.stringify, which is exactly the
    // failure mode this module exists to prevent: the operator must always
    // see the outcome_unknown count.
    const payload = buildQueueHeartbeatPayload({ pending: 1 } as any);
    expect(Object.keys(payload).sort()).toEqual(
      ['failed', 'outcome_unknown', 'pending', 'queued', 'sending'].sort(),
    );
    expect(payload.outcome_unknown).toBe(0);
    expect(JSON.stringify(payload)).toContain('outcome_unknown');
  });
});
