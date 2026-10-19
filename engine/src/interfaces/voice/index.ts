import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CoreRegistry } from '../../core/registry.js';
import { CoreEngine } from '../../core/engine.js';
import { MessageEnvelope, EnvelopeResponse } from '../../core/envelope.js';
import { SpeakerIdentity } from '../../core/types.js';
import { DbClient, VoiceDeliveryRecord } from '../../db/client.js';
import { Logger } from '../../config/logger.js';
import { AlertAuditLog } from '../../audit/alert_audit.js';
import {
  AudioSynthesizer,
  createElevenLabsAudioSynthesizer,
  DEFAULT_MIME_TYPE,
} from '../../audio/synthesis.js';
import { VoiceLaneService } from '../../transport/voice/voice_lane.js';
import { verifyTwilioSignature } from '../../transport/twilio/signature.js';

export const voiceInterfaceRouter = Router();

export interface VoiceSynthesizeRequest {
  tenant_id: string;
  project_id: string;
  speaker_ref: string;
  text: string;
  conversation_id?: string;
  correlation_id?: string;
  voice_id?: string;
  model_id?: string;
}

export interface ProcessVoiceTurnInput {
  from_e164: string;
  to_e164: string;
  speech_text: string;
  correlation_id?: string;
  call_sid?: string;
}

export interface VoiceTurnResult {
  status: 'synthesized' | 'refused' | 'dropped' | 'failed';
  text?: string;
  audioBase64?: string;
  mimeType?: string;
  voice_id?: string;
  reason?: string;
  error?: string;
  correlation_id: string;
  conversation_id?: string;
  message_id?: string;
  tenant_id?: string;
  project_id?: string;
  httpStatus?: number;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Voice Channel Interface
 * Handles Twilio Voice ingress, multi-tenant DID/project resolution,
 * speaker authorization, CST core envelope dispatch, project-scoped TTS synthesis,
 * and call status lifecycle management.
 */
export class VoiceInterface {
  private static mockSynthesizer: AudioSynthesizer | null = null;

  static setSynthesizer(synth: AudioSynthesizer | null): void {
    this.mockSynthesizer = synth;
  }

  static getSynthesizer(): AudioSynthesizer {
    if (this.mockSynthesizer) return this.mockSynthesizer;
    return VoiceLaneService.getSynthesizer();
  }

  private static async getAdapterHealthFailure(tenantId: string): Promise<string | null> {
    const adapter = CoreRegistry.getAdapter(tenantId);
    if (!adapter) {
      return `No tenant adapter registered for tenant ${tenantId}`;
    }

    if (!adapter.getHealth) {
      return null;
    }

    try {
      const health = await adapter.getHealth(tenantId);
      if (health.status !== 'healthy') {
        return `Tenant adapter health is ${health.status}`;
      }
    } catch (err: any) {
      return `Tenant adapter health check failed: ${err.message}`;
    }

    return null;
  }

  /**
   * Process an inbound voice transcript / message envelope.
   */
  static async handleVoiceEnvelope(envelope: MessageEnvelope): Promise<EnvelopeResponse> {
    if (envelope.channel !== 'voice') {
      throw new Error(`VoiceInterface received non-voice envelope channel: ${envelope.channel}`);
    }

    const project = CoreRegistry.getProject(envelope.project_id);
    if (!project || !project.capabilities.voice) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: envelope.tenant_id,
        actor: envelope.speaker_ref,
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.handleVoiceEnvelope',
        outcome: 'refused',
        reason: `Voice capability is disabled for project ${envelope.project_id}`,
        correlation_id: envelope.correlation_id,
      });
      throw new Error(`Voice capability is disabled for project "${envelope.project_id}"`);
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

