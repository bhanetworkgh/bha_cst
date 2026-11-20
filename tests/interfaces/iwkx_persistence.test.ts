import { beforeEach, afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { ElevenLabsWebhookService as Service } from '../../engine/src/interfaces/elevenlabs/service.js';
import { DbClient } from '../../engine/src/db/client.js';
import { FailureDetector } from '../../engine/src/observability/failure_detector.js';
import { CutOverManager } from '../../engine/src/observability/cut_over.js';

const io = vi.hoisted(() => ({post:vi.fn(), publish:vi.fn(), alert:vi.fn()}));
vi.mock('../../engine/src/notifications/call_log.js', () => ({
  CallLogPoster:{post:io.post}, collected:()=>undefined, endedRecord:()=>({}),
}));
vi.mock('../../engine/src/publishers/dashboard.js', () => ({getDashboardPublisher:()=>({publish:io.publish})}));
vi.mock('../../engine/src/notifications/error_router.js', () => ({ErrorRouter:{route:io.alert}}));

const DB_ENABLED = process.env.CST_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);

describe('IWKX required lifecycle persistence', () => {
  let query: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  const payload = {
    type:'post_call_transcription' as const, conversation_id:'conv_iwkx_local',
    start_time_unix_secs:1794056700,
    metadata:{phone_call:{external_number:'+12025550123'}},
    transcript:[{role:'user' as const,message:'Local test'}],
  };
  beforeEach(() => {
    Service.reset(); FailureDetector.reset(); DbClient.clearInMemory(); CutOverManager.reset();
    CutOverManager.configure({start_timestamp:'2026-11-03T00:00:00Z'});
    vi.clearAllMocks();
    io.post.mockResolvedValue({posted:true}); io.publish.mockResolvedValue({success:true});
    io.alert.mockResolvedValue({dispatched:true});
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network blocked')));
    query=vi.fn().mockResolvedValue({rows:[],rowCount:1}); release=vi.fn();
    DbClient.setPool({query,connect:async()=>({query,release})} as any);
  });
  afterEach(()=>{DbClient.setPool(null);vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});

  it('fails closed without a database outside the test runner', async()=>{
    vi.spyOn(DbClient as any, 'getPool').mockReturnValue(null);
    vi.stubEnv('VITEST', 'false');
    expect((await Service.process(payload)).status).toBe('failed');
    expect(io.post).not.toHaveBeenCalled();
    expect(io.publish).not.toHaveBeenCalled();
  });

  it('retries after a connection acquisition failure without dispatching early', async()=>{
    const connect=vi.fn().mockRejectedValueOnce(new Error('pool exhausted'))
      .mockResolvedValue({query,release});
    DbClient.setPool({query,connect} as any);
    expect((await Service.process(payload)).status).toBe('failed');
    expect(io.post).not.toHaveBeenCalled();
    expect((await Service.process(payload)).status).toBe('processed');
    expect(io.post).toHaveBeenCalledTimes(1);
  });

  it('does not create an escalation when lifecycle persistence fails', async()=>{
    const escalation=vi.spyOn(DbClient,'createEscalationRecord');
    query.mockRejectedValue(new Error('database unavailable'));
    expect((await Service.process({...payload,analysis:{evaluation_criteria_results:{human_handoff:true}}})).status).toBe('failed');
    expect(escalation).not.toHaveBeenCalled();
    expect(io.post).not.toHaveBeenCalled();
  });

  it('discards the pooled connection if rollback also fails', async()=>{
    query.mockRejectedValue(new Error('connection lost'));
    expect((await Service.process(payload)).status).toBe('failed');
    expect(release).toHaveBeenCalledWith(true);
  });

  it('rolls back a partial write, alerts, and allows redelivery before any customer dispatch', async()=>{
    let inserts=0;
    query.mockImplementation(async(sql:string)=>{
      if(sql.includes('INSERT') && ++inserts===2) throw new Error('synthetic insert failure');
      return {rows:[],rowCount:1};
    });
    const failed=await Service.process(payload);
    expect(failed.status).toBe('failed');
    expect(query.mock.calls.map(([sql])=>sql)).toContain('ROLLBACK');
    expect(query.mock.calls.map(([sql])=>sql)).not.toContain('COMMIT');
    expect(release).toHaveBeenCalledTimes(1);
    expect(Service.getPersistedEvents()).toHaveLength(0);
    expect(io.publish).not.toHaveBeenCalled(); expect(io.post).not.toHaveBeenCalled();
    expect(io.alert).toHaveBeenCalledWith(expect.objectContaining({service:'CST',category:'webhook_persistence'}));
    const retry=await Service.process(payload);
    expect(retry.status).toBe('processed');
    expect(query.mock.calls.map(([sql])=>sql)).toContain('COMMIT');
    expect(io.post).toHaveBeenCalledTimes(1);
    expect((await Service.process(payload)).status).toBe('already_processed');
    expect(io.post).toHaveBeenCalledTimes(1);
  });

  it('does not report success or dispatch when COMMIT fails', async()=>{
    query.mockImplementation(async(sql:string)=>{if(sql==='COMMIT') throw new Error('commit disconnected');return {rows:[],rowCount:1};});
    expect((await Service.process(payload)).status).toBe('failed');
    expect(Service.getPersistedEvents()).toHaveLength(0);
    expect(io.post).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);
  });

  it('uses stable lifecycle row IDs on redelivery after an ambiguous commit', async()=>{
    query.mockImplementation(async(sql:string)=>{if(sql==='COMMIT') throw new Error('commit response lost');return {rows:[],rowCount:1};});
    await Service.process(payload);
    const first=query.mock.calls.filter(([sql])=>sql.includes('INSERT')).map(([,args])=>args[0]);
    query.mockClear();query.mockResolvedValue({rows:[],rowCount:1});
    expect((await Service.process(payload)).status).toBe('processed');
    const second=query.mock.calls.filter(([sql])=>sql.includes('INSERT')).map(([,args])=>args[0]);
    expect(second).toEqual(first);
    expect(query.mock.calls.filter(([sql])=>sql.includes('INSERT')).every(([sql])=>sql.includes('ON CONFLICT (id) DO NOTHING'))).toBe(true);
  });
});

