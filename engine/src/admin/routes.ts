import { maskPhone } from '../util/privacy.js';
import { Router, Request, Response } from 'express';
import { CoreRegistry } from '../core/registry.js';
import { Tenant, Project, ServiceNumberBinding, SpeakerRecord } from '../core/types.js';
import { VfarmTenantAdapter } from '../adapters/vfarm/index.js';
import { DbClient, ConsentStatus } from '../db/client.js';
import { Logger } from '../config/logger.js';
import {
  recordConsent,
  recordOptOut,
  getConsentStatus,
} from '../consent/service.js';
import { getConsentWording, CONSENT_WORDING_VERSION } from '../consent/wording.js';
import { getDashboardPublisher } from '../publishers/dashboard.js';

export const adminRouter = Router();

// ── Shared: keep the runtime speaker directory in step with the DB projection ──
// Runtime identity resolution goes CoreRegistry.resolveSpeaker → adapter
// .resolveSpeaker → adapter in-memory speaker directory. The Admin Panel writes
// to the `customers` table. Without this mirror the two describe different users,
// so admin onboarding/revocation would not be visible to inbound traffic (and a
// revoked speaker would keep resolving). This is a mirror of the same record,
// not a second user system: the adapter directory is a cache of the DB rows and
// is still re-verified against vFarm on every live resolve.
function mirrorSpeakerToAdapter(projectId: string, record: {
  phone_e164: string;
  customer_ref: string;
  role?: string;
  farm_ids?: string[];
  farm_id?: string;
}): void {
  const adapter = CoreRegistry.getAdapter(
    CoreRegistry.getProject(projectId)?.tenant_id || ''
  );
  if (!adapter?.registerSpeaker) return;
  const speaker: SpeakerRecord = {
    person_id: record.customer_ref,
    phone_e164: record.phone_e164,
    role: (record.role || 'manager') as SpeakerRecord['role'],
    farm_ids: record.farm_ids || (record.farm_id ? [record.farm_id] : []),
  };
  try {
    adapter.registerSpeaker(projectId, speaker);
  } catch (err: any) {
    Logger.warn(`Admin: could not mirror speaker ${record.phone_e164} into adapter directory: ${err.message}`);
  }
}

