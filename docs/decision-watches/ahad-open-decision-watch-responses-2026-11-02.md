# Ahad — Open Decision Watch Responses (15 watches)

**Generated:** 2026-11-02  
**Source:** `Ahad -- Open Decision Watches (15).md` (live pull, 2 Nov 2026)  
**Owner:** U0AC6RFNP3P (Ahad)  
**Repository:** bhanetworkgh/bha_cst, branch `fix/vfarm-voice-status-reliability`, HEAD `261b4b6`  
**Render deployed SHA:** `78075b19757f` (pre-fix, deployed 2026-10-28T20:59:14Z)

---

## Decision Watch Status Summary

| # | Watch ID | Status | Key gap |
|---|----------|--------|---------|
| 1 | DW-1792685420585-9LNK | PARTIAL | P0 form→device link requires Jegan/vFarm upstream |
| 2 | DW-1792453482827-47MA | PARTIAL | Runbook evidence exists in code/tests, needs formatted submission |
| 3 | DW-1792187689082-B0M2 | PARTIAL | Voice E2E verified in production logs; security ledger verified; callback attribution still open |
| 4 | DW-1792559119184-3A8Q | PARTIAL | Phone→identity mapping exists; vFarm user/farm scope needs Jegan confirmation |
| 5 | DW-1792712806772-JLRL | PARTIAL | PR not opened; npm audit not run; BHARAG key not rotated; backup/restore not evidenced |
| 6 | DW-1793289606909-UUCT | PARTIAL | Evidence files local-only; need commit+push to canonical branch |
| 7 | DW-1792496727676-IQB3 | SATISFIED | No code blocker; next action is evidence submission |
| 8 | DW-1793106354268-UTR0 | PARTIAL | Backup/restore drill passed (20 tables, 22 migrations, 17 FKs); upgrade-vs-migrate write-up not produced |
| 9 | DW-1793373034142-26J5 | SATISFIED | Decision record exists; network lockdown documented; readings contract documented |
| 10 | DW-1793380167011-MDWV | SATISFIED | Sensor-type filter implemented and tested; production logs confirm skip behavior |
| 11 | DW-1793393849183-DN1D | PARTIAL | Migration discrepancy hypothesized (duplicate 003_ prefix) but not confirmed; callback attribution open |
| 12 | DW-1793405840064-50LF | PARTIAL | Deployed service healthy; SMS path needs verification; integration docs pending |
| 13 | DW-1793406530806-QJY3 | PARTIAL | No session yet for 3 of 4 loops; migration reconciliation pending |
| 14 | DW-1793450974729-Q64Y | PARTIAL | Migration discrepancy unresolved; SMS tenancy unresolved; farm-status summary not produced |
| 15 | DW-1793381880209-HWB8 | SATISFIED | Code filters to sensor types only; tests prove skip behavior; production logs confirm |

---

## Watch-by-Watch Responses

### 1. DW-1792685420585-9LNK — CST focus and deliverables

**Exact decision:** Jason set CST focus to P0 (vFarm form→device link with Jegan) and P1 chain (CS Twin v1, VFAM auth contract, DNS/TLS). Everything else secondary.

**Completed:**
- P0 form→device link: CST consumes vFarm devices via `listAllDevices()` and `listLatestReadings()`. The path is `farm_id → device list → sensor filter → per-sensor readings`. CST does not own the form→device mapping; vFarm is authoritative.
- P1 chain: CS Twin v1 (voice lane) implemented with deadline enforcement (12s default, 14s max). VFAM auth contract documented in `engine/src/adapters/vfarm/`. DNS/TLS: Render provides TLS; custom domain not configured.

**Outstanding:**
- Exact person→form→device DB path requires vFarm schema documentation from Jegan. CST reads devices via vFarm API, not direct DB.
- Genie/CS Twin allowed/must-not-say line: CST health must distinguish API/process, database, vFarm identity/live data, BHARAG knowledge, outbound worker/queue, and provider delivery. Must NOT claim sensor readings are reliable when vFarm times out.

**Self-healing rule:** When vFarm sensor reads timeout (10s observed), CST returns partial results (successful sensors only) and logs `upstream_timeout`. Voice turn continues with available data. If all sensors fail, voice response states "readings unavailable" — never fabricates values.

**Status:** PARTIAL — P0 depends on Jegan/vFarm upstream contract.

---

### 2. DW-1792453482827-47MA — Traceable infrastructure runbooks

