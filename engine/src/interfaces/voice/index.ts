import { maskPhone } from '../../util/privacy.js';
import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { CoreRegistry } from '../../core/registry.js';
import { CoreEngine } from '../../core/engine.js';
import { MessageEnvelope, EnvelopeResponse } from '../../core/envelope.js';
import { SpeakerIdentity, matchesCapability } from '../../core/types.js';
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
import { requireProgrammaticApiKey } from '../../middleware/programmatic_api_key.js';
import { isTestRunner } from '../../config/runtime.js';

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
  /** Cancellation signal, threaded to the synthesizer's HTTP request. */
  signal?: AbortSignal;
}

/**
 * Default bound on how long a voice turn may take before the webhook must
 * answer. Twilio expects a prompt webhook response; a turn can include a
 * CoreEngine round trip and an ElevenLabs synthesis, so it needs a ceiling.
 */
export const DEFAULT_VOICE_TURN_DEADLINE_MS = 7000;

export interface ProcessVoiceTurnInput {
  from_e164: string;
  to_e164: string;
  speech_text: string;
  correlation_id?: string;
  call_sid?: string;
  /**
   * Cancellation signal. The webhook deadline aborts this so a turn that has
   * been abandoned stops at its next checkpoint instead of persisting a
   * transcript and a voice-delivery row after the caller has already been
   * answered.
   */
  signal?: AbortSignal;
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

function getVoiceTurnActionUrl(req?: Request): string {
  // If explicitly configured via PUBLIC_WEBHOOK_URL or CST_SERVICE_URL, use it
  const envPublicUrl = (process.env.PUBLIC_WEBHOOK_URL || process.env.CST_SERVICE_URL)?.trim();
  if (envPublicUrl && (!isTestRunner() || process.env.TEST_FORCE_PUBLIC_URL === 'true')) {
    const base = envPublicUrl.replace(/\/+$/, '');
    return `${base}/webhooks/twilio/voice/turn`;
  }
  // If behind proxy (e.g. Render), reconstruct from x-forwarded-proto and x-forwarded-host
  if (req) {
    const forwardedHost = req.headers['x-forwarded-host'] as string | undefined;
    if (forwardedHost) {
      const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
      return `${proto}://${forwardedHost}/webhooks/twilio/voice/turn`;
    }
    if (!isTestRunner() || process.env.TEST_FORCE_PUBLIC_URL === 'true') {
      const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
      const host = req.get('host');
      if (host) {
        return `${proto}://${host}/webhooks/twilio/voice/turn`;
      }
    }
  }
  return '/webhooks/twilio/voice/turn';
}

function isTwilioVoiceRequest(req: Request): boolean {
  // 1. Genuine Twilio Voice requests always include User-Agent containing 'TwilioProxy'
  const ua = (req.headers['user-agent'] as string) || '';
  if (ua.includes('TwilioProxy')) {
    return true;
  }

  // 2. Client explicitly requesting XML via Accept header
  const accept = (req.headers.accept as string) || '';
  if (accept.includes('text/xml') || accept.includes('application/xml')) {
    return true;
  }

  // 3. Any other client defaults to JSON to preserve existing non-Twilio API contract
  return false;
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
  /**
   * The maximum time a voice turn may take before the webhook must answer.
   *
   * Twilio expects a webhook response quickly. A turn can include a CoreEngine
   * round trip and an ElevenLabs synthesis, so without a bound a slow or cold
   * instance can hold the response open until the provider gives up.
   *
   * Overridable with `CST_VOICE_TURN_DEADLINE_MS` for a deployment with a
   * different provider budget. The value is clamped to a sane range.
   */
  static voiceTurnDeadlineMs(): number {
    const raw = Number(process.env.CST_VOICE_TURN_DEADLINE_MS);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_VOICE_TURN_DEADLINE_MS;
    return Math.min(Math.max(raw, 1000), 20000);
  }

  /**
   * Run a voice turn under a bounded deadline.
   *
   * A bare `Promise.race()` is not enough: the losing promise keeps running
   * and can still write a transcript, a voice-delivery row, or an audit entry
   * after the caller has already been answered — a duplicate turn, and a
   * duplicate billed synthesis.
   *
   * So the turn is given an `AbortSignal`. When the deadline fires the
   * signal is aborted, the in-flight work stops at its next checkpoint, and
   * the turn is abandoned WITHOUT persisting anything. The caller receives a
   * `failed` result carrying `TURN_TIMEOUT`, which the existing failure path
   * renders as a short safe `<Say>` followed by a hang-up.
   */
  static async processVoiceTurnWithDeadline(
    input: ProcessVoiceTurnInput
  ): Promise<VoiceTurnResult> {
    const correlationId = input.correlation_id || input.call_sid || `voice_${randomUUID()}`;
    const deadlineMs = this.voiceTurnDeadlineMs();
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const turnPromise = this.processVoiceTurn({ ...input, signal: controller.signal });

    // The turn promise must never reject unhandled — an abort surfaces as a
    // rejection from the synthesizer.
    turnPromise.catch(() => undefined);

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve('timeout');
      }, deadlineMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const outcome = await Promise.race([
        turnPromise.then((result) => ({ kind: 'completed' as const, result })),
        timeoutPromise,
      ]);

      if (outcome === 'timeout') {
        Logger.audit({
          timestamp: new Date().toISOString(),
          tenant_id: null,
          actor: 'voice_webhook',
          role: 'system',
          entry_point: 'webhook',
          tool_or_route: 'VoiceInterface.processVoiceTurnWithDeadline',
          outcome: 'error',
          reason: `Voice turn exceeded the ${deadlineMs}ms response deadline; turn abandoned and no turn was persisted`,
          correlation_id: correlationId,
          details: { tripwire: true, deadline_ms: deadlineMs },
        });
        return {
          status: 'failed',
          reason: 'The response took too long to prepare',
          error: 'TURN_TIMEOUT',
          correlation_id: correlationId,
          httpStatus: 504,
        };
      }

      return outcome.result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

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
        actor: maskPhone(from_e164) || 'unknown_caller',
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

    // 2. Check capability. A combined 'sms_voice' binding serves both
    // transports, so it satisfies the voice check as well.
    if (!matchesCapability(binding.capability, 'voice')) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: maskPhone(from_e164) || 'unknown_caller',
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
        actor: maskPhone(from_e164) || 'unknown_caller',
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
        actor: maskPhone(from_e164),
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
        actor: maskPhone(from_e164) || 'unknown_caller',
        role: 'guest',
        entry_point: 'api',
        tool_or_route: 'VoiceInterface.processVoiceTurn',
        outcome: 'ok',
        reason: `Guest caller ${maskPhone(from_e164)} processing voice turn for project ${binding.project_id} under least-privilege policy`,
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
        actor: activeSpeaker.customer_ref || maskPhone(from_e164),
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

    // 6b. The webhook deadline may have fired while the engine was working.
    // Abandon the turn here, BEFORE any synthesis or persistence, so an
    // abandoned turn never writes a transcript, a voice-delivery row, or an
    // audit entry for a response the caller never received.
    if (input.signal?.aborted) {
      return {
        status: 'failed',
        reason: 'Turn abandoned: the response deadline expired before synthesis',
        error: 'TURN_TIMEOUT',
        correlation_id,
        conversation_id: conversationId,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 504,
      };
    }

    // 7. Resolve project-level ElevenLabs voice pointer (Strict Project Isolation)
    const voiceId = project.elevenlabs_voice_id?.trim();
    if (!voiceId) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: speaker.customer_ref || maskPhone(from_e164),
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
        signal: input.signal,
      });
    } catch (synthErr: any) {
      // A synthesis aborted by the response deadline is a timeout, not a
      // provider failure. Reporting it as SYNTHESIS_FAILED would tell the
      // operator to look at ElevenLabs when the cause was our own deadline.
      if (synthErr?.aborted || input.signal?.aborted || synthErr?.name === 'AbortError') {
        return {
          status: 'failed',
          reason: 'Turn abandoned: the response deadline expired during synthesis',
          error: 'TURN_TIMEOUT',
          correlation_id,
          conversation_id: conversationId,
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          httpStatus: 504,
        };
      }

      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: binding.tenant_id,
        actor: speaker.customer_ref || maskPhone(from_e164),
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

    // 8b. The deadline may have fired during synthesis. If it did, the audio
    // is discarded: no transcript, no voice-delivery row, no alert-audit row.
    // Persisting any of them would record a turn the caller never received.
    if (input.signal?.aborted) {
      return {
        status: 'failed',
        reason: 'Turn abandoned: the response deadline expired during synthesis',
        error: 'TURN_TIMEOUT',
        correlation_id,
        conversation_id: conversationId,
        tenant_id: binding.tenant_id,
        project_id: binding.project_id,
        httpStatus: 504,
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
      actor: speaker.customer_ref || maskPhone(from_e164),
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
        signal: req.signal,
      });

      const audioBuffer = Buffer.from(result.audioBase64, 'base64');

      // The response deadline may have fired while the synthesis was in
      // flight. If it did, the audio is discarded and NOTHING is recorded:
      // a 'synthesized' voice-delivery row would assert a turn that was
      // never delivered to the caller.
      if (req.signal?.aborted) {
        const abortErr: any = new Error('Voice synthesis was abandoned: the response deadline expired.');
        abortErr.name = 'AbortError';
        abortErr.aborted = true;
        throw abortErr;
      }

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

      // 2. Capability check. A combined 'sms_voice' binding serves both
      // transports, so it satisfies the voice check as well.
      if (!matchesCapability(binding.capability, 'voice')) {
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
          actor: maskPhone(callerNumber),
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
          actor: maskPhone(callerNumber),
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
          actor: maskPhone(callerNumber) || 'unknown_caller',
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
        const turnResult = await this.processVoiceTurnWithDeadline({
          from_e164: callerNumber,
          to_e164: receivingNumber,
          speech_text: speechText,
          correlation_id: callSid,
          call_sid: callSid,
        });

        res.setHeader('X-Tenant-Id', binding.tenant_id);
        res.setHeader('X-Project-Id', binding.project_id);

        const httpStatus = turnResult.httpStatus || (turnResult.status === 'synthesized' ? 200 : turnResult.status === 'refused' ? 403 : 502);

        if (!isTwilioVoiceRequest(req)) {
          res.status(turnResult.httpStatus || 200).json(turnResult);
          return;
        }

        const actionUrl = getVoiceTurnActionUrl(req);
        if (turnResult.status === 'synthesized') {
          const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST">\n    <Say>${escapeXml(turnResult.text || '')}</Say>\n  </Gather>\n  <Say>Are you still there? Please let me know how I can help, or stay on the line.</Say>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST"/>\n</Response>`;
          res.setHeader('Content-Type', 'text/xml; charset=utf-8');
          res.status(200).send(twiml);
        } else {
          // Distinguish hard security failures (hang up) from soft/recoverable
          // refusals (say a safe message, then re-gather so the caller can continue).
          const refusalText = turnResult.reason || turnResult.text || '';
          const isHardFailure = (
            refusalText.includes('not authorized') ||
            refusalText.includes('step-up') ||
            refusalText.includes('cross-tenant') ||
            refusalText.includes('FORBIDDEN')
          );
          if (turnResult.status === 'dropped' || turnResult.status === 'failed') {
            const safeErrMsg = 'I apologize, but I am currently experiencing technical difficulties. Please try again shortly or contact your account representative. Goodbye.';
            const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>${safeErrMsg}</Say>\n  <Hangup/>\n</Response>`;
            res.setHeader('Content-Type', 'text/xml; charset=utf-8');
            res.status(200).send(twiml);
            return;
          }
          const safeMsg = escapeXml(refusalText || 'I was unable to complete that request.');
          let twiml: string;
          if (isHardFailure) {
            twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>${safeMsg}</Say>\n  <Hangup/>\n</Response>`;
          } else {
            // Soft refusal (farm gate, no resources, etc.) — speak and re-gather without terminating call
            twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST">\n    <Say>${safeMsg}</Say>\n  </Gather>\n  <Say>Are you still there? Please let me know how I can help, or stay on the line.</Say>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST"/>\n</Response>`;
          }
          res.setHeader('Content-Type', 'text/xml; charset=utf-8');
          res.status(200).send(twiml);
        }
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
        actor: maskPhone(callerNumber) || 'twilio_voice_webhook',
        role: speaker.is_known ? speaker.role : 'guest',
        entry_point: 'webhook',
        tool_or_route: req.originalUrl || req.path,
        outcome: 'ok',
        reason: `Inbound voice call answered for project ${binding.project_id}`,
        correlation_id: callSid,
      });

      const greeting = project.onboarding_reply || 'Welcome to Customer Service Twin. How can I assist you today?';
      const actionUrl = getVoiceTurnActionUrl(req);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST">\n    <Say>${escapeXml(greeting)}</Say>\n  </Gather>\n  <Say>I did not hear anything. Please let me know how I can help, or stay on the line.</Say>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST"/>\n  <Say>Thank you for calling. Goodbye.</Say>\n  <Hangup/>\n</Response>`;

      res.setHeader('X-Tenant-Id', binding.tenant_id);
      res.setHeader('X-Project-Id', binding.project_id);
      res.setHeader('X-Call-Sid', callSid);

      if (!isTwilioVoiceRequest(req)) {
        res.status(200).json({
          status: 'initiated',
          call_sid: callSid,
          tenant_id: binding.tenant_id,
          project_id: binding.project_id,
          greeting,
          twiml,
        });
      } else {
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
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
    const turnStartTime = Date.now();
    try {
      const receivingNumber = ((req.body?.To as string) || '').trim();
      const callerNumber = ((req.body?.From as string) || '').trim();
      const callSid = req.body?.CallSid || `turn_${randomUUID()}`;
      const speechText = ((req.body?.SpeechResult || req.body?.speech_text || req.body?.Body || '') as string).trim();
      const confidence = req.body?.Confidence ? parseFloat(req.body.Confidence) : undefined;

      Logger.info(`Voice turn webhook received`, {
        call_sid: callSid,
        has_speech: Boolean(speechText),
        speech_chars: speechText.length,
        confidence,
        is_twilio: isTwilioVoiceRequest(req),
      });

      const actionUrl = getVoiceTurnActionUrl(req);

      // Fast-path: Empty speech or silent gather timeout
      if (!speechText) {
        Logger.info(`Voice turn received empty speech; returning reprompt`, { call_sid: callSid });
        if (!isTwilioVoiceRequest(req)) {
          res.status(200).json({
            status: 'empty_speech',
            message: 'No speech transcription received',
            call_sid: callSid,
          });
          return;
        }

        const repromptTwiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST">\n    <Say>I am sorry, I did not catch that. Could you please repeat what you said?</Say>\n  </Gather>\n  <Say>I still did not hear anything. Thank you for calling. Goodbye.</Say>\n  <Hangup/>\n</Response>`;
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
        res.status(200).send(repromptTwiml);
        return;
      }

      const result = await this.processVoiceTurnWithDeadline({
        from_e164: callerNumber,
        to_e164: receivingNumber,
        speech_text: speechText,
        correlation_id: callSid,
        call_sid: callSid,
      });

      const elapsedMs = Date.now() - turnStartTime;
      Logger.info(`Voice turn processed`, {
        call_sid: callSid,
        status: result.status,
        duration_ms: elapsedMs,
        tenant_id: result.tenant_id,
        project_id: result.project_id,
      });

      if (result.tenant_id) res.setHeader('X-Tenant-Id', result.tenant_id);
      if (result.project_id) res.setHeader('X-Project-Id', result.project_id);

      const httpStatus = result.httpStatus || (result.status === 'synthesized' ? 200 : result.status === 'refused' ? 403 : 502);

      if (!isTwilioVoiceRequest(req)) {
        res.status(httpStatus).json(result);
        return;
      }

      if (result.status === 'synthesized') {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST">\n    <Say>${escapeXml(result.text || '')}</Say>\n  </Gather>\n  <Say>Are you still there? Please let me know how I can help, or stay on the line.</Say>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST"/>\n</Response>`;
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
        res.status(200).send(twiml);
      } else if (result.status === 'refused') {
        // Hard security failures hang up; soft refusals (farm gate, no farm resources)
        // speak a safe reply and re-gather so the caller can continue the conversation.
        const refusalText = result.reason || result.text || '';
        const isHardFailure = (
          refusalText.includes('not authorized') ||
          refusalText.includes('step-up') ||
          refusalText.includes('cross-tenant') ||
          refusalText.includes('FORBIDDEN')
        );
        const safeMsg = escapeXml(refusalText || 'I was unable to complete that request.');
        let twiml: string;
        if (isHardFailure) {
          twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>${safeMsg}</Say>\n  <Hangup/>\n</Response>`;
        } else {
          // Soft refusal — speak and re-gather without terminating call
          twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST">\n    <Say>${safeMsg}</Say>\n  </Gather>\n  <Say>Are you still there? Please let me know how I can help, or stay on the line.</Say>\n  <Gather input="speech" speechTimeout="auto" timeout="5" action="${actionUrl}" method="POST"/>\n</Response>`;
        }
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
        res.status(200).send(twiml);
      } else {
        // Soft fallback for technical errors / dropped turns
        const safeErrMsg = 'I apologize, but I am currently experiencing technical difficulties. Please try again shortly or contact your account representative. Goodbye.';
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>${safeErrMsg}</Say>\n  <Hangup/>\n</Response>`;
        res.setHeader('Content-Type', 'text/xml; charset=utf-8');
        res.status(200).send(twiml);
      }
    } catch (err: any) {
      Logger.error(`Voice turn webhook failure: ${err.message}`, { duration_ms: Date.now() - turnStartTime });
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

      const result = await this.processVoiceTurnWithDeadline({
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
          actor: maskPhone(callerNumber) || 'twilio_voice_lifecycle',
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
        actor: maskPhone(callerNumber) || 'twilio_voice_lifecycle',
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
//    Authenticated: the caller asserts `from_e164`, and the speaker's role and
//    farm scope are resolved from that number, so an unauthenticated caller
//    could impersonate a known vFarm member. See middleware/programmatic_api_key.ts.
voiceInterfaceRouter.post('/api/v1/voice/turn', requireProgrammaticApiKey, (req: Request, res: Response) => {
  VoiceInterface.handleApiTurn(req, res);
});

// 4. Call Lifecycle Status Webhook
//    The Twilio-hosted variants are the intended public entry point and are
//    signed; the /api/v1 variant is programmatic and needs the shared secret.
const statusRoutes = [
  { path: '/webhooks/twilio/voice/status', guard: verifyTwilioSignature },
  { path: '/twilio/voice/status', guard: verifyTwilioSignature },
  { path: '/api/v1/voice/status', guard: requireProgrammaticApiKey },
];
statusRoutes.forEach(({ path, guard }) => {
  voiceInterfaceRouter.post(path, guard, (req: Request, res: Response) => {
    VoiceInterface.handleCallStatus(req, res);
  });
});

// 5. Direct Voice Synthesize REST Endpoint
//    Authenticated: it synthesizes arbitrary text with the project's ElevenLabs
//    voice clone, so an unauthenticated caller could burn quota and misuse the
//    clone. See middleware/programmatic_api_key.ts.
voiceInterfaceRouter.post('/api/v1/voice/synthesize', requireProgrammaticApiKey, async (req: Request, res: Response) => {
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
