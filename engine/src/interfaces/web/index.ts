import { Router, Request, Response } from 'express';
import { CoreRegistry } from '../../core/registry.js';
import { CoreEngine } from '../../core/engine.js';
import { MessageEnvelope, EnvelopeResponse } from '../../core/envelope.js';
import { Logger } from '../../config/logger.js';
import { randomUUID } from 'crypto';

export const webInterfaceRouter = Router();

export class WebInterface {
  static async handleWebEnvelope(envelope: MessageEnvelope): Promise<EnvelopeResponse> {
    if (envelope.channel !== 'web') {
      throw new Error(`WebInterface received non-web envelope channel: ${envelope.channel}`);
    }

    const project = CoreRegistry.getProject(envelope.project_id);
    if (!project || !project.capabilities.web) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: envelope.tenant_id,
        actor: envelope.speaker_ref,
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'WebInterface.handleWebEnvelope',
        outcome: 'refused',
        reason: `Web capability is disabled for project ${envelope.project_id}`,
        correlation_id: envelope.correlation_id,
      });
      throw new Error(`Web capability is not enabled for project "${envelope.project_id}"`);
    }

    // Resolve speaker
    const speaker = await CoreRegistry.resolveSpeaker({
      tenantId: envelope.tenant_id,
      projectId: envelope.project_id,
      phoneE164: envelope.speaker_ref,
    });

    // Process through Core Engine
    return await CoreEngine.processEnvelope(envelope, speaker);
  }
}

// REST endpoint for Web Chat Ingress
webInterfaceRouter.post('/api/v1/web/message', async (req: Request, res: Response) => {
  try {
    const { tenant_id, project_id, speaker_ref, text, media } = req.body;

    if (!tenant_id || !project_id || !text) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'Missing required parameters: tenant_id, project_id, text',
      });
      return;
    }

    const envelope: MessageEnvelope = {
      tenant_id,
      project_id,
      channel: 'web',
      speaker_ref: speaker_ref || 'web_anonymous_user',
      text,
      media: media || [],
      correlation_id: `web_${randomUUID()}`,
    };

    const response = await WebInterface.handleWebEnvelope(envelope);
    res.status(200).json(response);
  } catch (err: any) {
    Logger.error(`Web interface handling error: ${err.message}`);
    res.status(err.message.includes('not enabled') ? 403 : 500).json({
      error: 'WEB_INTERFACE_ERROR',
      message: err.message,
    });
  }
});
