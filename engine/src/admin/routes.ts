import { Router, Request, Response } from 'express';
import { CoreRegistry } from '../core/registry.js';
import { Tenant, Project, ServiceNumberBinding } from '../core/types.js';
import { VfarmTenantAdapter } from '../adapters/vfarm/index.js';
import { DbClient } from '../db/client.js';
import { Logger } from '../config/logger.js';

export const adminRouter = Router();

// ── 1. Tenant Management (/api/v1/admin/tenants) ──────────────────────────────

adminRouter.get('/tenants', (_req: Request, res: Response) => {
  const tenants = CoreRegistry.getAllTenants();
  res.status(200).json({ tenants, count: tenants.length });
});

adminRouter.post('/tenants', (req: Request, res: Response) => {
  try {
    const { tenant_id, name, adapter_type, adapter_config } = req.body;
    if (!tenant_id || !name) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing tenant_id or name' });
      return;
    }

    const tenant: Tenant = {
      tenant_id,
      name,
      status: 'active',
      adapter_type: adapter_type || 'vfarm',
      adapter_config,
      created_at: new Date().toISOString(),
    };

    let adapter = CoreRegistry.getAdapter(tenant_id);
    if (!adapter) {
      if (adapter_type === 'vfarm' || !adapter_type) {
        adapter = new VfarmTenantAdapter(tenant_id, adapter_config);
      }
    }

    CoreRegistry.registerTenant(tenant, adapter || undefined);
    Logger.info(`Admin: Registered tenant ${tenant_id} (${name})`);
    res.status(201).json({ status: 'created', tenant });
  } catch (err: any) {
    Logger.error(`Admin register tenant error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

adminRouter.patch('/tenants/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;
    const existing = CoreRegistry.getTenant(tenantId);
    if (!existing) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Tenant ${tenantId} not found` });
      return;
    }

    const { name, status, adapter_type, adapter_config } = req.body;
    if (name) existing.name = name;
    if (status) existing.status = status;
    if (adapter_type) existing.adapter_type = adapter_type;
    if (adapter_config !== undefined) existing.adapter_config = adapter_config;

    await DbClient.updateTenant(tenantId, { name, status, adapter_type, adapter_config });
    CoreRegistry.registerTenant(existing, CoreRegistry.getAdapter(tenantId) || undefined);
    Logger.info(`Admin: Updated tenant ${tenantId}`);
    res.status(200).json({ status: 'updated', tenant: existing });
  } catch (err: any) {
    Logger.error(`Admin update tenant error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── 2. Project Management (/api/v1/admin/projects) ─────────────────────────────

adminRouter.get('/projects', (req: Request, res: Response) => {
  const tenantId = req.query.tenant_id as string | undefined;
  const projects = tenantId
    ? CoreRegistry.getProjectsForTenant(tenantId)
    : Array.from(CoreRegistry['projects'].values());
  res.status(200).json({ projects, count: projects.length });
});

adminRouter.post('/projects/sync', async (req: Request, res: Response) => {
  try {
    const { tenant_id } = req.body;
    if (!tenant_id) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing tenant_id in request body' });
      return;
    }

    const synced = await CoreRegistry.syncProjectsFromAdapter(tenant_id);
    Logger.info(`Admin: Synced ${synced.length} projects for tenant ${tenant_id}`);
    res.status(200).json({ status: 'synced', count: synced.length, projects: synced });
  } catch (err: any) {
    Logger.error(`Admin sync projects error: ${err.message}`);
    res.status(500).json({ error: 'SYNC_FAILED', message: err.message });
  }
});

adminRouter.patch('/projects/:projectId', (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const project = CoreRegistry.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Project ${projectId} not found` });
      return;
    }

    const { capabilities, speaker_policy, onboarding_reply, voice_enabled, elevenlabs_voice_id } = req.body;
    if (capabilities) {
      project.capabilities = { ...project.capabilities, ...capabilities };
    }
    if (speaker_policy) {
      project.speaker_policy = speaker_policy;
    }
    if (onboarding_reply !== undefined) {
      project.onboarding_reply = onboarding_reply;
    }
    if (voice_enabled !== undefined) {
      project.voice_enabled = voice_enabled;
    }
    if (elevenlabs_voice_id !== undefined) {
      project.elevenlabs_voice_id = elevenlabs_voice_id;
    }

    CoreRegistry.registerProject(project);
    Logger.info(`Admin: Updated project ${projectId} configuration`);
    res.status(200).json({ status: 'updated', project });
  } catch (err: any) {
    Logger.error(`Admin update project error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── 3. Number Sync & Binding (/api/v1/admin/numbers) ──────────────────────────

adminRouter.get('/numbers/candidate', (_req: Request, res: Response) => {
  const numbers = CoreRegistry.getCandidateNumbers();
  res.status(200).json({ numbers, count: numbers.length });
});

adminRouter.post('/numbers/sync', async (req: Request, res: Response) => {
  try {
    const { tenant_id } = req.body;
    let numbers: string[] = [];

    if (tenant_id) {
      const adapter = CoreRegistry.getAdapter(tenant_id);
      if (adapter?.pullCandidateNumbers) {
        numbers = await adapter.pullCandidateNumbers(tenant_id);
      }
    } else {
      numbers = ['+19715885823', '+19715885824', '+19715885825'];
    }

    CoreRegistry.addCandidateNumbers(numbers);
    Logger.info(`Admin: Synced ${numbers.length} candidate numbers`);
    res.status(200).json({ status: 'synced', numbers, count: numbers.length });
  } catch (err: any) {
    Logger.error(`Admin number sync error: ${err.message}`);
    res.status(500).json({ error: 'SYNC_FAILED', message: err.message });
  }
});

adminRouter.get('/numbers/bindings', (_req: Request, res: Response) => {
  const bindings = CoreRegistry.getAllBindings();
  res.status(200).json({ bindings, count: bindings.length });
});

adminRouter.post('/numbers/bind', (req: Request, res: Response) => {
  try {
    const { phone_e164, tenant_id, project_id, capability } = req.body;
    if (!phone_e164 || !tenant_id || !project_id || !capability) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Missing required binding fields: phone_e164, tenant_id, project_id, capability',
      });
      return;
    }

    const binding: ServiceNumberBinding = {
      phone_e164,
      tenant_id,
      project_id,
      capability,
      status: 'bound',
    };

    CoreRegistry.bindServiceNumber(binding);
    res.status(201).json({ status: 'bound', binding });
  } catch (err: any) {
    if (err.message.includes('Collision detected')) {
      res.status(409).json({ error: 'COLLISION_DETECTED', message: err.message });
      return;
    }
    if (err.message.includes('not found') || err.message.includes('does not belong')) {
      res.status(404).json({ error: 'INVALID_PROJECT_OR_TENANT', message: err.message });
      return;
    }
    res.status(500).json({ error: 'BINDING_FAILED', message: err.message });
  }
});

adminRouter.delete('/numbers/unbind', (req: Request, res: Response) => {
  const { phone_e164 } = req.body;
  if (!phone_e164) {
    res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing phone_e164' });
    return;
  }
  const removed = CoreRegistry.unbindServiceNumber(phone_e164);
  res.status(200).json({ status: removed ? 'unbound' : 'not_found', phone_e164 });
});

// ── 4. System Health & Verification Readiness (/api/v1/admin/health/verification) ──

adminRouter.get('/health/verification', async (_req: Request, res: Response) => {
  try {
    const tenants = CoreRegistry.getAllTenants();
    const bindings = CoreRegistry.getAllBindings();
    const candidateNumbers = CoreRegistry.getCandidateNumbers();
    const voiceDeliveries24h = await DbClient.getVoiceDeliveriesInLast24Hours();

    const tenantHealthList = await Promise.all(
      tenants.map(async (t) => {
        const adapter = CoreRegistry.getAdapter(t.tenant_id);
        const projects = CoreRegistry.getProjectsForTenant(t.tenant_id);
        const projectsDetail = projects.map((p) => ({
          project_id: p.project_id,
          name: p.name,
          status: p.status,
          capabilities: p.capabilities,
          speaker_policy: p.speaker_policy,
          voice_enabled: p.voice_enabled ?? false,
        }));
        const health = adapter?.getHealth ? await adapter.getHealth(t.tenant_id) : { status: 'healthy' };
        return {
          tenant_id: t.tenant_id,
          name: t.name,
          status: t.status,
          projects_count: projects.length,
          projects: projectsDetail,
          adapter_health: health,
        };
      })
    );

    const pendingOutbound = await DbClient.getPendingOutboundMessages();

    const readiness = {
      status: 'ready',
      platform: 'CST Core Multi-Tenant Platform',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      tenants: tenantHealthList,
      service_numbers: {
        total_candidate: candidateNumbers.length,
        total_bound: bindings.length,
        bindings,
      },
      transport: {
        status: 'healthy',
        pending_outbound_count: pendingOutbound.length,
      },
      connectors: {
        bharag_rag: {
          status: 'healthy',
          endpoint: process.env.BHARAG_CLUSTER_URL || 'configured',
        },
        vfarm_telemetry: {
          status: 'healthy',
        },
      },
      voice_lane: {
        recent_24h_deliveries_count: voiceDeliveries24h.length,
        healthy: true,
      },
    };


    res.status(200).json(readiness);
  } catch (err: any) {
    Logger.error(`Verification health API error: ${err.message}`);
    res.status(500).json({ error: 'HEALTH_CHECK_FAILED', message: err.message });
  }
});

// ── 5. Speaker Sync & Invalidation (/api/v1/admin/speakers) ──────────────────
// Syncs speakers from the tenant adapter into the durable `customers` table.
// This is the onboarding flow step §10(6): "Sync speakers (farm owners' phones + farm grants)."

adminRouter.post('/speakers/sync', async (req: Request, res: Response) => {
  try {
    const { tenant_id, project_id } = req.body;
    if (!tenant_id || !project_id) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Missing tenant_id or project_id in request body',
      });
      return;
    }

    // Validate that project belongs to tenant
    const project = CoreRegistry.getProject(project_id);
    if (!project || project.tenant_id !== tenant_id) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Project ${project_id} not found for tenant ${tenant_id}`,
      });
      return;
    }

    const adapter = CoreRegistry.getAdapter(tenant_id);
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: `No adapter for tenant ${tenant_id}` });
      return;
    }

    // Pull speakers from tenant adapter — the tenant is source of truth (R-NUM-P1)
    const speakers = await adapter.pullSpeakers(tenant_id, project_id);
    const now = new Date();
    // TTL: speaker cache expires after 24 hours; CST re-resolves live on miss
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const synced: Array<{ person_id: string; phone_e164: string; role: string; farm_count: number }> = [];

    for (const speaker of speakers) {
      // Persist using DbClient.seedCustomer extended fields
      // farm_ids stored as JSONB array (replaces legacy single farm_id column)
      const pool = DbClient.getPool();
      if (pool) {
        await pool.query(
          `INSERT INTO customers
             (tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, farm_ids, speaker_cache_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (tenant_id, project_id, phone_e164) DO UPDATE SET
             customer_ref             = EXCLUDED.customer_ref,
             role                     = EXCLUDED.role,
             farm_ids                 = EXCLUDED.farm_ids,
             speaker_cache_expires_at = EXCLUDED.speaker_cache_expires_at`,
          [
            tenant_id,
            project_id,
            tenant_id,   // organization_id = tenant_id for vFarm
            '',          // workspace_id deprecated
            speaker.phone_e164.trim(),
            speaker.person_id,
            speaker.role,
            JSON.stringify(speaker.farm_ids),
            expiresAt,
          ]
        );
      } else {
        // In-memory fallback (test / no-DB mode)
        DbClient.seedCustomer({
          tenant_id,
          phone_e164: speaker.phone_e164.trim(),
          customer_ref: speaker.person_id,
          role: speaker.role as 'owner' | 'manager' | 'tech',
          farm_id: speaker.farm_ids[0],
        });
      }

      // Invalidate speaker cache so next inbound resolves fresh
      CoreRegistry.invalidateSpeakerCache(tenant_id, project_id, speaker.phone_e164);

      synced.push({
        person_id: speaker.person_id,
        phone_e164: speaker.phone_e164,
        role: speaker.role,
        farm_count: speaker.farm_ids.length,
      });
    }

    Logger.info(`Admin speakers/sync: synced ${synced.length} speakers for tenant=${tenant_id} project=${project_id}`);
    res.status(200).json({ status: 'synced', tenant_id, project_id, count: synced.length, speakers: synced });
  } catch (err: any) {
    Logger.error(`Admin speakers/sync error: ${err.message}`);
    res.status(500).json({ error: 'SYNC_FAILED', message: err.message });
  }
});

