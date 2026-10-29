# E2E Capture Template — CST Voice Acceptance

**Run ID:** ____________  
**Date/time (UTC):** ____________  
**Environment:** staging / production  
**Deployed SHA:** ____________  
**Operator:** ____________  
**Approval reference:** ____________

---

## 1. Call Identity

| Field | Value |
|-------|-------|
| Call SID / correlation ID | ____________ |
| Incoming destination (Twilio number) | ____________ (masked) |
| Caller reference | ____________ (masked) |
| Call start (UTC) | ____________ |
| Call end (UTC) | ____________ |
| Total duration (ms) | ____________ |

## 2. Identity Resolution

| Field | Value |
|-------|-------|
| CST tenant_id | ____________ |
| CST project_id | ____________ |
| vFarm organization reference | ____________ |
| vFarm person_id | ____________ (masked) |
| Role | owner / manager / tech / unknown |
| Farm IDs granted | ____________ |
| Authorization result | granted / denied / fail-closed |
| Resolution method | CoreRegistry.resolveSpeaker() → VfarmTenantAdapter |

## 3. vFarm Upstream Calls

### Device Discovery
| Field | Value |
|-------|-------|
| Endpoint | `GET /api/v1/devices?farm_id={farmId}` |
| HTTP status | ___ |
| Duration (ms) | ___ |
| Device count | ___ |
| Error (if any) | ____________ |

### Per-Sensor Readings
| Sensor ID | Endpoint | HTTP Status | Duration (ms) | Raw Values | Mapped CST Fields | Used in Response? |
|-----------|----------|-------------|---------------|------------|-------------------|-------------------|
| __________ | `GET /api/v1/readings/latest?sensor_id=...` | ___ | ___ | __________ | __________ | Yes/No |

### Farm Health
| Field | Value |
|-------|-------|
| Endpoint | `GET /api/v1/farms/{farmId}/health` |
| HTTP status | ___ |
| Duration (ms) | ___ |
| Farm status | ____________ |
| Device counts | total: ___ online: ___ offline: ___ unhealthy: ___ |

## 4. Voice Response

| Field | Value |
|-------|-------|
| Voice intent recognized | ____________ |
| Actual caller-facing response | ____________ |
| Greeting spoken | Yes/No |
| Greeting method | `<Play>` / `<Say>` fallback |
| Audio ID (if <Play>) | ____________ |
| Response latency (ms) | ___ |
| 7,000 ms deadline met | Yes/No |

## 5. Persistence

| Field | Value |
|-------|-------|
| Conversation turn persisted | Yes/No |
| Conversation ID | ____________ |
| Message ID | ____________ |
| Security/audit log entry exists | Yes/No |
| Security ledger correlation_id | ____________ |

## 6. Verbatim Sanitized Log Excerpts

```
[Paste exact Render log lines with UTC timestamps here]
```

## 7. Expected vs Actual Result

| Expected | Actual | Match? |
|----------|--------|--------|
| Caller identity resolved via vFarm | ____________ | Yes/No |
| Farm grant verified | ____________ | Yes/No |
| Per-unit readings retrieved | ____________ | Yes/No |
| Values spoken correctly | ____________ | Yes/No |
| Response < 7s | ____________ | Yes/No |
| Turn persisted | ____________ | Yes/No |
| Audit log created | ____________ | Yes/No |

## 8. Verdict

**PASS / FAIL / INCONCLUSIVE**

## 9. Evidence Links

- Render log query: ____________
- Database query (read-only): ____________
- Test results: ____________
- Screenshot filenames: ____________

## 10. Outstanding Blockers

| Blocker | Owner | Next Action |
|---------|-------|-------------|
| ____________ | ____________ | ____________ |
