# CST ↔ Research Twin Integration Brief & Wire Specification

**To:** Destiny Arupi (Research Twin Owner)  
**From:** CST Engineering (`bhanetworkgh/bha_cst`)  
**Context:** Monitoring & Research Twin Contract v1.1.1 / DW-1793626498819-PDQ2 (Requirement D)  
**Production CST URL:** `https://bha-cst-7u9e.onrender.com`  
**Render Service ID:** `srv-db8hepqvcj2c73adpus0`  
**Date:** 2026-11-03  
**Status:** Code Complete & Tested (50/50 Tests Pass); Awaiting Wire Schema Confirmation & Test Callback  

---

## 1. Executive Summary & Current Production State

All adapter infrastructure, Zod 4 schemas, error taxonomy, and HMAC signature validation on the CST side are implemented and verified.

On live Render production (`GET https://bha-cst-7u9e.onrender.com/api/health`), CST currently reports:
```json
{
  "research_twin": {
    "state": "blocked",
    "operational": false,
    "contract": "unverified",
    "endpoint_configured": true,
    "service_api_key_configured": true,
    "callback_signing_secret_configured": true,
    "missing": [],
    "reason": "approved Research Twin API and callback contract is not verified"
  }
}
```

### Why `state` is currently `"blocked"`:
The credentials (`RT_ENDPOINT_URL`, `RT_SERVICE_API_KEY`, `RT_CALLBACK_SIGNING_SECRET`) are present on Render (`missing: []`). Per Jason's fail-closed monitoring agreement, CST holds outbound requests until you confirm the exact wire schemas and trigger **one signed test callback**. Once verified, CST automatically flips `state` to `"active"` (`operational: true`).

---

## 2. CST Outbound Specification (CST → Research Twin)

When a customer turn or anomaly triggers an investigation, CST makes an outbound HTTP request to your configured endpoint (`RT_ENDPOINT_URL`).

### Request Details
- **Method:** `POST`
- **URL:** `${RT_ENDPOINT_URL}` (e.g., `https://research-twin.bhanetwork.org/api/v1/investigate` or n8n webhook)
- **Headers:**
  ```http
  Content-Type: application/json
  X-Service-Key: <RT_SERVICE_API_KEY>
  X-Correlation-ID: <uuid-v4>
  X-Tenant-ID: <tenant-id>
  X-Signature-SHA256: <hex-encoded-hmac-of-body>
  ```

### Outbound Request Body Schema (`ResearchTwinOutboundPayload`)
```json
{
  "request_id": "rt_req_01HP8X9J2M3K4N5P6Q7R8S9T0U",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "farm_id": "21dde23e-f7f6-46bc-9b54-e97fabaaafd7",
  "incident_id": "inc_20261103_001",
  "priority": "high",
  "context": {
    "intent": "crop_stress_analysis",
    "caller_id": "cust_usr_01",
    "urgency": "high"
  },
  "telemetry": [
    {
      "sensor_id": "rack1_soil",
      "metric": "moisture_percent",
      "value": 18.2,
      "unit": "%",
      "recorded_at": "2026-11-03T15:00:00.000Z"
    },
    {
      "sensor_id": "rack2_dht",
      "metric": "temperature_celsius",
      "value": 31.4,
      "unit": "C",
      "recorded_at": "2026-11-03T15:00:00.000Z"
    }
  ],
  "callback_url": "https://bha-cst-7u9e.onrender.com/api/v1/research-twin/callback",
  "timestamp": "2026-11-03T15:00:05.123Z"
}
```

### Expected Synchronous Response from Research Twin
CST expects an HTTP `200 OK` or `202 Accepted` returning the authoritative external investigation ID:
```json
{
  "success": true,
  "research_twin_investigation_id": "rt_inv_99887766",
  "status": "queued",
  "estimated_completion_seconds": 30,
  "received_at": "2026-11-03T15:00:05.456Z"
}
```

---

## 3. Inbound Callback Specification (Research Twin → CST)

When your analysis completes, Research Twin posts findings back to CST's inbound webhook.