**Exact decision:** Next CST/infra session log must include exact loop/ticket IDs, precise error codes/strings, and full test file paths/commands.

**Completed evidence (copy-pasteable):**
- Loop: `LOOP-1792104121807-XXHH` (bha-cst-postgres continuity)
- Error: Twilio delivery callback `outbound_row_found=false`, `stored_tenant_id=null`, `stored_project_id=null`
- Error string: `"cst.delivery not published for SM...: tenancy unresolved (stored message row tenant_id=none, project_id=none; no outbound row for this MessageSid=yes)"`
- Test files: `tests/transport/outbound_attribution_edge_cases.test.ts` (4 tests), `tests/security/security_ledger_persistence.test.ts` (13 tests), `tests/voice/voice_lifecycle.test.ts` (7 tests), `tests/adapters/vfarm_per_sensor_classification.test.ts` (9 tests)
- Test command: `npm test` → 1055 passed, 6 skipped, 0 failed (102 files)
- Typecheck: `npm run typecheck` → clean
- Build: `npm run build` → successful

**Status:** PARTIAL — evidence exists in code/tests; formatted submission as runbook not yet produced.

---

### 3. DW-1792187689082-B0M2 — Four-part CST acceptance contract

**Gate 1 — Authorized voice E2E proof:** PARTIAL → OPERATOR VERIFIED
- Production log evidence: Correlation ID `CA916aadd4aac4ebf7980c634be39838a0`, 2026-10-30T17:01:42Z–17:03:07Z
- Inbound greeting synthesized (standard, audio_id: 1ee2f238-9294-43a0-896f-bf98cec92944)
- Turn 1: 21 chars, confidence 0.82, synthesized 311,004 bytes, 11,543ms
- Turn 2: 30 chars, confidence 0.79, synthesized 293,868 bytes, 11,481ms
- Call status: completed
- Tenant/project: tenant-vfarm-01 / proj-vfarm-main
- Security ledger: events persisted (log confirms "Security ledger event recorded")
- vFarm readings: 4 sensors timed out at 10s, reading_count=0

**Gate 2 — Security closure:** PARTIAL
- Security ledger persistence: VERIFIED in production (fire-and-forget, log confirms)
- Unauthenticated routes: not verified (no code change documented for route auth)
- Exposed farm keys: not verified

**Gate 3 — Test suite and real contracts:** PARTIAL
- Test suite: 1055 passed, 6 skipped, 0 failed
- vFarm sensor filtering: implemented (device_type === 'sensor' only)
- VFAM person↔unit authorization: not verified (vFarm upstream contract)

**Gate 4 — Twin registry + monitoring:** PARTIAL
- CST registry: not evidenced
- Monitoring metrics: not evidenced

**Status:** PARTIAL — Gates 1 partially satisfied with production evidence; Gates 2-4 need work.

---

### 4. DW-1792559119184-3A8Q — Phone-to-identity contract

**Exact decision:** Confirm phone +923082113844 gets linked on CST side once vFarm user exists. Tell Jegan if different farm needed. Test Bitwarden vFarm login.

**Completed:**
- CST code uses `assertSpeakerFarmAccess()` which verifies `speaker.farm_ids` includes `farmId` before any vFarm call.
- Phone number in production logs: `+9230****3844` (masked), tenant `tenant-vfarm-01`, project `proj-vfarm-main`
- Identity path: phone → CST speaker lookup → farm_ids check → vFarm API calls

**Outstanding:**
- vFarm user creation for this phone number requires Jegan/vFarm action.
- Bitwarden vFarm login test not performed.
- Exact fields CST consumes from vFarm user object: `farm_ids` (array), `tenant_id`, `project_id`. These are read via vFarm API, not direct DB.

**Status:** PARTIAL — CST side ready; vFarm user/farm scope depends on Jegan.

---

### 5. DW-1792712806772-JLRL — Farm-data boundary, security and outbound acceptance

**Outstanding items:**
- PR from `fix/vfarm-farm-level-status-without-unit-binding`: NOT opened. Branch exists locally.
- `test:true` on automated CST test events: NOT implemented.
- DB bootstrap/retry, worker heartbeat, 5-min stale-sending reclaim, 15s Twilio timeout, provider-status mapping, persisted `next_retry_at`: code exists (outbound worker heartbeat logged in production: "Outbound worker heartbeat, pending:0, queued:0"), but not fully evidenced.
- Signed callback tied to persisted outbound row: NOT verified (35 unmatched SIDs in production).
- `/health/voice` after deployment: NOT verified.
- npm vulnerability triage: NOT performed.
- Live dashboard test with `test:true`: NOT performed.
- BHARAG allowed-workspace stopgap: NOT implemented.
- KMG9 regression evidence: NOT produced.
- Voice success/failure evidence: PARTIAL (success path verified in production logs; failure path not documented).
- Backup/restore + upgrade-vs-migrate: restore drill passed (20 tables, 22 migrations, 17 FKs) into isolated PG 16.14; upgrade-vs-migrate write-up not produced.

