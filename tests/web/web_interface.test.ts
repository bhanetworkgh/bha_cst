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
});
