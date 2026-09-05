import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';

describe('Swagger API Documentation Endpoints', () => {
  const app = createApp();

  it('serves raw OpenAPI 3.0.3 JSON specification at GET /api-docs.json', async () => {
    const res = await request(app).get('/api-docs.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.info.title).toContain('Customer Service Twin');
    expect(res.body.paths).toBeDefined();

    // Verify key paths are documented
    expect(res.body.paths['/webhooks/twilio/sms']).toBeDefined();
    expect(res.body.paths['/webhooks/twilio/sms'].post).toBeDefined();
    expect(res.body.paths['/webhooks/twilio/delivery-status']).toBeDefined();
    expect(res.body.paths['/health']).toBeDefined();
    expect(res.body.paths['/debug/state']).toBeDefined();

    // Verify schemas are present
    expect(res.body.components.schemas.TwilioSmsWebhookBody).toBeDefined();
    expect(res.body.components.schemas.TwilioDeliveryStatusBody).toBeDefined();
    expect(res.body.components.schemas.HealthResponse).toBeDefined();
  });

  it('serves Swagger UI HTML page at GET /api-docs/', async () => {
    const res = await request(app).get('/api-docs/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('swagger-ui');
  });

  it('redirects /api-docs to /api-docs/ for Swagger UI assets', async () => {
    const res = await request(app).get('/api-docs');

    // Express router / swagger-ui redirects bare /api-docs to /api-docs/ with 301
    expect([200, 301]).toContain(res.status);
  });

  it('redirects root / to /api-docs', async () => {
    const res = await request(app).get('/');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/api-docs');
  });
});