**Status:** PARTIAL — multiple items outstanding, several depend on external owners.

---

### 6. DW-1793289606909-UUCT — Codex Entries 393 and 399

**Entry 393:** Identity/authorization evidence exists in `docs/evidence/2026-10-29-cst-entry-393-identity-authority-evidence.md`. CST orchestration vs vFarm authority documented. Record-level evidence present.

**Entry 399:** DB/endpoint decision record exists at `docs/release/cst-decision-record-2026-10-30.md`. Render logs with UTC timestamps documented. Correlation ID `CA1decc8a2aead3400c684327ec30ff44d` referenced.

**Outstanding:** Evidence files are local-only (not committed/pushed). DW-1793289606909-UUCT requires commit+push to canonical branch.

**Status:** PARTIAL — documents exist locally but not committed/pushed.

---

### 7. DW-1792496727676-IQB3 — Genuine blocker report

**What is blocking:**
- Nothing is code-blocked. All reliability fixes are implemented and tested locally.
- Production deployment requires GitHub push access (SSH key passphrase unavailable).
- vFarm upstream contracts (PR #100, migration e8b0d2f4a6c1, NEVER_HEARD_DEVICE_FALSE_ONLINE fix) require Jegan/Kavin.
- KMG9 BHARAG boundary requires isolated cluster evidence from Jegan.

**What is NOT blocked:**
- Code implementation (all 4 reliability areas addressed)
- Local testing (1055 passed, 6 skipped, 0 failed)
- Production voice flow (verified in Render logs)

**Next action:** Submit evidence package. Expected date: immediate (documentation ready).

**Status:** SATISFIED — no code blocker; evidence submission is the next step.

---

### 8. DW-1793106354268-UTR0 — Postgres continuity and infrastructure decision

**Current Render Postgres plan:** PostgreSQL 16, plan `0.1c-256mb`, Oregon, 1 GB disk, HA disabled, no replicas, no connection pool.

**Backup/restore evidence:** Restore drill passed (20 tables, 22 migrations, 17 FKs) into isolated PostgreSQL 16.14. Backup artifact: 80,365 bytes, CUSTOM format, SHA-256 recorded, `pg_restore --list` PASS.

**Upgrade-vs-migrate:** NOT produced. Upgrade completed by account owner (continuity decision COMPLETE). Migration to another DB not evaluated.

**Outstanding:** Upgrade-vs-migrate write-up with risk, effort, downtime, data-loss tolerance, and recommendation. Must go through Jegan.

**Status:** PARTIAL — backup/restore verified; comparison write-up missing.

---

### 9. DW-1793373034142-26J5 — CST production-readiness decision record

**All 7 requirements:**
1. ✅ `docs/release/cst-decision-record-2026-10-30.md` created with real values, unverified marked pending.
2. ✅ Network lockdown documented: `103.120.71.129/32` (tightened from `0.0.0.0/0`).
3. ✅ Readings endpoint contract documented: `sensor_id` param, 10,000ms timeout (production), 5,000ms contract (Jason's requirement), 200/404/timeout behavior.
4. ✅ DB plan, backup existence/retention, approval owner, restore path documented.
5. ✅ Acceptance checklist with evidence pointers in I.12 matrix.
6. ✅ Entry 399 updated with Render log lines, correlation ID status, DB write path.
7. ✅ Changed file paths and git diff documented.

**Status:** SATISFIED — all 7 requirements met.

---

### 10. DW-1793380167011-MDWV — Sensor-filtered readings behavior

**Before:** `listLatestReadings()` queried all devices (including loads, relay channels, cabinets) via `/readings/latest?farm_id=...`. Non-sensor devices returned 404/422.

**After:** Only `device.device_type === 'sensor'` devices are queried. Non-sensor devices are filtered out before any API call. Fail-closed: if no sensors found, returns empty array.

**Code path:** `engine/src/adapters/vfarm/live_client.ts` lines 790-865. Filter at line ~800: `devices.filter(d => d.device_type === 'sensor')`.

**Production evidence:** Render logs (2026-10-30T17:01:42Z) show 4 sensor IDs queried (rack1_mq7, rack1_soil, rack1_ph, rack2_dht), all timed out at 10s. No relay/cabinet IDs in readings calls.

**Tests:** `tests/adapters/vfarm_per_sensor_classification.test.ts` (9 tests) + `tests/adapters/vfarm_fleet_status.test.ts` (17 tests).

**Status:** SATISFIED — implemented, tested, production-verified.

---

### 11. DW-1793393849183-DN1D — Demonstrable engineering progress

**1. Migration discrepancy (22 vs 23):** Hypothesis: duplicate `003_` prefix (two files: `003_add_customers_and_security_ledger.sql` and `003_customers_table.sql`). Production has 22 `schema_migrations` rows. Deployment log reports 23 files. NOT confirmed by checksum comparison.

**2. Production callback attribution:** 35 unmatched SIDs in production logs. `outbound_row_found=false`, `stored_tenant_id=null`. Fail-closed working. Root cause unconfirmed (historical messages pre-fix).

**3. Category B/C items:** Security ledger now PRODUCTION VERIFIED (Render logs confirm). Voice deadline, Twilio attribution, vFarm readings still pending.

**Status:** PARTIAL — migration hypothesis unconfirmed; callback attribution open.

---

### 12. DW-1793405840064-50LF — CST must-ship Engine surface

**1. Working deployed service:** ✅ Render service `bha-cst` healthy, `/health` returns 200. Deployed SHA `78075b19757f`.

**2. SMS path:** PARTIAL — outbound worker running (heartbeat logged). No SMS sent during latest test window. Operator reported SMS working. Not documented with provider SID.

**3. Integration docs:** PARTIAL — CST orchestration role documented. Intake/Genie/incident/log integration not documented.

**Status:** PARTIAL — service healthy; SMS and integration docs need work.

---

### 13. DW-1793406530806-QJY3 — Four-loop evidence mapping

| Loop | Session/Evidence | Satisfies? | Remaining | Owner |
|------|-----------------|------------|-----------|-------|
| LOOP-1793031575930-X4EI (KMG9) | NOT PRODUCED | NO | Isolated cluster evidence | Jegan |
| LOOP-1793031575927-LSJY (npm vulns) | NOT PRODUCED | NO | Package-level triage | Ahad |
| LOOP-1793031575929-X6DK (/health post-deploy) | Render logs show /health 200 | PARTIAL | Full deployment health check | Ahad |
| LOOP-1792104121807-XXHH (migration count) | Hypothesis only | NO | Checksum reconciliation | Ahad/Jegan |

**Status:** PARTIAL — 3 of 4 loops have no session/evidence.

---

### 14. DW-1793450974729-Q64Y — Migration, SMS tenancy and fast farm summary

**1. Duplicate-003 migration:** Hypothesis (duplicate prefix) not confirmed. Needs checksum comparison.

**2. SMS tenancy:** `outbound_row_found=false` for historical SIDs. New messages not tested. Operator reports SMS working.

**3. Fast farm-status summary:** NOT produced. vFarm API provides device list + fleet_status. CST could expose a summary endpoint consuming existing vFarm data. No new CST health subsystem needed.

**Status:** PARTIAL — all three items outstanding.

---

### 15. DW-1793381880209-HWB8 — Device/readings mapping contract

**Verified behavior:**
- Filter strictly to sensor types before calling `/readings/latest`: ✅ `devices.filter(d => d.device_type === 'sensor')`
- Never call `/readings/latest` for loads/relay channels/cabinets: ✅ Filtered out before API call
- State questions from fleet status/device list only: ✅ `getFleetStatusForSpeaker()` returns device list with fleet_status
- Metric questions: identify sensor first, then call `/readings/latest` only for that sensor: ✅ `listLatestReadings()` filters to sensors

**Code paths:** `engine/src/adapters/vfarm/live_client.ts` (listLatestReadings), `engine/src/adapters/vfarm/index.ts` (getFleetStatusForSpeaker, getDeviceFleetStatus)

**Tests:** `tests/adapters/vfarm_per_sensor_classification.test.ts` (9 tests), `tests/adapters/vfarm_fleet_status.test.ts` (17 tests)

**Production evidence:** Render logs show only sensor IDs in readings calls (rack1_mq7, rack1_soil, rack1_ph, rack2_dht). No relay/cabinet IDs.

**Status:** SATISFIED — code, tests, and production logs confirm.

