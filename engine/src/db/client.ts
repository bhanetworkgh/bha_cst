import { maskPhone } from '../util/privacy.js';
import { InboundMessage, OutboundMessage } from '../transport/twilio/types.js';
import { randomUUID } from 'crypto';
import pg from 'pg';
import { Logger } from '../config/logger.js';
import type { SecurityLedgerEvent } from '../config/logger.js';
import { shouldAutoCreatePool } from '../config/runtime.js';
import type { AlertAuditRow } from '../audit/alert_audit.js';
import type { EscalationRecord } from '../escalation/types.js';
import { CoreRegistry } from '../core/registry.js';
import { deliveryStatusRank } from '../contracts/events.js';
import type { Project, ServiceNumberBinding, Tenant } from '../core/types.js';

/**
 * Raised when an outbound message row could not be persisted.
 *
 * The `messages_out` row is the durable parent of:
 *   - `alert_audit_log.outbound_message_id` (FK, ON DELETE CASCADE);
 *   - the delivery-status callback's attribution (`provider_sid` join);
 *   - the queue the worker drains.
 *
 * When the INSERT fails there is no parent row, so any child write would
 * violate the foreign key and the message would never be queued. Callers
 * MUST abandon the turn rather than continue with an id that has no row —
 * that id is exactly what produces an `alert_audit_log` foreign-key
 * violation. The constraint is correct and is deliberately left in place.
 */
export class OutboundPersistenceError extends Error {
  public readonly code = 'OUTBOUND_PERSISTENCE_FAILED';
  constructor(
    message: string,
    public readonly tenantId: string,
    public readonly outboundMessageId: string,
  ) {
    super(message);
    this.name = 'OutboundPersistenceError';
  }
}

export interface CustomerRecord {
  phone_e164:       string;
  customer_ref:     string;
  organization_id?: string;
  tenant_id:        string;
  project_id?:      string;
  workspace_id?:    string;
  role?:            'owner' | 'manager' | 'tech';
  unit_id?:         string;
  farm_id?:         string;
  farm_ids?:        string[];
  speaker_cache_expires_at?: string;
  created_at?:      string;
}

/**
 * Maximum time a database CONNECT may take before the pool gives up.
 *
 * Without this, `pg` waits forever for a connection and a hibernating or
 * unreachable PostgreSQL silently stalls every caller — including the
 * delivery-status webhook, which is what produced Twilio error 11203.
 */
export const DB_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Maximum time a single statement may run before PostgreSQL cancels it.
 */
export const DB_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * How long a claimed outbound message may stay in `sending` before another
 * worker is allowed to reclaim it.
 *
 * The claim is a lease, not a lock: `claimOutboundMessage` flips the row to
 * `sending` and the row is invisible to `getPendingOutboundMessages` until it
 * reaches a terminal state. If the process dies between the claim and the
 * completion (a deploy, a crash, an OOM kill, a free-tier instance being
 * destroyed), the row stayed in `sending` FOREVER — never selected, never
 * claimable, never failed, never dead-lettered. The message was silently lost.
 *
 * The lease must be LONGER than the worst-case time a live worker can hold a
 * claim, so a healthy in-flight send is never stolen and duplicated. The
 * worst case is three attempts, each bounded by the Twilio send timeout, plus
 * the retry backoff — comfortably under a minute — so five minutes is a safe
 * margin that still recovers a stranded message within minutes rather than
 * hours.
 */
export const OUTBOUND_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Raised when a conversation row could not be persisted.
 *
 * Callers MUST abandon the turn rather than continue with the in-memory
 * conversation id: that id has no row in `conversations`, so any message written
 * against it would violate `messages_conversation_id_fkey`. The FK constraints
 * are correct and are deliberately left in place — this error is the alternative
 * to weakening them.
 */
export class ConversationPersistenceError extends Error {
  public readonly code = 'CONVERSATION_PERSISTENCE_FAILED';
  constructor(
    message: string,
    public readonly tenantId: string,
    public readonly customerRef: string,
  ) {
    super(`Conversation could not be persisted for tenant ${tenantId}: ${message}`);
    this.name = 'ConversationPersistenceError';
  }
}

/**
 * The durable outcome of one Dashboard publish attempt.
 *
 * `status` is one of:
 *   - 'published'            — the Dashboard accepted the event (2xx).
 *   - 'failed'               — the publish was attempted and did not succeed.
 *   - 'missing_configuration'— the publisher had no Dashboard URL/key configured.
 *   - 'dry_run'              — validated locally; no remote request was made.
 */
export interface DashboardPublishOutcome {
  id?: string;
  event_id: string;
  event_type: string;
  specversion?: string;
  turn_id?: string;
  correlation_id?: string;
  tenant_id?: string;
  project_id?: string;
  status: 'published' | 'failed' | 'missing_configuration' | 'dry_run';
  http_status?: number;
  attempts: number;
  error?: string;
  /** Masked, TTL-bounded copy of the published event, so it can be replayed. */
  payload?: Record<string, unknown>;
  created_at?: string;
  expires_at?: string;
  replayed_at?: string;
}

/** Retention for a replayable publish outcome, matching the alert audit TTL. */
export const DASHBOARD_OUTCOME_TTL_DAYS = 90;

export interface VoiceDeliveryRecord {
  id?: string;
  system_id?: string;
  project_id?: string;
  tenant_id: string;
  conversation_id?: string;
  message_id?: string;
  status: 'synthesized' | 'sent' | 'failed' | 'refused';
  voice_id?: string;
  model_id?: string;
  character_count: number;
  audio_bytes: number;
  mime_type?: string;
  error_code?: string;
  error_message?: string;
  correlation_id?: string;
  delivered_at?: string;
  created_at?: string;
}

export interface VoiceDeliveryRecord {
  id?: string;
  system_id?: string;
  project_id?: string;
  tenant_id: string;
  conversation_id?: string;
  message_id?: string;
  status: 'synthesized' | 'sent' | 'failed' | 'refused';
  voice_id?: string;
  model_id?: string;
  character_count: number;
  audio_bytes: number;
  mime_type?: string;
  error_code?: string;
  error_message?: string;
  correlation_id?: string;
  delivered_at?: string;
  created_at?: string;
}

export type ConsentStatus = 'opted_in' | 'opted_out' | 'not_consented';

export interface SmsConsentRecord {
  id: string;
  tenant_id: string;
  project_id: string | null;
  phone_e164: string;
  consent_status: ConsentStatus;
  consented_at: string | null;
  opted_out_at: string | null;
  wording_version: string;
  wording_snapshot: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface SmsConsentAuditRow {
  id: string;
  consent_id: string;
  tenant_id: string;
  project_id: string | null;
  phone_e164: string;
  action: string;
  previous_status: ConsentStatus | null;
  new_status: ConsentStatus;
  wording_version: string | null;
  wording_snapshot: string | null;
  source: string | null;
  actor: string;
  reason: string | null;
  correlation_id: string | null;
  created_at: string;
}

export class DbClient {

  // In-memory stores for unit testing / fast fallback
  private static messagesInStore:       Map<string, InboundMessage>      = new Map();
  private static messagesOutStore:      Map<string, OutboundMessage>     = new Map();
  private static conversationsStore:    Map<string, any>                 = new Map();
  private static transcriptsStore:      Map<string, any>                 = new Map();
  private static customersStore:        Map<string, CustomerRecord>      = new Map();
  private static voiceDeliveriesStore:  Map<string, VoiceDeliveryRecord> = new Map();
  private static dashboardOutcomeStore: Map<string, DashboardPublishOutcome> = new Map();
  private static projectsStore:         Map<string, Project>             = new Map();
  private static bindingsStore:         Map<string, ServiceNumberBinding>= new Map();
  private static tenantsStore:          Map<string, Tenant>              = new Map();
  private static alertAuditStore:       AlertAuditRow[]                  = [];
  private static smsConsentsStore:      Map<string, SmsConsentRecord>    = new Map();
  private static smsConsentAuditStore:  SmsConsentAuditRow[]             = [];
  /**
   * In-memory store for active consent prompts (sms_consent_prompts).
   * Accessed by the consent service for fast prompt lookups during YES/START handling.
   */
  static smsConsentPromptsStore: Map<string, any> = new Map();
  private static escalationsStore: Map<string, EscalationRecord> = new Map();
  private static pool: pg.Pool | null = null;

