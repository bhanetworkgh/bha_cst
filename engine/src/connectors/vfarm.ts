import { Logger } from '../config/logger.js';
import type { SpeakerIdentity } from '../core/types.js';
import type { IdentityContext } from '../transport/twilio/types.js';
import { CoreRegistry } from '../core/registry.js';
import { VfarmTenantAdapter, VfarmAuthorizationError } from '../adapters/vfarm/index.js';
import { recordFailure, isCapabilityDegraded, attemptRecovery } from '../recovery/self_healing_tracker.js';

export interface VfarmUnitStatus {
  unit_id: string;
  farm_id: string;
  status: 'normal' | 'warning' | 'fault' | 'telemetry_unavailable';
  water_temp_c?: number;
  humidity_rh?: number;
  ph_level?: number;
  ec_level?: number;
  water_level?: number;
  last_updated: string;
  /** True when the reading timestamp is older than the freshness threshold. */
  stale?: boolean;
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
    temperature_status?: string | null;
    humidity_rh?: unknown;
    humidity_status?: string | null;
    error_code?: string | null;
    error_message?: string | null;
    values?: Record<string, { unit?: string | null; value?: unknown; status?: string | null }>;
  },
): VfarmUnitStatus {
  const hasError = Boolean(reading.error_code || reading.error_message);
  // The actual sensor data lives in `values`, not in the top-level fields
  // (temperature_c / humidity_rh are null in almost every real reading).
  // Prefer `values`, fall back to the top-level fields for compatibility.
  const vals = reading.values || {};
  const tempVal = vals.temperature?.value ?? reading.temperature_c;
  const humVal = vals.humidity?.value ?? reading.humidity_rh;
  const phVal = vals.ph?.value;
  const coVal = vals.co?.value;
  const soilVal = vals.soil_moisture?.value;

  const temp = parseNumericField(tempVal);
  const humidity = parseNumericField(humVal);
  const ph = parseNumericField(phVal);
  const co = parseNumericField(coVal);
  const soil = parseNumericField(soilVal);

  // Status comes from vFarm's own status fields, not from locally invented
  // thresholds. Fall back to a range check only when vFarm did not supply one.
  let status: VfarmUnitStatus['status'] = 'normal';
  if (hasError) {
    status = 'fault';
  } else if (reading.temperature_status === 'warning' || reading.humidity_status === 'warning') {
    status = 'warning';
  } else if (temp != null && (temp < 10 || temp > 35)) {
    status = 'warning';
  }

  return {
    unit_id: unitId,
    farm_id: farmId,
    status,
    water_temp_c: temp,
    humidity_rh: humidity,
    ph_level: ph,
    ec_level: co,
    water_level: soil,
    last_updated: reading.reading_ts || reading.received_at || new Date().toISOString(),
    stale: (() => {
      const ts = reading.reading_ts || reading.received_at;
      if (!ts) return false;
      const age = Date.now() - new Date(ts).getTime();
      return Number.isFinite(age) && age > 24 * 60 * 60 * 1000;
    })(),
    // Preserve the upstream status fields for the response.
    ...(reading.temperature_status ? { temperature_status: reading.temperature_status } : {}),
    ...(reading.humidity_status ? { humidity_status: reading.humidity_status } : {}),
  };
}