### Webhook Route & Authentication
- **Method:** `POST`
- **URL:** `https://bha-cst-7u9e.onrender.com/api/v1/research-twin/callback`
- **Security Header:** `X-Research-Twin-Signature`
  * Value: `sha256=<hex_hmac>` computed over the raw UTF-8 request body using `RT_CALLBACK_SIGNING_SECRET`.

### Inbound Callback Payload Schema (`ResearchTwinInboundCallback`)
```json
{
  "request_id": "rt_req_01HP8X9J2M3K4N5P6Q7R8S9T0U",
  "research_twin_investigation_id": "rt_inv_99887766",
  "status": "completed",
  "confidence_score": 0.94,
  "findings": [
    {
      "finding_id": "fnd_thermal_01",
      "category": "thermal_stress",
      "severity": "warning",
      "summary": "Root zone temperature elevated 3.2C above baseline."
    }
  ],
  "recommendations": [
    {
      "action": "increase_irrigation_cycle",
      "parameters": {
        "duration_minutes": 15
      },
      "requires_human_approval": true
    }
  ],
  "completed_at": "2026-11-03T15:00:25.789Z"
}
```

### CST Response
- If HMAC signature is valid and schema passes: **`HTTP 200 OK`**
  ```json
  {"status":"received","investigation_id":"rt_inv_99887766","processed_at":"2026-11-03T15:00:26.012Z"}
  ```
- If HMAC signature is invalid or missing: **`HTTP 401 Unauthorized`**
  ```json
  {"error":"INVALID_SIGNATURE","message":"HMAC signature verification failed."}
  ```

---

## 4. Error Classification & Retry Protocol

CST's `ResearchTwinClient` implements the following standardized HTTP error handling:

| HTTP Status | Category | CST Action |
|---|---|---|
| `400 Bad Request` | Client Payload Error | Rejects immediately; logs validation failure; no retry |
| `401 Unauthorized` | Key Mismatch | Logs alert tripwire; fail-closed; no retry |
| `403 Forbidden` | Tenant Scope Violation | Rejects; logs security audit event; no retry |
| `404 Not Found` | Unknown Farm/Incident | Dead-letters the request; notifies operator |
| `422 Unprocessable` | Semantic Schema Error | Logs validation errors; no retry |
| `429 Too Many Requests` | Rate Limited | Inspects `Retry-After` header; applies exponential backoff |
| `500 Internal Error` | Upstream Server Crash | Bounded retry (3 attempts with jitter) |
| `502 / 503 / 504` | Gateway / Timeout | Circuit breaker triggers; marks telemetry fallback |

---

## 5. Live Test Command for Destiny (Copy & Paste)

You can verify the callback path immediately from your terminal or n8n workflow using this bash snippet (replace `<RT_CALLBACK_SIGNING_SECRET>` with the shared secret):

```bash
SECRET="<RT_CALLBACK_SIGNING_SECRET>"
BODY='{"request_id":"rt_req_test_01","research_twin_investigation_id":"rt_inv_test_01","status":"completed","confidence_score":0.95,"findings":[{"finding_id":"fnd_01","category":"moisture","severity":"info","summary":"Moisture optimal"}],"recommendations":[],"completed_at":"2026-11-03T15:00:00Z"}'

# Compute HMAC-SHA256 signature
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

# Send signed callback to live Render service
curl -i -X POST "https://bha-cst-7u9e.onrender.com/api/v1/research-twin/callback" \
  -H "Content-Type: application/json" \
  -H "X-Research-Twin-Signature: sha256=$SIG" \
  -d "$BODY"
```

---

## 6. What CST Needs Back From You

To close Requirement D and enable live operations, please confirm:

1. **Schema Acceptance:** Do the `ResearchTwinOutboundPayload` and `ResearchTwinInboundCallback` schemas above match what your service / n8n workflow expects? If you need additional fields or different key names, let us know.
2. **Auth Header:** Does your endpoint accept `X-Service-Key: <key>` or do you prefer `Authorization: Bearer <key>`?
3. **Execution of 1 Signed Test:** Trigger one signed test callback (using the snippet above or your test runner) so we can capture the verified `HTTP 200` log in Render and mark Requirement D closed.