function unmirrorSpeakerFromAdapter(projectId: string, phoneE164: string): void {
  const adapter = CoreRegistry.getAdapter(
    CoreRegistry.getProject(projectId)?.tenant_id || ''
  );
  try {
    adapter?.removeSpeaker?.(projectId, phoneE164);
  } catch (err: any) {
    Logger.warn(`Admin: could not evict speaker ${maskPhone(phoneE164)} from adapter directory: ${err.message}`);
  }
}

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

    // A candidate number must come from an authoritative source: the tenant
    // adapter's provider response, or an explicit configuration. There is NO
    // hardcoded fallback. The previous fallback seeded three numbers, two of
    // which the account does not own, so a sync could mark an unowned number
    // as a candidate and make it bindable as an outbound sender — the
    // precondition for Twilio error 21659.
    if (!tenant_id) {
      Logger.warn(
        'Admin: /numbers/sync requires a tenant_id — candidate numbers are never fabricated (fail closed)',
      );
      res.status(400).json({
        error: 'TENANT_ID_REQUIRED',
        message:
          'tenant_id is required. Candidate numbers must come from the tenant adapter or explicit configuration; they are never fabricated.',
      });
      return;
    }

    const adapter = CoreRegistry.getAdapter(tenant_id);
    if (!adapter?.pullCandidateNumbers) {
      Logger.warn(`Admin: /numbers/sync — tenant ${tenant_id} has no adapter that can supply candidate numbers`);
      res.status(409).json({
        error: 'NO_ADAPTER',
        message: `Tenant ${tenant_id} cannot supply candidate numbers. No numbers were added.`,
      });
      return;
    }

    const numbers = await adapter.pullCandidateNumbers(tenant_id);

    CoreRegistry.addCandidateNumbers(numbers);
    Logger.info(`Admin: Synced ${numbers.length} candidate numbers for tenant ${tenant_id}`);
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
        // A real, bounded, read-only upstream probe. It reports the MEASURED
        // latency and never claims health from the presence of credentials.
        // An adapter that does not implement a probe cannot assert health, so
        // it is reported as `configured` (health not asserted) rather than
        // the hard-coded `healthy` this used to return.
        const health = adapter?.getHealth
          ? await adapter.getHealth(t.tenant_id)
          : { status: 'configured' as const, details: { reason: 'adapter_does_not_expose_a_health_probe' } };
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

    // The Dashboard publisher's effective mode.
    //
    // `DRY_RUN` decides whether CST events are actually delivered to the
    // Dashboard. It is a deployment setting, and an operator needs to be able
    // to CONFIRM it without reading a secret out of a log stream. This is an
    // ADMIN-AUTHENTICATED response, so it reports the boolean and never the
    // underlying value or the dashboard key. The general log stream is not
    // the right place for it: a retained, widely-read log is the wrong
    // surface for a configuration fact.
    const dashboardPublisher = getDashboardPublisher();

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
      dashboard_publisher: {
        configured: dashboardPublisher.isConfigured(),
        // True means events are validated and logged locally but NOT sent to
        // the Dashboard. This is the operator's confirmation that no
        // production Dashboard records are being written.
        dry_run: dashboardPublisher.isDryRun(),
      },
      voice_lane: {
        recent_24h_deliveries_count: voiceDeliveries24h.length,
        // DERIVED, not asserted. This used to be hard-coded `true`, which
        // meant the admin readiness view claimed the voice lane was healthy
        // while the public `/health/voice` endpoint was correctly reporting
        // it as degraded and refusing with 503. The two views contradicted
        // each other, and the admin one was the optimistic one.
        //
        // The gate is the same one `/health/voice` uses: at least one
        // successful voice delivery in the last 24 hours. Zero deliveries
        // means the lane is unverified, so it is not healthy.
        healthy: voiceDeliveries24h.length > 0,
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
        // In-memory fallback (test / no-DB mode). Must carry the same scope as
        // the Postgres branch — dropping project_id or collapsing farm_ids to
        // the first entry would make the Admin Panel under-report the user's
        // real project and farm access.
        DbClient.seedCustomer({
          tenant_id,
          project_id,
          phone_e164: speaker.phone_e164.trim(),
          customer_ref: speaker.person_id,
          role: speaker.role as 'owner' | 'manager' | 'tech',
          farm_ids: [...speaker.farm_ids],
          speaker_cache_expires_at: expiresAt,
        });
      }

      // Invalidate speaker cache so next inbound resolves fresh, and mirror the
      // projected row into the adapter directory the runtime resolves against.
      CoreRegistry.invalidateSpeakerCache(tenant_id, project_id, speaker.phone_e164);
      mirrorSpeakerToAdapter(project_id, {
        phone_e164: speaker.phone_e164.trim(),
        customer_ref: speaker.person_id,
        role: speaker.role,
        farm_ids: speaker.farm_ids,
      });

      synced.push({
        person_id: speaker.person_id,
        phone_e164: speaker.phone_e164,
        role: speaker.role,
        farm_count: speaker.farm_ids.length,
      });
    }

    // Prune users the adapter dropped because they are no longer members of the
    // vFarm org (pullSpeakers removes them after a live org-members check).
    // Without this the Admin Panel keeps showing — and re-syncing would keep
    // resurrecting — a speaker vFarm has already revoked.
    //
    // Guarded on live mode on purpose: when the adapter cannot verify upstream
    // it returns its last-known directory intact, so pruning there would delete
    // real rows on an outage. Fail-closed authorization already happens at
    // resolve time; this only makes the projection tell the truth.
    const verifiedLive = typeof (adapter as any).isLiveMode === 'function'
      ? (adapter as any).isLiveMode() === true
      : false;
    let pruned: string[] = [];
    if (verifiedLive) {
      const upstreamPersonIds = new Set(speakers.map((s) => s.person_id));
      const existing = await DbClient.getAllCustomers(tenant_id, project_id);
      for (const row of existing) {
        if (upstreamPersonIds.has(row.customer_ref)) continue;
        await DbClient.deleteCustomer(row.phone_e164, tenant_id, project_id);
        unmirrorSpeakerFromAdapter(project_id, row.phone_e164);
        pruned.push(row.customer_ref);
      }
    }

    Logger.info(`Admin speakers/sync: synced ${synced.length} speakers for tenant=${tenant_id} project=${project_id}${pruned.length ? ` (pruned ${pruned.length} revoked: ${pruned.join(',')})` : ''}`);
    res.status(200).json({
      status: 'synced',
      tenant_id,
      project_id,
      count: synced.length,
      speakers: synced,
      pruned_count: pruned.length,
      pruned,
    });
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
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    if (pool) {
      await pool.query(
        `UPDATE customers
         SET speaker_cache_expires_at = NOW() - INTERVAL '1 second'
         WHERE tenant_id = $1
           AND ($2::text IS NULL OR project_id = $2)
           AND phone_e164 = $3`,
        [tenant_id, project_id || null, phone_e164.trim()]
      );
    } else {
      // In-memory mode has no SQL to expire the row; write the past TTL
      // directly so the projection reports the same expired state the Admin
      // Panel shows (and a runtime lookup treats it as a miss).
      await DbClient.updateCustomer(phone_e164, tenant_id, project_id || undefined, {
        speaker_cache_expires_at: expiredAt,
      });
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

      // RUNTIME RESOLUTION STATE.
      //
      // The row above is a CST projection. Whether an INBOUND caller with this
      // number resolves as a known speaker is a different question, answered by
      // the tenant adapter's live phone->identity directory. The two can
      // disagree, and when they do the caller is silently downgraded to a
      // guest — which is how "my number is registered but the bot keeps
      // calling a specialist" happens.
      //
      // The UI must show BOTH, otherwise a registered-but-unresolvable account
      // looks healthy.
      let identityResolution: 'bound' | 'not_bound' = 'not_bound';
      const adapter = CoreRegistry.getAdapter(c.tenant_id) as any;
      const projectId = c.project_id || '';
      if (adapter?.getRegisteredSpeaker && projectId) {
        const runtime = adapter.getRegisteredSpeaker(projectId, c.phone_e164);
        if (runtime && runtime.person_id === c.customer_ref) {
          identityResolution = 'bound';
        }
      }

      const farmIds = c.farm_ids || (c.farm_id ? [c.farm_id] : []);
      return {
        phone_e164: c.phone_e164,
        customer_ref: c.customer_ref,
        person_id: c.customer_ref,
        tenant_id: c.tenant_id,
        project_id: projectId,
        role: c.role || 'manager',
        farm_ids: farmIds,
        farm_count: farmIds.length,
        // 'granted' = the CST projection carries grants. 'none' = it carries
        // none. The AUTHORITATIVE grant list is the upstream one, read at
        // resolve time — this is the projection, and it is labelled as such.
        farm_grants_state: farmIds.length > 0 ? 'granted' : 'none',
        speaker_cache_expires_at: c.speaker_cache_expires_at,
        is_cache_active,
        // Whether an inbound caller with this number currently resolves as a
        // known speaker (true) or as a guest (false).
        identity_resolution: identityResolution,
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
    mirrorSpeakerToAdapter(project_id, {
      phone_e164: cleanPhone,
      customer_ref: customer_ref.trim(),
      role: cleanRole,
      farm_ids: cleanFarms,
    });

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

    Logger.info(`Admin: Manually onboarded speaker ${maskPhone(cleanPhone)} (${customer_ref}) in ${tenant_id}/${project_id}`);
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

    const mirrorProjectId = project_id || updated.project_id;
    if (mirrorProjectId) {
      mirrorSpeakerToAdapter(mirrorProjectId, {
        phone_e164: updated.phone_e164,
        customer_ref: updated.customer_ref,
        role: updated.role,
        farm_ids: updated.farm_ids || (updated.farm_id ? [updated.farm_id] : []),
      });
    }

    CoreRegistry.invalidateSpeakerCache(tenant_id, project_id || updated.project_id || '', phoneE164);
    Logger.info(`Admin: Updated configuration for speaker ${maskPhone(phoneE164)}`);
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

    // Capture the affected project scope BEFORE the row is removed, so the
    // runtime adapter directory can be evicted too. Without this a revoked
    // speaker keeps resolving through the adapter's in-memory directory.
    let affectedProjects: string[] = projectId ? [projectId] : [];
    if (!projectId) {
      const existing = await DbClient.getAllCustomers(tenantId, undefined, undefined, phoneE164.trim());
      affectedProjects = Array.from(new Set(existing.map((c) => c.project_id).filter(Boolean))) as string[];
    }

    const deleted = await DbClient.deleteCustomer(phoneE164, tenantId, projectId);
    for (const proj of affectedProjects) {
      unmirrorSpeakerFromAdapter(proj, phoneE164);
    }
    CoreRegistry.invalidateSpeakerCache(tenantId, projectId || '', phoneE164);
    Logger.info(`Admin: Revoked/deleted speaker ${maskPhone(phoneE164)} for tenant ${tenantId}`);
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

// ── 7. Dynamic vFarm Operations & Dashboard (/api/v1/admin/vfarm/...) ─────────
// JWT / credentials are sourced EXCLUSIVELY from environment variables.
// (VFARM_JWT, VFARM_ADMIN_EMAIL, VFARM_ADMIN_PASSWORD, VFARM_FARM_KEY)
// The browser client NEVER passes auth tokens to these endpoints.

/**
 * POST /api/v1/admin/vfarm/login
 * Triggers a server-side login using VFARM_ADMIN_EMAIL + VFARM_ADMIN_PASSWORD from env.
 * The resulting JWT is stored in the adapter's in-memory state only — never returned.
 */
adminRouter.post('/vfarm/login', async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    const adminEmail = process.env.VFARM_ADMIN_EMAIL;
    const adminPassword = process.env.VFARM_ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) {
      res.status(503).json({
        error: 'CONFIG_MISSING',
        message: 'Set VFARM_ADMIN_EMAIL and VFARM_ADMIN_PASSWORD in .env to enable dynamic login.',
      });
      return;
    }
    await adapter.authenticateAdmin(adminEmail, adminPassword);
    res.status(200).json({ status: 'authenticated' });
  } catch (err: any) {
    sendProxyError(res, 'login', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/farms
 * Discovers all accessible farms. JWT is resolved server-side:
 * adapter in-memory → VFARM_JWT env var → VFARM_FARM_KEY env var.
 *
 * Auto-relogin: if discoverFarms() fails with a 401/403 and
 * VFARM_ADMIN_EMAIL + VFARM_ADMIN_PASSWORD are set, the route triggers a
 * server-side re-authentication and retries once before giving up.
 */
adminRouter.get('/vfarm/farms', async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }

    let farms: import('../adapters/vfarm/schemas.js').FarmResponse[];
    try {
      // discoverFarms() already handles JWT expiry + one-shot re-auth internally.
      farms = await adapter.discoverFarms();
    } catch (innerErr: any) {
      // Route-level fallback: if the adapter couldn't auto-relogin (e.g. it
      // was the first startup and no password was cached yet), try an explicit
      // server-side login and retry discovery once more.
      const upstreamStatus = innerErr?.status ?? innerErr?.statusCode;
      const adminEmail = process.env.VFARM_ADMIN_EMAIL;
      const adminPassword = process.env.VFARM_ADMIN_PASSWORD;
      if ((upstreamStatus === 401 || upstreamStatus === 403) && adminEmail && adminPassword) {
        Logger.warn('Admin GET /vfarm/farms: upstream 401 — attempting server-side re-login and retry');
        try {
          await adapter.authenticateAdmin(adminEmail, adminPassword);
          farms = await adapter.discoverFarms();
        } catch (retryErr: any) {
          Logger.error(`Admin GET /vfarm/farms re-login retry failed: ${retryErr.message}`);
          sendProxyError(res, 'farms discovery (re-auth retry)', retryErr);
          return;
        }
      } else {
        throw innerErr; // no credentials or non-auth error — let the outer catch handle it
      }
    }

    res.status(200).json({
      farms,
      total: farms.length,
      active_farm_id: adapter.getActiveFarmId(),
    });
  } catch (err: any) {
    sendProxyError(res, 'farms discovery', err);
  }
});

