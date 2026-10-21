/**
 * Outbound queue heartbeat payload.
 *
 * The heartbeat is the only periodic signal that tells an operator whether
 * the outbound worker is alive and what the queue looks like. Two properties
 * matter and are both enforced here:
 *
 *  1. It carries AGGREGATE COUNTS ONLY — no message body, no recipient
 *     number, no correlation id, no tenant data. The heartbeat is written to
 *     a retained log stream that operators, auditors and reviewers read.
 *
 *  2. It carries EVERY state the operator can act on. `outcome_unknown` is
 *     the one state that needs a human: the provider may or may not have
 *     created the message, so it is never re-dispatched automatically and has
 *     to be reconciled against the provider message log. A count that is
 *     computed but not reported is a state that only surfaces by accident.
 */
export interface OutboundQueueDepth {
  pending: number;
  queued: number;
  sending: number;
  failed: number;
  outcome_unknown: number;
}

/**
 * Build the heartbeat log payload.
 *
 * Every state key is ALWAYS present, even when the depth query did not
 * supply it. A missing key would be dropped by `JSON.stringify`, and the
 * whole point of reporting `outcome_unknown` is that the operator must always
 * be able to see its count — a key that silently disappears is the defect
 * this module exists to prevent.
 *
 * @returns aggregate counts keyed by state, and nothing else.
 */
export function buildQueueHeartbeatPayload(depth: OutboundQueueDepth): Record<string, number> {
  return {
    pending: depth?.pending ?? 0,
    queued: depth?.queued ?? 0,
    sending: depth?.sending ?? 0,
    failed: depth?.failed ?? 0,
    outcome_unknown: depth?.outcome_unknown ?? 0,
  };
}
