import { Router, Request, Response } from 'express';
import { CoreRegistry } from '../../core/registry.js';
import { CoreEngine } from '../../core/engine.js';
import { MessageEnvelope, EnvelopeResponse } from '../../core/envelope.js';
import { Logger } from '../../config/logger.js';
import { isTestRunner } from '../../config/runtime.js';
import { randomUUID, createHash } from 'crypto';
import { DbClient } from '../../db/client.js';
import { VoiceInterface } from '../voice/index.js';

export const webInterfaceRouter = Router();
interface WebSession {
  token: string;
  tenant_id: string;
  project_id: string;
  speaker_ref: string;
  display_name: string;
  role: string;
  farm_ids: string[];
  farm_details?: Array<{ farm_id?: string; id?: string; role?: string; farm_name?: string; farm_code?: string }>;
  vfarm_token?: string;
  created_at: string;
}

const sessions = new Map<string, WebSession>();
const webMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; text: string; media?: string[]; created_at: string }>>();
const DEV_USERS: Record<string, { speaker_ref: string; display_name: string }> = {
  'demo-owner': { speaker_ref: '+923082113844', display_name: 'Test Owner' },
  'demo-manager': { speaker_ref: '+15551234567', display_name: 'John Doe' },
};

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.header('cookie') || '';
  return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function getSession(req: Request): Promise<WebSession | null> {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.header('x-cst-session') || cookieValue(req, 'cst_web_session');
  if (token) return sessions.get(token) || null;

  // Check if an admin token is supplied
  const adminToken = req.header('x-admin-token') || cookieValue(req, 'cst_admin_token');
  if (adminToken) {
    const adminSession = await resolveAdminSession(adminToken);
    if (adminSession) {
      const session = await createAdminWebSession(adminSession.email, adminSession.name);
      if (session) return session;
    }
  }

  // A demo session exists only inside a test runner when no token header was provided.
  if (isTestRunner()) return createSessionSync('demo-owner', process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main');
  return null;
}

async function resolveAdminSession(token: string): Promise<{ email: string; name: string } | null> {
  try {
    const pool = DbClient.getPool();
    if (pool) {
      const result = await pool.query(
        `SELECT s.email, u.name
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.admin_id
         WHERE s.token = $1 AND s.expires_at > NOW()`,
        [token],
      );
      if (result.rows.length > 0) {
        return { email: result.rows[0].email, name: result.rows[0].name || 'CST Super Admin' };
      }
    }
  } catch (err: any) {
    Logger.error(`Error resolving admin session in web interface: ${err.message}`);
  }
  return null;
}

async function createAdminWebSession(email: string, name?: string, requestedProjectId?: string): Promise<WebSession | null> {
  const projectId = requestedProjectId || process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main';
  const project = CoreRegistry.getProject(projectId);
  const tenantId = project?.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
  if (!project) return null;
  if (!project.capabilities.web) {
    project.capabilities.web = true;
    CoreRegistry.registerProject(project);
  }

  // Find owner speaker or map to default farm IDs
  const farmIds = [process.env.VFARM_FARM_ID || '21dde23e-f7f6-46bc-9b54-e97fabaaafd7'];
  const session: WebSession = {
    token: `web_${randomUUID()}`,
    tenant_id: tenantId,
    project_id: project.project_id,
    speaker_ref: '+923082113844', // Project owner reference
    display_name: name || 'CST Super Admin',
    role: 'owner',
    farm_ids: farmIds,
    created_at: new Date().toISOString(),
  };
  sessions.set(session.token, session);
  return session;
}

function createSessionSync(userKey: string, projectId: string): WebSession | null {
  const user = DEV_USERS[userKey];
  const project = CoreRegistry.getProject(projectId);
  const tenantId = project?.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
  if (!user || !project || project.tenant_id !== tenantId) return null;
  if (!project.capabilities.web) { project.capabilities.web = true; CoreRegistry.registerProject(project); }
  const session: WebSession = {
    token: `web_test_${userKey}_${projectId}`,
    tenant_id: tenantId,
    project_id: project.project_id,
    speaker_ref: user.speaker_ref,
    display_name: user.display_name,
    role: 'owner',
    farm_ids: [],
    created_at: new Date().toISOString(),
  };
  sessions.set(session.token, session);
  return session;
}

async function createSession(userKey: string, projectId: string): Promise<WebSession | null> {
  const user = DEV_USERS[userKey];
  const project = CoreRegistry.getProject(projectId);
  const tenantId = project?.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
  if (!user || !project || project.tenant_id !== tenantId) return null;
  if (!project.capabilities.web) { project.capabilities.web = true; CoreRegistry.registerProject(project); }
  const identity = await CoreRegistry.resolveSpeaker({ tenantId, projectId: project.project_id, phoneE164: user.speaker_ref });
  if (!identity.is_known) return null;
  const session: WebSession = {
    token: `web_${randomUUID()}`,
    tenant_id: tenantId,
    project_id: project.project_id,
    speaker_ref: identity.phone_e164,
    display_name: user.display_name,
    role: identity.role,
    farm_ids: [...identity.farm_ids],
    created_at: new Date().toISOString(),
  };
  sessions.set(session.token, session);
  return session;
}

async function createVfarmWebSession(
  vfarmUser: { id?: string; email: string; name?: string; role?: string },
  vfarmFarms: Array<{ farm_id?: string; id?: string; role?: string; farm_name?: string; farm_code?: string }>,
  vfarmToken?: string,
  requestedProjectId?: string,
): Promise<WebSession | null> {
  const projectId = requestedProjectId || process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main';
  const project = CoreRegistry.getProject(projectId);
  const tenantId = project?.tenant_id || process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
  if (!project) return null;
  if (!project.capabilities.web) {
    project.capabilities.web = true;
    CoreRegistry.registerProject(project);
  }

  const farmIds = vfarmFarms.map((f) => f.farm_id || f.id).filter((id): id is string => Boolean(id));
  if (farmIds.length === 0 && process.env.VFARM_FARM_ID) {
    farmIds.push(process.env.VFARM_FARM_ID);
  }

  const session: WebSession = {
    token: `web_${randomUUID()}`,
    tenant_id: tenantId,
    project_id: project.project_id,
    speaker_ref: vfarmUser.email,
    display_name: vfarmUser.name || vfarmUser.email,
    role: vfarmFarms[0]?.role || vfarmUser.role || 'owner',
    farm_ids: farmIds,
    farm_details: vfarmFarms,
    vfarm_token: vfarmToken,
    created_at: new Date().toISOString(),
  };
  sessions.set(session.token, session);
  return session;
}

function sessionView(session: WebSession) {
  return {
    session: session.token,
    user: { name: session.display_name, role: session.role },
    tenant: { id: session.tenant_id, name: CoreRegistry.getTenant(session.tenant_id)?.name },
    project: { id: session.project_id, name: CoreRegistry.getProject(session.project_id)?.name },
    farm_count: session.farm_ids.length,
    farms: session.farm_ids,
    farm_details: session.farm_details || session.farm_ids.map((id) => ({ farm_id: id, farm_name: id })),
    production_auth_required: false,
  };
}

webInterfaceRouter.post('/api/v1/web/session', async (req: Request, res: Response) => {
  const { email, password, token, user, project_id } = req.body || {};
  const requestedProjectId = typeof project_id === 'string' && project_id ? project_id : (process.env.VFARM_PROJECT_ID_MAIN || 'proj-vfarm-main');

  // 1. Authenticate via admin token (if passed in body or header)
  const incomingAdminToken = token || req.header('x-admin-token') || cookieValue(req, 'cst_admin_token');
  if (incomingAdminToken) {
    const adminSession = await resolveAdminSession(incomingAdminToken);
    if (adminSession) {
      const session = await createAdminWebSession(adminSession.email, adminSession.name, requestedProjectId);
      if (session) {
        res.setHeader('Set-Cookie', `cst_web_session=${session.token}; HttpOnly; SameSite=Lax; Path=/`);
        res.status(201).json(sessionView(session));
        return;
      }
    }
  }

  // 2. Authenticate via email & password against vFarm
  if (email && password) {
    const trimmedEmail = String(email).trim();
    const vfarmBaseUrl = (process.env.VFARM_API_BASE_URL || process.env.VFARM_BASE_URL || 'https://vfarm.bhanetwork.org').replace(/\/+$/, '');
    let vfarmAuthenticated = false;
    let vfarmUser: any = null;
    let vfarmFarms: any[] = [];
    let vfarmToken: string | undefined;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const vfarmRes = await fetch(`${vfarmBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ email: trimmedEmail, password: String(password) }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (vfarmRes.ok) {
        const data = await vfarmRes.json().catch(() => null) as any;
        if (data && (data.user || data.token || data.access_token || Array.isArray(data.farms))) {
          vfarmAuthenticated = true;
          vfarmUser = data.user || { email: trimmedEmail, name: trimmedEmail.split('@')[0] };
          vfarmFarms = Array.isArray(data.farms) ? data.farms : [];
          vfarmToken = data.token || data.access_token;
        }
      }
    } catch (vfarmErr: any) {
      Logger.warn(`vFarm authentication request error: ${vfarmErr.message}`);
    }

    if (vfarmAuthenticated && vfarmUser) {
      const session = await createVfarmWebSession(vfarmUser, vfarmFarms, vfarmToken, requestedProjectId);
      if (session) {
        res.setHeader('Set-Cookie', `cst_web_session=${session.token}; HttpOnly; SameSite=Lax; Path=/`);
        res.status(201).json(sessionView(session));
        return;
      }
    }

    // Fallback: Check local DB admin_users or in-memory CST admin credentials
    const hash = sha256(password);
    const pool = DbClient.getPool();

    let authenticated = false;
    let adminName = 'CST Super Admin';
    let adminEmail = trimmedEmail.toLowerCase();

    if (pool) {
      try {
        const result = await pool.query(
          `SELECT id, email, name, role, is_active FROM admin_users
           WHERE email = $1 AND password_hash = $2`,
          [adminEmail, hash],
        );
        if (result.rows.length > 0 && result.rows[0].is_active) {
          authenticated = true;
          adminName = result.rows[0].name || adminName;
        }
      } catch (err: any) {
        Logger.error(`Database admin auth check error: ${err.message}`);
      }
    } else {
      // In-memory fallback
      const validEmail = (process.env.CST_ADMIN_EMAIL || 'admin@cst.com').toLowerCase().trim();
      const validHash = process.env.CST_ADMIN_PASSWORD_HASH || '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918';
      if (adminEmail === validEmail && hash === validHash) {
        authenticated = true;
        adminName = process.env.CST_ADMIN_NAME || adminName;
      }
    }

    if (authenticated) {
      const session = await createAdminWebSession(adminEmail, adminName, requestedProjectId);
      if (session) {
        res.setHeader('Set-Cookie', `cst_web_session=${session.token}; HttpOnly; SameSite=Lax; Path=/`);
        res.status(201).json(sessionView(session));
        return;
      }
    } else {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not found in vFarm or invalid credentials. Please check your credentials.',
      });
      return;
    }
  }

  // 3. Fallback to development identity when NOT in production or when in test runner
  if (process.env.NODE_ENV !== 'production' || isTestRunner()) {
    const userKey = typeof user === 'string' && user ? user : 'demo-owner';
    const session = await createSession(userKey, requestedProjectId);
    if (session) {
      res.setHeader('Set-Cookie', `cst_web_session=${session.token}; HttpOnly; SameSite=Lax; Path=/`);
      res.status(201).json(sessionView(session));
      return;
    }
  }

  // 4. In production without credentials
  res.status(401).json({
    error: 'AUTH_REQUIRED',
    message: 'Production web access requires email and password authentication.',
  });
});

webInterfaceRouter.get('/api/v1/web/session', async (req: Request, res: Response) => {
  const session = await getSession(req);
  if (!session) { res.status(401).json({ error: 'INVALID_SESSION' }); return; }
  res.json(sessionView(session));
});

webInterfaceRouter.get('/api/v1/web/projects', (_req: Request, res: Response) => {
  const tenantId = process.env.VFARM_TENANT_ID || 'tenant-vfarm-01';
  res.json(CoreRegistry.getProjectsForTenant(tenantId).filter((project) => project.status === 'active' && (project.capabilities.web || process.env.NODE_ENV !== 'production')).map((project) => ({ project_id: project.project_id, name: project.name })));
});

webInterfaceRouter.post('/api/v1/web/message', async (req: Request, res: Response) => {
  try {
    const session = await getSession(req);
    if (!session) { res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid web session is required.' }); return; }
    const { text, media, voice } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) { res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing required parameter: text' }); return; }
    const envelope: MessageEnvelope = { tenant_id: session.tenant_id, project_id: session.project_id, channel: 'web', speaker_ref: session.speaker_ref, text: text.trim(), media: Array.isArray(media) ? media.filter((item): item is string => typeof item === 'string') : [], correlation_id: `web_${randomUUID()}` };
    const response = await WebInterface.handleWebEnvelope(envelope, session);

    // Synthesize voice via ElevenLabs when requested or when configured in environment
    let audioUrl: string | undefined;
    const shouldSynthesize = voice === true || voice === 'true' || process.env.WEB_VOICE_AUTO_SYNTHESIZE === 'true';
    if (shouldSynthesize || (process.env.ELEVENLABS_API_KEY && !isTestRunner())) {
      try {
        const synthResult = await VoiceInterface.synthesizeSpokenAudio({
          tenant_id: session.tenant_id,
          project_id: session.project_id,
          speaker_ref: session.speaker_ref,
          text: response.reply_text,
          conversation_id: response.conversation_id,
          correlation_id: response.correlation_id,
          record_delivery: false,
        });
        if (synthResult?.audio_id) {
          audioUrl = `/api/v1/voice/audio/${synthResult.audio_id}`;
        }
      } catch (synthErr: any) {
        Logger.info(`Web voice synthesis skipped: ${synthErr.message}`);
      }
    }

    const payload = {
      ...response,
      audio_url: audioUrl || response.media_url || null,
    };

    const history = webMessages.get(session.token) || [];
    history.push({ id: envelope.correlation_id, role: 'user', text: envelope.text, media: envelope.media, created_at: new Date().toISOString() });
    history.push({ id: `${envelope.correlation_id}_reply`, role: 'assistant', text: response.reply_text, media: response.media_url ? [response.media_url] : [], audio_url: audioUrl, created_at: new Date().toISOString() } as any);
    webMessages.set(session.token, history);
    res.status(200).json(payload);
  } catch (err: any) {
    Logger.error(`Web interface handling error: ${err.message}`);
    res.status(err.message.includes('not enabled') ? 403 : 500).json({ error: 'WEB_INTERFACE_ERROR', message: err.message });
  }
});

webInterfaceRouter.post('/api/v1/web/speak', async (req: Request, res: Response) => {
  try {
    const session = await getSession(req);
    if (!session) { res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid web session is required.' }); return; }
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing required parameter: text' });
      return;
    }

    const synthResult = await VoiceInterface.synthesizeSpokenAudio({
      tenant_id: session.tenant_id,
      project_id: session.project_id,
      speaker_ref: session.speaker_ref,
      text: text.trim(),
      record_delivery: false,
    });

    res.status(200).json({
      audio_id: synthResult.audio_id,
      audio_url: `/api/v1/voice/audio/${synthResult.audio_id}`,
      mime_type: synthResult.mime_type,
      voice_id: synthResult.voice_id,
      audio_bytes: synthResult.audio_bytes,
    });
  } catch (err: any) {
    Logger.error(`Web speak endpoint failed: ${err.message}`);
    res.status(502).json({ error: 'VOICE_SYNTHESIS_FAILED', message: err.message });
  }
});

webInterfaceRouter.get('/api/v1/web/history', async (req: Request, res: Response) => {
  const session = await getSession(req);
  if (!session) { res.status(401).json({ error: 'INVALID_SESSION' }); return; }
  res.json({ messages: webMessages.get(session.token) || [] });
});

webInterfaceRouter.post('/api/v1/web/logout', (req: Request, res: Response) => {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.header('x-cst-session') || cookieValue(req, 'cst_web_session');
  if (token) { sessions.delete(token); webMessages.delete(token); }
  res.setHeader('Set-Cookie', 'cst_web_session=; Max-Age=0; Path=/');
  res.status(204).send();
});

export class WebInterface {
  static async handleWebEnvelope(envelope: MessageEnvelope, session?: WebSession): Promise<EnvelopeResponse> {
    if (envelope.channel !== 'web') throw new Error(`WebInterface received non-web envelope channel: ${envelope.channel}`);
    const project = CoreRegistry.getProject(envelope.project_id);
    if (!project || !project.capabilities.web) {
      Logger.audit({ timestamp: new Date().toISOString(), tenant_id: envelope.tenant_id, actor: envelope.speaker_ref, role: 'untrusted_ingress', entry_point: 'api', tool_or_route: 'WebInterface.handleWebEnvelope', outcome: 'refused', reason: `Web capability is disabled for project ${envelope.project_id}`, correlation_id: envelope.correlation_id });
      throw new Error(`Web capability is not enabled for project "${envelope.project_id}"`);
    }

    let speaker: any;
    if (session && (session.farm_ids.length > 0 || session.speaker_ref.includes('@'))) {
      const baseSpeaker = await CoreRegistry.resolveSpeaker({
        tenantId: envelope.tenant_id,
        projectId: envelope.project_id,
        phoneE164: session.speaker_ref.startsWith('+') ? session.speaker_ref : '+10000000000',
      }).catch(() => null);

      speaker = {
        person_id: baseSpeaker?.person_id || session.speaker_ref,
        customer_ref: baseSpeaker?.customer_ref || session.speaker_ref,
        tenant_id: session.tenant_id,
        project_id: session.project_id,
        phone_e164: session.speaker_ref.startsWith('+') ? session.speaker_ref : (baseSpeaker?.phone_e164 || '+10000000000'),
        is_known: true,
        role: (session.role as any) || baseSpeaker?.role || 'owner',
        permissions: baseSpeaker?.permissions?.length ? baseSpeaker.permissions : ['read', 'status', 'chat', 'query'],
        farm_ids: session.farm_ids.length > 0 ? [...session.farm_ids] : (baseSpeaker?.farm_ids || []),
        unit_context: {
          farm_id: session.farm_ids[0] || baseSpeaker?.farm_ids?.[0],
          granted_farms: session.farm_ids.length > 0 ? session.farm_ids : (baseSpeaker?.farm_ids || []),
          role: session.role || baseSpeaker?.role || 'owner',
        },
      };
    } else {
      speaker = await CoreRegistry.resolveSpeaker({ tenantId: envelope.tenant_id, projectId: envelope.project_id, phoneE164: envelope.speaker_ref });
    }

    return CoreEngine.processEnvelope(envelope, speaker);
  }
}

