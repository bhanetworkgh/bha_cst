# Ahad — CST Execution Plan (2026-11-02)

**Generated:** 2026-11-02  
**Repository:** bhanetworkgh/bha_cst, branch `fix/vfarm-voice-status-reliability`, HEAD `261b4b6`  
**Render deployed SHA:** `78075b19757f` (pre-fix)

---

## Priority 1 — Establish the true baseline

### Task 1.1: Commit and push evidence files
- **Watches:** DW-1793289606909-UUCT, DW-1793393849183-DN1D, DW-1793406530806-QJY3
- **Files:** `docs/acceptance/cst-jason-consolidated-evidence.md`, `docs/evidence/2026-10-29-render-live-evidence-entry-399.md`, `docs/release/cst-decision-record-2026-10-30.md`, `docs/evidence/2026-10-30-cst-engine-surfacing-patch-log.md`
- **Current state:** Modified locally, not committed/pushed
- **Required change:** Commit and push to canonical branch
- **Blocker:** GitHub push access (SSH key passphrase unavailable)
- **Owner:** Ahad / account owner
- **Evidence artifact:** Commit hash + push confirmation

### Task 1.2: Reconcile migration count
- **Watches:** DW-1793393849183-DN1D, DW-1793406530806-QJY3, DW-1793450974729-Q64Y, DW-1792712806772-JLRL
- **Files:** `db/migrations/*.sql`, `schema_migrations` table
- **Current state:** Hypothesis (duplicate 003_ prefix) unconfirmed
- **Required change:** Read-only SQL query to list production migration names/checksums; compare against repo files
- **Test command:** `SELECT version, name, checksum FROM schema_migrations ORDER BY version`
- **Acceptance criteria:** Exact match between repo files and DB records, or documented discrepancy with root cause
- **Blocker:** Read-only SQL access (TLS/allowlist)
- **Owner:** Ahad (with Jegan for DB access)

### Task 1.3: Verify Render DB configuration
- **Watches:** DW-1793106354268-UTR0, DW-1793373034142-26J5
- **Files:** `render.yaml`, `docs/release/cst-decision-record-2026-10-30.md`
- **Current state:** Allowlist `103.120.71.129/32` (tightened). Plan: 0.1c-256mb, 1GB disk, HA disabled.
- **Required change:** Document current plan limits, backup retention, approval owner
- **Acceptance criteria:** Decision record contains all 7 requirements from DW-1793373034142-26J5
- **Status:** SATISFIED (decision record exists)

---

## Priority 2 — Close high-impact data and contract issues

### Task 2.1: Sensor-only readings calls
- **Watches:** DW-1793380167011-MDWV, DW-1793381880209-HWB8, DW-1792187689082-B0M2
- **Files:** `engine/src/adapters/vfarm/live_client.ts`, `tests/adapters/vfarm_per_sensor_classification.test.ts`
- **Current state:** IMPLEMENTED + TESTED + PRODUCTION VERIFIED
- **Status:** SATISFIED

### Task 2.2: vFarm health-attribute pass-through
- **Watches:** DW-1792187689082-B0M2 (special health ownership rule)
- **Files:** `engine/src/adapters/vfarm/`, `engine/src/connectors/vfarm.ts`
- **Current state:** Fleet status implemented via `getFleetStatusForSpeaker()`. Uses vFarm's `fleet_status` string.
- **Required change:** Verify health attribute preserved across admin, voice, messages. No independent health calculation.
- **Test:** vFarm healthy → CST healthy; vFarm unhealthy → CST unhealthy; missing → never healthy.
- **Status:** PARTIAL — needs verification tests

### Task 2.3: Identity and authorization evidence
- **Watches:** DW-1792559119184-3A8Q, DW-1792685420585-9LNK
- **Files:** `engine/src/adapters/vfarm/`, `engine/src/connectors/vfarm.ts`
- **Current state:** `assertSpeakerFarmAccess()` verifies `speaker.farm_ids` includes `farmId`. Production logs confirm tenant/project resolution.
- **Required change:** Document exact phone→system/farm/cabinet mapping. vFarm user creation depends on Jegan.
- **Status:** PARTIAL — CST side ready; vFarm upstream dependency

### Task 2.4: Migration reconciliation (detailed)
- **Watches:** DW-1793393849183-DN1D, DW-1793450974729-Q64Y
- **Files:** `db/migrations/*.sql`
- **Current state:** 22 files in repo (001-022), 2 with 003_ prefix. Production: 22 schema_migrations rows.
- **Required change:** Read-only SQL to list production migration names/checksums. Compare against repo.
- **Acceptance criteria:** Exact match or documented discrepancy with root cause
- **Status:** BLOCKED on read-only SQL access

---

## Priority 3 — Close production communication and reliability

### Task 3.1: SMS tenancy and delivery
- **Watches:** DW-1793405840064-50LF, DW-1793450974729-Q64Y, DW-1792187689082-B0M2
- **Files:** `engine/src/transport/twilio/outbound.ts`, `engine/src/db/client.ts`
- **Current state:** Outbound worker running. 35 unmatched callback SIDs in production. Fail-closed working.
- **Required change:** Test new SMS send → verify provider SID persisted → verify callback attribution → verify dashboard publication.
- **Acceptance criteria:** End-to-end SMS path with documented correlation ID and provider SID
- **Status:** PARTIAL — needs production test with authorized number

