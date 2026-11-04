# CST Research Twin Contract Reconciliation & Schema Specification (v1.1.1)

**Contract Document:** Monitoring & Research Twin Contract v1.1.1  
**Partner System:** Research Twin (Owner: Destiny)  
**Consumer/Provider:** CST (Customer Service Twin)  
**Affected Files:**  
- `engine/src/research_twin/schemas.ts`  
- `engine/src/research_twin/errors.ts`  
- `engine/src/research_twin/client.ts`  
- `engine/src/research_twin/webhook.ts`  
- `engine/src/research_twin/index.ts`  
- `tests/research_twin/schemas.test.ts`  
- `tests/research_twin/client.test.ts`  
**Date:** 2026-11-03  

---

## 1. Context & Purpose

The Research Twin (RT) collaborates with CST to evaluate complex farm anomalies, perform multi-variable trend analyses, and recommend corrective interventions. Contract v1.1.1 formalizes the bidirectional communication protocol between CST and the Research Twin.

This document serves as the authoritative reconciliation artifact for Destiny, detailing the exact data schemas, HTTP headers, authentication mechanisms, and error classification implemented in CST.

---

## 2. CST Outbound Payload Specification

When CST triggers an analysis or telemetry evaluation request to the Research Twin:
- **HTTP Method:** `POST`
- **Target Route:** `/api/v1/research/analyze` (configured via `RESEARCH_TWIN_BASE_URL`)
- **Required Headers:**
  - `Content-Type: application/json`
  - `X-Service-Key: <RESEARCH_TWIN_SERVICE_KEY>`
  - `Authorization: Bearer <RESEARCH_TWIN_BEARER_TOKEN>` (if configured)
  - `X-Correlation-ID: <uuid>`
  - `X-Tenant-ID: <tenant_id>`
  - `X-Signature-SHA256: <hmac_hex>` (HMAC-SHA256 of request body using shared secret)

### Outbound JSON Schema:
```json
{
  "request_id": "rt_req_01HP8X...",
  "tenant_id": "tenant-vfarm-01",
  "project_id": "proj-vfarm-main",
  "farm_id": "farm-01",
  "incident_id": "inc_20261103_001",
  "context": {
    "intent": "crop_stress_analysis",
    "caller_id": "cust_usr_01",
    "urgency": "high"
  },
  "telemetry": [
    {
      "sensor_id": "sensor_temp_01",
      "metric": "temperature_celsius",
      "value": 31.4,
      "unit": "C",
      "recorded_at": "2026-11-03T12:00:00Z"
    }
  ],
  "callback_url": "https://bha-cst-7u9e.onrender.com/api/v1/research-twin/callback",
  "timestamp": "2026-11-03T12:00:05Z"
}
```

---

## 3. Inbound Callback & Signature Verification

Upon completing its analysis, the Research Twin posts results back to CST's inbound webhook:
- **HTTP Method:** `POST`
- **Route:** `/api/v1/research-twin/callback`
- **Authentication:** `X-Research-Twin-Signature` (HMAC-SHA256 of raw request body verified against `RESEARCH_TWIN_WEBHOOK_SECRET`).

### Inbound Callback JSON Schema:
```json
{
  "request_id": "rt_req_01HP8X...",
  "status": "completed",
  "confidence_score": 0.94,
  "findings": [
    {
      "finding_id": "fnd_01",
      "category": "thermal_stress",
      "severity": "warning",
      "summary": "Root zone temperature elevated by 3.2C above baseline."
    }
  ],
  "recommendations": [
    {
      "action": "increase_irrigation_cycle",
      "parameters": { "duration_minutes": 15 },
      "requires_human_approval": true
    }
  ],
  "completed_at": "2026-11-03T12:00:15Z"
}
```

---

## 4. HTTP Error Handling & Retry Protocol

CST's `ResearchTwinClient` implements a unified error taxonomy via `ResearchTwinHttpError`:

| Status Code | Error Classification | CST Behavior |
|---|---|---|
| `400 Bad Request` | Client Payload Error | Rejects immediately; logs validation failure; no retry |
| `401 Unauthorized` | Key Mismatch | Alerts operator; fail-closed; no retry |
| `403 Forbidden` | Tenant Scope Violation | Rejects; logs security ledger audit tripwire; no retry |
| `404 Not Found` | Unknown Farm/Incident | Marks task dead-lettered; notifies caller |
| `422 Unprocessable` | Semantic Schema Error | Logs validation error payload; no retry |
| `429 Too Many Requests`| Rate Limited | Inspects `Retry-After` header; performs exponential backoff |
| `500 Internal Error` | Upstream Server Crash | Bounded retry (max 3 attempts with jitter) |
| `502 / 503 / 504` | Gateway / Unavailable | Bounded retry with circuit breaker tripwire |

---

## 5. Verification & Test Evidence

All 50 unit and integration tests across Research Twin suites pass cleanly:
```bash
npx vitest run tests/research_twin/
# Results:
# ✓ tests/research_twin/schemas.test.ts (19 tests)
# ✓ tests/research_twin/client.test.ts (18 tests)
# ✓ tests/research_twin/lifecycle.test.ts (13 tests)
# Test Files  3 passed (3)
# Tests       50 passed (50)
```

**Status:** Ready for Destiny's review and bilateral signing.

