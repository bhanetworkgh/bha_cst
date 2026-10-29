# vFarm API — Read-Only cURL Commands

All commands use environment variables. **Never hardcode credentials.**
Replace `$VFARM_API_BASE_URL`, `$VFARM_FARM_KEY`, and `$VFARM_JWT` with your actual values (loaded from `.env` or set in your shell).

```bash
# ── 1. Login (get JWT token) ────────────────────────────────────────────────
curl -s -X POST \
  "$VFARM_API_BASE_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"<YOUR_EMAIL>","password":"<YOUR_PASSWORD>"}'

# ── 2. List devices for a farm ──────────────────────────────────────────────
curl -s \
  -H "X-Farm-Key: $VFARM_FARM_KEY" \
  -H "Authorization: Bearer $VFARM_JWT" \
  "$VFARM_API_BASE_URL/api/v1/devices?farm_id=v-farm"

# ── 3. Get latest reading for a single sensor ───────────────────────────────
curl -s \
  -H "X-Farm-Key: $VFARM_FARM_KEY" \
  -H "Authorization: Bearer $VFARM_JWT" \
  "$VFARM_API_BASE_URL/api/v1/readings/latest?sensor_id=rack1_mq7"

# ── 4. Get readings properties for a farm (metadata) ────────────────────────
curl -s \
  -H "X-Farm-Key: $VFARM_FARM_KEY" \
  -H "Authorization: Bearer $VFARM_JWT" \
  "$VFARM_API_BASE_URL/api/v1/readings/properties?farm_id=v-farm"

# ── 5. Get farm health (aggregate) ─────────────────────────────────────────
curl -s \
  -H "X-Farm-Key: $VFARM_FARM_KEY" \
  -H "Authorization: Bearer $VFARM_JWT" \
  "$VFARM_API_BASE_URL/api/v1/farms/v-farm/health"

# ── 6. Verify the readings/latest endpoint requires sensor_id (not farm_id) ─
# This should return a 422 validation error:
curl -s -w "\nHTTP_STATUS:%{http_code}\n" \
  -H "X-Farm-Key: $VFARM_FARM_KEY" \
  -H "Authorization: Bearer $VFARM_JWT" \
  "$VFARM_API_BASE_URL/api/v1/readings/latest?farm_id=v-farm&limit=100"
```

## Loading credentials from .env (without printing them)

```bash
# Source .env in your shell (values stay in environment, not printed)
set -a
source .env
set +a

# Verify vars are set (prints only lengths, not values)
echo "VFARM_API_BASE_URL length: ${#VFARM_API_BASE_URL}"
echo "VFARM_FARM_KEY length: ${#VFARM_FARM_KEY}"
echo "VFARM_JWT length: ${#VFARM_JWT}"
```

## Expected Response Shapes

### Devices list (`GET /api/v1/devices?farm_id=v-farm`)
```json
{
  "devices": [
    {"id": "rack1_mq7", "device_type": "sensor", "status": "online", "last_seen_at": "2026-10-29T..."},
    {"id": "relay_m1_1", "device_type": "actuator", "status": "online", "last_seen_at": "2026-10-29T..."}
  ],
  "total": 23,
  "online_count": 19,
  "offline_count": 6
}
```

### Latest reading (`GET /api/v1/readings/latest?sensor_id=rack1_mq7`)
```json
{
  "sensor_id": "rack1_mq7",
  "reading_ts": "2026-10-29T13:45:49Z",
  "received_at": "2026-10-29T13:46:37.123Z",
  "temperature_c": null,
  "humidity_rh": null,
  "values": {
    "co": {"unit": "ppm", "value": 1.16, "status": "ok"}
  }
}
```

### No readings (`GET /api/v1/readings/latest?sensor_id=VFARM-CAB-001`)
```json
{"error": "error", "detail": "No readings found for sensor"}
```
HTTP 404

### Validation error (wrong param)
```json
{"error": "validation_error", "field": "query → sensor_id", "reason": "Field required"}
```
HTTP 422

## CST Telemetry Mapping

CST's `mapLatestReadingToTelemetry()` in `engine/src/connectors/vfarm.ts` maps:

| vFarm Field | CST Field | Spoken Label | Zero Preserved? |
|-------------|-----------|--------------|-----------------|
| `values.temperature.value` | `water_temp_c` | Temperature: X°C | Yes |
| `values.humidity.value` | `humidity_rh` | Humidity: X% | Yes |
| `values.ph.value` | `ph_level` | pH: X | Yes |
| `values.co.value` | `ec_level` | CO: X | Yes |
| `values.soil_moisture.value` | `water_level` | Soil Moisture: X% | Yes |
| `values.relay.value` | `relay` | Relay: ON/OFF | Yes |

Top-level `temperature_c` and `humidity_rh` are always null in the API response. CST correctly prefers `values.*.value`.

## Key Findings

1. **Device IDs ARE valid sensor IDs** — no separate mapping needed
2. **Relay values (0.0/1.0)** — now mapped (was previously dropped)
3. **Rack sensors are slow** — 29-43s per reading, exceeds 7s voice deadline (upstream vFarm performance issue)
4. **Relay sensors are fast** — ~0.7s each
5. **9 devices have no readings** (404) — cabinets, pumps, lights, modules
6. **Zero values preserved** — soil_moisture=0.0 correctly mapped, not treated as missing
7. **Stale readings flagged** — readings >24h old get "(reading is stale)" suffix
8. **No BHARAG fallback** — telemetry only from vFarm, never BHARAG

## Notes

- The `co` field maps to CO (carbon monoxide, ppm), NOT EC (electrical conductivity). The CST field name `ec_level` is misleading but the spoken label "CO" is correct.
- Rack sensors (rack1_mq7, rack1_soil, rack1_ph, rack2_dht) and gateways (pi_gateway_01, uno_board_01) take 29-43s — far exceeding the 7s voice deadline. CST handles this gracefully by timing out and reporting available readings.
- The `listLatestReadings` fix (list devices first, then fetch per-sensor) is in the working tree but NOT committed or deployed.
