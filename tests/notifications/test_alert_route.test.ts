/**
 * POST /api/v1/alerts/test — operator alert test.
 *
 * Pins three things: the route is locked behind CST_API_KEY (fails closed),
 * each test alert goes through the real alert paths (ErrorRouter classes CST
 * and CS_HANDOFF, and SlackNotifier), and no webhook URL ever comes back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { ErrorRouter } from '../../engine/src/notifications/error_router.js';
import { SlackNotifier } from '../../engine/src/notifications/slack.js';

const SECRET = 'test_programmatic_api_key_32_chars_long';

describe('Operator alert test route', () => {
  const app = createApp();
  let routed: string[] = [];
  let notified = 0;

  beforeEach(() => {
    process.env.CST_API_KEY = SECRET;
    routed = [];
    notified = 0;
    ErrorRouter.setMockHandler((classified) => {
      routed.push(classified.error_class);
      return true;
    });
    SlackNotifier.setMockHandler(() => {
      notified += 1;
    });
  });

  afterEach(() => {
    delete process.env.CST_API_KEY;
    ErrorRouter.reset();
    SlackNotifier.reset();
  });

  it('refuses a request with no key', async () => {
    const res = await request(app).post('/api/v1/alerts/test').send({});
    expect(res.status).toBe(401);
    expect(routed).toEqual([]);
  });

  it('refuses a wrong key', async () => {
    const res = await request(app).post('/api/v1/alerts/test').set('x-cst-api-key', 'wrong').send({});
    expect(res.status).toBe(403);
    expect(routed).toEqual([]);
  });

  it('fails closed when CST_API_KEY is unset', async () => {
    delete process.env.CST_API_KEY;
    const res = await request(app).post('/api/v1/alerts/test').set('x-cst-api-key', SECRET).send({});
    expect(res.status).toBe(503);
    expect(routed).toEqual([]);
  });

  it('sends one test alert down each real path by default', async () => {
    const res = await request(app).post('/api/v1/alerts/test').set('x-cst-api-key', SECRET).send({ requested_by: 'test' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(routed.sort()).toEqual(['CST', 'CS_HANDOFF']);
    expect(notified).toBe(1);
    expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\//);
  });

  it('sends only the kinds asked for, and rejects unknown kinds', async () => {
    const one = await request(app).post('/api/v1/alerts/test').set('x-cst-api-key', SECRET).send({ kinds: ['cs_handoff'] });
    expect(one.status).toBe(200);
    expect(routed).toEqual(['CS_HANDOFF']);

    const bad = await request(app).post('/api/v1/alerts/test').set('x-cst-api-key', SECRET).send({ kinds: ['everything'] });
    expect(bad.status).toBe(400);
  });
});
