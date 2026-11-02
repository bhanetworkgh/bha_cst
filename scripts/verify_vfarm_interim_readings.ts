import 'dotenv/config';
import {
  resolveSensorPlacement,
  VfarmLiveClient,
} from '../engine/src/adapters/vfarm/live_client.js';

const SENSOR_IDS = ['rack1_soil', 'rack1_ph', 'rack2_dht', 'rack1_mq7'] as const;
let stage = 'configuration';

function errorState(error: any) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    http_status: typeof error?.status === 'number' ? error.status : null,
  };
}

async function main() {
  const baseUrl = process.env.VFARM_BASE_URL;
  if (!baseUrl) throw new Error('VFARM_BASE_URL is required');

  const client = new VfarmLiveClient({
    baseUrl,
    apiKey: process.env.VFARM_FARM_KEY,
    apiToken: process.env.VFARM_JWT,
    timeoutMs: 5000,
  });

  let token = process.env.VFARM_JWT;
  if (!token && process.env.VFARM_ADMIN_EMAIL && process.env.VFARM_ADMIN_PASSWORD) {
    stage = 'authentication';
    const login = await client.login(
      process.env.VFARM_ADMIN_EMAIL,
      process.env.VFARM_ADMIN_PASSWORD,
    );
    token = login.token;
    client.setApiToken(token);
  }

  stage = 'farm_discovery';
  const farms = await client.listFarms(token);
  let farmId: string | null = null;
  let devices: any[] = [];
  const discoveryErrors: Record<string, unknown> = {};

  for (const farm of farms.farms) {
    try {
      stage = 'device_discovery';
      const response = await client.listAllDevices(farm.id);
      const candidateDevices = response.devices ?? [];
      const ids = new Set(candidateDevices.map((device) => device.id));
      if (SENSOR_IDS.every((sensorId) => ids.has(sensorId))) {
        farmId = farm.id;
        devices = candidateDevices;
        break;
      }
    } catch (error) {
      discoveryErrors[farm.id] = errorState(error);
    }
  }

  if (!farmId) {
    console.log(JSON.stringify({
      verification: 'BLOCKED',
      reason: 'No accessible farm contained all four required sensors',
      discovery_errors: discoveryErrors,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const results = [];
  for (const sensorId of SENSOR_IDS) {
    const sensor = devices.find((device) => device.id === sensorId);
    const placement = resolveSensorPlacement(sensor, devices);
    const startedAt = performance.now();
    try {
      stage = `sensor_reading:${sensorId}`;
      const reading = await client.getLatestReading(sensorId);
      const latencyMs = Math.round(performance.now() - startedAt);
      const readingTime = reading?.reading_ts ? Date.parse(reading.reading_ts) : Number.NaN;
      const ageMs = Number.isFinite(readingTime) ? Date.now() - readingTime : null;
      const values = reading?.values ?? {};
      const hasDisplayableValue = Object.values(values).some((entry) => entry.value !== null && entry.value !== undefined);
      const validTimestamp = Number.isFinite(readingTime) && ageMs !== null && ageMs >= -300000;
      results.push({
        sensor_id: sensorId,
        device_type: sensor.device_type ?? null,
        resolved_cabinet: placement.cabinet_id,
        placement_hierarchy: placement,
        reading_timestamp: reading?.reading_ts ?? null,
        received_at: reading?.received_at ?? null,
        age_ms: ageMs,
        stale_24h: ageMs === null ? null : ageMs > 24 * 60 * 60 * 1000,
        api_latency_ms: latencyMs,
        error_state: null,
        selection_contract: reading?.cst_selection_contract ?? null,
        values: reading ? values : null,
        safe_to_display: Boolean(reading && validTimestamp && hasDisplayableValue),
      });
    } catch (error) {
      results.push({
        sensor_id: sensorId,
        device_type: sensor.device_type ?? null,
        resolved_cabinet: placement.cabinet_id,
        placement_hierarchy: placement,
        reading_timestamp: null,
        received_at: null,
        age_ms: null,
        stale_24h: null,
        api_latency_ms: Math.round(performance.now() - startedAt),
        error_state: errorState(error),
        selection_contract: null,
        values: null,
        safe_to_display: false,
      });
    }
  }

  const cabinet = devices.find((device) => device.id === 'VFARM-CAB-001');
  console.log(JSON.stringify({
    verification: results.every((result) => result.safe_to_display) ? 'PASS' : 'PARTIAL',
    farm_id: farmId,
    cabinet: cabinet ? {
      id: cabinet.id,
      name: cabinet.name ?? cabinet.device_name ?? null,
      cabinet_serial: cabinet.cabinet_serial ?? cabinet.serial_number ?? null,
      physical_label: cabinet.physical_label ?? null,
    } : null,
    sensors: results,
  }, null, 2));

  if (results.some((result) => result.error_state)) process.exitCode = 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    verification: 'BLOCKED',
    stage,
    error_state: errorState(error),
  }, null, 2));
  process.exitCode = 2;
});
