import { Logger } from '../config/logger.js';
import type { SpeakerIdentity } from '../core/types.js';
import type { IdentityContext } from '../transport/twilio/types.js';
import { CoreRegistry } from '../core/registry.js';
import { VfarmTenantAdapter, VfarmAuthorizationError } from '../adapters/vfarm/index.js';

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

function parseNumericField(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function mapLatestReadingToTelemetry(
  farmId: string,
  unitId: string,
  reading: {
    reading_ts?: string;
    received_at?: string;
    temperature_c?: unknown;
    humidity_rh?: unknown;
    error_code?: string | null;
    error_message?: string | null;
  },
): VfarmUnitStatus {
  const hasError = Boolean(reading.error_code || reading.error_message);
  const temp = parseNumericField(reading.temperature_c);
  const humidity = parseNumericField(reading.humidity_rh);

  let status: VfarmUnitStatus['status'] = 'normal';
  if (hasError) {
    status = 'fault';
  } else if (temp != null && (temp < 10 || temp > 35)) {
    status = 'warning';
  }

  return {
    unit_id: unitId,
    farm_id: farmId,
    status,
    water_temp_c: temp,
    ph_level: humidity,
    last_updated: reading.reading_ts || reading.received_at || new Date().toISOString(),
  };
}

function formatTelemetryText(telemetry: VfarmUnitStatus): string {
  const readings: string[] = [];
  if (telemetry.water_temp_c !== undefined) readings.push(`Water Temp: ${telemetry.water_temp_c}°C`);
  if (telemetry.ph_level !== undefined) readings.push(`Humidity: ${telemetry.ph_level}%`);
  if (telemetry.ec_level !== undefined) readings.push(`EC: ${telemetry.ec_level}`);
  if (telemetry.water_level !== undefined) readings.push(`Water Level: ${telemetry.water_level}`);
  const readingsText = readings.length > 0 ? `. ${readings.join(', ')}.` : '.';
  return `vFarm Unit ${telemetry.unit_id} (${telemetry.farm_id}) Status: ${telemetry.status.toUpperCase()}${readingsText}`;
}

export class VfarmConnector {
  /**
   * Fetch live unit status from the vFarm read API when a resolved speaker identity
   * is available. Never falls back to BHARAG cluster for farm-specific telemetry
   * (KMG9: LOOP-1788044070647). On any upstream failure or missing live client,
   * returns a safe unavailable response with status telemetry_unavailable.
   */
  static async getUnitStatus(
    customerRef: string,
    unitContext?: Record<string, unknown>,
    _workspaceKey?: string,
    _question?: string,
    speaker?: SpeakerIdentity | IdentityContext,
  ): Promise<{ text: string; telemetry?: VfarmUnitStatus; httpStatus?: number }> {
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

    if (speaker) {
      const tenantId = speaker.tenant_id || ('organization_id' in speaker ? (speaker as IdentityContext).organization_id : undefined);
      if (tenantId) {
        const adapter = CoreRegistry.getAdapter(tenantId);
        if (adapter instanceof VfarmTenantAdapter && adapter.hasLiveClient()) {
          try {
            const speakerIdentity: SpeakerIdentity = 'phone_e164' in speaker
              ? (speaker as SpeakerIdentity)
              : {
                  person_id: speaker.customer_ref,
                  customer_ref: speaker.customer_ref,
                  tenant_id: tenantId,
                  project_id: speaker.project_id || 'proj-vfarm-main',
                  phone_e164: '',
                  is_known: speaker.is_known_customer,
                  role: speaker.role,
                  permissions: speaker.permissions as any,
                  farm_ids: farmId ? [farmId] : [],
                };
            const reading = await adapter.getLatestDeviceReading({
              farmId,
              deviceId: unitId,
              speaker: speakerIdentity,
            });
            const telemetry = mapLatestReadingToTelemetry(farmId, unitId, reading);
            Logger.info(
              `vFarm Telemetry Connector: live reading for unit ${unitId} (${farmId}) actor ${customerRef}`,
            );
            return { text: formatTelemetryText(telemetry), telemetry };
          } catch (err: any) {
            if (err instanceof VfarmAuthorizationError) {
              Logger.warn(`vFarm telemetry refused for ${customerRef}: ${err.message}`);
              return {
                text: 'You do not have access to telemetry for the requested farm or device.',
                httpStatus: 403,
                telemetry: {
                  unit_id: unitId,
                  farm_id: farmId,
                  status: 'telemetry_unavailable',
                  last_updated: new Date().toISOString(),
                },
              };
            }
            // vFarm upstream failure (timeout, 5xx, network) — fail closed.
            // KMG9: NEVER fall back to the BHARAG cluster path for farm-specific
            // telemetry. Return a safe unavailable response instead.
            Logger.warn(`vFarm live telemetry path failed (fail-closed, no BHARAG fallback): ${(err as Error).message}`, {
              unit_id: unitId,
              farm_id: farmId,
              customer_ref: customerRef,
            });
          }
        } else {
          // No live vFarm client configured for this tenant — KMG9: do not query
          // BHARAG. Return telemetry_unavailable so the caller never receives
          // cross-tenant or fabricated sensor data.
          Logger.warn(`vFarm telemetry unavailable for ${customerRef}: no live client for tenant ${tenantId} (fail-closed, no BHARAG fallback)`, {
            unit_id: unitId,
            farm_id: farmId,
          });
        }
      }
    }

    Logger.infra({
      message: 'vFarm telemetry unavailable: live adapter not configured or upstream call failed',
      commercial_impact: 'Customer cannot receive live sensor data for this unit. No cross-tenant or BHARAG-derived data is returned.',
      meta: { unit_id: unitId, farm_id: farmId, customer_ref: customerRef },
    });

    const telemetry: VfarmUnitStatus = {
      unit_id: unitId,
      farm_id: farmId,
      status: 'telemetry_unavailable',
      last_updated: new Date().toISOString(),
    };

    return {
      text: `vFarm Unit ${unitId} (${farmId}): Telemetry currently unavailable for this unit. Live sensor readings cannot be retrieved at this time.`,
      telemetry,
    };
  }
}