  /**
   * Process an interactive voice turn through the CST Core multi-tenant pipeline.
   */
  static async processVoiceTurn(input: ProcessVoiceTurnInput): Promise<VoiceTurnResult> {
    const correlation_id = input.correlation_id || input.call_sid || `voice_${randomUUID()}`;
    const from_e164 = (input.from_e164 || '').trim();
    const to_e164 = (input.to_e164 || '').trim();
    const speech_text = (input.speech_text || '').trim();

    if (!to_e164) {
      return {
        status: 'refused',
        reason: 'Missing receiving To number',
        correlation_id,
        httpStatus: 400,
        error: 'BAD_REQUEST',
      };
    }

    // 1. Resolve receiving DID via service_number_bindings
    const binding = CoreRegistry.resolveServiceNumber(to_e164);
    if (!binding) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: null,
        actor: from_e164 || 'unknown_caller',
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'refused',
        reason: `Unknown or unbound receiving service number ${to_e164}`,
        correlation_id,
      });
      return {
        status: 'refused',
        reason: `Unknown or unbound receiving service number ${to_e164}`,
        correlation_id,
        httpStatus: 404,
        error: 'SYSTEM_NOT_FOUND',
      };
    }

    // 2. Check capability
    if (binding.capability !== 'voice') {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: from_e164 || 'unknown_caller',
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'refused',
        reason: `Service number ${to_e164} is bound to capability "${binding.capability}", not "voice"`,
        correlation_id,
      });
      return {
        status: 'refused',
        reason: 'Service number is not enabled for Voice',
        correlation_id,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 404,
        error: 'CAPABILITY_DISABLED',
      };
    }

    const project = CoreRegistry.getProject(binding.project_id);
    if (!project || !project.capabilities.voice) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: from_e164 || 'unknown_caller',
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'refused',
        reason: `Voice capability disabled for project ${binding.project_id}`,
        correlation_id,
      });
      return {
        status: 'refused',
        reason: 'Voice capability is disabled for this project',
        correlation_id,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 404,
        error: 'CAPABILITY_DISABLED',
      };
    }

    // 3. Resolve caller speaker identity via Tenant Adapter (Fail-closed on degraded adapter)
    const adapterHealthFailure = await this.getAdapterHealthFailure(binding.tenant_id);
    if (adapterHealthFailure) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: from_e164,
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'error',
        reason: `Speaker resolve failed for tenant ${binding.tenant_id} (degraded): ${adapterHealthFailure}`,
        correlation_id,
        details: { tripwire: true },
      });

      await DbClient.recordVoiceDelivery({
        system_id: binding.project_id,
        project_id: binding.project_id,
        tenant_id: binding.tenant_id,
        status: 'failed',
        character_count: 0,
        audio_bytes: 0,
        error_code: 'ADAPTER_DEGRADED',
        error_message: adapterHealthFailure,
        correlation_id,
      });

      return {
        status: 'refused',
        reason: 'Tenant adapter unavailable (degraded state)',
        error: 'SERVICE_UNAVAILABLE',
        correlation_id,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 403,
      };
    }

    const speaker = await CoreRegistry.resolveSpeaker({
      tenantId: binding.tenant_id,
      projectId: binding.project_id,
      phoneE164: from_e164,
    });

    const isGuest = !speaker.is_known || speaker.role === 'unknown';
    const activeSpeaker: SpeakerIdentity = isGuest
      ? {
          person_id: speaker.person_id || `guest_${from_e164.replace(/[^0-9]/g, '')}`,
          customer_ref: speaker.customer_ref || `guest_${from_e164.replace(/[^0-9]/g, '')}`,
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          phone_e164: from_e164,
          is_known: false,
          role: 'unknown',
          permissions: [],
          farm_ids: [],
        }
      : speaker;

    if (isGuest) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: from_e164 || 'unknown_caller',
        role: 'guest',
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'ok',
        reason: `Guest caller ${from_e164} processing voice turn for project ${binding.project_id} under least-privilege policy`,
        correlation_id,
        details: {
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          guest_access: true,
        },
      });
    }

    // 4. Construct uniform MessageEnvelope
    const envelope: MessageEnvelope = {
      tenant_id: binding.tenant_id,
      project_id: binding.project_id,
      channel: 'voice',
      speaker_ref: activeSpeaker.customer_ref || from_e164,
      text: speech_text,
      media: [],
      correlation_id,
      metadata: {
        service_number: to_e164,
        call_sid: input.call_sid,
      },
    };

    // 5. Send through CST Core Engine
    let engineResponse: EnvelopeResponse;
    try {
      engineResponse = await CoreEngine.processEnvelope(envelope, activeSpeaker);
    } catch (coreErr: any) {
      Logger.error(`Voice turn CoreEngine error: ${coreErr.message}`, { correlation_id });
      await DbClient.recordVoiceDelivery({
        system_id: binding.project_id,
        project_id: binding.project_id,
        tenant_id: binding.tenant_id,
        status: 'failed',
        character_count: 0,
        audio_bytes: 0,
        error_code: 'ROUTING_FAILED',
        error_message: coreErr.message,
        correlation_id,
      });

      return {
        status: 'failed',
        reason: 'Internal voice routing error',
        error: 'ROUTING_FAILED',
        correlation_id,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 500,
      };
    }

    const conversationId = engineResponse.conversation_id || (engineResponse.metadata?.conversation_id as string | undefined);

    // 6. Fail-closed: Check if CST core refused text or authorization
    const isRefused =
      engineResponse.status === 'refused' ||
      engineResponse.status === 'step_up_required' ||
      engineResponse.reply_text.includes('not authorized') ||
      engineResponse.reply_text.includes('restricted to the Organization Admin Panel') ||
      engineResponse.reply_text.includes('step-up') ||
      engineResponse.reply_text.includes('require step-up authentication') ||
      engineResponse.reply_text.includes('not granted any active farm resources') ||
      engineResponse.reply_text.includes('You do not have access to queries for');

    if (isRefused) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: activeSpeaker.customer_ref || from_e164,
        role: activeSpeaker.role,
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'refused',
        reason: `Spoken response refused because CST authorization chain refused text: ${engineResponse.reply_text}`,
        correlation_id,
      });

      await DbClient.recordVoiceDelivery({
        system_id: binding.project_id,
        project_id: binding.project_id,
        tenant_id: binding.tenant_id,
        conversation_id: conversationId,
        status: 'refused',
        character_count: engineResponse.reply_text.length,
        audio_bytes: 0,
        error_code: 'AUTHORIZATION_REFUSED',
        error_message: engineResponse.reply_text,
        correlation_id,
      });

      return {
        status: 'refused',
        reason: engineResponse.reply_text,
        text: engineResponse.reply_text,
        error: 'AUTHORIZATION_REFUSED',
        correlation_id,
        conversation_id: conversationId,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 403,
      };
    }

    // 7. Resolve project-level ElevenLabs voice pointer (Strict Project Isolation)
    const voiceId = project.elevenlabs_voice_id?.trim();
    if (!voiceId) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: speaker.customer_ref || from_e164,
        role: speaker.role,
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'refused',
        reason: `Voice turn dropped: No voice clone pointer configured for project ${binding.project_id}. Strictly refuse generic voice substitution.`,
        correlation_id,
      });

      await DbClient.recordVoiceDelivery({
        system_id: binding.project_id,
        project_id: binding.project_id,
        tenant_id: binding.tenant_id,
        conversation_id: conversationId,
        status: 'refused',
        character_count: engineResponse.reply_text.length,
        audio_bytes: 0,
        error_code: 'NO_VOICE_POINTER',
        error_message: `Project ${binding.project_id} voice pointer not configured`,
        correlation_id,
      });

      return {
        status: 'dropped',
        reason: `Voice clone not configured for project ${binding.project_id}; generic voice fallback is forbidden`,
        error: 'NO_VOICE_POINTER',
        correlation_id,
        conversation_id: conversationId,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 422,
      };
    }

    // 8. Synthesize speech via ElevenLabs
    let synthResult: {
      audio_buffer: Buffer;
      mime_type: string;
      voice_id: string;
      character_count: number;
      audio_bytes: number;
    };

    try {
      synthResult = await this.synthesizeSpokenAudio({
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        speaker_ref: from_e164,
        text: engineResponse.reply_text,
        conversation_id: conversationId,
        correlation_id,
        voice_id: voiceId,
        model_id: project.elevenlabs_model_id,
      });
    } catch (synthErr: any) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: speaker.customer_ref || from_e164,
        role: speaker.role,
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'error',
        reason: `ElevenLabs synthesis failed: ${synthErr.message}. Turn dropped.`,
        correlation_id,
      });

      return {
        status: 'failed',
        reason: 'ElevenLabs synthesis failed; turn dropped',
        error: 'SYNTHESIS_FAILED',
        correlation_id,
        conversation_id: conversationId,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 502,
      };
    }

    // 9. Alert Audit Log & Conversation Transcripts
    await AlertAuditLog.write(
      correlation_id,
      binding.tenant_id,
      engineResponse.reply_text,
      {
        template_id: 'voice_clone_tts',
        version: '1.0.0',
        params: {
          channel: 'voice',
          project_id: binding.project_id,
          voice_id: voiceId,
          model_id: project.elevenlabs_model_id,
          audio_bytes: synthResult.audio_bytes,
          mime_type: synthResult.mime_type,
          correlation_id,
        },
      },
      binding.tenant_id
    );

    const messageId = `vmsg_out_${randomUUID()}`;
    if (conversationId) {
      try {
        await DbClient.addMessageToTranscript({
          message_id: messageId,
          conversation_id: conversationId,
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          direction: 'outbound',
          from_e164: to_e164,
          to_e164: from_e164,
          body: engineResponse.reply_text,
          media_refs: [`voice:elevenlabs:${voiceId}`],
          provider_sid: correlation_id,
        });
      } catch (transcriptErr: any) {
        Logger.warn(`Failed to append voice message to transcript: ${transcriptErr.message}`);
      }
    }

    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: binding.tenant_id,
      actor: speaker.customer_ref || from_e164,
      role: speaker.role,
      entry_point: 'api',
      tool_or_route: 'VoiceInterface.processVoiceTurn',
      outcome: 'ok',
      reason: `Spoken response synthesized successfully via ElevenLabs (voice_id: ${voiceId}, bytes: ${synthResult.audio_bytes}) for project ${binding.project_id}`,
      correlation_id,
    });

    return {
      status: 'synthesized',
      text: engineResponse.reply_text,
      audioBase64: synthResult.audio_buffer.toString('base64'),
      mimeType: synthResult.mime_type,
      voice_id: voiceId,
      correlation_id,
      conversation_id: conversationId,
      message_id: messageId,
      tenant_id: binding.tenant_id,
      project_id: binding.project_id,
      httpStatus: 200,
    };
  }

  /**
   * Synthesize spoken audio for a project response using project-level ElevenLabs pointer.
   */
  static async synthesizeSpokenAudio(req: VoiceSynthesizeRequest): Promise<{
    audio_buffer: Buffer;
    mime_type: string;
    voice_id: string;
    character_count: number;
    audio_bytes: number;
  }> {
    const project = CoreRegistry.getProject(req.project_id);
    const voiceId = req.voice_id || project?.elevenlabs_voice_id;
    const modelId = req.model_id || project?.elevenlabs_model_id || process.env.ELEVENLABS_MODEL_ID;

    if (!voiceId) {
      const err = new Error(`No ElevenLabs voice_id configured for project ${req.project_id}`);
      await DbClient.recordVoiceDelivery({
        system_id: req.project_id,
        project_id: req.project_id,
        tenant_id: req.tenant_id,
        conversation_id: req.conversation_id,
        status: 'refused',
        error_code: 'NO_VOICE_POINTER',
        error_message: err.message,
        character_count: req.text.length,
        audio_bytes: 0,
        correlation_id: req.correlation_id,
      });
      throw err;
    }

    try {
      const synthesizer = this.mockSynthesizer || (VoiceLaneService as any).defaultSynthesizer || createElevenLabsAudioSynthesizer({
        defaultVoiceId: voiceId,
        modelId,
      });

      const result = await synthesizer.synthesize({
        text: req.text,
        voiceId,
        modelId,
      });

      const audioBuffer = Buffer.from(result.audioBase64, 'base64');

      // Record voice delivery for 24h health tracking
      await DbClient.recordVoiceDelivery({
        system_id: req.project_id,
        project_id: req.project_id,
        tenant_id: req.tenant_id,
        conversation_id: req.conversation_id,
        status: 'synthesized',
        voice_id: voiceId,
        model_id: modelId,
        character_count: req.text.length,
        audio_bytes: audioBuffer.length,
        mime_type: result.mimeType || DEFAULT_MIME_TYPE,
        correlation_id: req.correlation_id,
        delivered_at: new Date().toISOString(),
      });

      return {
        audio_buffer: audioBuffer,
        mime_type: result.mimeType || DEFAULT_MIME_TYPE,
        voice_id: voiceId,
        character_count: req.text.length,
        audio_bytes: audioBuffer.length,
      };
    } catch (err: any) {
      await DbClient.recordVoiceDelivery({
        system_id: req.project_id,
        project_id: req.project_id,
        tenant_id: req.tenant_id,
        conversation_id: req.conversation_id,
        status: 'failed',
        voice_id: voiceId,
        model_id: modelId,
        error_code: 'SYNTHESIS_FAILED',
        error_message: err.message,
        character_count: req.text.length,
        audio_bytes: 0,
        correlation_id: req.correlation_id,
      });
      throw err;
    }
  }

  /**
   * Twilio Inbound Voice Webhook Handler
   */
  static async handleInboundCall(req: Request, res: Response): Promise<void> {
    try {
      const receivingNumber = ((req.body?.To as string) || '').trim();
      const callerNumber = ((req.body?.From as string) || '').trim();
      const callSid = req.body?.CallSid || `call_${randomUUID()}`;

      if (!receivingNumber) {
        res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing receiving To number' });
        return;
      }

      // 1. Resolve DID
      const binding = CoreRegistry.resolveServiceNumber(receivingNumber);
      if (!binding) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: null,
          actor: 'twilio_voice_webhook',
          role: 'untrusted_ingress',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'refused',
          reason: `Unknown or unbound receiving service number ${receivingNumber}`,
          correlation_id: callSid,
        });
        res.status(404).json({ error: 'SYSTEM_NOT_FOUND', message: 'Unknown or unbound receiving number' });
        return;
      }

      // 2. Capability check
      if (binding.capability !== 'voice') {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: binding.tenant_id,
          actor: 'twilio_voice_webhook',
          role: 'untrusted_ingress',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'refused',
          reason: `Service number ${receivingNumber} is bound to capability "${binding.capability}", not "voice"`,
          correlation_id: callSid,
        });
        res.status(404).json({ error: 'CAPABILITY_DISABLED', message: 'Service number is not enabled for Voice' });
        return;
      }

      const project = CoreRegistry.getProject(binding.project_id);
      if (!project || !project.capabilities.voice) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: binding.tenant_id,
          actor: 'twilio_voice_webhook',
          role: 'untrusted_ingress',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'refused',
          reason: `Voice capability disabled for project ${binding.project_id}`,
          correlation_id: callSid,
        });
        res.status(404).json({ error: 'CAPABILITY_DISABLED', message: 'Voice capability is disabled for this project' });
        return;
      }

      // 3. Tenancy anti-tamper check
      if (req.body && typeof req.body === 'object' && req.body.tenant_id && req.body.tenant_id !== binding.tenant_id) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: binding.tenant_id,
          actor: 'twilio_voice_webhook',
          role: 'untrusted_ingress',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'refused',
          reason: `Cross-tenant payload mismatch: body tenant_id (${req.body.tenant_id}) !== resolved (${binding.tenant_id})`,
          correlation_id: callSid,
        });
        res.status(403).json({
          error: 'TENANT_SCOPE_VIOLATION',
          message: 'Client-provided tenant_id overrides are strictly forbidden',
        });
        return;
      }

      // 4. Resolve Speaker via Tenant Adapter (Fail closed on degraded adapter)
      const adapterHealthFailure = await this.getAdapterHealthFailure(binding.tenant_id);
      if (adapterHealthFailure) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: binding.tenant_id,
          actor: callerNumber,
          role: 'untrusted_ingress',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'error',
          reason: `Speaker resolve failed for tenant ${binding.tenant_id} (degraded): ${adapterHealthFailure}`,
          correlation_id: callSid,
          details: { tripwire: true },
        });
        res.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'Tenant adapter unavailable (degraded state)' });
        return;
      }

      let speaker: SpeakerIdentity;
      try {
        speaker = await CoreRegistry.resolveSpeaker({
          tenantId: binding.tenant_id,
          projectId: binding.project_id,
          phoneE164: callerNumber,
        });
      } catch (err: any) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: binding.tenant_id,
          actor: callerNumber,
          role: 'untrusted_ingress',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'error',
          reason: `Speaker resolve failed for tenant ${binding.tenant_id} (degraded): ${err.message}`,
          correlation_id: callSid,
          details: { tripwire: true },
        });
        res.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'Tenant adapter unavailable (degraded state)' });
        return;
      }

      // Inbound entry policy: Allow unregistered/unknown callers to enter voice flow as guest with least privilege
      const isGuest = !speaker.is_known || speaker.role === 'unknown';
      if (isGuest) {
        speaker = {
          person_id: speaker.person_id || `guest_${callerNumber.replace(/[^0-9]/g, '')}`,
          customer_ref: speaker.customer_ref || `guest_${callerNumber.replace(/[^0-9]/g, '')}`,
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          phone_e164: callerNumber,
          is_known: false,
          role: 'unknown',
          permissions: [],
          farm_ids: [],
        };

        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: binding.tenant_id,
          actor: callerNumber || 'unknown_caller',
          role: 'guest',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'ok',
          reason: `Guest caller ${callerNumber} admitted to voice flow for project ${binding.project_id} under least-privilege policy`,
          correlation_id: callSid,
          details: {
            tenant_id: binding.tenant_id,
            project_id: binding.project_id,
            guest_access: true,
          },
        });
      }

      // 5. If speech turn included in inbound call (e.g. testing or immediate SpeechResult)
      const speechText = ((req.body?.SpeechResult || req.body?.speech_text || req.body?.Body || '') as string).trim();
      if (speechText) {
        const turnResult = await this.processVoiceTurn({
          from_e164: callerNumber,
          to_e164: receivingNumber,
          speech_text: speechText,
          correlation_id: callSid,
          call_sid: callSid,
        });

        res.setHeader('X-Tenant-Id', binding.tenant_id);
        res.setHeader('X-Project-Id', binding.project_id);
        res.status(turnResult.httpStatus || 200).json(turnResult);
        return;
      }

      // 6. Initial call answer: record event & prompt for speech
      await DbClient.recordVoiceDelivery({
        system_id: binding.project_id,
        project_id: binding.project_id,
        tenant_id: binding.tenant_id,
        status: 'synthesized',
        character_count: 0,
        audio_bytes: 0,
        correlation_id: callSid,
        delivered_at: new Date().toISOString(),
      });

      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: callerNumber || 'twilio_voice_webhook',
        role: speaker.is_known ? speaker.role : 'guest',
        entry_point: 'webhook',
        tool_or_route: req.originalUrl || req.path,
        outcome: 'ok',
        reason: `Inbound voice call answered for project ${binding.project_id}`,
        correlation_id: callSid,
      });

      const greeting = project.onboarding_reply || 'Welcome to Customer Service Twin. How can I assist you today?';
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST">\n    <Say>${escapeXml(greeting)}</Say>\n  </Gather>\n</Response>`;

      res.setHeader('X-Tenant-Id', binding.tenant_id);
      res.setHeader('X-Project-Id', binding.project_id);
      res.setHeader('X-Call-Sid', callSid);

      const wantsXml = req.headers.accept?.includes('text/xml') || req.headers.accept?.includes('application/xml');
      const wantsJson = !wantsXml && (req.headers.accept?.includes('application/json') || req.is('json') || (typeof req.headers['content-type'] === 'string' && req.headers['content-type'].includes('application/json')) || (typeof req.headers['content-type'] === 'string' && req.headers['content-type'].includes('application/x-www-form-urlencoded')));

      if (wantsJson) {
        res.status(200).json({
          status: 'initiated',
          call_sid: callSid,
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          greeting,
          twiml,
        });
      } else {
        res.setHeader('Content-Type', 'text/xml');
        res.status(200).send(twiml);
      }
    } catch (err: any) {
      Logger.error(`Twilio Voice inbound call error: ${err.message}`);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
    }
  }

  /**
   * Twilio Voice Turn Webhook Handler
   */
  static async handleSpeechTurnWebhook(req: Request, res: Response): Promise<void> {
    try {
      const receivingNumber = ((req.body?.To as string) || '').trim();
      const callerNumber = ((req.body?.From as string) || '').trim();
      const callSid = req.body?.CallSid || `turn_${randomUUID()}`;
      const speechText = ((req.body?.SpeechResult || req.body?.speech_text || req.body?.Body || '') as string).trim();

      const result = await this.processVoiceTurn({
        from_e164: callerNumber,
        to_e164: receivingNumber,
        speech_text: speechText,
        correlation_id: callSid,
        call_sid: callSid,
      });

      if (result.tenant_id) res.setHeader('X-Tenant-Id', result.tenant_id);
      if (result.project_id) res.setHeader('X-Project-Id', result.project_id);

      const httpStatus = result.httpStatus || (result.status === 'synthesized' ? 200 : result.status === 'refused' ? 403 : 502);

      const wantsXml = req.headers.accept?.includes('text/xml') || req.headers.accept?.includes('application/xml');
      const wantsJson = !wantsXml && (req.headers.accept?.includes('application/json') || req.is('json') || (typeof req.headers['content-type'] === 'string' && req.headers['content-type'].includes('application/json')) || (typeof req.headers['content-type'] === 'string' && req.headers['content-type'].includes('application/x-www-form-urlencoded')));

      if (wantsJson) {
        res.status(httpStatus).json(result);
        return;
      }

      if (result.status === 'synthesized') {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>${escapeXml(result.text || '')}</Say>\n  <Gather input="speech" action="/webhooks/twilio/voice/turn" method="POST"/>\n</Response>`;
        res.setHeader('Content-Type', 'text/xml');
        res.status(httpStatus).send(twiml);
      } else {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>${escapeXml(result.reason || 'Operation could not be completed.')}</Say>\n  <Hangup/>\n</Response>`;
        res.setHeader('Content-Type', 'text/xml');
        res.status(httpStatus).send(twiml);
      }
    } catch (err: any) {
      Logger.error(`Voice turn webhook failure: ${err.message}`);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
    }
  }

  /**
   * Programmatic API Voice Turn Handler
   */
  static async handleApiTurn(req: Request, res: Response): Promise<void> {
    try {
      const { from_e164, to_e164, speech_text, correlation_id } = req.body || {};
      if (!from_e164 || !to_e164 || !speech_text) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: 'from_e164, to_e164, and speech_text are required',
        });
        return;
      }

      const result = await this.processVoiceTurn({
        from_e164,
        to_e164,
        speech_text,
        correlation_id,
      });

      const httpStatus = result.httpStatus || (result.status === 'synthesized' ? 200 : result.status === 'refused' ? 403 : 502);
      res.status(httpStatus).json(result);
    } catch (err: any) {
      Logger.error(`API voice turn error: ${err.message}`);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
    }
  }

  /**
   * Call Lifecycle Status Events Handler
   */
  static async handleCallStatus(req: Request, res: Response): Promise<void> {
    try {
      const callSid = req.body?.CallSid || req.query?.CallSid || `call_${randomUUID()}`;
      const callStatus = (req.body?.CallStatus || req.query?.CallStatus || 'completed') as string;
      const receivingNumber = ((req.body?.To || req.query?.To || '') as string).trim();
      const callerNumber = ((req.body?.From || req.query?.From || '') as string).trim();

      // Reject client-supplied tenant/project in body (R-NUM-S4, §9)
      if (req.body && typeof req.body === 'object') {
        if (req.body.tenant_id || req.body.project_id) {
          Logger.audit({
            timestamp: new Date().toISOString(),
            tenant_id: null,
            actor: 'twilio_voice_lifecycle',
            role: 'untrusted_ingress',
            entry_point: 'webhook',
            tool_or_route: req.originalUrl || req.path,
            outcome: 'refused',
            reason: `Client-supplied tenant_id/project_id in call status webhook is forbidden`,
            correlation_id: callSid,
          });
          res.status(403).json({
            error: 'TENANT_SCOPE_VIOLATION',
            message: 'Client-provided tenant_id/project_id in status webhook is strictly forbidden',
          });
          return;
        }
      }

      let tenantId: string = '';
      let projectId: string = '';

      if (receivingNumber) {
        const binding = CoreRegistry.resolveServiceNumber(receivingNumber);
        if (binding) {
          tenantId = binding.tenant_id;
          projectId = binding.project_id;
        }
      }

      if (!tenantId || !projectId) {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: null,
          actor: callerNumber || 'twilio_voice_lifecycle',
          role: 'untrusted_ingress',
          entry_point: 'webhook',
          tool_or_route: req.originalUrl || req.path,
          outcome: 'refused',
          reason: `Call status webhook: cannot resolve tenant/project from receiving number ${receivingNumber}`,
          correlation_id: callSid,
        });
        res.status(404).json({ error: 'SYSTEM_NOT_FOUND', message: 'Unknown or unbound receiving number' });
        return;
      }

      const statusMap: Record<string, VoiceDeliveryRecord['status']> = {
        completed: 'sent',
        failed: 'failed',
        busy: 'failed',
        'no-answer': 'failed',
        canceled: 'refused',
      };

      const recordStatus = statusMap[callStatus] || 'synthesized';

      await DbClient.recordVoiceDelivery({
        system_id: projectId,
        project_id: projectId,
        tenant_id: tenantId,
        status: recordStatus,
        error_code: callStatus === 'failed' ? 'CALL_FAILED' : undefined,
        error_message: callStatus === 'failed' ? `Call status: ${callStatus}` : undefined,
        character_count: 0,
        audio_bytes: 0,
        correlation_id: callSid,
        delivered_at: callStatus === 'completed' ? new Date().toISOString() : undefined,
      });

      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        actor: callerNumber || 'twilio_voice_lifecycle',
        role: 'call_lifecycle',
        entry_point: 'webhook',
        tool_or_route: req.originalUrl || req.path,
        outcome: callStatus === 'failed' ? 'error' : 'ok',
        reason: `Twilio call ${callSid} status transitioned to "${callStatus}" for project ${projectId}`,
        correlation_id: callSid,
      });

      res.status(200).json({
        status: 'ok',
        call_sid: callSid,
        call_status: callStatus,
        tenant_id: tenantId,
        project_id: projectId,
      });
    } catch (err: any) {
      Logger.error(`Voice status webhook error: ${err.message}`);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: err.message });
    }
  }
}

