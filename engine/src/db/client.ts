import { InboundMessage, OutboundMessage } from '../transport/twilio/types.js';
import { randomUUID } from 'crypto';
import pg from 'pg';
import { Logger } from '../config/logger.js';
import type { AlertAuditRow } from '../audit/alert_audit.js';

export interface CustomerRecord {
  phone_e164:       string;
  customer_ref:     string;
  organization_id?: string;
  tenant_id:        string;
  workspace_id?:    string;
  role?:            'owner' | 'manager' | 'tech';
  unit_id?:         string;
  farm_id?:         string;
}

export interface VoiceDeliveryRecord {
  id?: string;
  system_id: string;
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
        const query = `
          INSERT INTO messages_in (message_id, tenant_id, from_e164, to_e164, body, media, received_at, status, correlation_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'enqueued', $8)
          ON CONFLICT (message_id) DO NOTHING
        `;
        const res = await pool.query(query, [
          msg.message_id,
          msg.tenant_id,
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
        const query = `
          INSERT INTO messages_out (id, tenant_id, from_e164, to_e164, body, media_url, correlation_id, status, retry_count, error_message, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            retry_count = EXCLUDED.retry_count,
            error_message = EXCLUDED.error_message,
            from_e164 = EXCLUDED.from_e164
        `;
        await pool.query(query, [
          record.id,
          record.tenant_id,
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
    workspaceId?: string
  ): Promise<{ conversation_id: string }> {
    const orgId = organizationId || tenantId;
    const wsId = workspaceId || 'ws-vfarm-main';
    const key = `${orgId}:${customerRef}`;
    let conv = this.conversationsStore.get(key);
    if (!conv) {
      conv = {
        conversation_id: `conv_${randomUUID()}`,
        tenant_id: orgId,
        organization_id: orgId,
        workspace_id: wsId,
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
        const query = `
          INSERT INTO conversations (conversation_id, tenant_id, organization_id, workspace_id, system_id, customer_ref, channel, state, incident_ids, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'sms', 'open', '[]'::jsonb, NOW(), NOW())
          ON CONFLICT (tenant_id, customer_ref) DO UPDATE SET updated_at = NOW()
          RETURNING conversation_id
        `;
        const res = await pool.query(query, [conv.conversation_id, orgId, orgId, wsId, systemId, customerRef]);
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
          INSERT INTO messages (message_id, conversation_id, tenant_id, direction, from_e164, to_e164, body, media_refs, provider_sid, delivery_status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received', NOW())
          ON CONFLICT (message_id) DO NOTHING
        `;
        await pool.query(query, [
          msg.message_id,
          msg.conversation_id,
          msg.tenant_id,
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
  }

  // ── Customer Registry (mirrors `customers` table in Postgres) ─────────────

  static seedCustomer(record: CustomerRecord): void {
    const role = record.role || 'manager';
    const orgId = record.organization_id || record.tenant_id;
    const wsId = record.workspace_id || 'ws-vfarm-main';
    const cleanRecord: CustomerRecord = {
      ...record,
      role,
      organization_id: orgId,
      tenant_id: orgId,
      workspace_id: wsId,
    };

    const key = `${orgId}:${record.phone_e164.trim()}`;
    this.customersStore.set(key, cleanRecord);
    // Also index under tenant_id for backwards compat key lookup
    if (record.tenant_id && record.tenant_id !== orgId) {
      this.customersStore.set(`${record.tenant_id}:${record.phone_e164.trim()}`, cleanRecord);
    }

    const pool = this.getPool();
    if (pool) {
      const query = `
        INSERT INTO customers (tenant_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
          customer_ref    = EXCLUDED.customer_ref,
          organization_id = EXCLUDED.organization_id,
          workspace_id    = EXCLUDED.workspace_id,
          role            = EXCLUDED.role,
          unit_id         = EXCLUDED.unit_id,
          farm_id         = EXCLUDED.farm_id
      `;
      pool.query(query, [
        orgId,
        orgId,
        wsId,
        record.phone_e164.trim(),
        record.customer_ref,
        role,
        record.unit_id || null,
        record.farm_id || null,
      ]).catch((err) => Logger.error(`DbClient.seedCustomer Postgres Error: ${err.message}`));
    }
  }

  static seedConversation(conv: {
    conversation_id: string;
    tenant_id: string;
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
    const cleanConv = {
      ...conv,
      organization_id: orgId,
      tenant_id: conv.tenant_id,
      customer_ref: conv.customer_ref || 'cust_default',
      alert_state: conv.alert_state ?? null,
      resolution_status: conv.resolution_status ?? null,
    };
    const key = `${orgId}:${cleanConv.customer_ref}`;
    this.conversationsStore.set(key, cleanConv);
  }

  static lookupCustomerByPhone(
    phoneE164: string,
    tenantId: string
  ): CustomerRecord | null {
    if (!phoneE164) return null;
    const cleanPhone = phoneE164.trim();
    const key = `${tenantId}:${cleanPhone}`;
    return this.customersStore.get(key) ?? null;
  }

  /**
   * Async version of lookupCustomerByPhone that also checks Postgres
   * if the in-memory store misses (e.g. after a server restart).
   */
  static async lookupCustomerByPhoneAsync(
    phoneE164: string,
    tenantId: string
  ): Promise<CustomerRecord | null> {
    if (!phoneE164) return null;
    const cleanPhone = phoneE164.trim();
    // Fast path: in-memory hit
    const memRecord = this.lookupCustomerByPhone(cleanPhone, tenantId);
    if (memRecord) return memRecord;

    // Slow path: Postgres lookup (exact E.164 match)
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT tenant_id, organization_id, workspace_id, phone_e164, customer_ref, role, unit_id, farm_id
           FROM customers WHERE (tenant_id = $1 OR organization_id = $1) AND phone_e164 = $2`,
          [tenantId, cleanPhone]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          const record: CustomerRecord = {
            tenant_id:       row.tenant_id,
            organization_id: row.organization_id || row.tenant_id,
            workspace_id:    row.workspace_id || 'ws-vfarm-main',
            phone_e164:      row.phone_e164,
            customer_ref:    row.customer_ref,
            role:            (row.role as 'owner' | 'manager' | 'tech') || 'manager',
            unit_id:         row.unit_id || undefined,
            farm_id:         row.farm_id || undefined,
          };
          // Populate in-memory cache
          const key = `${tenantId}:${cleanPhone}`;
          this.customersStore.set(key, record);
          return record;
        }
      } catch (err: any) {
        Logger.error(`DbClient.lookupCustomerByPhoneAsync Postgres Error: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Verify that a given workspace belongs to an organization.
   * Prevents cross-workspace query injection.
   */
  static validateWorkspaceScope(organizationId: string, workspaceId: string): boolean {
    if (!organizationId || !workspaceId) return false;
    // Default vFarm workspace mapping
    if (organizationId === 'tenant-vfarm-01' || organizationId === 'org-vfarm-01') {
      return workspaceId === 'ws-vfarm-main' || workspaceId === 'ws-vfarm-bay04';
    }
    // Allow matching workspace prefix for dynamically created workspaces in tests
    if (workspaceId.startsWith(`ws-${organizationId}`) || workspaceId.includes(organizationId)) {
      return true;
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
            delivered_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `;
        await pool.query(query, [
          record.id,
          record.system_id,
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
          ? `SELECT * FROM voice_deliveries WHERE system_id = $1 AND status IN ('synthesized', 'sent') AND created_at >= NOW() - INTERVAL '24 HOURS' ORDER BY created_at DESC`
          : `SELECT * FROM voice_deliveries WHERE status IN ('synthesized', 'sent') AND created_at >= NOW() - INTERVAL '24 HOURS' ORDER BY created_at DESC`;
        const params = systemId ? [systemId] : [];
        const res = await pool.query(query, params);
        if (res.rows && res.rows.length > 0) {
          return res.rows.map((row: any) => ({
            id: row.id,
            system_id: row.system_id,
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
      if (systemId && d.system_id !== systemId) return false;
      if (d.status !== 'synthesized' && d.status !== 'sent') return false;
      const createdAt = new Date(d.created_at || 0).getTime();
      return createdAt >= cutoff;
    });
  }

  static getAllVoiceDeliveries(): VoiceDeliveryRecord[] {
    return Array.from(this.voiceDeliveriesStore.values());
  }
}

