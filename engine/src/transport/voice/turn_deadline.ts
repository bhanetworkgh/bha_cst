/**
 * The bounded voice-turn response deadline.
 *
 * A voice turn can include a CoreEngine round trip and an ElevenLabs
 * synthesis, so without a bound a slow or cold instance holds the response
 * open until the provider gives up. This module is the single implementation of
 * that bound, shared by BOTH voice turn paths:
 *
 *   - `VoiceInterface.processVoiceTurn`  (the Twilio webhook / programmatic
 *     interface path)
 *   - `VoiceLaneService.processVoiceTurn` (the voice-lane path behind
 *     `POST /voice/turn` and `POST /audio/speak`)
 *
 * A bare `Promise.race()` is not enough: the losing promise keeps running and
 * can still write a transcript, a voice-delivery row, or an audit entry after
 * the caller has been answered — a duplicate turn, and a duplicate billed
 * synthesis. So the turn is given an `AbortSignal`; on expiry the signal is
 * aborted, the in-flight work stops at its next checkpoint, and the turn is
 * abandoned WITHOUT persisting anything.
 *
 * It lives in its own module (a leaf, with no imports from either voice
 * implementation) because the two implementations import each other in one
 * direction only, and a shared helper must not introduce a cycle.
 */
import { Logger } from '../../config/logger.js';

/** Default bound on how long a voice turn may take before the caller is answered. */
export const DEFAULT_VOICE_TURN_DEADLINE_MS = 7000;

const MIN_DEADLINE_MS = 1000;
const MAX_DEADLINE_MS = 20000;

/**
 * The configured deadline.
 *
 * Overridable with `CST_VOICE_TURN_DEADLINE_MS` for a deployment with a
 * different provider budget. Clamped to a sane range.
 */
export function voiceTurnDeadlineMs(): number {
  const raw = Number(process.env.CST_VOICE_TURN_DEADLINE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_VOICE_TURN_DEADLINE_MS;
  return Math.min(Math.max(raw, MIN_DEADLINE_MS), MAX_DEADLINE_MS);
}

export interface VoiceTurnDeadlineOptions {
  /** The correlation id of the turn, used for the audit entry. */
  correlationId: string;
  /** Which implementation is being bounded — recorded in the audit entry. */
  tool: string;
  /** The tenant, when known, for the audit entry. */
  tenantId?: string | null;
}

/**
 * Run a voice turn under a bounded deadline.
 *
 * @param run - The turn implementation. It receives the `AbortSignal` and must
 *   stop at its next checkpoint when it is aborted.
 * @returns The turn's own result, or `null` when the deadline expired.
 */
export async function runVoiceTurnWithDeadline<T extends { status?: string }>(
  run: (signal: AbortSignal) => Promise<T>,
  options: VoiceTurnDeadlineOptions
): Promise<T | null> {
  const deadlineMs = voiceTurnDeadlineMs();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const turnPromise = run(controller.signal);
  // The turn promise must never reject unhandled — an abort surfaces as a
  // rejection from the synthesizer.
  turnPromise.catch(() => undefined);

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
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
        tenant_id: options.tenantId ?? null,
        actor: 'voice_webhook',
        role: 'system',
        entry_point: 'webhook',
        tool_or_route: options.tool,
        outcome: 'error',
        reason: `Voice turn exceeded the ${deadlineMs}ms response deadline; turn abandoned and no turn was persisted`,
        correlation_id: options.correlationId,
        details: { tripwire: true, deadline_ms: deadlineMs },
      });
      return null;
    }

    return outcome.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
