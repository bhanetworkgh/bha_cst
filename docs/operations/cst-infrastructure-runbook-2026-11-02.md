# CST Infrastructure Runbook — 2026-11-02

**Repository:** bhanetworkgh/bha_cst  
**Branch:** fix/vfarm-voice-status-reliability  
**HEAD:** 261b4b6328a8c6a47ef0042e992a878c717aba1e  
**Render service:** bha-cst (srv-db8hepqvcj2c73adpus0)  
**Render deployed SHA:** 78075b19757f (pre-fix, deployed 2026-10-28T20:59:14Z)

---

## 1. Service Configuration

| Field | Value |
|-------|-------|
| Service name | bha-cst |
| Service ID | srv-db8hepqvcj2c73adpus0 |
| Repository | bhanetworkgh/bha_cst |
| Production branch | main |
| Region | Oregon |
| Plan | Starter (0.5c-512mb) |
| Instance count | 1 |
| Health check | /health |
| Deployed SHA | 78075b19757f539b88098a97a46cfcbf7b7937c6 |
| Deployment timestamp | 2026-10-28T20:59:14.495714Z |
| Web-service ingress | 0.0.0.0/0 |

## 2. PostgreSQL Configuration

| Field | Value |
|-------|-------|
| Resource ID | dpg-db8he2qvcj2c73ado3s0-a |
| Database | bha_cst_1sh0 |
| Version | PostgreSQL 16.15 |
| Plan | 0.1c-256mb |
| Region | Oregon |
| Disk | 1 GB (autoscaling disabled) |
| HA | Disabled |
| Read replicas | None |
| Connection pool | None |
| Allowlist | 103.120.71.129/32 (tightened from 0.0.0.0/0) |
| Size | 9,719 kB |

## 3. Migration State

| Metric | Value |
|--------|-------|
| Repository migration files | 23 (001-022, including two with 003_ prefix) |
| Production schema_migrations rows | 22 |
| Latest migration | 022_add_escalations_table.sql (applied 2026-10-28T17:02:14Z) |
| Duplicate prefix files | 003_add_customers_and_security_ledger.sql, 003_customers_table.sql |
| Drifted files | 006, 010 (contents changed) |
| Applied | 0 (all 23 recorded, 0 applied in latest run) |
| Hypothesis | Duplicate 003_ prefix causes 23 files vs 22 rows discrepancy |

**Read-only query for reconciliation:**
```sql
SELECT version, name, checksum FROM schema_migrations ORDER BY version;
```

## 4. Error Catalog

### 4.1 Twilio Delivery Callback Attribution
- **Error:** `outbound_row_found=false`, `stored_tenant_id=null`, `stored_project_id=null`
- **Log:** "cst.delivery not published for SM...: tenancy unresolved (stored message row tenant_id=none, project_id=none; no outbound row for this MessageSid=yes)"
- **Affected:** 35 distinct Message SIDs, 105 refusal log entries
- **Fail-closed:** Working — dashboard publication refused when attribution unresolved
- **Root cause:** Historical messages pre-fix lack persisted provider_sid

### 4.2 vFarm Sensor Timeouts
- **Error:** "vFarm request timed out after 10000ms: /api/v1/readings/latest?sensor_id=rack1_mq7"
- **Affected sensors:** rack1_mq7, rack1_soil, rack1_ph, rack2_dht
- **Observed:** 10,000ms timeout (production) vs 5,000ms (Jason's contract)
- **Impact:** reading_count=0 for all voice turns

### 4.3 Voice Deadline (Historical)
- **Incident 1:** Correlation ID CA1decc8a2aead3400c684327ec30ff44d, 7,015ms, deadline 7,000ms
- **Incident 2:** Correlation ID CAfdc6ae536baf7dd1b2cbf5502adb3f20, 7,006ms, deadline 7,000ms
- **Discrepancy:** Logs said "abandoned and not persisted" but DB shows published outcomes for both
- **Current code:** 12,000ms default, 14,000ms max clamp (turn_deadline.ts)

### 4.4 Security Ledger (Resolved)
- **Pre-fix:** `SELECT count(*) FROM security_ledger` → 0
- **Post-fix:** Render logs confirm "Security ledger event recorded" for voice calls
- **Production evidence:** Correlation ID CA916aadd4aac4ebf7980c634be39838a0, 2026-10-30T17:01:42Z-17:03:07Z

## 5. Loop IDs

| Loop ID | Description | Status |
|---------|-------------|--------|
| LOOP-1792104121807-XXHH | bha-cst-postgres continuity | Open |
| LOOP-1793031575930-X4EI | KMG9 authorization evidence | Open |
| LOOP-1793031575927-LSJY | npm vulnerability packages | Open |
| LOOP-1793031575929-X6DK | /health post-deployment check | Partial |

## 6. Recovery Procedures

### Service Restart
- Render Dashboard → bha-cst → Manual Deploy → "Clear build cache & deploy"
- Not authorized without explicit approval

### Database Restore
- Backup artifact: 80,365 bytes, CUSTOM format, SHA-256 recorded
- Restore drill: 20 tables, 22 migrations, 17 FKs into isolated PostgreSQL 16.14
- Command: `pg_restore --list` PASS
- Not authorized without explicit approval

### Network Allowlist
- Current: 103.120.71.129/32 (Bays Horizon admin)
- Previous: 0.0.0.0/0 (unrestricted)
- Do not widen without owner approval

## 7. Test Commands

```bash
npm run typecheck    # tsc --noEmit -p engine/tsconfig.json → clean
npm test             # vitest run → 1055 passed, 6 skipped, 0 failed (102 files)
npm run build        # tsc + copy web → dist → successful
```

## 8. Key File Paths

| File | Purpose |
|------|---------|
| engine/src/adapters/vfarm/live_client.ts | vFarm adapter, sensor filtering, per-sensor classification |
| engine/src/adapters/vfarm/index.ts | Fleet status helpers, getFleetStatusForSpeaker |
| engine/src/adapters/vfarm/schemas.ts | vFarm response schemas |
| engine/src/config/logger.ts | Logger.audit() with DB persistence |
| engine/src/db/client.ts | DbClient.recordSecurityLedgerEvent, updateOutboundProviderSid |
| engine/src/transport/voice/turn_deadline.ts | Voice deadline enforcement (12s/14s) |
| engine/src/transport/voice/voice_lane.ts | Voice lane service |
| engine/src/interfaces/voice/index.ts | Voice interface, processVoiceTurnWithDeadline |
| engine/src/connectors/vfarm.ts | describeFleetStatus, farm-level response |
| engine/src/admin/routes.ts | /vfarm/devices proxy with fleet_status filter |
| web/admin.js | Fleet status rendering |
| tests/adapters/vfarm_per_sensor_classification.test.ts | 9 tests |
| tests/adapters/vfarm_fleet_status.test.ts | 17 tests |
| tests/security/security_ledger_persistence.test.ts | 13 tests |
| tests/voice/voice_lifecycle.test.ts | 7 tests |
| tests/transport/outbound_attribution_edge_cases.test.ts | 4 tests |

