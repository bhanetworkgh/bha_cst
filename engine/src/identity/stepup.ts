import { IdentityContext } from '../transport/twilio/types.js';
import { Logger } from '../config/logger.js';

export interface StepUpVerificationResult {
  verified: boolean;
  message?: string;
  reason?: string;
}

export class StepUpAuthService {
  private static readonly SENSITIVE_KEYWORDS = [
    'reboot', 'restart', 'shutdown', 'turn off', 'turn on', 'override',
    'pump off', 'valve open', 'valve close', 'setpoint', 'set temp',
    'change config', 'wipe', 'reset', 'factory reset', 'payment', 'transfer',
    'admin override', 'delete'
  ];

  /**
   * Determine whether an incoming message request constitutes a sensitive write or state-changing action.
   */
  static isSensitiveAction(body: string, intent?: string): boolean {
    const text = (body || '').toLowerCase();
    
    // Explicit intent classification check
    if (intent === 'control' || intent === 'write_action' || intent === 'sensitive') {
      return true;
    }

    // Keyword matching for sensitive action commands
    return this.SENSITIVE_KEYWORDS.some((kw) => text.includes(kw));
  }

  /**
   * Check if an action requires step-up authentication.
   */
  static requiresStepUp(identity: IdentityContext, body: string, intent?: string): boolean {
    // Unknown users can never perform actions
    if (!identity.is_known_customer) {
      return true;
    }

    return this.isSensitiveAction(body, intent);
  }

  /**
   * Verify step-up authentication seam.
   * For v1, unverified sensitive write requests are rejected safely.
   */
  static verifyStepUp(
    identity: IdentityContext,
    stepUpToken?: string
  ): StepUpVerificationResult {
    // If a valid step-up token / verified flag is provided (e.g. from voice / web seam)
    if (stepUpToken && stepUpToken === 'VERIFIED_STEP_UP') {
      Logger.audit({
        timestamp: new Date().toISOString(),
        tenant_id: identity.tenant_id,
        actor: identity.customer_ref,
        role: identity.role || 'known_user',
        entry_point: 'api',
        tool_or_route: 'StepUpAuthService.verifyStepUp',
        outcome: 'ok',
        reason: 'Step-up authentication successfully verified via token',
      });
      return { verified: true };
    }

    // Otherwise, unverified sensitive action is safely rejected per spec §6
    Logger.audit({
      timestamp: new Date().toISOString(),
      tenant_id: identity.tenant_id,
      actor: identity.customer_ref,
      role: identity.role || 'known_user',
      entry_point: 'api',
      tool_or_route: 'StepUpAuthService.verifyStepUp',
      outcome: 'refused',
      reason: 'Sensitive write/action operation attempted without verified step-up authentication',
    });

    return {
      verified: false,
      reason: 'STEP_UP_REQUIRED',
      message: 'Sensitive write/action operations require explicit step-up verification. Please authenticate via your manager portal or voice callback.',
    };
  }
}
