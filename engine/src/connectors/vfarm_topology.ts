/**
 * vFarm Device Dependency Topology Engine
 *
 * Implements deterministic dependency graph resolution and runtime health evaluation
 * for vertical farm hardware using live schemas and relationships from `.openapi-vfarm.json`.
 *
 * Architecture & Relationship Contracts:
 *   1. Hardware Hierarchy (Parent Chain):
 *      load (e.g. pump_valve_01) → actuator/relay channel (relay_m1_1) →
 *      relay module (relay_module_01) → controller (uno_board_01) → gateway (pi_gateway_01).
 *      A load cannot operate normally if any upstream parent in its physical power/control
 *      chain is offline, unhealthy, or disconnected.
 *
 *   2. Environmental Colocation (Spatial Sensor Grouping):
 *      Loads and actuators deployed at a location_id / sublocation_id (e.g. rack tray tier)
 *      depend on the telemetry from sensors operating in that same spatial boundary
 *      (e.g. rack1_soil, rack1_ph, rack1_mq7, rack2_dht, RACK1_TANK, RACK1_WTEMP).
 *
 *   3. Deterministic Health Evaluation:
 *      Uses `computeDependentDeviceStatus` from `engine/src/connectors/vfarm.ts`:
 *      - Fails safe to DEGRADED on empty, missing, stale, degraded, or timed out sensors.
 *      - Evaluates to NORMAL only when all required sensors AND upstream parents are online.
 */

import { computeDependentDeviceStatus, type DependentDeviceStatus, type SensorState } from './vfarm.js';
import type { DeviceResponse } from '../adapters/vfarm/schemas.js';

export interface DeviceTopologyNode {
  device_id: string;
  device_type: string;
  device_model?: string | null;
  zone_id?: string | null;
  location_id?: string | null;
  sublocation_id?: string | null;
  parent_device_id?: string | null;
  parent_chain: string[];
  required_sensors: string[];
  parent_statuses: Record<string, string>;
  sensor_statuses: Record<string, SensorState>;
  computed_status: DependentDeviceStatus;
  reasons: string[];
}

export interface FarmTopologyReport {
  farm_id: string;
  evaluated_at: string;
  total_devices: number;
  dependent_devices_count: number;
  normal_count: number;
  degraded_count: number;
  devices: DeviceTopologyNode[];
}

/**
 * Normalizes device status from vFarm API fields into canonical state strings.
 */
function normalizeDeviceStatus(device?: DeviceResponse | null): string {
  if (!device) return 'missing';
  if (device.is_active === false) return 'inactive';
  if (device.fleet_status) return String(device.fleet_status).toLowerCase();
  if ((device as any).status) return String((device as any).status).toLowerCase();
  if ((device as any).state) return String((device as any).state).toLowerCase();
  return 'unknown';
}

/**
 * Maps raw device status / telemetry recency into strict SensorState.
 */
function normalizeSensorState(sensor?: DeviceResponse | null): SensorState {
  if (!sensor) return 'missing';
  const status = normalizeDeviceStatus(sensor);
  if (status === 'offline') return 'offline';
  if (status === 'unhealthy' || status === 'fault') return 'degraded';

  // Stale detection: if reading is older than 24 hours (86,400,000 ms)
  const lastTime = sensor.last_reading_at || sensor.last_seen_at;
  if (lastTime) {
    const elapsedMs = Date.now() - new Date(lastTime).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs > 24 * 60 * 60 * 1000) {
      return 'stale';
    }
  }

  if (status === 'online' || status === 'ok' || status === 'normal') {
    return 'online';
  }

  return 'degraded';
}

/**
 * Resolves the full dependency topology and evaluates health for all devices on a farm.
 */
