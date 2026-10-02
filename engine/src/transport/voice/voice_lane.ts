import { randomUUID } from 'crypto';
import { InboundMessage, OutboundMessage, SystemConfig } from '../twilio/types.js';
import { SystemsRegistry } from '../../systems/registry.js';
import { CoreRegistry } from '../../core/registry.js';
import { IdentityResolver } from '../../identity/resolver.js';
import { IntentRouter } from '../../router/index.js';
import { DbClient, VoiceDeliveryRecord } from '../../db/client.js';
import { Logger } from '../../config/logger.js';
import { AlertAuditLog } from '../../audit/alert_audit.js';
import {
  AudioSynthesizer,
  createElevenLabsAudioSynthesizerFromEnv,
} from '../../audio/synthesis.js';
import { validateOutboundTenancyScope } from '../twilio/outbound.js';

export interface ProcessVoiceTurnInput {
  from_e164: string;
  to_e164: string;
  speech_text: string;
  correlation_id?: string;
  synthesizer?: AudioSynthesizer;
}

export interface VoiceTurnSuccessResult {
  status: 'synthesized';
  text: string;
  audioBase64: string;
  mimeType: string;
  correlation_id: string;
  conversation_id?: string;
  message_id: string;
}

export interface VoiceTurnRefusedResult {
  status: 'refused';
  reason: string;
  text?: string;
  correlation_id: string;
}

export interface VoiceTurnDroppedResult {
  status: 'dropped' | 'failed';
  reason: string;
  error?: string;
  correlation_id: string;
}

export type VoiceTurnResult =
  | VoiceTurnSuccessResult
  | VoiceTurnRefusedResult
  | VoiceTurnDroppedResult;

export class VoiceLaneService {
  private static defaultSynthesizer: AudioSynthesizer | null = null;

  static getSynthesizer(): AudioSynthesizer {
    if (!this.defaultSynthesizer) {
      this.defaultSynthesizer = createElevenLabsAudioSynthesizerFromEnv();
    }
    return this.defaultSynthesizer;
  }

  static setSynthesizer(synth: AudioSynthesizer | null): void {
    this.defaultSynthesizer = synth;
  }