/**
 * POST /api/v1/admin/vfarm/tokens
 * Issues a farm-scoped API key. JWT is resolved server-side from env.
 * The raw_key is stored in the adapter only — never returned to the client.
 */
adminRouter.post('/vfarm/tokens', async (req: Request, res: Response) => {
  try {
    const { farm_id, name } = req.body || {};
    if (!farm_id) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    // JWT from env only — client passes no credentials
    await adapter.issueFarmToken(farm_id, undefined, name);

    // Credential-minting event: audited with the farm, never the key.
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'cst_admin_session',
      role: 'superadmin',
      entry_point: 'api',
      tool_or_route: 'POST /api/v1/admin/vfarm/tokens',
      outcome: 'ok',
      reason: `Operator issued a farm-scoped API key for farm ${farm_id}; the adapter's active farm key was switched`,
      correlation_id: (req.headers['x-correlation-id'] as string) || undefined,
    });

    res.status(201).json({ status: 'issued', farm_id });
  } catch (err: any) {
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: null,
      actor: 'cst_admin_session',
      role: 'superadmin',
      entry_point: 'api',
      tool_or_route: 'POST /api/v1/admin/vfarm/tokens',
      outcome: 'refused',
      reason: `Operator farm-scoped API key issuance failed for farm ${(req.body || {}).farm_id || 'unknown'}: ${err?.message}`,
      correlation_id: (req.headers['x-correlation-id'] as string) || undefined,
    });
    sendProxyError(res, 'token issuance', err);
  }
});

