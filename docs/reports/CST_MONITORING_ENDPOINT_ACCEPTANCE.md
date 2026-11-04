# CST Monitoring Endpoint Acceptance & Diagnostics

**Upstream Service:** vFarm API (`https://vfarm-api.internal` / configured upstream host)  
**Consumer:** CST Monitoring Layer & Customer Surface  
**Affected Files:**  
- `engine/src/adapters/vfarm/live_client.ts`  
- `engine/src/adapters/vfarm/health.ts`  
- `tests/adapters/vfarm_health_probe.test.ts`  
- `tests/integration/dashboard_e2e.test.ts`  
**Date:** 2026-11-03  

---

## 1. Upstream Endpoint Audit

CST's monitoring engine communicates with vFarm via three critical telemetry and health endpoints:

| Endpoint | Method | Purpose | Observed Production Status | CST Remediation |
|---|---|---|---|---|
| `/api/v1/farms/{id}/health` | `GET` | Upstream farm health | 200 OK (lacks `calculated_at`) | CST evaluates as `degraded` per Contract v1.1.1 |
| `/api/v1/alerts/threshold/counts` | `GET` | Active alert summary by level | 422 Unprocessable Entity (Missing `rung`) | **RESOLVED**: CST now supplies required `rung=farm` param |
| `/api/v1/readings/latest` | `GET` | Per-device latest sensor telemetry | 504 Gateway / 500 DB Statement Timeout | **ISOLATED**: Missing upstream database index |

---

## 2. Resolution of HTTP 422 on Alert Threshold Counts

### Root Cause
Upstream vFarm's Fastify/Pydantic validation schema requires the `rung` query parameter (allowed values: `farm`, `zone`, `location`, `sublocation`). In prior versions, CST called:
```text
GET /api/v1/alerts/threshold/counts?farm_id={farmId}
```
Because `rung` was omitted, vFarm returned:
```json
{
  "statusCode": 422,
  "error": "Unprocessable Entity",
  "message": "querystring must have required property 'rung'"
}
```

### Code Fix
In `engine/src/adapters/vfarm/live_client.ts:1049`:
```typescript
public async getAlertCounts(farmId: string, rung: string = 'farm'): Promise<AlertCountsResponse> {
  const params = new URLSearchParams({
    farm_id: farmId,
    rung: rung
  });
  return this.get<AlertCountsResponse>(`/api/v1/alerts/threshold/counts?${params.toString()}`);
}
```
This guarantees that all alert count queries pass validation.

---

## 3. Isolation of Upstream Timeout on Latest Sensor Readings

### Root Cause Analysis
During sensor telemetry polling for burn-in cabinets and greenhouse zones, `GET /api/v1/readings/latest?sensor_id={deviceId}` frequently triggers 5-second timeouts or database statement cancellations in vFarm.

Investigation into vFarm's query plan reveals:
- Table `readings` contains several million time-series records.
- Query: `SELECT * FROM readings WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1`.
- Upstream index state: An index exists on `recorded_at` alone, but **no composite index exists on `(device_id, recorded_at DESC)`**.
- As a result, PostgreSQL performs an expensive index scan over `recorded_at` with a row-level filter on `device_id`, causing statement timeouts under concurrent load.

### CST Client-Side Safeguards
To ensure that CST never crashes or hangs the customer voice/web interface:
1. **Bounded Timeout:** Per-device reading calls timeout strictly at 5,000 ms.
2. **Concurrency Limiter:** Concurrency is throttled to 5 concurrent device requests.
3. **Fail-Closed Fallback:** When a reading times out, CST maps the sensor state to `telemetry_unavailable` and marks the overall farm as `degraded` with an explicit notice to the operator.
4. **Action Request to Upstream:** A formal upstream ticket has been filed for Jegan to add:
   ```sql
   CREATE INDEX CONCURRENTLY idx_readings_device_recorded ON readings(device_id, recorded_at DESC);
   ```

---

## 4. Acceptance Status

- **Code-Level CST Client:** COMPLETE & VERIFIED. All unit and mock tests pass.
- **Upstream Production Readiness:** NOT READY — PENDING EXTERNAL EVIDENCE (vFarm index creation and `calculated_at` inclusion).

