import twilio from 'twilio';
import { getEnv } from '../../config/env.js';
import { Logger } from '../../config/logger.js';

export interface SendSmsParams {
  to: string;
  from?: string;
  messagingServiceSid?: string;
  body: string;
  mediaUrl?: string[];
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

  static async sendSms(params: SendSmsParams): Promise<{ sid: string; status: string }> {
    if (this.mockSendHandler) {
      return await this.mockSendHandler(params);
    }

    const env = getEnv();
    const client = this.getClient();

    const requestPayload: any = {
      to: params.to,
      body: params.body,
    };

    if (params.from) {
      requestPayload.from = params.from;
    } else if (params.messagingServiceSid || env.TWILIO_MESSAGING_SERVICE_SID) {
      requestPayload.messagingServiceSid = params.messagingServiceSid || env.TWILIO_MESSAGING_SERVICE_SID;
    }

    if (params.mediaUrl && params.mediaUrl.length > 0) {
      requestPayload.mediaUrl = params.mediaUrl;
    }

    try {
      Logger.info(`Executing Twilio Messages API call to ${params.to}`);
      const result = await client.messages.create(requestPayload);
      return { sid: result.sid, status: result.status };
    } catch (err: any) {
      const code = err.code || 'UNKNOWN_TWILIO_ERROR';
      const status = err.status || 500;
      const isNonRetriable = this.isNonRetriableError(err);

      Logger.error(`Twilio API Error [Code: ${code}, HTTP ${status}]: ${err.message}`, {
        to: params.to,
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
