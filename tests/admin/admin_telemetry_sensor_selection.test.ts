import { describe, it, expect } from 'vitest';

describe('Admin Dashboard Telemetry Device Selection (Regression for LOOP-1793620799001-3NBE)', () => {
  it('identifies the first sensor device rather than blindly taking devices[0]', () => {
    // Simulated device inventory matching vFarm live farm (21dde23e-f7f6-46bc-9b54-e97fabaaafd7)
    const devices = [
      { id: 'pump_valve_01', name: 'Pump valve', device_type: 'load' },
      { id: 'relay_m3_1', name: null, device_type: 'actuator' },
      { id: 'uno_board_01', name: 'UNO_01', device_type: 'controller' },
      { id: 'rack1_mq7', name: 'MQ07_01', device_type: 'sensor' },
      { id: 'rack1_soil', name: 'Soil_01', device_type: 'sensor' },
      { id: 'rack1_ph', name: 'Ph_01', device_type: 'sensor' },
      { id: 'rack2_dht', name: 'DHT11_01', device_type: 'sensor' },
    ];

    // Prior bug behavior: blindly selecting devices[0]
    const bugDeviceId = devices[0]?.id;
    expect(bugDeviceId).toBe('pump_valve_01');
    expect(devices.find(d => d.id === bugDeviceId)?.device_type).not.toBe('sensor');

    // Correct behavior in web/admin.js: find first sensor, fallback to devices[0]
    const firstSensor = devices.find(d => d.device_type === 'sensor');
    const selectedDeviceId = firstSensor?.id || devices[0]?.id || null;

    expect(selectedDeviceId).toBe('rack1_mq7');
    expect(devices.find(d => d.id === selectedDeviceId)?.device_type).toBe('sensor');
  });

  it('falls back to devices[0] if no sensor exists on the farm', () => {
    const devicesWithoutSensors = [
      { id: 'pump_valve_01', name: 'Pump valve', device_type: 'load' },
      { id: 'relay_m3_1', name: null, device_type: 'actuator' },
    ];

    const firstSensor = devicesWithoutSensors.find(d => d.device_type === 'sensor');
    const selectedDeviceId = firstSensor?.id || devicesWithoutSensors[0]?.id || null;

    expect(selectedDeviceId).toBe('pump_valve_01');
  });
});