### Task 3.2: Callback attribution
- **Watches:** DW-1793393849183-DN1D, DW-1792712806772-JLRL
- **Files:** `engine/src/transport/twilio/outbound.ts`, `engine/src/db/client.ts`
- **Current state:** Code correct (updateOutboundProviderSid + updateDeliveryStatusByProviderSid). Historical SIDs lack persisted provider_sid.
- **Required change:** New SMS send → verify provider_sid persisted → trigger callback → verify attribution resolves.
- **Status:** PARTIAL — needs production test

### Task 3.3: Voice E2E success and failure paths
- **Watches:** DW-1792187689082-B0M2, DW-1793405840064-50LF
- **Files:** `engine/src/transport/voice/`, `engine/src/interfaces/voice/`
- **Current state:** Success path verified in production (correlation ID CA916aadd4aac4ebf7980c634be39838a0). Failure path not documented.
- **Required change:** Document timeout/error behavior. Test with vFarm timeout (10s observed).
- **Status:** PARTIAL — success verified; failure path needs documentation

### Task 3.4: Security ledger persistence
- **Watches:** DW-1792187689082-B0M2
- **Files:** `engine/src/config/logger.ts`, `engine/src/db/client.ts`
- **Current state:** PRODUCTION VERIFIED — Render logs confirm "Security ledger event recorded" for voice calls.
- **Status:** SATISFIED

### Task 3.5: Outbound queue reliability
- **Watches:** DW-1792712806772-JLRL
- **Files:** `engine/src/transport/twilio/outbound.ts`
- **Current state:** Worker heartbeat confirmed in production. 5-min stale-sending reclaim, 15s Twilio timeout, next_retry_at persisted — code exists but not fully evidenced.
- **Required change:** Document outbound queue behavior with evidence.
- **Status:** PARTIAL — needs evidence documentation

---

## Priority 4 — Complete continuity and Engine integration evidence

### Task 4.1: Backup/restore proof
- **Watches:** DW-1793106354268-UTR0, DW-1792712806772-JLRL
- **Files:** `docs/`, `render.yaml`
- **Current state:** Restore drill passed (20 tables, 22 migrations, 17 FKs into isolated PG 16.14). Backup artifact: 80,365 bytes, CUSTOM format, SHA-256.
- **Required change:** Upgrade-vs-migrate write-up with risk, effort, downtime, data-loss tolerance, recommendation. Through Jegan.
- **Status:** PARTIAL — write-up missing

### Task 4.2: Monitoring Twin
- **Watches:** DW-1792187689082-B0M2 (Gate 4)
- **Files:** `engine/src/`, monitoring endpoints
- **Current state:** Not evidenced. CST health distinguishes API, DB, vFarm, BHARAG, outbound worker, provider delivery.
- **Required change:** Document monitoring surface using existing vFarm authoritative data.
- **Status:** NOT STARTED

### Task 4.3: Research Twin
- **Watches:** DW-1792187689082-B0M2
- **Files:** `engine/src/`
- **Current state:** Not evidenced. Investigation triggers for degraded modes.
- **Required change:** Document investigation triggers and degraded-mode behavior.
- **Status:** NOT STARTED

### Task 4.4: Front Door buyer promises
- **Watches:** DW-1792187689082-B0M2
- **Files:** `docs/`
- **Current state:** Not documented. What CST can/cannot claim.
- **Required change:** Document allowed and must-not-say statements for SMS delivery and CST health.
- **Status:** NOT STARTED

### Task 4.5: Intake/Genie/incident/log integration
- **Watches:** DW-1793405840064-50LF
- **Files:** `docs/`
- **Current state:** Not documented.
- **Required change:** Document CST integration points into Intake, Genie, incident, and log flows.
- **Status:** NOT STARTED

---

## Dependency Map

| Dependency | Blocks | Owner |
|------------|--------|-------|
| GitHub push access (SSH key) | All commit/push tasks | Account owner |
| vFarm PR #100 deployment | Fleet status in production | Jegan |
| vFarm migration e8b0d2f4a6c1 | Actuator→relay rename | vFarm team |
| NEVER_HEARD_DEVICE_FALSE_ONLINE fix | Device liveness | Kavin (target Nov 2) |
| Research Twin §10 rule | Research Twin design | Jegan |
| KMG9 BHARAG boundary | Isolated cluster evidence | Jegan |
| Read-only SQL access | Migration reconciliation, conversation persistence | Ahad/Jegan |
| Authorized SMS test number | SMS E2E verification | Twilio owner |

---

## Test Commands

```bash
npm run typecheck    # tsc --noEmit -p engine/tsconfig.json
npm test             # vitest run → 1055 passed, 6 skipped, 0 failed
npm run build        # tsc + copy web → dist
```

## Current Verification Status

| Check | Result |
|-------|--------|
| Typecheck | ✅ Clean |
| Tests | ✅ 1055 passed, 6 skipped, 0 failed (102 files) |
| Build | ✅ Successful |
| Lint | N/A (no lint script) |
| Git SHA | `261b4b6328a8c6a47ef0042e992a878c717aba1e` |
| Render deployed SHA | `78075b19757f` (pre-fix) |
| Render health | ✅ `/health` returns 200 |

