import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../engine/src/app.js';
import { CoreRegistry } from '../../engine/src/core/registry.js';
import { DbClient } from '../../engine/src/db/client.js';

describe('CST Core Admin APIs & Multi-Channel Interfaces', () => {
  const app = createApp();

  beforeEach(() => {
    DbClient.clearAll();
    CoreRegistry.resetToDefault();
  });

  it('GET /api/v1/admin/tenants returns registered tenants', async () => {
    const res = await request(app).get('/api/v1/admin/tenants');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
    expect(res.body.tenants[0].tenant_id).toBe('tenant-vfarm-01');
  });

  it('POST /api/v1/admin/tenants registers a new tenant', async () => {
    const res = await request(app)
      .post('/api/v1/admin/tenants')
      .send({
        tenant_id: 'tenant-agri-02',
        name: 'AgriTech NextGen',
        adapter_type: 'vfarm',
      });

    expect(res.status).toBe(201);
    expect(res.body.tenant.tenant_id).toBe('tenant-agri-02');
  });

  it('POST /api/v1/admin/projects/sync pulls projects from tenant adapter', async () => {
    const res = await request(app)
      .post('/api/v1/admin/projects/sync')
      .send({ tenant_id: 'tenant-vfarm-01' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('synced');
    expect(res.body.count).toBeGreaterThanOrEqual(2);
  });

  it('PATCH /api/v1/admin/projects/:projectId updates project capabilities and speaker policy', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/projects/proj-vfarm-main')
      .send({
        capabilities: { web: true, voice: true },
        speaker_policy: 'all_project_members',
      });

    expect(res.status).toBe(200);
    expect(res.body.project.capabilities.web).toBe(true);
    expect(res.body.project.speaker_policy).toBe('all_project_members');
  });

  it('POST /api/v1/admin/numbers/sync syncs candidate numbers', async () => {
    const res = await request(app)
      .post('/api/v1/admin/numbers/sync')
      .send({ tenant_id: 'tenant-vfarm-01' });

    expect(res.status).toBe(200);
    expect(res.body.numbers.length).toBeGreaterThan(0);
  });

  it('POST /api/v1/admin/numbers/bind binds an unbound DID', async () => {
    const res = await request(app)
      .post('/api/v1/admin/numbers/bind')
      .send({
        phone_e164: '+19715885899',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        capability: 'sms',
      });

    expect(res.status).toBe(201);
    expect(res.body.binding.status).toBe('bound');
  });

  it('GET /api/v1/admin/health/verification returns full system verification health', async () => {
    const res = await request(app).get('/api/v1/admin/health/verification');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.tenants.length).toBeGreaterThan(0);
    expect(res.body.service_numbers.total_bound).toBeGreaterThan(0);
  });

  it('POST /api/v1/admin/speakers/sync synchronizes speakers for a tenant project', async () => {
    const res = await request(app)
      .post('/api/v1/admin/speakers/sync')
      .send({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('synced');
    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.speakers.some((s: any) => s.phone_e164 === '+923082113844')).toBe(true);
  });

  it('POST /api/v1/admin/speakers/invalidate invalidates speaker entry', async () => {
    const res = await request(app)
      .post('/api/v1/admin/speakers/invalidate')
      .send({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        phone_e164: '+923082113844',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('invalidated');
  });

  it('POST /api/v1/web/message processes web chat envelopes using identical core engine contract', async () => {
    // Enable web capability on proj-vfarm-main
    const project = CoreRegistry.getProject('proj-vfarm-main')!;
    project.capabilities.web = true;
    CoreRegistry.registerProject(project);

    const res = await request(app)
      .post('/api/v1/web/message')
      .send({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        speaker_ref: '+923082113844',
        text: 'Hello from web client',
      });

    expect(res.status).toBe(200);
    expect(res.body.channel).toBe('web');
    expect(res.body.reply_text).toBeDefined();
    expect(res.body.tenant_id).toBe('tenant-vfarm-01');
  }, 15_000);

  it('GET /api/v1/admin/speakers lists users and supports filtering and search', async () => {
    // Seed test users
    DbClient.seedCustomer({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      phone_e164: '+15550001111',
      customer_ref: 'usr_sarah_01',
      role: 'owner',
      farm_ids: ['farm_austin_main'],
    });

    DbClient.seedCustomer({
      tenant_id: 'tenant-vfarm-01',
      project_id: 'proj-vfarm-main',
      phone_e164: '+15550002222',
      customer_ref: 'usr_mike_02',
      role: 'tech',
      farm_ids: ['farm_austin_east'],
    });

    // List all
    const res1 = await request(app).get('/api/v1/admin/speakers');
    expect(res1.status).toBe(200);
    expect(res1.body.speakers.length).toBeGreaterThanOrEqual(2);

    // Filter by role
    const res2 = await request(app).get('/api/v1/admin/speakers?role=tech');
    expect(res2.status).toBe(200);
    expect(res2.body.speakers.every((s: any) => s.role === 'tech')).toBe(true);

    // Search by text
    const res3 = await request(app).get('/api/v1/admin/speakers?search=sarah');
    expect(res3.status).toBe(200);
    expect(res3.body.speakers.some((s: any) => s.customer_ref === 'usr_sarah_01')).toBe(true);
  });

  it('POST /api/v1/admin/speakers registers a new speaker and PATCH updates their configuration', async () => {
    const postRes = await request(app)
      .post('/api/v1/admin/speakers')
      .send({
        phone_e164: '+15553334444',
        customer_ref: 'usr_elena_03',
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        role: 'manager',
        farm_ids: ['farm_austin_main'],
      });

    expect(postRes.status).toBe(201);
    expect(postRes.body.speaker.phone_e164).toBe('+15553334444');
    expect(postRes.body.speaker.role).toBe('manager');

    // PATCH update configuration
    const patchRes = await request(app)
      .patch('/api/v1/admin/speakers/+15553334444')
      .send({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
        role: 'owner',
        farm_ids: ['farm_austin_main', 'farm_austin_east'],
      });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.speaker.role).toBe('owner');
    expect(patchRes.body.speaker.farm_ids).toEqual(['farm_austin_main', 'farm_austin_east']);

    // DELETE speaker
    const deleteRes = await request(app)
      .delete('/api/v1/admin/speakers/+15553334444')
      .send({
        tenant_id: 'tenant-vfarm-01',
        project_id: 'proj-vfarm-main',
      });

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.status).toBe('deleted');
  });

  it('PATCH /api/v1/admin/tenants/:tenantId updates tenant configuration', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/tenants/tenant-vfarm-01')
      .send({
        name: 'vFarm Global Enterprises',
        status: 'active',
      });

    expect(res.status).toBe(200);
    expect(res.body.tenant.name).toBe('vFarm Global Enterprises');
  });

  it('GET /api/v1/admin/audit/logs returns security events and alert audit history', async () => {
    const res = await request(app).get('/api/v1/admin/audit/logs');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Array.isArray(res.body.security_events)).toBe(true);
    expect(Array.isArray(res.body.alert_audits)).toBe(true);
  });
});

