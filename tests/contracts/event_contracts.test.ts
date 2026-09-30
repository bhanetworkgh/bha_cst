import { describe, it, expect } from 'vitest';
import {
  CST_EVENT_SPEC_VERSION,
  ALLOWED_CHANNELS,
  ALLOWED_TURN_STATUSES,
  ALLOWED_DELIVERY_STATUSES,
  ALLOWED_OPERATIONAL_STATUSES,
  ALLOWED_STATUSES,
  ALLOWED_INTENTS,
  ALLOWED_CUSTOMER_ROLES,
  isAllowedChannel,
  isAllowedTurnStatus,
  isAllowedDeliveryStatus,
  isAllowedStatus,
  isStandardIntent,
  parseCstEventV1,
  safeParseCstEventV1,
  createCstTurnEventV1,
  createCstDeliveryEventV1,
  CstEventV1Schema,
  CstTurnSchema,
  CstDeliverySchema,
  CustomerPayloadSchema,
  CstTurn,
  CstDelivery,
  CustomerPayload,
  CstEventV1,
} from '../../engine/src/contracts/index.js';

describe('Task 1 — Event contract/types (cst.event.v1)', () => {
  const sampleCustomer: CustomerPayload = {
    customer_ref: 'cust_vfarm_001_john_doe',
    phone_e164: '+15551234567',
    role: 'owner',
    is_known: true,
    tenant_id: 'tenant_vfarm',
    project_id: 'proj_vfarm_primary',
    person_id: 'person_001',
    name: 'John Doe',
    farm_ids: ['farm_alpha', 'farm_beta'],
    metadata: { tier: 'enterprise' },
  };

  describe('Allowed Channels', () => {
    it('defines the canonical allowed channels', () => {
      expect(ALLOWED_CHANNELS).toEqual(['sms', 'voice', 'web', 'whatsapp', 'email']);
    });

    it('validates allowed channels using isAllowedChannel', () => {
      for (const channel of ALLOWED_CHANNELS) {
        expect(isAllowedChannel(channel)).toBe(true);
      }
      expect(isAllowedChannel('pager')).toBe(false);
      expect(isAllowedChannel('')).toBe(false);
      expect(isAllowedChannel(null)).toBe(false);
      expect(isAllowedChannel(undefined)).toBe(false);
    });
  });

  describe('Allowed Statuses & Delivery Statuses', () => {
    it('includes all turn statuses in ALLOWED_TURN_STATUSES', () => {
      expect(ALLOWED_TURN_STATUSES).toEqual([
        'received',
        'processing',
        'synthesized',
        'completed',
        'refused',
        'dropped',
        'failed',
        'timeout',
        'step_up',
        'step_up_required',
        'onboarding',
      ]);
    });

    it('includes all delivery statuses in ALLOWED_DELIVERY_STATUSES', () => {
      expect(ALLOWED_DELIVERY_STATUSES).toEqual([
        'pending',
        'queued',
        'sending',
        'sent',
        'delivered',
        'undelivered',
        'failed',
        'refused',
      ]);
    });

    it('includes operational statuses in ALLOWED_OPERATIONAL_STATUSES', () => {
      expect(ALLOWED_OPERATIONAL_STATUSES).toEqual(['active', 'suspended', 'closed']);
    });

    it('validates statuses with type guards', () => {
      expect(isAllowedTurnStatus('synthesized')).toBe(true);
      expect(isAllowedTurnStatus('delivered')).toBe(false);

      expect(isAllowedDeliveryStatus('delivered')).toBe(true);
      expect(isAllowedDeliveryStatus('synthesized')).toBe(false);

      expect(isAllowedStatus('completed')).toBe(true);
      expect(isAllowedStatus('delivered')).toBe(true);
      expect(isAllowedStatus('active')).toBe(true);
      expect(isAllowedStatus('bogus_status')).toBe(false);
    });
  });

  describe('Intents', () => {
    it('defines standard CST intents', () => {
      expect(ALLOWED_INTENTS).toEqual(['status', 'knowledge', 'images', 'escalate', 'default']);
    });

    it('validates standard intents with isStandardIntent', () => {
      expect(isStandardIntent('status')).toBe(true);
      expect(isStandardIntent('knowledge')).toBe(true);
      expect(isStandardIntent('escalate')).toBe(true);
      expect(isStandardIntent('arbitrary_intent')).toBe(false);
    });
  });

  describe('Customer Payload', () => {
    it('validates a complete customer payload', () => {
      const parsed = CustomerPayloadSchema.parse(sampleCustomer);
      expect(parsed.customer_ref).toBe('cust_vfarm_001_john_doe');
      expect(parsed.role).toBe('owner');
      expect(parsed.farm_ids).toEqual(['farm_alpha', 'farm_beta']);
    });

    it('validates customer roles', () => {
      expect(ALLOWED_CUSTOMER_ROLES).toEqual(['owner', 'manager', 'tech', 'unknown']);
    });

    it('fails on missing required customer boundary fields', () => {
      const invalid = { customer_ref: 'cust_1' };
      const result = CustomerPayloadSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe('cst.turn Contract', () => {
    it('validates an inbound/outbound turn with duration and intent', () => {
      const turn: CstTurn = {
        turn_id: 'turn_1001',
        conversation_id: 'conv_555',
        direction: 'inbound',
        channel: 'voice',
        status: 'synthesized',
        intent: 'status',
        text: 'What is the temperature in Greenhouse A?',
        reply_text: 'Current temperature in Greenhouse A is 22.4 degrees Celsius.',
        audio_url: 'https://media.cst.internal/audio/turn_1001.mp3',
        voice_id: 'eleven_voice_jason',
        duration: {
          total_ms: 1850,
          processing_ms: 450,
          synthesis_ms: 1200,
          call_seconds: 12,
        },
      };

      const parsed = CstTurnSchema.parse(turn);
      expect(parsed.turn_id).toBe('turn_1001');
      expect(parsed.status).toBe('synthesized');
      expect(parsed.duration).toEqual({
        total_ms: 1850,
        processing_ms: 450,
        synthesis_ms: 1200,
        call_seconds: 12,
      });
    });

    it('allows numeric duration in milliseconds', () => {
      const turn: CstTurn = {
        turn_id: 'turn_1002',
        direction: 'outbound',
        channel: 'sms',
        status: 'completed',
        text: 'Alert: Pump 3 pressure nominal',
        duration: 340,
      };

      const parsed = CstTurnSchema.parse(turn);
      expect(parsed.duration).toBe(340);
    });
  });

  describe('cst.delivery Contract', () => {
    it('validates outbound delivery with delivery status and provider info', () => {
      const delivery: CstDelivery = {
        delivery_id: 'del_9001',
        provider_sid: 'SM1234567890abcdef',
        channel: 'sms',
        to: '+15551234567',
        from: '+15559876543',
        status: 'delivered',
        intent: 'status',
        duration: 125,
        segments: 1,
        delivered_at: '2026-09-30T16:00:00.000Z',
      };

      const parsed = CstDeliverySchema.parse(delivery);
      expect(parsed.delivery_id).toBe('del_9001');
      expect(parsed.status).toBe('delivered');
      expect(parsed.segments).toBe(1);
    });

    it('validates failed delivery with error code and retry count', () => {
      const failedDelivery: CstDelivery = {
        delivery_id: 'del_9002',
        provider_sid: 'SM9999999999',
        channel: 'sms',
        to: '+15550000000',
        status: 'failed',
        error_code: 30008,
        error_message: 'Unknown error',
        retry_count: 3,
      };

      const parsed = CstDeliverySchema.parse(failedDelivery);
      expect(parsed.status).toBe('failed');
      expect(parsed.error_code).toBe(30008);
      expect(parsed.retry_count).toBe(3);
    });
  });

  describe('cst.event.v1 Envelope & Discriminated Union', () => {
    it('creates and parses a valid cst.turn event', () => {
      const event = createCstTurnEventV1({
        id: 'evt_turn_001',
        tenant_id: 'tenant_vfarm',
        project_id: 'proj_vfarm_primary',
        correlation_id: 'corr_turn_abc',
        channel: 'voice',
        customer: sampleCustomer,
        turn: {
          turn_id: 'turn_001',
          direction: 'inbound',
          channel: 'voice',
          status: 'completed',
          intent: 'status',
          text: 'Check Zone 1 moisture',
          reply_text: 'Zone 1 moisture is 68%',
          duration: { total_ms: 820 },
        },
      });

      expect(event.specversion).toBe(CST_EVENT_SPEC_VERSION);
      expect(event.type).toBe('cst.turn');
      expect(event.data.turn_id).toBe('turn_001');

      const validated = parseCstEventV1(event);
      expect(validated.type).toBe('cst.turn');
      if (validated.type === 'cst.turn') {
        expect(validated.data.intent).toBe('status');
      }
    });

    it('creates and parses a valid cst.delivery event', () => {
      const event = createCstDeliveryEventV1({
        id: 'evt_del_001',
        tenant_id: 'tenant_vfarm',
        project_id: 'proj_vfarm_primary',
        correlation_id: 'corr_del_xyz',
        channel: 'sms',
        customer: sampleCustomer,
        delivery: {
          delivery_id: 'del_001',
          provider_sid: 'SMabc123',
          channel: 'sms',
          to: '+15551234567',
          status: 'delivered',
          duration: 350,
        },
      });

      expect(event.specversion).toBe('cst.event.v1');
      expect(event.type).toBe('cst.delivery');
      expect(event.data.delivery_id).toBe('del_001');

      const validated = parseCstEventV1(event);
      expect(validated.type).toBe('cst.delivery');
      if (validated.type === 'cst.delivery') {
        expect(validated.data.status).toBe('delivered');
      }
    });

    it('fails closed when specversion is not cst.event.v1', () => {
      const invalidEvent = {
        specversion: 'v0.9',
        type: 'cst.turn',
        id: 'evt_invalid',
        source: 'test',
        time: new Date().toISOString(),
        tenant_id: 'tenant_1',
        project_id: 'proj_1',
        correlation_id: 'corr_1',
        channel: 'sms',
        customer: sampleCustomer,
        data: {
          turn_id: 't1',
          direction: 'inbound',
          channel: 'sms',
          status: 'received',
        },
      };

      const result = safeParseCstEventV1(invalidEvent);
      expect(result.success).toBe(false);
    });

    it('fails closed when channel is not allowed', () => {
      const invalidEvent = {
        specversion: 'cst.event.v1',
        type: 'cst.turn',
        id: 'evt_invalid_channel',
        source: 'test',
        time: new Date().toISOString(),
        tenant_id: 'tenant_1',
        project_id: 'proj_1',
        correlation_id: 'corr_1',
        channel: 'unsupported_carrier',
        customer: sampleCustomer,
        data: {
          turn_id: 't1',
          direction: 'inbound',
          channel: 'sms',
          status: 'received',
        },
      };

      const result = safeParseCstEventV1(invalidEvent);
      expect(result.success).toBe(false);
    });

    it('fails closed when delivery status is not allowed', () => {
      const invalidEvent = {
        specversion: 'cst.event.v1',
        type: 'cst.delivery',
        id: 'evt_invalid_delivery',
        source: 'test',
        time: new Date().toISOString(),
        tenant_id: 'tenant_1',
        project_id: 'proj_1',
        correlation_id: 'corr_1',
        channel: 'sms',
        customer: sampleCustomer,
        data: {
          delivery_id: 'del_bad',
          channel: 'sms',
          to: '+15551234567',
          status: 'partially_sent', // not an allowed delivery status
        },
      };

      const result = safeParseCstEventV1(invalidEvent);
      expect(result.success).toBe(false);
    });
  });
});
