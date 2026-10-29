# vFarm Device Readings Report

**Farm ID:** v-farm
**Total devices:** 23
**Devices with readings:** 8
**Devices without readings (404):** 9
**Devices timed out:** 4
**Timestamp:** 2026-10-29T13:55:57Z

## Devices with Readings (OK)

| Device ID | Type | Status | Latency | Values | Reading Timestamp |
|-----------|------|--------|---------|--------|-------------------|
| relay_m2_4 | actuator | online | 0.9s | relay=0.0  (ok) | 2026-09-08T11:00:46Z |
| relay_m2_3 | actuator | online | 0.8s | relay=0.0  (ok) | 2026-09-08T11:01:08Z |
| relay_m2_2 | actuator | online | 0.7s | relay=1.0  (ok) | 2026-09-08T11:59:52Z |
| relay_m2_1 | actuator | online | 1.0s | relay=0.0  (ok) | 2026-09-08T10:00:53Z |
| relay_m1_4 | actuator | online | 0.7s | relay=0.0  (ok) | 2026-09-08T10:12:43Z |
| relay_m1_3 | actuator | online | 0.8s | relay=0.0  (ok) | 2026-09-08T10:12:18Z |
| relay_m1_2 | actuator | online | 0.7s | relay=0.0  (ok) | 2026-09-08T10:59:09Z |
| relay_m1_1 | actuator | online | 0.7s | relay=0.0  (ok) | 2026-09-08T10:16:27Z |

## Devices Without Readings (HTTP 404)

| Device ID | Type | Status | Error |
|-----------|------|--------|-------|
| VFARM-CAB-001 | cabinet | unknown | No readings found for sensor |
| relay_m3_1 | actuator | online | No readings found for sensor |
| relay_module_03 | actuator | online | No readings found for sensor |
| vfarm-rover-01 | controller | online | No readings found for sensor |
| drain_pump_01 | load | online | No readings found for sensor |
| water_pump_01 | load | online | No readings found for sensor |
| led_light_01 | load | online | No readings found for sensor |
| relay_module_02 | actuator | online | No readings found for sensor |
| relay_module_01 | actuator | online | No readings found for sensor |

## Devices That Timed Out

| Device ID | Type | Status | Error |
|-----------|------|--------|-------|
| rack1_mq7 | sensor | online | Request timed out (>10s) |
| rack1_soil | sensor | online | Request timed out (>10s) |
| rack1_ph | sensor | online | Request timed out (>10s) |
| pi_gateway_01 | gateway | online | Request timed out (>10s) |

## Summary

- **Total devices:** 23
- **With readings:** 8
- **No readings (404):** 9
- **Timed out:** 4

## CST Telemetry Mapping

CST's `mapLatestReadingToTelemetry()` maps these upstream fields:

| vFarm Field | CST Field | Spoken Label |
|-------------|-----------|--------------|
| `values.temperature.value` | `water_temp_c` | Temperature: X°C |
| `values.humidity.value` | `humidity_rh` | Humidity: X% |
| `values.ph.value` | `ph_level` | pH: X |
| `values.co.value` | `ec_level` | CO: X |
| `values.soil_moisture.value` | `water_level` | Soil Moisture: X% |
| `values.relay.value` | `relay` | Relay: ON/OFF |

Top-level `temperature_c` and `humidity_rh` are always null in the API response. CST correctly prefers `values.*.value` over top-level fields.

## Notes

- Relay sensors (relay_m1_1..4, relay_m2_1..4) respond quickly (~0.7s) and return 0.0/1.0 values
- Rack sensors (rack1_mq7, rack1_soil, rack1_ph, rack2_dht) and gateways (pi_gateway_01, uno_board_01) take 29-43s — far exceeding the 7s voice deadline
- 9 devices have no readings at all (404)
- Zero values are preserved (not treated as missing)
- Stale readings (>24h) are flagged with '(reading is stale)'
- No BHARAG fallback for telemetry — vFarm is the only source