// ── Inbound Webhooks & Direct Routes ─────────────────────────────────────────

// 1. Inbound Call Webhooks (Twilio Signature Verification applied)
const inboundRoutes = [
  '/webhooks/twilio/voice',
  '/webhooks/twilio/voice/inbound',
  '/twilio/voice',
  '/twilio/voice/inbound',
];
inboundRoutes.forEach((route) => {
  voiceInterfaceRouter.post(route, verifyTwilioSignature, (req: Request, res: Response) => {
    VoiceInterface.handleInboundCall(req, res);
  });
});

// 2. Speech Turn Webhooks (Twilio Signature Verification applied)
const turnRoutes = [
  '/webhooks/twilio/voice/turn',
  '/twilio/voice/turn',
];
turnRoutes.forEach((route) => {
  voiceInterfaceRouter.post(route, verifyTwilioSignature, (req: Request, res: Response) => {
    VoiceInterface.handleSpeechTurnWebhook(req, res);
  });
});

// 3. Direct Programmatic Voice Turn Endpoint
voiceInterfaceRouter.post('/api/v1/voice/turn', (req: Request, res: Response) => {
  VoiceInterface.handleApiTurn(req, res);
});

// 4. Call Lifecycle Status Webhook
const statusRoutes = [
  '/webhooks/twilio/voice/status',
  '/twilio/voice/status',
  '/api/v1/voice/status',
];
statusRoutes.forEach((route) => {
  voiceInterfaceRouter.post(route, (req: Request, res: Response) => {
    VoiceInterface.handleCallStatus(req, res);
  });
});

// 5. Direct Voice Synthesize REST Endpoint
voiceInterfaceRouter.post('/api/v1/voice/synthesize', async (req: Request, res: Response) => {
  try {
    const { tenant_id, project_id, speaker_ref, text, conversation_id, correlation_id } = req.body;
    if (!tenant_id || !project_id || !text) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing required parameters (tenant_id, project_id, text)' });
      return;
    }

    const result = await VoiceInterface.synthesizeSpokenAudio({
      tenant_id,
      project_id,
      speaker_ref: speaker_ref || 'unknown',
      text,
      conversation_id,
      correlation_id,
    });

    res.setHeader('Content-Type', result.mime_type);
    res.setHeader('X-Voice-Id', result.voice_id);
    res.setHeader('X-Audio-Bytes', String(result.audio_bytes));
    res.status(200).send(result.audio_buffer);
  } catch (err: any) {
    Logger.error(`Voice synthesize API error: ${err.message}`);
    res.status(500).json({ error: 'VOICE_SYNTHESIS_FAILED', message: err.message });
  }
});