  static getPool(): pg.Pool | null {
    if (this.pool) return this.pool;
    // Never auto-create a pool inside a test runner. This used to key off
    // `NODE_ENV !== 'test'`, which broke whenever the shell had the repo's
    // `.env` sourced (it sets NODE_ENV=development): unit tests then opened a
    // live database and 76 tests across 14 files failed for that reason alone.
    // Real-DB tests opt in with CST_DB_TESTS=1 and inject a pool via setPool().
    if (!shouldAutoCreatePool()) {
      return this.pool;
    }
    try {
      this.pool = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 10,
        idleTimeoutMillis: 30000,
        // BOUNDED CONNECT + BOUNDED STATEMENTS.
        //
        // `pg` defaults `connectionTimeoutMillis` to 0, i.e. it waits for a
        // free/establishable connection FOREVER. On a managed PostgreSQL that
        // is hibernating, restarting, or unreachable, every caller of
        // `pool.query()` would then hang indefinitely.
        //
        // That is not a theoretical concern for this service: the outbound
        // worker's claim/status writes and the Twilio delivery-status webhook
        // both run through this pool. A stalled connection therefore blocked
        // the webhook handler (Twilio gave up on the callback — error 11203)
        // and starved the outbound queue for as long as the stall lasted.
        //
        // `statement_timeout` does the same for a query that connects but
        // never returns (a lock wait, for example).
        connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
        statement_timeout: DB_STATEMENT_TIMEOUT_MS,
      });
      Logger.info('DbClient: Initialized PostgreSQL database connection pool');
    } catch (err: any) {
      Logger.warn(`DbClient: Failed to initialize Postgres pool: ${err.message}`);
    }
    return this.pool;
  }

  static setPool(pool: pg.Pool | null): void {
    this.pool = pool;
  }

  /**
   * Close the PostgreSQL connection pool and release all connections.
   * Idempotent — safe to call multiple times or when no pool exists.
   * Called during graceful shutdown (SIGTERM/SIGINT) and test teardown.
   */
  static async disconnect(): Promise<void> {
    const pool = this.pool;
    if (!pool) return;
    this.pool = null; // Prevent new queries from using the closing pool
    try {
      await pool.end();
      Logger.info('DbClient: PostgreSQL connection pool closed');
    } catch (err: any) {
      Logger.warn(`DbClient: Error closing PostgreSQL pool: ${err.message}`);
    }
  }

  /**
   * Reset all in-memory stores (for test teardown).
   * Does NOT touch the database pool.
   */
  static clearInMemory(): void {
    this.messagesInStore.clear();
    this.messagesOutStore.clear();
    this.conversationsStore.clear();
    this.transcriptsStore.clear();
    this.customersStore.clear();
    this.voiceDeliveriesStore.clear();
    this.projectsStore.clear();
    this.bindingsStore.clear();
    this.tenantsStore.clear();
    this.alertAuditStore.splice(0);
    this.smsConsentsStore.clear();
    this.smsConsentAuditStore.splice(0);
    this.smsConsentPromptsStore.clear();
    this.escalationsStore.clear();
    // Publish outcomes are test-visible state: leaving them behind lets one
    // test file's publishes surface in the next file's dead-letter view.
    this.dashboardOutcomeStore.clear();
  }

  /**
   * Save inbound message and handle MessageSid deduplication.
   * Return isDuplicate: true if message_id was already present.
   */
  static async saveInboundMessage(msg: InboundMessage): Promise<{ isDuplicate: boolean }> {
    const isDuplicate = this.messagesInStore.has(msg.message_id);
    if (!isDuplicate) {
      this.messagesInStore.set(msg.message_id, { ...msg });
    }

    const pool = this.getPool();
    if (pool) {
      try {
        // project_id included since migration 010; column is nullable for older rows.
        const query = `
          INSERT INTO messages_in (message_id, tenant_id, project_id, from_e164, to_e164, body, media, received_at, status, correlation_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'enqueued', $9)
          ON CONFLICT (message_id) DO NOTHING
        `;
        const res = await pool.query(query, [
          msg.message_id,
          msg.tenant_id,
          (msg as any).project_id || null,
          msg.from_e164,
          msg.to_e164,
          msg.body,
          JSON.stringify(msg.media || []),
          msg.received_at || new Date().toISOString(),
          msg.correlation_id,
        ]);
        return { isDuplicate: res.rowCount === 0 };
      } catch (err: any) {
        Logger.error(`DbClient.saveInboundMessage Postgres Error: ${err.message}`);
      }
    }

    return { isDuplicate };
  }

  static async saveOutboundMessage(msg: OutboundMessage): Promise<OutboundMessage> {
    const id = msg.id || `out_${randomUUID()}`;
    const now = new Date().toISOString();
    const record: OutboundMessage = {
      ...msg,
      id,
      status: msg.status || 'pending',
      retry_count: msg.retry_count || 0,
      max_retries: msg.max_retries || 3,
      created_at: msg.created_at || now,
      updated_at: msg.updated_at || now,
    };
    this.messagesOutStore.set(id, record);

    const pool = this.getPool();
    if (pool) {
      try {
        // project_id since migration 010; turn_id since migration 013. Both are
        // nullable so legacy rows keep loading.
        const query = `
          INSERT INTO messages_out (id, tenant_id, project_id, from_e164, to_e164, body, media_url, correlation_id, turn_id, status, retry_count, error_message, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            retry_count = EXCLUDED.retry_count,
            error_message = EXCLUDED.error_message,
            from_e164 = EXCLUDED.from_e164,
            project_id = COALESCE(EXCLUDED.project_id, messages_out.project_id),
            turn_id = COALESCE(EXCLUDED.turn_id, messages_out.turn_id)
        `;
        await pool.query(query, [
          record.id,
          record.tenant_id,
          (record as any).project_id || null,
          record.from_e164 || null,
          record.to_e164,
          record.body,
          record.media_url || null,
          record.correlation_id,
          // Durable cst.turn <-> cst.delivery join key.
          record.turn_id || null,
          record.status,
          record.retry_count,
          record.error_message || null,
          record.created_at,
        ]);
      } catch (err: any) {
        // A FAILED PERSISTENCE MUST NOT BE REPORTED AS SUCCESS.
        //
        // The returned record carries an `id` that the caller will use to
        // write child rows — most importantly `alert_audit_log`, whose
        // `outbound_message_id` REFERENCES `messages_out(id)`. If this INSERT
        // failed there is no parent row, so the audit write fails with a
        // foreign-key violation and the message is not in the queue at all:
        // the customer never gets a reply, and the failure surfaces only as a
        // confusing constraint error far from its cause.
        //
        // So the failure is raised. Callers already handle it as a failed
        // turn rather than proceeding as though the reply was queued.
        Logger.error(`DbClient.saveOutboundMessage Postgres Error: ${err.message}`);
        throw new OutboundPersistenceError(err.message, msg.tenant_id, id);
      }
    }

    return record;
  }

  static async getPendingOutboundMessages(): Promise<OutboundMessage[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        // project_id (migration 010) and turn_id (migration 013) are read here so
        // the worker can resolve the sending number and publish correlated
        // delivery events from persisted state alone.
        const query = `
          SELECT id, tenant_id, project_id, from_e164, to_e164, body, media_url, correlation_id, turn_id, provider_sid, status, retry_count, error_message, created_at, next_retry_at
          FROM messages_out
          WHERE (status = 'pending') OR (status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
          ORDER BY created_at ASC
          LIMIT 50
        `;
        const res = await pool.query(query);
        const dbPending: OutboundMessage[] = res.rows.map((r) => ({
          id: r.id,
          tenant_id: r.tenant_id,
          project_id: r.project_id ?? undefined,
          from_e164: r.from_e164,
          to_e164: r.to_e164,
          body: r.body,
          media_url: r.media_url,
          correlation_id: r.correlation_id,
          turn_id: r.turn_id ?? undefined,
          provider_sid: r.provider_sid ?? undefined,
          status: r.status,
          retry_count: r.retry_count,
          error_message: r.error_message,
          created_at: r.created_at,
          // The retry schedule must survive the DB -> memory copy, otherwise
          // the in-memory view of a deferred retry disagrees with the row the
          // worker actually claimed.
          next_retry_at: r.next_retry_at ? new Date(r.next_retry_at).toISOString() : undefined,
        }));

        for (const msg of dbPending) {
          if (msg.id) this.messagesOutStore.set(msg.id, msg);
        }
        return dbPending;
      } catch (err: any) {
        Logger.error(`DbClient.getPendingOutboundMessages Postgres Error: ${err.message}`);
      }
    }

    const pending: OutboundMessage[] = [];
    const now = new Date();
    for (const msg of this.messagesOutStore.values()) {
      const isEligibleStatus = msg.status === 'pending' || msg.status === 'queued';
      if (isEligibleStatus) {
        if (msg.next_retry_at) {
          const scheduledTime = new Date(msg.next_retry_at);
          if (now >= scheduledTime) pending.push(msg);
        } else {
          pending.push(msg);
        }
      }
    }
    return pending;
  }

  /**
   * Atomically claim a pending or queued outbound message for processing.
   * Uses atomic conditional update (WHERE status IN ('pending', 'queued')) to ensure
   * exactly one worker can claim a message even under high concurrency.
   * Returns true if successfully claimed, false if already claimed or finished.
   */
  static async claimOutboundMessage(id: string): Promise<boolean> {
    const pool = this.getPool();
    if (pool) {
      try {
        const query = `
          UPDATE messages_out
          SET status = 'sending', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND (status = 'pending' OR status = 'queued')
          RETURNING id
        `;
        const res = await pool.query(query, [id]);
        const claimed = (res.rowCount ?? 0) > 0;
        if (claimed) {
          const msg = this.messagesOutStore.get(id);
          if (msg) {
            msg.status = 'sending';
            msg.updated_at = new Date().toISOString();
            this.messagesOutStore.set(id, msg);
          }
        }
        return claimed;
      } catch (err: any) {
        Logger.error(`DbClient.claimOutboundMessage Postgres Error: ${err.message}`);
        return false;
      }
    }

    const msg = this.messagesOutStore.get(id);
    if (!msg || (msg.status !== 'pending' && msg.status !== 'queued')) {
      return false;
    }
    msg.status = 'sending';
    msg.updated_at = new Date().toISOString();
    this.messagesOutStore.set(id, msg);
    return true;
  }

  static async updateOutboundStatus(
    id: string,
    status: OutboundMessage['status'],
    error?: string,
    retryCount?: number,
    nextRetryAt?: string
  ): Promise<boolean> {
    const msg = this.messagesOutStore.get(id);
    if (msg) {
      msg.status = status;
      msg.updated_at = new Date().toISOString();
      if (error !== undefined) msg.error_message = error;
      if (retryCount !== undefined) msg.retry_count = retryCount;
      if (nextRetryAt !== undefined) msg.next_retry_at = nextRetryAt;
      this.messagesOutStore.set(id, msg);
    }

    const pool = this.getPool();
    if (pool) {
      try {
        // `next_retry_at` MUST be persisted here.
        //
        // It used to be accepted and applied to the in-memory store only; the
        // UPDATE statement never mentioned the column. In production — where
        // the worker reads the queue from Postgres — that silently discarded
        // the retry schedule: a retriable failure was stored as `queued` with
        // `next_retry_at = NULL`, and `getPendingOutboundMessages` treats a
        // NULL `next_retry_at` as "due now". The documented exponential
        // backoff therefore never applied and every retry fired on the next
        // 5-second poll, burning all attempts within seconds and turning a
        // transient failure into a permanent one.
        //
        // `COALESCE` is used so that omitting `nextRetryAt` leaves an
        // existing schedule untouched instead of clearing it.
        const query = `
          UPDATE messages_out
          SET status = $1,
              error_message = COALESCE($2, error_message),
              retry_count = COALESCE($3, retry_count),
              next_retry_at = COALESCE($5, next_retry_at)
          WHERE id = $4
        `;
        await pool.query(query, [status, error || null, retryCount || null, id, nextRetryAt || null]);
        return true;
      } catch (err: any) {
        // A failed status write means the DURABLE state and the in-memory
        // state now disagree: the row is still `sending` in the database
        // while the worker believes it moved on. That is exactly the state
        // the lease recovery inspects, so it must be reported rather than
        // swallowed.
        Logger.error(`DbClient.updateOutboundStatus Postgres Error: ${err.message}`);
        Logger.infra({
          message: `Outbound message state could not be persisted (${status})`,
          commercial_impact:
            'The durable delivery state of an outbound message did not update. The message will be recovered by the lease reaper on the next pass and will not be re-sent if the provider already accepted it.',
          meta: { outbound_message_id: id, status, tenant_id: msg?.tenant_id || null },
        });
        return false;
      }
    }
    return true;
  }

  /**
   * Count the outbound messages in each state.
   *
   * Read-only. Used by the worker's heartbeat so an operator can tell
   * "the worker is running and the queue is empty" apart from "the worker is
   * not running at all" — from outside the process those look identical.
   */
  static async getOutboundQueueDepth(): Promise<{
    pending: number;
    queued: number;
    sending: number;
    failed: number;
    outcome_unknown: number;
  }> {
    const depth = { pending: 0, queued: 0, sending: 0, failed: 0, outcome_unknown: 0 };
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT status, COUNT(*)::int AS count FROM messages_out GROUP BY status`,
        );
        for (const row of res.rows || []) {
          switch (row.status) {
            case 'pending': depth.pending = row.count; break;
            case 'queued': depth.queued = row.count; break;
            case 'sending': depth.sending = row.count; break;
            case 'failed': depth.failed = row.count; break;
            case 'outcome_unknown': depth.outcome_unknown = row.count; break;
            default: break;
          }
        }
        return depth;
      } catch (err: any) {
        Logger.error(`DbClient.getOutboundQueueDepth Postgres Error: ${err.message}`);
      }
    }
    for (const msg of this.messagesOutStore.values()) {
      if (msg.status === 'pending') depth.pending++;
      else if (msg.status === 'queued') depth.queued++;
      else if (msg.status === 'sending') depth.sending++;
      else if (msg.status === 'failed') depth.failed++;
      else if (msg.status === 'outcome_unknown') depth.outcome_unknown++;
    }
    return depth;
  }

  /**
   * Recover outbound messages whose worker died mid-send.
   *
   * `claimOutboundMessage` flips a row to `sending` before the Twilio call.
   * If the process dies at that point the row stays in `sending` forever: it
   * is not selected by `getPendingOutboundMessages` (which only looks at
   * `pending` and `queued`), it cannot be claimed again (the claim only
   * accepts `pending`/`queued`), and nothing fails or dead-letters it. The
   * customer message was silently lost — it never became "delivered hours
   * later", it simply never went out.
   *
   * THE ROW IS NEVER RE-QUEUED. A stale claim carries one of two very
   * different meanings, and re-queueing either of them is unsafe:
   *
   *   - `provider_sid` IS SET — the provider returned a MessageSid, so the
   *     message WAS created. The status write is what failed. Re-queueing
   *     would deliver a SECOND copy to the customer. The truthful status is
   *     `sent`: the provider accepted it.
   *   - `provider_sid` IS NULL — the worker died around the dispatch, so it
   *     cannot be established whether the provider created the message. This
   *     is the same ambiguity as a send timeout, and re-queueing it would
   *     risk a duplicate.
   *
   * So a stale claim is moved to a state that is durable, visible and
   * reconcilable, and is NEVER re-dispatched automatically. The operator
   * reconciliation procedure is in the operations runbook.
   *
   * @returns the ids that were recovered, and how.
   */
  static async reclaimStaleOutboundMessages(
    leaseMs: number = OUTBOUND_CLAIM_LEASE_MS
  ): Promise<string[]> {
    const reclaimed: string[] = [];
    const now = Date.now();
    const cutoff = new Date(now - leaseMs).toISOString();

    const pool = this.getPool();
    if (pool) {
      try {
        // `provider_sid IS NOT NULL` -> the provider accepted the message:
        // record it as `sent` (truthful) and never re-dispatch it.
        const accepted = await pool.query(
          `UPDATE messages_out
              SET status = 'sent',
                  updated_at = CURRENT_TIMESTAMP
            WHERE status = 'sending'
              AND provider_sid IS NOT NULL
              AND updated_at IS NOT NULL
              AND updated_at < $1
            RETURNING id`,
          [cutoff],
        );
        for (const row of accepted.rows || []) {
          if (row.id) reclaimed.push(row.id);
        }

        // `provider_sid IS NULL` -> the outcome of the dispatch is unknown.
        // Park it so it is visible and reconcilable, and NOT re-dispatched.
        const unknown = await pool.query(
          `UPDATE messages_out
              SET status = 'outcome_unknown',
                  error_message = COALESCE(error_message, 'worker stopped mid-send; provider outcome unknown'),
                  updated_at = CURRENT_TIMESTAMP
            WHERE status = 'sending'
              AND provider_sid IS NULL
              AND updated_at IS NOT NULL
              AND updated_at < $1
            RETURNING id`,
          [cutoff],
        );
        for (const row of unknown.rows || []) {
          if (row.id) reclaimed.push(row.id);
        }
      } catch (err: any) {
        Logger.error(`DbClient.reclaimStaleOutboundMessages Postgres Error: ${err.message}`);
      }
    }

    // In-memory mode (no pool): the same rules apply to the local store.
    for (const msg of this.messagesOutStore.values()) {
      if (msg.status !== 'sending') continue;
      const updatedAt = msg.updated_at ? new Date(msg.updated_at).getTime() : 0;
      if (!updatedAt || now - updatedAt < leaseMs) continue;
      if (msg.provider_sid) {
        // The provider accepted the message.
        msg.status = 'sent';
      } else {
        // The dispatch outcome is unknown.
        msg.status = 'outcome_unknown';
        msg.error_message =
          msg.error_message || 'worker stopped mid-send; provider outcome unknown';
      }
      msg.next_retry_at = undefined;
      msg.updated_at = new Date().toISOString();
      this.messagesOutStore.set(msg.id!, msg);
      if (msg.id) reclaimed.push(msg.id);
    }

    if (reclaimed.length > 0) {
      Logger.warn(
        `Outbound worker recovered ${reclaimed.length} message(s) stuck in "sending" (lease expired) — a previous worker stopped mid-send. None were re-dispatched: accepted messages are marked "sent" and the rest are parked as "outcome_unknown" for operator reconciliation.`,
        { recovered_count: reclaimed.length },
      );
    }
    return reclaimed;
  }

  /** Record the Twilio from-number that was used to send this outbound message. */
  static async updateOutboundFromE164(id: string, fromE164: string): Promise<void> {
    const msg = this.messagesOutStore.get(id);
    if (msg) {
      msg.from_e164 = fromE164;
      this.messagesOutStore.set(id, msg);
    }

    const pool = this.getPool();
    if (pool) {
      try {
        await pool.query('UPDATE messages_out SET from_e164 = $1 WHERE id = $2', [fromE164, id]);
      } catch (err: any) {
        Logger.error(`DbClient.updateOutboundFromE164 Postgres Error: ${err.message}`);
      }
    }
  }

  /** Associate provider_sid (Twilio MessageSid) with an outbound message. */
  static async updateOutboundProviderSid(id: string, providerSid: string): Promise<void> {
    const msg = this.messagesOutStore.get(id);
    if (msg) {
      msg.provider_sid = providerSid;
      this.messagesOutStore.set(id, msg);
    }

    const pool = this.getPool();
    if (pool) {
      try {
        await pool.query('UPDATE messages_out SET provider_sid = $1 WHERE id = $2', [providerSid, id]);
      } catch (err: any) {
        Logger.error(`DbClient.updateOutboundProviderSid Postgres Error: ${err.message}`);
      }
    }
  }

  /**
   * Update delivery status across outbound queue and message transcripts by provider_sid or correlation_id.
   *
   * Monotonic: a delivery state never moves backwards. Once a terminal status
   * (delivered / undelivered / failed) is recorded, a late duplicate or regressing
   * callback (e.g. Twilio re-sending `sent`) leaves the stored state untouched.
   *
   * The accepted vocabulary is the RANKED subset of the outbound status
   * vocabulary. `sending` is deliberately excluded: in CST `sending` means
   * "claimed by a worker", and a provider-side status callback must never be
   * able to move a row into that state — such a row would be invisible to the
   * queue and could never be claimed or retried.
   *
   * Returns the resolved correlation context so the caller can build a
   * `cst.delivery` event whose `turn_id` matches the originating `cst.turn` and
   * whose `project_id` is never empty.
   */
  static async updateDeliveryStatusByProviderSid(
    providerSid: string,
    status: 'queued' | 'sent' | 'delivered' | 'failed' | 'undelivered',
    errorDetails?: string
  ): Promise<{
    updated: boolean;
    /** False when the incoming status was a duplicate or a regression. */
    advanced: boolean;
    tenant_id?: string;
    project_id?: string;
    message_id?: string;
    turn_id?: string;
    to_e164?: string;
    from_e164?: string;
    previous_status?: string;
  }> {
    let updated = false;
    let advanced = false;
    let resolvedTenantId: string | undefined;
    let resolvedProjectId: string | undefined;
    let resolvedMessageId: string | undefined;
    let resolvedTurnId: string | undefined;
    let resolvedTo: string | undefined;
    let resolvedFrom: string | undefined;
    let previousStatus: string | undefined;

    const incomingRank = deliveryStatusRank(status);

    for (const msg of this.messagesOutStore.values()) {
      if (msg.provider_sid === providerSid || msg.id === providerSid || msg.correlation_id?.includes(providerSid)) {
        previousStatus = msg.status;
        if (deliveryStatusRank(msg.status) >= incomingRank) {
          // Duplicate or backwards transition — keep the stored state.
          resolvedTenantId = msg.tenant_id;
          resolvedProjectId = msg.project_id;
          resolvedMessageId = msg.id;
          resolvedTurnId = msg.turn_id;
          resolvedTo = msg.to_e164;
          resolvedFrom = msg.from_e164;
          break;
        }
        msg.status = status;
        if (errorDetails) (msg as any).error_message = errorDetails;
        resolvedTenantId = msg.tenant_id;
        resolvedProjectId = msg.project_id;
        resolvedMessageId = msg.id;
        // turn_id is the cst.turn.turn_id join key; fall back to the
        // correlation_id, which the SMS ingress lane sets to the same value.
        resolvedTurnId = msg.turn_id || msg.correlation_id;
        resolvedTo = msg.to_e164;
        resolvedFrom = msg.from_e164;
        updated = true;
        advanced = true;
        break;
      }
    }

    for (const transcript of this.transcriptsStore.values()) {
      if (transcript.provider_sid === providerSid || transcript.message_id === providerSid) {
        if (deliveryStatusRank(transcript.delivery_status) < incomingRank) {
          transcript.delivery_status = status;
          if (errorDetails) transcript.error_message = errorDetails;
          advanced = true;
        }
        if (!resolvedTenantId) resolvedTenantId = transcript.tenant_id;
        if (!resolvedProjectId) resolvedProjectId = transcript.project_id;
        if (!resolvedTurnId) resolvedTurnId = transcript.message_id;
        updated = true;
        break;
      }
    }

    const pool = this.getPool();
    if (pool) {
      try {
        // `provider_sid` is the join column for a Twilio callback: it is the only
        // column that holds the MessageSid for a row written by the send path.
        // Matching on `id`/`correlation_id` alone (as this used to) matched
        // nothing once the process had restarted and the in-memory store was
        // empty, so delivery state stopped persisting AND the callback resolved
        // no tenant/project and refused to publish — real deliveries silently
        // vanished from the dashboard.
        //
        // EXACTLY ONE ROW IS UPDATED. `provider_sid` carries a plain (not
        // unique) index and the `correlation_id` fallback is a wildcard, so
        // the predicate could match more than one row. A single callback must
        // never mutate several messages — least of all messages belonging to
        // different tenants. The sub-select picks the single most recent
        // match, and the row's OWN tenant/project are what the event is
        // attributed to, so a callback can never cross a tenant boundary.
        const query1 = `
          UPDATE messages_out SET status = $1, error_message = $2
          WHERE id = (
            SELECT id FROM messages_out
            WHERE provider_sid = $3 OR id = $3 OR correlation_id LIKE $4
            ORDER BY created_at DESC
            LIMIT 1
          )
            AND COALESCE(
              (CASE status
                 WHEN 'pending' THEN 0
                 WHEN 'outcome_unknown' THEN 0
                 WHEN 'queued' THEN 1
                 WHEN 'sending' THEN 2
                 WHEN 'sent' THEN 3
                 ELSE 4 END),
              0
            ) < $5
          RETURNING tenant_id, project_id, id, turn_id, correlation_id, to_e164, from_e164
        `;
        const res1 = await pool.query(query1, [
          status,
          errorDetails || null,
          providerSid,
          `%${providerSid}%`,
          incomingRank,
        ]);
        if (res1.rowCount && res1.rowCount > 0) {
          updated = true;
          advanced = true;
          resolvedTenantId = res1.rows[0].tenant_id ?? resolvedTenantId;
          resolvedProjectId = res1.rows[0].project_id ?? resolvedProjectId;
          resolvedMessageId = res1.rows[0].id ?? resolvedMessageId;
          resolvedTurnId = res1.rows[0].turn_id ?? res1.rows[0].correlation_id ?? resolvedTurnId;
          resolvedTo = res1.rows[0].to_e164 ?? resolvedTo;
          resolvedFrom = res1.rows[0].from_e164 ?? resolvedFrom;
        }

        const query2 = `
          UPDATE messages SET delivery_status = $1
          WHERE message_id = (
            SELECT message_id FROM messages
            WHERE message_id = $2 OR provider_sid = $3
            ORDER BY created_at DESC
            LIMIT 1
          )
            AND COALESCE(
              (CASE delivery_status
                 WHEN 'received' THEN 0
                 WHEN 'pending' THEN 0
                 WHEN 'outcome_unknown' THEN 0
                 WHEN 'queued' THEN 1
                 WHEN 'sending' THEN 2
                 WHEN 'sent' THEN 3
                 ELSE 4 END),
              0
            ) < $4
          RETURNING tenant_id, project_id, message_id, from_e164, to_e164
        `;
        const res2 = await pool.query(query2, [status, providerSid, providerSid, incomingRank]);
        if (res2.rowCount && res2.rowCount > 0) {
          updated = true;
          advanced = true;
          if (!resolvedTenantId) resolvedTenantId = res2.rows[0].tenant_id;
          if (!resolvedProjectId) resolvedProjectId = res2.rows[0].project_id;
          if (!resolvedTurnId) resolvedTurnId = res2.rows[0].message_id;
        }

        // Correlation must survive a SUPPRESSED transition.
        //
        // The monotonic guard in both UPDATEs above means a duplicate or a
        // regression (e.g. a late `delivered` arriving for a message already
        // recorded as `failed`) legitimately updates no row — so `resolvedTurnId`
        // would still be undefined and the resulting cst.delivery event would go
        // out with no turn_id, silently breaking the cst.turn join for that
        // event. Read-only lookup so the join key is always resolvable.
        if (!resolvedTurnId || !resolvedTenantId || !resolvedProjectId) {
          const lookup = `
            SELECT tenant_id, project_id, id AS message_id, turn_id, correlation_id, to_e164, from_e164
            FROM messages_out
            WHERE provider_sid = $1 OR id = $1
            ORDER BY created_at DESC
            LIMIT 1
          `;
          const res3 = await pool.query(lookup, [providerSid]);
          if (res3.rowCount && res3.rowCount > 0) {
            const row = res3.rows[0];
            resolvedTenantId = resolvedTenantId ?? row.tenant_id;
            resolvedProjectId = resolvedProjectId ?? row.project_id;
            resolvedMessageId = resolvedMessageId ?? row.message_id;
            resolvedTurnId = resolvedTurnId ?? row.turn_id ?? row.correlation_id;
            resolvedTo = resolvedTo ?? row.to_e164;
            resolvedFrom = resolvedFrom ?? row.from_e164;
            updated = true;
          }
        }
      } catch (err: any) {
        Logger.error(`DbClient.updateDeliveryStatusByProviderSid Postgres Error: ${err.message}`);
      }
    }

    return {
      updated,
      advanced,
      tenant_id: resolvedTenantId,
      project_id: resolvedProjectId,
      message_id: resolvedMessageId,
      turn_id: resolvedTurnId,
      to_e164: resolvedTo,
      from_e164: resolvedFrom,
      previous_status: previousStatus,
    };
  }

  /**
   * Record a security ledger event to the `security_ledger` table.
   *
   * The event is persisted with a UUID primary key, timestamp, tenant_id,
   * actor, role, entry_point, tool_or_route, outcome, and optional reason
   * and correlation_id. This mirrors the structure defined in migration
   * 003_add_customers_and_security_ledger.sql (security_ledger table).
   *
   * Callers must ensure the event data is valid before calling this method.
   * If no pool is configured (in-memory mode), the event is only logged to
   * the in-memory audit ring buffer via Logger.audit() — see that method
   * for the in-memory path details.
   */
  static async recordSecurityLedgerEvent(event: SecurityLedgerEvent): Promise<void> {
    const pool = this.getPool();
    if (pool) {
      try {
        const id = event.id || `ledger_${randomUUID()}`;
        // Determine tripwire and level based on outcome, matching Logger.audit console output
        const tripwire = event.outcome === 'refused';
        const level = event.outcome === 'refused' ? 'WARN' : event.outcome === 'error' ? 'ERROR' : 'INFO';
        // reason is NOT NULL in the database; provide a default if not present
        const reason = event.reason || `security ledger ${event.outcome}`;
        const query = `
          INSERT INTO security_ledger (id, timestamp, tenant_id, actor, role, entry_point, tool_or_route, outcome, reason, correlation_id, tripwire, level)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `;
        await pool.query(query, [
          id,
          event.timestamp || new Date().toISOString(),
          event.tenant_id,
          event.actor,
          event.role,
          event.entry_point,
          event.tool_or_route,
          event.outcome,
          reason,
          event.correlation_id || null,
          tripwire,
          level,
        ]);
        Logger.info(`Security ledger event recorded: ${event.tool_or_route}`);
      } catch (err: any) {
        Logger.error(`DbClient.recordSecurityLedgerEvent Postgres Error: ${err.message}`);
      }
    } else {
      Logger.info(`Security ledger event (in-memory only): ${event.tool_or_route}`);
    }
  }

  /**
   * Resolve the authoritative `systems.system_id` for a tenant.
   *
   * `systems.tenant_id` is UNIQUE (db/migrations/001_initial_schema.sql:5), so a
   * tenant maps to exactly one system and this lookup is authoritative. Callers
   * that pass a `project_id` in the `systemId` slot therefore get the real value
   * instead of a string with no row in `systems` — which is what used to violate
   * `conversations_system_id_fkey`.
   *
   * Falls back to the caller's value when no pool is configured (in-memory mode)
   * or when the tenant genuinely has no system row yet, so behaviour outside
   * of Postgres is unchanged.
   */
  private static async resolveSystemIdForTenant(
    pool: pg.Pool,
    tenantId: string,
    fallback: string,
  ): Promise<string> {
    try {
      const res = await pool.query(
        `SELECT system_id FROM systems WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      if (res.rows.length > 0 && res.rows[0].system_id) {
        return res.rows[0].system_id;
      }
      Logger.warn(
        `DbClient: no systems row for tenant ${tenantId} — conversation FK parent missing (fail closed)`,
      );
      return fallback;
    } catch (err: any) {
      Logger.warn(
        `DbClient: systems lookup failed for tenant ${tenantId}: ${err.message}`,
      );
      return fallback;
    }
  }

  static async getOrCreateConversation(
    tenantId: string,
    systemId: string,
    customerRef: string,
    organizationId?: string,
    workspaceId?: string,
    projectId?: string
  ): Promise<{ conversation_id: string }> {
    const orgId = organizationId || tenantId;
    const wsId = workspaceId || '';
    const projId = projectId || null;
    // Key includes project_id so two projects for the same speaker produce separate conversations
    const key = `${orgId}:${projId || 'default'}:${customerRef}`;
    let conv = this.conversationsStore.get(key);
    if (!conv) {
      conv = {
        conversation_id: `conv_${randomUUID()}`,
        tenant_id: orgId,
        organization_id: orgId,
        workspace_id: wsId,
        project_id: projId,
        system_id: systemId,
        customer_ref: customerRef,
        channel: 'sms',
        state: 'open',
        incident_ids: [],
        created_at: new Date().toISOString(),
      };
      this.conversationsStore.set(key, conv);
    }

    const pool = this.getPool();
    if (pool) {
      // The database is the authority on system_id. Callers disagree about what
      // belongs here (engine.ts passed a project_id, router/index.ts passed
      // identity.system_id) and only the latter matched `systems`. Resolve it
      // from tenant_id so the FK is satisfied by construction.
      const authoritativeSystemId = await this.resolveSystemIdForTenant(
        pool,
        orgId,
        systemId,
      );
      conv.system_id = authoritativeSystemId;

      try {
        // ON CONFLICT now uses the (tenant_id, project_id, customer_ref) unique constraint
        // added in migration 010. Falls back gracefully for rows where project_id is NULL.
        const query = `
          INSERT INTO conversations (conversation_id, tenant_id, project_id, organization_id, workspace_id, system_id, customer_ref, channel, state, incident_ids, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'sms', 'open', '[]'::jsonb, NOW(), NOW())
          ON CONFLICT (tenant_id, project_id, customer_ref) DO UPDATE SET updated_at = NOW()
          RETURNING conversation_id
        `;
        const res = await pool.query(query, [
          conv.conversation_id,
          orgId,
          projId,
          orgId,
          wsId,
          authoritativeSystemId,
          customerRef,
        ]);
        if (res.rows.length > 0) {
          conv.conversation_id = res.rows[0].conversation_id;
          this.conversationsStore.set(key, conv);
        }
      } catch (err: any) {
        // Previously this was logged and swallowed, and the unpersisted in-memory
        // uuid was returned anyway. The caller then wrote a `messages` row against
        // that dangling id, which is exactly how `messages_conversation_id_fkey`
        // violations appeared: the conversation write had already failed. Fail
        // loudly instead so the caller can abandon the turn rather than persist an
        // orphan message.
        Logger.error(`DbClient.getOrCreateConversation Postgres Error: ${err.message}`);
        throw new ConversationPersistenceError(err.message, orgId, customerRef);
      }
    }

    return { conversation_id: conv.conversation_id };
  }

  /** Append an incident_id reference to a conversation record per spec §2 and §3 */
  static async addIncidentToConversation(conversationId: string, incidentId: string): Promise<void> {
    for (const conv of this.conversationsStore.values()) {
      if (conv.conversation_id === conversationId) {
        if (!conv.incident_ids.includes(incidentId)) {
          conv.incident_ids.push(incidentId);
        }
        conv.updated_at = new Date().toISOString();
        break;
      }
    }

    const pool = this.getPool();
    if (pool) {
      try {
        const query = `
          UPDATE conversations
          SET incident_ids = COALESCE(incident_ids, '[]'::jsonb) || JSONB_BUILD_ARRAY($1::text), updated_at = NOW()
          WHERE conversation_id = $2
        `;
        await pool.query(query, [incidentId, conversationId]);
      } catch (err: any) {
        Logger.error(`DbClient.addIncidentToConversation Postgres Error: ${err.message}`);
      }
    }
  }

  static async addMessageToTranscript(msg: {
    message_id: string;
    conversation_id: string;
    tenant_id: string;
    project_id?: string;
    direction: 'inbound' | 'outbound';
    from_e164: string;
    to_e164: string;
    body: string;
    media_refs?: string[];
    provider_sid?: string;
  }): Promise<void> {
    this.transcriptsStore.set(msg.message_id, {
      ...msg,
      created_at: new Date().toISOString(),
    });

    const pool = this.getPool();
    if (pool) {
      try {
        const query = `
          INSERT INTO messages (message_id, conversation_id, tenant_id, project_id, direction, from_e164, to_e164, body, media_refs, provider_sid, delivery_status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'received', NOW())
          ON CONFLICT (message_id) DO NOTHING
        `;
        await pool.query(query, [
          msg.message_id,
          msg.conversation_id,
          msg.tenant_id,
          msg.project_id || null,
          msg.direction,
          msg.from_e164,
          msg.to_e164,
          msg.body,
          JSON.stringify(msg.media_refs || []),
          msg.provider_sid || null,
        ]);
      } catch (err: any) {
        Logger.error(`DbClient.addMessageToTranscript Postgres Error: ${err.message}`);
      }
    }
  }

  static getInboundMessage(messageId: string): InboundMessage | undefined {
    return this.messagesInStore.get(messageId);
  }

  static getTranscriptCount(): number {
    return this.transcriptsStore.size;
  }

  static getConversationCount(): number {
    return this.conversationsStore.size;
  }

  static getAllConversations(): any[] {
    return Array.from(this.conversationsStore.values());
  }

  static getAllTranscripts(): any[] {
    return Array.from(this.transcriptsStore.values());
  }

  static getAllMessagesIn(): InboundMessage[] {
    return Array.from(this.messagesInStore.values());
  }

  static getAllMessagesOut(): OutboundMessage[] {
    return Array.from(this.messagesOutStore.values());
  }

  static lookupOutboundMessageByProviderSid(
    providerSid: string
  ): OutboundMessage | null {
    for (const msg of this.messagesOutStore.values()) {
      if (msg.provider_sid === providerSid) {
        return msg;
      }
    }
    return null;
  }

  static clearAll(): void {
    this.messagesInStore.clear();
    this.messagesOutStore.clear();
    this.conversationsStore.clear();
    this.transcriptsStore.clear();
    this.customersStore.clear();
    this.voiceDeliveriesStore.clear();
    this.alertAuditStore = [];
    this.smsConsentsStore.clear();
    this.smsConsentAuditStore.splice(0);
    this.smsConsentPromptsStore.clear();
    // Publish outcomes are test-visible state: leaving them behind lets one
    // test file's publishes surface in the next file's dead-letter view.
    this.dashboardOutcomeStore.clear();
  }

  static resetDurableStores(): void {
    this.projectsStore.clear();
    this.bindingsStore.clear();
    this.tenantsStore.clear();
  }

  // ── Customer Registry (mirrors `customers` table in Postgres) ─────────────

  static seedCustomer(record: CustomerRecord): void {
    const role = record.role || 'manager';
    const orgId = record.organization_id || record.tenant_id;
    const wsId = record.workspace_id || '';
    const cleanRecord: CustomerRecord = {
      ...record,
      role,
      organization_id: orgId,
      tenant_id: orgId,
      workspace_id: wsId,
      farm_ids: record.farm_ids || (record.farm_id ? [record.farm_id] : []),
    };

    if (record.project_id) {
      const projKey = `${orgId}:${record.project_id}:${record.phone_e164.trim()}`;
      this.customersStore.set(projKey, cleanRecord);
    }
    const key = `${orgId}:${record.phone_e164.trim()}`;
    this.customersStore.set(key, cleanRecord);
    // Also index under tenant_id for backwards compat key lookup
    if (record.tenant_id && record.tenant_id !== orgId) {
      this.customersStore.set(`${record.tenant_id}:${record.phone_e164.trim()}`, cleanRecord);
    }

    const pool = this.getPool();
    if (pool) {
      const query = `
        INSERT INTO customers (tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id, farm_ids)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        ON CONFLICT (tenant_id, project_id, phone_e164) DO UPDATE SET
          customer_ref    = EXCLUDED.customer_ref,
          organization_id = EXCLUDED.organization_id,
          workspace_id    = EXCLUDED.workspace_id,
          role            = EXCLUDED.role,
          unit_id         = EXCLUDED.unit_id,
          farm_id         = EXCLUDED.farm_id,
          farm_ids        = COALESCE(EXCLUDED.farm_ids, customers.farm_ids);
      `;
      pool
        .query(query, [
          cleanRecord.tenant_id,
          cleanRecord.project_id || null,
          cleanRecord.organization_id,
          cleanRecord.workspace_id,
          cleanRecord.phone_e164.trim(),
          cleanRecord.customer_ref,
          cleanRecord.role,
          cleanRecord.unit_id || null,
          cleanRecord.farm_id || null,
          JSON.stringify(cleanRecord.farm_ids || []),
        ])
        .catch((err) => Logger.error(`DbClient.seedCustomer Postgres Error: ${err.message}`));
    }
  }

  static seedConversation(conv: {
    conversation_id: string;
    tenant_id: string;
    project_id?: string;
    organization_id?: string;
    workspace_id?: string;
    system_id?: string;
    customer_ref?: string;
    channel?: string;
    state?: string;
    alert_state?: string | null;
    resolution_status?: string | null;
  }): void {
    const orgId = conv.organization_id || conv.tenant_id;
    const projId = conv.project_id || 'default';
    const cleanConv = {
      ...conv,
      organization_id: orgId,
      tenant_id: conv.tenant_id,
      project_id: conv.project_id,
      customer_ref: conv.customer_ref || 'cust_default',
      alert_state: conv.alert_state ?? null,
      resolution_status: conv.resolution_status ?? null,
    };
    const key = `${orgId}:${projId}:${cleanConv.customer_ref}`;
    this.conversationsStore.set(key, cleanConv);
    this.conversationsStore.set(`${orgId}:${cleanConv.customer_ref}`, cleanConv);
  }

  static lookupCustomerByPhone(
    phoneE164: string,
    tenantId: string,
    projectId?: string
  ): CustomerRecord | null {
    if (!phoneE164) return null;
    const cleanPhone = phoneE164.trim();
    if (projectId) {
      const projRecord = this.customersStore.get(`${tenantId}:${projectId}:${cleanPhone}`);
      if (projRecord) return projRecord;
    }
    const key = `${tenantId}:${cleanPhone}`;
    return this.customersStore.get(key) ?? null;
  }

  /**
   * Async customer lookup scoped to (tenant_id, project_id, phone_e164) per R-NUM-P4.
   * project_id is required — same phone in two projects has separate membership.
   * Falls back to in-memory cache (seed data / test) when Postgres is unavailable.
   */
  static async lookupCustomerByPhoneAsync(
    phoneE164: string,
    tenantId: string,
    projectId?: string
  ): Promise<CustomerRecord | null> {
    if (!phoneE164) return null;
    const cleanPhone = phoneE164.trim();
    // Fast path: in-memory hit
    const memRecord = this.lookupCustomerByPhone(cleanPhone, tenantId, projectId);
    if (memRecord) return memRecord;

    // Slow path: Postgres lookup — scoped by project_id when provided (migration 010+)
    const pool = this.getPool();
    if (pool) {
      try {
        const hasProjectId = !!projectId;
        const res = await pool.query(
          hasProjectId
            ? `SELECT tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id, farm_ids, speaker_cache_expires_at
               FROM customers WHERE (tenant_id = $1 OR organization_id = $1) AND project_id = $2 AND phone_e164 = $3`
            : `SELECT tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id, farm_ids, speaker_cache_expires_at
               FROM customers WHERE (tenant_id = $1 OR organization_id = $1) AND phone_e164 = $2 ORDER BY speaker_cache_expires_at DESC NULLS LAST LIMIT 1`,
          hasProjectId ? [tenantId, projectId, cleanPhone] : [tenantId, cleanPhone]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          // Honor TTL: if speaker_cache_expires_at is set and in the past, treat as miss
          if (row.speaker_cache_expires_at && new Date(row.speaker_cache_expires_at) < new Date()) {
            Logger.warn(`DbClient.lookupCustomerByPhoneAsync: cache row expired for ${maskPhone(cleanPhone)} in project ${projectId}`);
            return null;
          }
          const record: CustomerRecord = {
            tenant_id:       row.tenant_id,
            project_id:      row.project_id || projectId,
            organization_id: row.organization_id || row.tenant_id,
            workspace_id:    row.workspace_id || '',
            phone_e164:      row.phone_e164,
            customer_ref:    row.customer_ref,
            role:            (row.role as 'owner' | 'manager' | 'tech') || 'manager',
            unit_id:         row.unit_id || undefined,
            farm_id:         row.farm_id || undefined,
            farm_ids:        row.farm_ids || (row.farm_id ? [row.farm_id] : []),
          };
          // Populate in-memory cache
          if (projectId) {
            this.customersStore.set(`${tenantId}:${projectId}:${cleanPhone}`, record);
          }
          this.customersStore.set(`${tenantId}:${cleanPhone}`, record);
          return record;
        }
      } catch (err: any) {
        Logger.error(`DbClient.lookupCustomerByPhoneAsync Postgres Error: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Retrieve all customers/speakers with optional tenant, project, role, and search filters.
   */
  static async getAllCustomers(
    tenantId?: string,
    projectId?: string,
    role?: string,
    search?: string
  ): Promise<CustomerRecord[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const conditions: string[] = [];
        const params: any[] = [];

        if (tenantId) {
          params.push(tenantId);
          conditions.push(`(tenant_id = $${params.length} OR organization_id = $${params.length})`);
        }
        if (projectId) {
          params.push(projectId);
          conditions.push(`project_id = $${params.length}`);
        }
        if (role) {
          params.push(role);
          conditions.push(`role = $${params.length}`);
        }
        if (search) {
          params.push(`%${search.trim().toLowerCase()}%`);
          conditions.push(`(LOWER(phone_e164) LIKE $${params.length} OR LOWER(customer_ref) LIKE $${params.length})`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const query = `
          SELECT tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id, farm_ids, speaker_cache_expires_at, created_at
          FROM customers
          ${whereClause}
          ORDER BY tenant_id, project_id, phone_e164
        `;
        const res = await pool.query(query, params);
        return res.rows.map((row) => ({
          phone_e164: row.phone_e164,
          customer_ref: row.customer_ref,
          organization_id: row.organization_id,
          tenant_id: row.tenant_id,
          project_id: row.project_id,
          workspace_id: row.workspace_id,
          role: row.role,
          unit_id: row.unit_id,
          farm_id: row.farm_id,
          farm_ids: Array.isArray(row.farm_ids) ? row.farm_ids : (row.farm_ids ? JSON.parse(row.farm_ids) : []),
          speaker_cache_expires_at: row.speaker_cache_expires_at ? new Date(row.speaker_cache_expires_at).toISOString() : undefined,
          created_at: row.created_at ? new Date(row.created_at).toISOString() : undefined,
        }));
      } catch (err: any) {
        Logger.error(`DbClient.getAllCustomers Postgres Error: ${err.message}`);
      }
    }

    // In-memory fallback
    const seen = new Set<string>();
    const results: CustomerRecord[] = [];
    for (const record of this.customersStore.values()) {
      const uniqueKey = `${record.tenant_id}:${record.project_id || ''}:${record.phone_e164}`;
      if (seen.has(uniqueKey)) continue;
      seen.add(uniqueKey);

      if (tenantId && record.tenant_id !== tenantId && record.organization_id !== tenantId) continue;
      if (projectId && record.project_id !== projectId) continue;
      if (role && record.role !== role) continue;
      if (search) {
        const s = search.trim().toLowerCase();
        const matches = (record.phone_e164 && record.phone_e164.toLowerCase().includes(s)) ||
                        (record.customer_ref && record.customer_ref.toLowerCase().includes(s));
        if (!matches) continue;
      }
      results.push({ ...record });
    }
    return results;
  }

  /**
   * Update configuration and resource scope of an existing customer/speaker.
   */
  static async updateCustomer(
    phoneE164: string,
    tenantId: string,
    projectId: string | undefined,
    updates: Partial<CustomerRecord>
  ): Promise<CustomerRecord | null> {
    const cleanPhone = phoneE164.trim();
    const pool = this.getPool();
    let updatedRecord: CustomerRecord | null = null;

    if (pool) {
      try {
        const setClauses: string[] = [];
        const params: any[] = [tenantId, cleanPhone];

        if (updates.role !== undefined) {
          params.push(updates.role);
          setClauses.push(`role = $${params.length}`);
        }
        if (updates.farm_ids !== undefined) {
          params.push(JSON.stringify(updates.farm_ids));
          setClauses.push(`farm_ids = $${params.length}::jsonb`);
        }
        if (updates.customer_ref !== undefined) {
          params.push(updates.customer_ref);
          setClauses.push(`customer_ref = $${params.length}`);
        }
        if (updates.project_id !== undefined) {
          params.push(updates.project_id);
          setClauses.push(`project_id = $${params.length}`);
        }
        if (updates.speaker_cache_expires_at !== undefined) {
          params.push(updates.speaker_cache_expires_at);
          setClauses.push(`speaker_cache_expires_at = $${params.length}`);
        }

        if (setClauses.length > 0) {
          // Tenant/organization scoping is the outer boundary. A supplied
          // project narrows it STRICTLY: an admin edit scoped to project A must
          // never mutate a row belonging to project B. Previously the predicate
          // also matched `project_id IS NULL`, which let a project-scoped write
          // silently land on an unscoped legacy row from another scope.
          let whereClause = `WHERE (tenant_id = $1 OR organization_id = $1) AND phone_e164 = $2`;
          if (projectId) {
            params.push(projectId);
            whereClause += ` AND project_id = $${params.length}`;
          }

          const query = `
            UPDATE customers
            SET ${setClauses.join(', ')}
            ${whereClause}
            RETURNING tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id, farm_ids, speaker_cache_expires_at, created_at
          `;
          const res = await pool.query(query, params);
          if (res.rows.length > 0) {
            const row = res.rows[0];
            updatedRecord = {
              phone_e164: row.phone_e164,
              customer_ref: row.customer_ref,
              organization_id: row.organization_id,
              tenant_id: row.tenant_id,
              project_id: row.project_id,
              workspace_id: row.workspace_id,
              role: row.role,
              unit_id: row.unit_id,
              farm_id: row.farm_id,
              farm_ids: Array.isArray(row.farm_ids) ? row.farm_ids : (row.farm_ids ? JSON.parse(row.farm_ids) : []),
              speaker_cache_expires_at: row.speaker_cache_expires_at ? new Date(row.speaker_cache_expires_at).toISOString() : undefined,
              created_at: row.created_at ? new Date(row.created_at).toISOString() : undefined,
            };
          }
        }
      } catch (err: any) {
        Logger.error(`DbClient.updateCustomer Postgres Error: ${err.message}`);
      }
    }

    // In-memory update
    const memKey = projectId ? `${tenantId}:${projectId}:${cleanPhone}` : `${tenantId}:${cleanPhone}`;
    const existing = this.customersStore.get(memKey) || this.customersStore.get(`${tenantId}:${cleanPhone}`);
    if (existing) {
      if (updates.role) existing.role = updates.role;
      if (updates.farm_ids) existing.farm_ids = updates.farm_ids;
      if (updates.customer_ref) existing.customer_ref = updates.customer_ref;
      if (updates.project_id) existing.project_id = updates.project_id;
      if (updates.speaker_cache_expires_at) existing.speaker_cache_expires_at = updates.speaker_cache_expires_at;
      if (!updatedRecord) updatedRecord = { ...existing };
    }

    return updatedRecord;
  }

  /**
   * Delete or revoke a customer/speaker.
   */
  /**
   * Create or update the phone -> customer binding.
   *
   * This is the single persistence path for the CST-owned identity mapping
   * (vFarm exposes no phone field on a user, so the mapping is CST's). Both
   * the admin "manually onboard a speaker" route and the email
   * self-service verification flow write through here, so there is exactly one
   * upsert to audit.
   */
  static async upsertCustomer(input: {
    tenant_id: string;
    project_id: string;
    phone_e164: string;
    customer_ref: string;
    role?: string;
    farm_ids?: string[];
    speaker_cache_expires_at?: string;
    organization_id?: string;
    workspace_id?: string;
  }): Promise<boolean> {
    const cleanPhone = input.phone_e164.trim();
    const cleanRef = (input.customer_ref || '').trim();
    const role = input.role || 'owner';
    const farms = Array.isArray(input.farm_ids) ? input.farm_ids.filter(Boolean) : [];
    const organizationId = input.organization_id ?? input.tenant_id;
    const workspaceId = input.workspace_id ?? '';
    const pool = this.getPool();

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO customers
             (tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, farm_ids, speaker_cache_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (tenant_id, project_id, phone_e164) DO UPDATE SET
             customer_ref             = EXCLUDED.customer_ref,
             role                     = EXCLUDED.role,
             farm_ids                 = EXCLUDED.farm_ids,
             speaker_cache_expires_at = EXCLUDED.speaker_cache_expires_at`,
          [
            input.tenant_id,
            input.project_id,
            organizationId,
            workspaceId,
            cleanPhone,
            cleanRef,
            role,
            JSON.stringify(farms),
            input.speaker_cache_expires_at ?? null,
          ],
        );
        return true;
      } catch (err: any) {
        Logger.error(`DbClient.upsertCustomer Postgres Error: ${err.message}`);
        return false;
      }
    }

    this.seedCustomer({
      tenant_id: input.tenant_id,
      project_id: input.project_id,
      phone_e164: cleanPhone,
      customer_ref: cleanRef,
      role: role as any,
      farm_ids: farms,
      speaker_cache_expires_at: input.speaker_cache_expires_at,
      organization_id: organizationId,
      workspace_id: workspaceId,
    } as any);
    return true;
  }

  /**
   * Deactivate a customer binding WITHOUT deleting it.
   *
   * The phone -> customer_ref binding is CST-owned: vFarm exposes no phone
   * field on a user, so a deleted row's mapping cannot be reconstructed from
   * the upstream. Expiring keeps the record an operator needs in order to
   * repair it, and is the same "no longer active" mechanism
   * `/speakers/invalidate` uses.
   *
   * The runtime honours the expiry: `lookupCustomerByPhoneAsync` treats an
   * expired row as a miss, and the Admin Panel reports `is_cache_active:false`.
   */
  static async expireCustomer(
    phoneE164: string,
    tenantId: string,
    projectId?: string
  ): Promise<boolean> {
    const cleanPhone = phoneE164.trim();
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    let expired = false;
    const pool = this.getPool();

    if (pool) {
      try {
        const query = projectId
          ? `UPDATE customers SET speaker_cache_expires_at = $4, updated_at = CURRENT_TIMESTAMP
              WHERE (tenant_id = $1 OR organization_id = $1) AND project_id = $2 AND phone_e164 = $3`
          : `UPDATE customers SET speaker_cache_expires_at = $4, updated_at = CURRENT_TIMESTAMP
              WHERE (tenant_id = $1 OR organization_id = $1) AND phone_e164 = $3`;
        const params = projectId
          ? [tenantId, projectId, cleanPhone, expiredAt]
          : [tenantId, projectId, cleanPhone, expiredAt];
        const res = await pool.query(query, params);
        expired = (res.rowCount ?? 0) > 0;
      } catch (err: any) {
        Logger.error(`DbClient.expireCustomer Postgres Error: ${err.message}`);
      }
    }

    // In-memory store
    const keys = projectId
      ? [`${tenantId}:${projectId}:${cleanPhone}`]
      : [`${tenantId}:${projectId}:${cleanPhone}`, `${tenantId}:${cleanPhone}`];
    for (const key of keys) {
      const record = this.customersStore.get(key);
      if (record) {
        record.speaker_cache_expires_at = expiredAt;
        this.customersStore.set(key, record);
        expired = true;
      }
    }
    return expired;
  }

  static async deleteCustomer(
    phoneE164: string,
    tenantId: string,
    projectId?: string
  ): Promise<boolean> {
    const cleanPhone = phoneE164.trim();
    let deleted = false;
    const pool = this.getPool();

    if (pool) {
      try {
        const query = projectId
          ? `DELETE FROM customers WHERE (tenant_id = $1 OR organization_id = $1) AND project_id = $2 AND phone_e164 = $3`
          : `DELETE FROM customers WHERE (tenant_id = $1 OR organization_id = $1) AND phone_e164 = $2`;
        const params = projectId ? [tenantId, projectId, cleanPhone] : [tenantId, cleanPhone];
        const res = await pool.query(query, params);
        deleted = (res.rowCount ?? 0) > 0;
      } catch (err: any) {
        Logger.error(`DbClient.deleteCustomer Postgres Error: ${err.message}`);
      }
    }

    // In-memory
    if (projectId) {
      deleted = this.customersStore.delete(`${tenantId}:${projectId}:${cleanPhone}`) || deleted;
    }
    deleted = this.customersStore.delete(`${tenantId}:${cleanPhone}`) || deleted;
    return deleted;
  }

  // ── Projects Persistence (projects table) ──────────────────────────────────

  static async saveProject(project: Project): Promise<void> {
    this.projectsStore.set(project.project_id, project);

    const pool = this.getPool();
    if (pool) {
      try {
        const query = `
          INSERT INTO projects (project_id, tenant_id, name, status, tenant_org_id, capabilities, speaker_policy, onboarding_reply, elevenlabs_voice_id, elevenlabs_model_id, voice_enabled, synced_at, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, NOW(), NOW(), NOW())
          ON CONFLICT (project_id) DO UPDATE SET
            tenant_id           = EXCLUDED.tenant_id,
            name                = EXCLUDED.name,
            status              = EXCLUDED.status,
            tenant_org_id       = EXCLUDED.tenant_org_id,
            capabilities        = EXCLUDED.capabilities,
            speaker_policy      = EXCLUDED.speaker_policy,
            onboarding_reply    = EXCLUDED.onboarding_reply,
            elevenlabs_voice_id = EXCLUDED.elevenlabs_voice_id,
            elevenlabs_model_id = EXCLUDED.elevenlabs_model_id,
            voice_enabled       = EXCLUDED.voice_enabled,
            synced_at           = EXCLUDED.synced_at,
            updated_at          = NOW();
        `;
        await pool.query(query, [
          project.project_id,
          project.tenant_id,
          project.name,
          project.status,
          project.tenant_org_id || null,
          JSON.stringify(project.capabilities),
          project.speaker_policy,
          project.onboarding_reply || null,
          project.elevenlabs_voice_id || null,
          project.elevenlabs_model_id || null,
          project.voice_enabled ?? false,
        ]);
      } catch (err: any) {
        Logger.error(`DbClient.saveProject Postgres Error: ${err.message}`);
      }
    }
  }

  static async getProject(projectId: string): Promise<Project | null> {
    const mem = this.projectsStore.get(projectId);
    if (mem) return mem;

    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          'SELECT project_id, tenant_id, name, status, tenant_org_id, capabilities, speaker_policy, onboarding_reply, elevenlabs_voice_id, elevenlabs_model_id, voice_enabled, synced_at FROM projects WHERE project_id = $1',
          [projectId]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          const proj: Project = {
            project_id: r.project_id,
            tenant_id: r.tenant_id,
            name: r.name,
            status: r.status,
            tenant_org_id: r.tenant_org_id || undefined,
            capabilities: r.capabilities || { sms: true },
            speaker_policy: r.speaker_policy || 'allowlist',
            onboarding_reply: r.onboarding_reply || undefined,
            elevenlabs_voice_id: r.elevenlabs_voice_id || undefined,
            elevenlabs_model_id: r.elevenlabs_model_id || undefined,
            voice_enabled: r.voice_enabled ?? false,
            synced_at: r.synced_at ? new Date(r.synced_at).toISOString() : undefined,
          };
          this.projectsStore.set(proj.project_id, proj);
          return proj;
        }
      } catch (err: any) {
        Logger.error(`DbClient.getProject Postgres Error: ${err.message}`);
      }
    }
    return null;
  }

  static async getAllProjects(): Promise<Project[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          'SELECT project_id, tenant_id, name, status, tenant_org_id, capabilities, speaker_policy, onboarding_reply, elevenlabs_voice_id, elevenlabs_model_id, voice_enabled, synced_at FROM projects'
        );
        if (res.rows.length > 0) {
          const list = res.rows.map((r) => ({
            project_id: r.project_id,
            tenant_id: r.tenant_id,
            name: r.name,
            status: r.status,
            tenant_org_id: r.tenant_org_id || undefined,
            capabilities: r.capabilities || { sms: true },
            speaker_policy: r.speaker_policy || 'allowlist',
            onboarding_reply: r.onboarding_reply || undefined,
            elevenlabs_voice_id: r.elevenlabs_voice_id || undefined,
            elevenlabs_model_id: r.elevenlabs_model_id || undefined,
            voice_enabled: r.voice_enabled ?? false,
            synced_at: r.synced_at ? new Date(r.synced_at).toISOString() : undefined,
          }));
          for (const p of list) {
            this.projectsStore.set(p.project_id, p);
          }
          return list;
        }
      } catch (err: any) {
        Logger.error(`DbClient.getAllProjects Postgres Error: ${err.message}`);
      }
    }
    return Array.from(this.projectsStore.values());
  }

  // ── Service Number Bindings Persistence (service_number_bindings table) ───

  static async saveServiceNumberBinding(binding: ServiceNumberBinding): Promise<void> {
    const phone = binding.phone_e164.trim();
    this.bindingsStore.set(phone, { ...binding, phone_e164: phone });

    const pool = this.getPool();
    if (pool) {
      try {
        const query = `
          INSERT INTO service_number_bindings (phone_e164, tenant_id, project_id, capability, status, sid, bound_at, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (phone_e164) DO UPDATE SET
            tenant_id   = EXCLUDED.tenant_id,
            project_id  = EXCLUDED.project_id,
            capability  = EXCLUDED.capability,
            status      = EXCLUDED.status,
            sid         = EXCLUDED.sid,
            bound_at    = EXCLUDED.bound_at,
            unbound_at  = NULL;
        `;
        await pool.query(query, [
          phone,
          binding.tenant_id,
          binding.project_id,
          binding.capability,
          binding.status || 'bound',
          binding.sid || null,
          binding.bound_at ? new Date(binding.bound_at) : new Date(),
        ]);
      } catch (err: any) {
        Logger.error(`DbClient.saveServiceNumberBinding Postgres Error: ${err.message}`);
      }
    }
  }

  static async removeServiceNumberBinding(phoneE164: string): Promise<void> {
    const phone = phoneE164.trim();
    this.bindingsStore.delete(phone);

    const pool = this.getPool();
    if (pool) {
      try {
        await pool.query('DELETE FROM service_number_bindings WHERE phone_e164 = $1', [phone]);
      } catch (err: any) {
        Logger.error(`DbClient.removeServiceNumberBinding Postgres Error: ${err.message}`);
      }
    }
  }

  static async getAllServiceNumberBindings(): Promise<ServiceNumberBinding[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          "SELECT phone_e164, tenant_id, project_id, capability, status, sid, bound_at FROM service_number_bindings WHERE status = 'bound'"
        );
        if (res.rows.length > 0) {
          const list = res.rows.map((r) => ({
            phone_e164: r.phone_e164,
            tenant_id: r.tenant_id,
            project_id: r.project_id,
            capability: r.capability as any,
            status: r.status as any,
            sid: r.sid || undefined,
            bound_at: r.bound_at ? new Date(r.bound_at).toISOString() : undefined,
          }));
          for (const b of list) {
            this.bindingsStore.set(b.phone_e164, b);
          }
          return list;
        }
      } catch (err: any) {
        Logger.error(`DbClient.getAllServiceNumberBindings Postgres Error: ${err.message}`);
      }
    }
    return Array.from(this.bindingsStore.values());
  }

  // ── Tenant Persistence (organizations table) ──────────────────────────────

  static async saveTenant(tenant: Tenant): Promise<void> {
    this.tenantsStore.set(tenant.tenant_id, tenant);

    const pool = this.getPool();
    if (pool) {
      try {
        await pool.query(
          'INSERT INTO organizations (organization_id, name, status, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (organization_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status',
          [tenant.tenant_id, tenant.name, tenant.status || 'active']
        );
      } catch (err: any) {
        Logger.error(`DbClient.saveTenant Postgres Error: ${err.message}`);
      }
    }
  }

  static async updateTenant(tenantId: string, updates: Partial<Tenant>): Promise<Tenant | null> {
    const mem = this.tenantsStore.get(tenantId);
    if (mem) {
      if (updates.name) mem.name = updates.name;
      if (updates.status) mem.status = updates.status;
      if (updates.adapter_type) mem.adapter_type = updates.adapter_type;
      if (updates.adapter_config) mem.adapter_config = updates.adapter_config;
    }
    const pool = this.getPool();
    if (pool) {
      try {
        const clauses: string[] = [];
        const params: any[] = [tenantId];
        if (updates.name) {
          params.push(updates.name);
          clauses.push(`name = $${params.length}`);
        }
        if (updates.status) {
          params.push(updates.status);
          clauses.push(`status = $${params.length}`);
        }
        if (clauses.length > 0) {
          await pool.query(`UPDATE organizations SET ${clauses.join(', ')} WHERE organization_id = $1`, params);
        }
      } catch (err: any) {
        Logger.error(`DbClient.updateTenant Postgres Error: ${err.message}`);
      }
    }
    return mem || (await this.getAllTenants()).find((t) => t.tenant_id === tenantId) || null;
  }

  static async getAllTenants(): Promise<Tenant[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query('SELECT organization_id, name, status, created_at FROM organizations');
        if (res.rows.length > 0) {
          const list = res.rows.map((r) => ({
            tenant_id: r.organization_id,
            name: r.name,
            status: r.status,
            adapter_type: r.organization_id.includes('vfarm') ? 'vfarm' : 'custom',
            created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
          }));
          for (const t of list) {
            this.tenantsStore.set(t.tenant_id, t);
          }
          return list;
        }
      } catch (err: any) {
        Logger.error(`DbClient.getAllTenants Postgres Error: ${err.message}`);
      }
    }
    return Array.from(this.tenantsStore.values());
  }

  // ── Conversation & Message Query Methods ──────────────────────────────────

  static async getConversation(
    tenantId: string,
    projectId: string,
    customerRef: string
  ): Promise<any | null> {
    const key = `${tenantId}:${projectId}:${customerRef}`;
    const mem = this.conversationsStore.get(key);
    if (mem) return mem;

    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          'SELECT * FROM conversations WHERE tenant_id = $1 AND project_id = $2 AND customer_ref = $3',
          [tenantId, projectId, customerRef]
        );
        if (res.rows.length > 0) {
          return res.rows[0];
        }
      } catch (err: any) {
        Logger.error(`DbClient.getConversation Postgres Error: ${err.message}`);
      }
    }
    return null;
  }

  static async getMessagesForConversation(
    conversationId: string,
    tenantId: string,
    projectId?: string
  ): Promise<any[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          'SELECT * FROM messages WHERE conversation_id = $1 AND tenant_id = $2 AND ($3::text IS NULL OR project_id = $3) ORDER BY created_at ASC',
          [conversationId, tenantId, projectId || null]
        );
        return res.rows;
      } catch (err: any) {
        Logger.error(`DbClient.getMessagesForConversation Postgres Error: ${err.message}`);
      }
    }
    return Array.from(this.transcriptsStore.values()).filter(
      (m: any) => m.conversation_id === conversationId && m.tenant_id === tenantId && (!projectId || m.project_id === projectId)
    );
  }


  /**
   * Verify that a given workspace is valid for the given organization.
   *
   * Strategy (synchronous — no DB):
   * 1. Reject immediately if organizationId is empty.
   * 2. Try CoreRegistry: collect all project_ids for this tenant and accept
   *    the workspace if it matches a known project_id or its standard ws- prefix.
   * 3. Reject if the workspaceId clearly contains a *different* org/tenant prefix
   *    (cross-tenant injection attempt).
   * 4. If unknown but not clearly foreign, fail closed (return false).
   */
  static validateWorkspaceScope(organizationId: string, workspaceId: string): boolean {
    if (!organizationId || !workspaceId) return false;

    // Fast check: registry
    try {
      const projects = CoreRegistry.getProjectsForTenant(organizationId);
      if (projects.length > 0) {
        for (const p of projects) {
          if (workspaceId === p.project_id || workspaceId === `ws-${p.project_id}`) return true;
          if (p.tenant_org_id && (workspaceId === p.tenant_org_id || workspaceId === `ws-${p.tenant_org_id}`)) return true;
        }
      }
    } catch {
      // ignore
    }

    // Tenant slug extraction: e.g. 'tenant-vfarm-01' -> 'vfarm'
    const slug = organizationId.replace(/^(tenant|org)-/, '').replace(/-\d+$/, '');
    if (slug && workspaceId.includes(slug)) {
      return true;
    }
    if (workspaceId.startsWith(organizationId) || workspaceId.includes(organizationId)) {
      return true;
    }

    return false;
  }

  /**
   * Project-scoped validation: confirm project_id belongs to tenant_id.
   * Uses CoreRegistry (in-memory, fast) first, then Postgres as fallback.
   */
  static async validateProjectScope(tenantId: string, projectId: string): Promise<boolean> {
    if (!tenantId || !projectId) return false;
    // Fast path: registry
    const project = CoreRegistry.getProject(projectId);
    if (project) return project.tenant_id === tenantId;
    // Slow path: Postgres
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          'SELECT project_id FROM projects WHERE project_id = $1 AND tenant_id = $2',
          [projectId, tenantId]
        );
        return (res.rowCount ?? 0) > 0;
      } catch (err: any) {
        Logger.error(`DbClient.validateProjectScope Postgres Error: ${err.message}`);
      }
    }
    return false;
  }

  static getCustomerCount(): number {
    return this.customersStore.size;
  }

  // ── Alert Audit Log Writer ───────────────────────────────────────────────────

  /**
   * Insert an immutable alert audit row into alert_audit_log.
   * Called from AlertAuditLog.write() after masking and size-capping.
   * In-memory mode (tests): logs the event and returns without DB interaction.
   */
  static async writeAlertAuditRow(row: AlertAuditRow): Promise<void> {
    this.alertAuditStore.push(row);
    if (this.alertAuditStore.length > 200) {
      this.alertAuditStore.shift();
    }

    const pool = this.getPool();
    if (!pool) {
      Logger.info(`DbClient.writeAlertAuditRow (in-memory): id=${row.id} outbound=${row.outbound_message_id} truncated=${row.truncated} masked=${row.masked_at !== null}`);
      return;
    }
    try {
      const query = `
        INSERT INTO alert_audit_log
          (id, outbound_message_id, tenant_id, organization_id, rendered_body, truncated,
           template_id, version, params, masked_at, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `;
      await pool.query(query, [
        row.id,
        row.outbound_message_id,
        row.tenant_id,
        row.organization_id || row.tenant_id,
        row.rendered_body,
        row.truncated,
        row.template_id || null,
        row.version     || null,
        row.params ? JSON.stringify(row.params) : null,
        row.masked_at   || null,
        row.expires_at,
        row.created_at,
      ]);
    } catch (err: any) {
      Logger.error(`DbClient.writeAlertAuditRow Postgres Error: ${err.message}`);
      throw err;
    }
  }

  static async getRecentAlertAuditLogs(limit = 50): Promise<AlertAuditRow[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, outbound_message_id, tenant_id, organization_id, rendered_body, truncated,
                  template_id, version, params, masked_at, expires_at, created_at
           FROM alert_audit_log
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );
        return res.rows.map((row) => ({
          id: row.id,
          outbound_message_id: row.outbound_message_id,
          tenant_id: row.tenant_id,
          organization_id: row.organization_id,
          rendered_body: row.rendered_body,
          truncated: row.truncated,
          template_id: row.template_id,
          version: row.version,
          params: typeof row.params === 'string' ? JSON.parse(row.params) : row.params,
          masked_at: row.masked_at ? new Date(row.masked_at).toISOString() : null,
          expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : new Date().toISOString(),
          created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        }));
      } catch (err: any) {
        Logger.error(`DbClient.getRecentAlertAuditLogs Postgres Error: ${err.message}`);
      }
    }
    return [...this.alertAuditStore].slice(-limit).reverse();
  }

  // ── Escalation Records (mirrors `escalations` table in Postgres) ─────────
  /**
   * Create a durable escalation record.
   * In-memory mode (tests): stores in escalationsStore.
   * Postgres mode: inserts into escalations table.
   */
  static async createEscalationRecord(params: {
    caller_phone: string;
    tenant_id: string;
    project_id: string;
    conversation_id?: string;
    correlation_id: string;
    caller_email?: string;
    reason?: string;
    transcript?: string[];
    status?: 'pending' | 'notified' | 'failed';
  }): Promise<string> {
    const id = `esc_${randomUUID()}`;
    const now = new Date().toISOString();
    const record: EscalationRecord = {
      id,
      caller_phone: params.caller_phone,
      tenant_id: params.tenant_id,
      project_id: params.project_id,
      conversation_id: params.conversation_id || undefined,
      correlation_id: params.correlation_id,
      caller_email: params.caller_email || undefined,
      reason: params.reason || undefined,
      transcript: params.transcript || undefined,
      slack_notified: false,
      slack_notified_at: undefined,
      slack_error: undefined,
      created_at: now,
      status: params.status || 'pending',
    };

    this.escalationsStore.set(id, record);

    const pool = this.getPool();
    if (!pool) {
      Logger.info(`DbClient.createEscalationRecord (in-memory): id=${id} caller=${maskPhone(params.caller_phone)}`);
      return id;
    }
    try {
      await pool.query(
        `INSERT INTO escalations
          (id, caller_phone, tenant_id, project_id, conversation_id, correlation_id,
           caller_email, reason, transcript, slack_notified, slack_notified_at,
           slack_error, created_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          id,
          params.caller_phone,
          params.tenant_id,
          params.project_id,
          params.conversation_id || null,
          params.correlation_id,
          params.caller_email || null,
          params.reason || null,
          params.transcript ? JSON.stringify(params.transcript) : null,
          false,
          null,
          null,
          now,
          record.status,
        ],
      );
      return id;
    } catch (err: any) {
      Logger.error(`DbClient.createEscalationRecord Postgres Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Update the Slack notification status on an escalation record.
   */
  static async updateEscalationSlackStatus(
    escalationId: string,
    notified: boolean,
    error?: string,
  ): Promise<void> {
    const record = this.escalationsStore.get(escalationId);
    if (record) {
      record.slack_notified = notified;
      record.slack_notified_at = notified ? new Date().toISOString() : undefined;
      record.slack_error = error || undefined;
      // Only mark 'failed' when there's an actual error. When Slack is simply
      // not configured (notified === false, no error), the escalation remains
      // 'pending' — the record exists, notification hasn't been sent yet.
      if (notified) {
        record.status = 'notified';
      } else if (error) {
        record.status = 'failed';
      }
      this.escalationsStore.set(escalationId, record);
    }

    const pool = this.getPool();
    if (!pool) return;
    try {
      await pool.query(
        `UPDATE escalations
          SET slack_notified = $1, slack_notified_at = $2, slack_error = $3, status = $4
          WHERE id = $5`,
        [notified, notified ? new Date().toISOString() : null, error || null, notified ? 'notified' : error ? 'failed' : 'pending', escalationId],
      );
    } catch (err: any) {
      Logger.error(`DbClient.updateEscalationSlackStatus Postgres Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Update the caller email on an escalation record.
   */
  static async updateEscalationEmail(escalationId: string, email: string): Promise<void> {
    const record = this.escalationsStore.get(escalationId);
    if (record) {
      record.caller_email = email;
      this.escalationsStore.set(escalationId, record);
    }

    const pool = this.getPool();
    if (!pool) return;
    try {
      await pool.query(`UPDATE escalations SET caller_email = $1 WHERE id = $2`, [email, escalationId]);
    } catch (err: any) {
      Logger.error(`DbClient.updateEscalationEmail Postgres Error: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get an escalation record by ID.
   */
  static async getEscalationRecord(escalationId: string): Promise<EscalationRecord | null> {
    const record = this.escalationsStore.get(escalationId);
    if (record) return { ...record };

    const pool = this.getPool();
    if (!pool) return null;
    try {
      const res = await pool.query(
        `SELECT id, caller_phone, tenant_id, project_id, conversation_id, correlation_id,
                caller_email, reason, transcript, slack_notified, slack_notified_at,
                slack_error, created_at, status
         FROM escalations WHERE id = $1`,
        [escalationId],
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0];
      return {
        id: row.id,
        caller_phone: row.caller_phone,
        tenant_id: row.tenant_id,
        project_id: row.project_id,
        conversation_id: row.conversation_id,
        correlation_id: row.correlation_id,
        caller_email: row.caller_email,
        reason: row.reason,
        transcript: typeof row.transcript === 'string' ? JSON.parse(row.transcript) : row.transcript,
        slack_notified: row.slack_notified,
        slack_notified_at: row.slack_notified_at ? new Date(row.slack_notified_at).toISOString() : undefined,
        slack_error: row.slack_error || undefined,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
        status: row.status,
      };
    } catch (err: any) {
      Logger.error(`DbClient.getEscalationRecord Postgres Error: ${err.message}`);
      throw err;
    }
  }

  // ── Voice Deliveries Ledger & Health Tracking ───────────────────────────────

  /**
   * Record a spoken delivery event for Destiny health tracking and audit.
   */
  static async recordVoiceDelivery(delivery: VoiceDeliveryRecord): Promise<VoiceDeliveryRecord> {
    const id = delivery.id || `vd_${randomUUID()}`;
    const now = new Date().toISOString();
    const record: VoiceDeliveryRecord = {
      ...delivery,
      id,
      created_at: delivery.created_at || now,
      delivered_at:
        delivery.status === 'synthesized' || delivery.status === 'sent'
          ? delivery.delivered_at || now
          : undefined,
    };

    this.voiceDeliveriesStore.set(id, record);

    const pool = this.getPool();
    if (pool) {
      // Same defect class as the conversations insert: `voice_deliveries.system_id`
      // has the same `REFERENCES systems(system_id)` FK (migration 009:18), and
      // most voice call sites pass a project_id. The previous
      // `|| record.project_id || 'system-vfarm-01'` chain fed the FK either a
      // project id (no matching row) or a hardcoded literal. Resolve from
      // tenant_id instead, exactly as conversations does.
      const authoritativeSystemId = await this.resolveSystemIdForTenant(
        pool,
        record.tenant_id,
        record.system_id || '',
      );
      if (!authoritativeSystemId) {
        // `system_id` is NOT NULL + FK. With no `systems` row for this tenant the
        // row is genuinely unpersistable; skip the write rather than fabricate a
        // value or fire a guaranteed-violating INSERT. The in-memory ledger below
        // still records the event.
        Logger.warn(
          `DbClient.recordVoiceDelivery: no systems row for tenant ${record.tenant_id} — voice delivery not persisted (fail closed)`,
        );
        return record;
      }
      record.system_id = authoritativeSystemId;
      try {
        const query = `
          INSERT INTO voice_deliveries (
            id, system_id, tenant_id, conversation_id, message_id,
            status, voice_id, model_id, character_count, audio_bytes,
            mime_type, error_code, error_message, correlation_id,
            delivered_at, created_at, project_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `;
        await pool.query(query, [
          record.id,
          authoritativeSystemId,
          record.tenant_id,
          record.conversation_id || null,
          record.message_id || null,
          record.status,
          record.voice_id || null,
          record.model_id || null,
          record.character_count || 0,
          record.audio_bytes || 0,
          record.mime_type || 'audio/mpeg',
          record.error_code || null,
          record.error_message || null,
          record.correlation_id || null,
          record.delivered_at || null,
          record.created_at,
          record.project_id || record.system_id || null,
        ]);
      } catch (err: any) {
        Logger.error(`DbClient.recordVoiceDelivery Postgres Error: ${err.message}`);
      }
    }

    return record;
  }

  /**
   * Query spoken deliveries in the last 24 hours to compute Destiny's voice-lane health signal:
   * "clone configured + at least one successful spoken delivery in the last 24h"
   */
  static async getVoiceDeliveriesInLast24Hours(systemId?: string): Promise<VoiceDeliveryRecord[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const query = systemId
          ? `SELECT * FROM voice_deliveries WHERE (system_id = $1 OR project_id = $1) AND status IN ('synthesized', 'sent') AND created_at >= NOW() - INTERVAL '24 HOURS' ORDER BY created_at DESC`
          : `SELECT * FROM voice_deliveries WHERE status IN ('synthesized', 'sent') AND created_at >= NOW() - INTERVAL '24 HOURS' ORDER BY created_at DESC`;
        const params = systemId ? [systemId] : [];
        const res = await pool.query(query, params);
        if (res.rows && res.rows.length > 0) {
          return res.rows.map((row: any) => ({
            id: row.id,
            system_id: row.system_id,
            project_id: row.project_id,
            tenant_id: row.tenant_id,
            conversation_id: row.conversation_id || undefined,
            message_id: row.message_id || undefined,
            status: row.status,
            voice_id: row.voice_id || undefined,
            model_id: row.model_id || undefined,
            character_count: Number(row.character_count || 0),
            audio_bytes: Number(row.audio_bytes || 0),
            mime_type: row.mime_type || 'audio/mpeg',
            error_code: row.error_code || undefined,
            error_message: row.error_message || undefined,
            correlation_id: row.correlation_id || undefined,
            delivered_at: row.delivered_at ? new Date(row.delivered_at).toISOString() : undefined,
            created_at: row.created_at ? new Date(row.created_at).toISOString() : undefined,
          }));
        }
      } catch (err: any) {
        Logger.error(`DbClient.getVoiceDeliveriesInLast24Hours Postgres Error: ${err.message}`);
      }
    }

    // In-memory fallback
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return Array.from(this.voiceDeliveriesStore.values()).filter((d) => {
      if (systemId && d.system_id !== systemId && d.project_id !== systemId) return false;
      if (d.status !== 'synthesized' && d.status !== 'sent') return false;
      const createdAt = new Date(d.created_at || 0).getTime();
      return createdAt >= cutoff;
    });
  }

  static getAllVoiceDeliveries(): VoiceDeliveryRecord[] {
    return Array.from(this.voiceDeliveriesStore.values());
  }

  // ── Dashboard Publish Outcomes (migration 020) ─────────────────────────────

  /**
   * Record the durable outcome of a Dashboard publish attempt.
   *
   * The publisher is fire-and-forget: without this record a dropped event
   * could not be found, replayed, or audited once the log rotated. One row is
   * written per attempt; a retry of the same event supersedes the previous
   * row for the same (event_id, event_type) pair.
   */
  static async recordDashboardPublishOutcome(
    outcome: DashboardPublishOutcome
  ): Promise<DashboardPublishOutcome> {
    const id = outcome.id || `dpo_${randomUUID()}`;
    const now = new Date();
    const record: DashboardPublishOutcome = {
      ...outcome,
      id,
      created_at: outcome.created_at || now.toISOString(),
      expires_at:
        outcome.expires_at ||
        new Date(now.getTime() + DASHBOARD_OUTCOME_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    };

    // Supersede any prior live row for the same event so the current outcome
    // is unambiguous. The prior row's history is preserved in the log.
    for (const [key, existing] of this.dashboardOutcomeStore) {
      if (
        existing.event_id === record.event_id &&
        existing.event_type === record.event_type &&
        existing.replayed_at === undefined
      ) {
        this.dashboardOutcomeStore.delete(key);
      }
    }
    this.dashboardOutcomeStore.set(id, record);

    const pool = this.getPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO dashboard_publish_outcomes (
             id, event_id, event_type, specversion, turn_id, correlation_id,
             tenant_id, project_id, status, http_status, attempts, error,
             payload, created_at, expires_at, replayed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            record.id,
            record.event_id,
            record.event_type,
            record.specversion || null,
            record.turn_id || null,
            record.correlation_id || null,
            record.tenant_id || null,
            record.project_id || null,
            record.status,
            record.http_status ?? null,
            record.attempts,
            record.error || null,
            record.payload ? JSON.stringify(record.payload) : null,
            record.created_at,
            record.expires_at,
            record.replayed_at || null,
          ],
        );
      } catch (err: any) {
        // A failed evidence write must never break the customer path.
        Logger.warn(
          `DbClient.recordDashboardPublishOutcome: could not persist outcome for ${record.event_id}: ${err?.message}`,
        );
      }
    }

    return record;
  }

  /**
   * Outcomes that were not ingested, oldest first — the dead-letter view.
   *
   * READS THE DATABASE, not just the in-memory map. The publisher is
   * fire-and-forget and the process can restart at any time, so an
   * in-memory-only view is empty after a restart and the events that failed
   * to publish would be unrecoverable — exactly the events most in need of a
   * replay.
   */
  static async getUnpublishedDashboardOutcomes(limit = 50): Promise<DashboardPublishOutcome[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, event_id, event_type, specversion, turn_id, correlation_id,
                  tenant_id, project_id, status, http_status, attempts, error,
                  payload, created_at, expires_at, replayed_at
             FROM dashboard_publish_outcomes
            WHERE status <> 'published'
              AND replayed_at IS NULL
              AND expires_at > NOW()
            ORDER BY created_at ASC
            LIMIT $1`,
          [limit],
        );
        const rows: DashboardPublishOutcome[] = (res.rows || []).map((r) => ({
          id: r.id,
          event_id: r.event_id,
          event_type: r.event_type,
          specversion: r.specversion ?? undefined,
          turn_id: r.turn_id ?? undefined,
          correlation_id: r.correlation_id ?? undefined,
          tenant_id: r.tenant_id ?? undefined,
          project_id: r.project_id ?? undefined,
          status: r.status,
          http_status: r.http_status ?? undefined,
          attempts: r.attempts ?? 0,
          error: r.error ?? undefined,
          payload: r.payload ?? undefined,
          created_at: r.created_at ? new Date(r.created_at).toISOString() : undefined,
          expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : undefined,
          replayed_at: r.replayed_at ? new Date(r.replayed_at).toISOString() : undefined,
        }));
        // Keep the in-memory view in step with the durable one.
        for (const row of rows) {
          if (row.id) this.dashboardOutcomeStore.set(row.id, row);
        }
        return rows;
      } catch (err: any) {
        Logger.error(`DbClient.getUnpublishedDashboardOutcomes Postgres Error: ${err.message}`);
      }
    }
    return Array.from(this.dashboardOutcomeStore.values())
      .filter((o) => o.status !== 'published' && o.replayed_at === undefined)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
      .slice(0, limit);
  }

  /** Every recorded outcome, newest first — the audit view. */
  static getAllDashboardPublishOutcomes(): DashboardPublishOutcome[] {
    return Array.from(this.dashboardOutcomeStore.values()).sort((a, b) =>
      (b.created_at || '').localeCompare(a.created_at || ''),
    );
  }

  /**
   * Mark a dead-letter row as replayed.
   *
   * PERSISTS the mark. Without this the row stays `replayed_at IS NULL` in
   * the database, so a replayed event would be published a second time on the
   * next pass — a duplicate Dashboard event for one customer turn.
   */
  static async markDashboardOutcomeReplayed(id: string, replayedAt?: string): Promise<void> {
    const stamp = replayedAt || new Date().toISOString();
    const record = this.dashboardOutcomeStore.get(id);
    if (record) {
      record.replayed_at = stamp;
      this.dashboardOutcomeStore.set(id, record);
    }

    const pool = this.getPool();
    if (pool) {
      try {
        await pool.query(
          `UPDATE dashboard_publish_outcomes SET replayed_at = $2 WHERE id = $1`,
          [id, stamp],
        );
      } catch (err: any) {
        Logger.error(`DbClient.markDashboardOutcomeReplayed Postgres Error: ${err.message}`);
      }
    }
  }

  // ── SMS Consent Persistence (sms_consents + sms_consent_audit) ─────────────

  private static consentStoreKey(tenantId: string, phoneE164: string, projectId?: string): string {
    const projKey = projectId || '';
    return `${tenantId}:${projKey}:${phoneE164.trim()}`;
  }

  static consentPromptStoreKey(tenantId: string, phoneE164: string, projectId?: string): string {
    const projKey = projectId || '';
    return `${tenantId}:${projKey}:${phoneE164.trim()}`;
  }

  /**
   * Record or update an SMS consent (opt-in or opt-out) row.
   * Uses upsert semantics: if a record exists for this tenant/project/phone,
   * it is updated; otherwise a new one is created.
   * An audit row is always inserted.
   */
  static async recordSmsConsent(params: {
    tenant_id: string;
    project_id?: string | null;
    phone_e164: string;
    consent_status: ConsentStatus;
    consented_at?: string | null;
    opted_out_at?: string | null;
    wording_version: string;
    wording_snapshot: string;
    source: string;
    actor: string;
    correlation_id?: string | null;
    reason?: string;
  }): Promise<SmsConsentRecord> {
    const now = new Date().toISOString();
    const cleanPhone = params.phone_e164.trim();
    const projId = params.project_id || null;
    const key = this.consentStoreKey(params.tenant_id, cleanPhone, projId || undefined);

    const existing = this.smsConsentsStore.get(key);

    const record: SmsConsentRecord = {
      id: existing?.id || `smsc_${randomUUID()}`,
      tenant_id: params.tenant_id,
      project_id: projId,
      phone_e164: cleanPhone,
      consent_status: params.consent_status,
      consented_at: params.consent_status === 'opted_in' ? (params.consented_at || now) : (params.consented_at || existing?.consented_at || null),
      opted_out_at: params.consent_status === 'opted_out' ? (params.opted_out_at || now) : null,
      wording_version: params.wording_version,
      wording_snapshot: params.wording_snapshot,
      source: params.source,
      created_at: existing?.created_at || now,
      updated_at: now,
    };

    this.smsConsentsStore.set(key, record);

    // ── Audit row ───────────────────────────────────────────────────────────
    const auditRow: SmsConsentAuditRow = {
      id: `smsca_${randomUUID()}`,
      consent_id: record.id,
      tenant_id: params.tenant_id,
      project_id: projId,
      phone_e164: cleanPhone,
      action: params.consent_status === 'opted_in' ? 'consent_granted' : 'consent_revoked',
      previous_status: existing?.consent_status || null,
      new_status: params.consent_status,
      wording_version: params.wording_version,
      wording_snapshot: params.wording_snapshot,
      source: params.source,
      actor: params.actor,
      reason: params.reason || null,
      correlation_id: params.correlation_id || null,
      created_at: now,
    };
    this.smsConsentAuditStore.push(auditRow);

    // ── Postgres write ──────────────────────────────────────────────────────
    const pool = this.getPool();
    if (pool) {
      try {
        // Use INSERT with VALUES to handle both tenant-only (null project_id) and project-scoped cases.
        // ON CONFLICT will update only when there is a conflict with (tenant_id, COALESCE(project_id, ''), phone_e164).
        // This ensures new records are inserted regardless of null project_id.
        await pool.query(
          `INSERT INTO sms_consents
             (id, tenant_id, project_id, phone_e164, consent_status, consented_at, opted_out_at,
               wording_version, wording_snapshot, source, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (tenant_id, COALESCE(project_id, ''), phone_e164)
            DO UPDATE SET
              consent_status   = EXCLUDED.consent_status,
              consented_at     = CASE
                                   WHEN EXCLUDED.consent_status = 'opted_in'
                                   THEN COALESCE(EXCLUDED.consented_at, sms_consents.consented_at)
                                   ELSE sms_consents.consented_at
                                 END,
              opted_out_at     = CASE
                                   WHEN EXCLUDED.consent_status = 'opted_out'
                                   THEN COALESCE(EXCLUDED.opted_out_at, NOW())
                                   ELSE NULL
                                 END,
              wording_version  = EXCLUDED.wording_version,
              wording_snapshot = EXCLUDED.wording_snapshot,
              source           = EXCLUDED.source,
              updated_at       = NOW()`,
          [
            record.id,
            params.tenant_id,
            projId,
            cleanPhone,
            params.consent_status,
            record.consented_at,
            record.opted_out_at,
            params.wording_version,
            params.wording_snapshot,
            params.source,
            record.created_at,
            now,
          ],
        );
      } catch (err: any) {
        Logger.error(`DbClient.recordSmsConsent Postgres Error: ${err.message}`);
      }

      try {
        await pool.query(
          `INSERT INTO sms_consent_audit
             (id, consent_id, tenant_id, project_id, phone_e164, action, previous_status,
              new_status, wording_version, wording_snapshot, source, actor, reason,
              correlation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            auditRow.id,
            auditRow.consent_id,
            auditRow.tenant_id,
            auditRow.project_id,
            auditRow.phone_e164,
            auditRow.action,
            auditRow.previous_status,
            auditRow.new_status,
            auditRow.wording_version,
            auditRow.wording_snapshot,
            auditRow.source,
            auditRow.actor,
            auditRow.reason,
            auditRow.correlation_id,
            auditRow.created_at,
          ],
        );
      } catch (err: any) {
        Logger.error(`DbClient.recordSmsConsent audit Postgres Error: ${err.message}`);
      }
    }

    return record;
  }

  /**
   * Record an opt-out (STOP) for a phone number.
   * Creates the consent record if it does not exist, or updates it to opted_out.
   */
  static async recordSmsOptOut(params: {
    tenant_id: string;
    project_id?: string | null;
    phone_e164: string;
    opted_out_at: string;
    wording_version: string;
    wording_snapshot: string;
    source: string;
    actor: string;
    correlation_id?: string | null;
    reason?: string;
  }): Promise<SmsConsentRecord> {
    return this.recordSmsConsent({
      tenant_id: params.tenant_id,
      project_id: params.project_id,
      phone_e164: params.phone_e164,
      consent_status: 'opted_out',
      consented_at: null,
      opted_out_at: params.opted_out_at || new Date().toISOString(),
      wording_version: params.wording_version,
      wording_snapshot: params.wording_snapshot,
      source: params.source,
      actor: params.actor,
      correlation_id: params.correlation_id,
      reason: params.reason,
    });
  }

  /**
   * Look up the current SMS consent record for a phone within a tenant (and
   * optionally project). Returns null when no consent record exists.
   *
   * Tenant/project isolation: queries are always scoped — cross-tenant or
   * cross-project reads are never possible through this interface.
   */
  static async lookupSmsConsent(
    phoneE164: string,
    tenantId: string,
    projectId?: string
  ): Promise<SmsConsentRecord | null> {
    const cleanPhone = phoneE164.trim();
    if (!cleanPhone) return null;

    const projectFilter = projectId || null;
    const memKey = this.consentStoreKey(tenantId, cleanPhone, projectFilter || undefined);
    const memRecord = this.smsConsentsStore.get(memKey);
    if (memRecord) return memRecord;

    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, tenant_id, project_id, phone_e164, consent_status, consented_at,
                  opted_out_at, wording_version, wording_snapshot, source, created_at, updated_at
           FROM sms_consents
           WHERE tenant_id = $1
             AND COALESCE(project_id, '') = $2::text
             AND phone_e164 = $3
           ORDER BY updated_at DESC
           LIMIT 1`,
          [tenantId, projectFilter || '', cleanPhone],
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const record: SmsConsentRecord = {
            id: row.id,
            tenant_id: row.tenant_id,
            project_id: row.project_id,
            phone_e164: row.phone_e164,
            consent_status: row.consent_status as ConsentStatus,
            consented_at: row.consented_at,
            opted_out_at: row.opted_out_at,
            wording_version: row.wording_version,
            wording_snapshot: row.wording_snapshot,
            source: row.source,
            created_at: row.created_at,
            updated_at: row.updated_at,
          };
          this.smsConsentsStore.set(memKey, record);
          return record;
        }
      } catch (err: any) {
        Logger.error(`DbClient.lookupSmsConsent Postgres Error: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Check if a phone number is opted out of SMS for a tenant/project.
   * Returns true only when the most recent consent state is opted_out.
   */
  static async isPhoneOptedOut(
    phoneE164: string,
    tenantId: string,
    projectId?: string
  ): Promise<boolean> {
    const record = await this.lookupSmsConsent(phoneE164, tenantId, projectId);
    return record?.consent_status === 'opted_out';
  }

  /**
   * Check if a phone number has explicitly opted in to SMS.
   * Returns true only when the most recent consent state is opted_in.
   */
  static async isPhoneSmsConsented(
    phoneE164: string,
    tenantId: string,
    projectId?: string
  ): Promise<boolean> {
    const record = await this.lookupSmsConsent(phoneE164, tenantId, projectId);
    return record?.consent_status === 'opted_in';
  }

  /**
   * Retrieve all SMS consent records with optional filtering.
   */
  static async getAllSmsConsents(
    tenantId?: string,
    projectId?: string,
    status?: ConsentStatus,
    search?: string,
  ): Promise<SmsConsentRecord[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const conditions: string[] = [];
        const params: any[] = [];

        if (tenantId) {
          params.push(tenantId);
          conditions.push(`tenant_id = $${params.length}`);
        }
        if (projectId) {
          params.push(projectId);
          conditions.push(`COALESCE(project_id, '') = $${params.length}::text`);
        }
        if (status) {
          params.push(status);
          conditions.push(`consent_status = $${params.length}`);
        }
        if (search) {
          params.push(`%${search.trim().toLowerCase()}%`);
          conditions.push(
            `(LOWER(phone_e164) LIKE $${params.length} OR LOWER(source) LIKE $${params.length})`,
          );
          params.push(`%${search.trim().toLowerCase()}%`);
          conditions.push(
            `(LOWER(phone_e164) LIKE $${params.length} OR LOWER(source) LIKE $${params.length})`,
          );
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const res = await pool.query(
          `SELECT id, tenant_id, project_id, phone_e164, consent_status, consented_at,
                  opted_out_at, wording_version, wording_snapshot, source, created_at, updated_at
           FROM sms_consents
           ${whereClause}
           ORDER BY tenant_id, phone_e164, updated_at DESC`,
          params,
        );
        return res.rows.map((row) => ({
          id: row.id,
          tenant_id: row.tenant_id,
          project_id: row.project_id,
          phone_e164: row.phone_e164,
          consent_status: row.consent_status as ConsentStatus,
          consented_at: row.consented_at,
          opted_out_at: row.opted_out_at,
          wording_version: row.wording_version,
          wording_snapshot: row.wording_snapshot,
          source: row.source,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }));
      } catch (err: any) {
        Logger.error(`DbClient.getAllSmsConsents Postgres Error: ${err.message}`);
      }
    }

    // In-memory fallback
    const results: SmsConsentRecord[] = [];
    for (const record of this.smsConsentsStore.values()) {
      if (tenantId && record.tenant_id !== tenantId) continue;
      if (projectId && record.project_id !== projectId) continue;
      if (status && record.consent_status !== status) continue;
      if (search) {
        const s = search.trim().toLowerCase();
        if (!record.phone_e164.toLowerCase().includes(s) && !record.source.toLowerCase().includes(s)) continue;
      }
      results.push({ ...record });
    }
    return results;
  }

  /**
   * Retrieve audit history for a phone number (all consent changes).
   */
  static async getSmsConsentAuditForPhone(
    phoneE164: string,
    tenantId: string,
    projectId?: string,
  ): Promise<SmsConsentAuditRow[]> {
    const cleanPhone = phoneE164.trim();

    const pool = this.getPool();
    if (pool) {
      try {
        let query = `
          SELECT id, consent_id, tenant_id, project_id, phone_e164, action,
                 previous_status, new_status, wording_version, wording_snapshot,
                 source, actor, reason, correlation_id, created_at
          FROM sms_consent_audit
          WHERE tenant_id = $1 AND phone_e164 = $2`;
        const params: any[] = [tenantId, cleanPhone];

        if (projectId) {
          params.push(projectId);
          query += ` AND COALESCE(project_id, '') = $${params.length}::text`;
        }

        query += ` ORDER BY created_at DESC`;
        const res = await pool.query(query, params);
        return res.rows.map((row) => ({
          id: row.id,
          consent_id: row.consent_id,
          tenant_id: row.tenant_id,
          project_id: row.project_id,
          phone_e164: row.phone_e164,
          action: row.action,
          previous_status: row.previous_status as ConsentStatus | null,
          new_status: row.new_status as ConsentStatus,
          wording_version: row.wording_version,
          wording_snapshot: row.wording_snapshot,
          source: row.source,
          actor: row.actor,
          reason: row.reason,
          correlation_id: row.correlation_id,
          created_at: row.created_at,
        }));
      } catch (err: any) {
        Logger.error(`DbClient.getSmsConsentAuditForPhone Postgres Error: ${err.message}`);
      }
    }

    // In-memory fallback
    return [...this.smsConsentAuditStore]
      .filter((r) => r.tenant_id === tenantId && r.phone_e164 === cleanPhone)
      .filter((r) => !projectId || r.project_id === projectId || r.project_id === null)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}

