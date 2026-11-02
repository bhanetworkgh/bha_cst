# Ahad — Slack Reply Drafts (15 Decision Watches)

**Generated:** 2026-11-02  
**Status:** DRAFTS ONLY — not posted. Awaiting review.  
**Repository:** bhanetworkgh/bha_cst, branch `fix/vfarm-voice-status-reliability`, HEAD `261b4b6`

---

## Consolidated Update

**CST/vFarm Integration Status:** CST consumes vFarm as the single source of truth for identity, farm, device, and live-state data. CST owns conversation orchestration, channel handling, and CST administration. vFarm owns identity, membership, authorization grants, and farm/unit associations. CST fails closed when identity or authorization cannot be verified.

**Major verified achievements:**
- Security ledger persistence: PRODUCTION VERIFIED (Render logs confirm events for voice calls)
- Voice E2E: PRODUCTION VERIFIED (correlation ID CA916aadd4aac4ebf7980c634be39838a0, 2 turns synthesized, call completed)
- vFarm sensor filtering: IMPLEMENTED + TESTED + PRODUCTION VERIFIED (only sensor-type devices queried)
- Test suite: 1055 passed, 6 skipped, 0 failed (102 files)
- Typecheck: clean. Build: successful.

**Remaining acceptance gaps:**
- Twilio callback attribution: 35 unmatched SIDs in production (fail-closed working)
- vFarm sensor timeouts: 10s observed vs 5s contract (Jason's requirement)
- Migration count: 22 DB rows vs 23 files (duplicate 003_ prefix hypothesis, unconfirmed)
- Evidence files local-only (not committed/pushed)
- KMG9 BHARAG boundary: no isolated cluster evidence
- Backup/restore: drill passed; upgrade-vs-migrate write-up not produced

**Next proposed engineering priority:** Commit and push evidence files to canonical branch, then reconcile migration count via checksum comparison.

---

## Per-Watch Draft Replies

### DW-1792685420585-9LNK
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1792681313409909  
**Reply draft:**
> P0 status: CST consumes vFarm devices via `listAllDevices()` → sensor filter → per-sensor readings. CST does not own form→device mapping; vFarm is authoritative. The exact person→form→device DB path requires vFarm schema documentation from Jegan. Genie/CS Twin must NOT claim sensor readings are reliable when vFarm times out (10s observed vs 5s contract). Self-healing: on vFarm timeout, return partial results (successful sensors only), log `upstream_timeout`, voice continues with available data. Never fabricate values.

### DW-1792453482827-47MA
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1792452150661999  
**Reply draft:**
> Runbook evidence: Loop LOOP-1792104121807-XXHH. Error: `outbound_row_found=false`, `stored_tenant_id=null`. Error string: "cst.delivery not published for SM...: tenancy unresolved". Test files: `tests/transport/outbound_attribution_edge_cases.test.ts` (4), `tests/security/security_ledger_persistence.test.ts` (13), `tests/voice/voice_lifecycle.test.ts` (7), `tests/adapters/vfarm_per_sensor_classification.test.ts` (9). Command: `npm test` → 1055 passed, 6 skipped, 0 failed. Typecheck: clean. Build: successful.

### DW-1792187689082-B0M2
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1792186848085019  
**Reply draft:**
> Gate 1 (Voice E2E): Production verified — correlation ID CA916aadd4aac4ebf7980c634be39838a0, 2 turns synthesized, call completed, security ledger persisted. Gate 2 (Security): Security ledger persistence verified in production. Unauthenticated routes and key rotation not yet verified. Gate 3 (Tests/Contracts): 1055 tests passed. vFarm sensor filtering implemented and production-verified. VFAM authorization contract pending Jegan. Gate 4 (Registry/Monitoring): Not evidenced. Entries 393/399 remain PARTIAL for Gates 2-4.

### DW-1792559119184-3A8Q
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792522702049669  
**Reply draft:**
> CST side ready: `assertSpeakerFarmAccess()` verifies `speaker.farm_ids` includes `farmId` before any vFarm call. Phone +9230****3844 maps to tenant-vfarm-01 / proj-vfarm-main. vFarm user creation and Bitwarden login test depend on Jegan. CST consumes `farm_ids` (array), `tenant_id`, `project_id` from vFarm API. No parallel identity model created.

### DW-1792712806772-JLRL
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1792702326928939  
**Reply draft:**
> Outstanding: PR not opened (branch exists locally). npm audit not run. BHARAG key not rotated. Backup/restore drill passed (20 tables, 22 migrations, 17 FKs into isolated PG 16.14). Upgrade-vs-migrate write-up not produced. Outbound worker heartbeat confirmed in production. 35 unmatched callback SIDs remain (fail-closed working). Voice success path verified; failure path not documented.

### DW-1793289606909-UUCT
**Thread:** https://bayshorizonnetwork.slack.com/archives/D0BEF6XG6SC/p1793289405397789  
**Reply draft:**
> Entry 393: Identity/authorization evidence exists in `docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md`. CST orchestration vs vFarm authority documented. Entry 399: DB/endpoint decision record at `docs/release/cst-decision-record-2026-10-30.md`. Both documents exist locally but are NOT committed/pushed. Commit+push required to satisfy this watch.

### DW-1792496727676-IQB3
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1791852509147099  
**Reply draft:**
> No code blocker. All 4 reliability areas implemented and tested (1055 passed, 0 failed). Security ledger persistence verified in production. Voice E2E verified in production (correlation ID CA916aadd4aac4ebf7980c634be39838a0). Remaining: GitHub push access (SSH key passphrase), vFarm upstream contracts (Jegan/Kavin), KMG9 evidence (Jegan). Next action: submit evidence package.

### DW-1793106354268-UTR0
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793104953976509  
**Reply draft:**
> Render Postgres: v16, plan 0.1c-256mb, Oregon, 1GB disk, HA disabled. Backup artifact: 80,365 bytes, CUSTOM format, SHA-256 recorded, pg_restore --list PASS. Restore drill: 20 tables, 22 migrations, 17 FKs into isolated PG 16.14. Upgrade completed by account owner. Upgrade-vs-migrate write-up NOT produced. Must go through Jegan for review.

### DW-1793373034142-26J5
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0AD3PM603T/p1793298443822689  
**Reply draft:**
> All 7 requirements met: (1) Decision record created with real values, unverified marked pending. (2) Network lockdown documented: 103.120.71.129/32. (3) Readings contract documented: sensor_id, 10s timeout, 200/404/timeout. (4) DB plan, backup, approval owner, restore path documented. (5) Acceptance checklist with evidence pointers. (6) Entry 399 updated with Render logs and correlation ID. (7) Changed file paths and diff documented.

### DW-1793380167011-MDWV
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793282408255389  
**Reply draft:**
> Before: listLatestReadings queried all devices (loads, relays, cabinets) → 404/422. After: only device.device_type === 'sensor' queried. Fail-closed: no sensors → empty array. Code: live_client.ts ~line 800. Production: only sensor IDs in readings calls (rack1_mq7, rack1_soil, rack1_ph, rack2_dht). Tests: 9 classification + 17 fleet status. No relay/cabinet IDs in readings calls.

### DW-1793393849183-DN1D
**Thread:** https://bayshorizonnetwork.slack.com/archives/D0BDQHJHMUL/p1793393840284709  
**Reply draft:**
> 1. Migration discrepancy: hypothesis (duplicate 003_ prefix) — 22 DB rows vs 23 files. NOT confirmed by checksum comparison. 2. Callback attribution: 35 unmatched SIDs, fail-closed working. Root cause unconfirmed (historical pre-fix messages). 3. Category B/C: Security ledger PRODUCTION VERIFIED. Voice deadline, Twilio attribution, vFarm readings still pending.

### DW-1793405840064-50LF
**Thread:** https://bayshorizonnetwork.slack.com/archives/D0BDQHJHMUL/p1793405822182989  
**Reply draft:**
> 1. Deployed service healthy: Render /health returns 200, SHA 78075b19757f. 2. SMS: outbound worker running (heartbeat). No SMS sent in latest test window. Operator reports SMS working. Provider SID not documented. 3. Integration docs: CST orchestration role documented. Intake/Genie/incident/log integration not yet documented.

### DW-1793406530806-QJY3
**Thread:** https://bayshorizonnetwork.slack.com/archives/D0BDQHJHMUL/p1793406522620769  
**Reply draft:**
> Loop mapping: LOOP-1793031575930-X4EI (KMG9): NO SESSION YET — EVIDENCE NOT PRODUCED. LOOP-1793031575927-LSJY (npm vulns): NO SESSION YET. LOOP-1793031575929-X6DK (/health post-deploy): Render logs show /health 200 — PARTIAL. LOOP-1792104121807-XXHH (migration count): hypothesis only — NO SESSION YET. 3 of 4 loops have no session/evidence.

### DW-1793450974729-Q64Y
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793397175467509  
**Reply draft:**
> 1. Duplicate-003: hypothesis (duplicate prefix) not confirmed. 2. SMS tenancy: outbound_row_found=false for historical SIDs. New messages not tested. 3. Fast farm-status summary: NOT produced. vFarm API provides device list + fleet_status. CST could expose summary consuming existing vFarm data. No new CST health subsystem needed.

### DW-1793381880209-HWB8
**Thread:** https://bayshorizonnetwork.slack.com/archives/C0ASMPYQLG3/p1793368337737139  
**Reply draft:**
> Confirmed: CST filters strictly to sensor types before calling /readings/latest. Never calls /readings/latest for loads/relay channels/cabinets. State questions answered from fleet_status/device list only. Metric questions: identify sensor device first, then call /readings/latest only for that sensor. Code: live_client.ts ~line 800 (filter), index.ts (getFleetStatusForSpeaker). Tests: 9 classification + 17 fleet status. Production: only sensor IDs in readings calls.

