# CST Database Continuity & Upgrade Plan

**Loop:** `LOOP-1792104121807-XXHH`
**Database Target:** `bha-cst-postgres` (`dpg-db8he2qvcj2c73ado3s0-a`)
**Current Plan:** Render Free PostgreSQL 16 (Expires: 2026-11-14T18:10:20Z)
**Target Plan:** Render Starter PostgreSQL ($7/month)
**Deliverable Status:** **PLAN COMPLETE** (Planning deliverable only; execution pending authorized owner approval)
**Owner / Approver:** Platform Owner / Jason Bays
**Date:** 19 October 2026

---

## 1. Context & Expiry Verification

- **Current State**: Render free tier PostgreSQL database `bha-cst-postgres` was provisioned on 16 August 2026. Render free databases have a mandatory 90-day lifetime and will expire and be terminated on **14 November 2026 at 18:10:20 UTC** if not upgraded.
- **Service Impact**: Free tier databases do not support automated backups or PITR and are subject to connection suspensions. Terminating the database would destroy all conversation history, SMS consents, message queues, and tenant bindings.
- **Target Plan**: Render Starter PostgreSQL ($7/mo) provides:
  - Permanent persistence (no 90-day expiry).
  - Automated daily backups with 7-day retention.
  - Dedicated compute/RAM (1 GB RAM, 0.5 CPU, 25 GB storage).
  - Continuous service without hibernation.

---

## 2. Backup & Restoration Procedures

### 2.1 Pre-Migration Logical Backup (`pg_dump`)
Prior to any maintenance window or plan transition, an authorized operator must extract a full logical backup:
```bash
# Export full database schema and data with compression
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="bha_cst_pre_upgrade_$(date +%Y%m%d_%H%M%S).dump"
```
Verify the dump integrity:
```bash
pg_restore --list "bha_cst_pre_upgrade_*.dump" | head -n 20
```

### 2.2 Restoration Procedure (Emergency Standby)
In the event that the primary database instance is corrupted or dropped:
1. Provision a new PostgreSQL 16 instance on Render.
2. Restore the custom-format dump:
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges \
     --dbname="$NEW_DATABASE_URL" "bha_cst_pre_upgrade_*.dump"
   ```
3. Run schema verification using `scripts/migrate.js --dry-run`.

---

## 3. Planned Cutover & Maintenance Protocol

The upgrade from Render Free to Starter can be achieved with zero data re-import via the Render Dashboard ("Upgrade Plan" button), which preserves existing storage volume and connection credentials in-place.

### 3.1 Maintenance Window Schedule
- **Window**: Off-hours maintenance window (e.g., Sunday 02:00 – 02:30 EST).
- **Announced Downtime**: 5 to 10 minutes maximum (for container restart and volume resize).

### 3.2 Cutover Execution Steps
1. **Pre-flight**:
   - Confirm active connections: `SELECT count(*) FROM pg_stat_activity;`.
   - Take manual `pg_dump` backup as described in Section 2.1.
2. **Execute In-Place Upgrade**:
   - In Render Dashboard: Select `bha-cst-postgres` → **Settings** → **Plan** → Select **Starter** ($7/mo).
   - Click **Save Changes**.
3. **Engine Health Check**:
   - As soon as Render reports the database status as `Available`:
   - Probe CST Engine: `curl -sI https://bha-cst-7u9e.onrender.com/health`.
   - Verify HTTP 200 response.

---

## 4. Post-Cutover Data Validation

Execute the following read-only SQL queries to verify zero data loss across critical tables:

```sql
-- 1. Verify schema migrations ledger
SELECT count(*) AS migrations_applied FROM schema_migrations;
-- Must equal at least 19 records.

-- 2. Verify tenant service number bindings
SELECT count(*) AS service_bindings FROM service_number_bindings;

-- 3. Verify SMS consent records
SELECT count(*) AS consents_count FROM sms_consents;
SELECT count(*) AS audit_records FROM sms_consent_audit;

-- 4. Verify system config integrity
SELECT count(*) AS systems_count FROM systems;
```

---

## 5. Rollback Plan

If the in-place upgrade fails or database fails to boot:
1. **Rollback Action**: If Render allows downgrade, revert to Free plan temporarily while troubleshooting.
2. **Alternative Recovery**: Provision a fresh Render PostgreSQL Starter database, restore the pre-upgrade dump (`bha_cst_pre_upgrade_*.dump`), update `DATABASE_URL` environment variable on `srv-db8hepqvcj2c73adpus0` (`bha-cst`), and redeploy the service.

---

## 6. Approvals & Constraints

> [!IMPORTANT]
> **Safety Rule**: No billing changes, plan upgrades, or production data migrations are to be executed without explicit written authorization from Jason Bays / Platform Owner.
> This document satisfies the planning requirement for `LOOP-1792104121807-XXHH`.
