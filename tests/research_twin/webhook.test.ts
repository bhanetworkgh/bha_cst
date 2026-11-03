import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { createHmac } from 'crypto';

const app = createApp();

describe('Research Twin Signed Webhook Callback', () => {
  const SECRET = 'test-signing-secret-key-12345';
  let origSecret: string | undefined;

  beforeEach(() => {
    origSecret = process.env.RT_CALLBACK_SIGNING_SECRET;
    process.env.RT_CALLBACK_SIGNING_SECRET = SECRET;
  });

  afterEach(() => {
    process.env.RT_CALLBACK_SIGNING_SECRET = origSecret;
  });

  it('rejects callback with 503 if secret is not configured', async () => {
    delete process.env.RT_CALLBACK_SIGNING_SECRET;
    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .send({ investigation_id: 'inv-1' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('CONFIG_MISSING');
  });

  it('rejects callback with 401 if signature header is missing', async () => {
    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .send({ investigation_id: 'inv-1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('rejects callback with 403 if signature is invalid', async () => {
    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('X-RT-Signature', 'sha256=invalidhexsignature000000000000000000000000000000000000000000000000')
      .send({ investigation_id: 'inv-1' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('rejects callback with 400 if timestamp is older than 300 seconds', async () => {
    const payload = {
      investigation_id: 'inv-1',
      status: 'resolved',
      timestamp: new Date(Date.now() - 400_000).toISOString(),
    };
    const bodyStr = JSON.stringify(payload);
    const signature = createHmac('sha256', SECRET).update(bodyStr).digest('hex');

    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', `sha256=${signature}`)
      .send(bodyStr);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('REPLAY_DETECTED');
  });

  it('accepts valid HMAC-SHA256 callback with 200 OK', async () => {
    const payload = {
      investigation_id: 'inv-100',
      status: 'in_progress',
      timestamp: new Date().toISOString(),
      notes: 'Agronomic team dispatched to inspect soil sensor.',
    };
    const bodyStr = JSON.stringify(payload);
    const signature = createHmac('sha256', SECRET).update(bodyStr).digest('hex');

    const res = await request(app)
      .post('/webhooks/research-twin/callback')
      .set('Content-Type', 'application/json')
      .set('X-RT-Signature', `sha256=${signature}`)
      .send(bodyStr);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'received',
      investigation_id: 'inv-100',
      verified: true,
    });
  });
});

