import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';

const app = createApp();

describe('CST Web Interface sessions and isolation', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
    const project = CoreRegistry.getProject('proj-vfarm-main')!;
    project.capabilities.web = true;
    CoreRegistry.registerProject(project);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ answer: 'Farm status is normal.' }),
    } as Response);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('creates a development session with server-resolved context', async () => {
    const res = await request(app).post('/api/v1/web/session').send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });
    expect(res.status).toBe(201);
    expect(res.body.session).toMatch(/^web_/);
    expect(res.body.tenant.id).toBe('tenant-vfarm-01');
    expect(res.body.project.id).toBe('proj-vfarm-main');
    expect(res.body.farm_count).toBe(1);
  });

  it('rejects an invalid session', async () => {
    const res = await request(app).get('/api/v1/web/session').set('x-cst-session', 'invalid');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_SESSION');
  });

  it('sends a message through the web MessageEnvelope and returns a response', async () => {
    const agent = request.agent(app);
    const session = await agent.post('/api/v1/web/session').send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });
    expect(session.status).toBe(201);
    const res = await agent.post('/api/v1/web/message').send({ text: 'What is the status of my farm?' });
    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('web');
    expect(res.body.reply_text).toBeDefined();
    const history = await agent.get('/api/v1/web/history');
    expect(history.body.messages).toHaveLength(2);
  });

  it('ignores tenant, project, speaker, and farm overrides in the request body', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/web/session').send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });
    const res = await agent.post('/api/v1/web/message').send({
      tenant_id: 'attacker-tenant', project_id: 'proj-vfarm-dallas', speaker_ref: '+15559990000', farm_ids: ['farm_dallas_north'], text: 'status',
    });
    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe('tenant-vfarm-01');
    expect(res.body.project_id).toBe('proj-vfarm-main');
    expect(res.body.reply_text).not.toContain('farm_dallas_north');
  });

  it('keeps farm data inside the authenticated speaker scope', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/web/session').send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });
    const res = await agent.post('/api/v1/web/message').send({ text: 'Show status for farm_dallas_north' });
    expect(res.status).toBe(200);
    expect(res.body.reply_text).toContain('not have access');
    expect(res.body.reply_text).toContain('farm_austin_main');
  });

  it('authenticates production web session via email and password', async () => {
    const res = await request(app)
      .post('/api/v1/web/session')
      .send({ email: 'admin@cst.com', password: 'admin', project_id: 'proj-vfarm-main' });
    expect(res.status).toBe(201);
    expect(res.body.session).toMatch(/^web_/);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.tenant.id).toBe('tenant-vfarm-01');
  });

  it('rejects invalid email and password with 401', async () => {
    const res = await request(app)
      .post('/api/v1/web/session')
      .send({ email: 'admin@cst.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.body.message).toContain('User not found in vFarm or invalid credentials');
  });

  it('authenticates session via vFarm, links connected farms, and allows user to chat', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/auth/login')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: { id: 'vfarm-user-123', email: 'grower@vfarm.co', name: 'Grower Alice' },
            farms: [
              { farm_id: 'farm-alpha-01', role: 'owner', farm_name: 'Alpha Greenhouse', farm_code: 'alpha-gh' },
              { farm_id: 'farm-beta-02', role: 'admin', farm_name: 'Beta Tunnel', farm_code: 'beta-tun' },
            ],
            token: 'vfarm-mock-jwt-token',
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ answer: 'Alpha Greenhouse telemetry is optimal at 22C.' }),
      } as Response;
    });

    const agent = request.agent(app);
    const loginRes = await agent
      .post('/api/v1/web/session')
      .send({ email: 'grower@vfarm.co', password: 'correct-password', project_id: 'proj-vfarm-main' });

    expect(loginRes.status).toBe(201);
    expect(loginRes.body.user.name).toBe('Grower Alice');
    expect(loginRes.body.farm_count).toBe(2);
    expect(loginRes.body.farms).toEqual(['farm-alpha-01', 'farm-beta-02']);
    expect(loginRes.body.farm_details).toHaveLength(2);

    const chatRes = await agent
      .post('/api/v1/web/message')
      .send({ text: 'What is the status of my farm?' });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.channel).toBe('web');
    expect(chatRes.body.reply_text).toBeDefined();

    const history = await agent.get('/api/v1/web/history');
    expect(history.body.messages).toHaveLength(2);
  });

  it('displays error message when user is not found in vFarm or invalid credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/auth/login')) {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'unauthorized', detail: 'Invalid email or password' }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    const res = await request(app)
      .post('/api/v1/web/session')
      .send({ email: 'nonexistent@vfarm.co', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.body.message).toBe('User not found in vFarm or invalid credentials. Please check your credentials.');
  });

  it('rejects unauthenticated request in production mode when no credentials provided', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const res = await request(app).post('/api/v1/web/session').send({});
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('AUTH_REQUIRED');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('synthesizes audio via ElevenLabs credentials when voice requested in web message', async () => {
    const mockSynthesizer = {
      synthesize: vi.fn().mockResolvedValue({
        audioBase64: Buffer.from('mock-audio-data').toString('base64'),
        mimeType: 'audio/mpeg',
      }),
    };
    const { VoiceInterface } = await import('../../engine/src/interfaces/voice/index.js');
    VoiceInterface.setSynthesizer(mockSynthesizer as any);

    const agent = request.agent(app);
    await agent.post('/api/v1/web/session').send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });

    const res = await agent.post('/api/v1/web/message').send({
      text: 'What is the status of my farm?',
      voice: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.reply_text).toBeDefined();
    expect(res.body.audio_url).toMatch(/^\/api\/v1\/voice\/audio\//);

    // Verify audio endpoint serves the synthesized audio
    const audioRes = await request(app).get(res.body.audio_url);
    expect(audioRes.status).toBe(200);
    expect(audioRes.headers['content-type']).toBe('audio/mpeg');
  });

  it('supports direct text-to-speech synthesis via POST /api/v1/web/speak', async () => {
    const mockSynthesizer = {
      synthesize: vi.fn().mockResolvedValue({
        audioBase64: Buffer.from('mock-speak-data').toString('base64'),
        mimeType: 'audio/mpeg',
      }),
    };
    const { VoiceInterface } = await import('../../engine/src/interfaces/voice/index.js');
    VoiceInterface.setSynthesizer(mockSynthesizer as any);

    const agent = request.agent(app);
    await agent.post('/api/v1/web/session').send({ user: 'demo-owner', project_id: 'proj-vfarm-main' });

    const res = await agent.post('/api/v1/web/speak').send({
      text: 'Farm Austin Main telemetry is currently normal.',
    });

    expect(res.status).toBe(200);
    expect(res.body.audio_id).toBeDefined();
    expect(res.body.audio_url).toBe(`/api/v1/voice/audio/${res.body.audio_id}`);
    expect(res.body.mime_type).toBe('audio/mpeg');
  });
});

