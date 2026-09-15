import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { DbClient } from '../../engine/src/db/client.js';
import { normalizeTwilioInbound } from '../../engine/src/transport/twilio/normalize.js';

import { seedTestCustomers } from '../helpers/seed_customers.js';
import { SystemsRegistry } from '../../engine/src/systems/registry.js';

describe('Inbound Transport Unit Tests', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    SystemsRegistry.resetToDefault();
    seedTestCustomers();
  });

  it('correctly normalizes raw Twilio webhook payload including media', () => {
    const payload = {
      MessageSid: 'SM100200300',
      From: '+15551234567',
      To: '+19715885823',
      Body: 'Check out this sensor photo',
      NumMedia: '2',
      MediaUrl0: 'https://media.twilio.com/photo1.jpg',
      MediaUrl1: 'https://media.twilio.com/photo2.jpg',
    };

    const normalized = normalizeTwilioInbound(payload, 'tenant-vfarm-01');

    expect(normalized.message_id).toBe('SM100200300');
    expect(normalized.tenant_id).toBe('tenant-vfarm-01');
    expect(normalized.from_e164).toBe('+15551234567');
    expect(normalized.to_e164).toBe('+19715885823');
    expect(normalized.body).toBe('Check out this sensor photo');
    expect(normalized.media).toEqual([
      'https://media.twilio.com/photo1.jpg',
      'https://media.twilio.com/photo2.jpg',
    ]);
  });

  it('deduplicates duplicate MessageSid webhooks', async () => {
    const duplicatePayload = {
      MessageSid: 'SM_DEDUP_001',
      From: '+15551234567',
      To: '+19715885823',
      Body: 'First transmission',
    };

    // First request
    const res1 = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send(duplicatePayload);

    expect(res1.status).toBe(204);

    // Second request with duplicate MessageSid
    const res2 = await request(app)
      .post('/webhooks/twilio/sms')
      .set('x-test-bypass-signature', 'true')
      .type('form')
      .send(duplicatePayload);

    expect(res2.status).toBe(204);

    // Store should contain exactly 1 entry for SM_DEDUP_001
    expect(DbClient.getInboundMessage('SM_DEDUP_001')).toBeDefined();
  });
});
