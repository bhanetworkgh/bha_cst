import { describe, it, expect } from 'vitest';
import { selectTelemetrySensor } from '../../web/admin.js';

describe('Admin Dashboard Telemetry Device Selection (LOOP-1794738235750-262P / LOOP-1793620799001-3NBE)', () => {
  it('directly imports and exercises the production implementation from web/admin.js', () => {
    expect(typeof selectTelemetrySensor).toBe('function');
  });

  // Case A — Sensor and pump both exist
  it('Case A: selects sensor when sensor and pump both exist, never selecting the pump', () => {
    const devices = [
      { id: 'water_pump_01', name: 'Water pump', device_type: 'load' },
      { id: 'rack1_soil', name: 'Soil Moisture', device_type: 'sensor' },
    ];
    const selected = selectTelemetrySensor(devices);
    expect(selected).toBe('rack1_soil');
    expect(selected).not.toBe('water_pump_01');
  });

  // Case B — Pump appears before the sensor (matching live vFarm inventory order)
  it('Case B: selects sensor even when pump and controller precede it (does not select devices[0])', () => {
    const devices = [
      { id: 'pump_valve_01', name: 'Pump valve', device_type: 'load' },
      { id: 'relay_m3_1', name: 'Relay Actuator', device_type: 'actuator' },
      { id: 'uno_board_01', name: 'UNO Controller', device_type: 'controller' },
      { id: 'rack1_mq7', name: 'MQ07 CO Sensor', device_type: 'sensor' },
    ];
    const selected = selectTelemetrySensor(devices);
    expect(selected).toBe('rack1_mq7');
    expect(selected).not.toBe(devices[0].id);
    expect(selected).not.toBe('pump_valve_01');
  });

  // Case C — No sensor exists (only loads, actuators, controllers)
  it('Case C: returns null and does NOT silently fall back to devices[0] when no sensor exists', () => {
    const devices = [
      { id: 'pump_valve_01', name: 'Pump valve', device_type: 'load' },
      { id: 'relay_module_01', name: 'Relay Module', device_type: 'actuator' },
      { id: 'uno_board_01', name: 'UNO Board', device_type: 'controller' },
    ];
    const selected = selectTelemetrySensor(devices);
    // Must return null — never fallback to devices[0] / pump_valve_01
    expect(selected).toBeNull();
  });

  // Case D — Empty inventory
  it('Case D: returns null on empty or invalid inventory', () => {
    expect(selectTelemetrySensor([])).toBeNull();
    expect(selectTelemetrySensor(null as any)).toBeNull();
    expect(selectTelemetrySensor(undefined as any)).toBeNull();
  });

  // Case E — Sensor ordering across multiple sensors and non-sensors
  it('Case E: consistently returns the first sensor and never non-sensors', () => {
    const devices = [
      { id: 'led_light_01', name: 'LED light', device_type: 'load' },
      { id: 'relay_m2_1', name: 'Relay 1', device_type: 'actuator' },
      { id: 'rack1_mq7', name: 'MQ07 CO Sensor', device_type: 'sensor' },
      { id: 'rack1_soil', name: 'Soil Moisture', device_type: 'sensor' },
      { id: 'rack1_ph', name: 'pH Sensor', device_type: 'sensor' },
      { id: 'rack2_dht', name: 'Temp/Humidity', device_type: 'sensor' },
    ];
    const selected = selectTelemetrySensor(devices);
    expect(selected).toBe('rack1_mq7');
    expect(selected).not.toBe('led_light_01');
    expect(selected).not.toBe('relay_m2_1');
  });
});