if (!DB_ENABLED) {
  describe('IWKX required lifecycle persistence — real PostgreSQL transaction (requires CST_DB_TESTS=1 and DATABASE_URL, skipped)', () => {
    it('is skipped because no real PostgreSQL database is configured for these tests', () => {
      expect(DB_ENABLED).toBe(false);
    });
  });
} else {
  describe('IWKX required lifecycle persistence — real PostgreSQL transaction (Stage D)', () => {
    const suffix = `${Date.now()}`;
    const tenantId = 'tenant-vfarm-01';
    const projectId = 'proj-vfarm-main';
    const createdConversationIds: string[] = [];
    let realPool: pg.Pool;

    const expectedLifecycleIds = (convId: string, kinds = ['start', 'trsc', 'outc']) =>
      kinds.map(
        (kind) =>
          `dpo_evt_${kind}_${createHash('sha256')
            .update(JSON.stringify(['elevenlabs', tenantId, projectId, convId, kind]))
            .digest('hex')}`,
      );

    beforeAll(async () => {
      realPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
      await realPool.query('SELECT id, event_id, event_type, status FROM dashboard_publish_outcomes LIMIT 1');
      await realPool.query('SELECT id, conversation_id, status FROM escalations LIMIT 1');
    });

    beforeEach(() => {
      Service.reset();
      FailureDetector.reset();
      DbClient.clearInMemory();
      CutOverManager.reset();
      CutOverManager.configure({ start_timestamp: '2026-11-03T00:00:00Z' });
      vi.clearAllMocks();
      io.post.mockResolvedValue({ posted: true });
      io.publish.mockResolvedValue({ success: true });
      io.alert.mockResolvedValue({ dispatched: true });
      DbClient.setPool(realPool);
    });

    afterEach(() => {
      DbClient.setPool(null);
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (realPool && createdConversationIds.length > 0) {
        await realPool.query('DELETE FROM dashboard_publish_outcomes WHERE correlation_id = ANY($1)', [
          createdConversationIds,
        ]);
        await realPool.query('DELETE FROM escalations WHERE conversation_id = ANY($1)', [
          createdConversationIds,
        ]);
      }
      if (realPool) {
        await realPool.end();
      }
    });

    it('1 & 2. writes all required lifecycle rows in one real PostgreSQL transaction and commits before customer/dashboard dispatch', async () => {
      const convId = `conv_pg_atomic_${suffix}_1`;
      createdConversationIds.push(convId);

      let rowsVisibleDuringPublish = 0;
      let rowsVisibleDuringSlackPost = 0;

      io.publish.mockImplementation(async () => {
        const check = await realPool.query(
          `SELECT count(*)::int AS cnt FROM dashboard_publish_outcomes WHERE correlation_id = $1 AND status = 'internal_only'`,
          [convId],
        );
        rowsVisibleDuringPublish = check.rows[0].cnt;
        return { success: true };
      });

      io.post.mockImplementation(async () => {
        const check = await realPool.query(
          `SELECT count(*)::int AS cnt FROM dashboard_publish_outcomes WHERE correlation_id = $1 AND status = 'internal_only'`,
          [convId],
        );
        rowsVisibleDuringSlackPost = check.rows[0].cnt;
        return { posted: true };
      });

      const result = await Service.process({
        type: 'post_call_transcription',
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+12025550123' } },
        transcript: [{ role: 'user', message: 'Real Postgres transaction check' }],
        analysis: { evaluation_criteria_results: { human_handoff: true } },
      });

      expect(result.status).toBe('processed');
      expect(result.events_count).toBe(4);
      // All 4 lifecycle rows (start, trsc, outc, escl) were already committed in PostgreSQL before publish or Slack post ran
      expect(rowsVisibleDuringPublish).toBe(4);
      expect(rowsVisibleDuringSlackPost).toBe(4);

      const dbRows = await realPool.query(
        `SELECT id, event_id, event_type, status FROM dashboard_publish_outcomes WHERE correlation_id = $1 ORDER BY event_type ASC`,
        [convId],
      );
      expect(dbRows.rows).toHaveLength(4);
      expect(dbRows.rows.map((r) => r.event_type)).toEqual([
        'cst.escalation',
        'cst.interaction.start',
        'cst.outcome',
        'cst.transcript',
      ]);
      expect(dbRows.rows.map((r) => r.id).sort()).toEqual(
        expectedLifecycleIds(convId, ['start', 'trsc', 'outc', 'escl']).sort(),
      );
    });

    it('3, 6 & 7. rolls back all partial writes on mid-transaction SQL failure, returns failed for redelivery, and withholds dispatch', async () => {
      const convId = `conv_pg_rollback_${suffix}_2`;
      createdConversationIds.push(convId);

      // Force the 3rd INSERT inside the real PostgreSQL transaction to fail with a NOT NULL constraint violation on event_type
      let insertCount = 0;
      const client = await realPool.connect();
      const origQuery = client.query.bind(client);
      const origRelease = client.release.bind(client);
      const connectSpy = vi.spyOn(realPool, 'connect').mockImplementationOnce((async () => {
        client.query = (async (text: any, values?: any) => {
          if (typeof text === 'string' && text.includes('INSERT INTO dashboard_publish_outcomes')) {
            insertCount++;
            if (insertCount === 3 && Array.isArray(values)) {
              const badValues = [...values];
              badValues[2] = null; // event_type is NOT NULL in PostgreSQL -> triggers 23502 constraint error
              return origQuery(text, badValues);
            }
          }
          return origQuery(text, values);
        }) as any;
        client.release = ((err?: any) => {
          client.query = origQuery as any;
          client.release = origRelease as any;
          return origRelease(err);
        }) as any;
        connectSpy.mockRestore();
        return client;
      }) as any);

      const failedResult = await Service.process({
        type: 'post_call_transcription',
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+12025550123' } },
        transcript: [{ role: 'user', message: 'Should roll back on 3rd insert' }],
      });

      expect(failedResult.status).toBe('failed');
      expect(failedResult.error).toBe('POST_CALL_PERSISTENCE_FAILED');
      expect(insertCount).toBe(3);

      // Verify PostgreSQL rolled back the first 2 INSERT statements: 0 rows exist in dashboard_publish_outcomes
      const afterRollback = await realPool.query(
        `SELECT count(*)::int AS cnt FROM dashboard_publish_outcomes WHERE correlation_id = $1`,
        [convId],
      );
      expect(afterRollback.rows[0].cnt).toBe(0);

      // Verify dispatch was completely withheld and error was routed
      expect(io.publish).not.toHaveBeenCalled();
      expect(io.post).not.toHaveBeenCalled();
      expect(io.alert).toHaveBeenCalledWith(
        expect.objectContaining({ service: 'CST', category: 'webhook_persistence' }),
      );

      // Verify redelivery now succeeds and commits all 3 rows cleanly
      const retryResult = await Service.process({
        type: 'post_call_transcription',
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+12025550123' } },
        transcript: [{ role: 'user', message: 'Should roll back on 3rd insert' }],
      });
      expect(retryResult.status).toBe('processed');
      const afterRetry = await realPool.query(
        `SELECT id FROM dashboard_publish_outcomes WHERE correlation_id = $1`,
        [convId],
      );
      expect(afterRetry.rows).toHaveLength(3);
      expect(io.post).toHaveBeenCalledTimes(1);
    });

    it('4 & 5. preserves stable deterministic row IDs across retry and ON CONFLICT (id) DO NOTHING prevents duplicate rows in PostgreSQL', async () => {
      const convId = `conv_pg_idemp_${suffix}_3`;
      createdConversationIds.push(convId);

      // First run commits in PostgreSQL, then we simulate a lost response by resetting in-memory idempotency state
      const first = await Service.process({
        type: 'post_call_transcription',
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+12025550123' } },
        transcript: [{ role: 'user', message: 'Idempotent retry check' }],
      });
      expect(first.status).toBe('processed');

      const firstRows = await realPool.query(
        `SELECT id, event_id, created_at FROM dashboard_publish_outcomes WHERE correlation_id = $1 ORDER BY id ASC`,
        [convId],
      );
      expect(firstRows.rows).toHaveLength(3);
      const firstIds = firstRows.rows.map((r) => r.id);
      expect(firstIds).toEqual(expectedLifecycleIds(convId).sort());

      // Simulate process restart / ambiguous commit redelivery
      Service.reset();
      DbClient.clearInMemory();

      const second = await Service.process({
        type: 'post_call_transcription',
        conversation_id: convId,
        start_time_unix_secs: 1794056700,
        metadata: { phone_call: { external_number: '+12025550123' } },
        transcript: [{ role: 'user', message: 'Idempotent retry check' }],
      });
      expect(second.status).toBe('processed');

      const secondRows = await realPool.query(
        `SELECT id, event_id, created_at FROM dashboard_publish_outcomes WHERE correlation_id = $1 ORDER BY id ASC`,
        [convId],
      );
      expect(secondRows.rows).toHaveLength(3);
      expect(secondRows.rows.map((r) => r.id)).toEqual(firstIds);
      // Original created_at timestamps were preserved by ON CONFLICT (id) DO NOTHING
      expect(secondRows.rows.map((r) => new Date(r.created_at).toISOString())).toEqual(
        firstRows.rows.map((r) => new Date(r.created_at).toISOString()),
      );
    });
  });
}
