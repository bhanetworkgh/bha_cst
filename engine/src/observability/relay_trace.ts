import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Logger } from '../config/logger.js';

export interface RelayTrace {
  webhook_receive_id: string;
  provider_request_id: string | null;
  provider_request_id_source: string | null;
  provider_conversation_id: string | null;
  provider_call_sid: string | null;
  received_at: string;
  payload_sha256: string;
  committed_rows: Array<{ db_row_id: string; event_id: string }>;
}

const context = new AsyncLocalStorage<RelayTrace>();

// IDs only: never accept arbitrary text, URLs, signatures, or phone numbers.
export function traceId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}

export function createRelayTrace(rawBody: string, providerRequestId?: string, source?: string): RelayTrace {
  const id = traceId(providerRequestId);
  return {
    webhook_receive_id: `whr_${randomUUID()}`,
    provider_request_id: id,
    provider_request_id_source: id ? source || null : null,
    provider_conversation_id: null,
    provider_call_sid: null,
    received_at: new Date().toISOString(),
    payload_sha256: createHash('sha256').update(rawBody).digest('hex'),
    committed_rows: [],
  };
}

export function withRelayTrace<T>(trace: RelayTrace, fn: () => T): T {
  return context.run(trace, fn);
}

export function currentRelayTrace(): RelayTrace | undefined {
  return context.getStore();
}

/** Observation only: log failures must not alter delivery/error handling. */
export function traceRelay(stage: string, fields: Record<string, unknown> = {}): void {
  const trace = context.getStore();
  if (!trace) return;
  try {
    Logger.info('PBT5 relay trace', {
      trace_schema: 'pbt5.relay.v1',
      stage,
      ...fields,
      webhook_receive_id: trace.webhook_receive_id,
      provider_request_id: trace.provider_request_id,
      provider_request_id_source: trace.provider_request_id_source,
      provider_conversation_id: trace.provider_conversation_id,
      provider_call_sid: trace.provider_call_sid,
      received_at: trace.received_at,
      payload_sha256: trace.payload_sha256,
      deployed_commit: traceId(process.env.RENDER_GIT_COMMIT),
    });
  } catch { /* Tracing is not a new failure path. */ }
}

export function traceDatabaseWrite(
  status: 'committed' | 'failed' | 'memory_only', dbRowId: string, eventId: string,
): void {
  const trace = context.getStore();
  if (!trace) return;
  if (status === 'committed') trace.committed_rows.push({ db_row_id: dbRowId, event_id: eventId });
  traceRelay('db_write', { persistence: status, db_row_id: dbRowId, event_id: eventId });
}
