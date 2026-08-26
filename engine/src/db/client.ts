import { InboundMessage, OutboundMessage } from '../transport/twilio/types.js';
import { randomUUID } from 'crypto';

export class DbClient {
  private static messagesInStore: Map<string, InboundMessage> = new Map();
  private static messagesOutStore: Map<string, OutboundMessage> = new Map();
  private static conversationsStore: Map<string, any> = new Map();
  private static transcriptsStore: Map<string, any> = new Map();

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
    status: 'pending' | 'sent' | 'failed' | 'refused',
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
  }
}
