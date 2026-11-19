import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { Logger } from '../../engine/src/config/logger.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('LOOP-1795035800169-NVLF: Content-Type Validation, Observability & Error Handling', () => {
  let app: any;

  beforeEach(() => {
    DbClient.clearAll();
    app = createApp();
  });

  it('rejects POST to JSON endpoint without Content-Type with HTTP 400 and structured envelope', async () => {
    const res = await request(app)
      .post('/api/v1/web/session')
      .unset('Content-Type')
      .send('{"user":"demo-owner"}');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'UNSUPPORTED_MEDIA_TYPE');
    expect(res.body).toHaveProperty('message', 'Content-Type must be application/json');
    expect(res.body).toHaveProperty('correlation_id');
    expect(res.headers['x-correlation-id']).toBe(res.body.correlation_id);

    // Verify structured security ledger event was recorded
    const recentEvents = Logger.getRecentAuditEvents(10);
    const auditEvent = recentEvents.find(
      (e) => e.outcome === 'refused' && (e.reason === 'MISSING_CONTENT_TYPE' || e.reason === 'UNSUPPORTED_CONTENT_TYPE')
    );
    expect(auditEvent).toBeDefined();
    expect(auditEvent?.correlation_id).toBe(res.body.correlation_id);
    expect(auditEvent?.details?.service).toBe('cst');
    expect(auditEvent?.details?.component).toBe('content_type_validator');
    expect(auditEvent?.details?.http_status).toBe(400);
    expect(auditEvent?.details?.error_code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects POST to JSON endpoint with text/plain with HTTP 400', async () => {
    const customCorrelationId = 'corr_test_text_plain_123';
    const res = await request(app)
      .post('/api/v1/web/session')
      .set('Content-Type', 'text/plain')
      .set('X-Correlation-ID', customCorrelationId)
      .send('user=demo-owner');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'UNSUPPORTED_MEDIA_TYPE');
    expect(res.body).toHaveProperty('message', 'Content-Type must be application/json');
    expect(res.body.correlation_id).toBe(customCorrelationId);
    expect(res.headers['x-correlation-id']).toBe(customCorrelationId);

    const recentEvents = Logger.getRecentAuditEvents(10);
    const auditEvent = recentEvents.find(
      (e) => e.outcome === 'refused' && e.reason === 'UNSUPPORTED_CONTENT_TYPE'
    );
    expect(auditEvent).toBeDefined();
    expect(auditEvent?.details?.classification).toBe('client_protocol_error');
    expect(auditEvent?.details?.source_system).toBe('cst_gateway');
  });

  it('rejects unsupported media type multipart/form-data on JSON endpoint with HTTP 400', async () => {
    const res = await request(app)
      .post('/api/v1/web/session')
      .set('Content-Type', 'multipart/form-data; boundary=---boundary123')
      .send('---boundary123\r\nContent-Disposition: form-data; name="user"\r\n\r\ndemo-owner\r\n---boundary123--\r\n');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects POST to webhook JSON endpoint with text/plain with HTTP 400', async () => {
    const res = await request(app)
      .post('/webhooks/elevenlabs')
      .set('Content-Type', 'text/plain')
      .send('raw webhook string');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('allows POST to JSON endpoint with application/json and valid body', async () => {
    const res = await request(app)
      .post('/api/v1/web/session')
      .set('Content-Type', 'application/json')
      .send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });

    // Under test runner, this creates a valid session and returns 201
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('session');
  });

  it('catches malformed JSON on application/json requests and returns HTTP 400 MALFORMED_JSON', async () => {
    const res = await request(app)
      .post('/api/v1/web/session')
      .set('Content-Type', 'application/json')
      .send('{ "user": "demo-owner", invalid_json }');

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'MALFORMED_JSON');
    expect(res.body).toHaveProperty('message', 'Request body contains invalid JSON');
    expect(res.body).toHaveProperty('correlation_id');
    expect(res.headers['x-correlation-id']).toBe(res.body.correlation_id);
  });

  it('does NOT reject Twilio webhook POST with application/x-www-form-urlencoded', async () => {
    const res = await request(app)
      .post('/webhooks')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('From=%2B15551234567&To=%2B19715885823&Body=Status&MessageSid=SM_TEST_NVLF');

    // Twilio router handles form-urlencoded, doesn't reject with 400 UNSUPPORTED_MEDIA_TYPE
    expect(res.status).not.toBe(400);
  });

  it('rejects Twilio webhook when signature is missing (proves signature gate intact)', async () => {
    const res = await request(app)
      .post('/webhooks/voice/inbound')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('CallSid=CA123&From=%2B15551234567');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error', 'UNAUTHORIZED');
  });

  it('does NOT reject GET requests to any endpoint without Content-Type', async () => {
    const res = await request(app).get('/api/v1/web/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('allows empty-body POST to allowlisted logout route without Content-Type', async () => {
    const res = await request(app)
      .post('/api/v1/web/logout')
      .set('x-cst-session', 'web_test_nonexistent');

    // Logout endpoint responds 204 No Content
    expect(res.status).toBe(204);
  });

  it('does not expose credentials or sensitive parameters in error responses or audit logs', async () => {
    const res = await request(app)
      .post('/api/v1/web/session')
      .set('Content-Type', 'text/plain')
      .send('password=super_secret_password&token=secret_token_123');

    expect(res.status).toBe(400);
    const rawRes = JSON.stringify(res.body);
    expect(rawRes).not.toContain('super_secret_password');
    expect(rawRes).not.toContain('secret_token_123');

    const recentEvents = Logger.getRecentAuditEvents(5);
    const auditEvent = recentEvents[0];
    const rawAudit = JSON.stringify(auditEvent);
    expect(rawAudit).not.toContain('super_secret_password');
    expect(rawAudit).not.toContain('secret_token_123');
  });
});
