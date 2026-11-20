import { describe, it, expect } from 'vitest';
import { evaluateFarmTopology } from '../../engine/src/connectors/vfarm_topology.js';
import type { DeviceResponse } from '../../engine/src/adapters/vfarm/schemas.js';

describe('vFarm Device Dependency Topology Engine', () => {
  const farmId = '21dde23e-f7f6-46bc-9b54-e97fabaaafd7';

  // Realistic mock device set based on live vFarm devices
  const createMockDevices = (overrides?: Partial<DeviceResponse>[]): DeviceResponse[] => {
    const base: Partial<DeviceResponse>[] = [
      // Controllers / Gateways
      { id: 'pi_gateway_01', device_type: 'gateway', status: 'online' as any, parent_device_id: null },
      { id: 'uno_board_01', device_type: 'controller', status: 'online' as any, parent_device_id: null },
      // Relay Modules
      { id: 'relay_module_01', device_type: 'actuator', status: 'online' as any, parent_device_id: 'uno_board_01' },
      // Relay Channels
      { id: 'relay_m1_1', device_type: 'actuator', status: 'online' as any, parent_device_id: 'relay_module_01' },
      // Loads
      {
        id: 'pump_valve_01',
        device_type: 'load',
        status: 'online' as any,
        parent_device_id: 'relay_m1_1',
        sublocation_id: 'subloc-tier-1',
        location_id: 'loc-rack-01',
      },
      // Sensors
      {
        id: 'rack1_soil',
        device_type: 'sensor',
        status: 'online' as any,
        parent_device_id: 'uno_board_01',
        sublocation_id: 'subloc-tier-1',
        location_id: 'loc-rack-01',
        last_reading_at: new Date().toISOString(),
      },
      {
        id: 'rack1_ph',
        device_type: 'sensor',
        status: 'online' as any,
        parent_device_id: 'uno_board_01',
        sublocation_id: 'subloc-tier-1',
        location_id: 'loc-rack-01',
        last_reading_at: new Date().toISOString(),
      },
    ];

    if (overrides) {
      for (const override of overrides) {
        const idx = base.findIndex((d) => d.id === override.id);
        if (idx >= 0) {
          base[idx] = { ...base[idx], ...override };
        } else {
          base.push(override);
        }
      }
    }

    return base as DeviceResponse[];
  };

  it('evaluates dependent load as NORMAL when all parent devices and required sensors are online', () => {
    const devices = createMockDevices();
    const report = evaluateFarmTopology(devices, farmId);

    expect(report.farm_id).toBe(farmId);
    expect(report.total_devices).toBe(devices.length);
    expect(report.dependent_devices_count).toBe(3); // relay_module_01, relay_m1_1, pump_valve_01

    const pumpNode = report.devices.find((d) => d.device_id === 'pump_valve_01');
    expect(pumpNode).toBeDefined();
    expect(pumpNode?.computed_status).toBe('NORMAL');
    expect(pumpNode?.parent_chain).toEqual(['relay_m1_1', 'relay_module_01', 'uno_board_01']);
    expect(pumpNode?.required_sensors).toContain('rack1_soil');
    expect(pumpNode?.required_sensors).toContain('rack1_ph');
    expect(pumpNode?.reasons).toHaveLength(0);
  });

  it('evaluates dependent load as DEGRADED when an upstream parent relay is offline', () => {
    const devices = createMockDevices([
      { id: 'relay_module_01', status: 'offline' as any, fleet_status: 'offline' },
    ]);
    const report = evaluateFarmTopology(devices, farmId);

    const pumpNode = report.devices.find((d) => d.device_id === 'pump_valve_01');
    expect(pumpNode?.computed_status).toBe('DEGRADED');
    expect(pumpNode?.reasons.some((r) => r.includes('relay_module_01 is offline'))).toBe(true);
  });

  it('evaluates dependent load as DEGRADED when an upstream root controller is offline', () => {
    const devices = createMockDevices([
      { id: 'uno_board_01', status: 'offline' as any, fleet_status: 'offline' },
    ]);
    const report = evaluateFarmTopology(devices, farmId);

    const pumpNode = report.devices.find((d) => d.device_id === 'pump_valve_01');
    expect(pumpNode?.computed_status).toBe('DEGRADED');
    expect(pumpNode?.reasons.some((r) => r.includes('uno_board_01 is offline'))).toBe(true);
  });

  it('evaluates dependent load as DEGRADED when a required colocated sensor is offline', () => {
    const devices = createMockDevices([
      { id: 'rack1_soil', status: 'offline' as any, fleet_status: 'offline' },
    ]);
    const report = evaluateFarmTopology(devices, farmId);

    const pumpNode = report.devices.find((d) => d.device_id === 'pump_valve_01');
    expect(pumpNode?.computed_status).toBe('DEGRADED');
    expect(pumpNode?.sensor_statuses['rack1_soil']).toBe('offline');
    expect(pumpNode?.reasons.some((r) => r.includes('rack1_soil is offline'))).toBe(true);
  });

  it('evaluates dependent load as DEGRADED when a sensor reading is stale (>24h)', () => {
    const staleDate = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(); // 36 hours ago
    const devices = createMockDevices([
      { id: 'rack1_ph', status: 'online' as any, last_reading_at: staleDate },
    ]);
    const report = evaluateFarmTopology(devices, farmId);

    const pumpNode = report.devices.find((d) => d.device_id === 'pump_valve_01');
    expect(pumpNode?.computed_status).toBe('DEGRADED');
    expect(pumpNode?.sensor_statuses['rack1_ph']).toBe('stale');
    expect(pumpNode?.reasons.some((r) => r.includes('rack1_ph is stale'))).toBe(true);
  });

  it('fails safe to DEGRADED when an upstream parent device is missing from active inventory', () => {
    const devices: DeviceResponse[] = [
      { id: 'orphan_pump', device_type: 'load', status: 'online' as any, parent_device_id: 'unregistered_relay' } as any,
    ];
    const report = evaluateFarmTopology(devices, farmId);

    const orphanNode = report.devices.find((d) => d.device_id === 'orphan_pump');
    expect(orphanNode?.computed_status).toBe('DEGRADED');
    expect(orphanNode?.reasons.some((r) => r.includes('unregistered_relay is missing'))).toBe(true);
  });
});