/**
 * POST /api/v1/admin/vfarm/select
 * Switches the active farm context. JWT resolved server-side from env.
 */
adminRouter.post('/vfarm/select', async (req: Request, res: Response) => {
  try {
    const { farm_id } = req.body || {};
    if (!farm_id) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    // No JWT from client — adapter resolves from its env-backed state
    const result = await adapter.switchActiveFarm(farm_id);
    res.status(200).json({ status: 'active', active_farm_id: result.farmId });
  } catch (err: any) {
    sendProxyError(res, 'farm selection', err);
  }
});

adminRouter.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId() || undefined;
    const data = await adapter.getDashboardData(farmId);
    res.status(200).json(data);
  } catch (err: any) {
    Logger.error(`Admin dashboard error: ${err.message}`);
    sendProxyError(res, 'dashboard', err);
  }
});

adminRouter.get('/vfarm/dashboard', async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId() || undefined;
    const data = await adapter.getDashboardData(farmId);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'dashboard', err);
  }
});

// ── 8. vFarm OpenAPI Proxy Routes (/api/v1/admin/vfarm/proxy/...) ─────────────
// These are direct pass-through proxy routes to the live vFarm API.
// All auth is server-side (X-Farm-Key from env). The browser client never
// handles credentials. All responses are passed through verbatim.

/** Helper to get the live client or return 503 */
function getLiveClient(res: Response): import('../adapters/vfarm/live_client.js').VfarmLiveClient | null {
  const adapter = CoreRegistry.getVfarmAdapter();
  if (!adapter) {
    res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
    return null;
  }
  const client = adapter.getLiveClient();
  if (!client) {
    res.status(503).json({ error: 'NO_LIVE_CLIENT', message: 'vFarm live client is not configured. Set VFARM_BASE_URL and VFARM_FARM_KEY in .env.' });
    return null;
  }
  return client;
}

/**
 * Send a vFarm proxy failure to the browser WITHOUT leaking the upstream status.
 *
 * These routes proxy third-party calls. Re-emitting vFarm's own 401/403 is wrong
 * twice over:
 *   - semantically, the caller's CST admin session was fine; it is the *upstream*
 *     credential that is missing or expired;
 *   - practically, the Admin Panel treats any 401 as "my session expired", clears
 *     the stored token and bounces the operator to the login screen. An expired
 *     VFARM_JWT therefore logged admins out of CST entirely (observed with an
 *     expired JWT: GET /vfarm/organizations returned 401 and the panel lost its
 *     session).
 *
 * Upstream auth failures are therefore reported as 502 with an explicit code, so
 * the panel can show "vFarm unavailable" without touching CST admin auth.
 */
function sendProxyError(res: Response, label: string, err: any): void {
  const status = err?.status;
  const isUpstreamAuth = status === 401 || status === 403;
  Logger.error(`vFarm ${label} proxy: ${err?.message ?? String(err)}`);
  res.status(isUpstreamAuth ? 502 : (status || 502)).json({
    error: isUpstreamAuth ? 'VFARM_AUTH_FAILED' : 'PROXY_ERROR',
    upstream_status: status,
    message: err?.message ?? String(err),
  });
}

/**
 * GET /api/v1/admin/vfarm/health
 * Proxies GET /api/v1/health — returns { status, db, version }.
 */