  /**
   * Process an interactive voice turn through the full CST authorization and answering pipeline.
   *
   * Step-by-step rules enforced:
   * 1. CST authorization chain in front of voice (identity, roles, step-up, intent routing).
   * 2. Fail-closed: If CST refuses text version, refuse to speak it.
   * 3. Fail-closed: Missing clone config or missing voice_id drops turn — never fall back to generic voice.
   * 4. Audit & Transcripts: Link render to conversation transcripts, alert_audit_log, and audit ledgers.
   */
  static async processVoiceTurn(input: ProcessVoiceTurnInput): Promise<VoiceTurnResult> {
    const correlation_id = input.correlation_id || `voice_${randomUUID()}`;
    const from_e164 = (input.from_e164 || '').trim();
    const to_e164 = (input.to_e164 || '').trim();
    const speech_text = (input.speech_text || '').trim();

    // 1. Resolve the tenancy chain first.
    //    Twilio To -> service_number_binding -> tenant_id + project_id.
    // The binding is the tenancy AUTHORITY for voice ingress. `SystemsRegistry`
    // is consulted only for non-identity configuration (system name, onboarding
    // copy, BHARAG workspace key, ElevenLabs voice pointer); it cannot admit a
    // call and it cannot set the tenant.
    const binding = CoreRegistry.resolveServiceNumber(to_e164);
    if (!binding) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: null,
        actor: from_e164 || 'unknown_caller',
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceLaneService.processVoiceTurn',
        outcome: 'refused',
        reason: `Voice turn refused: receiving number ${to_e164} is not bound to any project, so no tenant/project tenancy chain exists`,
        correlation_id,
      });

      return {
        status: 'refused',
        reason: `Receiving number ${to_e164} is not bound to a project`,
        correlation_id,
      };
    }

    // Non-identity runtime configuration. Absent config is a deployment fault,
    // not an identity question, so it still refuses — but the tenancy is already
    // established by the binding above and is never taken from this lookup.
    const system = SystemsRegistry.resolveSystemByPhoneNumber(to_e164);
    if (!system) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: from_e164 || 'unknown_caller',
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceLaneService.processVoiceTurn',
        outcome: 'refused',
        reason: `Voice turn refused: no runtime system configuration registered for bound number ${to_e164} (tenant=${binding.tenant_id}, project=${binding.project_id})`,
        correlation_id,
      });

      return {
        status: 'refused',
        reason: `Receiving number ${to_e164} has no runtime system configuration`,
        correlation_id,
      };
    }

    // The binding is authoritative. If SystemsRegistry disagrees about which
    // tenant owns this number, that is a configuration conflict: refuse rather
    // than pick a winner, because picking one would let a stale registry entry
    // override the binding that actually admitted the call.
    const tenantId = binding.tenant_id;
    const resolvedProjectId = binding.project_id;
    const systemId = system.system_id;

    if (system.tenant_id !== tenantId) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        actor: from_e164 || 'unknown_caller',
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'VoiceLaneService.processVoiceTurn',
        outcome: 'refused',
        reason: `Voice turn refused: configuration conflict — service number ${to_e164} is bound to tenant "${tenantId}" but the system configuration claims tenant "${system.tenant_id}"`,
        correlation_id,
      });
      return {
        status: 'refused',
        reason: 'Receiving number binding conflicts with system configuration',
        correlation_id,
      };
    }

    // 2. Resolve caller identity through the same active tenant-adapter path as
    //    SMS/Web (CoreRegistry.resolveSpeaker → vFarm tenant adapter).
    //    Project scope comes from the binding resolved above, so the vFarm
    //    farm-grant lookup is authoritative for farm_ids.
    const identity = await IdentityResolver.resolveSenderIdentity(from_e164, system, {
      projectId: resolvedProjectId,
    });

    // 3. Build normalized inbound message
    const inboundMsg: InboundMessage = {
      message_id: `vmsg_in_${randomUUID()}`,
      tenant_id: tenantId,
      from_e164,
      to_e164,
      body: speech_text,
      media: [],
      received_at: new Date().toISOString(),
      correlation_id,
    };

    // 4. Execute CST Orchestrator pipeline (intent routing, RBAC, step-up, BHARAG connectors)
    let outboundMessage: OutboundMessage;
    try {
      outboundMessage = await IntentRouter.routeAndHandle(inboundMsg, identity);
    } catch (routeErr: any) {
      Logger.error(`VoiceLane routing failure: ${routeErr.message}`, { correlation_id, tenant_id: tenantId });
      await DbClient.recordVoiceDelivery({
        system_id: systemId,
        tenant_id: tenantId,
        status: 'failed',
        character_count: 0,
        audio_bytes: 0,
        error_code: 'ROUTING_FAILED',
        error_message: routeErr.message,
        correlation_id,
      });
      return {
        status: 'failed',
        reason: 'Internal routing error',
        error: routeErr.message,
        correlation_id,
      };
    }

    // 5. Fail-Closed Rule: If text was refused (or authorization rejected), refuse to speak!
    const isCrossTenantRefused = !validateOutboundTenancyScope(outboundMessage);
    const isRoleOrActionRefused =
      outboundMessage.status === 'refused' ||
      outboundMessage.body.includes('not authorized') ||
      outboundMessage.body.includes('restricted to the Organization Admin Panel') ||
      outboundMessage.body.includes('require step-up authentication') ||
      isCrossTenantRefused;

    if (isRoleOrActionRefused) {
      const reason =
        (isCrossTenantRefused ? 'Cross-tenant send refused' : null) ||
        outboundMessage.error_message ||
        outboundMessage.body;

      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        actor: identity.customer_ref,
        role: identity.role,
        entry_point: 'api',
        tool_or_route: 'VoiceLaneService.processVoiceTurn',
        outcome: 'refused',
        reason: `Spoken response refused because CST authorization chain refused text: ${reason}`,
        correlation_id,
      });

      await DbClient.recordVoiceDelivery({
        system_id: systemId,
        tenant_id: tenantId,
        message_id: outboundMessage.id,
        status: 'refused',
        character_count: (outboundMessage.body || '').length,
        audio_bytes: 0,
        error_code: 'AUTHORIZATION_REFUSED',
        error_message: reason,
        correlation_id,
      });

      return {
        status: 'refused',
        reason,
        text: outboundMessage.body,
        correlation_id,
      };
    }

    // 6. Fail-Closed Rule: Check voice clone pointer in Systems Registry
    const voiceId = system.elevenlabs_voice_id?.trim();
    if (!voiceId) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        actor: identity.customer_ref,
        role: identity.role,
        entry_point: 'api',
        tool_or_route: 'VoiceLaneService.processVoiceTurn',
        outcome: 'refused',
        reason: `Voice turn dropped: No voice clone pointer configured for system ${systemId}. Strictly refuse generic voice substitution.`,
        correlation_id,
      });
      Logger.infra({
        message: `Voice turn dropped for system ${systemId}: voice clone pointer (elevenlabs_voice_id) missing`,
        commercial_impact: 'Voice turn cannot be spoken in Jason\'s voice clone. Spoken turn dropped to prevent off-brand/generic voice playback.',
        meta: { system_id: systemId, tenant_id: tenantId, correlation_id },
      });

      await DbClient.recordVoiceDelivery({
        system_id: systemId,
        tenant_id: tenantId,
        message_id: outboundMessage.id,
        status: 'refused',
        character_count: (outboundMessage.body || '').length,
        audio_bytes: 0,
        error_code: 'NO_VOICE_POINTER',
        error_message: 'System voice pointer not configured',
        correlation_id,
      });

      return {
        status: 'dropped',
        reason: 'Voice clone not configured for system; generic voice fallback is forbidden',
        correlation_id,
      };
    }

    // 7. Synthesize audio via ElevenLabs
    const synthesizer = input.synthesizer || this.getSynthesizer();
    let audioPayload: { audioBase64: string; mimeType: string };

    try {
      audioPayload = await synthesizer.synthesize({
        text: outboundMessage.body,
        voiceId,
        modelId: system.elevenlabs_model_id,
      });
    } catch (synthErr: any) {
      const errorMsg = synthErr.message || 'ElevenLabs synthesis failed';
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: tenantId,
        actor: identity.customer_ref,
        role: identity.role,
        entry_point: 'api',
        tool_or_route: 'VoiceLaneService.processVoiceTurn',
        outcome: 'error',
        reason: `ElevenLabs synthesis failed: ${errorMsg}. Spoken turn dropped (no generic fallback).`,
        correlation_id,
      });
      Logger.infra({
        message: `Voice synthesis failure: ${errorMsg}`,
        commercial_impact: 'Spoken customer response failed. Customer voice call/turn dropped to preserve fail-closed contract.',
        meta: { system_id: systemId, tenant_id: tenantId, voice_id: voiceId, error: errorMsg, correlation_id },
      });

      await DbClient.recordVoiceDelivery({
        system_id: systemId,
        tenant_id: tenantId,
        message_id: outboundMessage.id,
        status: 'failed',
        voice_id: voiceId,
        model_id: system.elevenlabs_model_id,
        character_count: (outboundMessage.body || '').length,
        audio_bytes: 0,
        error_code: 'SYNTHESIS_FAILED',
        error_message: errorMsg,
        correlation_id,
      });

      return {
        status: 'failed',
        reason: 'ElevenLabs synthesis failed; turn dropped',
        error: errorMsg,
        correlation_id,
      };
    }

    // 8. Wire into audit and health surfaces on successful synthesis
    const audioBytes = Buffer.from(audioPayload.audioBase64, 'base64').length;

    // A. Record spoken delivery event for Destiny health signal
    await DbClient.recordVoiceDelivery({
      system_id: systemId,
      tenant_id: tenantId,
      message_id: outboundMessage.id,
      status: 'synthesized',
      voice_id: voiceId,
      model_id: system.elevenlabs_model_id,
      character_count: outboundMessage.body.length,
      audio_bytes: audioBytes,
      mime_type: audioPayload.mimeType,
      correlation_id,
      delivered_at: new Date().toISOString(),
    });

    // B. Link to Alert Audit Log (write-time secret masking & 64KB cap)
    await AlertAuditLog.write(
      outboundMessage.id!,
      tenantId,
      outboundMessage.body,
      {
        template_id: 'voice_clone_tts',
        version: '1.0.0',
        params: {
          channel: 'voice',
          voice_id: voiceId,
          model_id: system.elevenlabs_model_id,
          audio_bytes: audioBytes,
          mime_type: audioPayload.mimeType,
          correlation_id,
        },
      }
    );

    // C. Add outbound message to conversation transcripts
    try {
      const conv = DbClient.getAllConversations().find(
        (c: any) => c.customer_ref === identity.customer_ref && (c.tenant_id === tenantId || c.organization_id === tenantId)
      );
      if (conv) {
        await DbClient.addMessageToTranscript({
          message_id: outboundMessage.id!,
          conversation_id: conv.conversation_id,
          tenant_id: tenantId,
          direction: 'outbound',
          from_e164: to_e164,
          to_e164: from_e164,
          body: outboundMessage.body,
          media_refs: [`voice:elevenlabs:${voiceId}`],
          provider_sid: outboundMessage.id,
        });
      }
    } catch (transcriptErr: any) {
      Logger.warn(`Failed to append voice message to transcript: ${transcriptErr.message}`);
    }

    // D. Log audit event
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      actor: identity.customer_ref,
      role: identity.role,
      entry_point: 'api',
      tool_or_route: 'VoiceLaneService.processVoiceTurn',
      outcome: 'ok',
      reason: `Spoken response synthesized successfully via ElevenLabs (voice_id: ${voiceId}, bytes: ${audioBytes})`,
      correlation_id,
    });

    return {
      status: 'synthesized',
      text: outboundMessage.body,
      audioBase64: audioPayload.audioBase64,
      mimeType: audioPayload.mimeType,
      correlation_id,
      message_id: outboundMessage.id!,
    };
  }

  /**
   * Direct speak endpoint for pre-authorized speech text (as documented in reference Section 4).
   * Validates voice pointer, ensures no fallback, audits the render, and records the delivery.
   */
  static async synthesizeAuthorizedSpeech(input: {
    text: string;
    voiceId?: string;
    systemId?: string;
    tenantId?: string;
    correlation_id?: string;
    synthesizer?: AudioSynthesizer;
  }): Promise<{ audioBase64: string; mimeType: string }> {
    const correlation_id = input.correlation_id || `speak_${randomUUID()}`;
    const normalizedText = (input.text || '').trim();
    if (!normalizedText) {
      throw new Error('Text is required for speech synthesis.');
    }

    // Resolve system
    let system: SystemConfig | null = null;
    if (input.systemId) {
      system = SystemsRegistry.getSystemById(input.systemId);
    } else if (input.tenantId) {
      system = SystemsRegistry.getSystemByTenantId(input.tenantId);
    }

    const voiceId = input.voiceId?.trim() || system?.elevenlabs_voice_id?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim() || process.env.VFARM_ELEVENLABS_VOICE_ID?.trim();
    if (!voiceId) {
      throw new Error('No ElevenLabs voice pointer configured. Fallback to generic voice is forbidden.');
    }

    const systemId = system?.system_id || 'system-vfarm-01';
    const tenantId = system?.tenant_id || 'tenant-vfarm-01';
    const modelId = (system?.elevenlabs_model_id || process.env.ELEVENLABS_MODEL_ID || '').trim();
    if (!modelId) {
      throw new Error('ELEVENLABS_MODEL_ID is required for audio synthesis.');
    }

    const synthesizer = input.synthesizer || this.getSynthesizer();
    let result: { audioBase64: string; mimeType: string };

    try {
      result = await synthesizer.synthesize({
        text: normalizedText,
        voiceId,
        modelId,
      });
    } catch (err: any) {
      await DbClient.recordVoiceDelivery({
        system_id: systemId,
        tenant_id: tenantId,
        status: 'failed',
        voice_id: voiceId,
        model_id: modelId,
        character_count: normalizedText.length,
        audio_bytes: 0,
        error_code: 'SYNTHESIS_FAILED',
        error_message: err.message,
        correlation_id,
      });
      throw err;
    }

    const audioBytes = Buffer.from(result.audioBase64, 'base64').length;

    // Record delivery
    await DbClient.recordVoiceDelivery({
      system_id: systemId,
      tenant_id: tenantId,
      status: 'synthesized',
      voice_id: voiceId,
      model_id: modelId,
      character_count: normalizedText.length,
      audio_bytes: audioBytes,
      mime_type: result.mimeType,
      correlation_id,
      delivered_at: new Date().toISOString(),
    });

    // Alert Audit Log
    const outboundId = `speak_${randomUUID()}`;
    await AlertAuditLog.write(
      outboundId,
      tenantId,
      normalizedText,
      {
        template_id: 'voice_direct_speak',
        params: { voice_id: voiceId, model_id: modelId, correlation_id },
      }
    );

    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      actor: 'api_client',
      role: 'voice_client',
      entry_point: 'api',
      tool_or_route: '/audio/speak',
      outcome: 'ok',
      reason: `Direct speech synthesized with voice clone (voice_id: ${voiceId})`,
      correlation_id,
    });

    return result;
  }
}
