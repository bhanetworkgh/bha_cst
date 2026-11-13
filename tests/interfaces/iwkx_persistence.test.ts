import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
