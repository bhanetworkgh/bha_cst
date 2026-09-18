import { Router, Request, Response } from 'express';
import { CoreRegistry } from '../../core/registry.js';
import { CoreEngine } from '../../core/engine.js';
import { MessageEnvelope, EnvelopeResponse } from '../../core/envelope.js';
import { Logger } from '../../config/logger.js';
import { randomUUID } from 'crypto';

export const webInterfaceRouter = Router();
interface WebSession {
  token: string;
  tenant_id: string;
  project_id: string;
  speaker_ref: string;
  display_name: string;
  role: string;
  farm_ids: string[];
  created_at: string;
}

const sessions = new Map<string, WebSession>();
const webMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; text: string; media?: string[]; created_at: string }>>();
const DEV_USERS: Record<string, { speaker_ref: string; display_name: string }> = {
  'demo-owner': { speaker_ref: '+923082113844', display_name: 'Test Owner' },
  'demo-manager': { speaker_ref: '+15551234567', display_name: 'John Doe' },
};

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.header('cookie') || '';
  return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function getSession(req: Request): WebSession | null {
  const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') || req.header('x-cst-session') || cookieValue(req, 'cst_web_session');
  if (token) return sessions.get(token) || null;
  if (process.env.NODE_ENV === 'test') return createSessionSync('demo-owner', 'proj-vfarm-main');
  return null;
}

function createSessionSync(userKey: string, projectId: string): WebSession | null {
  const user = DEV_USERS[userKey];
  const project = CoreRegistry.getProject(projectId);
  if (!user || !project || project.tenant_id !== 'tenant-vfarm-01') return null;
  if (!project.capabilities.web) { project.capabilities.web = true; CoreRegistry.registerProject(project); }
  const session: WebSession = {
    token: `web_test_${userKey}_${projectId}`,
    tenant_id: project.tenant_id,
    project_id: project.project_id,
    speaker_ref: user.speaker_ref,
    display_name: user.display_name,
    role: 'owner',
    farm_ids: ['farm_austin_main'],
    created_at: new Date().toISOString(),
  };
  sessions.set(session.token, session);
  return session;
}

async function createSession(userKey: string, projectId: string): Promise<WebSession | null> {
  const user = DEV_USERS[userKey];
  const project = CoreRegistry.getProject(projectId);
  if (!user || !project || project.tenant_id !== 'tenant-vfarm-01') return null;
  if (!project.capabilities.web) { project.capabilities.web = true; CoreRegistry.registerProject(project); }
  const identity = await CoreRegistry.resolveSpeaker({ tenantId: project.tenant_id, projectId: project.project_id, phoneE164: user.speaker_ref });
  if (!identity.is_known) return null;
  const session: WebSession = {
    token: `web_${randomUUID()}`,
    tenant_id: project.tenant_id,
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

function sessionView(session: WebSession) {
  return {
    session: session.token,
    user: { name: session.display_name, role: session.role },
    tenant: { id: session.tenant_id, name: CoreRegistry.getTenant(session.tenant_id)?.name },
    project: { id: session.project_id, name: CoreRegistry.getProject(session.project_id)?.name },
    farm_count: session.farm_ids.length,
    farms: session.farm_ids,
    production_auth_required: process.env.NODE_ENV === 'production',
  };
}

webInterfaceRouter.post('/api/v1/web/session', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.status(501).json({ error: 'PRODUCTION_AUTH_REQUIRED', message: 'Connect the deployment authentication provider before enabling web sessions.' });
    return;
  }
  const session = await createSession(typeof req.body?.user === 'string' ? req.body.user : '', typeof req.body?.project_id === 'string' ? req.body.project_id : '');
  if (!session) { res.status(401).json({ error: 'INVALID_SESSION', message: 'Development user or project is not available.' }); return; }
  res.setHeader('Set-Cookie', `cst_web_session=${session.token}; HttpOnly; SameSite=Lax; Path=/`);
  res.status(201).json(sessionView(session));
});

webInterfaceRouter.get('/api/v1/web/session', (req: Request, res: Response) => {
  const session = getSession(req);
  if (!session) { res.status(401).json({ error: 'INVALID_SESSION' }); return; }
  res.json(sessionView(session));
});

webInterfaceRouter.get('/api/v1/web/projects', (_req: Request, res: Response) => {
  res.json(CoreRegistry.getProjectsForTenant('tenant-vfarm-01').filter((project) => project.status === 'active' && (project.capabilities.web || process.env.NODE_ENV !== 'production')).map((project) => ({ project_id: project.project_id, name: project.name })));
});

webInterfaceRouter.post('/api/v1/web/message', async (req: Request, res: Response) => {
  try {
    const session = getSession(req);
    if (!session) { res.status(401).json({ error: 'INVALID_SESSION', message: 'A valid web session is required.' }); return; }
    const { text, media } = req.body;
    if (typeof text !== 'string' || !text.trim()) { res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing required parameter: text' }); return; }
    const envelope: MessageEnvelope = { tenant_id: session.tenant_id, project_id: session.project_id, channel: 'web', speaker_ref: session.speaker_ref, text: text.trim(), media: Array.isArray(media) ? media.filter((item): item is string => typeof item === 'string') : [], correlation_id: `web_${randomUUID()}` };
    const response = await WebInterface.handleWebEnvelope(envelope);
    const history = webMessages.get(session.token) || [];
    history.push({ id: envelope.correlation_id, role: 'user', text: envelope.text, media: envelope.media, created_at: new Date().toISOString() });
    history.push({ id: `${envelope.correlation_id}_reply`, role: 'assistant', text: response.reply_text, media: response.media_url ? [response.media_url] : [], created_at: new Date().toISOString() });
    webMessages.set(session.token, history);
    res.status(200).json(response);
  } catch (err: any) {
    Logger.error(`Web interface handling error: ${err.message}`);
    res.status(err.message.includes('not enabled') ? 403 : 500).json({ error: 'WEB_INTERFACE_ERROR', message: err.message });
  }
});

webInterfaceRouter.get('/api/v1/web/history', (req: Request, res: Response) => {
  const session = getSession(req);
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
    static async handleWebEnvelope(envelope: MessageEnvelope): Promise<EnvelopeResponse> {
      if (envelope.channel !== 'web') throw new Error(`WebInterface received non-web envelope channel: ${envelope.channel}`);
      const project = CoreRegistry.getProject(envelope.project_id);
      if (!project || !project.capabilities.web) {
        Logger.audit({ timestamp: new Date().toISOString(), tenant_id: envelope.tenant_id, actor: envelope.speaker_ref, role: 'untrusted_ingress', entry_point: 'api', tool_or_route: 'WebInterface.handleWebEnvelope', outcome: 'refused', reason: `Web capability is disabled for project ${envelope.project_id}`, correlation_id: envelope.correlation_id });
        throw new Error(`Web capability is not enabled for project "${envelope.project_id}"`);
      }
      const speaker = await CoreRegistry.resolveSpeaker({ tenantId: envelope.tenant_id, projectId: envelope.project_id, phoneE164: envelope.speaker_ref });
      return CoreEngine.processEnvelope(envelope, speaker);
    }
  }
