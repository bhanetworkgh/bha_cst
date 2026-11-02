# CST PostgreSQL — Upgrade vs Migration Analysis — 2026-11-02

**Repository:** bhanetworkgh/bha_cst  
**Database:** bha-cst-postgres (dpg-db8he2qvcj2c73ado3s0-a)  
**Decision owner:** Account owner (upgrade completed) / Jegan (review required)

---

## 1. Current State

| Field | Value |
|-------|-------|
| PostgreSQL version | 16.15 |
| Plan | 0.1c-256mb (Render Starter) |
| Region | Oregon |
| Disk | 1 GB (autoscaling disabled) |
| HA | Disabled |
| Read replicas | None |
| Connection pool | None |
| Allowlist | 103.120.71.129/32 |
| Database size | 9,719 kB |
| Application tables | 21 |
| Migrations | 22 (schema_migrations rows) |
| Foreign keys | 17 |

## 2. Backup Evidence

| Artifact | Value |
|----------|-------|
| Format | CUSTOM (pg_dump) |
| Size | 80,365 bytes |
| SHA-256 | Recorded (see evidence docs) |
| pg_restore --list | PASS |
| Restore target | Isolated PostgreSQL 16.14 |
| Restore result | 20 tables, 22 migrations, 17 FKs |
| Zero-downtime recovery | NOT evidenced |

## 3. Option A — Upgrade in Place (Render)

**Description:** Stay on Render managed PostgreSQL, upgrade plan as needed.

| Factor | Assessment |
|--------|------------|
| Risk | Low — same provider, same region, same backup/restore path |
| Effort | Low — plan change via Render Dashboard |
| Downtime | Minimal (Render handles upgrade) |
| Data loss tolerance | Low — backup artifact verified, restore drill passed |
| Cost | Plan-dependent (current: 0.1c-256mb) |
| Backup/restore | Verified (80,365 bytes, pg_restore PASS) |
| HA | Available on higher plans |
| Connection pooling | Available on higher plans |
| Replicas | Available on higher plans |

**Pros:** Minimal disruption, verified backup/restore, same VPC (private network), no data migration risk.

**Cons:** Render plan limits, no HA on current plan, no connection pooling, single region.

## 4. Option B — Migrate to Another Database

**Description:** Move CST PostgreSQL to a different provider or self-hosted instance.

| Factor | Assessment |
|--------|------------|
| Risk | High — data migration, connection string changes, downtime |
| Effort | High — schema migration, data transfer, testing, cutover |
| Downtime | Significant (minutes to hours depending on data size) |
| Data loss tolerance | Requires verified backup/restore on target |
| Cost | Provider-dependent |
| Backup/restore | Must be re-verified on target |
| HA | Provider-dependent |
| Connection pooling | Provider-dependent |
| Replicas | Provider-dependent |

**Pros:** Potentially better performance, cost, or feature set.

**Cons:** Migration risk, downtime, connection string changes, new provider learning curve, must re-verify all integrations.

## 5. Recommendation

**Stay on Render managed PostgreSQL (Option A).**

Rationale:
1. Backup/restore verified and working.
2. Private network connectivity confirmed (TLSv1.3).
3. Upgrade completed by account owner — continuity decision COMPLETE.
4. Migration risk not justified at current scale (9,719 kB database).
5. No production-equivalent restore or zero-downtime drill performed — migration would add unverified risk.

**Conditions that would trigger migration:**
- Database size exceeds Render plan limits (>1 GB disk, current: 9,719 kB)
- HA requirement becomes non-negotiable
- Connection pooling bottleneck identified
- Render pricing becomes unacceptable
- Multi-region requirement

**Decision owner:** Account owner (upgrade) / Jegan (review of backup/restore evidence)

**Status:** Upgrade complete. Migration not recommended at current scale. Zero-downtime recovery proof remains a verification gap (not a blocker).

