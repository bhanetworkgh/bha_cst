import { randomUUID } from 'crypto';
import { CoreRegistry } from '../core/registry.js';
import { CoreEngine } from '../core/engine.js';
import { MessageEnvelope, EnvelopeResponse } from '../core/envelope.js';
import { SpeakerIdentity, TurnChannel } from '../core/types.js';
import { Logger } from '../config/logger.js';
import { EscalationService } from '../escalation/service.js';
import {
  BrainTurnRequest,
  BrainTurnRequestSchema,
  BrainTurnResponse,
  BrainTurnStatus,
} from './schemas.js';

export interface ServerResolvedContext {
  tenant_id: string;
  project_id: string;
  speaker_ref?: string;
  role?: string;
  farm_ids?: string[];
  auth_mode: 'api_key' | 'session' | 'service_number' | 'internal';
}

export class BrainServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly errorCode: string = 'BAD_REQUEST',
    public readonly correlationId?: string
  ) {
    super(message);
    this.name = 'BrainServiceError';
  }
}

export class TenantScopeViolationError extends BrainServiceError {
  constructor(message: string, correlationId?: string) {
    super(message, 403, 'TENANT_SCOPE_VIOLATION', correlationId);
    this.name = 'TenantScopeViolationError';
  }
}

export class BrainTimeoutError extends BrainServiceError {
  constructor(message: string = 'Brain turn processing timed out', correlationId?: string) {
    super(message, 504, 'TURN_TIMEOUT', correlationId);
    this.name = 'BrainTimeoutError';
  }
}

