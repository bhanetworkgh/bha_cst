import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

export class MediaServerConnector {
  /**
   * Fetch short-lived signed S3 URL from Media Server / AWS S3 Bucket (Spec §3, §4 & §6).
   */
  static async getSignedMediaUrl(unitId: string = 'unit_bay_04'): Promise<string> {
    const env = getEnv();
    const mediaBaseUrl = env.MEDIA_SERVER_URL;

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

    const s3BucketUrl = env.S3_MEDIA_BUCKET_URL || 'https://vfarm-media-captures.s3.us-east-1.amazonaws.com';
    return `${s3BucketUrl}/units/${unitId}/latest_snap.jpg`;
  }
}