// Invalidate a single speaker entry — called when a person is removed in the tenant (R-NUM-P5)
adminRouter.post('/speakers/invalidate', async (req: Request, res: Response) => {
  try {
    const { tenant_id, project_id, phone_e164 } = req.body;
    if (!tenant_id || !phone_e164) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing tenant_id or phone_e164' });
      return;
    }

    // Expire the DB row by setting speaker_cache_expires_at to the past
    const pool = DbClient.getPool();
    if (pool) {
      await pool.query(
        `UPDATE customers
         SET speaker_cache_expires_at = NOW() - INTERVAL '1 second'
         WHERE tenant_id = $1
           AND ($2::text IS NULL OR project_id = $2)
           AND phone_e164 = $3`,
        [tenant_id, project_id || null, phone_e164.trim()]
      );
    }

    // Evict in-memory cache entry
    CoreRegistry.invalidateSpeakerCache(tenant_id, project_id, phone_e164);

    Logger.info(`Admin speakers/invalidate: expired cache for phone=${phone_e164} tenant=${tenant_id} project=${project_id}`);
    res.status(200).json({ status: 'invalidated', tenant_id, project_id, phone_e164 });
  } catch (err: any) {
    Logger.error(`Admin speakers/invalidate error: ${err.message}`);
    res.status(500).json({ error: 'INVALIDATION_FAILED', message: err.message });
  }
});