export class CsTwinBrainService {
  /**
   * Process a tenancy-scoped turn through the unified CS Twin conversational brain.
   */
  static async processTurn(
    rawInput: unknown,
    context: ServerResolvedContext,
    options?: { signal?: AbortSignal }
  ): Promise<BrainTurnResponse> {
    const startTime = Date.now();
    const correlationId = (rawInput as any)?.correlation_id || `brain_${randomUUID()}`;

    // 1. Validate Input Payload against Zod Schema
    const parseResult = BrainTurnRequestSchema.safeParse(rawInput);
    if (!parseResult.success) {
      const errorDetail = parseResult.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
      Logger.warn(`CsTwinBrainService: Validation error on correlation ${correlationId}: ${errorDetail}`);
      throw new BrainServiceError(`Invalid turn request: ${errorDetail}`, 400, 'BAD_REQUEST', correlationId);
    }
    const input: BrainTurnRequest = parseResult.data;

    // 2. Strict Server-Side Tenancy & Tamper Guard (§7 / Cross-Tenant Prevention)
    if (!context.tenant_id || !context.project_id) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: null,
        actor: context.speaker_ref || 'unauthenticated',
        role: 'untrusted_ingress',
        entry_point: 'api',
        tool_or_route: 'CsTwinBrainService.processTurn',
        outcome: 'refused',
        reason: 'Missing server-side resolved tenant_id or project_id',
        correlation_id: correlationId,
      });
      throw new TenantScopeViolationError('Server-resolved tenancy context is missing', correlationId);
    }

    if (input.tenant_id && input.tenant_id !== context.tenant_id) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: context.tenant_id,
        actor: context.speaker_ref || 'untrusted_caller',
        role: context.role || 'untrusted',
        entry_point: 'api',
        tool_or_route: 'CsTwinBrainService.processTurn',
        outcome: 'refused',
        reason: `Cross-tenant payload tamper attempt: body tenant_id (${input.tenant_id}) !== resolved (${context.tenant_id})`,
        correlation_id: correlationId,
      });
      throw new TenantScopeViolationError(
        `Cross-tenant tenant_id override strictly prohibited (resolved: ${context.tenant_id})`,
        correlationId
      );
    }

    // 3. Resolve Project and Validate Channel Capability
    const tenant = CoreRegistry.getTenant(context.tenant_id);
    const project = CoreRegistry.getProject(context.project_id);
    if (!tenant || !project) {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: context.tenant_id,
        actor: context.speaker_ref || 'untrusted_caller',
        role: 'untrusted',
        entry_point: 'api',
        tool_or_route: 'CsTwinBrainService.processTurn',
        outcome: 'refused',
        reason: `Invalid tenant (${context.tenant_id}) or project (${context.project_id})`,
        correlation_id: correlationId,
      });
      throw new BrainServiceError(`Tenant "${context.tenant_id}" or project "${context.project_id}" not found`, 404, 'NOT_FOUND', correlationId);
    }

    const coreChannel: TurnChannel = input.channel === 'api' ? 'web' : (input.channel as TurnChannel);
    // Ensure capability exists for the requested channel
    if (coreChannel === 'web' && !project.capabilities.web) {
      throw new BrainServiceError(`Web capability is disabled for project "${context.project_id}"`, 403, 'CAPABILITY_DISABLED', correlationId);
    }
    if (coreChannel === 'voice' && !project.capabilities.voice) {
      throw new BrainServiceError(`Voice capability is disabled for project "${context.project_id}"`, 403, 'CAPABILITY_DISABLED', correlationId);
    }

    // 4. Resolve Speaker Identity & Farm Scope
    const speakerRef = input.speaker_ref || context.speaker_ref || input.phone_e164 || 'service_caller';
    let speaker: SpeakerIdentity;

    if (context.speaker_ref && context.role && context.role !== 'unknown') {
      speaker = {
        person_id: speakerRef,
        customer_ref: speakerRef,
        tenant_id: context.tenant_id,
        project_id: context.project_id,
        phone_e164: input.phone_e164 || (speakerRef.startsWith('+') ? speakerRef : '+10000000000'),
        is_known: true,
        role: context.role as any,
        permissions: ['read', 'status', 'chat', 'query'],
        farm_ids: context.farm_ids && context.farm_ids.length > 0 ? context.farm_ids : (process.env.VFARM_FARM_ID ? [process.env.VFARM_FARM_ID] : []),
        unit_context: {
          farm_id: context.farm_ids?.[0] || process.env.VFARM_FARM_ID,
          granted_farms: context.farm_ids || [],
          role: context.role,
        },
      };
    } else {
      speaker = await CoreRegistry.resolveSpeaker({
        tenantId: context.tenant_id,
        projectId: context.project_id,
        phoneE164: input.phone_e164 || (speakerRef.startsWith('+') ? speakerRef : '+10000000000'),
      });
    }

    // 5. Construct Canonical MessageEnvelope
    const envelope: MessageEnvelope = {
      tenant_id: context.tenant_id,
      project_id: context.project_id,
      channel: coreChannel,
      speaker_ref: speakerRef,
      text: input.text,
      media: input.media || [],
      correlation_id: correlationId,
      metadata: {
        ...input.metadata,
        auth_mode: context.auth_mode,
        conversation_id: input.conversation_id,
      },
    };

    // 6. Check Cancellation / Timeout Signal
    if (options?.signal?.aborted) {
      throw new BrainTimeoutError('Brain turn processing aborted before execution', correlationId);
    }

    // 7. Invoke Shared CoreEngine Pipeline
    let engineResponse: EnvelopeResponse;
    try {
      engineResponse = await CoreEngine.processEnvelope(envelope, speaker);
    } catch (coreErr: any) {
      Logger.error(`CsTwinBrainService: CoreEngine execution error: ${coreErr.message}`);
      throw new BrainServiceError(`Internal brain execution failed: ${coreErr.message}`, 500, 'EXECUTION_ERROR', correlationId);
    }

    // Check cancellation signal after pipeline execution
    if (options?.signal?.aborted) {
      throw new BrainTimeoutError('Brain turn deadline expired during execution', correlationId);
    }

    // 8. Map Engine Response Status to Contract Status
    let contractStatus: BrainTurnStatus = 'ok';
    if (engineResponse.status === 'refused' || engineResponse.reply_text.includes('restricted to the Organization Admin Panel') || engineResponse.reply_text.includes('not authorized')) {
      contractStatus = 'refused';
    } else if (engineResponse.status === 'step_up_required' || engineResponse.reply_text.includes('step-up')) {
      contractStatus = 'step_up_required';
    } else if (engineResponse.status === 'failed' || engineResponse.status === 'error') {
      contractStatus = 'error';
    }

    // 9. Handle Human Escalation Signaling
    let escalationResult;
    const lowerText = input.text.toLowerCase();
    const isEscalationIntent = engineResponse.intent === 'escalation' || lowerText.includes('talk to a human') || lowerText.includes('speak to an agent') || lowerText.includes('representative');

    if (isEscalationIntent && contractStatus === 'ok') {
      try {
        const escalation = await EscalationService.escalate({
          caller_phone: speaker.phone_e164 || speakerRef,
          tenant_id: context.tenant_id,
          project_id: context.project_id,
          correlation_id: correlationId,
          conversation_id: engineResponse.conversation_id,
          reason: input.text,
          transcript: [
            `User: ${input.text}`,
            `Assistant: ${engineResponse.reply_text}`,
          ],
        });
        escalationResult = {
          requested: true,
          reason: input.text,
          escalation_id: correlationId,
          status: escalation.created ? 'notified' : 'pending',
        };
      } catch (escErr: any) {
        Logger.warn(`CsTwinBrainService: Escalation notification non-fatal failure: ${escErr.message}`);
        escalationResult = {
          requested: true,
          reason: input.text,
          status: 'failed',
        };
      }
    }

    const durationMs = Date.now() - startTime;
    const conversationId = engineResponse.conversation_id || (engineResponse.metadata?.conversation_id as string) || `conv_${correlationId}`;

    // 10. Construct Final Strongly-Typed Response
    const response: BrainTurnResponse = {
      turn_id: `turn_${randomUUID()}`,
      conversation_id: conversationId,
      correlation_id: correlationId,
      tenant_id: context.tenant_id,
      project_id: context.project_id,
      speaker_ref: speakerRef,
      channel: input.channel,
      role: speaker.role || 'unknown',
      input_text: input.text,
      reply_text: engineResponse.reply_text,
      status: contractStatus,
      intent: engineResponse.intent || 'general_help',
      duration_ms: durationMs,
      escalation: escalationResult,
      timestamp: new Date().toISOString(),
      metadata: {
        ...engineResponse.metadata,
        reason: engineResponse.reason,
      },
    };

    // 11. Security Ledger Audit
    Logger.audit({
      timestamp: response.timestamp,
      tenant_id: context.tenant_id,
      actor: speakerRef,
      role: speaker.role,
      entry_point: 'api',
      tool_or_route: 'CsTwinBrainService.processTurn',
      outcome: contractStatus === 'ok' ? 'ok' : 'refused',
      reason: engineResponse.reason || `Turn completed with status ${contractStatus}`,
      correlation_id: correlationId,
      details: {
        channel: input.channel,
        intent: response.intent,
        duration_ms: durationMs,
      },
    });

    return response;
  }
}
