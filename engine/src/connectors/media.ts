import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

export class MediaServerConnector {
  /**
   * Fetch short-lived signed S3 URL from Media Server / AWS S3 Bucket (Spec §3, §4 & §6).
   *
   * HOW MMS MEDIA IS SENT VIA S3 BUCKET:
   * 1. Hydroponic camera units upload snapshot photos to the AWS S3 bucket (`AWS_S3_BUCKET_NAME`).
   * 2. The Media Server (`MEDIA_SERVER_URL` / `S3_MEDIA_BUCKET_URL`) generates a presigned URL.
   * 3. CST receives the presigned S3 URL and passes it as `media_url` to Twilio's Messages API.
   * 4. Twilio fetches the photo directly from S3 and delivers it as an MMS image message.
   * 5. CST holds ZERO raw media binary files locally — only URL references.
   */
  static async getSignedMediaUrl(unitId: string = 'unit_bay_04'): Promise<string> {
    const env = getEnv();
    const mediaBaseUrl = env.MEDIA_SERVER_URL;
    const s3BucketUrl = env.S3_MEDIA_BUCKET_URL;

    Logger.info(`Media Server Connector: Requesting signed S3 photo URL for unit ${unitId} via ${mediaBaseUrl}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const response = await fetch(`${mediaBaseUrl}/api/v1/captures/latest?unit_id=${unitId}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeoutId);

      if (response && response.ok) {
        const data = await response.json() as any;
        if (data.signed_url) {
          return data.signed_url;
        }
      }
    } catch (err: any) {
      Logger.warn(`Media Server API fetch fallback: ${err.message}`);
    }

    // Direct AWS S3 Bucket URL format per Spec §3 & §4
    return `${s3BucketUrl}/units/${unitId}/latest_snap.jpg`;
  }
}