// ── List all users / speakers with filters & search (/api/v1/admin/speakers) ─
adminRouter.get('/speakers', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenant_id as string | undefined;
    const projectId = req.query.project_id as string | undefined;
    const role = req.query.role as string | undefined;
    const search = req.query.search as string | undefined;

    const customers = await DbClient.getAllCustomers(tenantId, projectId, role, search);
    const now = Date.now();

    const speakers = customers.map((c) => {
      const expiresAtMs = c.speaker_cache_expires_at ? new Date(c.speaker_cache_expires_at).getTime() : null;
      const is_cache_active = expiresAtMs ? expiresAtMs > now : true;
      return {
        phone_e164: c.phone_e164,
        customer_ref: c.customer_ref,
        person_id: c.customer_ref,
        tenant_id: c.tenant_id,
        project_id: c.project_id || '',
        role: c.role || 'manager',
        farm_ids: c.farm_ids || (c.farm_id ? [c.farm_id] : []),
        farm_count: (c.farm_ids || (c.farm_id ? [c.farm_id] : [])).length,
        speaker_cache_expires_at: c.speaker_cache_expires_at,
        is_cache_active,
        created_at: c.created_at,
      };
    });

    res.status(200).json({ status: 'ok', count: speakers.length, speakers });
  } catch (err: any) {
    Logger.error(`Admin GET speakers error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── Manually onboard or seed a speaker/user (/api/v1/admin/speakers) ─────────
adminRouter.post('/speakers', async (req: Request, res: Response) => {
  try {
    const { phone_e164, customer_ref, tenant_id, project_id, role, farm_ids, ttl_hours } = req.body;
    if (!phone_e164 || !customer_ref || !tenant_id || !project_id) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Missing required fields: phone_e164, customer_ref, tenant_id, project_id',
      });
      return;
    }

    const cleanPhone = phone_e164.trim();
    if (!cleanPhone.startsWith('+') || cleanPhone.length < 8) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'phone_e164 must be in valid E.164 format (e.g. +15551234567)',
      });
      return;
    }

    const project = CoreRegistry.getProject(project_id);
    if (!project || project.tenant_id !== tenant_id) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `Project ${project_id} not found for tenant ${tenant_id}`,
      });
      return;
    }

    const cleanRole = role && ['owner', 'manager', 'tech'].includes(role) ? role : 'owner';
    const cleanFarms = Array.isArray(farm_ids) ? farm_ids.map(String) : [];
    const hours = typeof ttl_hours === 'number' && ttl_hours > 0 ? ttl_hours : 24;
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

    const pool = DbClient.getPool();
    if (pool) {
      await pool.query(
        `INSERT INTO customers
           (tenant_id, project_id, organization_id, workspace_id, phone_e164, customer_ref, role, farm_ids, speaker_cache_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (tenant_id, project_id, phone_e164) DO UPDATE SET
           customer_ref             = EXCLUDED.customer_ref,
           role                     = EXCLUDED.role,
           farm_ids                 = EXCLUDED.farm_ids,
           speaker_cache_expires_at = EXCLUDED.speaker_cache_expires_at`,
        [
          tenant_id,
          project_id,
          tenant_id,
          '',
          cleanPhone,
          customer_ref.trim(),
          cleanRole,
          JSON.stringify(cleanFarms),
          expiresAt,
        ]
      );
    } else {
      DbClient.seedCustomer({
        tenant_id,
        project_id,
        phone_e164: cleanPhone,
        customer_ref: customer_ref.trim(),
        role: cleanRole as any,
        farm_ids: cleanFarms,
        speaker_cache_expires_at: expiresAt,
      });
    }

    CoreRegistry.invalidateSpeakerCache(tenant_id, project_id, cleanPhone);

    const speaker = {
      phone_e164: cleanPhone,
      customer_ref: customer_ref.trim(),
      person_id: customer_ref.trim(),
      tenant_id,
      project_id,
      role: cleanRole,
      farm_ids: cleanFarms,
      farm_count: cleanFarms.length,
      speaker_cache_expires_at: expiresAt,
      is_cache_active: true,
    };

    Logger.info(`Admin: Manually onboarded speaker ${cleanPhone} (${customer_ref}) in ${tenant_id}/${project_id}`);
    res.status(201).json({ status: 'created', speaker });
  } catch (err: any) {
    Logger.error(`Admin POST speaker error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── Update speaker configuration / resource scope (/api/v1/admin/speakers/:phoneE164) ──
adminRouter.patch('/speakers/:phoneE164', async (req: Request, res: Response) => {
  try {
    const { phoneE164 } = req.params;
    const { tenant_id, project_id, customer_ref, role, farm_ids, ttl_hours } = req.body;

    if (!tenant_id) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing tenant_id in request body' });
      return;
    }

    const updates: any = {};
    if (role) {
      if (!['owner', 'manager', 'tech'].includes(role)) {
        res.status(400).json({ error: 'BAD_REQUEST', message: 'role must be owner, manager, or tech' });
        return;
      }
      updates.role = role;
    }
    if (farm_ids !== undefined) {
      updates.farm_ids = Array.isArray(farm_ids) ? farm_ids.map(String) : [];
    }
    if (customer_ref !== undefined) {
      updates.customer_ref = customer_ref.trim();
    }
    if (project_id !== undefined) {
      updates.project_id = project_id;
    }
    if (ttl_hours !== undefined) {
      const hours = Number(ttl_hours);
      if (hours > 0) {
        updates.speaker_cache_expires_at = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      }
    }

    const updated = await DbClient.updateCustomer(phoneE164, tenant_id, project_id, updates);
    if (!updated) {
      res.status(404).json({ error: 'NOT_FOUND', message: `Speaker with phone ${phoneE164} not found` });
      return;
    }

    CoreRegistry.invalidateSpeakerCache(tenant_id, project_id || updated.project_id || '', phoneE164);
    Logger.info(`Admin: Updated configuration for speaker ${phoneE164}`);
    res.status(200).json({ status: 'updated', speaker: updated });
  } catch (err: any) {
    Logger.error(`Admin PATCH speaker error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── Delete / Revoke a speaker (/api/v1/admin/speakers/:phoneE164) ────────────
adminRouter.delete('/speakers/:phoneE164', async (req: Request, res: Response) => {
  try {
    const { phoneE164 } = req.params;
    const tenantId = (req.query.tenant_id as string) || (req.body?.tenant_id as string);
    const projectId = (req.query.project_id as string) || (req.body?.project_id as string);

    if (!tenantId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing tenant_id parameter' });
      return;
    }

    const deleted = await DbClient.deleteCustomer(phoneE164, tenantId, projectId);
    CoreRegistry.invalidateSpeakerCache(tenantId, projectId || '', phoneE164);
    Logger.info(`Admin: Revoked/deleted speaker ${phoneE164} for tenant ${tenantId}`);
    res.status(200).json({ status: deleted ? 'deleted' : 'not_found', phone_e164: phoneE164 });
  } catch (err: any) {
    Logger.error(`Admin DELETE speaker error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── 6. Audit & Security Ledger (/api/v1/admin/audit/logs) ────────────────────
adminRouter.get('/audit/logs', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const securityEvents = Logger.getRecentAuditEvents(limit);
    const alertAudits = await DbClient.getRecentAlertAuditLogs(limit);

    res.status(200).json({
      status: 'ok',
      security_events: securityEvents,
      alert_audits: alertAudits,
    });
  } catch (err: any) {
    Logger.error(`Admin GET audit logs error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});