adminRouter.get('/vfarm/health', async (_req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const data = await client.getApiHealth();
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'health', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/summary?farm_id=...
 * Proxies GET /api/v1/dashboard/summary.
 */
adminRouter.get('/vfarm/summary', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId() || undefined;
    const data = await client.getDashboardSummary(farmId);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'summary', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/system-stats
 * Proxies GET /api/v1/system/stats.
 */
adminRouter.get('/vfarm/system-stats', async (_req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const data = await client.getSystemStats();
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'system stats', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/organizations
 * Proxies GET /api/v1/organizations using env JWT.
 */
adminRouter.get('/vfarm/organizations', async (_req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const jwt = (await adapter.ensureAdminToken()) || undefined;
    const data = await client.listOrganizations(jwt);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'organizations', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/layout?farm_id=...
 * Proxies GET /api/v1/farms/{farm_id}/layout — full zone/location tree.
 */
adminRouter.get('/vfarm/layout', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required (or set an active farm)' });
      return;
    }
    const data = await client.getFarmLayout(farmId);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'layout', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/zones?farm_id=...
 * Proxies GET /api/v1/farms/{farm_id}/zones.
 */
adminRouter.get('/vfarm/zones', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const zones = await client.listFarmZones(farmId);
    res.status(200).json({ zones, total: zones.length });
  } catch (err: any) {
    sendProxyError(res, 'zones', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/devices?farm_id=...&filter=all|offline|unhealthy
 * Proxies GET /api/v1/devices, /api/v1/devices/offline, or /api/v1/devices/unhealthy.
 */
adminRouter.get('/vfarm/devices', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const filter = (req.query.filter as string) || 'all';
    let data;
    if (filter === 'offline') {
      data = await client.listOfflineDevices(farmId);
    } else if (filter === 'unhealthy') {
      data = await client.listUnhealthyDevices(farmId);
    } else {
      data = await client.listAllDevices(farmId);
    }
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'devices', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/devices/:device_id
 * Proxies GET /api/v1/devices/{device_id}.
 */
adminRouter.get('/vfarm/devices/:device_id', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const { device_id } = req.params;
    const data = await client.getDevice(device_id);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'device detail', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/devices/:device_id/rollup
 * Proxies GET /api/v1/devices/{device_id}/rollup.
 */
adminRouter.get('/vfarm/devices/:device_id/rollup', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const { device_id } = req.params;
    const data = await client.getDeviceRollup(device_id);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'device rollup', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/readings/latest?farm_id=...
 * Proxies GET /api/v1/readings/latest — latest readings across the farm.
 */
adminRouter.get('/vfarm/readings/latest', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const readings = await client.listLatestReadings(farmId, limit);
    res.status(200).json({ readings, total: readings.length });
  } catch (err: any) {
    sendProxyError(res, 'readings/latest', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/readings/sensor-latest?sensor_id=...
 * Proxies GET /api/v1/readings/latest?sensor_id=...
 */
adminRouter.get('/vfarm/readings/sensor-latest', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const sensorId = req.query.sensor_id as string;
    if (!sensorId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'sensor_id is required' });
      return;
    }
    const data = await client.getLatestReading(sensorId);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'sensor-latest', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/readings?sensor_id=...&limit=...
 * Proxies GET /api/v1/readings — historical readings for a sensor.
 */
adminRouter.get('/vfarm/readings', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const sensorId = req.query.sensor_id as string;
    if (!sensorId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'sensor_id is required' });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const data = await client.getReadings(sensorId, limit);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'readings', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/readings/stats?sensor_id=...&window=...
 * Proxies GET /api/v1/readings/stats.
 */
adminRouter.get('/vfarm/readings/stats', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const sensorId = req.query.sensor_id as string;
    if (!sensorId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'sensor_id is required' });
      return;
    }
    const window = (req.query.window as string) || '24h';
    const data = await client.getReadingStats(sensorId, window);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'readings/stats', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/alerts/counts?farm_id=...
 * Proxies GET /api/v1/alerts/threshold/counts.
 */
adminRouter.get('/vfarm/alerts/counts', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const data = await client.getAlertCounts(farmId);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'alert counts', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/alerts/open?farm_id=...
 * Proxies GET /api/v1/alerts/threshold/open.
 */
adminRouter.get('/vfarm/alerts/open', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const data = await client.listOpenAlerts(farmId, limit);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'open alerts', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/alerts/history?farm_id=...
 * Proxies GET /api/v1/alerts/history.
 */
adminRouter.get('/vfarm/alerts/history', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const data = await client.listAlertHistory(farmId, limit);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'alert history', err);
  }
});

/**
 * GET /api/v1/admin/vfarm/vision/latest?farm_id=...
 * Proxies GET /api/v1/vision/images/latest.
 */
adminRouter.get('/vfarm/vision/latest', async (req: Request, res: Response) => {
  try {
    const client = getLiveClient(res);
    if (!client) return;
    const adapter = CoreRegistry.getVfarmAdapter()!;
    const farmId = (req.query.farm_id as string) || adapter.getActiveFarmId();
    if (!farmId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_id is required' });
      return;
    }
    const data = await client.getLatestVisionImage(farmId);
    res.status(200).json(data);
  } catch (err: any) {
    sendProxyError(res, 'vision', err);
  }
});

// ── 9. Turn Stream & Delivery State (/api/v1/admin/turn-stream) ───────────────
/**
 * GET /api/v1/admin/turn-stream
 * Returns the in-process turn + delivery journal for dashboard display.
 * Each row joins an inbound message with its outbound reply (if any).
 *
 * Query params:
 *   tenant_id  – filter by tenant
 *   limit      – max rows (default 100, max 500)
 */
adminRouter.get('/turn-stream', async (req: Request, res: Response) => {
  try {
    const tenantFilter = req.query.tenant_id as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const conversations = DbClient.getAllConversations();
    const messagesIn    = DbClient.getAllMessagesIn();
    const messagesOut   = DbClient.getAllMessagesOut();

    // Index outbound messages by turn_id (= MessageSid = cst.turn.turn_id after fix)
    const outboundByTurnId = new Map<string, typeof messagesOut[number]>();
    for (const out of messagesOut) {
      const key = out.turn_id || out.correlation_id;
      if (key && !outboundByTurnId.has(key)) {
        outboundByTurnId.set(key, out);
      }
    }

    // Build turn stream rows — one row per inbound message
    const rows = messagesIn
      .filter((m) => !tenantFilter || m.tenant_id === tenantFilter)
      .slice(0, limit)
      .map((inbound) => {
        const outbound = outboundByTurnId.get(inbound.message_id);
        const conv = conversations.find((c) => c.tenant_id === inbound.tenant_id);
        return {
          turn_id: inbound.message_id,                      // = cst.turn.turn_id
          conversation_id: (inbound as any).conversation_id || conv?.conversation_id,
          tenant_id: inbound.tenant_id,
          project_id: (inbound as any).project_id,
          customer_phone: inbound.from_e164,
          service_number: inbound.to_e164,
          inbound_text: inbound.body,
          received_at: inbound.received_at,
          // Delivery (cst.delivery) fields
          delivery_status: outbound?.status ?? null,
          delivery_provider_sid: outbound?.provider_sid ?? null,
          delivery_turn_id: outbound?.turn_id ?? null,
          reply_body: outbound?.body ?? null,
          delivery_error: outbound?.error_message ?? null,
          delivery_updated_at: outbound?.updated_at ?? null,
          // Correlation health check: turn_id matches outbound turn_id?
          correlated: outbound
            ? (inbound.message_id === (outbound.turn_id || outbound.correlation_id))
            : null,
        };
      })
      .sort((a, b) => (b.received_at || '').localeCompare(a.received_at || ''));

    res.status(200).json({
      status: 'ok',
      count: rows.length,
      turns: rows,
    });
  } catch (err: any) {
    Logger.error(`Admin GET turn-stream error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

// ── 10. vFarm Users / Customer Verification (/api/v1/admin/vfarm/customers) ───
/**
 * GET /api/v1/admin/vfarm/customers?org_id=...
 * Returns vFarm org members cross-referenced with local CST speaker records.
 * Used by the admin panel Users tab to show the authoritative vFarm user list
 * and verify each user has a matching local speaker record.
 */
adminRouter.get(['/vfarm/customers', '/vfarm/users'], async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    const client = adapter.getLiveClient();
    if (!client) {
      res.status(503).json({
        error: 'NO_LIVE_CLIENT',
        message: 'vFarm live client not configured. Set VFARM_BASE_URL and VFARM_FARM_KEY in .env.',
      });
      return;
    }

    const orgId = req.query.org_id as string | undefined;
    if (!orgId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'org_id query param is required' });
      return;
    }

    const jwt = await adapter.ensureAdminToken();

    // Fetch live vFarm org members — try both method names for safety
    let vfarmMembers: any[] = [];
    let sourceError: string | null = null;
    try {
      if (typeof (client as any).listOrganizationMembers === 'function') {
        vfarmMembers = await (client as any).listOrganizationMembers(orgId, jwt || undefined);
      } else if (typeof (client as any).getOrgMembers === 'function') {
        // This endpoint rejects X-Farm-Key auth, so the bearer JWT is required.
        vfarmMembers = await (client as any).getOrgMembers(orgId, jwt || undefined);
      } else {
        sourceError = 'vFarm live client exposes no organization-members method';
      }
    } catch (err: any) {
      Logger.warn(`Admin vfarm/customers: org members fetch failed: ${err.message}`);
      vfarmMembers = [];
      sourceError = err.message;
    }

    // Cross-reference with local CST speakers.
    const localSpeakers = await DbClient.getAllCustomers();
    const byUserId = new Map<string, (typeof localSpeakers)[number]>();
    for (const s of localSpeakers) {
      if (s.customer_ref && !byUserId.has(s.customer_ref)) byUserId.set(s.customer_ref, s);
    }

    // Enrich each member with live farm grants from vFarm
    const customers = await Promise.all(
      vfarmMembers.map(async (member: any) => {
        let liveGrants: any[] = [];
        try {
          if (client && typeof client.getUserFarmGrants === 'function') {
            liveGrants = await client.getUserFarmGrants(member.user_id, jwt || undefined);
          }
        } catch (err: any) {
          Logger.warn(`Admin vfarm/customers: live farm grants lookup failed for ${member.user_id}: ${err.message}`);
        }

        const local = byUserId.get(member.user_id);
        const liveFarmIds = liveGrants.map((g: any) => g.farm_id).filter(Boolean);

        return {
          user_id: member.user_id,
          email: member.email,
          name: member.name,
          vfarm_role: member.role,
          granted_at: member.granted_at,
          // Authoritative live vFarm grants
          vfarm_grants: liveGrants,
          vfarm_farm_ids: liveFarmIds,
          farm_grants_count: liveGrants.length,
          // CST local record
          cst_registered: Boolean(local),
          cst_phone_e164: local?.phone_e164 ?? null,
          cst_role: local?.role ?? null,
          cst_project_id: local?.project_id ?? null,
          cst_farm_ids: local?.farm_ids ?? null,
          cst_cache_expires_at: local?.speaker_cache_expires_at ?? null,
        };
      })
    );

    res.status(200).json({
      status: 'ok',
      org_id: orgId,
      count: customers.length,
      customers,
      vfarm_source: sourceError ? 'unavailable' : 'live',
      source_error: sourceError,
    });
  } catch (err: any) {
    Logger.error(`Admin GET vfarm/customers error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /api/v1/admin/vfarm/users/:userId/farm-grants
 * Returns live authoritative farm grants for a specific vFarm user.
 */
adminRouter.get('/vfarm/users/:userId/farm-grants', async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    const client = adapter.getLiveClient();
    if (!client) {
      res.status(503).json({ error: 'NO_LIVE_CLIENT', message: 'vFarm live client not configured' });
      return;
    }

    const { userId } = req.params;
    if (!userId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'userId is required' });
      return;
    }

    const jwt = await adapter.ensureAdminToken();
    const grants = await client.getUserFarmGrants(userId, jwt || undefined);
    res.status(200).json({
      status: 'ok',
      user_id: userId,
      count: grants.length,
      grants,
    });
  } catch (err: any) {
    Logger.error(`Admin GET vfarm/users/:userId/farm-grants error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

/**
 * POST /api/v1/admin/vfarm/users/:userId/farm-grants
 *
 * Grants a vFarm user access to farms. This is the AUTHORITATIVE grant
 * mechanism: vFarm owns farm membership, so the grant is made upstream
 * through `POST /api/v1/farms/grants` and CST records nothing of its own.
 *
 * Body: { role_id: 'operator' | 'viewer', farm_ids: string[] }
 *
 * There is no farm-level `owner` role — `owner` is CST's mapping of the
 * ORGANISATION role `admin`. The farm role is chosen explicitly.
 */
adminRouter.post('/vfarm/users/:userId/farm-grants', async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    const client = adapter.getLiveClient();
    if (!client) {
      res.status(503).json({ error: 'NO_LIVE_CLIENT', message: 'vFarm live client not configured' });
      return;
    }

    const { userId } = req.params;
    const { role_id, farm_ids } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'userId is required' });
      return;
    }
    if (role_id !== 'operator' && role_id !== 'viewer') {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: "role_id must be 'operator' or 'viewer'. There is no farm-level 'owner' role.",
      });
      return;
    }
    const farmIds = Array.isArray(farm_ids) ? farm_ids.map((f: unknown) => String(f)).filter(Boolean) : [];
    if (farmIds.length === 0) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_ids must be a non-empty array' });
      return;
    }

    const jwt = await adapter.ensureAdminToken();
    const result = await client.grantUserFarmRoles(userId, role_id, farmIds, jwt || undefined);
    res.status(201).json({ status: 'ok', user_id: userId, role_id, farm_ids: farmIds, result });
  } catch (err: any) {
    Logger.error(`Admin POST vfarm/users/:userId/farm-grants error: ${err.message}`);
    res.status(502).json({ error: 'VFARM_UPSTREAM_ERROR', message: err.message });
  }
});

/**
 * DELETE /api/v1/admin/vfarm/users/:userId/farm-grants
 *
 * Revokes a vFarm user's access to farms. Body: { farm_ids: string[] }
 */
adminRouter.delete('/vfarm/users/:userId/farm-grants', async (req: Request, res: Response) => {
  try {
    const adapter = CoreRegistry.getVfarmAdapter();
    if (!adapter) {
      res.status(503).json({ error: 'ADAPTER_UNAVAILABLE', message: 'vFarm adapter is not registered' });
      return;
    }
    const client = adapter.getLiveClient();
    if (!client) {
      res.status(503).json({ error: 'NO_LIVE_CLIENT', message: 'vFarm live client not configured' });
      return;
    }

    const { userId } = req.params;
    const { farm_ids } = req.body || {};
    if (!userId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'userId is required' });
      return;
    }
    const farmIds = Array.isArray(farm_ids) ? farm_ids.map((f: unknown) => String(f)).filter(Boolean) : [];
    if (farmIds.length === 0) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'farm_ids must be a non-empty array' });
      return;
    }

    const jwt = await adapter.ensureAdminToken();
    const result = await client.revokeUserFarmRoles(userId, farmIds, jwt || undefined);
    res.status(200).json({ status: 'ok', user_id: userId, farm_ids: farmIds, result });
  } catch (err: any) {
    Logger.error(`Admin DELETE vfarm/users/:userId/farm-grants error: ${err.message}`);
    res.status(502).json({ error: 'VFARM_UPSTREAM_ERROR', message: err.message });
  }
});

// ── 11. SMS Consent Spine (/api/v1/admin/sms-consent/*) ────────────────────────
// Consent is strictly separate from vFarm identity/farm authorization.
// These endpoints allow operators to inspect and manage SMS consent state.

/**
 * GET /api/v1/admin/sms-consent/wording
 * Returns the canonical consent wording and version.
 * Every UI surface must use this exact wording when collecting consent.
 */
adminRouter.get('/sms-consent/wording', (_req: Request, res: Response) => {
  const wording = getConsentWording();
  res.status(200).json({
    version: wording.version,
    text: wording.text,
    consents_version: CONSENT_WORDING_VERSION,
  });
});

/**
 * POST /api/v1/admin/sms-consent
 * Grant or revoke SMS consent for a phone number.
 *
 * Body:
 *   tenant_id: string (required)
 *   project_id: string (optional)
 *   phone_e164: string (required, E.164)
 *   action: 'grant' | 'revoke'  (required)
 *   source: string (optional, defaults based on action)
 *   correlation_id: string (optional)
 *
 * The server stamps the canonical wording version/snapshot from
 * getConsentWording() — client-supplied wording is ignored.
 */
adminRouter.post('/sms-consent', async (req: Request, res: Response) => {
  try {
    const { tenant_id, project_id, phone_e164, action, source, correlation_id } = req.body;

    if (!tenant_id || !phone_e164 || !action) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Missing required fields: tenant_id, phone_e164, action (grant|revoke)',
      });
      return;
    }

    if (action !== 'grant' && action !== 'revoke') {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: `Invalid action "${action}". Must be "grant" or "revoke".`,
      });
      return;
    }

    const wording = getConsentWording();

    let record: any;
    let auditAction: string;

    if (action === 'grant') {
      record = await recordConsent(tenant_id, phone_e164, {
        projectId: project_id,
        source: source || 'admin_grant',
        correlationId: correlation_id,
        actor: 'admin',
      });
      auditAction = 'consent_granted';
    } else {
      record = await recordOptOut(tenant_id, phone_e164, {
        projectId: project_id,
        source: source || 'admin_revoke',
        correlationId: correlation_id,
        actor: 'admin',
        reason: 'Admin revoked SMS consent via Admin Panel',
      });
      auditAction = 'consent_revoked';
    }

    Logger.info(
      `Admin SMS consent ${auditAction}: phone=${phone_e164} tenant=${tenant_id}${project_id ? ` project=${project_id}` : ''}`,
      {
        tenant_id,
        phone_e164,
        action: auditAction,
        correlation_id,
      },
    );

    res.status(201).json({
      status: auditAction,
      tenant_id,
      project_id: project_id || null,
      phone_e164: record.phone_e164,
      consent_status: record.consent_status,
      consented_at: record.consented_at,
      opted_out_at: record.opted_out_at,
      wording_version: record.wording_version,
      wording_snapshot: record.wording_snapshot,
      source: record.source,
      consent_id: record.id,
    });
  } catch (err: any) {
    Logger.error(`Admin POST sms-consent error: ${err.message}`);
    res.status(err.message?.includes('Invalid phone') ? 400 : 500).json({
      error: err.message?.includes('Invalid phone') ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/admin/sms-consent/:phoneE164?tenant_id=…&project_id=…
 * Returns the current consent state for a phone number.
 */
adminRouter.get('/sms-consent/:phoneE164', async (req: Request, res: Response) => {
  try {
    const { phoneE164 } = req.params;
    const tenantId = req.query.tenant_id as string;
    const projectId = req.query.project_id as string | undefined;

    if (!tenantId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing required query param: tenant_id' });
      return;
    }

    const { status, record } = await getConsentStatus(tenantId, phoneE164, projectId);

    const wording = getConsentWording();

    res.status(200).json({
      status,
      consent: record ? {
        id: record.id,
        tenant_id: record.tenant_id,
        project_id: record.project_id,
        phone_e164: record.phone_e164,
        consent_status: record.consent_status,
        consented_at: record.consented_at,
        opted_out_at: record.opted_out_at,
        wording_version: record.wording_version,
        wording_snapshot: record.wording_snapshot,
        source: record.source,
        created_at: record.created_at,
        updated_at: record.updated_at,
      } : null,
      canonical_wording: {
        version: wording.version,
        text: wording.text,
      },
    });
  } catch (err: any) {
    Logger.error(`Admin GET sms-consent error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /api/v1/admin/sms-consent
 * List consent records with optional filters:
 *   tenant_id, project_id, status (opted_in|opted_out|not_consented), search
 */
adminRouter.get('/sms-consent', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenant_id as string | undefined;
    const projectId = req.query.project_id as string | undefined;
    const status = (req.query.status as string || undefined) as ConsentStatus | undefined;
    const search = req.query.search as string | undefined;

    // Validate status param
    if (status && !['opted_in', 'opted_out', 'not_consented'].includes(status)) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: `Invalid status "${status}". Must be one of: opted_in, opted_out, not_consented`,
      });
      return;
    }

    const consents = await DbClient.getAllSmsConsents(
      tenantId,
      projectId,
      status,
      search,
    );

    res.status(200).json({
      status: 'ok',
      count: consents.length,
      consents: consents.map((c) => ({
        id: c.id,
        tenant_id: c.tenant_id,
        project_id: c.project_id,
        phone_e164_masked: maskPhone(c.phone_e164),
        phone_e164: c.phone_e164,
        consent_status: c.consent_status,
        consented_at: c.consented_at,
        opted_out_at: c.opted_out_at,
        wording_version: c.wording_version,
        source: c.source,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })),
    });
  } catch (err: any) {
    Logger.error(`Admin GET sms-consent list error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

/**
 * GET /api/v1/admin/sms-consent/:phoneE164/history?tenant_id=…&project_id=…
 * Returns the audit history for a consent record.
 */
adminRouter.get('/sms-consent/:phoneE164/history', async (req: Request, res: Response) => {
  try {
    const { phoneE164 } = req.params;
    const tenantId = req.query.tenant_id as string;
    const projectId = req.query.project_id as string | undefined;

    if (!tenantId) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing required query param: tenant_id' });
      return;
    }

    const history = await DbClient.getSmsConsentAuditForPhone(phoneE164, tenantId, projectId);

    res.status(200).json({
      status: 'ok',
      phone_e164: phoneE164,
      tenant_id: tenantId,
      project_id: projectId || null,
      count: history.length,
      history: history.map((h) => ({
        action: h.action,
        previous_status: h.previous_status,
        new_status: h.new_status,
        wording_version: h.wording_version,
        source: h.source,
        actor: h.actor,
        reason: h.reason,
        correlation_id: h.correlation_id,
        created_at: h.created_at,
      })),
    });
  } catch (err: any) {
    Logger.error(`Admin GET sms-consent history error: ${err.message}`);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
  }
});

