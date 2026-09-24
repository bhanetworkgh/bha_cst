import { InboundMessage, OutboundMessage } from '../transport/twilio/types.js';
import { randomUUID } from 'crypto';
import pg from 'pg';
import { Logger } from '../config/logger.js';
import type { AlertAuditRow } from '../audit/alert_audit.js';
import { CoreRegistry } from '../core/registry.js';
import type { Project, ServiceNumberBinding, Tenant } from '../core/types.js';

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

export class DbClient {
  private static pool: pg.Pool | null = null;

  // In-memory stores for unit testing / fast fallback
  private static messagesInStore:       Map<string, InboundMessage>      = new Map();
  private static messagesOutStore:      Map<string, OutboundMessage>     = new Map();
  private static conversationsStore:    Map<string, any>                 = new Map();
  private static transcriptsStore:      Map<string, any>                 = new Map();
  private static customersStore:        Map<string, CustomerRecord>      = new Map();
  private static voiceDeliveriesStore:  Map<string, VoiceDeliveryRecord> = new Map();
  private static projectsStore:         Map<string, Project>             = new Map();
  private static bindingsStore:         Map<string, ServiceNumberBinding>= new Map();
  private static tenantsStore:          Map<string, Tenant>              = new Map();
  private static alertAuditStore:       AlertAuditRow[]                  = [];

