# CST IWKX — Production Deployment & Live PostgreSQL Database Verification

**Date:** 20 November 2026  
**Repository:** `bhanetworkgh/bha_cst`  
**Target Loop:** `LOOP-1789824812431-IWKX` (Ship Customer Service Twin v1)  
**Pull Requests:**
- [PR #55](https://github.com/bhanetworkgh/bha_cst/pull/55) (Commit `ee0a69e4fbafa4999c5df9f2a512183c81d5bef1`, Merged 2026-11-18)
- [PR #64](https://github.com/bhanetworkgh/bha_cst/pull/64) (`feat/iwkx-postgres-lifecycle-acceptance`, Merged into `main` at `19a13ceb75e75fbd78ac89b91aa79836fe385af8` on 2026-11-20T18:34:38Z)
**Primary Evidence Report:** [docs/operations/IWKX_RELIABILITY_FIX.md](docs/operations/IWKX_RELIABILITY_FIX.md)  
**Production Host:** `https://bha-cst-7u9e.onrender.com` / `https://cst.bhanetwork.org`  
**Render Web Service:** `srv-db8hepqvcj2c73adpus0` (`bha-cst`)  
**Render PostgreSQL Database:** `dpg-db8he2qvcj2c73ado3s0-a` (`bha-cst-postgres`, database `bha_cst_1sh0`)  
**Inspector:** CST Engineering via Authenticated Render CLI (`v2.30.0`)  

---

## 1. Executive Summary

This document captures empirical production verification evidence demonstrating that:
1. The IWKX follow-up remediation PR #64 was merged to `main` and deployed live to Render.
2. Production database migration `025_escalations_acknowledgement_and_status_lifecycle.sql` was automatically applied to live Render PostgreSQL (`bha-cst-postgres` / `bha_cst_1sh0`) during container startup.
3. Direct read-only `render psql` inspection confirms the updated schema:
   - Dedicated `acknowledged_by` (`varchar(255)`) and `acknowledged_at` (`timestamptz`) columns.
   - Live check constraint `ck_escalation_status` enforcing all 5 statuses: `('pending', 'sent', 'notified', 'acknowledged', 'failed')`.
   - Existing production escalation records preserved without data corruption.
4. Production web service health probes (`/health`, `/health/reliability`, `/health/registry`) return `200 OK` and healthy readiness.

---

## 2. Render Deployment Verification

### 2.1 Live Deployment Inspection
**Command:**
```bash
render deploys list srv-db8hepqvcj2c73adpus0 --output json
```

**Output:**
```json
[
  {
    "commit": {
      "createdAt": "2026-11-20T18:34:38Z",
      "id": "19a13ceb75e75fbd78ac89b91aa79836fe385af8",
      "message": "Merge pull request #64 from bhanetworkgh/feat/iwkx-postgres-lifecycle-acceptance\n\nfix(iwkx): persist escalation acknowledgement lifecycle"
    },
    "createdAt": "2026-11-20T18:34:40.842077Z",
    "finishedAt": "2026-11-20T18:35:34.044747Z",
    "id": "dep-dc095g7lk1mc73f0ir90",
    "startedAt": "2026-11-20T18:34:40.812967Z",
    "status": "live",
    "trigger": "new_commit",
    "updatedAt": "2026-11-20T18:36:05.657778Z"
  }
]
```

---

## 3. Production Container Startup & Migration Execution

**Command:**
```bash
render logs --resources srv-db8hepqvcj2c73adpus0 --limit 50 --output text
```

**Recorded Output:**
```text
2026-11-20 18:35:31  · already applied, skipping: 001_initial_schema.sql ... 024_add_consent_exempt_to_messages_out.sql
2026-11-20 18:35:31  Applying migration: 025_escalations_acknowledgement_and_status_lifecycle.sql...
2026-11-20 18:35:31  ✓ Successfully applied: 025_escalations_acknowledgement_and_status_lifecycle.sql
2026-11-20 18:35:31  🎉 Migrations complete: 1 applied, 25 already recorded.
2026-11-20 18:35:31  
2026-11-20 18:35:31  > bha-cst@1.0.0 start
2026-11-20 18:35:31  > node dist/engine/src/server.js
2026-11-20 18:35:32  {"timestamp":"2026-11-20T18:35:32.289Z","level":"INFO","message":"DbClient: Initialized PostgreSQL database connection pool"}
2026-11-20 18:35:32  {"timestamp":"2026-11-20T18:35:32.368Z","level":"INFO","message":"System registry validation passed","systems":1}
2026-11-20 18:35:32  {"timestamp":"2026-11-20T18:35:32.371Z","level":"INFO","message":"Outbound background worker starting","interval_ms":5000,"node_env":"production"}
2026-11-20 18:35:32  {"timestamp":"2026-11-20T18:35:32.371Z","level":"INFO","message":"CS Twin Engine listening on port 10000","node_env":"production","service":"bha-cst"}
2026-11-20 18:35:34  ==> Your service is live 🎉
2026-11-20 18:35:34  ==> Available at your primary URL https://cst.bhanetwork.org + 1 more domain
```

---

## 4. Live Production Database Queries (`render psql`)

Direct query inspection against `dpg-db8he2qvcj2c73ado3s0-a` (database `bha_cst_1sh0`):

### 4.1 Schema Migration Ledger
**Query:**
```sql
SELECT filename, applied_at FROM schema_migrations ORDER BY filename DESC LIMIT 5;
```

**Result:**
```text
                         filename                         |          applied_at           
----------------------------------------------------------+-------------------------------
 025_escalations_acknowledgement_and_status_lifecycle.sql | 2026-11-20 18:35:31.005136+00
 024_add_consent_exempt_to_messages_out.sql               | 2026-11-16 21:05:48.399891+00
 023_reconcile_duplicate_003_and_schema_drift.sql         | 2026-11-02 22:43:25.032521+00
 022_add_escalations_table.sql                            | 2026-10-28 17:02:14.122471+00
 021_repair_service_number_bindings.sql                   | 2026-10-20 17:41:39.073465+00
(5 rows)
```

### 4.2 `escalations` Table Column Schema
**Query:**
```sql
SELECT column_name, data_type, is_nullable, character_maximum_length 
FROM information_schema.columns 
WHERE table_name = 'escalations' 
ORDER BY ordinal_position;
```

**Result:**
```text
    column_name    |        data_type         | is_nullable | character_maximum_length 
-------------------+--------------------------+-------------+--------------------------
 id                | character varying        | NO          |                       64
 caller_phone      | character varying        | NO          |                       32
 tenant_id         | character varying        | NO          |                       64
 project_id        | character varying        | YES         |                       64
 conversation_id   | character varying        | YES         |                       64
 correlation_id    | character varying        | NO          |                      128
 caller_email      | character varying        | YES         |                      255
 reason            | text                     | YES         |                         
 transcript        | jsonb                    | YES         |                         
 slack_notified    | boolean                  | NO          |                         
 slack_notified_at | timestamp with time zone | YES         |                         
 slack_error       | text                     | YES         |                         
 created_at        | timestamp with time zone | NO          |                         
 status            | character varying        | NO          |                       32
 acknowledged_by   | character varying        | YES         |                      255
 acknowledged_at   | timestamp with time zone | YES         |                         
(16 rows)
```

### 4.3 `ck_escalation_status` Constraint Definition
**Query:**
```sql
SELECT conname, pg_get_constraintdef(oid) AS def 
FROM pg_constraint 
WHERE conrelid = 'escalations'::regclass;
```

**Result:**
```text
       conname        |                                                                                                   def                                                                                                    
----------------------+----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 ck_escalation_status | CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying, 'notified'::character varying, 'acknowledged'::character varying, 'failed'::character varying])::text[])))
 escalations_pkey     | PRIMARY KEY (id)
(2 rows)
```

### 4.4 Live Escalations Records
**Query:**
```sql
SELECT id, status, caller_phone, tenant_id, project_id, correlation_id, acknowledged_by, acknowledged_at, created_at 
FROM escalations 
ORDER BY created_at DESC LIMIT 10;
```

**Result:**
```text
                    id                    | status  |  caller_phone  |    tenant_id    |   project_id    |          correlation_id           | acknowledged_by | acknowledged_at |         created_at         
------------------------------------------+---------+----------------+-----------------+-----------------+-----------------------------------+-----------------+-----------------+----------------------------
 esc_ce40ed6b-ff4f-4084-bc8a-078993a27e64 | pending | +16073162985   | tenant-vfarm-01 | proj-vfarm-main | conv_4101m7ar86wkf09rqkny9rb43gxa |                 |                 | 2026-11-13 15:29:00.571+00
 esc_f01bf0de-46bd-497e-9dcd-84266a14e7f0 | pending | +15184698083   | tenant-vfarm-01 | proj-vfarm-main | conv_5501m75hkhpjen3sz0cxk7sjf64c |                 |                 | 2026-11-11 14:54:14.215+00
 esc_600ba97b-c0df-44e2-bab5-ac10b740e4b9 | pending | +2348163361737 | tenant-vfarm-01 | proj-vfarm-main | conv_6101m6xh602zfzyrb2b2axxpr5sx |                 |                 | 2026-11-08 12:14:19.463+00
 esc_ef9ead44-954f-4d80-b74d-e6cdc7fd0dee | pending | +2348163361737 | tenant-vfarm-01 | proj-vfarm-main | conv_2101m6xgt7ncegn8p6nmaj76ft3n |                 |                 | 2026-11-08 12:08:07.275+00
 esc_43ad3dfe-3aad-4fff-b13b-01c4686328cd | pending | +2348163361737 | tenant-vfarm-01 | proj-vfarm-main | conv_5201m6xfhdqvf33aqme8v7hfeda4 |                 |                 | 2026-11-08 11:45:33.777+00
 esc_299368d4-ddf2-4a16-9486-24095834f1e8 | pending | +2348163361737 | tenant-vfarm-01 | proj-vfarm-main | conv_5701m6xbwbytf5vapacsb5nz3gcq |                 |                 | 2026-11-08 10:42:53.656+00
(6 rows)
```

### 4.5 Production Database Table Census
**Query:**
```sql
SELECT relname AS table_name, n_live_tup AS row_count 
FROM pg_stat_user_tables 
ORDER BY n_live_tup DESC;
```

**Result:**
```text
         table_name         | row_count 
----------------------------+-----------
 security_ledger            |       922
 dashboard_publish_outcomes |       279
 voice_deliveries           |       147
 messages                   |        66
 admin_sessions             |        62
 schema_migrations          |        26
 messages_in                |        25
 messages_out               |        14
 alert_audit_log            |        10
 sms_consent_audit          |         6
 escalations                |         6
 sms_consent_prompts        |         3
 sms_consents               |         3
 customers                  |         3
 service_number_bindings    |         2
 conversations              |         2
 projects                   |         2
 organizations              |         1
 admin_users                |         1
 systems                    |         1
 workspaces                 |         1
(21 rows)
```

---

## 5. Live Production HTTP Probes

### 5.1 Service Liveness & Version
**Command:** `curl -s https://bha-cst-7u9e.onrender.com/health`  
**Response (HTTP 200):**
```json
{"status":"ok","service":"bha-cst-engine"}
```

### 5.2 Reliability & Subsystem Health
**Command:** `curl -s https://bha-cst-7u9e.onrender.com/health/reliability`  
**Response (HTTP 200):**
```json
{
  "liveness": "healthy",
  "readiness": "ready",
  "timestamp": "2026-11-20T18:41:05.168Z",
  "subsystems": {
    "elevenlabs_webhook": {
      "status": "healthy",
      "metrics": {
        "total_received": 0,
        "authenticated_success": 0,
        "auth_failures": 0,
        "validation_failures": 0,
        "processing_failures": 0,
        "persistence_failures": 0,
        "duplicate_deliveries": 0,
        "last_successful_timestamp": null,
        "pending_retries": 0
      }
    },
    "slack_notifications": {
      "status": "healthy",
      "metrics": {
        "total_attempts": 0,
        "successful_deliveries": 0,
        "failed_deliveries": 0,
        "rate_limit_hits": 0,
        "deferred_deliveries": 0,
        "pending_retries": 0,
        "last_successful_timestamp": null
      }
    },
    "twilio_callbacks": {
      "status": "healthy",
      "metrics": {
        "total_callbacks": 0,
        "signature_valid": 0,
        "signature_invalid": 0,
        "unmatched_sids": 0,
        "unresolved_attributions": 0,
        "invalid_transitions": 0,
        "duplicate_callbacks": 0,
        "delivered_count": 0,
        "failed_delivery_count": 0,
        "last_callback_timestamp": null
      }
    }
  },
  "unhealthy_reasons": []
}
```

### 5.3 System Registry Configuration Health
**Command:** `curl -s https://bha-cst-7u9e.onrender.com/health/registry`  
**Response (HTTP 200):**
```json
{"ok":true,"issues":[]}
```

---

## 6. Conclusion & Acceptance Status

* **Production Code**: `MERGED & DEPLOYED` (`dep-dc095g7lk1mc73f0ir90`, Commit `19a13ceb75e75fbd78ac89b91aa79836fe385af8`).
* **Production Database Schema**: `VERIFIED IN PRODUCTION` (`025` applied at `2026-11-20 18:35:31.005136+00`, columns and 5-status constraint verified via `render psql`).
* **Remaining Acceptance Requirement**: Destiny Arupi's review of the companion contract [docs/contracts/cst-events.md](docs/contracts/cst-events.md) and execution of the controlled live telephony handoff drill.
