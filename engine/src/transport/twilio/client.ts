import twilio from 'twilio';
import { getEnv } from '../../config/env.js';
import { Logger } from '../../config/logger.js';
import { maskPhone } from '../../util/privacy.js';

/**
 * Hard upper bound on a single outbound Twilio API call.
 *
 * WHY THIS BOUND EXISTS
 *   The outbound worker processes a batch of messages SERIALLY. If a single
 *   `messages.create()` call can hang for as long as the Twilio SDK's default
 *   request timeout, one slow message holds the entire batch — and with it
 *   every other customer's reply behind it. Three attempts of that per
 *   message, plus the retry backoff, is several minutes of head-of-line
 *   blocking for the whole queue.
 *
 *   Fifteen seconds is comfortably above the normal Messages API latency
 *   (well under a second) and comfortably below the point where a single
 *   message can stall the batch. A call that exceeds it fails as a
 *   TIMEOUT, which is a RETRIABLE error, so the message is re-queued with
 *   backoff rather than being lost.
 */
export const TWILIO_SEND_TIMEOUT_MS = 15_000;

export interface SendSmsParams {
  to: string;
  from?: string;
  messagingServiceSid?: string;
  body: string;
  mediaUrl?: string[];
}

/**
 * Reject with a TIMEOUT error when `work` does not settle in time.
 *
 * The underlying operation is NOT aborted — a late resolution is discarded
 * rather than acted on. That is deliberate: the Twilio SDK's request object
 * is not safely abortable, and the only thing the caller must not do is
 * treat a timed-out send as a completed one. A timed-out send is a
 * RETRIABLE failure, so the message is re-queued with backoff; the risk of
 * a duplicate send is bounded by the provider's own idempotency behaviour
 * and by the fact that a genuinely accepted message will receive its own
 * status callback.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err: any = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      err.status = 408;
      err.isTimeout = true;
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TwilioClientWrapper {
  private static client: twilio.Twilio | null = null;
  private static mockSendHandler: ((params: SendSmsParams) => Promise<{ sid: string; status: string }>) | null = null;

  static getClient(): twilio.Twilio {
    if (!this.client) {
      const env = getEnv();
      this.client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    }
    return this.client;
  }

  static setMockHandler(handler: ((params: SendSmsParams) => Promise<{ sid: string; status: string }>) | null): void {
    this.mockSendHandler = handler;
  }

  /**
   * Permanent non-retriable Twilio error codes.
   *
   * These errors indicate a permanent delivery impossibility — retrying will
   * never succeed and would only burn API quota. The outbound worker immediately
   * classifies a message as permanently failed when one of these codes is thrown.
   *
   * Voice & SMS geo-permission codes:
   *   21215 — Outbound call/SMS blocked by Twilio Geo-Permissions for this
   *            destination country (e.g. Pakistan +92 voice is blocked by default).
   *            OPERATOR ACTION REQUIRED: enable the country in the Twilio Console
   *            under Voice > Settings > Geo-Permissions before retrying.
   *
   * Sender-configuration codes:
   *   21659 — The 'From' number is not a valid phone number, shortcode or
   *            alphanumeric sender id, i.e. it is not a number this Twilio
   *            account owns or has verified. This is PERMANENT: the sender
   *            identity cannot become valid by resending. The remedy is
   *            configuration, not retry — either bind a number this account
   *            owns, or send through a Messaging Service whose sender pool
   *            contains one. Retrying only burns quota and delays the
   *            operator action.
   *            (Basis: the operator-reported error text and the account
   *            ownership semantics. The installed client — twilio 5.13.1 —
   *            does not define server-side error codes locally, so the code
   *            is classified from the provider's documented behaviour rather
   *            than from a local constant.)
   *
   * SMS carrier codes:
   *   30005 — Unknown handset. The destination carrier returned a permanent
   *            rejection. For international long-code SMS (e.g. Pakistan Jazz),
   *            this indicates carrier-level filtering that cannot be retried.
   *   30008 — Unknown error — permanent carrier delivery failure with no retry path.
   */
  private static nonRetriableErrorCodes = new Set([
    20003, // Authentication Error
    21211, // Invalid 'To' Phone Number
    21215, // Geo-Permission denied (e.g. voice/SMS to Pakistan blocked by account settings)
    21408, // Permission to send an SMS has not been enabled for the region
    21614, // To number is not a valid mobile number
    21610, // Message cannot be sent to unverified number (Trial accounts)
    21659, // 'From' number is not a valid/owned sender id — permanent sender-configuration failure
    30005, // Unknown handset — permanent carrier rejection (incl. international long-code SMS)
    30007, // Carrier violation (A2P filter)
    30008, // Unknown permanent carrier failure
  ]);

  static isNonRetriableError(err: any): boolean {
    if (err && typeof err.code === 'number') {
      return this.nonRetriableErrorCodes.has(err.code);
    }
    return false;
  }

  /**
   * Build the Twilio Messages API payload for an outbound SMS.
   *
   * Extracted so the sender-selection contract can be asserted directly:
   *
   *   - A Messaging Service SID takes precedence and is sent ALONE. A
   *     `from` and a `messagingServiceSid` are mutually exclusive in the
   *     Messages API, so sending both is a conflict.
   *   - Without a Messaging Service SID, the resolved `from` is used. That
   *     number must be one this account owns — a Messaging Service cannot
   *     make an unowned number a valid sender, it only selects a configured
   *     sender pool.
   */
  static buildSendSmsPayload(
    params: SendSmsParams,
    env: { messagingServiceSid?: string } = {}
  ): Record<string, unknown> {
    const requestPayload: Record<string, unknown> = {
      to: params.to,
      body: params.body,
    };

    const msid = params.messagingServiceSid || env.messagingServiceSid;
    if (msid) {
      requestPayload.messagingServiceSid = msid;
    } else if (params.from) {
      requestPayload.from = params.from;
    }

    if (params.mediaUrl && params.mediaUrl.length > 0) {
      requestPayload.mediaUrl = params.mediaUrl;
    }

    return requestPayload;
  }

  /**
   * Classify a failed send into the three outcomes the queue must distinguish.
   *
   *   'accepted'  — Twilio returned a MessageSid. The message exists.
   *   'rejected'  — Twilio (or the network) answered definitively: the
   *                 message was NOT created. Safe to retry.
   *   'ambiguous' — the request was dispatched but no answer was obtained. A
   *                 timeout or a connection reset does NOT prove that Twilio
   *                 failed to create the message; it may have been created and
   *                 merely not acknowledged in time. Re-dispatching such a
   *                 message risks delivering a SECOND copy to the customer,
   *                 so it must not be retried blindly.
   *
   * The distinction is deliberately conservative: only a definitive answer
   * from the far end (or a failure to ever reach it) is treated as
   * 'rejected'.
   */
  static isAmbiguousSendOutcome(err: any): boolean {
    if (!err) return false;
    // Our own bound (see `withTimeout`).
    if (err.isTimeout === true) return true;
    // A socket-level timeout: the request may have reached Twilio.
    if (typeof err.code === 'string' && err.code === 'ETIMEDOUT') return true;
    // HTTP 408/504 from an intermediary.
    if (err.status === 408 || err.status === 504) return true;
    // Twilio's own "request timed out" code (20404) — the request may still
    // have been processed by Twilio.
    if (err.code === 20404) return true;
    // The connection was established and then broke: the request may have
    // been fully transmitted.
    if (typeof err.code === 'string' && ['ECONNRESET', 'EPIPE', 'ENOTREADY'].includes(err.code)) {
      return true;
    }
    return false;
  }

  /**
   * True when the failure happened BEFORE the request could reach the
   * provider, so the provider definitely did not create the message.
   */
  static isDefinitivePreDispatchFailure(err: any): boolean {
    if (!err || TwilioClientWrapper.isAmbiguousSendOutcome(err)) return false;
    if (typeof err.code === 'string' && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code)) {
      return true;
    }
    return false;
  }

  static async sendSms(params: SendSmsParams): Promise<{ sid: string; status: string }> {
    const env = getEnv();

    // Fail closed BEFORE the API call when there is no usable sender. Sending
    // a payload with neither `from` nor `messagingServiceSid` produces a
    // confusing provider error and, in the queue, a pointless retry cycle.
    // The check runs before the mock handler so it applies to every path.
    const requestPayload = TwilioClientWrapper.buildSendSmsPayload(params, {
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    });
    if (!requestPayload.from && !requestPayload.messagingServiceSid) {
      const err: any = new Error(
        'No outbound SMS sender: no messagingServiceSid is configured and no from number was resolved. ' +
          'Bind a service number this Twilio account owns, or configure TWILIO_MESSAGING_SERVICE_SID.',
      );
      err.code = 21659;
      err.isNonRetriable = true;
      err.status = 400;
      Logger.error('Twilio send refused before dispatch: no usable sender', {
        to: maskPhone(params.to),
        code: 21659,
        isNonRetriable: true,
      });
      throw err;
    }

    if (this.mockSendHandler) {
      return await this.mockSendHandler(params);
    }

    const client = this.getClient();

    try {
      Logger.info(`Executing Twilio Messages API call to ${maskPhone(params.to)}`);
      const result = await withTimeout(
        client.messages.create(requestPayload as any),
        TWILIO_SEND_TIMEOUT_MS,
        'Twilio Messages API call',
      );
      return { sid: result.sid, status: result.status };
    } catch (err: any) {
      const code = err.code || 'UNKNOWN_TWILIO_ERROR';
      const status = err.status || 500;
      const isNonRetriable = this.isNonRetriableError(err);

      Logger.error(`Twilio API Error [Code: ${code}, HTTP ${status}]: ${err.message}`, {
        to: maskPhone(params.to),
        from: params.from,
        code,
        isNonRetriable,
      });

      // Attach metadata to error object for caller handling
      err.isNonRetriable = isNonRetriable;
      throw err;
    }
  }
}
