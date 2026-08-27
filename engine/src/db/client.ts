import { InboundMessage, OutboundMessage } from '../transport/twilio/types.js';
import { randomUUID } from 'crypto';

interface CustomerRecord {
  phone_e164:   string;
  customer_ref: string;
  tenant_id:    string;
  unit_id?:     string;
  farm_id?:     string;
}

export class DbClient {
  private static messagesInStore:    Map<string, InboundMessage>  = new Map();
  private static messagesOutStore:   Map<string, OutboundMessage> = new Map();
  private static conversationsStore: Map<string, any>             = new Map();
  private static transcriptsStore:   Map<string, any>             = new Map();
  /** customers table: keyed by "tenant_id:phone_e164" */
  private static customersStore:     Map<string, CustomerRecord>  = new Map();

  /**
   * Save inbound message and handle MessageSid deduplication.
   * Return isDuplicate: true if message_id was already present.
   */
  static async saveInboundMessage(msg: InboundMessage): Promise<{ isDuplicate: boolean }> {
    if (this.messagesInStore.has(msg.message_id)) {
      return { isDuplicate: true };
    }
    this.messagesInStore.set(msg.message_id, { ...msg });
    return { isDuplicate: false };
  }

  static async saveOutboundMessage(msg: OutboundMessage): Promise<OutboundMessage> {
    const id = msg.id || `out_${randomUUID()}`;
    const record: OutboundMessage = {
      ...msg,
      id,
      status: msg.status || 'pending',
      created_at: msg.created_at || new Date().toISOString(),
    };
    this.messagesOutStore.set(id, record);
    return record;
  }

  static async getPendingOutboundMessages(): Promise<OutboundMessage[]> {
    const pending: OutboundMessage[] = [];
    for (const msg of this.messagesOutStore.values()) {
      if (msg.status === 'pending') {
        pending.push(msg);
      }
    }
    return pending;
  }

  static async updateOutboundStatus(
    id: string,
    status: 'pending' | 'sent' | 'failed' | 'refused' | 'delivered' | 'undelivered',
    error?: string
  ): Promise<void> {
    const msg = this.messagesOutStore.get(id);
    if (msg) {
      msg.status = status;
      if (error) (msg as any).error_message = error;
      this.messagesOutStore.set(id, msg);
    }
  }

  /** Record the Twilio from-number that was used to send this outbound message (GAP-5 fix). */
  static async updateOutboundFromE164(id: string, fromE164: string): Promise<void> {
    const msg = this.messagesOutStore.get(id);
    if (msg) {
      msg.from_e164 = fromE164;
      this.messagesOutStore.set(id, msg);
    }
  }

  /** Associate provider_sid (Twilio MessageSid) with an outbound message. */
  static async updateOutboundProviderSid(id: string, providerSid: string): Promise<void> {
    const msg = this.messagesOutStore.get(id);
    if (msg) {
      msg.provider_sid = providerSid;
      this.messagesOutStore.set(id, msg);
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

    // 1. Update outbound store
    for (const msg of this.messagesOutStore.values()) {
      if (msg.provider_sid === providerSid || msg.id === providerSid || msg.correlation_id?.includes(providerSid)) {
        msg.status = status;
        if (errorDetails) (msg as any).error_message = errorDetails;
        resolvedTenantId = msg.tenant_id;
        updated = true;
        break;
      }
    }

    // 2. Update transcripts store
    for (const transcript of this.transcriptsStore.values()) {
      if (transcript.provider_sid === providerSid || transcript.message_id === providerSid) {
        transcript.delivery_status = status;
        if (errorDetails) transcript.error_message = errorDetails;
        if (!resolvedTenantId) resolvedTenantId = transcript.tenant_id;
        updated = true;
        break;
      }
    }

    return { updated, tenant_id: resolvedTenantId };
  }



  static async getOrCreateConversation(
    tenantId: string,
    systemId: string,
    customerRef: string
  ): Promise<{ conversation_id: string }> {
    const key = `${tenantId}:${customerRef}`;
    let conv = this.conversationsStore.get(key);
    if (!conv) {
      conv = {
        conversation_id: `conv_${randomUUID()}`,
        tenant_id: tenantId,
        system_id: systemId,
        customer_ref: customerRef,
        channel: 'sms',
        state: 'open',
        incident_ids: [],
        created_at: new Date().toISOString(),
      };
      this.conversationsStore.set(key, conv);
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
  }

  // ── Customer Registry (mirrors `customers` table in Postgres) ─────────────

  /**
   * Seed one or more customer records into the in-memory customers store.
   * Called by tests and the app bootstrap to load records from the DB.
   * Equivalent to INSERT ... ON CONFLICT DO UPDATE.
   */
  static seedCustomer(record: CustomerRecord): void {
    const key = `${record.tenant_id}:${record.phone_e164}`;
    this.customersStore.set(key, record);
  }

  /**
   * Look up a known customer by their E.164 phone number and tenant.
   * Returns null if the phone is not registered (unknown sender path).
   */
  static lookupCustomerByPhone(
    phoneE164: string,
    tenantId: string
  ): CustomerRecord | null {
    const key = `${tenantId}:${phoneE164}`;
    return this.customersStore.get(key) ?? null;
  }

  /** How many customers are seeded (for test assertions). */
  static getCustomerCount(): number {
    return this.customersStore.size;
  }
}