  static getPool(): pg.Pool | null {
    if (this.pool) return this.pool;
    const connectionString = process.env.DATABASE_URL;
    if (connectionString && process.env.NODE_ENV !== 'test') {
      try {
        this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30000 });
        Logger.info('DbClient: Initialized PostgreSQL database connection pool');
      } catch (err: any) {
        Logger.warn(`DbClient: Failed to initialize Postgres pool: ${err.message}`);
      }
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
        // project_id included since migration 010; column is nullable for older rows.
        const query = `
          INSERT INTO messages_out (id, tenant_id, project_id, from_e164, to_e164, body, media_url, correlation_id, status, retry_count, error_message, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            retry_count = EXCLUDED.retry_count,
            error_message = EXCLUDED.error_message,
            from_e164 = EXCLUDED.from_e164,
            project_id = COALESCE(EXCLUDED.project_id, messages_out.project_id)
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
          record.status,
          record.retry_count,
          record.error_message || null,
          record.created_at,
        ]);
      } catch (err: any) {
        Logger.error(`DbClient.saveOutboundMessage Postgres Error: ${err.message}`);
      }
    }

    return record;
  }

  static async getPendingOutboundMessages(): Promise<OutboundMessage[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const query = `
          SELECT id, tenant_id, from_e164, to_e164, body, media_url, correlation_id, status, retry_count, error_message, created_at, next_retry_at
          FROM messages_out
          WHERE (status = 'pending') OR (status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
          ORDER BY created_at ASC
          LIMIT 50
        `;
        const res = await pool.query(query);
        const dbPending: OutboundMessage[] = res.rows.map((r) => ({
          id: r.id,
          tenant_id: r.tenant_id,
          from_e164: r.from_e164,
          to_e164: r.to_e164,
          body: r.body,
          media_url: r.media_url,
          correlation_id: r.correlation_id,
          status: r.status,
          retry_count: r.retry_count,
          error_message: r.error_message,
          created_at: r.created_at,
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
  ): Promise<void> {
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
        const query = `
          UPDATE messages_out
          SET status = $1, error_message = COALESCE($2, error_message), retry_count = COALESCE($3, retry_count)
          WHERE id = $4
        `;
        await pool.query(query, [status, error || null, retryCount || null, id]);
      } catch (err: any) {
        Logger.error(`DbClient.updateOutboundStatus Postgres Error: ${err.message}`);
      }
    }
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
   * Returns true if a matching record was found and updated.
   */
  static async updateDeliveryStatusByProviderSid(
    providerSid: string,
    status: 'sent' | 'delivered' | 'failed' | 'undelivered',
    errorDetails?: string
  ): Promise<{ updated: boolean; tenant_id?: string }> {
    let updated = false;
    let resolvedTenantId: string | undefined;

    for (const msg of this.messagesOutStore.values()) {
      if (msg.provider_sid === providerSid || msg.id === providerSid || msg.correlation_id?.includes(providerSid)) {
        msg.status = status;
        if (errorDetails) (msg as any).error_message = errorDetails;
        resolvedTenantId = msg.tenant_id;
        updated = true;
        break;
      }
    }

    for (const transcript of this.transcriptsStore.values()) {
      if (transcript.provider_sid === providerSid || transcript.message_id === providerSid) {
        transcript.delivery_status = status;
        if (errorDetails) transcript.error_message = errorDetails;
        if (!resolvedTenantId) resolvedTenantId = transcript.tenant_id;
        updated = true;
        break;
      }
    }

    const pool = this.getPool();
    if (pool) {
      try {
        const query1 = `UPDATE messages_out SET status = $1, error_message = $2 WHERE id = $3 OR correlation_id LIKE $4 RETURNING tenant_id`;
        const res1 = await pool.query(query1, [status, errorDetails || null, providerSid, `%${providerSid}%`]);
        if (res1.rowCount && res1.rowCount > 0) {
          updated = true;
          resolvedTenantId = res1.rows[0].tenant_id;
        }

        const query2 = `UPDATE messages SET delivery_status = $1 WHERE message_id = $2 OR provider_sid = $3 RETURNING tenant_id`;
        const res2 = await pool.query(query2, [status, providerSid, providerSid]);
        if (res2.rowCount && res2.rowCount > 0) {
          updated = true;
          if (!resolvedTenantId) resolvedTenantId = res2.rows[0].tenant_id;
        }
      } catch (err: any) {
        Logger.error(`DbClient.updateDeliveryStatusByProviderSid Postgres Error: ${err.message}`);
      }
    }

    return { updated, tenant_id: resolvedTenantId };
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
      try {
        // ON CONFLICT now uses the (tenant_id, project_id, customer_ref) unique constraint
        // added in migration 010. Falls back gracefully for rows where project_id is NULL.
        const query = `
          INSERT INTO conversations (conversation_id, tenant_id, project_id, organization_id, workspace_id, system_id, customer_ref, channel, state, incident_ids, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'sms', 'open', '[]'::jsonb, NOW(), NOW())
          ON CONFLICT (tenant_id, project_id, customer_ref) DO UPDATE SET updated_at = NOW()
          RETURNING conversation_id
        `;
        const res = await pool.query(query, [conv.conversation_id, orgId, projId, orgId, wsId, systemId, customerRef]);
        if (res.rows.length > 0) {
          conv.conversation_id = res.rows[0].conversation_id;
          this.conversationsStore.set(key, conv);
        }
      } catch (err: any) {
        Logger.error(`DbClient.getOrCreateConversation Postgres Error: ${err.message}`);
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

  static clearAll(): void {
    this.messagesInStore.clear();
    this.messagesOutStore.clear();
    this.conversationsStore.clear();
    this.transcriptsStore.clear();
    this.customersStore.clear();
    this.voiceDeliveriesStore.clear();
    this.alertAuditStore = [];
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
        ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
          customer_ref    = EXCLUDED.customer_ref,
          project_id      = COALESCE(EXCLUDED.project_id, customers.project_id),
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
            Logger.warn(`DbClient.lookupCustomerByPhoneAsync: cache row expired for ${cleanPhone} in project ${projectId}`);
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
          let whereClause = `WHERE (tenant_id = $1 OR organization_id = $1) AND phone_e164 = $2`;
          if (projectId) {
            params.push(projectId);
            whereClause += ` AND (project_id = $${params.length} OR project_id IS NULL)`;
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
          record.system_id || record.project_id || 'system-vfarm-01',
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
}