export function evaluateFarmTopology(devices: DeviceResponse[], farmId: string): FarmTopologyReport {
  const devicesById = new Map<string, DeviceResponse>();
  for (const dev of devices) {
    if (dev.id) {
      devicesById.set(dev.id, dev);
    }
  }

  // Group sensors by spatial context (sublocation_id and location_id)
  const sensorsBySublocation = new Map<string, DeviceResponse[]>();
  const sensorsByLocation = new Map<string, DeviceResponse[]>();
  const sensorsByParent = new Map<string, DeviceResponse[]>();
  const allSensors: DeviceResponse[] = [];

  for (const dev of devices) {
    const isSensor = dev.device_type === 'sensor' || (dev.sensor_type_id && dev.device_type !== 'load');
    if (isSensor) {
      allSensors.push(dev);
      if (dev.sublocation_id) {
        const subList = sensorsBySublocation.get(dev.sublocation_id) || [];
        subList.push(dev);
        sensorsBySublocation.set(dev.sublocation_id, subList);
      }
      if (dev.location_id) {
        const locList = sensorsByLocation.get(dev.location_id) || [];
        locList.push(dev);
        sensorsByLocation.set(dev.location_id, locList);
      }
      if (dev.parent_device_id) {
        const parentList = sensorsByParent.get(dev.parent_device_id) || [];
        parentList.push(dev);
        sensorsByParent.set(dev.parent_device_id, parentList);
      }
    }
  }

  const nodes: DeviceTopologyNode[] = [];
  let normalCount = 0;
  let degradedCount = 0;

  for (const dev of devices) {
    const devType = (dev.device_type || 'unknown').toLowerCase();
    const isDependent = devType === 'load' || devType === 'actuator' || devType === 'relay';

    // 1. Trace parent chain (physical/power hierarchy)
    const parentChain: string[] = [];
    const parentStatuses: Record<string, string> = {};
    const visited = new Set<string>([dev.id]);
    let current = dev;
    let parentsAllOnline = true;
    const reasons: string[] = [];

    while (current.parent_device_id && !visited.has(current.parent_device_id)) {
      const parentId = current.parent_device_id;
      parentChain.push(parentId);
      visited.add(parentId);
      const parent = devicesById.get(parentId);
      if (!parent) {
        parentStatuses[parentId] = 'missing';
        parentsAllOnline = false;
        reasons.push(`Upstream parent device ${parentId} is missing from active inventory`);
        break;
      }

      const pStatus = normalizeDeviceStatus(parent);
      parentStatuses[parentId] = pStatus;
      if (pStatus !== 'online' && pStatus !== 'on') {
        parentsAllOnline = false;
        reasons.push(`Upstream parent ${parent.device_type || 'device'} ${parentId} is ${pStatus}`);
      }
      current = parent;
    }

    // 2. Identify required monitoring sensors
    const requiredSensorsMap = new Map<string, DeviceResponse>();

    if (isDependent) {
      // (a) Colocated sensors in the same sublocation (rack tier/tray)
      if (dev.sublocation_id && sensorsBySublocation.has(dev.sublocation_id)) {
        for (const s of sensorsBySublocation.get(dev.sublocation_id)!) {
          requiredSensorsMap.set(s.id, s);
        }
      }
      // (b) Colocated sensors in the same location (rack frame) if sublocation yielded none
      if (requiredSensorsMap.size === 0 && dev.location_id && sensorsByLocation.has(dev.location_id)) {
        for (const s of sensorsByLocation.get(dev.location_id)!) {
          requiredSensorsMap.set(s.id, s);
        }
      }
      // (c) Sensors attached to the same root controller as this load's relay
      if (requiredSensorsMap.size === 0 && parentChain.length > 0) {
        const rootParent = parentChain[parentChain.length - 1];
        if (sensorsByParent.has(rootParent)) {
          for (const s of sensorsByParent.get(rootParent)!) {
            requiredSensorsMap.set(s.id, s);
          }
        }
      }
      // (d) Domain-specific water pump / liquid sensors fallback (RACK1_TANK, RACK1_WTEMP)
      if (dev.id.includes('pump') || dev.id.includes('valve')) {
        for (const s of allSensors) {
          if (s.id.includes('TANK') || s.id.includes('WTEMP') || s.id.includes('soil')) {
            requiredSensorsMap.set(s.id, s);
          }
        }
      }
    }

    const requiredSensors = Array.from(requiredSensorsMap.keys());
    const sensorStatuses: Record<string, SensorState> = {};
    const sensorStateList: SensorState[] = [];

    for (const sensorId of requiredSensors) {
      const sensorObj = requiredSensorsMap.get(sensorId);
      const state = normalizeSensorState(sensorObj);
      sensorStatuses[sensorId] = state;
      sensorStateList.push(state);
      if (state !== 'online') {
        reasons.push(`Required sensor ${sensorId} is ${state}`);
      }
    }

    // 3. Compute dependent device status using computeDependentDeviceStatus
    let computedStatus: DependentDeviceStatus;
    if (isDependent) {
      if (!parentsAllOnline) {
        computedStatus = 'DEGRADED';
      } else {
        // Evaluate sensor dependencies
        computedStatus = computeDependentDeviceStatus(sensorStateList);
        if (computedStatus === 'DEGRADED' && reasons.length === 0) {
          reasons.push('Dependent device has zero verified online sensors (fails safe)');
        }
      }

      if (computedStatus === 'NORMAL') {
        normalCount++;
      } else {
        degradedCount++;
      }
    } else {
      // Non-dependent devices evaluate by their own state
      const selfStatus = normalizeDeviceStatus(dev);
      computedStatus = (selfStatus === 'online' || selfStatus === 'on') ? 'NORMAL' : 'DEGRADED';
      if (computedStatus === 'DEGRADED') {
        reasons.push(`Device is ${selfStatus}`);
        degradedCount++;
      } else {
        normalCount++;
      }
    }

    nodes.push({
      device_id: dev.id,
      device_type: dev.device_type || 'unknown',
      device_model: dev.device_model || null,
      zone_id: dev.zone_id || null,
      location_id: dev.location_id || null,
      sublocation_id: dev.sublocation_id || null,
      parent_device_id: dev.parent_device_id || null,
      parent_chain: parentChain,
      required_sensors: requiredSensors,
      parent_statuses: parentStatuses,
      sensor_statuses: sensorStatuses,
      computed_status: computedStatus,
      reasons: reasons,
    });
  }

  const dependentCount = nodes.filter((n) => {
    const t = n.device_type.toLowerCase();
    return t === 'load' || t === 'actuator' || t === 'relay';
  }).length;

  return {
    farm_id: farmId,
    evaluated_at: new Date().toISOString(),
    total_devices: devices.length,
    dependent_devices_count: dependentCount,
    normal_count: normalCount,
    degraded_count: degradedCount,
    devices: nodes,
  };
}
