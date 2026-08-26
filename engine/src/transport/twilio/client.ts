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

    if (params.messagingServiceSid || env.TWILIO_MESSAGING_SERVICE_SID) {
      requestPayload.messagingServiceSid = params.messagingServiceSid || env.TWILIO_MESSAGING_SERVICE_SID;
    } else if (params.from) {
      requestPayload.from = params.from;
    }

    if (params.mediaUrl && params.mediaUrl.length > 0) {
      requestPayload.mediaUrl = params.mediaUrl;
    }

    Logger.info(`Executing Twilio Messages API call to ${params.to}`);
    const result = await client.messages.create(requestPayload);
    return { sid: result.sid, status: result.status };
  }
}