function formatTelemetryText(telemetry: VfarmUnitStatus): string {
  const readings: string[] = [];
  if (telemetry.water_temp_c !== undefined) readings.push(`Temperature: ${telemetry.water_temp_c}°C`);
  if (telemetry.humidity_rh !== undefined) readings.push(`Humidity: ${telemetry.humidity_rh}%`);
  if (telemetry.ph_level !== undefined) readings.push(`pH: ${telemetry.ph_level}`);
  if (telemetry.ec_level !== undefined) readings.push(`CO: ${telemetry.ec_level}`);
  if (telemetry.water_level !== undefined) readings.push(`Soil Moisture: ${telemetry.water_level}%`);
  const readingsText = readings.length > 0 ? `. ${readings.join(', ')}.` : '.';
  const staleNote = telemetry.stale ? ' (reading is stale)' : '';
  return `vFarm Unit ${telemetry.unit_id} (${telemetry.farm_id}) Status: ${telemetry.status.toUpperCase()}${readingsText}${staleNote}`;
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

    if (!farmId) {
      // Nothing is known about the caller's farm. That IS a missing link.
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

    // ── Self-healing: degraded capability check ──────────────────────────────
    //
    // If the upstream has failed repeatedly for this scope, the capability
    // is marked degraded and we stop claiming live device data. We attempt a
    // bounded recheck (max 5, 1/min) using a probe that performs the actual
    // upstream call. Recovery succeeds only if the probe returns true.
    //
    // This is invoked here — on the next inbound message — because there is
    // no separate scheduler. The recheck rate limit prevents overload.
    const tenantId = speaker?.tenant_id || ('organization_id' in (speaker as any) ? (speaker as any).organization_id : undefined);
    const projectId = (speaker as any)?.project_id || 'unknown';
    if (tenantId && isCapabilityDegraded(tenantId, projectId, 'upstream_unavailable')) {
      const recovery = await attemptRecovery({
        tenantId,
        projectId,
        category: 'upstream_unavailable',
        probe: async () => {
          // The probe performs the actual upstream call. If it succeeds,
          // the capability is restored.
          const adapter = CoreRegistry.getAdapter(tenantId);
          if (!(adapter instanceof VfarmTenantAdapter) || !adapter.hasLiveClient()) return false;
          try {
            const health = await adapter.getFarmStatusForSpeaker({ farmId, speaker: speaker as any });
            return health !== null;
          } catch {
            return false;
          }
        },
      });
      if (!recovery.recovered) {
        // Still degraded. Do not claim live data.
        Logger.warn(`vFarm farm-level status: capability degraded for farm ${farmId} (recheck ${recovery.recheckCount})`);
        return {
          text: 'Farm data is temporarily unavailable. Please try again later.',
          telemetry: {
            unit_id: 'unbound',
            farm_id: farmId,
            status: 'telemetry_unavailable',
            last_updated: new Date().toISOString(),
          },
        };
      }
      // Recovery succeeded — fall through to the normal path.
    }

    if (!unitId) {
      // The caller HAS an authorized farm, but no unit binding.
      //
      // vFarm exposes no user -> device mapping, so a per-unit reading cannot
      // be attributed to a person. The FARM level, however, is fully readable
      // and fully scoped to a farm the caller is granted — so the answer is
      // given at farm level instead of refusing outright.
      //
      // The previous behaviour refused here ("not linked to an active vFarm
      // unit") even though the farm was known and authorized, which made the
      // system look broken to a correctly-identified customer.
      const tenantId = speaker?.tenant_id || ('organization_id' in (speaker as any) ? (speaker as any).organization_id : undefined);
      const adapter = tenantId ? CoreRegistry.getAdapter(tenantId) : null;
      // Narrow to the resolved SpeakerIdentity — the farm grant list lives on it.
      const speakerIdentity: SpeakerIdentity | null =
        speaker && 'phone_e164' in speaker
          ? (speaker as SpeakerIdentity)
          : speaker
            ? ({
                person_id: (speaker as any).customer_ref,
                customer_ref: (speaker as any).customer_ref,
                tenant_id: tenantId,
                project_id: (speaker as any).project_id || 'proj-vfarm-main',
                phone_e164: '',
                is_known: (speaker as any).is_known_customer,
                role: (speaker as any).role,
                permissions: (speaker as any).permissions as any,
                farm_ids: farmId ? [farmId] : [],
              } as SpeakerIdentity)
            : null;
      if (adapter instanceof VfarmTenantAdapter && adapter.hasLiveClient() && speakerIdentity) {
        try {
          const farmStatus = await adapter.getFarmStatusForSpeaker({ farmId, speaker: speakerIdentity });
          if (farmStatus) {
            const d = farmStatus.devices;
            const farmLabel = farmStatus.farm_name ? `Farm ${farmStatus.farm_name}` : `Farm ${farmId}`;
            const statusLabel = farmStatus.status ? farmStatus.status.toUpperCase() : 'UNKNOWN';

            // THE COUNTER RELATIONSHIP IS NOT DOCUMENTED UPSTREAM.
            // `DeviceListResponse` carries total / online_count / offline_count /
            // unhealthy_count with no descriptions, and on the live farm
            // `unhealthy_count` (10) EXCEEDS `offline_count` (6) — so the
            // unhealthy set overlaps the online/offline split and is NOT a
            // fourth disjoint category. Presenting the four numbers as a
            // partition ("19 online, 6 offline, 10 unhealthy" = 35 of 26) is
            // simply wrong.
            //
            // So: online/offline are reported as upstream reports them, the
            // remainder (if any) is named as its own bucket rather than
            // folded into online or offline, and "unhealthy" is phrased as a
            // flag on devices already counted ("of them"), never as extra
            // devices.
            const statusParts: string[] = [`${d.total} devices`];
            if (d.online) statusParts.push(`${d.online} online`);
            if (d.offline) statusParts.push(`${d.offline} offline`);
            const remainder = d.total - d.online - d.offline;
            if (remainder > 0) statusParts.push(`${remainder} with an unknown status`);

            const parts: string[] = [`${farmLabel}: status ${statusLabel}.`];
            parts.push(`${statusParts.join(', ')}.`);
            if (d.unhealthy > 0) {
              parts.push(`Of those, ${d.unhealthy} ${d.unhealthy === 1 ? 'is' : 'are'} flagged unhealthy.`);
            }

            // Open alerts for this farm (farm-scoped, authorized by the
            // speaker's grant list — re-checked inside the adapter). An empty
            // list is a real result and is reported as such; a failure is
            // reported honestly rather than silently dropped.
            let alertText = '';
            try {
              const alerts = await adapter.getFarmAlertsForSpeaker({ farmId, speaker: speakerIdentity, limit: 5 });
              if (alerts) {
                if (alerts.total === 0) {
                  alertText = 'No open alerts.';
                } else {
                  const lines = alerts.alerts.map((a) => `${a.severity.toUpperCase()}: ${a.title} (${a.device_id})`);
                  alertText = `${alerts.total} open alert${alerts.total === 1 ? '' : 's'}: ${lines.join('; ')}.`;
                }
              }
            } catch (err: any) {
              Logger.warn(`vFarm farm-level alerts failed for farm ${farmId}: ${err?.message}`);
              alertText = 'Alerts could not be retrieved at this time.';
            }
            if (alertText) parts.push(alertText);

            Logger.info(
              `vFarm Telemetry Connector: farm-level status for farm ${farmId} (total=${d.total}, online=${d.online}, offline=${d.offline}, notReported=${remainder}, unhealthy=${d.unhealthy}, alerts=${alertText || 'n/a'})`,
            );

            // ── Per-unit readings for the authorized farm ──────────────────────
            // When the caller is granted the farm but has no specific unit
            // binding, vFarm's `listLatestReadings(farmId)` returns the latest
            // reading for every sensor/device in that farm. We fetch these and
            // report them per-unit rather than leaving the caller with only
            // aggregate counts. No BHARAG fallback — vFarm is the only source.
            let perUnitReadings: Array<{
              unit_id: string;
              farm_id: string;
              status: 'normal' | 'warning' | 'fault' | 'telemetry_unavailable';
              water_temp_c?: number;
              humidity_rh?: number;
              ph_level?: number;
              ec_level?: number;
              water_level?: number;
              last_updated: string;
              stale?: boolean;
            }> = [];
            try {
              const readings = await adapter.listLatestReadings?.({ farmId, speaker: speakerIdentity });
              if (readings && Array.isArray(readings) && readings.length > 0) {
                perUnitReadings = readings
                  .filter((r: any) => r && (r.sensor_id || r.device_id))
                  .map((r: any) => {
                    const reading = mapLatestReadingToTelemetry(farmId, String(r.sensor_id || r.device_id), r);
                    return {
                      unit_id: reading.unit_id,
                      farm_id: reading.farm_id,
                      status: reading.status,
                      water_temp_c: reading.water_temp_c,
                      humidity_rh: reading.humidity_rh,
                      ph_level: reading.ph_level,
                      ec_level: reading.ec_level,
                      water_level: reading.water_level,
                      last_updated: reading.last_updated,
                      stale: reading.stale,
                    };
                  });
                }
              } catch (err: any) {
              // Per-unit readings are additive: if they fail, we still report
              // the farm-level aggregate above and note the limitation honestly.
              Logger.warn(`vFarm per-unit readings failed for farm ${farmId}: ${err?.message}`);
            }

            // Build the per-unit readings text block.
            let unitReadingsText = '';
            if (perUnitReadings.length > 0) {
              const lines = perUnitReadings.map((r) => {
                const parts: string[] = [`Unit ${r.unit_id}: status ${r.status.toUpperCase()}`];
                const vals: string[] = [];
                if (r.water_temp_c !== undefined) vals.push(`Temperature: ${r.water_temp_c}°C`);
                if (r.humidity_rh !== undefined) vals.push(`Humidity: ${r.humidity_rh}%`);
                if (r.ph_level !== undefined) vals.push(`pH: ${r.ph_level}`);
                if (r.ec_level !== undefined) vals.push(`CO: ${r.ec_level}`);
                if (r.water_level !== undefined) vals.push(`Soil Moisture: ${r.water_level}%`);
                if (vals.length > 0) parts.push(vals.join(', '));
                if (r.stale) parts.push('(reading is stale)');
                return parts.join(' — ');
              });
              unitReadingsText = ` Per-unit readings: ${lines.join('; ')}.`;
            } else {
              unitReadingsText = ' No per-unit readings are available at this time.';
            }

            return {
              text: `${parts.join(' ')}${unitReadingsText}`,
              telemetry: {
                unit_id: 'unbound',
                farm_id: farmId,
                status:
                  farmStatus.status === 'critical' || farmStatus.status === 'fault'
                    ? 'fault'
                    : farmStatus.status === 'warning'
                      ? 'warning'
                      : 'normal',
                last_updated: new Date().toISOString(),
              },
            };
          }
        } catch (err: any) {
          if (err instanceof VfarmAuthorizationError) {
            // Authorization denial is a real refusal, not a system failure.
            // Record it as a failure for the self-healing tracker, but do
            // not mark the capability degraded — the upstream is working,
            // the caller is just not authorized.
            recordFailure({
              tenantId: tenantId || 'unknown',
              projectId: (speaker as any)?.project_id || 'unknown',
              category: 'authorization_denied',
              correlationRef: customerRef || 'unknown',
            });
            Logger.warn(`vFarm farm-level status refused for ${customerRef}: ${err.message}`);
            return {
              text: 'You do not have access to telemetry for the requested farm or device.',
              httpStatus: 403,
              telemetry: {
                unit_id: 'unbound',
                farm_id: farmId,
                status: 'telemetry_unavailable',
                last_updated: new Date().toISOString(),
              },
            };
          }
          // Upstream failure (timeout, 5xx, network, malformed response).
          // Record it for the self-healing tracker. After 3 failures in 10
          // minutes the capability is marked degraded and stops claiming
          // live device data.
          const category = /timeout/i.test(String(err?.message)) ? 'upstream_timeout' : 'upstream_unavailable';
          recordFailure({
            tenantId: tenantId || 'unknown',
            projectId: (speaker as any)?.project_id || 'unknown',
            category,
            correlationRef: customerRef || 'unknown',
          });
          Logger.warn(`vFarm farm-level status failed for farm ${farmId}: ${err?.message}`);
        }
      }
      return {
        text: 'Your phone number is not linked to an active vFarm unit. Please contact support or provide your unit ID.',
        telemetry: {
          unit_id: 'unbound',
          farm_id: farmId,
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
            if (!reading) {
              // No readings for this device. That is a real, honest result —
              // not an upstream failure and not a fabricated value.
              Logger.info(`vFarm Telemetry Connector: no readings for unit ${unitId} (${farmId})`);
              return {
                text: `vFarm Unit ${unitId} (${farmId}): No sensor readings are available for this unit at this time.`,
                telemetry: {
                  unit_id: unitId,
                  farm_id: farmId,
                  status: 'telemetry_unavailable',
                  last_updated: new Date().toISOString(),
                },
              };
            }
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