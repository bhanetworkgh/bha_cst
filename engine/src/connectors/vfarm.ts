import { getEnv } from '../config/env.js';
import { Logger } from '../config/logger.js';

export interface VfarmUnitStatus {
  unit_id: string;
  farm_id: string;
  status: 'normal' | 'warning' | 'fault' | 'telemetry_unavailable';
  water_temp_c?: number;
  ph_level?: number;
  ec_level?: number;
  water_level?: 'normal' | 'low' | 'critical';
  last_updated: string;
}

export class VfarmConnector {
  /**
   * Fetch live unit status and sensor telemetry from vFarm Telemetry / Read APIs (Spec §4 & §6).
   * Uses caller's resolved farm_id and unit_id to enforce multi-tenancy isolation.
   * Includes workspaceKey, farm_id, and unit_id in API payloads instead of sending a bare { "query": question }.
   */
  static async getUnitStatus(
    customerRef: string,
    unitContext?: Record<string, unknown>,
    workspaceKey?: string,
    question?: string
  ): Promise<{ text: string; telemetry?: VfarmUnitStatus }> {
    const env = getEnv();
    const farmId = unitContext?.farm_id as string | undefined;
    const unitId = unitContext?.unit_id as string | undefined;

    if (!farmId || !unitId) {
      return {
        text: 'Your phone number is not linked to an active vFarm unit. Please contact support or provide your unit ID.',
        telemetry: {
          unit_id: unitId || 'unbound',
          farm_id: farmId || 'unbound',
          status: 'telemetry_unavailable',
          last_updated: new Date().toISOString(),
        },
      };
    }

    const wsKey = workspaceKey || env.BHARAG_WORKSPACE_KEY;
    const query = question || `What is the current status and telemetry of unit ${unitId} at farm ${farmId}?`;

    const clusterUrl = env.BHARAG_CLUSTER_URL;
    const clusterKey = env.BHARAG_CLUSTER_KEY;

    Logger.info(`vFarm Telemetry Connector: Querying status for unit ${unitId} (${farmId}) for actor ${customerRef}`);

    try {
      const controller = new AbortController();
      const timeoutMs = env.BHARAG_CLUSTER_TIMEOUT_MS || 10000;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const payload = {
        query,
        workspaceKey: wsKey,
        farm_id: farmId,
        unit_id: unitId,
      };

      const response = await fetch(clusterUrl, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': clusterKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => null);

      clearTimeout(timeoutId);

      if (response && response.ok) {
        const data = (await response.json()) as any;
        if (data.status && data.status !== 'telemetry_unavailable') {
          const telemetry: VfarmUnitStatus = {
            unit_id: data.unit_id || unitId,
            farm_id: data.farm_id || farmId,
            status: data.status,
            water_temp_c: data.water_temp_c != null ? Number(data.water_temp_c) : undefined,
            ph_level: data.ph_level != null ? Number(data.ph_level) : undefined,
            ec_level: data.ec_level != null ? Number(data.ec_level) : undefined,
            water_level: data.water_level,
            last_updated: data.last_updated || new Date().toISOString(),
          };

          const readings: string[] = [];
          if (telemetry.water_temp_c !== undefined) readings.push(`Water Temp: ${telemetry.water_temp_c}°C`);
          if (telemetry.ph_level !== undefined) readings.push(`pH: ${telemetry.ph_level}`);
          if (telemetry.ec_level !== undefined) readings.push(`EC: ${telemetry.ec_level}`);
          if (telemetry.water_level !== undefined) readings.push(`Water Level: ${telemetry.water_level}`);

          const readingsText = readings.length > 0 ? `. ${readings.join(', ')}.` : '.';

          return {
            text: `vFarm Unit ${telemetry.unit_id} (${telemetry.farm_id}) Status: ${telemetry.status.toUpperCase()}${readingsText}`,
            telemetry,
          };
        }

        if (data.answer) {
          const lower = data.answer.toLowerCase();
          const lacksInfo = lower.includes("don't have enough information") ||
                            lower.includes("not enough information") ||
                            lower.includes("does not include any specific current readings") ||
                            lower.includes("does not include any current sensor readings");
          if (!lacksInfo) {
            return { text: data.answer };
          }
        }
      }
    } catch (err: any) {
      Logger.warn(`vFarm live telemetry API fetch fallback: ${err.message}`);
    }

    // Degraded fallback when live telemetry endpoints are unreachable or data is unavailable.
    // Explicitly avoids returning synthetic or false-confidence sensor readings.
    const telemetry: VfarmUnitStatus = {
      unit_id: unitId,
      farm_id: farmId,
      status: 'telemetry_unavailable',
      last_updated: new Date().toISOString(),
    };

    const formattedText = `vFarm Unit ${unitId} (${farmId}): Telemetry currently unavailable for this unit. Live sensor readings cannot be retrieved at this time.`;

    return { text: formattedText, telemetry };
  }
}
