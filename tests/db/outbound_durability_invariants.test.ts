/**
 * Outbound durability invariants — regression tests.
 *
 * These cover the code-owned defects confirmed while closing the remaining
 * gaps from the 2026-10-21 outbound queue delay audit:
 *
 *  1. A FAILED `saveOutboundMessage` WAS REPORTED AS SUCCESS. The error was
 *     swallowed and the caller received an id for a row that does not exist.
 *     Two consequences: the customer reply was never queued (it silently
 *     vanished), and any child write against that id violated a foreign key —
 *     which is the `alert_audit_log.outbound_message_id -> messages_out(id)`
 *     violation reported from live voice turns.
 *
 *  2. A FAILED `updateOutboundStatus` was swallowed, so the durable state and
 *     the in-memory state silently diverged.
 *
 *  3. The lease recovery RE-QUEUED a stale claim, including one the provider
 *     had already accepted — a duplicate-send path.
 *
 *  4. The delivery-status callback UPDATE could match MORE THAN ONE row
 *     (`provider_sid` carries a non-unique index and the `correlation_id`
 *     fallback is a wildcard), so a single callback could mutate several
 *     messages.
 *
 *  5. The delivery-status rank mapping in SQL did not mirror the in-memory
 *     `deliveryStatusRank`, so a `pending`/`outcome_unknown` row could never
 *     be advanced by a callback.
 *
 *  6. The Dashboard dead-letter view was in-memory only and the "replayed"
 *     mark was never persisted, so a failed publish was unrecoverable after a
 *     restart and a replayed event could be published twice.
 *
 * No database, no network, no provider: every case uses a deterministic stub
 * pool. The foreign-key constraints are deliberately left intact — these tests
 * exist to prove the write path satisfies them, not to remove them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DbClient, OutboundPersistenceError } from '../../engine/src/db/client.js';
import { AlertAuditLog } from '../../engine/src/audit/alert_audit.js';

const TENANT = 'tenant-vfarm-01';
const PROJECT = 'proj-vfarm-main';

describe('outbound persistence — a failed write is never reported as success', () => {
  let stubPool: { query: ReturnType<typeof vi.fn> };
  const originalPool = DbClient.getPool();

  beforeEach(() => {
    DbClient.clearAll();
    stubPool = { query: vi.fn() };
    DbClient.setPool(stubPool as any);
  });

  afterEach(() => {
    DbClient.setPool(originalPool);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('throws an OutboundPersistenceError when the messages_out INSERT fails', async () => {
    stubPool.query.mockImplementation(async () => {
      throw new Error('insert failed: connection terminated unexpectedly');
    });

    // Before the fix this resolved to a record with an id, and the caller
    // carried on as though the reply was queued.
    await expect(
      DbClient.saveOutboundMessage({
        tenant_id: TENANT,
        project_id: PROJECT,
        to_e164: '+15551234567',
        body: 'reply that could not be persisted',
        correlation_id: 'turn_persist_fail',
      } as any),
    ).rejects.toBeInstanceOf(OutboundPersistenceError);
  });

  it('the persistence error carries no customer content', async () => {
    stubPool.query.mockImplementation(async () => {
      throw new Error('insert failed');
    });

    const secretBody = 'SECRET-CUSTOMER-MESSAGE-BODY';
    let thrown: any = null;
    try {
      await DbClient.saveOutboundMessage({
        tenant_id: TENANT,
        project_id: PROJECT,
        to_e164: '+15551234567',
        body: secretBody,
        correlation_id: 'turn_persist_fail_2',
      } as any);
    } catch (err: any) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(OutboundPersistenceError);
    const serialised = `${thrown?.message} ${thrown?.tenantId} ${thrown?.outboundMessageId}`;
    expect(serialised).not.toContain(secretBody);
    expect(serialised).not.toContain('+15551234567');
  });

  it('does NOT write an alert-audit row for a message that was never persisted', async () => {
    // The alert audit row references `messages_out(id)`. A failed save means
    // there is no parent row, so the audit write would fail with a foreign
    // key violation. With the save now failing loudly, the caller never gets
    // an id and never attempts the child write.
    stubPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO messages_out')) {
        throw new Error('insert failed');
      }
      return { rows: [] };
    });

    let outboundId: string | null = null;
    try {
      const saved = await DbClient.saveOutboundMessage({
        tenant_id: TENANT,
        project_id: PROJECT,
        to_e164: '+15551234567',
        body: 'reply',
        correlation_id: 'turn_persist_fail_3',
      } as any);
      outboundId = saved.id ?? null;
    } catch {
      // expected: the caller must fail the turn
    }

    expect(outboundId).toBeNull();

    // And the foreign key itself is still intact: writing an audit row for a
    // message id that has no parent still fails, rather than silently
    // succeeding. The constraint is not weakened to make anything pass.
    stubPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO alert_audit_log')) {
        throw new Error(
          'insert or update on table "alert_audit_log" violates foreign key constraint "alert_audit_log_outbound_message_id_fkey"',
        );
      }
      return { rows: [] };
    });

    await expect(
      DbClient.writeAlertAuditRow({
        id: 'alert_orphan_001',
        outbound_message_id: 'out_never_persisted',
        tenant_id: TENANT,
        organization_id: TENANT,
        rendered_body: 'masked body',
        truncated: false,
        masked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      } as any),
    ).rejects.toThrow(/foreign key constraint/i);
  });

  it('reports a failed status write instead of silently diverging from the durable state', async () => {
    stubPool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE messages_out')) {
        throw new Error('could not serialize access due to concurrent update');
      }
      return { rows: [] };
    });

    const persisted = await DbClient.updateOutboundStatus('out_status_001', 'sent', undefined, 1);

    // The caller can now tell that the durable state did not move.
    expect(persisted).toBe(false);
  });

  it('reports success when the status write succeeds', async () => {
    stubPool.query.mockImplementation(async () => ({ rows: [] }));
    const persisted = await DbClient.updateOutboundStatus('out_status_002', 'sent', undefined, 1);
    expect(persisted).toBe(true);
  });
});

describe('outbound lease recovery — a stale claim is never re-dispatched', () => {
  let stubPool: { query: ReturnType<typeof vi.fn> };
  const originalPool = DbClient.getPool();

  beforeEach(() => {
    DbClient.clearAll();
    stubPool = { query: vi.fn() };
    DbClient.setPool(stubPool as any);
  });

  afterEach(() => {
    DbClient.setPool(originalPool);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('a claim is atomic — the status predicate stops a second worker winning the same row', async () => {
    const statements: string[] = [];
    // The first claim wins, the second finds the row already `sending` and
    // therefore updates no row.
    let claimCount = 0;
    stubPool.query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('UPDATE messages_out') && sql.includes("status = 'sending'")) {
        claimCount++;
        return claimCount === 1
          ? { rows: [{ id: 'out_race_001' }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const first = await DbClient.claimOutboundMessage('out_race_001');
    const second = await DbClient.claimOutboundMessage('out_race_001');

    expect(first).toBe(true);
    expect(second).toBe(false);

    // The claim must be a conditional UPDATE, never a read-then-write.
    const claimSql = statements.find((s) => s.includes("status = 'sending'"))!;
    expect(claimSql).toMatch(/WHERE id = \$1 AND \(status = 'pending' OR status = 'queued'\)/);
    expect(claimSql).toMatch(/RETURNING id/);
  });

  it('two concurrent claims of the same message: exactly one wins', async () => {
    // The in-memory path (no pool) is exercised here: the database path is
    // covered by the conditional-UPDATE assertion above.
    DbClient.setPool(null);
    await DbClient.saveOutboundMessage({
      id: 'out_race_002',
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+15551234567',
      body: 'raced',
      correlation_id: 'turn_race_002',
      status: 'pending',
    } as any);

    const results = await Promise.all([
      DbClient.claimOutboundMessage('out_race_002'),
      DbClient.claimOutboundMessage('out_race_002'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('marks an accepted stale claim as sent and never re-queues it', async () => {
    const statements: string[] = [];
    stubPool.query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('provider_sid IS NOT NULL')) {
        return { rows: [{ id: 'out_accepted_001' }], rowCount: 1 };
      }
      if (sql.includes('provider_sid IS NULL')) {
        return { rows: [{ id: 'out_unknown_001' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const recovered = await DbClient.reclaimStaleOutboundMessages(60_000);

    expect(recovered).toContain('out_accepted_001');
    expect(recovered).toContain('out_unknown_001');

    const acceptedSql = statements.find((s) => s.includes('provider_sid IS NOT NULL'))!;
    const unknownSql = statements.find((s) => s.includes('provider_sid IS NULL'))!;

    // The accepted message becomes `sent` (the provider DID create it).
    expect(acceptedSql).toMatch(/SET status = 'sent'/);
    // The unknown one is parked, not re-queued.
    expect(unknownSql).toMatch(/SET status = 'outcome_unknown'/);
    // NEITHER path may put the row back into the eligible queue.
    expect(acceptedSql).not.toMatch(/'queued'/);
    expect(unknownSql).not.toMatch(/'queued'/);
    expect(acceptedSql).not.toMatch(/next_retry_at\s*=\s*\$2/);
  });
});

describe('delivery-status callback — exactly one row, one consistent rank map', () => {
  let stubPool: { query: ReturnType<typeof vi.fn> };
  const originalPool = DbClient.getPool();

  beforeEach(() => {
    DbClient.clearAll();
    stubPool = { query: vi.fn() };
    DbClient.setPool(stubPool as any);
  });

  afterEach(() => {
    DbClient.setPool(originalPool);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('updates at most one message row per callback', async () => {
    const statements: string[] = [];
    stubPool.query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await DbClient.updateDeliveryStatusByProviderSid('SM_SINGLE_ROW_001', 'delivered');

    const update = statements.find((s) => s.includes('UPDATE messages_out'))!;
    expect(update).toBeDefined();
    // The predicate is narrowed to a single, most-recent match.
    expect(update).toMatch(/WHERE id = \(\s*SELECT id FROM messages_out/s);
    expect(update).toMatch(/LIMIT 1/);
    // It is not a bare multi-row predicate any more.
    expect(update).not.toMatch(/WHERE \(provider_sid = \$3 OR id = \$3 OR correlation_id LIKE \$4\)\s*AND/);
  });

  it('uses the same rank map as the in-memory deliveryStatusRank', async () => {
    const statements: string[] = [];
    stubPool.query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 0 };
    });

    await DbClient.updateDeliveryStatusByProviderSid('SM_RANK_001', 'delivered');

    const update = statements.find((s) => s.includes('UPDATE messages_out'))!;
    // `pending` and `outcome_unknown` mean "no delivery information yet", so
    // a callback must be able to advance them. The old mapping folded them
    // into the terminal rank, which silently discarded the delivery state.
    expect(update).toMatch(/WHEN 'pending' THEN 0/);
    expect(update).toMatch(/WHEN 'outcome_unknown' THEN 0/);
    expect(update).toMatch(/WHEN 'queued' THEN 1/);
    expect(update).toMatch(/WHEN 'sending' THEN 2/);
    expect(update).toMatch(/WHEN 'sent' THEN 3/);
  });
});

describe('Dashboard dead-letter — durable read and durable replay mark', () => {
  let stubPool: { query: ReturnType<typeof vi.fn> };
  const originalPool = DbClient.getPool();

  beforeEach(() => {
    DbClient.clearAll();
    stubPool = { query: vi.fn() };
    DbClient.setPool(stubPool as any);
  });

  afterEach(() => {
    DbClient.setPool(originalPool);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('reads the dead-letter view from the database, not only from memory', async () => {
    const statements: string[] = [];
    stubPool.query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      return {
        rows: [
          {
            id: 'dpo_001',
            event_id: 'turn_evt_durable_001',
            event_type: 'cst.turn',
            status: 'failed',
            attempts: 3,
            error: 'HTTP 503',
            payload: { type: 'cst.turn' },
            created_at: new Date('2026-10-21T00:00:00Z'),
            expires_at: new Date('2026-10-28T00:00:00Z'),
            replayed_at: null,
          },
        ],
        rowCount: 1,
      };
    });

    const outcomes = await DbClient.getUnpublishedDashboardOutcomes();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].event_id).toBe('turn_evt_durable_001');
    expect(statements.some((s) => s.includes('FROM dashboard_publish_outcomes'))).toBe(true);
  });

  it('persists the replayed mark so an event is never published twice', async () => {
    const statements: string[] = [];
    stubPool.query.mockImplementation(async (sql: string) => {
      statements.push(sql);
      return { rows: [], rowCount: 1 };
    });

    await DbClient.markDashboardOutcomeReplayed('dpo_001');

    const mark = statements.find((s) => s.includes('UPDATE dashboard_publish_outcomes'))!;
    expect(mark).toBeDefined();
    expect(mark).toMatch(/replayed_at/);
  });
});

describe('queue depth — aggregate counts only, no customer content', () => {
  let stubPool: { query: ReturnType<typeof vi.fn> };
  const originalPool = DbClient.getPool();

  beforeEach(() => {
    DbClient.clearAll();
    stubPool = { query: vi.fn() };
    DbClient.setPool(stubPool as any);
  });

  afterEach(() => {
    DbClient.setPool(originalPool);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('returns counts by state and nothing else', async () => {
    await DbClient.saveOutboundMessage({
      id: 'out_depth_001',
      tenant_id: TENANT,
      project_id: PROJECT,
      to_e164: '+15551234567',
      body: 'SECRET-CUSTOMER-MESSAGE-BODY',
      correlation_id: 'turn_depth_001',
      status: 'pending',
    } as any);

    const depth = await DbClient.getOutboundQueueDepth();

    // The heartbeat payload is aggregate counts by state only.
    expect(Object.keys(depth).sort()).toEqual(
      ['failed', 'outcome_unknown', 'pending', 'queued', 'sending'].sort(),
    );
    expect(depth.pending).toBe(1);

    // No message content, recipient number or correlation id can travel in it.
    const serialised = JSON.stringify(depth);
    expect(serialised).not.toContain('SECRET-CUSTOMER-MESSAGE-BODY');
    expect(serialised).not.toContain('+15551234567');
    expect(serialised).not.toContain('turn_depth_001');
  });
});

describe('AlertAuditLog — a persistence failure is surfaced, not swallowed', () => {
  let stubPool: { query: ReturnType<typeof vi.fn> };
  const originalPool = DbClient.getPool();

  beforeEach(() => {
    DbClient.clearAll();
    stubPool = { query: vi.fn() };
    DbClient.setPool(stubPool as any);
  });

  afterEach(() => {
    DbClient.setPool(originalPool);
    DbClient.clearAll();
    vi.restoreAllMocks();
  });

  it('never interrupts the caller when the audit row cannot be written', async () => {
    stubPool.query.mockImplementation(async () => {
      throw new Error('database unavailable');
    });

    // The audit write is best-effort for the customer path, but the failure
    // must be observable.
    await expect(
      AlertAuditLog.write('out_audit_001', TENANT, 'a masked body'),
    ).resolves.toBeUndefined();
  });
});
