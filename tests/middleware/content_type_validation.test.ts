import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { Logger } from '../../engine/src/config/logger.js';
import { DbClient } from '../../engine/src/db/client.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { VoiceInterface } from '../../engine/src/interfaces/voice/index.js';
import { CallLogPoster } from '../../engine/src/notifications/call_log.js';

describe('LOOP-1795035800169-NVLF: Content-Type Validation, Observability & Error Handling', () => {
  let app: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    CoreRegistry.resetToDefault();
    DbClient.clearAll();
    app = createApp();
  });

  describe('Core Media Type Rejection & Structured Envelopes', () => {
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
      expect(res.body.message).toBe('Content-Type must be application/json');
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

  describe('Charset Validation', () => {
    it('accepts application/json with valid utf-8 charset', async () => {
      const res = await request(app)
        .post('/api/v1/web/session')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });

      expect(res.status).toBe(201);
    });

    it('rejects application/json with unsupported charset iso-8859-1 with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/web/session')
        .set('Content-Type', 'application/json; charset=iso-8859-1')
        .send('{"user":"demo-owner"}');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(res.body.message).toContain('Unsupported charset "iso-8859-1"');
    });

    it('rejects application/json with unsupported charset utf-16 with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/v1/web/session')
        .set('Content-Type', 'application/json; charset=utf-16')
        .send('{"user":"demo-owner"}');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(res.body.message).toContain('Unsupported charset "utf-16"');
    });
  });

  describe('Twilio Webhook Specific Form Enforcement', () => {
    it('rejects Twilio SMS webhook with application/json with HTTP 400', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/sms')
        .set('Content-Type', 'application/json')
        .send({ From: '+15551234567', To: '+19715885823', Body: 'Hello' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(res.body.message).toBe('Content-Type must be application/x-www-form-urlencoded');
    });

    it('rejects Twilio delivery status webhook with text/plain with HTTP 400', async () => {
      const res = await request(app)
        .post('/webhooks/twilio/delivery-status')
        .set('Content-Type', 'text/plain')
        .send('MessageSid=SM123&MessageStatus=delivered');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(res.body.message).toBe('Content-Type must be application/x-www-form-urlencoded');
    });
  });

  describe('Body Size Limits & Oversized Payloads', () => {
    it('rejects oversized JSON payload (>100kb) with HTTP 413 PAYLOAD_TOO_LARGE on standard API endpoints', async () => {
      const bigString = 'x'.repeat(120 * 1024); // 120kb
      const res = await request(app)
        .post('/api/v1/web/session')
        .set('Content-Type', 'application/json')
        .send({ data: bigString });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('PAYLOAD_TOO_LARGE');
      expect(res.body.message).toContain('Request entity exceeds maximum allowable size limit');
      expect(res.body).toHaveProperty('correlation_id');
    });
  });

  describe('Phase 4: Mandatory Proof — Invalid Requests Never Reach Business Routes', () => {
    it('proves invalid Content-Type stops execution BEFORE Twilio SMS handler or DB touch', async () => {
      const spySaveInbound = vi.spyOn(DbClient, 'saveInboundMessage');

      const res = await request(app)
        .post('/webhooks/twilio/sms')
        .set('Content-Type', 'text/plain')
        .send('From=%2B15551234567&To=%2B19715885823&Body=AttackerPayload&MessageSid=SM_NEVER_SAVED');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');

      // Crucial verification: downstream handler was NEVER reached, no DB write occurred
      expect(spySaveInbound).not.toHaveBeenCalled();
      expect(DbClient.getInboundMessage('SM_NEVER_SAVED')).toBeUndefined();
      expect(DbClient.getConversationCount()).toBe(0);
    });

    it('proves invalid Content-Type stops execution BEFORE Twilio Voice handler execution', async () => {
      const spyVoiceInbound = vi.spyOn(VoiceInterface, 'handleInboundCall');

      const res = await request(app)
        .post('/webhooks/twilio/voice/inbound')
        .set('Content-Type', 'text/plain')
        .send('CallSid=CA_BOGUS&From=%2B15551234567');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');

      // Crucial verification: VoiceInterface.handleInboundCall was never invoked
      expect(spyVoiceInbound).not.toHaveBeenCalled();
    });

    it('proves invalid Content-Type stops execution BEFORE ElevenLabs call log poster execution', async () => {
      const spyCallLogPoster = vi.spyOn(CallLogPoster, 'post');

      const res = await request(app)
        .post('/webhooks/elevenlabs/post-call')
        .set('Content-Type', 'text/plain')
        .send('conversation_id=conv_123&analysis=fake');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');

      // Crucial verification: CallLogPoster.post was never invoked
      expect(spyCallLogPoster).not.toHaveBeenCalled();
    });

    it('proves malformed JSON stops execution BEFORE business route handler', async () => {
      const spySaveTenant = vi.spyOn(DbClient, 'saveTenant');

      const res = await request(app)
        .post('/api/v1/admin/tenants')
        .set('Content-Type', 'application/json')
        .send('{ "tenant_id": "tenant-evil", broken_syntax_here ');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('MALFORMED_JSON');

      // Crucial verification: route handler never ran, DbClient.saveTenant was never invoked
      expect(spySaveTenant).not.toHaveBeenCalled();
      const allTenants = await DbClient.getAllTenants();
      expect(allTenants.find((t) => t.tenant_id === 'tenant-evil')).toBeUndefined();
    });

    it('proves missing Content-Type on admin mutation stops execution BEFORE authentication and business handler', async () => {
      const spySaveTenant = vi.spyOn(DbClient, 'saveTenant');

      const res = await request(app)
        .post('/api/v1/admin/tenants')
        .unset('Content-Type')
        .send('{"tenant_id":"tenant-unauth","name":"Unauth Corp"}');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');

      // Crucial verification: admin route handler never reached, zero tenant records written
      expect(spySaveTenant).not.toHaveBeenCalled();
      const allTenants = await DbClient.getAllTenants();
      expect(allTenants.find((t) => t.tenant_id === 'tenant-unauth')).toBeUndefined();
    });
  });
});
